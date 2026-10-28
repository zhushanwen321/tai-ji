#!/usr/bin/env node
/**
 * check-z-surface-baseline.mjs —— z 基线扫描多重集 ↔ 模态表面登记表全等对账（§6.7 完备性判据）。
 *
 * 拦什么（原 settings-page-bundle 的「z 基线 ↔ 登记表全等对账」4 例逐条承接）：
 *   1. 扫描器非空转：已知表面（SettingsModal / SearchModal / CompanionBand / ToastContainer）
 *      必须被扫到；扫到的全部锚点解析值 ≥ 1000（`var(--z-*)` 解析后低于 1000 的不入基线）
 *   2. 全等：新增 z 面未登记 → 红；登记表条目在源码中消失 → 红；同 (file, form, literal)
 *      出现次数不一致 → 红
 *   3. 登记表结构完整：id 唯一、家族旗标组三字段齐备且与同步查询通道一致、excluded 语义自洽
 *   4. 豁免与低 z 面不入基线（HoverCard --z-hovercard: 500 / PlanCommentPopover --z-overlay: 20）
 *
 * 为什么是脚本而不是 vitest 用例：扫描对象是全仓源码（packages + apps + extensions），
 * 发起时实测 scanZSurfaces 单次 530ms，且耗时随仓库文件数单调增长；它不验证运行时行为。
 * 扫描器本体与登记表是唯一权威副本（`z-scan-helper.ts` / `manifest.ts`），本脚本直接 import
 * 它们（纯函数 + 纯数据，无 DOM / 无 vue 运行时依赖），不复制第二份实现。
 *
 * 用法：node scripts/check-z-surface-baseline.mjs
 * 退出码：0 = 全等；1 = 命中差异；2 = 环境错误（扫描器/登记表加载失败或扫描根失效）
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { findRepoRoot, scanZSurfaces } = await import(
  resolve(ROOT, 'packages/renderer/src/__tests__/composables/modal-surface-registry/z-scan-helper.ts')
)
const {
  MODAL_SURFACE_FAMILY_FLAGS,
  MODAL_SURFACE_MANIFEST,
  modalSurfaceEntry,
  modalSurfaceFlags,
} = await import(
  resolve(ROOT, 'packages/renderer/src/composables/features/app/modal-surface-registry/manifest.ts')
)

const problems = []
const check = (id, cond, detail) => {
  if (!cond) problems.push(`${id}：${detail}`)
}

let repoRoot
let occurrences
try {
  repoRoot = findRepoRoot(ROOT)
  occurrences = scanZSurfaces(repoRoot)
} catch (e) {
  console.error('[check-z-surface-baseline] 扫描失败（扫描根/扫描器异常）：', e instanceof Error ? e.message : e)
  process.exit(2)
}

/** (file, form, literal) → 出现次数（扫描侧多重集） */
function scannedCounts() {
  const counts = new Map()
  for (const o of occurrences) {
    const key = `${o.file}|${o.form}|${o.literal}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** (file, form, literal) → 出现次数（登记表侧多重集） */
function manifestCounts() {
  const counts = new Map()
  for (const entry of MODAL_SURFACE_MANIFEST) {
    for (const anchor of entry.zAnchors) {
      const key = `${anchor.file}|${anchor.form}|${anchor.literal}`
      counts.set(key, (counts.get(key) ?? 0) + anchor.count)
    }
  }
  return counts
}

// ── 1) 扫描器非空转 ──────────────────────────────────────────────────────────
{
  const keys = [...scannedCounts().keys()]
  check(
    'z-baseline/1 已知表面被扫到',
    keys.some((k) => k.includes('SettingsModal.vue') && k.includes('var(--z-modal)'))
      && keys.some((k) => k.includes('overlays/SearchModal.vue') && k.includes('var(--z-modal)'))
      && keys.some((k) => k.includes('CompanionBand.vue') && k.includes('var(--z-dialog)'))
      && keys.some((k) => k.includes('ToastContainer.vue') && k.endsWith('|var(--z-toast)')),
    'SettingsModal / SearchModal / CompanionBand / ToastContainer 四个已知表面必须出现在扫描结果里（扫描根或 z token 表可能已变）',
  )
  const below = occurrences.filter((o) => o.value < 1000)
  check(
    'z-baseline/1 锚点解析值下限',
    below.length === 0,
    `扫到 ${below.length} 条解析值 <1000 的锚点（低 z 面应被解析后过滤）：${below.slice(0, 5).map((o) => `${o.file}|${o.literal}=${o.value}`).join('、')}`,
  )
}

// ── 2) 扫描多重集 ≡ 登记表多重集 ────────────────────────────────────────────
{
  const scanned = scannedCounts()
  const manifest = manifestCounts()
  const unregistered = [...scanned.keys()].filter((k) => !manifest.has(k)).sort()
  const stale = [...manifest.keys()].filter((k) => !scanned.has(k)).sort()
  const countMismatch = [...scanned.keys()]
    .filter((k) => manifest.has(k) && manifest.get(k) !== scanned.get(k))
    .map((k) => `${k}: scan=${scanned.get(k)} manifest=${manifest.get(k)}`)
    .sort()
  check(
    'z-baseline/2 全等对账',
    unregistered.length === 0 && stale.length === 0 && countMismatch.length === 0,
    `未登记=${JSON.stringify(unregistered)}；登记表过期=${JSON.stringify(stale)}；次数不符=${JSON.stringify(countMismatch)}`
      + '（新增 z 面须先登记 manifest.ts 的 zAnchors；删除面须同步删登记）',
  )
}

// ── 3) 登记表结构完整性 ──────────────────────────────────────────────────────
{
  const seen = new Set()
  const dupIds = []
  const badFlags = []
  const badQuery = []
  const badExcluded = []
  for (const entry of MODAL_SURFACE_MANIFEST) {
    if (seen.has(entry.id)) dupIds.push(entry.id)
    seen.add(entry.id)
    const flags = MODAL_SURFACE_FAMILY_FLAGS[entry.family]
    if (typeof flags?.yieldsEsc !== 'boolean' || typeof flags?.yieldsCmdW !== 'boolean'
      || !['none', 'unconditional', 'intersecting'].includes(flags?.shieldsView)) {
      badFlags.push(entry.id)
    }
    if (JSON.stringify(modalSurfaceFlags(entry.id)) !== JSON.stringify(flags)
      || modalSurfaceEntry(entry.id).family !== entry.family) {
      badQuery.push(entry.id)
    }
    if (entry.kind === 'excluded' && (entry.family !== 'overlay-shell' || String(entry.basis ?? '').length <= 10)) {
      badExcluded.push(entry.id)
    }
  }
  check('z-baseline/3 登记表 id 唯一', dupIds.length === 0, `重复 id：${dupIds.join('、')}`)
  check('z-baseline/3 家族旗标组三字段齐备', badFlags.length === 0, `旗标组缺字段或 shieldsView 非法：${badFlags.join('、')}`)
  check('z-baseline/3 同步查询通道一致', badQuery.length === 0, `modalSurfaceFlags/Entry 与登记表不一致：${badQuery.join('、')}`)
  check(
    'z-baseline/3 excluded 语义自洽',
    badExcluded.length === 0,
    `excluded 条目须 family=overlay-shell 且 basis 说明 >10 字：${badExcluded.join('、')}`,
  )
}

// ── 4) 豁免与低 z 面不入基线 ────────────────────────────────────────────────
{
  const keys = [...scannedCounts().keys()]
  check(
    'z-baseline/4 低 z 面不入基线',
    !keys.some((k) => k.includes('HoverCard')) && !keys.some((k) => k.includes('PlanCommentPopover')),
    'HoverCard（--z-hovercard: 500）/ PlanCommentPopover（--z-overlay: 20）解析值 <1000，不应出现在基线里',
  )
}

if (problems.length > 0) {
  console.error(`[check-z-surface-baseline] 命中 ${problems.length} 条差异（扫描 ${occurrences.length} 条锚点 / 登记 ${MODAL_SURFACE_MANIFEST.length} 个表面）：`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log(`[check-z-surface-baseline] OK（扫描 ${occurrences.length} 条锚点 ≡ 登记表 ${MODAL_SURFACE_MANIFEST.length} 个表面的 zAnchors）`)
