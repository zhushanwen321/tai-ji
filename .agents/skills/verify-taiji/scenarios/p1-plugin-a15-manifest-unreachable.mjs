/**
 * p1-plugin-a15-manifest-unreachable —— D3 验收场景 A15（设计 S15，非核心）：
 * 插件清单不可达两态（fail-safe 链：远程 → 上次缓存 → 无缓存报错）。
 *
 * 装配：自建隔离实例（verify-d3-r3 家族）+ launch 前 seed demo fixture 插件与清单缓存
 * （checkedAt 拨旧到 5h 前 = 节流窗外，listAvailable 必走网络）。「断网」的确定性前提 =
 * raw.githubusercontent.com 直连不可达（REMOTE_CONFIG_BASE_URL 是编译期常量不可注入，
 * 境内默认直连境外超时；run 开头跑一次同 URL 探针锁定前提，探针可达 = 环境不满足直接
 * fail 并提示关代理，不静默产出误导性绿）。
 *
 * 路径：
 *   态① 曾拉取成功后断网：
 *   B：plugin.listAvailable → available=true / stale=true / reason='network' / 缓存 3 条目 →
 *   A：家族卡网格 3 张（缓存清单渲染）→ demo 行（已装 provider）展开正常（管理不受影响）→
 *   态② 从未拉取断网（删缓存文件后重开对话框强制重拉）：
 *   B：plugin.listAvailable → available=false / reason='no-cache' / plugins=[] →
 *   A：plugin-family-empty 空态 + plugin-catalog-retry 重试入口在场、家族卡 0 张 →
 *   A：demo 行仍可展开、宿主编辑体正常（既有 provider 管理不受影响）。
 *
 * 锚点事实（源码已核对）：fail-safe 链 = refreshRemoteConfig（remote-config-fetch.ts，
 * checkedAt 节流 / 网络失败 reason='network' / 无缓存 reason='no-cache'，链路恒成功返回
 * 不 reject）；plugin.listAvailable runtime 侧只透出 reply.plugins（stale/available 停在
 * service 层）；UI 空态 = PluginProviderFlow.vue 的 plugin-family-empty + plugin-catalog-retry
 * （catalogLoaded 区分「清单为空」与「正在加载」文案）。S15① 的「清单可能不是最新」提示：
 * renderer 侧无 stale 消费（PluginProviderSource.refreshCatalog 丢弃 stale 字段）——产品
 * 偏差，记 ISSUES 不阻断本剧本（fail-safe 降级本体与重试入口照验）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

import {
  launchFixtureInstance,
  waitPluginActive,
  seedDemoProvider,
  seedPluginProviderFixture,
  openProviderPage,
  demoCardSelector,
  expandDemoProviderRow,
  removeCatalogCache,
  DEMO_PLUGIN_ID,
  DEMO_ROW_NAME,
} from './lib/plugin-provider-fixture.mjs'

/** 与 remote-config-fetch.ts 同源常量（探针 URL 与超时——改源码必须同步这里）。 */
const REMOTE_BASE_URL = 'https://raw.githubusercontent.com/zhushanwen321/tai-ji/main/configs/remote'
const REQUEST_TIMEOUT_MS = 8000

