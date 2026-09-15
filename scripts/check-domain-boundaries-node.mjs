#!/usr/bin/env node
/**
 * check-domain-boundaries-node.mjs —— 全域铁律 gate 扫描器（由 check-domain-boundaries.sh 调用）。
 *
 * 零第三方依赖（node:fs/node:path），实现仿 verify-extension-host-boundaries.mjs
 * （正则提取 import specifier + normalize 多行）。职责：
 *
 * 1. AC10 跨域 import 图（core/src/domain 下各域目录）：
 *    - 包名路径 '@taiji/core/domain/<域>/<模块>'（2+ 层）→ 违规
 *    - 包名路径 '@taiji/core/domain/<域>'（单层 index）→ 放行
 *    - 包名路径 '@taiji/core'（包入口）→ 放行
 *    - 相对路径（./ 或 ../ 开头）→ node:path.resolve 到真实文件，
 *      落在其他 domain/<域>/ 下 → 违规（含指向他域 index.ts 的相对路径形式）
 *    - 其余（vue/@taiji/shared/foundation 相对路径等）→ 放行
 * 2. AC11 清空派 grep（core/src 全域）：
 *    - reset*ModuleState（排除 *ForTest 测试隔离形态）→ 违规候选
 *    - watch(sessionId) 显式清空派 → 违规候选，allowlist（CLI 参数传入的文件路径）
 *      命中即豁免（订阅重订/刷新形态，非清空派）
 *
 * 退出码：0 = 通过；1 = 违规（打印 文件:行 + 原因）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DOMAIN_ROOT = join(ROOT, 'packages/core/src/domain')
const CORE_SRC = join(ROOT, 'packages/core/src')

/** watch(sessionId) 订阅重订形态 allowlist（相对 ROOT 路径，CLI 参数注入）。 */
const watchAllowlist = new Set(process.argv.slice(2))

/** 收集一个目录下全部 .ts 文件（递归，排除 __tests__ 与 *.test.ts）。 */
function collectTsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      collectTsFiles(full, out)
    } else if (extname(full) === '.ts' && !entry.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

/** 提取文件内所有 import specifier（去注释、合并多行、覆盖 import type 变体）。 */
function extractImportSpecifiers(content) {
  const specifiers = []
  const normalized = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const singleLine = normalized.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ')
  const importRe = /\bimport\s+(?:type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]/g
  const importTypeRe = /\bimport\s+type\s*\{[\s\S]*?\}\s*from\s+['"]([^'"]+)['"]/g
  let m
  while ((m = importRe.exec(singleLine)) !== null) specifiers.push(m[1])
  while ((m = importTypeRe.exec(singleLine)) !== null) specifiers.push(m[1])
  return specifiers
}

/** 解析 import specifier 的「目标域」（domain/<域>），非 domain 返回 null。 */
function domainOfSpecifier(spec) {
  // 包名路径形式：@taiji/core/domain/<域>/... 或 @taiji/core/domain/<域>
  const pkgMatch = spec.match(/^@taiji\/core\/domain\/([^/]+)/)
  if (pkgMatch) return pkgMatch[1]
  return null
}

const violations = []

// ---------------------------------------------------------------------------
// AC10：跨域 import 图
// ---------------------------------------------------------------------------
for (const file of collectTsFiles(DOMAIN_ROOT)) {
  const rel = file.slice(ROOT.length + 1)
  const content = readFileSync(file, 'utf8')
  const lines = content.split('\n')
  const fileDomain = rel.match(/domain\/([^/]+)\//)?.[1] ?? null

  for (const spec of extractImportSpecifiers(content)) {
    // 包名路径形式
    if (spec.startsWith('@taiji/core/domain/')) {
      const targetDomain = domainOfSpecifier(spec)
      const segments = spec.split('/')
      const depth = segments.length // '@taiji/core/domain/<域>' = 4 段（index 公开 API）；'<域>/<模块>' = 5+ 段（内部模块）
      if (depth >= 5) {
        const lineNo = lines.findIndex((l) => l.includes(spec.slice(0, 30))) + 1
        violations.push(
          `${rel}:${lineNo || '?'} AC10 违规：包名路径 import 域内部模块 '${spec}' —— 经 '@taiji/core/domain/${targetDomain}' 公开 index API 或 '@taiji/core' 包入口消费`
        )
      }
      continue
    }
    // 相对路径形式
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const resolved = resolve(dirname(file), spec)
      const relResolved = resolved.slice(ROOT.length + 1)
      const targetDomain = relResolved.match(/domain\/([^/]+)\//)?.[1] ?? null
      if (targetDomain && targetDomain !== fileDomain) {
        const lineNo = lines.findIndex((l) => l.includes(spec.slice(0, 30))) + 1
        violations.push(
          `${rel}:${lineNo || '?'} AC10 违规：相对路径跨域 import '${spec}' → ${relResolved} —— 经 '@taiji/core/domain/${targetDomain}' 公开 index API 消费`
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// AC11：清空派 grep（core/src 全域）
// ---------------------------------------------------------------------------
for (const file of collectTsFiles(CORE_SRC)) {
  const rel = file.slice(ROOT.length + 1)
  const content = readFileSync(file, 'utf8')
  const lines = content.split('\n')

  // reset*ModuleState（排除 *ForTest 测试隔离形态）
  const resetRe = /\b(reset[A-Z][A-Za-z]*ModuleState)\s*\(/
  lines.forEach((line, i) => {
    const m = resetRe.exec(line)
    if (m && !m[1].endsWith('ForTest')) {
      violations.push(`${rel}:${i + 1} AC11 违规：reset*ModuleState 手动清空派 '${m[1]}' —— per-session 状态经 useSessionScopedState 分区，销毁由 cleanup 注册自动清理`)
    }
  })

  // watch(sessionId) 显式清空派（allowlist 命中豁免——订阅重订/刷新形态）
  if (!watchAllowlist.has(rel)) {
    lines.forEach((line, i) => {
      if (/\bwatch\s*\(\s*sessionId/.test(line)) {
        violations.push(
          `${rel}:${i + 1} AC11 违规候选：watch(sessionId) 模式（若为显式清空派必须迁移 useSessionScopedState；若为订阅重订/刷新形态请登记 AC11_WATCH_ALLOWLIST 并注明原因）`
        )
      }
    })
  }
}

if (violations.length > 0) {
  console.error(`[check-domain-boundaries] ${violations.length} 处违规：`)
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}
console.log('[check-domain-boundaries] AC10 跨域 import + AC11 清空派 全域通过（exit 0）')
process.exit(0)
