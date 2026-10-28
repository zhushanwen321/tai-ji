#!/usr/bin/env node
/**
 * quality-gates.mjs —— 质量门聚合出口（review-pipeline-redesign 设计 §5-U1 / §3.3 决策 4）。
 *
 * 聚合（统一出口，编排层一次调用）：
 *   1. typecheck 四处（自跑）：extensions `npx tsc --noEmit` / runtime `pnpm run typecheck` /
 *      renderer `pnpm run typecheck` / mobile-renderer `pnpm run typecheck`——命令与 cwd
 *      与 scripts/pr-pre-merge.sh 同款。
 *      （根 package.json 无 typecheck:extensions 等聚合 script，故按目标包实际 script 直跑。）
 *   2. coverage-gate：子进程调用 .agents/skills/pr-cr-fix/scripts/coverage-gate.py（既有实现，
 *      不移植判定逻辑）。该实体在 .agents（不入 git），缺失时报错并指明缺失路径，不静默跳过；
 *      恢复通道 = refs/skills-snapshot 备份 ref。
 *   3. 机器盲区判定（决策 4，本脚本新增的机器承接）：coverage.json 各 OK 包 files_without_lcov
 *      （= base...HEAD diff 新增但未被任何测试加载的文件）中「含可执行行」者 → FAIL。
 *      判定边界：① 豁免通道 coverage-file-gate-exempt（文件头标记，coverage-gate.py 的
 *      file_gate 豁免同款）同步覆盖本判定；② 可执行行口径见 hasExecutableLines——
 *      interface/type/常量/纯导出聚合等无可执行分支的文件整文件排除。
 *   4. metrics-gate：子进程调用 metrics-gate.py（在 coverage-gate 之后——它消费同 base 的
 *      coverage.json 真实覆盖率）。warn 档与 high_crap 检查目标清单按决策 4 降级为机器
 *      报告呈报（不逐条 LLM 核查），只有 fail 档影响本门判定。
 *
 * 产物目录：coverage.json / metrics.json 读取优先新根
 * `~/.agents/skill-data/pr-review/<project-slug>/`（经 scripts/skill-data-dir.mjs 解析），
 * 缺产物时回退旧 `.review/`（迁移过渡期，design.md §7 风险 2）。
 *
 * 并发互斥：同 worktree 同时只允许一个 quality-gates 整体运行（worktree 级互斥锁，
 * 根因 = 并发两次会让两个 vitest coverage 跑互删 .tmp 覆盖文件、报 ENOENT 哑 FAIL，
 * 详见 acquireGateLock 头注释）。
 *
 * base 口径两侧差异有意保留（参数化承载，设计 §5-U1）：
 *   --side dev-merge  → base = `git merge-base github/main HEAD`（fallback main）——分支增量
 *   --side pr-cr-fix  → base = main（--base 可覆盖）——累积
 *
 * 用法：node scripts/quality-gates.mjs [--side dev-merge|pr-cr-fix] [--base <ref>] [--json]
 * 退出码：0 = 全绿；1 = 有 FAIL（typecheck / coverage / 盲区判定 / metrics fail 档）；
 *         2 = 用法/环境错误（py 实体缺失、base 无法解析、py 工具错误）
 *
 * 门清单：1 typecheck×4 / 2 coverage-gate / 3 机器盲区 / 4 metrics-gate /
 * 5 test-suite（快速守卫测试族，scripts/test-suites.mjs 单一登记，恒跑不分 side）
 *
 * --only <组,组>：只跑指定门组（typecheck / coverage / metrics / test；缺省全跑）。
 * 排除 coverage+metrics 时不做 py 实体检查、不解析 base（merge 阶段 1 的 pre-merge-check
 * 以 --only typecheck,test 调用——类型检查与守卫族的完整单测覆盖由阶段 2 的 PR CI 等待承担）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, linkSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { skillDataDir } from './skill-data-dir.mjs'
import { SUITES } from './test-suites.mjs'

const PY_REL_DIR = join('.agents', 'skills', 'pr-cr-fix', 'scripts')
const COVERAGE_PY = 'coverage-gate.py'
const METRICS_PY = 'metrics-gate.py'

// 与 coverage-gate.py 文件级豁免读取窗口同款口径：py 的 read_text()[:2400] 是 str 字符切片
// （非字节），此处同样按字符 slice——中文注释密集文件 1 字符 = 3 字节（UTF-8），字节窗口会
// 提前截断导致同一标记在 py 判豁免、此处判违规
const EXEMPT_HEAD_CHARS = 2400
const EXEMPT_MARKER_RE = /coverage-file-gate-exempt:\s*(.+)/

function usageError(msg) {
  const err = new Error(`用法错误：${msg}`)
  err.exitCode = 2
  return err
}

const ONLY_GROUPS = ['typecheck', 'coverage', 'metrics', 'test']

export function parseGateArgs(argv) {
  const out = { side: 'pr-cr-fix', base: null, json: false, only: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--side') {
      const v = argv[++i]
      if (v !== 'dev-merge' && v !== 'pr-cr-fix') {
        throw usageError(`--side 只接受 dev-merge | pr-cr-fix，得到：${v}`)
      }
      out.side = v
    } else if (a === '--base') {
      out.base = argv[++i]
      if (!out.base) throw usageError('--base 需要一个 ref 参数')
    } else if (a === '--only') {
      const v = argv[++i]
      if (!v) throw usageError(`--only 需要组名列表（${ONLY_GROUPS.join(',')}，逗号分隔）`)
      const groups = v.split(',').map((x) => x.trim()).filter(Boolean)
      // 纯分隔符输入（--only ,）过滤后为空 → 全门组关闭、零 FAIL、exit 0 的「无检查即绿」
      // 形态，fail-fast 拒绝（ADR-0173 反对的输入边缘）
      if (groups.length === 0) throw usageError(`--only 至少需要一个有效组名（${ONLY_GROUPS.join(',')}）——「${v}」解析后无有效组`)
      const bad = groups.filter((g) => !ONLY_GROUPS.includes(g))
      if (bad.length > 0) throw usageError(`--only 只接受 ${ONLY_GROUPS.join(',')}，得到：${bad.join(',')}`)
      out.only = groups
    } else if (a === '--json') {
      out.json = true
    } else {
      throw usageError(
        `未知参数：${a}。用法：node scripts/quality-gates.mjs [--side dev-merge|pr-cr-fix] [--base <ref>] [--only ${ONLY_GROUPS.join(',')}] [--json]`,
      )
    }
  }
  return out
}

/**
 * base 口径解析（两侧差异在此落地，测试锚点）。
 * 显式 --base 恒优先；否则 pr-cr-fix 侧固定 main（累积），dev-merge 侧取 merge-base
 * github/main HEAD（分支增量；github/main 不存在的环境 fallback main）。
 */
