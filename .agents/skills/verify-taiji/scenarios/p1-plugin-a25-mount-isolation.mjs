/**
 * p1-plugin-a25-mount-isolation —— D3 验收场景 A25（设计 S25，核心）：
 * 同挂载位多插件隔离——两个 fixture 插件交替向 provider.detail-extra 推树，各推各的
 * （快照按 pluginId 分区互不覆盖；UI 行卡只渲染自己插件的树）。
 *
 * 装配：runner 单实例（scenario 顶层 import 阶段 seed）+ 双 fixture 插件：
 *   - a25-iso-alpha（pkg '@verify/plugin-iso-alpha' → ns 'iso-alpha'）：providers.write 写
 *     iso-alpha-prov 条目 + 激活即推 detail-extra 树（A1 哨兵）+ repaint 方法重推（A2）；
 *   - a25-iso-beta（pkg '@verify/plugin-iso-beta' → ns 'iso-beta'）：同构（B1/B2）。
 *   清单双家族条目（行卡 pluginInfo 识别的前提 = providerId 命中家族 id 前缀）。
 *
 * 路径：
 *   C：models.json 双条目落盘（两插件 providers.write 各自命名空间）→
 *   B：快照分区基线（global:provider.detail-extra:<pluginId>）A=A1 / B=B1——分区键按
 *   插件维度正交 →
 *   A：展开 IsoAlpha 行 → 边界内 A1 在场、B1 不在场（行卡只渲染自己插件的分区）→
 *   B：invoke iso-a repaint → 快照 A 含 A2 → 对拍快照 B 仍含 B1 且不含 A2（A 重推不覆盖
 *   B 分区）→ invoke iso-b repaint → 快照 B 含 B2 → 对拍快照 A 仍含 A2 且不含 B2（交替
 *   重推互不覆盖）→
 *   A：收起 A 行 → 展开 IsoBeta 行 → 边界内 B1/B2 在场、A 哨兵不在场；重展开 IsoAlpha →
 *   A2 在场（UI 与快照同源）。
 *
 * 锚点事实（源码已核对）：全局域分区键 = `global:<mountId>:<pluginId>`（view-host-source.ts
 * / view-host-store，pluginId 取 sandbox fork 通道身份——消息体自报值不进判定，
 * views-api.registerViewRpcHandlers）；行卡 detail-extra ViewHost scope =
 * { kind:'global', mountId, pluginId: pluginInfo.pluginId }（ProviderRowCard.vue）；
 * 快照请求 = plugin.ui.snapshot { mountId, pluginId, viewId }（a6 先例）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

import { pluginFixture, resolveDataDirFromArgv } from './lib-plugin-fixtures.mjs'
import {
  seedMultiPluginFixture,
  waitPluginActive,
  openProviderPage,
  providerCardSelector,
  expandProviderRow,
  pollUntil,
} from './lib/plugin-provider-fixture.mjs'

const DETAIL_EXTRA_MOUNT = 'provider.detail-extra'
const A1 = 'A25-ALPHA-TREE-V1'
const A2 = 'A25-ALPHA-TREE-V2'
const B1 = 'A25-BETA-TREE-V1'
const B2 = 'A25-BETA-TREE-V2'

const PROBE_PERMISSIONS = ['plugin.views.update', 'plugin.commands.register', 'plugin.commands.invoke.result', 'providers.write']

/** 双插件文件集（同构，参数化 ns/providerId/哨兵）。 */
function isoPlugin({ dirName, pkgName, ns, providerId, rowName, v1, v2 }) {
  return pluginFixture({
    dirName,
    pkgName,
    displayName: dirName,
    description: `A25 fixture: isolated detail-extra trees for ${ns}`,
    namespace: ns,
    permissions: PROBE_PERMISSIONS,
    activateBody: `
  const push = (mark) => api.views.update('${DETAIL_EXTRA_MOUNT}', [
    { type: 'ansi-text', props: { lines: [mark] } },
  ], { mountId: '${DETAIL_EXTRA_MOUNT}' })
  await api.commands.register({ id: 'repaint' }, () => push('${v2}'))
  await api.providers.write({ providerId: '${providerId}', apiKey: 'A25-KEY-${ns.toUpperCase()}', displayName: '${rowName}', models: [{ id: '${ns}-model' }] })
  await push('${v1}')
`,
  })
}

