#!/usr/bin/env node
/**
 * check-capability-allowlist-sync.mjs —— capability 清单 ↔ 渲染管线白名单对拍守卫。
 * （设计：.tmp/tech-design/chat-html-support.md §6.1 D1 / §10 u1-prompt / §11 检查点 8 同型）
 *
 * 背景：system prompt 的 capability 段把「对话流渲染管线的 HTML 能力边界」告知 AI。这段
 * 文案的成员集合以结构化常量承载在 extensions/taiji/system-prompt/src/index.ts
 * （CAPABILITY_INLINE_TAG_FAMILIES / CAPABILITY_PRESENTATION_ATTRS / CAPABILITY_FORBIDDEN），
 * 但**真实白名单**是 packages/renderer/src/composables/logic/markdown-sanitize.ts 的
 * ALLOWED_TAGS / ALLOWED_ATTR。两侧是跨包双份手工维护——渲染白名单改了而清单忘跟（或反之）
 * 就是 agent 被教会的能力与实际行为漂移。本守卫在提交期做**源文件字面量集合对拍**（零散文
 * 解析，跨包不可 import 不是豁免理由——u-artifacts 的公式对拍同为读源文件文本形态）：
 *
 *   ① 正面标签清单 === ALLOWED_TAGS 字面量集合（双向对拍：多出 = 教会了会被剥的标签；
 *      缺失 = 白名单新增未告知）；
 *   ② 正面属性清单 === ALLOWED_ATTR 字面量集合（同款双向）；
 *   ③ 负面清单与剥除语义一致：禁用标签均不在 ALLOWED_TAGS；禁用属性（含 data-* / on* 通配）
 *      均不在 ALLOWED_ATTR；`data-*` 通配的存在要求净化层 ALLOW_DATA_ATTR === false，
 *      `aria-*` 面要求净化层 ALLOW_ARIA_ATTR === false（两者的构造性收窄语义锚点——
 *      DOMPurify 两旗标均默认 true 且判定优先于 ALLOWED_ATTR，不关掉则通配越过声明面放行，
 *      声明清单 ≠ 有效放行面）。
 *
 * 呈报骨架（✓/✗ 行 + failed 旗标 + 对拍呈报 + 汇总出口）与 scripts 家族共享：
 * scripts/lib/guard-report.mjs。
 *
 * 用法：
 *   node scripts/check-capability-allowlist-sync.mjs               # 常规校验（pre-commit 按路径触发）
 *   node scripts/check-capability-allowlist-sync.mjs --self-test   # 纯函数轻量自检
 *
 * 零第三方依赖。退出码：0 = 通过；1 = 存在 fail。提取失败一律 fail（宁可误报不可漏报，
 * 源文件形态变化时红灯提示人工同步）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fail, ok, isFailed, guardExit, reportSetCompare, setDiff } from './lib/guard-report.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SYSTEM_PROMPT_SRC = join(ROOT, 'extensions', 'taiji', 'system-prompt', 'src', 'index.ts')
const SANITIZE_SRC = join(ROOT, 'packages', 'renderer', 'src', 'composables', 'logic', 'markdown-sanitize.ts')

// ── 纯函数（--self-test 覆盖）────────────────────────────────────────

/** 剔除行注释与块注释——常量块内注释里的引号字符串不得被当成成员。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * 取 `const <name> ... = <数组/对象字面量>` 的初始化块文本（含外层括号）。
 * 注释先剥离；括号平衡扫描在 scanBalancedBlock（字符串字面量内的括号不计数）。
 */
export function extractInitializer(text, constName) {
  const clean = stripComments(text)
  const decl = clean.match(new RegExp(`const\\s+${constName}\\b`))
  if (!decl) return { error: `未找到 const ${constName} 声明（改名 / 移动？）` }
  const eq = clean.indexOf('=', decl.index)
  if (eq < 0) return { error: `const ${constName} 缺初始化赋值` }
  const start = skipWs(clean, eq + 1)
  if (clean[start] !== '[' && clean[start] !== '{') {
    return { error: `const ${constName} 初始化不是数组 / 对象字面量（形态变化？）` }
  }
  return scanBalancedBlock(clean, start, constName)
}

