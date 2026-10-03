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
 *      均不在 ALLOWED_ATTR；`data-*` 通配的存在要求净化层 ALLOW_DATA_ATTR === false
 *      （构造性全剥的语义锚点）。
 *
 * 形态照搬 scripts/check-thinking-levels.mjs（双清单对拍先例）。
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SYSTEM_PROMPT_SRC = join(ROOT, 'extensions', 'taiji', 'system-prompt', 'src', 'index.ts')
const SANITIZE_SRC = join(ROOT, 'packages', 'renderer', 'src', 'composables', 'logic', 'markdown-sanitize.ts')

let failed = 0
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  failed = 1
}
const ok = (msg) => console.log(`  ✓ ${msg}`)

// ── 纯函数（--self-test 覆盖）────────────────────────────────────────

/** 剔除行注释与块注释——常量块内注释里的引号字符串不得被当成成员。 */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * 取 `const <name> ... = <数组/对象字面量>` 的初始化块文本（含外层括号）。
 * 注释先剥离；括号按栈平衡扫描，字符串字面量内的括号不计数。
 */
export function extractInitializer(text, constName) {
  const clean = stripComments(text)
  const decl = clean.match(new RegExp(`const\\s+${constName}\\b`))
  if (!decl) return { error: `未找到 const ${constName} 声明（改名 / 移动？）` }
  const eq = clean.indexOf('=', decl.index)
  if (eq < 0) return { error: `const ${constName} 缺初始化赋值` }
  let i = eq + 1
  while (i < clean.length && /\s/.test(clean[i])) i++
  const open = clean[i]
  if (open !== '[' && open !== '{') {
    return { error: `const ${constName} 初始化不是数组 / 对象字面量（形态变化？）` }
  }
  const stack = []
  let inString = null
  let out = ''
  for (; i < clean.length; i++) {
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
      out += ch
      continue
    }
    if (ch === '[') stack.push(']')
    else if (ch === '{') stack.push('}')
    else if (ch === stack[stack.length - 1]) {
      stack.pop()
      out += ch
      if (stack.length === 0) break
      continue
    }
    out += ch
  }
  if (stack.length !== 0) return { error: `const ${constName} 字面量括号不平衡（截断？）` }
  return { text: out }
}