// ── 顶层预置（import 阶段执行，先于 instance.launch）────────────────
const dataDir0 = resolveDataDirFromArgv()
const seedSummary = seedMultiPluginFixture(dataDir0, {
  plugins: [
    isoPlugin({ dirName: 'a25-iso-alpha', pkgName: '@verify/plugin-iso-alpha', ns: 'iso-alpha', providerId: 'iso-alpha-prov', rowName: 'IsoAlpha (verify fixture)', v1: A1, v2: A2 }),
    isoPlugin({ dirName: 'a25-iso-beta', pkgName: '@verify/plugin-iso-beta', ns: 'iso-beta', providerId: 'iso-beta-prov', rowName: 'IsoBeta (verify fixture)', v1: B1, v2: B2 }),
  ],
  permissionSpecs: {
    'a25-iso-alpha': PROBE_PERMISSIONS,
    'a25-iso-beta': PROBE_PERMISSIONS,
  },
  catalogPlugins: [
    {
      packageName: '@verify/plugin-iso-alpha',
      pluginId: 'a25-iso-alpha',
      displayName: 'IsoAlpha',
      description: 'A25 isolation family alpha (installed)',
      pluginVersion: '0.1.0',
      family: { id: 'iso-alpha', displayName: 'IsoAlpha', vendor: 'verify', credentialSource: 'oauth', modelCount: 1 },
    },
    {
      packageName: '@verify/plugin-iso-beta',
      pluginId: 'a25-iso-beta',
      displayName: 'IsoBeta',
      description: 'A25 isolation family beta (installed)',
      pluginVersion: '0.1.0',
      family: { id: 'iso-beta', displayName: 'IsoBeta', vendor: 'verify', credentialSource: 'oauth', modelCount: 1 },
    },
  ],
})

export const meta = {
  id: 'p1-plugin-a25-mount-isolation',
  priority: 'P1',
  title: 'D3/A25（设计 S25）：同挂载位多插件隔离——detail-extra 分区按 pluginId 正交，交替重推互不覆盖，行卡各渲染各的',
  covers: ['settings.provider', 'plugin.list'],
  requires: [],
  estimateSec: 240,
  provable: [
    'C: models.json 双条目落盘（两插件 providers.write 各自命名空间正面）',
    'B: 快照分区基线正交——A 分区含 A1、B 分区含 B1（global:provider.detail-extra:<pluginId> 分区键）',
    'A: 展开 IsoAlpha 行只渲染 A 分区树（A1 在场、B1 不在场）',
    'B: iso-a 重推后快照 A 含 A2 且快照 B 仍含 B1 不含 A2（A 重推不覆盖 B 分区）',
    'B: iso-b 重推后快照 B 含 B2 且快照 A 仍含 A2 不含 B2（交替重推互不覆盖）',
    'A: 展开 IsoBeta 行只渲染 B 分区树（B1/B2 在场、A 哨兵不在场）；重展开 IsoAlpha 行 A2 在场（UI 与快照同源）',
  ],
  notProvable: [
    'plugin.authorize 挂载位的家族卡切换视角（设计 S25 原文场景）——同一分区键实现（global:<mountId>:<pluginId>），detail-extra 视角覆盖即证分区机制',
    '伪造 pluginId 写他人分区的防御面——sandbox fork 通道身份由宿主注册（views-api 取 identity.pluginId，自报值不进判定），插件侧无用户通道可伪造',
    'trusted 共享 Worker 的回落自报分支（羊毛系 external 插件恒 sandbox，正常路径无此形态）',
  ],
}

