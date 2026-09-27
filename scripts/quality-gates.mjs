#!/usr/bin/env node
/**
 * quality-gates.mjs —— 质量门聚合出口（review-pipeline-redesign 设计 §5-U1 / §3.3 决策 4）。
 *
 * 聚合（统一出口，编排层一次调用）：
 *   1. typecheck 三处（自跑）：extensions `npx tsc --noEmit` / runtime `pnpm run typecheck` /
 *      renderer `pnpm run typecheck`——命令与 cwd 与 scripts/pr-pre-merge.sh 同款。
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
 *      .review/coverage.json 真实覆盖率）。warn 档与 high_crap 靶子清单按决策 4 降级为机器
 *      报告呈报（不逐条 LLM 核查），只有 fail 档影响本门判定。
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
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

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

/** typecheck 三处（自跑）。命令与 cwd 与 pr-pre-merge.sh 的 typecheck 步骤同款。 */
export function buildTypecheckSteps() {
  return [
    { name: 'typecheck:extensions', cmd: 'npx', args: ['tsc', '--noEmit'], cwd: 'extensions' },
    { name: 'typecheck:runtime', cmd: 'pnpm', args: ['run', 'typecheck'], cwd: 'packages/runtime' },
    { name: 'typecheck:renderer', cmd: 'pnpm', args: ['run', 'typecheck'], cwd: 'packages/renderer' },
  ]
}

/**
 * 可执行行口径（决策 4 判定边界②）：非空非注释的语句行；
 * interface/type/常量/纯导出聚合等无可执行分支的文件整文件排除。
 *
 * 取向：宁可误 FAIL（保守）不可漏 FAIL——误 FAIL 的出口是豁免标记，漏 FAIL 复活机器盲区。
 * 形态清单外的行（function/class/enum/控制流/未识别）一律视为可执行。
 * .vue 含 template 渲染行为面，不做整文件排除（豁免标记通道仍可用）。
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
  let i = 0
  const n = content.length
  let state = 'code' // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = content[i]
    const d = content[i + 1]
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue }
      if (c === "'") { state = 'sq'; out += c; i++; continue }
      if (c === '"') { state = 'dq'; out += c; i++; continue }
      if (c === '`') { state = 'tpl'; out += c; i++; continue }
      out += c; i++; continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c } else { out += ' ' }
      i++; continue
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue }
      out += c === '\n' ? '\n' : ' '
      i++; continue
    }
    // 字符串态：字面量内容抹成空格（保留边界引号），转义跳过
    if (c === '\\') { out += '  '; i += 2; continue }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code'; out += c; i++; continue
    }
    out += c === '\n' ? '\n' : ' '
    i++
  }
  return out
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
    // 单行即闭合（无括号开启的声明行，如 let x = 1）也到此为止
    if (!started && /;\s*$/.test(lines[i])) return i + 1
  }
  return lines.length
}

/** 常量/变量声明体内是否出现执行形态（调用 / new / await / 箭头 / 函数·类定义等）。 */
function looksExecutable(body) {
  return /(=>|\bnew\b|\bawait\b|\byield\b|\basync\b|\bfunction\b|\bclass\b|\bthrow\b|\breturn\b|\bif\b|\bfor\b|\bwhile\b|\bswitch\b|\btry\b|[\w$)\]]\s*\()/.test(body)
}

