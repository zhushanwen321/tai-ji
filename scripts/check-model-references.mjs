#!/usr/bin/env node
/**
 * check-model-references.mjs —— pi 引擎域资产模型引用漂移守卫（workflow-architecture-redesign D8 机器守卫）。
 *
 * 校验对象：extensions/ 内 pi 引擎域资产里**声明式**的模型引用 vs 模型目录的 diff。
 * 目录静态基准 = packages/runtime/src/generated/builtin-providers.json（pi 内置
 * provider 目录快照，`pnpm gen:builtin-providers` 从 pi-ai 实装版生成）——provider
 * 配置漂移（pi 升级后目录变化：provider 退役/改名/模型 id 下架）时，引用漂移在
 * 提交期红，不等 run 烧 token（G4）。
 *
 * 资产域与判据：
 * - 扫 extensions/ 树下全部 .md，frontmatter（首个 `---` 围栏块）含 `kind: agent` 的
 *   agent 资产才提取 `model:` 字段（与 meta-parser 的 kind 判据同源；skills 等
 *   其他 .md 的正文文本不误报——只读 frontmatter 块内行首键）。
 * - workflow 资产（.js meta）无模型声明字段（WorkflowMeta 无 model——P-C4 实测
 *   内置 workflows 零硬编码模型引用，脚本内 agent({model}) 全为运行时变量），
 *   无静态扫描面。
 * - 校验域 = pi 内置 provider 快照：引用用户自定义 provider 的资产会被判红——
 *   本仓发布资产不得依赖用户侧 provider 配置，红即正确。
 *
 * 用法：node scripts/check-model-references.mjs [--root <dir>]
 *   --root 指向含 extensions/ 与 packages/runtime/src/generated/ 的目录（默认仓库
 *   根；fixture 演练自测用）。
 *
 * 零第三方依赖（node:fs/node:path）。退出码：0 = 通过（允许含 WARN）；1 = 违规。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let ROOT = join(__dirname, '..')

// ── --root 参数解析（fixture 演练入口）────────────────────────────────
const rootIdx = process.argv.indexOf('--root')
if (rootIdx !== -1) {
  const val = process.argv[rootIdx + 1]
  if (!val || val.startsWith('--')) {
    console.error('用法: node scripts/check-model-references.mjs [--root <dir>]（--root 须带目录参数）')
    process.exit(1)
  }
  ROOT = val
}

const EXTENSIONS_DIR = join(ROOT, 'extensions')
const SNAPSHOT_JSON = join(ROOT, 'packages', 'runtime', 'src', 'generated', 'builtin-providers.json')

let failed = 0
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  failed = 1
}
const warn = (msg) => console.warn(`  ⚠ ${msg}`)

// ── thinking 档位后缀 strip（与 subagent-core shared/model-ref THINKING_ORDER 同表；
//    防漂移 = 启动对账检查，见下方 auditThinkingOrderCopy 段）──
const THINKING_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 剥离模型串尾部 `:thinkingLevel` 后缀（仅合法档位，避免误剥无关冒号）。 */
function stripThinkingSuffix(modelStr) {
  const alt = [...THINKING_ORDER].sort((a, b) => b.length - a.length).join('|')
  return modelStr.replace(new RegExp(`:(${alt})$`), '')
}

// ── 0b. THINKING_ORDER 副本 vs core 权威表对账（防漂移机器守卫）─────────────
// 权威源 = 本仓 core 源码（相对脚本定位，不随 --root fixture 走——对账保护的是
// 本脚本内副本与权威源的一致性，与被扫资产域无关）。
const CORE_MODEL_REF_TS = join(__dirname, '..', 'packages', 'subagent-core', 'src', 'shared', 'model-ref.ts')

/** 从 core model-ref.ts 源码提取 THINKING_ORDER 字面量表（窄解析：定位数组字面量后收 "..." 串）。 */
function parseCoreThinkingOrder(source) {
  const m = /THINKING_ORDER\s*=\s*\[([^\]]*)\]/.exec(source)
  if (!m) return null
  return [...m[1].matchAll(/"([^"]+)"/g)].map((s) => s[1])
}

/** 对账脚本内 THINKING_ORDER 副本 vs core 权威表（逐项按序全等）；不一致 fail 并给恢复动作。 */
function auditThinkingOrderCopy() {
  let source
  try {
    source = readFileSync(CORE_MODEL_REF_TS, 'utf-8')
  } catch (e) {
    fail(`core 权威表不可读: ${CORE_MODEL_REF_TS} — ${e.message}——恢复动作：确认仓库内 packages/subagent-core/src/shared/model-ref.ts 存在后重跑`)
    return
  }
  const coreOrder = parseCoreThinkingOrder(source)
  if (!coreOrder || coreOrder.length === 0) {
    fail(`core 权威表解析失败（model-ref.ts 未提取到 THINKING_ORDER 数组字面量）——恢复动作：核对 ${CORE_MODEL_REF_TS} 的 THINKING_ORDER 声明形态（须为 "..." 字符串数组字面量），并同步本脚本的解析正则`)
    return
  }
  const inSync = coreOrder.length === THINKING_ORDER.length && coreOrder.every((v, i) => v === THINKING_ORDER[i])
  if (inSync) return
  const coreSet = new Set(coreOrder)
  const copySet = new Set(THINKING_ORDER)
  const missingInCopy = coreOrder.filter((v) => !copySet.has(v))
  const extraInCopy = THINKING_ORDER.filter((v) => !coreSet.has(v))
  const diffDesc =
    missingInCopy.length === 0 && extraInCopy.length === 0
      ? '成员一致但顺序不同'
      : `副本缺失: ${missingInCopy.join(', ') || '（无）'}；副本多出: ${extraInCopy.join(', ') || '（无）'}`
  fail(
    `THINKING_ORDER 副本与 core 权威表不一致（${diffDesc}）——脚本: [${THINKING_ORDER.join(', ')}] vs core: [${coreOrder.join(', ')}]` +
      `——恢复动作：同步本脚本 THINKING_ORDER 副本为 ${CORE_MODEL_REF_TS} 的权威表`,
  )
}