/** 断网前提探针：直连清单 URL 必须 fail（8s 超时/连接拒绝均算不可达）。 */
async function remoteUnreachable() {
  try {
    await fetch(`${REMOTE_BASE_URL}/v2-plugins.json`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    return false
  } catch {
    return true
  }
}

export const meta = {
  id: 'p1-plugin-a15-manifest-unreachable',
  priority: 'P1',
  title: 'D3/A15（设计 S15）：清单不可达两态——缓存兜底（stale）与无缓存整页空态重试，已装 provider 管理均不受影响',
  covers: ['settings.provider', 'plugin.listAvailable'],
  requires: [],
  estimateSec: 260,
  provable: [
    'C: 断网前提探针——直连 raw.githubusercontent.com 清单 URL 不可达（8s 超时），fail-safe 链的网络失败分支确定性命中',
    'B: 态① listAvailable available=true / stale=true / reason=network / plugins=缓存 3 条目（缓存兜底语义）',
    'A: 态① 家族卡 3 张（缓存清单渲染）+ demo 已装行展开正常（既有 provider 管理不受影响）',
    'B: 态② 删缓存后 listAvailable available=false / reason=no-cache / plugins=[]（全链无数据语义）',
    'A: 态② plugin-family-empty 空态 + plugin-catalog-retry 重试入口在场、家族卡 0 张（整页报错 + 重试）',
    'A: 态② demo 行仍可展开、宿主编辑体（provider-edit-name）在场（既有 provider 管理不受影响）',
  ],
  notProvable: [
    'S15① 的「清单可能不是最新」提示——renderer 无 stale 消费（PluginProviderSource.refreshCatalog 丢弃该字段），产品偏差记 ISSUES，本剧本不断言',
    '真实远程清单内容（探针只验不可达；远程数据正确性归 S1/S26）',
    '重试按钮点击后的成功恢复（需断网恢复时序，本剧本锁定两态降级形态本体）',
  ],
}

export async function run(ctx) {
  const { ev, log, repo } = ctx
  const uncovered = []
  const gotchas = [
    '「断网」= 直连 GitHub raw 超时（境内默认环境；探针可达说明代理开着，环境不满足直接 fail）',
    'remote-config-fetch 的网络失败路径不落盘不更新 checkedAt——同实例可连续复现两态（删缓存文件即切换）',
    'listAvailable RPC 恒成功返回（fail-safe 不 reject）；「报错」的 UI 形态 = 家族卡空态块 + 重试按钮，不是 toast/dialog',
    '态② 下插件来源识别失效（entryOfProvider 依赖清单）→ demo 行失去插件徽标属产品真实降级，管理动作（展开/编辑）不受影响',
  ]
  const { createUI } = await import(path.join(SKILL_ROOT, 'scripts', 'lib', 'ui.mjs'))
  let instance = null
  let proto = null
  try {
    // ── 断网前提探针（环境不满足 = fail，不产出误导性绿）─────────────
    const unreachable = await remoteUnreachable()
    ev.assert('C: 断网前提探针（直连 raw.githubusercontent.com 不可达）', unreachable, {
      channel: 'C',
      expected: `8s 内不可达（${REMOTE_BASE_URL}）`,
      actual: unreachable ? '不可达（断网态成立）' : '可达——代理开启导致 fail-safe 网络分支无法确定性命中，请关代理后重跑',
    })
    if (!unreachable) {
      uncovered.push('断网前提不成立（远程清单可达）——S15 两态无法确定性复现')
    }

    // ── 装配：checkedAt 拨旧 5h（节流窗外 = 必走网络）────────────────
    const fixture = await launchFixtureInstance({
      repo, ev, tag: 'a15', family: 'd3-r3',
      seed: (dataDir) => seedPluginProviderFixture(dataDir, { catalogCheckedAt: Date.now() - 5 * 3_600_000 }),
    })
    instance = fixture.instance
    proto = fixture.proto
    const ui = createUI({ page: await instance.page(), evidence: ev, repo })

    await waitPluginActive(proto, DEMO_PLUGIN_ID)
    await seedDemoProvider(proto, fixture.dataDir, ev)

    // ── 态①：曾拉取成功（缓存在场）+ 断网 ──────────────────────────
    const avail1 = await proto.call('plugin.listAvailable', {}, { timeoutMs: 30_000 })
    const plugins1 = avail1?.plugins ?? []
    ev.assert('B: 态① available=true / stale=true / reason=network', avail1?.available === true && avail1?.stale === true && avail1?.reason === 'network', {
      channel: 'B',
      expected: 'available=true stale=true reason=network',
      actual: `available=${avail1?.available} stale=${avail1?.stale} reason=${avail1?.reason}`,
    })
    ev.assert('B: 态① plugins=缓存 3 条目（缓存兜底生效）', plugins1.length === 3 && plugins1.some((p) => p.pluginId === DEMO_PLUGIN_ID && p.installed === true), {
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

    // 家族卡（打开对话框触发 enterFlow → refreshCatalog：网络失败 → 缓存渲染）
    await ui.click('testid=provider-template-picker')
    await ui.click('testid=add-menu-plugin')
    await ui.expectVisible('testid=plugin-provider-flow', { timeoutMs: 30_000 })
    await ui.expectCount('testid=plugin-family-card', 3, { timeoutMs: 30_000 })
    ev.assert('A: 态① 家族卡 3 张（缓存清单渲染，无空态块）', true, {
      channel: 'A',
      expected: 'plugin-family-card × 3',
      actual: '命中（8s 网络失败后缓存渲染）',
    })
    await ui.screenshot('a15-state1-stale-cache')

    // ── 态②：删缓存（从未拉取）+ 断网 → 重开对话框强制重拉 ─────────
    const removed = removeCatalogCache(fixture.dataDir)
    ev.step({ step: 'catalog-cache.removed', channel: 'C', exitCode: removed ? 0 : 1, stats: { dataDir: fixture.dataDir, existed: removed } })
    await ui.press('Escape')
    await ui.expectGone('testid=plugin-provider-flow', { timeoutMs: 10_000 })

    const avail2 = await proto.call('plugin.listAvailable', {}, { timeoutMs: 30_000 })
    ev.assert('B: 态② available=false / reason=no-cache / plugins=[]', avail2?.available === false && avail2?.reason === 'no-cache' && (avail2?.plugins ?? []).length === 0, {
      channel: 'B',
      expected: 'available=false reason=no-cache plugins=[]',
      actual: `available=${avail2?.available} reason=${avail2?.reason} count=${(avail2?.plugins ?? []).length}`,
    })

    await ui.click('testid=provider-template-picker')
    await ui.click('testid=add-menu-plugin')
    await ui.expectVisible('testid=plugin-provider-flow', { timeoutMs: 30_000 })
    await ui.expectVisible('testid=plugin-family-empty', { timeoutMs: 30_000 })
    await ui.expectCount('testid=plugin-family-card', 0)
    await ui.expectVisible('testid=plugin-catalog-retry')
    ev.assert('A: 态② 家族卡空态 + 重试入口在场（整页报错 + 重试形态）', true, {
      channel: 'A',
      expected: 'plugin-family-empty + plugin-catalog-retry 在场、家族卡 0 张',
      actual: '命中',
    })
    await ui.screenshot('a15-state2-no-cache')

    // 既有 provider 管理不受影响（空态下关闭对话框、行管理与展开正常）
    await ui.press('Escape')
    await ui.expectGone('testid=plugin-provider-flow', { timeoutMs: 10_000 })
    await ui.expectVisible(card)
    await expandDemoProviderRow(ui)
    await ui.expectVisible(`${card} [data-testid="provider-edit-name"]`)
    ev.assert('A: 态② demo 行仍可展开、宿主编辑体在场（既有 provider 管理不受影响）', true, {
      channel: 'A',
      expected: `${DEMO_ROW_NAME} 行展开 + provider-edit-name 在场`,
      actual: '命中',
    })
    ev.attach('a15-state2-list-available', JSON.stringify(avail2, null, 2).slice(0, 2_000))

    log('a15 done')
  } finally {
    try {
      await proto?.close()
    } catch { /* ignore */ }
    if (instance) {
      await instance.dispose()
      try {
        fs.rmSync(instance.dataDir, { recursive: true, force: true })
      } catch { /* 清理失败由证据目录暴露 */ }
    }
  }
  return { uncovered, gotchas }
}
