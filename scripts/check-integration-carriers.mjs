#!/usr/bin/env node
/**
 * check-integration-carriers.mjs — 集成门控组载体登记漂移检查。
 *
 * 检测形态：vitest.config.ts 的 INTEGRATION_TESTS 成员文件内存在未被
 * `describe.skipIf(!INTEGRATION_TESTS_ENABLED)` 包裹的用例、却未登记
 * INTEGRATION_UNGATED_CARRIERS。后果 = 门控关闭时 integration project 的 include
 * 条件化只收集载体表，该文件不被收集——其中的非门控用例静默消失（无报错、
 * 无 skip 记录），等价于用例被删（maintenance contract 见 runtime vitest.config.ts
 * 文件头「INTEGRATION_TESTS 成员若含未包门控的用例」段）。
 *
 * 检查项（对每个含 INTEGRATION_TESTS 表的 vitest.config.ts）：
 *   1. 两表提取（注释剥离后取字符串字面量）；INTEGRATION_UNGATED_CARRIERS 必须
 *      ⊆ INTEGRATION_TESTS（载体登记指向非成员 = 死登记）；
 *   2. 成员文件磁盘存在（成员被删/改名后表未更新 = 死登记）；
 *   3. 非载体成员文件逐用例覆盖判定：
 *      - 位于 describe.skipIf(!INTEGRATION_TESTS_ENABLED) 调用区间内 → 门控 ✓
 *      - it.skipIf(...) / test.skipIf(...) → 用例级条件门控 ✓
 *      - it.skip / it.todo → 恒不执行 ✓
 *      - 裸 it( / test(（含 .each / .concurrent 形态）落在所有门控区间外 → ✗ 违例
 *
 * 保守原则（误报趋零）：静态解析能力不足时（括号配对失败、文件内无任何可识别
 * 结构）输出 WARNING 放行并提示人工确认，不 fail——本检查只拦「确定能证明的
 * 漂移」，不制造需要豁免登记的误报噪音。
 *
 * 只做静态扫描，不执行测试。用法：node scripts/check-integration-carriers.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const toPosix = (p) => p.split(path.sep).join('/')

/** 扫描这些目录下一层的 vitest.config.ts（当前唯一持有两表结构的是 packages/runtime；
 * 未来其他包引入同结构即自动纳入）。 */
const SCAN_ROOTS = ['packages']

// ── 掩码状态机：把注释 / 字符串 / 模板 / 正则字面量替换为等长空白 ────────────
// 目的：后续的 skipIf 区间提取与 it/test 识别只看真实代码。模板插值 ${...} 内
// 恢复代码态（栈式），避免合法插值破坏括号配对。正则 vs 除法用前缀 token 启发，
// 误判只影响掩码完整性，最坏退化为 WARNING 放行（保守方向）。
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';',
  '+', '-', '*', '%', '<', '>', '~', '^',
])

/** 区间掩为等长空白（保留换行，行列号不变）。 */
function blankRange(src, out, from, to) {
  for (let k = from; k < to; k++) {
    if (src[k] !== '\n' && src[k] !== '\r') out[k] = ' '
  }
}

/** from 起向前最近一个非空白字符；无则返回 ''（正则 vs 除法的启发判据）。 */
function lastMeaningfulChar(src, from) {
  for (let k = from; k >= 0; k--) {
    if (!/\s/.test(src[k])) return src[k]
  }
  return ''
}

/** 行注释掩码：返回注释段之后（换行符）下标。 */
function maskLineComment(src, out, i) {
  const end = src.indexOf('\n', i)
  const stop = end === -1 ? src.length : end
  blankRange(src, out, i, stop)
  return stop
}

/** 块注释掩码：返回注释段之后下标。 */
function maskBlockComment(src, out, i) {
  const end = src.indexOf('*/', i + 2)
  const stop = end === -1 ? src.length : end + 2
  blankRange(src, out, i, stop)
  return stop
}

/** 单双引号字符串掩码：返回字符串段之后下标（未闭合按保守中断不留跨行掩码）。 */
function maskQuotedString(src, out, i) {
  const n = src.length
  const quote = src[i]
  let j = i + 1
  while (j < n && src[j] !== quote) {
    if (src[j] === '\\') j++
    if (src[j] === '\n') break // 未闭合字符串：保守中断，不留跨行掩码
    j++
  }
  blankRange(src, out, i, Math.min(j + 1, n))
  return j + 1
}

