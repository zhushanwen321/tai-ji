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
 * base 口径两侧差异有意保留（参数化承载，设计 §5-U1）：
 *   --side dev-merge  → base = `git merge-base github/main HEAD`（fallback main）——分支增量
 *   --side pr-cr-fix  → base = main（--base 可覆盖）——累积
 *
 * 用法：node scripts/quality-gates.mjs [--side dev-merge|pr-cr-fix] [--base <ref>] [--json]
 * 退出码：0 = 全绿；1 = 有 FAIL（typecheck / coverage / 盲区判定 / metrics fail 档）；
 *         2 = 用法/环境错误（py 实体缺失、base 无法解析、py 工具错误）
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { skillDataDir } from './skill-data-dir.mjs'

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

export function parseGateArgs(argv) {
  const out = { side: 'pr-cr-fix', base: null, json: false }
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
    } else if (a === '--json') {
      out.json = true
    } else {
      throw usageError(
        `未知参数：${a}。用法：node scripts/quality-gates.mjs [--side dev-merge|pr-cr-fix] [--base <ref>] [--json]`,
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
  }
}

/**
 * 聚合编排。返回 { exitCode, result }——result 可直接 --json 序列化；
 * 人可读输出由调用方（main）按 result.gates 渲染。
 */
export async function runGates(deps, args) {
  const gates = []
  const { side, base: explicitBase } = args

  // fail-fast：py 实体缺失在跑任何门之前报错（不静默跳过、也不白跑重型 typecheck）
  const missing = missingPythonEntities(deps)
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

  const { base, source } = resolveBase({ side, explicitBase }, deps.git)

  // 1. typecheck 四处（自跑）
  runTypecheckGates(deps, gates)

  // 2. coverage-gate（py）
  const covError = runCoverageGate(deps, base, gates)
  if (covError) return finish(deps, base, source, gates, covError)

  // 3. 机器盲区判定（消费 coverage.json；py fail 时产物仍在，判定照跑并叠加明细）
  const blindspotError = runBlindspotGate(deps, gates)
  if (blindspotError) return finish(deps, base, source, gates, blindspotError)

  // 4. metrics-gate（py；coverage 之后——消费同 base coverage.json）
  const metricsError = runMetricsGate(deps, base, gates)
  if (metricsError) return finish(deps, base, source, gates, metricsError)

  const hasFail = gates.some((g) => g.status === 'FAIL')
  return { exitCode: hasFail ? 1 : 0, result: { verdict: hasFail ? 'fail' : 'pass', base, baseSource: source, gates, metrics: buildMetricsBrief(deps) } }
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
