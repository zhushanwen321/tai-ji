#!/usr/bin/env node
/**
 * check-stale-ctx-audit-coverage.mjs —— stale-ctx 普查清单完备性守卫（O1-2 审计覆盖机器守卫，B 方案）。
 *
 * 背景（docs/architecture/crash-forensics-and-watchdog.md §3.3 D9 O1-2）：crash-resilience（设计文档已删，git 可追溯）u1-ext-guard
 * 交付的 stale-ctx 全仓普查（extensions/shared/ext-guards/docs/stale-ctx-audit.md §3）是一次性人工动作，
 * 此后新增 extension 包不会自动进入普查——「新包绕过 stale 静默语义判定」的漏洞无人把守。
 * 采用 B 方案（清单完备性检查）而非 AST lint（A 方案被否：回调形态发散，过匹配/漏匹配不可靠）：
 * 清单完备性是可机器判定的强不变量，语义判定交回人（普查表）+ 行为兜底交回守卫（guardStaleCtx）。
 *
 * 检查：解析普查表 §3「全仓普查清单」（权威表——不是 §2 接入清单）的「包」列，
 *   与 extensions/{taiji,universal,shared}/ 三组下实际含 package.json 的包目录比对。
 *   任何实际包未在普查表出现即红（forcing 新包接入时填写 stale 静默语义判定）。
 *
 * 解析规则：
 *   1. §3 定位：`^## 3.` 标题行起、下一个 `^## ` 前止（标题文字漂移不敏感，节序漂移即红）。
 *   2. 表格数据行 = 以 `|` 开头且非分隔行（`|---|` 形态）；只取第一列（「包」列），
 *      其余列的 `/` 与括号注记不参与（避免 hit 点描述污染包名）。
 *   3. 合并行按 `/` 拆分逐一比对（如「rename-session / msg-id-mapper / …」）。
 *   4. token 归一化：剥 markdown 强调（`**`/`__`/反引号）→ trim → 剥尾部括号注记
 *      （如「plugin-bridge（taiji）」→「plugin-bridge」）。修饰性 token
 *      （如「smart-context 其余模块」）归一化后不等于任何包目录名，不参与命中也无害。
 *
 * 用法：node scripts/check-stale-ctx-audit-coverage.mjs [--root <dir>]
 *   --root 指向一个含 extensions/shared/ext-guards/docs/stale-ctx-audit.md 与
 *   extensions/{taiji,universal,shared}/ 的目录（默认仓库根；fixture 自测用）。
 *
 * 零第三方依赖（node:fs/node:path/node:url）。退出码：0 = 全部实际包已登记；1 = 有缺失或结构漂移。
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = join(__dirname, '..')

const GROUPS = ['taiji', 'universal', 'shared']
const AUDIT_REL = 'extensions/shared/ext-guards/docs/stale-ctx-audit.md'

// ── --root 参数解析（fixture 自测入口，对齐 check-pi-semantics.mjs 惯例）──────
let ROOT = DEFAULT_ROOT
const rootIdx = process.argv.indexOf('--root')
if (rootIdx !== -1) {
  const val = process.argv[rootIdx + 1]
  if (!val || val.startsWith('--')) {
    console.error('用法: node scripts/check-stale-ctx-audit-coverage.mjs [--root <dir>]（--root 须带目录参数）')
    process.exit(1)
  }
  ROOT = val
}

const auditPath = join(ROOT, AUDIT_REL)
if (!existsSync(auditPath)) {
  console.error(`普查清单文件不存在: ${auditPath}`)
  console.error('该文件是 stale-ctx 普查的权威 SSOT，缺失说明仓库结构漂移——先核对 docs/architecture/crash-forensics-and-watchdog.md §3.3 D9。')
  process.exit(1)
}

// ── 1. 解析普查表 §3 全仓普查清单 ────────────────────────────────────────────
const lines = readFileSync(auditPath, 'utf8').split('\n')

const sectionStart = lines.findIndex((l) => /^##\s+3\.\s/.test(l))
if (sectionStart === -1) {
  console.error(`未在 ${AUDIT_REL} 中找到 §3 节（^## 3. 标题行）。`)
  console.error('权威普查表是 §3「全仓普查清单」，不是 §2 接入清单——文档节序漂移，请人工核对后修脚本或修文档。')
  process.exit(1)
}
let sectionEnd = lines.length
for (let i = sectionStart + 1; i < lines.length; i++) {
  if (/^##\s/.test(lines[i])) {
    sectionEnd = i
    break
  }
}

// 剥 markdown 强调 + trim + 剥尾部括号注记（全角/半角）
function normalizeToken(raw) {
  return raw
    .replace(/\*\*|__|`/g, '')
    .trim()
    .replace(/[（(][^（）()]*[)）]\s*$/, '')
    .trim()
}

const registered = new Set()
for (const line of lines.slice(sectionStart + 1, sectionEnd)) {
  if (!line.startsWith('|')) continue
  const cells = line.split('|')
  // 分隔行（| --- | --- |）与表头行（「包」）不产生包名
  if (cells.length < 3) continue
  const first = cells[1] ?? ''
  if (/^[\s:-]*$/.test(first) || first.trim() === '包') continue
  // 合并行按 / 拆分逐一比对；单包行拆分后即自身
  for (const token of first.split('/')) {
    const name = normalizeToken(token)
    if (name) registered.add(name)
  }
}

if (registered.size === 0) {
  console.error(`§3 节内未解析到任何普查表行: ${auditPath}`)
  console.error('表格结构漂移（表头「包」列缺失或全部行被判为分隔行）——请人工核对 §3 表格结构后修脚本或修文档。')
  process.exit(1)
}

// ── 2. 枚举 extensions/{taiji,universal,shared}/ 实际包目录 ─────────────────
const actual = [] // { name, group }
for (const group of GROUPS) {
  const groupDir = join(ROOT, 'extensions', group)
  if (!existsSync(groupDir)) {
    console.error(`extensions 分组目录不存在: ${groupDir}`)
    console.error(`三组目录 ${GROUPS.join('/')} 是本守卫的扫描面，缺失说明仓库结构漂移——核对 docs/architecture/crash-forensics-and-watchdog.md §3.3 D9 的扫描范围定义。`)
    process.exit(1)
  }
  for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (existsSync(join(groupDir, entry.name, 'package.json'))) {
      actual.push({ name: entry.name, group })
    }
  }
}

// ── 3. 比对：任何实际包未在普查表出现即红 ────────────────────────────────────
const missing = actual.filter((p) => !registered.has(p.name))

if (missing.length > 0) {
  console.error(`stale-ctx 审计覆盖检查失败：${missing.length} 个实际 extension 包未在普查清单 §3 登记`)
  for (const p of missing) {
    console.error(`  - ${p.name}（extensions/${p.group}/${p.name}）`)
  }
  console.error('')
  console.error('修复：编辑 extensions/shared/ext-guards/docs/stale-ctx-audit.md 的 §3「全仓普查清单」表格，')
  console.error('  为上述每个包补一行登记（列：包 / 命中点 / 判定 / 理由；同组多包可并入斜杠分隔的合并行），')
  console.error('  判定为「接入」的包还需在 §4「stale 静默语义」判定表补对应场景行。')
  console.error('设计依据：docs/architecture/crash-forensics-and-watchdog.md §3.3 D9 O1-2（B 方案：清单完备性检查）。')
  process.exit(1)
}

console.log(`stale-ctx 审计覆盖检查通过：extensions/{${GROUPS.join(',')}}/ 共 ${actual.length} 个实际包全部已在普查表 §3 登记（普查表解析到 ${registered.size} 个登记名）。`)
process.exit(0)