export function resolveBase({ side, explicitBase }, git) {
  if (explicitBase) return { base: explicitBase, source: 'explicit' }
  if (side === 'pr-cr-fix') return { base: 'main', source: 'pr-cr-fix-cumulative' }
  // dev-merge：分支增量。github/main 是本仓唯一 remote 的裸共享 ref（AGENTS.md git 规范），
  // 非本仓布局（无 github/main）时退回 main；两者皆无 = 无法界定分支增量，fail-fast。
  for (const ref of ['github/main', 'main']) {
    try {
      const base = git(['merge-base', ref, 'HEAD']).trim()
      if (base) return { base, source: `dev-merge-incremental(${ref})` }
    } catch {
      // ref 不可解析 → 试下一个
    }
  }
  throw usageError(
    'dev-merge 侧 base 解析失败：github/main 与 main 均不可解析——分支增量无从界定。' +
      '恢复：确认在 worktree 内运行，或用 --base <ref> 显式指定合并基点',
  )
}

export function buildCoverageCommand(pyPath, base) {
  return ['python3', pyPath, '--base', base]
}

export function buildMetricsCommand(pyPath, base) {
  return ['python3', pyPath, '--base', base]
}

/** typecheck 四处（自跑）。命令与 cwd 与 pr-pre-merge.sh 的 typecheck 步骤同款。
 *  mobile-renderer 在列的根据：它是 renderer 的同构消费包（桥接 core 词表/类型），
 *  不在列时其类型破坏要到构建步骤才暴露（v0.10.14 轮 U4 词表改名实例）。 */
export function buildTypecheckSteps() {
  return [
    { name: 'typecheck:extensions', cmd: 'npx', args: ['tsc', '--noEmit'], cwd: 'extensions' },
    { name: 'typecheck:runtime', cmd: 'pnpm', args: ['run', 'typecheck'], cwd: 'packages/runtime' },
    { name: 'typecheck:renderer', cmd: 'pnpm', args: ['run', 'typecheck'], cwd: 'packages/renderer' },
    { name: 'typecheck:mobile-renderer', cmd: 'pnpm', args: ['run', 'typecheck'], cwd: 'packages/mobile-renderer' },
  ]
}

/**
 * 可执行行口径（决策 4 判定边界②）：非空非注释的语句行；
 * interface/type/常量/纯导出聚合等无可执行分支的文件整文件排除。
 *
 * 取向：宁可误 FAIL（保守）不可漏 FAIL——误 FAIL 的出口是豁免标记，漏 FAIL 复活机器盲区。
 * 形态清单外的行（function/class/enum/控制流/未识别）一律视为可执行。
 * .vue 含 template 渲染行为范围，不做整文件排除（豁免标记通道仍可用）。
 */
