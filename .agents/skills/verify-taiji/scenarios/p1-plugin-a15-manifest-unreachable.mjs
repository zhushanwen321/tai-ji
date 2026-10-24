/**
 * p1-plugin-a15-manifest-unreachable —— D3 验收场景 A15（设计 S15，非核心）：
 * 插件清单不可达两态（fail-safe 链：远程 → 上次缓存 → 无缓存报错）。
 *
 * 装配：runner 单实例（smoke 形态——scenario 顶层在 import 阶段 seed 数据目录，先于
 * instance.launch）+ demo fixture 插件 + 清单缓存 checkedAt 拨旧到 5h 前（4h 节流窗外 =
 * listAvailable 必走网络）。「断网」的确定性前提 = 远程清单不可用：与本剧本同源探测
 * remote-config-fetch 的网络分支语义（fetch 抛错或 !res.ok 均回退缓存，reason='network'）。
 * 当前环境事实：GitHub main 上 configs/remote/v2-plugins.json 不存在（404）——与网络失败
 * 同一 fail-safe 分支且比网络可达性更稳；run 开头跑同 URL 探针锁定前提，200 = 远程已有
 * 真实清单、环境不满足，直接 fail 并提示（不静默产出误导性绿）。
 *
 * 路径：
 *   态① 曾拉取成功后远程不可用：
 *   B：plugin.listAvailable → plugins=缓存 3 条目（回退缓存，缓存兜底语义）→
 *   A：家族卡网格 3 张（缓存清单渲染）→ demo 已装行展开正常（既有 provider 管理不受影响）→
 *   态② 从未拉取（删缓存文件后重开对话框强制重拉）：
 *   B：plugin.listAvailable → plugins=[]（全链无数据）→
 *   A：plugin-family-empty 空态 + plugin-catalog-retry 重试入口在场、家族卡 0 张 →
 *   A：demo 行收起后仍可再展开、宿主编辑体在场（既有 provider 管理不受影响）。
 *
 * 锚点事实（源码已核对）：fail-safe 链 = refreshRemoteConfig（remote-config-fetch.ts：
 * 网络失败回退缓存、无缓存 data undefined，链路恒成功不 reject；失败路径不落盘不更新
 * checkedAt——同实例删缓存文件即可切换两态）；plugin.listAvailable 的 RPC reply 只含
 * plugins（service 层的 available/stale/reason 在 runtime 侧被丢弃，UI 空态判定走
 * catalogLoaded + 空数组——S15①「清单可能不是最新」提示与 stale 判据未透出 UI，产品偏差
 * 记 ISSUES，本剧本不断言）；UI 空态 = PluginProviderFlow.vue 的 plugin-family-empty +
 * plugin-catalog-retry。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

import { resolveDataDirFromArgv } from './lib-plugin-fixtures.mjs'
import {
  seedPluginProviderFixture,
  removeCatalogCache,
  waitPluginActive,
  seedDemoProvider,
  openProviderPage,
  demoCardSelector,
  expandDemoProviderRow,
  DEMO_PLUGIN_ID,
  DEMO_ROW_NAME,
} from './lib/plugin-provider-fixture.mjs'

// ── 顶层预置（import 阶段执行，先于 instance.launch）────────────────
// checkedAt 拨旧 5h：节流窗外 → 每次 listAvailable 都会尝试网络 → 直连超时 → 回退缓存。
const dataDir0 = resolveDataDirFromArgv()
const seedSummary = seedPluginProviderFixture(dataDir0, { catalogCheckedAt: Date.now() - 5 * 3_600_000 })

/** 与 remote-config-fetch.ts 同源常量（探针 URL 与超时——改源码必须同步这里）。 */
const REMOTE_BASE_URL = 'https://raw.githubusercontent.com/zhushanwen321/tai-ji/main/configs/remote'
const REQUEST_TIMEOUT_MS = 8000

/**
 * 远程不可用前提探针（remote-config-fetch 网络分支同语义）：fetch 抛错（超时/连接拒绝）
 * 或 !res.ok（404 等）都算「远程清单不可用」——fail-safe 链回退缓存的确定性前提。
 * res.ok=true = 远程已有真实清单，环境不满足（拉到真数据会覆盖 seed 缓存，两态失真）。
 */