// ── 0. 前置物存在性 ──────────────────────────────────────────────────
if (!existsSync(EXTENSIONS_DIR)) {
  fail(`extensions/ 不存在: ${EXTENSIONS_DIR}——恢复动作：在仓库根重跑 node scripts/check-model-references.mjs`)
  console.error('\ncheck-model-references: FAIL')
  process.exit(1)
}
if (!existsSync(SNAPSHOT_JSON)) {
  fail(`内置 provider 目录快照不存在: ${SNAPSHOT_JSON}——恢复动作：执行 pnpm gen:builtin-providers 生成后重跑`)
  console.error('\ncheck-model-references: FAIL')
  process.exit(1)
}
let providers
try {
  providers = JSON.parse(readFileSync(SNAPSHOT_JSON, 'utf-8')).providers ?? []
} catch (e) {
  fail(`快照 JSON 解析失败: ${e.message}——恢复动作：执行 pnpm gen:builtin-providers 重生成后重跑`)
  console.error('\ncheck-model-references: FAIL')
  process.exit(1)
}
const providerIds = new Set(providers.map((p) => p.id))
const modelsByProvider = new Map(providers.map((p) => [p.id, new Set((p.models ?? []).map((m) => m.id))]))

auditThinkingOrderCopy()

// ── 1. 收集 extensions/ 下 agent 资产的 frontmatter model 声明 ────────

/** 读 .md frontmatter 围栏块（首个 `---` 到闭合 `---`），无 frontmatter 返回 null。 */
function readFrontmatterBlock(content) {
  const lines = content.split('\n')
  if ((lines[0] ?? '').trim() !== '---') return null
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end === -1) return null
  return lines.slice(1, end)
}

/** frontmatter 行集合 → { kind, model }（行首键直读，非 YAML 全量解析——守卫只认
 *  这两个键的顶层声明，嵌套/正文文本不误报）。 */
function readDeclaredRef(frontLines) {
  let kind
  let model
  for (const line of frontLines) {
    const kindMatch = /^kind:\s*(\S+)\s*$/.exec(line)
    if (kindMatch) kind = kindMatch[1]
    const modelMatch = /^model:\s*(\S+)\s*$/.exec(line)
    if (modelMatch) model = modelMatch[1]
  }
  return { kind, model }
}

function walkMdFiles(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkMdFiles(full, out)
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
  }
}

const mdFiles = []
walkMdFiles(EXTENSIONS_DIR, mdFiles)

const declarations = [] // { file, ref }
for (const file of mdFiles) {
  let content
  try {
    content = readFileSync(file, 'utf-8')
  } catch (e) {
    warn(`不可读（跳过）: ${relative(ROOT, file)} — ${e.message}`)
    continue
  }
  const front = readFrontmatterBlock(content)
  if (!front) continue
  const { kind, model } = readDeclaredRef(front)
  if (kind !== 'agent' || model === undefined || model.trim() === '') continue
  declarations.push({ file, ref: model.trim() })
}

if (declarations.length === 0) {
  console.log('check-model-references: extensions/ 内无 agent 资产模型声明（当前存量 = 0，P-C4 采集一致）— OK')
}

// ── 2. 逐条声明 vs 快照 diff ─────────────────────────────────────────

for (const { file, ref } of declarations) {
  const rel = relative(ROOT, file)
  const clean = stripThinkingSuffix(ref)
  const slashIdx = clean.indexOf('/')
  const provider = slashIdx > 0 ? clean.slice(0, slashIdx) : ''
  const id = slashIdx > 0 ? clean.slice(slashIdx + 1) : ''
  if (provider === '' || id === '') {
    fail(`${rel}: model "${ref}" 非 "provider/modelId" 规范形——恢复动作：改为快照内 provider/modelId 全等串（含大小写），或删除该声明`)
    continue
  }
  if (!providerIds.has(provider)) {
    fail(
      `${rel}: model "${ref}" 的 provider "${provider}" 不在内置 provider 目录快照（快照 ${providerIds.size} 个 provider）` +
        `——恢复动作：核对 pnpm gen:builtin-providers 快照中的 provider id，或删除该声明`,
    )
    continue
  }
  if (!modelsByProvider.get(provider).has(id)) {
    fail(
      `${rel}: model "${ref}" 的 id "${id}" 不在 provider "${provider}" 的内置目录内` +
        `——恢复动作：核对快照中该 provider 的模型 id（provider 配置漂移时先 pnpm gen:builtin-providers 重生成快照再对账），或删除该声明`,
    )
  }
}

// ── 结果 ─────────────────────────────────────────────────────────────
if (failed) {
  console.error(`\ncheck-model-references: FAIL（声明 ${declarations.length} 条，见上 ✗ 明细）`)
  process.exit(1)
}
console.log(`check-model-references: OK（声明 ${declarations.length} 条，全部命中内置 provider 目录快照）`)