export function hasExecutableLines(content, filePath) {
  if (filePath.endsWith('.vue')) return true
  // 逐字符状态机：剥注释（行/块）并抹掉字符串字面量——字符串内的 // 与括号不参与判定。
  // 模板串内 ${} 表达式一并抹掉——已知漏 FAIL 边界（有意取舍，不做完整 JS 词法）：
  // 唯一执行语义为模板插值的 const（export const V = `x${f()}`）判 false；正则字面量内
  // 的 { 计入深度可能吞掉同文件后续行判定。此两形态靠 audit 细网 / 评审兜底，不视为门禁缺陷。
  const lines = stripCommentsAndStrings(content).split('\n')
  let i = 0
  while (i < lines.length) {
    const t = lines[i].trim()
    if (!t) { i++; continue }
    if (/^export\s*[{*]/.test(t) || /^declare\b/.test(t)) { i++; continue } // 纯导出聚合 / declare
    if (/^import\b/.test(t)) {
      // bare side-effect import（import './x'）有执行语义 → 可执行；其余 import 排除
      if (/^import\s*['"]/.test(t)) return true
      i++; continue
    }
    if (/^(export\s+)?(type|interface)\b/.test(t)) { i = skipBalanced(lines, i); continue }
    if (/^(export\s+)?(const|let|var)\b/.test(t)) {
      const end = skipBalanced(lines, i)
      if (looksExecutable(lines.slice(i, end).join('\n'))) return true
      i = end; continue
    }
    return true // function/class/enum/表达式/未识别形态 → 可执行（保守）
  }
  return false
}

function stripCommentsAndStrings(content) {
  let out = ''
  let state = 'code' // code | line | block | sq | dq | tpl
  let i = 0
  while (i < content.length) {
    const step = stripStep(state, content[i], content[i + 1])
    out += step.text
    state = step.state
    i += step.advance
  }
  return out
}

/** [stripCommentsAndStrings 拆分] code 态单步转移（注释开 / 引号开 / 原样透出）。 */
function stripCodeStep(c, d) {
  if (c === '/' && d === '/') return { state: 'line', advance: 2, text: '  ' }
  if (c === '/' && d === '*') return { state: 'block', advance: 2, text: '  ' }
  if (c === "'") return { state: 'sq', advance: 1, text: c }
  if (c === '"') return { state: 'dq', advance: 1, text: c }
  if (c === '`') return { state: 'tpl', advance: 1, text: c }
  return { state: 'code', advance: 1, text: c }
}

/**
 * [stripCommentsAndStrings 拆分] 状态机单步转移：返回 { state, advance, text }
 * （advance = 本步消耗字符数 ≥1，text = 本步追加输出——注释与字符串字面量内容抹成
 * 空格、保留边界引号与换行，转义跳过下一字符）。逐分支与拆分前实现同构。
 */
function stripStep(state, c, d) {
  if (state === 'code') return stripCodeStep(c, d)
  if (state === 'line') {
    return c === '\n'
      ? { state: 'code', advance: 1, text: '\n' }
      : { state: 'line', advance: 1, text: ' ' }
  }
  if (state === 'block') {
    if (c === '*' && d === '/') return { state: 'code', advance: 2, text: '  ' }
    return { state: 'block', advance: 1, text: c === '\n' ? '\n' : ' ' }
  }
  // 字符串态（sq/dq/tpl）：转义跳过；结束引号回 code
  if (c === '\\') return { state, advance: 2, text: '  ' }
  const closing = state === 'sq' ? "'" : state === 'dq' ? '"' : '`'
  if (c === closing) return { state: 'code', advance: 1, text: c }
  return { state, advance: 1, text: c === '\n' ? '\n' : ' ' }
}

/** 从 lines[i] 起消费一个完整语句/声明（括号深度归零且见行尾），返回下一行下标。 */
function skipBalanced(lines, start) {
  let depth = 0
  let started = false
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if ('([{'.includes(ch)) { depth++; started = true }
      else if (')]}'.includes(ch)) { depth-- }
    }
    const ended = started && depth <= 0
    if (ended) return i + 1
    // 单行即结束（无括号开启的声明行，如 let x = 1）也到此为止
    if (!started && /;\s*$/.test(lines[i])) return i + 1
  }
  return lines.length
}

/** 常量/变量声明体内是否出现执行形态（调用 / new / await / 箭头 / 函数·类定义等）。 */
function looksExecutable(body) {
  return /(=>|\bnew\b|\bawait\b|\byield\b|\basync\b|\bfunction\b|\bclass\b|\bthrow\b|\breturn\b|\bif\b|\bfor\b|\bwhile\b|\bswitch\b|\btry\b|[\w$)\]]\s*\()/.test(body)
}

/**
 * 机器盲区判定（决策 4）。输入 = coverage-gate.py 产出的 report（coverage.json，读取
 * 优先新 pr-review 目录、回退旧 `.review/`——见 createDefaultDeps 的 readReviewJson），
 * 其中每个 OK 包的 files_without_lcov = 「base...HEAD diff 新增且无 lcov 记录」清单的
 * 截断前 10 条（py no_lcov[:10]）——单轮呈报不全；FAIL 判定不受影响（列表内 ≥1 即 FAIL），
 * 已修文件重跑 gates 后新条目顶上，fixer 迭代收敛补全。「diff 新增」语义由 py 的 diff
 * 口径构造性保证，此处不再重算 diff。
 * readHead(fileRel) 返回文件头文本（豁免标记读取窗口）或 null（读不到按无豁免处理）。
 */
export function judgeNoLcov(report, readHead) {
  const violations = []
  const exempt = []
  const packages = (report && report.packages) || {}
  for (const [pkg, entry] of Object.entries(packages)) {
    if (entry.status !== 'OK') continue
    for (const file of entry.files_without_lcov || []) {
      // 豁免判定 = 文件头窗口（与 coverage-gate.py file_gate 豁免同款前 2400 字符，非字节）；
      // 可执行行判定 = 全文（readHead(chars=Infinity)），读不到全文时退回窗口（短文件即全文）
      const head = readHead(file)
      const m = head ? head.match(EXEMPT_MARKER_RE) : null
      if (m) {
        exempt.push({ file, package: pkg, reason: m[1].trim() })
        continue
      }
      const full = (head !== null && readHead(file, Infinity)) || head
      if (full !== null && !hasExecutableLines(full, file)) continue // 纯类型/常量/聚合类，整文件排除
      violations.push({
        file,
        package: pkg,
        reason: 'diff 新增且含可执行行，但无 lcov 记录（未被任何测试加载）',
        fix: '补测试加载该文件；确属单测结构性不可达面（组合根装配接线、跨环境分支等）时在文件头加豁免标记 `coverage-file-gate-exempt: <理由>`',
      })
    }
  }
  return { violations, exempt }
}

/**
 * 门禁子进程 PATH 自举（node 版本管理器环境兜底）。quality-gates 常被非交互宿主
 * （workflow / 编辑器任务面板）spawn，其 PATH 可能缺 nvm/volta 等版本管理器的 bin
 * 目录——pnpm/npx/fallow 全部 spawnSync ENOENT，typecheck 四门 + coverage/metrics
 * 门齐挂（2026-10-12 dev-merge gates round 2 实例）。自举依据：本脚本能跑起来 =
 * process.execPath 的 node 一定存在，其 symlink 解析后的真实 bin 目录（nvm 形态）
 * 就是全套 node 工具链所在；另补 pnpm 官方默认安装位。
 * 追加（不前置）到现有 PATH 尾部——调用方显式配置的工具链恒优先，自举只兜底缺漏。
 */