/** 从 i 起跳过空白，返回首个非空白字符下标。 */
function skipWs(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

/**
 * 括号平衡扫描（extractInitializer 的扫描半体）：从起始括号扫到与之配对的闭括号，
 * 返回含外层括号的块文本。字符串字面量内的括号 / 转义不参与配对；不平衡 = 源文件
 * 截断，报 error。
 */
function scanBalancedBlock(clean, start, constName) {
  const stack = []
  let inString = null
  let out = ''
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i]
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += clean[++i] ?? ''
        continue
      }
      if (ch === inString) inString = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
    } else if (ch === '[' || ch === '{') {
      stack.push(ch === '[' ? ']' : '}')
    } else if (ch === stack[stack.length - 1]) {
      stack.pop()
      out += ch
      if (stack.length === 0) return { text: out }
      continue
    }
    out += ch
  }
  return { error: `const ${constName} 字面量括号不平衡（截断？）` }
}

/** 提取文本内全部字符串字面量（去空串），不做语义排序。 */
function extractStringLiterals(text) {
  return [...text.matchAll(/["']([^"']+)["']/g)].map((x) => x[1])
}

/** 从对象初始化块里取 `<field>: [ ... ]` 子数组的字面量集合。 */
export function extractSubArrayLiterals(objectBlock, field) {
  const m = objectBlock.match(new RegExp(`${field}\\s*:\\s*\\[([\\s\\S]*?)\\]`))
  if (!m) return { error: `对象块内未找到 ${field}: [...] 子数组（形态变化？）` }
  const values = extractStringLiterals(m[1])
  if (values.length === 0) return { error: `${field} 子数组提取不到任何字符串字面量` }
  return { values }
}

/** 取顶层（数组）常量的成员集合。 */
export function extractArrayConst(text, constName) {
  const block = extractInitializer(text, constName)
  if (block.error) return block
  const values = extractStringLiterals(block.text)
  if (values.length === 0) return { error: `const ${constName} 提取不到任何字符串字面量` }
  return { values }
}

/** 取对象常量（family -> string[]）的全部值字面量——对象键为裸标识符，不进集合。 */
export function extractRecordValues(text, constName) {
  const block = extractInitializer(text, constName)
  if (block.error) return block
  const values = extractStringLiterals(block.text)
  if (values.length === 0) return { error: `const ${constName} 提取不到任何字符串字面量` }
  return { values }
}

/** 属性匹配：条目以 `*` 结尾时按前缀匹配，否则精确匹配。 */
function attrMatches(entry, candidate) {
  return entry.endsWith('*') ? candidate.startsWith(entry.slice(0, -1)) : candidate === entry
}

// ── --self-test：纯函数轻量自检（不触真实仓库文件）────────────────────

