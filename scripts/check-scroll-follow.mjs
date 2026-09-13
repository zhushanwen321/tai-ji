#!/usr/bin/env node
/**
 * check-scroll-follow.mjs — 消息流滚动跟随链路守卫（约束 C-state-11 机器执法）。
 *
 * 设计来源：docs/design/chat-pin-bottom-fix.md §4.3 D1/D6 + §4.4 护栏④⑤（已删除，git 可追溯；
 * INVAR 权威定义现居 packages/renderer/src/composables/panel/useVirtuaFollow.ts 文件头注释）
 * （约束登记：docs/constraints.json C-state-11）。
 *
 * [顺序依赖声明] 本守卫在 M1（U1 useVirtuaFollow 末项索引直取 + D6 vlistBottom 同款修正）
 * 把禁用模式 `findItemIndex(...scrollSize)` 活调用归零之后落地（实施计划 M2/U4 挂接
 * pre-commit）——先归零后挂接，守卫防复发而非清存量。
 *
 * 检查 1（滚动到底唯一原语，§4.4⑤ 扫描范围收窄）：
 *   范围 = packages/renderer/src/composables/panel/（递归）
 *        + packages/renderer/src/components/panel/MessageStream.vue
 *   `scrollToIndex(` 调用只许出现在白名单文件（WHITELIST）：
 *   - useVirtuaFollow.ts —— follow 原语本体（末项索引直取 + offset=tailHeight 唯一实现处）
 *   - useMessageStreamRail.ts —— rail 导航跳转（align:'start'，合法独立用途，设计 D7④）
 *   范围外既有合法调用点（TraceView.vue trace 独立链路 / 测试 mock 断言）不在扫描面内、
 *   天然不红（影响面审 r2 MF1 全量枚举核实）。
 *
 * 检查 2（R3 禁用模式，§4.4④ / D6）：`findItemIndex(` 与 `scrollSize` 同行组合——
 *   范围 = packages/renderer/src/（递归，.ts/.vue），排除 __tests__/ 目录与 *.test.ts
 *   （测试头注释合法引用该模式做回归描述；__tests__/ 内的 mock helper 同为测试基建）。
 *
 * 注释行豁免（实施计划偏差 #6 主 agent 裁决）：lineage/历史性注释提及（如
 * useVirtuaFollow.ts 头部 R3 事故背景注释、MessageStream.vue vlistBottom 死路径标注）
 * 非活引用，两个检查均排除纯注释行（// 、行内块注释前缀 / 与行中 /*……*\/ 只按行首形态判）。
 *
 * 白名单扩登记流程：跟随链路出现新的合法「滚到底」需求时——先在设计文档 §4.4⑤ 登记用途
 * 与文件，再把文件加入下方 WHITELIST 并注明理由；禁止无登记扩白名单（误伤面收敛靠登记制，
 * 同 check_pnpm_store_layout.sh 先例的「规则误报修正规则本体」纪律）。
 *
 * 用法：node scripts/check-scroll-follow.mjs（pre-commit 按路径触发；亦可手动随时跑，<50ms）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath 而非 URL.pathname：Windows 上 pathname 返回 /D:/... 形态，resolve 叠加盘符成 D:\D:\
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 检查 1 扫描范围：跟随链路目录（递归）+ 单文件（§4.4⑤ 收窄声明） */
const SCOPE_DIRS = ['packages/renderer/src/composables/panel']
const SCOPE_FILES = ['packages/renderer/src/components/panel/MessageStream.vue']
/**
 * 检查 1 白名单（扩登记流程见文件头注释；禁止无登记扩白名单）
 * - useVirtuaFollow.ts：follow 原语本体（滚动到底唯一入口，C-state-11）
 * - useMessageStreamRail.ts：rail 导航跳转 align:'start'（合法独立用途，设计 D7④）
 */
const WHITELIST = new Set([
  'packages/renderer/src/composables/panel/useVirtuaFollow.ts',
  'packages/renderer/src/composables/panel/useMessageStreamRail.ts',
])
/** 检查 2 扫描根：R3 禁用模式（findItemIndex × scrollSize 同行） */
const FORBIDDEN_SCAN_ROOT = 'packages/renderer/src'
const FORBIDDEN_RE = /findItemIndex\(.*scrollSize/
/** 注释行豁免（偏差 #6）：行首 // 、行首 /*、块注释续行 * 前缀 */
const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*)/

function collectFiles(relDir, out) {
  const abs = path.join(PROJECT_ROOT, relDir)
  if (!statSync(abs).isDirectory()) return out
  for (const name of readdirSync(abs)) {
    const rel = path.join(relDir, name)
    const full = path.join(abs, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue
      collectFiles(rel, out)
    } else if (/\.(ts|vue)$/.test(name)) {
      out.push(rel)
    }
  }
  return out
}

/** 逐行扫 pattern，返回命中（排除注释行）；行号 1-based */
function scanLines(relFile, re) {
  const hits = []
  const lines = readFileSync(path.join(PROJECT_ROOT, relFile), 'utf-8').split('\n')
  lines.forEach((line, i) => {
    if (COMMENT_LINE_RE.test(line)) return
    if (re.test(line)) hits.push({ file: relFile, line: i + 1, text: line.trim() })
  })
  return hits
}

const failures = []

// ── 检查 1：跟随链路内 scrollToIndex 越出白名单 ──────────────────────────
const scopeFiles = new Set(SCOPE_FILES)
for (const dir of SCOPE_DIRS) {
  for (const f of collectFiles(dir, [])) scopeFiles.add(f)
}
for (const rel of scopeFiles) {
  if (WHITELIST.has(rel)) continue
  for (const hit of scanLines(rel, /scrollToIndex\(/)) {
    failures.push(
      `检查1 scrollToIndex 越出唯一原语（C-state-11）：\n` +
        `  ✗ ${hit.file}:${hit.line}  ${hit.text}`,
    )
  }
}

// ── 检查 2：禁用模式 findItemIndex(...scrollSize（R3 坐标错位，排除测试）──
const allFiles = collectFiles(FORBIDDEN_SCAN_ROOT, []).filter(
  (f) => !f.split(path.sep).includes('__tests__') && !f.endsWith('.test.ts'),
)
for (const rel of allFiles) {
  for (const hit of scanLines(rel, FORBIDDEN_RE)) {
    failures.push(
      `检查2 禁用模式 findItemIndex(...scrollSize（R3 坐标错位，见设计 §3.3 R3）：\n` +
        `  ✗ ${hit.file}:${hit.line}  ${hit.text}`,
    )
  }
}

if (failures.length > 0) {
  console.error(`[scroll-follow] 守卫拦截：${failures.length} 处违规（约束 C-state-11）\n`)
  for (const f of failures) console.error(`  ${f}\n`)
  console.error('[FIX] 滚动到底必须走 useVirtuaFollow 的 follow 原语（末项索引直取 + offset=tailHeight），')
  console.error('      修复指引：packages/renderer/src/composables/panel/useVirtuaFollow.ts 文件头注释 INVAR-M4-2′（原 chat-pin-bottom-fix 设计文档已删除，git 可追溯）。')
  console.error('      新合法用途按本脚本头注释「白名单扩登记流程」在设计文档登记后加入 WHITELIST。')
  process.exit(1)
}
console.log(`[scroll-follow] OK：跟随链路唯一原语 ✓ + 禁用模式归零 ✓（扫描 ${scopeFiles.size} 链路文件 + ${allFiles.length} 全 renderer 文件）`)