export function buildGateEnv(baseEnv = process.env) {
  const existing = splitPath(baseEnv.PATH)
  const extra = candidateToolBinDirs(baseEnv).filter((dir) => isDirectory(dir) && !existing.includes(dir))
  return { ...baseEnv, PATH: [...existing, ...extra].join(delimiter) }
}

function splitPath(pathValue) {
  return String(pathValue || '').split(delimiter).filter(Boolean)
}

/** node 工具链候选目录（按命中可靠性排序；存在性过滤在 buildGateEnv 统一做）。 */
function candidateToolBinDirs(baseEnv) {
  const candidates = []
  // execPath 未解析形态（homebrew shim 目录等，已在 PATH 时被去重过滤）
  candidates.push(dirname(process.execPath))
  try {
    // symlink 解析后的真实 node 所在 bin 目录（nvm/volta 形态，pnpm/npm/npx/corepack 同目录）
    candidates.push(dirname(realpathSync(process.execPath)))
  } catch {
    // node 实体被移除等边缘情形：跳过该候选
  }
  if (baseEnv.PNPM_HOME) candidates.push(String(baseEnv.PNPM_HOME))
  candidates.push(join(homedir(), 'Library', 'pnpm')) // pnpm 官方 mac 安装位
  candidates.push(join(homedir(), '.local', 'share', 'pnpm')) // pnpm 官方 linux 安装位
  return candidates
}

function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

// ── worktree 级互斥锁（并发 quality-gates 串行化）──────────────────────────
// 根因（2026-10-21 dev-merge-gates 双发实例）：同一 worktree 同时跑两个
// quality-gates 时，两个 coverage-gate.py 各起一个 `vitest run --coverage`，
// 共用同一 reportsDirectory（packages/*/coverage）。后启动方的 clean() 会
// rm -rf 整个 reportsDirectory 再重建，把先启动方 worker 已写出的 .tmp 覆盖
// 文件删掉 → 先启动方 readCoverageFiles 读 ENOENT 崩溃，coverage-gate 报
// 「测试失败（exit=1）」的哑 FAIL（vitest 的 normalizeCoverageFileError 对此
// 形态有明示：不要同时跑多个共用 reportsDirectory 的 vitest）。
// 修法按 ADR-0122 ⑥（竞态用顺序契约消解，不用宽限窗/重试兜底）：同 worktree
// 互斥，第二个进程等第一个整体跑完再跑。锁文件落系统临时目录、按 root 路径
// 哈希分 worktree 桶——不污染工作区（发起前脏区预检看不到它），跨 worktree
// 天然隔离（各自 coverage 目录独立，无需互斥）。
//
// 锁内容与回收判定（二轮加固，登记 dmg-r1-1 / dmg-r1-2 / pid 复用披露项）：
// - 建锁原子：pid + 进程启动时间先写临时文件，再 link() 为锁文件——内容先于
//   可见性完整，锁文件结构上不可能为空（旧实现「建文件→写 pid」两步间崩溃
//   留下的空锁「永不回收」状态被消除而非检测）。
// - 持锁身份 = pid + 启动时间双因子：pid 复用（崩溃后 pid 被无关进程接走）时
//   纯存活探测定恒真、锁永不回收；启动时间不匹配 → 判非原持锁方偷锁。启动
//   时间是确定性同步查询（ADR-0122 ⑤）：linux /proc/<pid>/stat、macOS
//   `ps -o lstart=`（LC_ALL=C 稳定格式），只做同源字符串相等比对，不解析日期。
// - 无主回收三通道：pid 已死 / 启动时间不匹配 / 内容空或损坏（旧实现崩溃
//   残留）。旧格式锁（纯 pid 数字）降级为纯 pid 存活语义——过渡期不误偷仍
//   活着的旧版持锁方；启动时间读不到（平台不支持 / ps 失败）同样降级不偷。
const GATE_LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000
const GATE_LOCK_POLL_MS = 2000

/** 锁路径：root 经 realpath 规范化后取哈希前缀分桶，落 tmpdir（每用户独立）。 */
export function gateLockPath(root) {
  let canonical = root
  try {
    canonical = realpathSync(root)
  } catch {
    // root 不存在（测试注入的假路径）→ 用原值，哈希仍确定
  }
  const bucket = createHash('sha256').update(canonical).digest('hex').slice(0, 16)
  return join(tmpdir(), `taiji-quality-gates-${bucket}.lock`)
}

/** pid 存活判定：kill(pid, 0) 不发信号只探存在；EPERM = 存在但无权发信号，仍算存活。 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 进程启动时间（持锁身份第二因子）：linux 读 /proc/<pid>/stat 第 22 字段（自
 * boot 的时钟滴答数），macOS 经 `ps -p <pid> -o lstart=`（LC_ALL=C 固定英文
 * 格式）。返回带平台前缀的字符串——只做同源相等比对（当前值 vs 锁内记录值），
 * 绝不跨平台比对或解析日期。读不到（进程不存在 / 平台不支持 / ps 失败）返回
 * null，调用方降级为纯 pid 存活语义。
 */
export function captureProcessStartTime(pid) {
  if (process.platform === 'linux') return captureStartTimeLinux(pid)
  if (process.platform === 'darwin') return captureStartTimeDarwin(pid)
  return null
}

/** [captureProcessStartTime 拆分] linux：/proc/<pid>/stat 第 22 字段（comm 可含空格与括号，最后一个 ')' 之后起算）。 */
function captureStartTimeLinux(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
    // starttime 是剩余部分的第 20 个 token（下标 19）
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
    return fields[19] ? `linux:${fields[19]}` : null
  } catch {
    return null
  }
}