/**
 * 机器盲区判定（决策 4）。输入 = coverage-gate.py 产出的 report（.review/coverage.json），
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
      if (full !== null && !hasExecutableLines(full, file)) continue // 纯类型/常量/聚合面，整文件排除
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

/** 组装真实依赖（测试注入点：runGates 的全部 IO 经 deps）。 */
export function createDefaultDeps(cwd = process.cwd()) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  return {
    root,
    git: (args) => execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }),
    exec: (cmd, args, relCwd) => spawnSync(cmd, args, { cwd: join(root, relCwd), encoding: 'utf-8' }),
    runPython: (args) => spawnSync(args[0], args.slice(1), { cwd: root, encoding: 'utf-8' }),
    exists: (rel) => existsSync(join(root, rel)),
    readJson: (rel) => {
      try {
        return JSON.parse(readFileSync(join(root, rel), 'utf-8'))
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
  const missing = [COVERAGE_PY, METRICS_PY]
    .map((f) => join(PY_REL_DIR, f))
    .filter((rel) => !deps.exists(rel))
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

  // 1. typecheck 三处（自跑）
  for (const step of buildTypecheckSteps()) {
    const r = deps.exec(step.cmd, step.args, step.cwd)
    const ok = r.status === 0
    gates.push({
      name: step.name,
      status: ok ? 'PASS' : 'FAIL',
      detail: ok ? '' : tailLines((r.stderr || '') + (r.stdout || ''), 30),
    })
  }

  // 2. coverage-gate（py）
  const cov = deps.runPython(buildCoverageCommand(join(PY_REL_DIR, COVERAGE_PY), base))
  if (cov.status === null || cov.error) {
    return finish(deps, base, source, gates, {
      exitCode: 2,
      error: { message: `coverage-gate.py 无法执行（python3 缺失或不可执行）`, detail: String(cov.error || '') },
    })
  }
  if (cov.status === 2) {
    return finish(deps, base, source, gates, {
      exitCode: 2,
      error: { message: 'coverage-gate.py 工具错误（exit 2）', detail: tailLines((cov.stderr || '') + (cov.stdout || ''), 30) },
    })
  }
  gates.push({
    name: 'coverage-gate',
    status: cov.status === 0 ? 'PASS' : 'FAIL',
    detail: tailLines((cov.stdout || '') + (cov.stderr || ''), 15),
  })

  // 3. 机器盲区判定（消费 coverage.json；py fail 时产物仍在，判定照跑并叠加明细）
  const report = deps.readJson('.review/coverage.json')
  if (!report) {
    return finish(deps, base, source, gates, {
      exitCode: 2,
      error: { message: 'coverage.json 读取/解析失败（coverage-gate.py 已跑但产物不可用）', detail: join(deps.root, '.review', 'coverage.json') },
    })
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

  // 4. metrics-gate（py；coverage 之后——消费同 base coverage.json）
  const met = deps.runPython(buildMetricsCommand(join(PY_REL_DIR, METRICS_PY), base))
  if (met.status === null || met.error) {
    return finish(deps, base, source, gates, {
      exitCode: 2,
      error: { message: 'metrics-gate.py 无法执行（python3 缺失或 fallow 未安装）', detail: String(met.error || '') },
    })
  }
  if (met.status === 2) {
    return finish(deps, base, source, gates, {
      exitCode: 2,
      error: { message: 'metrics-gate.py 工具错误（exit 2）', detail: tailLines((met.stderr || '') + (met.stdout || ''), 30) },
    })
  }
  gates.push({
    name: 'metrics-gate',
    status: met.status === 0 ? 'PASS' : 'FAIL',
    detail: tailLines((met.stdout || '') + (met.stderr || ''), 15),
  })
  // warn 档与 targets 呈报（决策 4：降级为机器报告，不逐条 LLM 核查；fail 档已由上方 status 承接）
  const metricsReport = deps.readJson('.review/metrics.json')
  const metricsBrief = metricsReport
    ? {
        warn: (metricsReport.warn || []).map((w) => `${w.path || (w.files || []).join(',') || '?'}${w.line ? ':' + w.line : ''} ${w.reason || ''}`.trim()).slice(0, 20),
        targets: (metricsReport.targets?.high_crap || []).map((t) => `${t.path}:${t.line} ${t.name} (crap=${t.crap})`),
      }
    : null

  const hasFail = gates.some((g) => g.status === 'FAIL')
  return { exitCode: hasFail ? 1 : 0, result: { verdict: hasFail ? 'fail' : 'pass', base, baseSource: source, gates, metrics: metricsBrief } }
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