export async function run(ctx) {
  const { ev, log, protocol, dataDir, repo } = ctx
  const uncovered = []
  const gotchas = [
    '分区键 = global:<mountId>:<pluginId>（插件维度在键内）——两个插件同挂载位互不覆盖是分区机制的结构性结果，不是互斥锁',
    '快照（plugin.ui.snapshot）与渲染同源（runtime 快照兜底 + 展开时 refreshViewInScope 拉取）——B 通道快照对拍先行，UI 断言随后',
    'repaint 经 plugin.invoke 触发（commands-executor 执行链），是剧本驱动插件重推的唯一正路',
    '行卡手风琴单展开（ProviderPage expandedId 单值）——「两行同时可见」不可能，隔离断言用分区快照承载，UI 断言按行轮流展开',
  ]
  const { createUI } = await import(path.join(SKILL_ROOT, 'scripts', 'lib', 'ui.mjs'))
  const page = await ctx.instance.page()
  const ui = createUI({ page, evidence: ev, repo })
  const proto = protocol

  const ALPHA_ID = 'a25-iso-alpha'
  const BETA_ID = 'a25-iso-beta'
  const ALPHA_ROW = 'IsoAlpha (verify fixture)'
  const BETA_ROW = 'IsoBeta (verify fixture)'

  ev.step({ step: 'fixture.seed', channel: 'C', exitCode: 0, stats: { dataDir, plugins: seedSummary.pluginDirs.length, sentinels: [A1, A2, B1, B2] } })

  await waitPluginActive(proto, ALPHA_ID)
  await waitPluginActive(proto, BETA_ID)

  // C：双条目落盘
  const written = await pollUntil(() => {
    try {
      const models = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', 'models.json'), 'utf8'))
      return Boolean(models.providers?.['iso-alpha-prov']?.apiKey) && Boolean(models.providers?.['iso-beta-prov']?.apiKey)
    } catch {
      return false
    }
  }, { timeoutMs: 20_000, label: 'models.json 落盘 iso-alpha-prov + iso-beta-prov' })
  ev.assert('C: models.json 双条目落盘（两插件各自命名空间 providers.write）', written !== null, {
    channel: 'C',
    expected: 'iso-alpha-prov + iso-beta-prov 均含 apiKey',
    actual: written !== null ? '命中' : '20s 内未落盘',
  })

  /** 快照分区文本（B 通道权威源）。 */
  const snapshotText = async (pluginId) => {
    const snap = await proto.call(
      'plugin.ui.snapshot',
      { mountId: DETAIL_EXTRA_MOUNT, pluginId, viewId: DETAIL_EXTRA_MOUNT },
      { replyType: 'plugin:uiSnapshot', timeoutMs: 30_000 },
    )
    return JSON.stringify(snap?.views ?? [])
  }

  // B：分区基线（激活期推送 → 快照兜底）
  const baseA = await pollUntil(async () => (await snapshotText(ALPHA_ID)).includes(A1) ? 'hit' : null, { timeoutMs: 20_000, label: 'A 分区基线 A1' })
  const baseB = await pollUntil(async () => (await snapshotText(BETA_ID)).includes(B1) ? 'hit' : null, { timeoutMs: 20_000, label: 'B 分区基线 B1' })
  ev.assert('B: 分区基线正交（A 分区含 A1、B 分区含 B1）', baseA !== null && baseB !== null, {
    channel: 'B',
    expected: `A 分区含 ${A1}；B 分区含 ${B1}`,
    actual: `A=${baseA !== null} B=${baseB !== null}`,
  })

  // A：展开 IsoAlpha 行 → 只渲染 A 分区
  await openProviderPage(ui)
  const alphaCard = providerCardSelector(ALPHA_ROW)
  const betaCard = providerCardSelector(BETA_ROW)
  await ui.expectVisible(`${alphaCard} [data-testid="provider-plugin-badge"]`)
  await ui.expectVisible(`${betaCard} [data-testid="provider-plugin-badge"]`)
  await expandProviderRow(ui, ALPHA_ROW)
  const alphaBoundary = `${alphaCard} [data-testid="provider-detail-extra-boundary"]`
  await ui.expectVisible(alphaBoundary, { timeoutMs: 20_000 })
  /** 行内边界文本（原生 DOM 查询——:has-text() 是 Playwright 语法，evaluate 内不可用）。 */
  const boundaryText = (rowName) => page.evaluate(({ name }) => {
    const cardEl = [...document.querySelectorAll('[data-testid="provider-card"]')].find((el) => el.textContent?.includes(name))
    return cardEl?.querySelector('[data-testid="provider-detail-extra-boundary"]')?.textContent ?? ''
  }, { name: rowName })
  const alphaUi = await pollUntil(async () => {
    const text = await boundaryText(ALPHA_ROW)
    return text.includes(A1) ? text : null
  }, { timeoutMs: 20_000, label: 'IsoAlpha 边界渲染 A1' })
  const alphaUiClean = alphaUi !== null && !alphaUi.includes(B1)
  ev.assert('A: IsoAlpha 行只渲染 A 分区树（A1 在场、B1 不在场）', alphaUiClean, {
    channel: 'A',
    expected: `${A1} 在场且 ${B1} 不在场`,
    actual: alphaUi !== null ? `A1=${alphaUi.includes(A1)} B1=${alphaUi.includes(B1)}` : '20s 内边界未渲染 A1',
  })
  await ui.screenshot('a25-alpha-row-isolated')

  // B：A 重推 → A 分区更新、B 分区不动
  await proto.call('plugin.invoke', { pluginId: ALPHA_ID, method: 'repaint', params: {} }, { timeoutMs: 30_000 })
  const repaintedA = await pollUntil(async () => (await snapshotText(ALPHA_ID)).includes(A2) ? 'hit' : null, { timeoutMs: 20_000, label: 'A 分区含 A2' })
  const snapshotB1 = await snapshotText(BETA_ID)
  ev.assert('B: iso-a 重推后 A 分区含 A2、B 分区仍 B1 且无 A2（不覆盖邻居）', repaintedA !== null && snapshotB1.includes(B1) && !snapshotB1.includes(A2), {
    channel: 'B',
    expected: `A 含 ${A2}；B 含 ${B1} 且不含 ${A2}`,
    actual: `A2=${repaintedA !== null} B1=${snapshotB1.includes(B1)} B-hasA2=${snapshotB1.includes(A2)}`,
  })

  // B：B 重推 → B 分区更新、A 分区不动（交替重推互不覆盖）
  await proto.call('plugin.invoke', { pluginId: BETA_ID, method: 'repaint', params: {} }, { timeoutMs: 30_000 })
  const repaintedB = await pollUntil(async () => (await snapshotText(BETA_ID)).includes(B2) ? 'hit' : null, { timeoutMs: 20_000, label: 'B 分区含 B2' })
  const snapshotA2 = await snapshotText(ALPHA_ID)
  ev.assert('B: iso-b 重推后 B 分区含 B2、A 分区仍 A2 且无 B2（交替重推互不覆盖）', repaintedB !== null && snapshotA2.includes(A2) && !snapshotA2.includes(B2), {
    channel: 'B',
    expected: `B 含 ${B2}；A 含 ${A2} 且不含 ${B2}`,
    actual: `B2=${repaintedB !== null} A2=${snapshotA2.includes(A2)} A-hasB2=${snapshotA2.includes(B2)}`,
  })
  ev.attach('a25-partition-snapshots', JSON.stringify({ alpha: snapshotA2.slice(0, 600), beta: snapshotB1.slice(0, 600) }))

  // A：Beta 行只渲染 B 分区；Alpha 行重展开见 A2（UI 与快照同源）
  await ui.click(`${alphaCard} span[role="button"]`)
  await ui.expectGone(`${alphaCard} [data-testid="provider-expand-body"]`, { timeoutMs: 10_000 })
  await expandProviderRow(ui, BETA_ROW)
  const betaBoundary = `${betaCard} [data-testid="provider-detail-extra-boundary"]`
  await ui.expectVisible(betaBoundary, { timeoutMs: 20_000 })
  const betaUi = await pollUntil(async () => {
    const text = await boundaryText(BETA_ROW)
    // B1 已被 iso-b 重推全量替换（generation 替换语义即本场景验证对象），Beta 行最新树 = B2
    return text.includes(B2) ? text : null
  }, { timeoutMs: 20_000, label: 'IsoBeta 边界渲染 B2' })
  const betaUiClean = betaUi !== null && !betaUi.includes(A1) && !betaUi.includes(A2)
  ev.assert('A: IsoBeta 行只渲染 B 分区树（B2 在场、A 哨兵不在场）', betaUiClean, {
    channel: 'A',
    expected: `${B2} 在场且 A 哨兵不在场（B1 已被 iso-b 重推全量替换——替换语义本身）`,
    actual: betaUi !== null ? `B1=${betaUi.includes(B1)} B2=${betaUi.includes(B2)} A1=${betaUi.includes(A1)} A2=${betaUi.includes(A2)}` : '20s 内边界未渲染 B2',
  })
  await ui.screenshot('a25-beta-row-isolated')

  await ui.click(`${betaCard} span[role="button"]`)
  await ui.expectGone(`${betaCard} [data-testid="provider-expand-body"]`, { timeoutMs: 10_000 })
  await expandProviderRow(ui, ALPHA_ROW)
  const alphaReUi = await pollUntil(async () => {
    const text = await boundaryText(ALPHA_ROW)
    return text.includes(A2) ? text : null
  }, { timeoutMs: 20_000, label: 'IsoAlpha 重展开渲染 A2' })
  ev.assert('A: IsoAlpha 重展开渲染 A2（重推后的 UI 与快照同源）', alphaReUi !== null, {
    channel: 'A',
    expected: `${A2} 在场`,
    actual: alphaReUi !== null ? '命中' : '20s 内未见 A2',
  })

  log('a25 done')
  return { uncovered, gotchas }
}