/** [captureProcessStartTime 拆分] darwin：ps -o lstart=（LC_ALL=C 稳定格式），status 0 且输出非空才算读到。 */
function captureStartTimeDarwin(pid) {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf-8',
    env: { ...process.env, LC_ALL: 'C' },
  })
  const out = (r.stdout ?? '').trim()
  return r.status === 0 && out ? `darwin:${out}` : null
}

/** 锁 pid 合法形态守卫：正整数。 */
function isLockPid(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** 锁记录是否为对象形态（新格式 { pid, started }；null / 数组均非）。 */
function isLockRecord(value) {
  return value !== null && typeof value === 'object'
}

/** [readLockInfo 拆分] 新格式锁记录 → 持锁身份；started 非字符串降级 null（纯 pid 存活语义）。 */
function parseRecordLock(parsed) {
  return { pid: parsed.pid, started: typeof parsed.started === 'string' ? parsed.started : null }
}

/**
 * 读锁内容 → 持锁身份 { pid, started }。空/非 JSON 文件（旧实现「建文件→写
 * pid」两步间崩溃的残留——新实现结构上不产生）返回 null = 无主可偷；旧格式
 * （纯 pid 数字）解析为 started 缺失，降级纯 pid 存活语义。
 */
function readLockInfo(lockPath) {
  let raw
  try {
    raw = readFileSync(lockPath, 'utf-8')
  } catch {
    return null
  }
  return parseLockPayload(raw)
}

/** [readLockInfo 拆分] 锁内容解析：读失败 = 无主；解析归一委托 parseLockIdentity。 */
function parseLockPayload(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null // 空文件 / 非 JSON → 旧实现崩溃残留，无主
  }
  return parseLockIdentity(parsed)
}

/** [parseLockPayload 拆分] 旧格式（纯 pid 数字）与新格式（{ pid, started } 对象）统一归一为持锁身份；其余形态 = 无主可偷。 */
function parseLockIdentity(parsed) {
  if (typeof parsed === 'number') return { pid: parsed, started: null }
  if (isLockRecord(parsed) && isLockPid(parsed.pid)) return parseRecordLock(parsed)
  return null
}

/**
 * 获取 worktree 级互斥锁，返回 release 函数（幂等，重复调用安全）。
 * 无主回收走确定性事实判定（ADR-0122 ⑤）：持锁 pid 已死 / pid 复用（启动时间
 * 不匹配）/ 锁内容残留（空、损坏）→ 偷锁，不用时间启发判陈旧；等待超时抛错
 * （调用方转 exit 2 环境错误并附恢复动作）。
 */
export function acquireGateLock(lockPath, { timeoutMs = GATE_LOCK_TIMEOUT_MS, pollMs = GATE_LOCK_POLL_MS } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const release = tryCreateLock(lockPath)
    if (release) return release
    awaitLockRelease(lockPath, deadline, timeoutMs, pollMs)
  }
}

/**
 * 原子占锁：pid + 启动时间先写临时文件，再 link() 为锁文件——内容先于可见性
 * 完整，锁文件不可能为空。link EEXIST = 已被占（返回 null，非 EEXIST 错误上
 * 抛）；临时文件无论成败都清（link 成功后删的只是临时名，锁本体不受影响）。
 */
function tryCreateLock(lockPath) {
  const tmpPath = `${lockPath}.${process.pid}.tmp`
  try {
    writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, started: captureProcessStartTime(process.pid) }))
    try {
      linkSync(tmpPath, lockPath)
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      return null
    }
    return makeRelease(lockPath)
  } finally {
    try {
      unlinkSync(tmpPath)
    } catch {
      // 临时文件已不存在（写失败前未建 / 已清理）——无残留可清
    }
  }
}

/** release 闭包：幂等删锁（重复调用安全；锁已被他方删除时静默）。 */
function makeRelease(lockPath) {
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      unlinkSync(lockPath)
    } catch {
      // 锁文件已不存在（他方偷锁清理）→ 无主可释放
    }
  }
}

/** 锁被占用时的单轮处置：无主（死/复用/残留）→ 偷锁；超时 → 抛错（指引按持锁状态分流）；否则睡一轮再试。 */
function awaitLockRelease(lockPath, deadline, timeoutMs, pollMs) {
  if (stealStaleLock(lockPath)) return
  if (Date.now() >= deadline) {
    throw new Error(lockTimeoutMessage(lockPath, timeoutMs))
  }
  sleepSync(pollMs)
}

/** 无主判定：锁内容缺失 / 持锁 pid 已死 / pid 复用（启动时间不符）任一命中 = 可偷。 */
function isLockOrphaned(lockPath) {
  const info = readLockInfo(lockPath)
  return info === null || !pidAlive(info.pid) || lockHolderReplaced(info)
}

/**
 * 无主锁回收：无主（三通道判定见 isLockOrphaned）→ 删锁返回 true；pid 活且身份
 * 核实一致 / 身份不可核实（旧格式、平台不支持）→ 不偷返回 false。
 */
function stealStaleLock(lockPath) {
  if (!isLockOrphaned(lockPath)) return false
  try {
    unlinkSync(lockPath)
  } catch {
    // 偷锁竞争落败（他方先删/先建）→ 由外层循环下一轮重试
  }
  return true
}

/** pid 复用判定：锁内记录了启动时间且当前该 pid 的启动时间与之不符 → 已被无关进程复用（读不到 = 无法核实，降级不偷）。 */
function lockHolderReplaced(info) {
  if (!info.started) return false
  const current = captureProcessStartTime(info.pid)
  return current !== null && current !== info.started
}