function selfTest() {
  const assert = (cond, name) => {
    if (!cond) {
      console.error(`  ✗ self-test: ${name}`)
      process.exitCode = 1
    } else {
      console.log(`  ✓ self-test: ${name}`)
    }
  }

  const ts1 = `const ALLOWED_TAGS = [\n  'a', 'b', // 'x' 注释里的引号不算成员\n]`
  assert(
    JSON.stringify(extractArrayConst(ts1, 'ALLOWED_TAGS').values) === JSON.stringify(['a', 'b']),
    '数组常量提取 + 行注释剔除',
  )
  const ts2 = `const CAPABILITY_INLINE_TAG_FAMILIES: Readonly<Record<string, readonly string[]>> = {\n  headings: ['h1', 'h2'],\n  table: ['table'],\n}`
  assert(
    JSON.stringify(extractRecordValues(ts2, 'CAPABILITY_INLINE_TAG_FAMILIES').values) ===
      JSON.stringify(['h1', 'h2', 'table']),
    '对象常量（族 -> tags）值提取，键不入集合',
  )
  const ts3 = `export const CAPABILITY_FORBIDDEN = {\n  tags: ['script', 'svg'],\n  attributes: ['class', 'data-*'],\n}`
  const block = extractInitializer(ts3, 'CAPABILITY_FORBIDDEN')
  assert(
    JSON.stringify(extractSubArrayLiterals(block.text, 'tags').values) === JSON.stringify(['script', 'svg']),
    '对象块 tags 子数组提取',
  )
  assert(
    JSON.stringify(extractSubArrayLiterals(block.text, 'attributes').values) === JSON.stringify(['class', 'data-*']),
    '对象块 attributes 子数组提取（含通配）',
  )
  assert(extractInitializer('const OTHER = 1', 'ALLOWED_TAGS').error !== undefined, '常量缺失报 error')
  assert(
    extractInitializer('const X: readonly string[] = someCall()', 'X').error !== undefined,
    '非字面量初始化报 error',
  )
  const d = setDiff(['a', 'b'], ['b', 'c'])
  assert(JSON.stringify(d.extra) === '["a"]' && JSON.stringify(d.missing) === '["c"]', 'setDiff 双向差异')
  assert(attrMatches('data-*', 'data-x') && !attrMatches('data-*', 'data') && attrMatches('class', 'class'), 'attrMatches 通配/精确')

  if (process.exitCode === 1) {
    console.error('capability-allowlist-sync self-test 未通过')
    process.exit(1)
  }
  console.log('✓ capability-allowlist-sync self-test 全部通过')
  process.exit(0)
}

if (process.argv.includes('--self-test')) selfTest()

// ── main()：CLI 直跑才执行 ──────────────────────────────────────────

function readTextOrFail(filePath, label) {
  if (!existsSync(filePath)) {
    fail(`${label} 缺失: ${filePath}——恢复动作：确认文件未被移动 / 删除（迁移时同步本守卫路径）`)
    return null
  }
  return readFileSync(filePath, 'utf-8')
}

/**
 * 提取阶段：读两侧源文件 + 抽出全部比对面成员。任一提取失败 → ✗ 明细 + fail-fast
 * （提取失败一律 fail，宁可误报不可漏报）。返回值里的成员集全是已过提取的 values。
 */
function extractInputsOrFail() {
  const spText = readTextOrFail(SYSTEM_PROMPT_SRC, 'system-prompt 源文件')
  const sanitizeText = readTextOrFail(SANITIZE_SRC, '渲染净化源文件')
  if (spText === null || sanitizeText === null) process.exit(1)

  // 权威侧（渲染管线真实白名单）
  const allowedTags = extractArrayConst(sanitizeText, 'ALLOWED_TAGS')
  const allowedAttrs = extractArrayConst(sanitizeText, 'ALLOWED_ATTR')
  if (allowedTags.error) {
    fail(`渲染侧 ALLOWED_TAGS 提取失败: ${allowedTags.error}——恢复动作：核对 ${SANITIZE_SRC} 后同步本守卫提取正则`)
  }
  if (allowedAttrs.error) {
    fail(`渲染侧 ALLOWED_ATTR 提取失败: ${allowedAttrs.error}——恢复动作：核对 ${SANITIZE_SRC} 后同步本守卫提取正则`)
  }

  // 清单侧（capability 常量）
  const capTags = extractRecordValues(spText, 'CAPABILITY_INLINE_TAG_FAMILIES')
  const capAttrs = extractArrayConst(spText, 'CAPABILITY_PRESENTATION_ATTRS')
  const forbidden = extractInitializer(spText, 'CAPABILITY_FORBIDDEN')
  if (capTags.error) fail(`capability 标签清单提取失败: ${capTags.error}`)
  if (capAttrs.error) fail(`capability 属性清单提取失败: ${capAttrs.error}`)
  if (forbidden.error) fail(`capability 禁用清单提取失败: ${forbidden.error}`)
  if (isFailed()) {
    console.error('capability 清单对拍：提取阶段失败，按上方 ✗ 修复后重跑')
    process.exit(1)
  }

  const forbiddenTags = extractSubArrayLiterals(forbidden.text, 'tags')
  const forbiddenAttrs = extractSubArrayLiterals(forbidden.text, 'attributes')
  if (forbiddenTags.error) fail(`CAPABILITY_FORBIDDEN.tags 提取失败: ${forbiddenTags.error}`)
  if (forbiddenAttrs.error) fail(`CAPABILITY_FORBIDDEN.attributes 提取失败: ${forbiddenAttrs.error}`)
  if (isFailed()) {
    console.error('capability 清单对拍：禁用清单提取失败，按上方 ✗ 修复后重跑')
    process.exit(1)
  }

  return {
    sanitizeText,
    capTags: capTags.values,
    capAttrs: capAttrs.values,
    allowedTags: allowedTags.values,
    allowedAttrs: allowedAttrs.values,
    forbiddenTags: forbiddenTags.values,
    forbiddenAttrs: forbiddenAttrs.values,
  }
}