/** 正则字面量结束下标（越过 flags）；识别失败（不跨行 / 未闭合）返回 -1。 */
function regexLiteralEnd(src, i) {
  const n = src.length
  let j = i + 1
  let inClass = false
  while (j < n) {
    const rc = src[j]
    if (rc === '\\') { j += 2; continue }
    if (rc === '\n') return -1 // 正则不跨行：识别失败，按除法放弃
    if (inClass) { if (rc === ']') inClass = false }
    else if (rc === '[') inClass = true
    else if (rc === '/') {
      let end = j + 1
      while (end < n && /[a-z]/.test(src[end])) end++ // flags
      return end
    }
    j++
  }
  return -1
}

/** code 态 '/'：按前缀 token 启发判正则 vs 除法，正则掩码、除法原样。返回下一处理下标。 */
function maskSlash(src, out, i) {
  const prev = lastMeaningfulChar(src, i - 1)
  const isRegex = prev === '' || REGEX_PRECEDERS.has(prev)
  if (!isRegex) return i + 1
  const end = regexLiteralEnd(src, i)
  if (end === -1) return i + 1
  blankRange(src, out, i, end)
  return end
}

/** code 态单字符处理：注释 / 字符串 / 模板进入 / 插值深度跟踪 / 正则。返回下一处理下标。 */
function maskCodeChar(src, out, stack, i) {
  const n = src.length
  const frame = stack[stack.length - 1]
  const c = src[i]
  const next = i + 1 < n ? src[i + 1] : ''
  if (c === '/' && next === '/') return maskLineComment(src, out, i)
  if (c === '/' && next === '*') return maskBlockComment(src, out, i)
  if (c === "'" || c === '"') return maskQuotedString(src, out, i)
  if (c === '`') {
    out[i] = ' '
    stack.push({ kind: 'template' })
    return i + 1
  }
  if (c === '{' && frame.interpDepth !== undefined) frame.interpDepth++
  if (c === '}' && frame.interpDepth !== undefined) {
    if (frame.interpDepth === 0) {
      // 配对插值的闭 }：退回模板态，该字符掩掉
      out[i] = ' '
      stack.pop()
      return i + 1
    }
    frame.interpDepth--
  }
  if (c === '/') return maskSlash(src, out, i)
  return i + 1
}

/** template 态单字符处理：内容整体掩码，遇 ${ 进插值帧（code 态 + 深度跟踪），遇 ` 结束。 */
function maskTemplateChar(src, out, stack, i) {
  const n = src.length
  const c = src[i]
  const next = i + 1 < n ? src[i + 1] : ''
  if (c === '\\') {
    out[i] = ' '
    if (i + 1 < n) out[i + 1] = ' '
    return i + 2
  }
  if (c === '$' && next === '{') {
    out[i] = ' '
    out[i + 1] = ' '
    stack.push({ kind: 'code', interpDepth: 0 })
    return i + 2
  }
  if (c === '`') {
    out[i] = ' '
    stack.pop()
    return i + 1
  }
  if (c !== '\n' && c !== '\r') out[i] = ' '
  return i + 1
}

function maskSource(src) {
  const out = src.split('')
  // 栈帧：'code' = 普通代码态（interpDepth 非 undefined = 由模板插值 ${ 进入，
  // 需跟踪花括号深度，配对的 } 处退回模板态）；'template' = 模板字面量态
  const stack = [{ kind: 'code' }]
  let i = 0
  while (i < src.length) {
    const frame = stack[stack.length - 1]
    i = frame.kind === 'code' ? maskCodeChar(src, out, stack, i) : maskTemplateChar(src, out, stack, i)
  }
  return out.join('')
}

