#!/usr/bin/env node
/**
 * verify-extension-host-boundaries.mjs —— AC7 静态 import 边界检查（TC5）。
 *
 * 断言 extension-host 消费端模块的 import 不含任何 domain/stores/composables 路径。
 * core 是独立 headless 包，不反向依赖 renderer domain/store/composables（AC7 + 包级依赖铁律）。
 *
 * 检查对象（W4 交付的三个消费端模块）：
 *   - packages/core/src/extension-host/status-bar-controller.ts
 *   - packages/core/src/extension-host/overlay-lifecycle.ts
 *   - packages/core/src/extension-host/view-host-store.ts
 *
 * 实现：轻量正则解析 import 语句（node 原生 fs，零外部依赖）。禁 import 路径模式：
 *   - '/domain/'           （core 内部 domain 域——消费端不得依赖，信息流向单向）
 *   - '/stores/'           （renderer pinia stores）
 *   - '@/stores/'、'@/composables'（renderer 路径别名）
 *   - '../domain/'、'../stores/'（core 内相对路径逃逸）
 *
 * exit 0 = 通过；exit 1 = 存在违规 import（打印违规文件 + 行）。可作为
 * pre-commit hook 或 CI 的一环。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

/** 禁 import 路径模式（正则，命中即违规）。 */
const FORBIDDEN_PATTERNS = [
  { pattern: /\/domain\//, reason: 'domain 域 import（消费端不得反向依赖领域层）' },
  { pattern: /\/stores\//, reason: 'stores import（renderer pinia stores）' },
  { pattern: /@\/stores\//, reason: 'renderer stores 别名路径' },
  { pattern: /@\/composables/, reason: 'renderer composables 别名路径' },
]

/** 检查对象：W4 交付的 extension-host 消费端模块（相对仓库根）。 */
const TARGETS = [
  'packages/core/src/extension-host/status-bar-controller.ts',
  'packages/core/src/extension-host/overlay-lifecycle.ts',
  'packages/core/src/extension-host/view-host-store.ts',
]

/** 提取文件内所有 import 语句（含 import type / 动态 import，覆盖行续）。 */
function extractImportSpecifiers(content) {
  const specifiers = []
  // 处理多行 import 语句：合并到单行后逐一匹配
  const normalized = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const singleLine = normalized.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ')
  const importRe = /\bimport\s+(?:type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]/g
  // 兼容 type 前缀 import：import type { X } from '...'
  const importTypeRe = /\bimport\s+type\s*\{[\s\S]*?\}\s*from\s+['"]([^'"]+)['"]/g
  let m
  while ((m = importRe.exec(singleLine)) !== null) {
    specifiers.push({ specifier: m[1], raw: m[0] })
  }
  while ((m = importTypeRe.exec(singleLine)) !== null) {
    specifiers.push({ specifier: m[1], raw: m[0] })
  }
  return specifiers
}

let violations = 0
let checked = 0

for (const target of TARGETS) {
  const filePath = join(ROOT, target)
  let content
  try {
    content = readFileSync(filePath, 'utf8')
  } catch (err) {
    console.error(`[verify-extension-host-boundaries] 读取失败（文件不存在？）: ${target} —— ${err.message}`)
    violations += 1
    continue
  }
  checked += 1
  for (const { specifier, raw } of extractImportSpecifiers(content)) {
    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
      if (pattern.test(specifier)) {
        violations += 1
        console.error(`[verify-extension-host-boundaries] 违规 import: ${target}`)
        console.error(`  specifier: ${specifier}（${reason}）`)
        console.error(`  statement: ${raw.slice(0, 120)}`)
      }
    }
  }
}

console.log(`[verify-extension-host-boundaries] checked ${checked}/${TARGETS.length} files, ${violations} violations`)
if (violations > 0) {
  console.error('[verify-extension-host-boundaries] FAIL —— AC7 边界被破坏（domain/stores import 禁止）')
  process.exit(1)
}
process.exit(0)