/**
 * ①/② 共用骨架：正面清单 ↔ 渲染白名单双向对拍（多出与缺失都是漂移）。
 * 清单面文案（标签 / 属性）与恢复动作由参数给定。
 */
function comparePositiveList({ listLabel, allowedName, capValues, allowedValues, okNote, extraPart, missingPart, recovery }) {
  reportSetCompare(capValues, allowedValues, {
    okMsg: `正面${listLabel}清单与 ${allowedName} 一致（${capValues.length} 项${okNote}）`,
    extraPart,
    missingPart,
    failHeader: `正面${listLabel}清单与 ${allowedName} 漂移: `,
    failSuffix: `——恢复动作：${recovery}`,
  })
}

/** ① 正面标签清单 ↔ ALLOWED_TAGS（双向）。 */
function compareTags(input) {
  comparePositiveList({
    listLabel: '标签',
    allowedName: 'ALLOWED_TAGS',
    capValues: input.capTags,
    allowedValues: input.allowedTags,
    okNote: '，含族归类',
    extraPart: (xs) => `清单多出未放行标签: ${xs.join(', ')}（会被净化层剥除，agent 被教会了无效能力）`,
    missingPart: (xs) => `白名单新增未入清单: ${xs.join(', ')}（agent 不知道可用）`,
    recovery: `人工核对 ${SANITIZE_SRC} 的 ALLOWED_TAGS 后同步 ${SYSTEM_PROMPT_SRC} 的 CAPABILITY_INLINE_TAG_FAMILIES（并跑包内渲染锁定单测）`,
  })
}

/** ② 正面属性清单 ↔ ALLOWED_ATTR（双向）。 */
function compareAttrs(input) {
  comparePositiveList({
    listLabel: '属性',
    allowedName: 'ALLOWED_ATTR',
    capValues: input.capAttrs,
    allowedValues: input.allowedAttrs,
    okNote: '',
    extraPart: (xs) => `清单多出未放行属性: ${xs.join(', ')}`,
    missingPart: (xs) => `白名单新增未入清单: ${xs.join(', ')}`,
    recovery: `人工核对 ${SANITIZE_SRC} 的 ALLOWED_ATTR 后同步 ${SYSTEM_PROMPT_SRC} 的 CAPABILITY_PRESENTATION_ATTRS`,
  })
}

/**
 * ③ 负面清单与剥除语义一致：禁用标签 / 属性均不得实际放行（含 data-* / aria-* 两个
 * 构造性收窄语义锚点——DOMPurify 两旗标默认 true 且判定优先于 ALLOWED_ATTR 白名单，
 * 不显式关掉则通配越过声明面放行，声明清单 ≠ 有效放行面）。
 */