/** 从掩码文本上做括号配对：返回与 openIdx 配对的闭括号下标；失败返回 -1。 */
const BRACKET_PAIRS = { '(': ')', '[': ']', '{': '}' }
function matchBracket(masked, openIdx) {
  const open = masked[openIdx]
  const close = BRACKET_PAIRS[open]
  if (close === undefined) return -1
  let depth = 0
  for (let i = openIdx; i < masked.length; i++) {
    const c = masked[i]
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 从数组字面量段提取字符串成员。定位（含注释剔除）在掩码文本上做，成员字符串
 * 从原文本同区间提取（掩码等长，下标通用）——掩码文本上字面量已是空白，直接
 * 提取会恒为空。 */
function extractStringArray(configSrc, configMasked, constName) {
  const re = new RegExp(`\\b${constName}\\s*:\\s*\\[|\\bconst\\s+${constName}\\s*=\\s*\\[`)
  const m = re.exec(configMasked)
  if (!m) return null
  const openIdx = maskedIndexOf(configMasked, m.index, '[')
  if (openIdx === -1) return null
  const closeIdx = matchBracket(configMasked, openIdx)
  if (closeIdx === -1) return null
  const body = configSrc.slice(openIdx + 1, closeIdx)
  const members = []
  const strRe = /'([^']*)'|"([^"]*)"/g
  let sm
  while ((sm = strRe.exec(body)) !== null) members.push(sm[1] ?? sm[2])
  return members
}

/** 区间内第一个指定字符的下标。 */
function maskedIndexOf(masked, from, ch) {
  const idx = masked.indexOf(ch, from)
  return idx
}