/** 提取文本内全部字符串字面量（去空串），不做语义排序。 */
export function extractStringLiterals(text) {
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

/** 集合差异：extra = a 有 b 无；missing = b 有 a 无。 */
export function setDiff(a, b) {
  const bs = new Set(b)
  const as = new Set(a)
  return {
    extra: [...as].filter((x) => !bs.has(x)),
    missing: [...bs].filter((x) => !as.has(x)),
  }
}

/** 属性匹配：条目以 `*` 结尾时按前缀匹配，否则精确匹配。 */
export function attrMatches(entry, candidate) {
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

function main() {
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

  if (failed !== 0) {
    console.error('capability 清单对拍：提取阶段失败，按上方 ✗ 修复后重跑')
    process.exit(1)
  }

  const forbiddenTags = extractSubArrayLiterals(forbidden.text, 'tags')
  const forbiddenAttrs = extractSubArrayLiterals(forbidden.text, 'attributes')
  if (forbiddenTags.error) fail(`CAPABILITY_FORBIDDEN.tags 提取失败: ${forbiddenTags.error}`)
  if (forbiddenAttrs.error) fail(`CAPABILITY_FORBIDDEN.attributes 提取失败: ${forbiddenAttrs.error}`)
  if (failed !== 0) {
    console.error('capability 清单对拍：禁用清单提取失败，按上方 ✗ 修复后重跑')
    process.exit(1)
  }

  // ① 正面标签清单 ↔ ALLOWED_TAGS（双向）
  {
    const { extra, missing } = setDiff(capTags.values, allowedTags.values)
    if (extra.length === 0 && missing.length === 0) {
      ok(`正面标签清单与 ALLOWED_TAGS 一致（${capTags.values.length} 项，含族归类）`)
    } else {
      const parts = []
      if (extra.length > 0) parts.push(`清单多出未放行标签: ${extra.join(', ')}（会被净化层剥除，agent 被教会了无效能力）`)
      if (missing.length > 0) parts.push(`白名单新增未入清单: ${missing.join(', ')}（agent 不知道可用）`)
      fail(
        `正面标签清单与 ALLOWED_TAGS 漂移: ${parts.join('；')}` +
          `——恢复动作：人工核对 ${SANITIZE_SRC} 的 ALLOWED_TAGS 后同步 ${SYSTEM_PROMPT_SRC} 的 CAPABILITY_INLINE_TAG_FAMILIES（并跑包内渲染锁定单测）`,
      )
    }
  }

  // ② 正面属性清单 ↔ ALLOWED_ATTR（双向）
  {
    const { extra, missing } = setDiff(capAttrs.values, allowedAttrs.values)
    if (extra.length === 0 && missing.length === 0) {
      ok(`正面属性清单与 ALLOWED_ATTR 一致（${capAttrs.values.length} 项）`)
    } else {
      const parts = []
      if (extra.length > 0) parts.push(`清单多出未放行属性: ${extra.join(', ')}`)
      if (missing.length > 0) parts.push(`白名单新增未入清单: ${missing.join(', ')}`)
      fail(
        `正面属性清单与 ALLOWED_ATTR 漂移: ${parts.join('；')}` +
          `——恢复动作：人工核对 ${SANITIZE_SRC} 的 ALLOWED_ATTR 后同步 ${SYSTEM_PROMPT_SRC} 的 CAPABILITY_PRESENTATION_ATTRS`,
      )
    }
  }

  // ③ 负面清单与剥除语义一致
  {
    const allowedTagSet = new Set(allowedTags.values)
    const leakedTags = forbiddenTags.values.filter((t) => allowedTagSet.has(t))
    if (leakedTags.length > 0) {
      fail(
        `禁用标签清单与剥除语义矛盾（这些标签实际在 ALLOWED_TAGS 内）: ${leakedTags.join(', ')}` +
          `——恢复动作：人工核对 ${SANITIZE_SRC} 的 ALLOWED_TAGS 后修正 ${SYSTEM_PROMPT_SRC} 的 CAPABILITY_FORBIDDEN.tags`,
      )
    } else {
      ok(`禁用标签清单与剥除语义一致（${forbiddenTags.values.length} 项均不在 ALLOWED_TAGS）`)
    }

    const leakedAttrs = forbiddenAttrs.values.filter((entry) =>
      allowedAttrs.values.some((candidate) => attrMatches(entry, candidate)),
    )
    if (leakedAttrs.length > 0) {
      fail(
        `禁用属性清单与剥除语义矛盾（这些属性实际在 ALLOWED_ATTR 内）: ${leakedAttrs.join(', ')}` +
          `——恢复动作：人工核对 ${SANITIZE_SRC} 的 ALLOWED_ATTR 后修正 ${SYSTEM_PROMPT_SRC} 的 CAPABILITY_FORBIDDEN.attributes`,
      )
    } else {
      ok(`禁用属性清单与剥除语义一致（${forbiddenAttrs.values.length} 项均不在 ALLOWED_ATTR）`)
    }

    // data-* 通配的语义锚点：净化层必须显式 ALLOW_DATA_ATTR=false（DOMPurify 默认 true 且
    // 优先于 ALLOWED_ATTR 白名单——不关掉则任意 data-* 越过白名单）。
    if (forbiddenAttrs.values.some((entry) => entry === 'data-*' || entry === 'data-')) {
      if (/ALLOW_DATA_ATTR\s*:\s*false/.test(stripComments(sanitizeText))) {
        ok('data-* 通配以 ALLOW_DATA_ATTR=false 的构造性全剥为语义锚')
      } else {
        fail(
          `负面清单声明剥离 data-*，但 ${SANITIZE_SRC} 未显式 ALLOW_DATA_ATTR: false` +
            '——恢复动作：核对净化配置（否则 data-* 实际放行，声明失实）',
        )
      }
    }
  }

  if (failed === 0) {
    console.log('✓ capability 清单对拍守卫通过（正面清单双向一致 + 负面清单与剥除语义一致）')
    process.exit(0)
  }
  console.error('capability 清单对拍守卫未通过，按上方 ✗ 明细修复后重跑（每条报错自带恢复动作）')
  process.exit(1)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) main()