function checkForbiddenSemantics({ sanitizeText, forbiddenTags, forbiddenAttrs, allowedTags, allowedAttrs }) {
  const allowedTagSet = new Set(allowedTags)
  const leakedTags = forbiddenTags.filter((t) => allowedTagSet.has(t))
  if (leakedTags.length > 0) {
    fail(
      `禁用标签清单与剥除语义矛盾（这些标签实际在 ALLOWED_TAGS 内）: ${leakedTags.join(', ')}` +
        `——恢复动作：人工核对 ${SANITIZE_SRC} 的 ALLOWED_TAGS 后修正 ${SYSTEM_PROMPT_SRC} 的 CAPABILITY_FORBIDDEN.tags`,
    )
  } else {
    ok(`禁用标签清单与剥除语义一致（${forbiddenTags.length} 项均不在 ALLOWED_TAGS）`)
  }

  const leakedAttrs = forbiddenAttrs.filter((entry) =>
    allowedAttrs.some((candidate) => attrMatches(entry, candidate)),
  )
  if (leakedAttrs.length > 0) {
    fail(
      `禁用属性清单与剥除语义矛盾（这些属性实际在 ALLOWED_ATTR 内）: ${leakedAttrs.join(', ')}` +
        `——恢复动作：人工核对 ${SANITIZE_SRC} 的 ALLOWED_ATTR 后修正 ${SYSTEM_PROMPT_SRC} 的 CAPABILITY_FORBIDDEN.attributes`,
    )
  } else {
    ok(`禁用属性清单与剥除语义一致（${forbiddenAttrs.length} 项均不在 ALLOWED_ATTR）`)
  }

  // data-* 通配的语义锚点：净化层必须显式 ALLOW_DATA_ATTR=false（DOMPurify 默认 true 且
  // 优先于 ALLOWED_ATTR 白名单——不关掉则任意 data-* 越过白名单）。
  if (forbiddenAttrs.some((entry) => entry === 'data-*' || entry === 'data-')) {
    if (/ALLOW_DATA_ATTR\s*:\s*false/.test(stripComments(sanitizeText))) {
      ok('data-* 通配以 ALLOW_DATA_ATTR=false 的构造性全剥为语义锚')
    } else {
      fail(
        `负面清单声明剥离 data-*，但 ${SANITIZE_SRC} 未显式 ALLOW_DATA_ATTR: false` +
          '——恢复动作：核对净化配置（否则 data-* 实际放行，声明失实）',
      )
    }
  }

  // aria-* 面的语义锚点（与 data-* 锚点同型）：净化层必须显式 ALLOW_ARIA_ATTR=false。
  // DOMPurify 的 ALLOW_ARIA_ATTR 默认 true 且 _isValidAttribute 判定优先于 ALLOWED_ATTR
  // 白名单（3.4.11 实装核实）——不关掉则任意 aria-* 越过声明面放行，属性面「声明清单 =
  // 有效放行面」失实，而第 ② 步（正面属性清单 === ALLOWED_ATTR）仍绿（ALLOWED_ATTR 字面量
  // 未变）。故有效放行面按默认 true 计入 aria-*：须显式置 false 收窄为声明面，否则红灯。
  if (/ALLOW_ARIA_ATTR\s*:\s*false/.test(stripComments(sanitizeText))) {
    const ariaDeclared = allowedAttrs.filter((a) => a.startsWith('aria-'))
    ok(`aria-* 面以 ALLOW_ARIA_ATTR=false 收窄（有效放行面 = 声明面，含 ${ariaDeclared.length} 项 aria 白名单）`)
  } else {
    fail(
      `${SANITIZE_SRC} 未显式 ALLOW_ARIA_ATTR: false` +
        '——恢复动作：核对净化配置（DOMPurify 默认 true 时任意 aria-* 越过 ALLOWED_ATTR 放行，' +
        '声明清单 ≠ 有效放行面；若确需放开 aria-*，须同步 capability 属性面声明并重议本锚点）',
    )
  }
}

function main() {
  const input = extractInputsOrFail()
  compareTags(input)
  compareAttrs(input)
  checkForbiddenSemantics(input)
  guardExit(
    '✓ capability 清单对拍守卫通过（正面清单双向一致 + 负面清单与剥除语义一致）',
    'capability 清单对拍守卫未通过，按上方 ✗ 明细修复后重跑（每条报错自带恢复动作）',
  )
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) main()
