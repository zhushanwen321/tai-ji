/**
 * W1T2: virtua@<version> API 对齐验证脚本。
 *
 * 用途（cw wave w1 / DM1）：
 * - 逐项核对 virtua/vue 导出的 VirtualizerHandle 8 个假设 API + 2 个额外 API
 *   是否存在，并在运行时 typeof 校验
 * - 从 d.ts 提取 VirtualizerHandle interface 完整定义，输出 markdown 报告到 stdout
 * - ERR3（ResizeObserver loop warning）/ ERR4（isSameRange 短路）为运行时行为，
 *   只能 dev Electron 手工验证（W1T6），此处只列出待办项
 *
 * 跑法：node packages/renderer/scripts/verify-virtua-api.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'

const require = createRequire(import.meta.url)

// 解析 virtua 包根目录（从 renderer 包视角 require.resolve）
const virtuaPkgJsonPath = require.resolve('virtua/package.json')
const virtuaRoot = dirname(virtuaPkgJsonPath)
const virtuaPkg = JSON.parse(readFileSync(virtuaPkgJsonPath, 'utf8'))
const version = virtuaPkg.version

// 动态 import virtua/vue（ESM 子包入口）
/** @type {Record<string, unknown>} */
let vueExports = {}
let importError = ''
try {
  vueExports = await import('virtua/vue')
} catch (e) {
  importError = e instanceof Error ? e.message : String(e)
}

// VirtualizerHandle 是类型（type-only export），运行时不带实例方法；typeof 校验只能基于
// 已知组件导出 Virtualizer。我们用「是否在 d.ts interface 中声明该成员」作为存在性证据，
// 运行时 typeof 仅对 runtime 导出（Virtualizer 组件本身）有效。
const dtsPath = resolve(virtuaRoot, 'lib/vue/Virtualizer.d.ts')
const dtsContent = readFileSync(dtsPath, 'utf8')

/**
 * 从 d.ts 文本提取 VirtualizerHandle interface 完整定义块
 * （从 `export interface VirtualizerHandle {` 起到匹配的 `}`）。
 * @returns {string}
 */
function extractHandleInterface() {
  const startIdx = dtsContent.indexOf('export interface VirtualizerHandle')
  if (startIdx === -1) return '(VirtualizerHandle interface not found in d.ts)'
  // 从 startIdx 的下一个 `{` 开始做 brace 匹配
  const braceStart = dtsContent.indexOf('{', startIdx)
  if (braceStart === -1) return '(opening brace not found)'
  let depth = 0
  let endIdx = -1
  for (let i = braceStart; i < dtsContent.length; i++) {
    const ch = dtsContent[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        endIdx = i
        break
      }
    }
  }
  if (endIdx === -1) return '(closing brace not found)'
  return dtsContent.slice(startIdx, endIdx + 1)
}

/**
 * 判断某个成员是否声明在 VirtualizerHandle interface 文本中。
 * 用正则匹配 `name(`（方法）或 `readonly name` / `name:`（属性）。
 * @param {string} name
 * @returns {boolean}
 */
function hasMember(name) {
  const block = extractHandleInterface()
  // 方法：`  name(` 或 `name<...>(`
  // 属性：`readonly name:` 或 `  name:`
  const methodRe = new RegExp(`\\b${name}\\s*(?:<[^>]*>)?\\s*\\(`)
  const propRe = new RegExp(`\\b(?:readonly\\s+)?${name}\\s*(?::|\\?)`)
  return methodRe.test(block) || propRe.test(block)
}

/**
 * 从 d.ts 文本提取某成员的签名行（注释 + 签名），供报告展示。
 * @param {string} name
 * @returns {string}
 */