/**
 * 超时报错文案：走到超时意味着偷锁三通道都未命中（持锁 pid 存活且身份成立或
 * 不可核实），指引统一为 ps 核对——真在跑（冷缓存大 diff 首跑可达小时级）等它，
 * 无 quality-gates 在跑（pid 复用残留 / 身份不可核实）删锁重跑。不给 kill 指引：
 * pid 复用场景下被复用的 pid 属无关进程，盲目 kill 会误伤。
 */
function lockTimeoutMessage(lockPath, timeoutMs) {
  const info = readLockInfo(lockPath)
  return (
    `等待 quality-gates 互斥锁超时（${Math.round(timeoutMs / 60000)} 分钟）：${lockPath} ` +
    `被进程 ${info?.pid ?? '未知'} 持有且未释放。` +
    `恢复：ps aux | grep quality-gates.mjs 核对——确在跑则等其结束后重跑；` +
    `无 quality-gates 在跑（pid 复用 / 异常残留）则手动删除 ${lockPath} 后重跑`
  )
}

/** 组装真实依赖（测试注入点：runGates 的全部 IO 经 deps）。 */
export function createDefaultDeps(cwd = process.cwd()) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  // 产物目录迁移过渡期（design.md §7 风险 2）：coverage.json / metrics.json 读取
  // 优先新 pr-review 目录（skill-data-dir.mjs 单一解析出口），缺产物时回退旧 `.review/`
  // （向后兼容在途分支与 py 写方降级只写旧目录的情形）。回退是设计内合法路径。
  let reviewDir = null
  try {
    reviewDir = skillDataDir('pr-review', root)
  } catch {
    // realpath 失败（root 异常）→ 保持 null，读取全部走旧目录回退
  }
  // 门禁子进程统一用自举后的 env：typecheck 的 pnpm/npx 直接受益；coverage-gate.py /
  // metrics-gate.py 以 {**os.environ} 继承本 env，其内部的 npx vitest / fallow 同样受益
  const gateEnv = buildGateEnv()
  return {
    root,
    reviewDir,
    git: (args) => execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }),
    exec: (cmd, args, relCwd) => spawnSync(cmd, args, { cwd: join(root, relCwd), encoding: 'utf-8', env: gateEnv }),
    runPython: (args) => spawnSync(args[0], args.slice(1), { cwd: root, encoding: 'utf-8', env: gateEnv }),
    exists: (rel) => existsSync(join(root, rel)),
    readJson: (rel) => {
      try {
        return JSON.parse(readFileSync(join(root, rel), 'utf-8'))
      } catch {
        return null
      }
    },
    readReviewJson: (name) => {
      if (reviewDir) {
        try {
          return JSON.parse(readFileSync(join(reviewDir, name), 'utf-8'))
        } catch {
          // 新目录缺产物 → 回退旧目录
        }
      }
      try {
        return JSON.parse(readFileSync(join(root, '.review', name), 'utf-8'))
      } catch {
        return null
      }
    },
    readHead: (rel, chars = EXEMPT_HEAD_CHARS) => {
      const p = join(root, rel)
      if (!existsSync(p)) return null
      const fd = (() => { try { return readFileSync(p) } catch { return null } })()
      if (!fd) return null
      const text = fd.toString('utf-8')
      return chars === Infinity ? text : text.slice(0, chars) // 字符切片，与 py read_text()[:2400] 同口径
    },
    // worktree 级互斥锁（并发 quality-gates 串行化，根因见 acquireGateLock 头注释）
    acquireGateLock: () => acquireGateLock(gateLockPath(root)),
  }
}

/**
 * 聚合编排。返回 { exitCode, result }——result 可直接 --json 序列化；
 * 人可读输出由调用方（main）按 result.gates 渲染。
 */
export async function runGates(deps, args) {
  const gates = []
  const { side, base: explicitBase } = args
  const groups = args.only ?? null
  const on = (g) => groups === null || groups.includes(g)
  const needsPy = on('coverage') || on('metrics')

  // fail-fast：py 实体缺失在跑任何门之前报错（不静默跳过、也不白跑重型 typecheck）；
  // --only 排除 py 门时不检查（merge 阶段 1 的 typecheck,test 调用不应因 .agents 缺 py 而阻断）
  const missing = needsPy ? missingPythonEntities(deps) : []
  if (missing.length > 0) {
    return {
      exitCode: 2,
      result: {
        verdict: 'error',
        base: null,
        baseSource: null,
        gates: [],
        error: {
          message: 'pr-cr-fix 门禁脚本实体缺失（.agents 实体不入 git，恢复通道 = refs/skills-snapshot）',
          missing,
          recover: 'git archive refs/skills-snapshot | tar -x -C <workspace 根>',
        },
      },
    }
  }

  // base 只被 py 门（coverage/metrics）消费；--only 排除 py 门时无需解析（也避免
  // 在与 base 无关的环境因 ref 缺失而 exit 2）
  let base = null
  let source = 'not-selected(--only 未含 coverage/metrics)'
  if (needsPy) {
    const r = resolveBase({ side, explicitBase }, deps.git)
    base = r.base
    source = r.source
  }

  // worktree 级互斥：同 worktree 同时只允许一个 quality-gates 整体运行（并发两次
  // 会让两个 vitest coverage 跑互删 .tmp 覆盖文件、报 ENOENT 哑 FAIL，根因与修法
  // 见 acquireGateLock 头注释）。获取失败 = 环境错误（exit 2，不自动重试）。
  let release
  try {
    release = deps.acquireGateLock()
  } catch (e) {
    return {
      exitCode: 2,
      result: {
        verdict: 'error',
        base,
        baseSource: source,
        gates: [],
        error: {
          message: `quality-gates 互斥锁获取失败：${e.message}`,
          recover: '持锁进程在跑则等其结束后重跑；持锁方已退出或 pid 复用时锁会被自动回收；仍异常时 ps aux | grep quality-gates.mjs 核对，无进程在跑可手动删除报错中的锁文件后重跑',
        },
      },
    }
  }

  try {
    // 1. typecheck 四处（自跑）
    if (on('typecheck')) runTypecheckGates(deps, gates)

    // 2. coverage-gate（py）+ 3. 机器盲区判定（消费 coverage.json；py fail 时产物仍在，判定照跑并叠加明细）
    if (on('coverage')) {
      const covError = runCoverageGate(deps, base, gates)
      if (covError) return finish(deps, base, source, gates, covError)

      const blindspotError = runBlindspotGate(deps, gates)
      if (blindspotError) return finish(deps, base, source, gates, blindspotError)
    }

    // 4. metrics-gate（py；coverage 之后——消费同 base coverage.json）
    if (on('metrics')) {
      const metricsError = runMetricsGate(deps, base, gates)
      if (metricsError) return finish(deps, base, source, gates, metricsError)
    }

    // 5. 快速守卫测试族（test-suites.mjs 单一登记；恒跑不分 side——过期测试在
    //    dev 合入边界当天红，不再等终局 PR 第一次跑，v0.11.16 两连红的根因修复）
    if (on('test')) runTestSuiteGate(deps, gates)

    const hasFail = gates.some((g) => g.status === 'FAIL')
    return { exitCode: hasFail ? 1 : 0, result: { verdict: hasFail ? 'fail' : 'pass', base, baseSource: source, gates, metrics: buildMetricsBrief(deps) } }
  } finally {
    release()
  }
}