async function remoteUnavailable() {
  try {
    const res = await fetch(`${REMOTE_BASE_URL}/v2-plugins.json`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (res.ok) return { unavailable: false, detail: `HTTP ${res.status}（远程清单存在且可拉）` }
    return { unavailable: true, detail: `HTTP ${res.status}（non-ok → 回退缓存分支）` }
  } catch (e) {
    return { unavailable: true, detail: `fetch 失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

export const meta = {
  id: 'p1-plugin-a15-manifest-unreachable',
  priority: 'P1',
  title: 'D3/A15（设计 S15）：清单不可达两态——缓存兜底与无缓存空态重试，已装 provider 管理均不受影响',
  covers: ['settings.provider', 'plugin.listAvailable'],
  requires: [],
  estimateSec: 260,
  provable: [
    'C: 远程不可用前提探针——清单 URL non-ok（404）或 fetch 失败，fail-safe 回退缓存分支确定性命中',
    'B: 态① listAvailable 返回缓存 3 条目（网络失败 → 缓存兜底生效，demo-wool installed=true）',
    'A: 态① 家族卡 3 张（缓存清单渲染）+ demo 已装行展开正常（既有 provider 管理不受影响）',
    'B: 态② 删缓存文件后 listAvailable 返回空清单（无缓存且拉不到 = 全链无数据）',
    'A: 态② plugin-family-empty 空态 + plugin-catalog-retry 重试入口在场、家族卡 0 张（整页报错 + 重试）',
    'A: 态② demo 行仍可展开、宿主编辑体在场（既有 provider 管理不受影响）',
  ],
  notProvable: [
    'S15① 的「清单可能不是最新」提示与 stale 判据——service 层 available/stale/reason 未透出 RPC（runtime 只透 reply.plugins），renderer 无从消费；产品偏差记 ISSUES',
    '真实远程清单内容（探针只验不可达；远程数据正确性归 S1/S26）',
    '重试按钮点击后的成功恢复（需断网恢复时序，本剧本锁定两态降级形态本体）',
    '态② 的「从未拉取」首载文案（catalogLoading）——catalogLoaded 单例在态① 已置 true，重开对话框显示「清单为空」文案；空态块与重试入口是断言对象，文案差异不载义',
  ],
}

export async function run(ctx) {
  const { ev, log, protocol, dataDir, repo } = ctx
  const uncovered = []
  const gotchas = [
    '「断网」在本剧本的确定形态 = 远程清单不可用（当前环境事实：GitHub main 无该文件，404 与网络失败走 remote-config-fetch 同一回退分支；探针 200 = 环境变了，fail 并提示）',
    'remote-config-fetch 的失败路径不落盘不更新 checkedAt——同实例删缓存文件即可连续复现两态',
    'listAvailable RPC 恒成功返回（fail-safe 不 reject）；「报错」的 UI 形态 = 家族卡空态块 + 重试按钮，不是 toast/dialog',
    '态② 下插件来源识别失效（entryOfProvider 依赖清单）→ demo 行失去插件徽标属产品真实降级，管理动作（展开/编辑）不受影响',
    '行展开是切换语义（点行名 = 展开/收起切换）——「仍可展开」断言先收起再展开，不重复点击',
  ]
  const { createUI } = await import(path.join(SKILL_ROOT, 'scripts', 'lib', 'ui.mjs'))
  const ui = createUI({ page: await ctx.instance.page(), evidence: ev, repo })
  const proto = protocol

  ev.step({ step: 'fixture.seed', channel: 'C', exitCode: 0, stats: { dataDir, catalogCheckedAtShiftedHours: 5, ...seedSummary, pluginDir: undefined } })

  // ── 远程不可用前提探针（环境不满足 = fail，不产出误导性绿）─────────
  const probe = await remoteUnavailable()
  ev.assert('C: 远程不可用前提探针（清单 URL non-ok 或 fetch 失败）', probe.unavailable, {
    channel: 'C',
    expected: `${REMOTE_BASE_URL}/v2-plugins.json 不可用（404/网络失败 → fail-safe 回退缓存分支确定性命中）`,
    actual: probe.unavailable ? probe.detail : `${probe.detail}——请删除远程文件或断网后重跑`,
  })
  if (!probe.unavailable) {
    uncovered.push('远程不可用前提不成立（远程清单可拉取）——S15 两态无法确定性复现')
  }

  await waitPluginActive(proto, DEMO_PLUGIN_ID)
  await seedDemoProvider(proto, dataDir, ev)

  // ── 态①：曾拉取成功（缓存在场）+ 断网 ─────────────────────────────
  const avail1 = await proto.call('plugin.listAvailable', {}, { timeoutMs: 30_000 })
  const plugins1 = avail1?.plugins ?? []
  ev.assert('B: 态① plugins=缓存 3 条目（网络失败 → 缓存兜底生效）', plugins1.length === 3 && plugins1.some((p) => p.pluginId === DEMO_PLUGIN_ID && p.installed === true), {
    channel: 'B',
    expected: '3 条目（缓存清单），demo-wool installed=true',
    actual: `count=${plugins1.length} ids=${plugins1.map((p) => p.pluginId).join(',')}`,
  })

  await openProviderPage(ui)
  const card = demoCardSelector()
  await ui.expectVisible(`${card} [data-testid="provider-plugin-badge"]`)
  await expandDemoProviderRow(ui)
  await ui.expectVisible(`${card} [data-testid="provider-edit-name"]`)
  ev.assert('A: 态① demo 已装行展开正常（宿主编辑体在场，管理不受影响）', true, {
    channel: 'A',
    expected: `${DEMO_ROW_NAME} 行展开 + provider-edit-name 在场`,
    actual: '命中',
  })

  // 家族卡（打开对话框触发 enterFlow → refreshCatalog：网络失败 8s → 缓存渲染）
  await ui.click('testid=provider-template-picker')
  await ui.click('testid=add-menu-plugin')
  await ui.expectVisible('testid=plugin-provider-flow', { timeoutMs: 30_000 })
  await ui.expectCount('testid=plugin-family-card', 3, { timeoutMs: 40_000 })
  ev.assert('A: 态① 家族卡 3 张（缓存清单渲染，无空态块）', true, {
    channel: 'A',
    expected: 'plugin-family-card × 3',
    actual: '命中（8s 网络失败后缓存渲染）',
  })
  await ui.screenshot('a15-state1-stale-cache')

  // ── 态②：删缓存（从未拉取）+ 断网 → 重开对话框强制重拉 ───────────
  const removed = removeCatalogCache(dataDir)
  ev.step({ step: 'catalog-cache.removed', channel: 'C', exitCode: removed ? 0 : 1, stats: { dataDir, existed: removed } })
  await ui.press('Escape')
  await ui.expectGone('testid=plugin-provider-flow', { timeoutMs: 10_000 })

  const avail2 = await proto.call('plugin.listAvailable', {}, { timeoutMs: 30_000 })
  const plugins2 = avail2?.plugins ?? []
  ev.assert('B: 态② listAvailable 返回空清单（无缓存且拉不到）', plugins2.length === 0, {
    channel: 'B',
    expected: 'plugins=[]（全链无数据）',
    actual: `count=${plugins2.length}`,
  })
  ev.attach('a15-state2-list-available', JSON.stringify(avail2, null, 2).slice(0, 2_000))

  await ui.click('testid=provider-template-picker')
  await ui.click('testid=add-menu-plugin')
  await ui.expectVisible('testid=plugin-provider-flow', { timeoutMs: 30_000 })
  await ui.expectVisible('testid=plugin-family-empty', { timeoutMs: 40_000 })
  await ui.expectCount('testid=plugin-family-card', 0)
  await ui.expectVisible('testid=plugin-catalog-retry')
  ev.assert('A: 态② 家族卡空态 + 重试入口在场（整页报错 + 重试形态）', true, {
    channel: 'A',
    expected: 'plugin-family-empty + plugin-catalog-retry 在场、家族卡 0 张',
    actual: '命中',
  })
  await ui.screenshot('a15-state2-no-cache')

  // 既有 provider 管理不受影响（空态下关闭对话框，行收起后可再展开、编辑体正常）
  await ui.press('Escape')
  await ui.expectGone('testid=plugin-provider-flow', { timeoutMs: 10_000 })
  await ui.expectVisible(card)
  // 态① 段行已展开：先点行名收起（展开动作是切换语义），再重展开证明「仍可展开」
  await ui.click(`${card} span[role="button"]`)
  await ui.expectGone(`${card} [data-testid="provider-expand-body"]`, { timeoutMs: 10_000 })
  await expandDemoProviderRow(ui)
  await ui.expectVisible(`${card} [data-testid="provider-edit-name"]`)
  ev.assert('A: 态② demo 行收起后仍可再展开、宿主编辑体在场（既有 provider 管理不受影响）', true, {
    channel: 'A',
    expected: `${DEMO_ROW_NAME} 行重展开 + provider-edit-name 在场`,
    actual: '命中',
  })

  log('a15 done')
  return { uncovered, gotchas }
}