// ── 成员文件用例覆盖扫描 ──────────────────────────────────────────────────
const SKIP_IF_RE = /\bdescribe\s*\.\s*skipIf\s*\(/g
/** 用例定义起点：it/test 后跟可选 `.modifier` 再跟 `(`。前导 `.`（如 obj.it(）排除。 */
const CASE_RE = /\b(?:it|test)(?:\s*\.\s*(\w+)\s*)?\s*\(/g
const CASE_MODIFIERS_NEED_COVER = new Set([undefined, 'each', 'concurrent', 'fails'])

/** 单个 describe.skipIf(...) 的门控 describe 调用区间（第二实参括号区间）；
 * 无法静态配对 / 非标准形态时 push warning 并返回 null（保守放行）。 */
function gatedDescribeRange(masked, fromIdx, relForLog, warnings) {
  const condOpen = maskedIndexOf(masked, fromIdx, '(')
  const condClose = condOpen === -1 ? -1 : matchBracket(masked, condOpen)
  if (condClose === -1) {
    warnings.push(`${relForLog}：describe.skipIf(...) 实参括号无法静态配对，跳过该处覆盖判定（请人工确认）`)
    return null
  }
  // 跳过空白找 describe 调用的实参开括号
  let callOpen = condClose + 1
  while (callOpen < masked.length && /\s/.test(masked[callOpen])) callOpen++
  if (masked[callOpen] !== '(') {
    warnings.push(`${relForLog}：describe.skipIf(...) 后未紧跟调用括号（非标准形态），跳过该处覆盖判定`)
    return null
  }
  const callClose = matchBracket(masked, callOpen)
  if (callClose === -1) {
    warnings.push(`${relForLog}：describe.skipIf(...) 调用体括号无法静态配对，跳过该处覆盖判定（请人工确认）`)
    return null
  }
  return [callOpen, callClose]
}

/** 门控 describe 区间收集：describe.skipIf(...)( 'name', fn ) 的第二个实参括号区间。 */
function collectGatedRanges(masked, relForLog, warnings) {
  const gatedRanges = []
  SKIP_IF_RE.lastIndex = 0
  let m
  while ((m = SKIP_IF_RE.exec(masked)) !== null) {
    const range = gatedDescribeRange(masked, m.index + m[0].length - 1, relForLog, warnings)
    if (range) gatedRanges.push(range)
  }
  return gatedRanges
}

/** 扫描单个成员文件：返回 { violations: string[], warnings: string[] }（含行号前缀）。 */
function scanMemberFile(absPath, relForLog) {
  const violations = []
  const warnings = []
  const src = readFileSync(absPath, 'utf-8')
  const masked = maskSource(src)
  const gatedRanges = collectGatedRanges(masked, relForLog, warnings)

  const inGated = (idx) => gatedRanges.some(([a, b]) => idx > a && idx < b)
  const lineOf = (idx) => src.slice(0, idx).split('\n').length

  CASE_RE.lastIndex = 0
  let m
  while ((m = CASE_RE.exec(masked)) !== null) {
    const start = m.index
    // 排除属性访问形态（foo.it( / x.test(）
    let p = start - 1
    while (p >= 0 && /\s/.test(masked[p])) p--
    if (p >= 0 && masked[p] === '.') continue
    const modifier = m[1]
    if (!CASE_MODIFIERS_NEED_COVER.has(modifier)) continue // skipIf/skip/todo：已门控或恒不执行
    if (inGated(start)) continue
    const snippet = src.slice(start, start + 100).split('\n')[0].trim()
    violations.push(`${relForLog}:${lineOf(start)}：用例未被 describe.skipIf(!INTEGRATION_TESTS_ENABLED) 包裹 → ${snippet}`)
  }

  // 完全无可识别结构（既无用例也无 skipIf describe）：可能是解析失败，保守提示
  const hasCase = /\b(?:it|test)\s*\(/.test(masked)
  if (!hasCase && gatedRanges.length === 0) {
    warnings.push(`${relForLog}：文件内未识别到任何用例或门控 describe（可能为非测试形态成员），请人工确认`)
  }
  return { violations, warnings }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const failures = []
const warningLines = []
let checkedFiles = 0
let checkedConfigs = 0

for (const root of SCAN_ROOTS) {
  const absRoot = path.join(REPO_ROOT, root)
  if (!existsSync(absRoot)) continue
  for (const entry of readdirSync(absRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const configPath = path.join(absRoot, entry.name, 'vitest.config.ts')
    if (!existsSync(configPath)) continue
    const configSrc = readFileSync(configPath, 'utf-8')
    const configMasked = maskSource(configSrc)
    const integration = extractStringArray(configSrc, configMasked, 'INTEGRATION_TESTS')
    if (integration === null) continue // 无两表结构的 config：不属于本检查范围
    checkedConfigs++
    const carriers = extractStringArray(configSrc, configMasked, 'INTEGRATION_UNGATED_CARRIERS') ?? []
    const pkgRoot = path.join(absRoot, entry.name)
    const relConfig = toPosix(path.relative(REPO_ROOT, configPath))

    // 检查 1：载体表 ⊆ 成员表
    const integrationSet = new Set(integration)
    for (const carrier of carriers) {
      if (!integrationSet.has(carrier)) {
        failures.push(`${relConfig}：INTEGRATION_UNGATED_CARRIERS 成员 '${carrier}' 不在 INTEGRATION_TESTS 中（死登记：载体表必须是成员表子集）`)
      }
    }

    // 检查 2 + 3：成员存在性 + 非载体成员的门控覆盖
    const carrierSet = new Set(carriers)
    for (const member of integration) {
      const absMember = path.join(pkgRoot, member)
      if (!existsSync(absMember)) {
        failures.push(`${relConfig}：INTEGRATION_TESTS 成员 '${member}' 磁盘不存在（死登记：文件被删/改名后表未更新）`)
        continue
      }
      if (carrierSet.has(member)) continue // 已登记载体：允许含非门控用例
      checkedFiles++
      const relMember = toPosix(path.relative(REPO_ROOT, absMember))
      const { violations, warnings } = scanMemberFile(absMember, relMember)
      failures.push(...violations)
      warningLines.push(...warnings)
    }
  }
}

if (checkedConfigs === 0) {
  console.error('[integration-carriers] 未找到任何含 INTEGRATION_TESTS 表的 vitest.config.ts（扫描范围异常），请人工确认')
  process.exit(1)
}

if (failures.length > 0) {
  console.error(`[integration-carriers] 检查拦截：${failures.length} 项违规\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  console.error('')
  console.error('[FIX] 二选一：')
  console.error('  ① 文件内全部用例门控开启时才该跑 → 把裸用例包进 describe.skipIf(!INTEGRATION_TESTS_ENABLED)')
  console.error('     （import INTEGRATION_TESTS_ENABLED from test-guard/integration-gate.ts，先例见 packages/runtime/test/server-subagent.test.ts）')
  console.error('  ② 门控关闭时仍有用例该跑（mock 快用例等） → 把文件登记进该包 vitest.config.ts 的')
  console.error('     INTEGRATION_UNGATED_CARRIERS（漏登记 = 门控关闭时这些用例静默消失，无报错无 skip 记录）')
  process.exit(1)
}

for (const w of warningLines) console.warn(`  ⚠ ${w}`)
console.log(
  `[integration-carriers] OK：${checkedConfigs} 个 config 的两表自洽，` +
    `${checkedFiles} 个非载体成员文件逐用例门控覆盖通过` +
    (warningLines.length > 0 ? `（${warningLines.length} 条 WARNING，见上）` : ''),
)