/** [runGates 拆分] fail-fast 前置：py 实体缺失清单（缺失即中止，不白跑重型 typecheck）。 */
function missingPythonEntities(deps) {
  return [COVERAGE_PY, METRICS_PY]
    .map((f) => join(PY_REL_DIR, f))
    .filter((rel) => !deps.exists(rel))
}

/** [runGates 拆分] gate 1：typecheck 四处（命令/cwd 与 pr-pre-merge.sh 同款）。 */
function runTypecheckGates(deps, gates) {
  for (const step of buildTypecheckSteps()) {
    const r = deps.exec(step.cmd, step.args, step.cwd)
    const ok = r.status === 0
    gates.push({
      name: step.name,
      status: ok ? 'PASS' : 'FAIL',
      detail: ok ? '' : typecheckFailDetail(step, r),
    })
  }
}

/** gate 5 的执行计划（devGate 族 + 前置 needs），导出供单测锁定。 */
export function buildSuiteSteps() {
  return SUITES
    .filter((s) => s.devGate)
    .map((s) => ({
      name: `test-suite:${s.id}`,
      needs: s.needs.map((n) => n.split(/\s+/)),
      args: s.cmd.split(/\s+/),
    }))
}

/**
 * [runGates 拆分] gate 5：快速守卫测试族（恒跑）。清单 = scripts/test-suites.mjs 的
 * SUITES（devGate: true 子集）；needs（如 prepare-builtin-extensions）先跑，失败即
 * 该族 FAIL 不再跑本体。命令与 ci.yml 对应步骤文本一致（对账器保证不漂移）。
 */
export function runTestSuiteGate(deps, gates) {
  for (const step of buildSuiteSteps()) {
    let needFail = null
    for (const need of step.needs) {
      const r = deps.exec(need[0], need.slice(1), '')
      if (r.status !== 0) {
        needFail = `前置 ${need.join(' ')} 失败：${tailLines((r.stderr || '') + (r.stdout || ''), 15)}`
        break
      }
    }
    if (needFail) {
      gates.push({ name: step.name, status: 'FAIL', detail: needFail })
      continue
    }
    const r = deps.exec(step.args[0], step.args.slice(1), '')
    const ok = r.status === 0
    let detail = ''
    if (!ok) {
      // spawn 失败（status null）时 stderr/stdout 恒空——同 typecheck 门实发过的哑 FAIL
      // 形态（node 版本管理器漏 PATH），补恢复动作线索
      detail = r.status === null && r.error
        ? `命令无法执行：${step.args[0]} 不在 PATH 或不可执行（${r.error.message}）。恢复：确保 pnpm/npx 在 PATH 中（node 版本管理器环境需先加载）`
        : tailLines((r.stderr || '') + (r.stdout || ''), 20)
    }
    gates.push({ name: step.name, status: ok ? 'PASS' : 'FAIL', detail })
  }
}

/** spawn 失败（status null：命令不在 PATH / 不可执行）时 stderr 与 stdout 恒空——
 *  若只拼两者会呈现为无 detail 的哑 FAIL（node 版本管理器环境漏 PATH 实例，typecheck
 *  四门齐挂且无任何线索）。此处把 r.error 与恢复动作报进 detail。 */
function typecheckFailDetail(step, r) {
  if (r.status === null && r.error) {
    return `命令无法执行：${step.cmd} 不在 PATH 或不可执行（${r.error.message}）。` +
      `注：脚本已把 node 实际安装位（含 symlink 解析）与 pnpm 官方目录追加进 PATH，仍未找到。` +
      `恢复：确保 pnpm/npx 在 PATH 中（node 版本管理器环境需先加载，如 nvm.sh）`
  }
  return tailLines((r.stderr || '') + (r.stdout || ''), 30)
}

/**
 * [runGates 拆分] gate 2：coverage-gate（py 子进程）。返回中止 error 对象或 null
 * （null = 正常推进；status 0/1 记 PASS/FAIL 后继续——产物 coverage.json 照常消费）。
 */