function extractSignature(name) {
  const block = extractHandleInterface()
  const lines = block.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const methodRe = new RegExp(`\\b${name}\\s*(?:<[^>]*>)?\\s*\\(`)
    const propRe = new RegExp(`\\b(?:readonly\\s+)?${name}\\s*(?::|\\?)`)
    if (methodRe.test(line) || propRe.test(line)) {
      // 向上收集 JSDoc 注释块（以 /** ... */ 或 * 行的形式）
      const collected = []
      for (let j = i; j >= 0; j--) {
        const prev = lines[j].trim()
        if (prev.startsWith('/**') || prev.startsWith('*') || prev.endsWith('*/')) {
          collected.unshift(lines[j])
        } else if (prev === '') {
          // 空行允许在注释上方
          continue
        } else {
          break
        }
      }
      // 当前行本身
      if (!collected.includes(line)) collected.push(line)
      return collected.map((l) => l.trim()).join(' ')
    }
  }
  return '(signature not found)'
}

// DM1 假设的 8 个 API（VirtualizerHandle contract）
const DM1_API = [
  { name: 'scrollToIndex', expected: '(index, opts?) => void' },
  { name: 'getItemOffset', expected: '(index) => number' },
  { name: 'getItemSize', expected: '(index) => number' },
  { name: 'findItemIndex', expected: '(offset) => number' },
  { name: 'scrollSize', expected: 'readonly number' },
  { name: 'scrollOffset', expected: 'readonly number' },
  { name: 'viewportSize', expected: 'readonly number' },
  { name: 'cache', expected: 'readonly CacheSnapshot' },
]
// 额外 API（d.ts 中存在但 DM1 未列入假设）
const EXTRA_API = [
  { name: 'scrollTo', expected: '(offset) => void' },
  { name: 'scrollBy', expected: '(offset) => void' },
]

// ───────────────── 输出 markdown 报告 ─────────────────
const lines = []
lines.push(`# virtua@${version} API 对齐报告`)
lines.push('')
lines.push('> 由 \`packages/renderer/scripts/verify-virtua-api.mjs\` 生成（cw wave w1 / DM1）。')
lines.push('')
lines.push(`- virtua 版本：\`${version}\``)
lines.push(`- d.ts 路径：\`${dtsPath}\``)
lines.push(`- \`import * from 'virtua/vue'\` 运行时导出键：\`${
  importError ? `IMPORT FAILED: ${importError}` : Object.keys(vueExports).join(', ')
}\``)
lines.push('')

lines.push('## VirtualizerHandle API 逐项核对')
lines.push('')
lines.push('| API | DM1 预期 | 实际签名（从 d.ts） | 一致性 |')
lines.push('|---|---|---|---|')
for (const { name, expected } of DM1_API) {
  const present = hasMember(name)
  const sig = present ? extractSignature(name) : '(missing)'
  lines.push(`| \`${name}\` | ${expected} | \`${sig}\` | ${present ? '✅' : '❌'} |`)
}
for (const { name, expected } of EXTRA_API) {
  const present = hasMember(name)
  const sig = present ? extractSignature(name) : '(missing)'
  lines.push(`| \`${name}\` | ${expected}（额外） | \`${sig}\` | ${present ? '✅（额外）' : '❌'} |`)
}
lines.push('')

lines.push('## VirtualizerHandle 完整定义（从 d.ts）')
lines.push('')
lines.push('```ts')
lines.push(extractHandleInterface())
lines.push('```')
lines.push('')

lines.push('## ERR3 RO loop warning')
lines.push('- 待 dev Electron 验证（W1T6 手工）：virtua 内部 ResizeObserver 在 streaming 高频内容增长下是否触发浏览器「ResizeObserver loop completed with undelivered notifications」警告。')
lines.push('')

lines.push('## ERR4 isSameRange 短路')
lines.push('- 待 dev Electron 验证（W1T6 手工）：virtua 内部 isSameRange 短路在 session 切换 / 大幅内容替换场景下是否会导致首帧空白或滚动位置错位。')
lines.push('')

// 写 stdout
process.stdout.write(lines.join('\n') + '\n')