function runCoverageGate(deps, base, gates) {
  const cov = deps.runPython(buildCoverageCommand(join(PY_REL_DIR, COVERAGE_PY), base))
  if (cov.status === null || cov.error) {
    return { exitCode: 2, error: { message: `coverage-gate.py 无法执行（python3 缺失或不可执行）`, detail: String(cov.error || '') } }
  }
  if (cov.status === 2) {
    return { exitCode: 2, error: { message: 'coverage-gate.py 工具错误（exit 2）', detail: tailLines((cov.stderr || '') + (cov.stdout || ''), 30) } }
  }
  gates.push({
    name: 'coverage-gate',
    status: cov.status === 0 ? 'PASS' : 'FAIL',
    detail: tailLines((cov.stdout || '') + (cov.stderr || ''), 15),
  })
  return null
}

/** [runGates 拆分] gate 3：机器盲区判定（judgeNoLcov，见其头注释）。 */
function runBlindspotGate(deps, gates) {
  const report = deps.readReviewJson('coverage.json')
  if (!report) {
    return {
      exitCode: 2,
      error: {
        message: 'coverage.json 读取/解析失败（coverage-gate.py 已跑但产物不可用）',
        detail: join(deps.reviewDir ?? join(deps.root, '.review'), 'coverage.json'),
      },
    }
  }
  const blindspot = judgeNoLcov(report, deps.readHead)
  gates.push({
    name: 'coverage-blindspot',
    status: blindspot.violations.length > 0 ? 'FAIL' : 'PASS',
    detail: blindspot.violations.length > 0
      ? `${blindspot.violations.length} 个新增可执行文件无 lcov 记录：` +
        blindspot.violations.map((v) => `\n  - ${v.file} —— ${v.fix}`).join('')
      : (blindspot.exempt.length > 0 ? `${blindspot.exempt.length} 个文件走豁免通道（可见登记，不静默）` : ''),
    exempt: blindspot.exempt,
    violations: blindspot.violations,
  })
  return null
}

/**
 * [runGates 拆分] gate 4：metrics-gate（py 子进程）。返回中止 error 对象或 null。
 */
function runMetricsGate(deps, base, gates) {
  const met = deps.runPython(buildMetricsCommand(join(PY_REL_DIR, METRICS_PY), base))
  if (met.status === null || met.error) {
    return { exitCode: 2, error: { message: 'metrics-gate.py 无法执行（python3 缺失或 fallow 未安装）', detail: String(met.error || '') } }
  }
  if (met.status === 2) {
    return { exitCode: 2, error: { message: 'metrics-gate.py 工具错误（exit 2）', detail: tailLines((met.stderr || '') + (met.stdout || ''), 30) } }
  }
  gates.push({
    name: 'metrics-gate',
    status: met.status === 0 ? 'PASS' : 'FAIL',
    detail: tailLines((met.stdout || '') + (met.stderr || ''), 15),
  })
  return null
}

/** [runGates 拆分] metrics 报告呈报摘要（决策 4：降级为机器报告，不逐条 LLM 核查）。 */
function buildMetricsBrief(deps) {
  const metricsReport = deps.readReviewJson('metrics.json')
  return metricsReport
    ? {
        warn: (metricsReport.warn || []).map((w) => `${w.path || (w.files || []).join(',') || '?'}${w.line ? ':' + w.line : ''} ${w.reason || ''}`.trim()).slice(0, 20),
        targets: (metricsReport.targets?.high_crap || []).map((t) => `${t.path}:${t.line} ${t.name} (crap=${t.crap})`),
      }
    : null
}

function finish(deps, base, source, gates, { exitCode, error }) {
  return { exitCode, result: { verdict: 'error', base, baseSource: source, gates, error } }
}

function tailLines(text, n) {
  const lines = String(text).split('\n').filter((l) => l.trim())
  return lines.slice(-n).join('\n')
}

function renderHuman(result) {
  const out = []
  out.push(`[quality-gates] base=${result.base} (${result.baseSource})`)
  for (const g of result.gates) {
    out.push(`[quality-gates] ${g.name} ${g.status}`)
    if (g.detail) out.push(g.detail.split('\n').map((l) => `  ${l}`).join('\n'))
  }
  if (result.metrics && (result.metrics.warn.length || result.metrics.targets.length)) {
    out.push(`[quality-gates] metrics 报告呈报（warn=${result.metrics.warn.length} targets=${result.metrics.targets.length}，机器报告不逐条核查；深查走 code-overdesign-audit / architecture-decay-audit 手动通道）`)
    for (const w of result.metrics.warn) out.push(`  [warn] ${w}`)
    for (const t of result.metrics.targets) out.push(`  [target] ${t}`)
  }
  if (result.error) {
    out.push(`[quality-gates] ERROR ${result.error.message}`)
    if (result.error.missing) for (const m of result.error.missing) out.push(`  缺失: ${m}`)
    if (result.error.recover) out.push(`  恢复: ${result.error.recover}`)
    if (result.error.detail) out.push(result.error.detail.split('\n').map((l) => `  ${l}`).join('\n'))
  }
  out.push(`[quality-gates] verdict=${result.verdict}`)
  return out.join('\n')
}

export async function main(argv) {
  let args
  try {
    args = parseGateArgs(argv)
  } catch (e) {
    console.error(String(e.message))
    process.exit(2)
  }
  const deps = createDefaultDeps()
  const { exitCode, result } = await runGates(deps, args)
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else console.log(renderHuman(result))
  process.exit(exitCode)
}

// 被 import 时不执行（vitest 消费纯函数）；直接 node 执行时进 main
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
