// @vitest-environment node

/**
 * useExtensionHostBridge-plugin-replay.test.ts —— 清理与重放接线单测（容器扩展点统一
 * U12 / 走查 W-C-9 修复的验收载体）。
 *
 * 被测行为（桥内 config.plugins 订阅处维护快照 + E2 触发链成对接线双注册表）：
 * - U12-A（验收①）：plugin-status-change inactive/crashed → handlePluginGone 追加
 *   contentSlotRegistry.clearForPlugin——禁用后插件容器位从抽屉派生视图消失、内置项不受影响；
 * - U12-B（验收②）：handlePluginBack 的 external 分支从「只重放 builtin」改为从最近一帧
 *   config.plugins 快照重放——active 后不发第二帧，external 声明与容器位即刻回来；
 * - U12-C（验收③，S8 前置）：禁用→启用后容器位回来且不残留已删 tab——声明收缩（插件
 *   新版本删 tab）后经 禁用→启用 循环，派生视图只含存活项，分区选中值指向已删 tab 时
 *   effectiveDrawerTab 回退内置默认项（§11.1-1 断言 3 行为断言）；
 * - U12-D：enabled=false 帧不灌入不注册（togglePlugin 广播全量列表且 mapper 无条件透传
 *   禁用插件 contributes——不过滤则禁用清理被同一次操作的广播帧复活）；重放信任 active
 *   事件不看快照 enabled 位（statusChange 先于下一帧到达，快照 enabled 位已过期）；
 * - U12-E：快照缺失（安装后首帧未达）时 handlePluginBack 不 throw、builtin 照常重放。
 *
 * 双注册表断言：抽屉派生读 core 模块级单例（domain/drawer/content-slots 的
 * drawerTabViews），侧栏派生读 renderer 装配单例（lib/content-slots 的
 * getContentSlotRegistry().deriveSidebarTabs）——清理/灌入/重放对两份实体成对生效。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useExtensionHostBridge-plugin-replay.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { registerMountPoints, scanContributions, type ContributionRegistry } from '@taiji/core'
import { dispatchGlobal } from '@taiji/core/transport/api'
import { drawerTabViews, effectiveDrawerTab, builtinDefaultDrawerTab } from '@taiji/core/domain/drawer'
import { getContentSlotRegistry, __resetContentSlotsForTesting } from '@/lib/content-slots'
import {
  getExtensionBus,
  initExtensionHostBridge,
  __testing,
} from '@/composables/shell/useExtensionHostBridge'
import type { PluginInfo } from '@taiji/shared'

// commandStore 依赖 getPlatform().storage（bridge 装配即调 useCommandStore），stub 掉判定输入
//（对齐 extension-host-plugin-points-wiring.test.ts 同款 mock）
vi.mock('@/composables/features/command/useCommandStore', () => ({
  useCommandStore: () => ({ getCommands: () => [] as Array<{ name: string }> }),
}))

beforeEach(() => {
  // 双注册表实例均跨用例持存（core 模块级单例 + renderer 装配单例）：每用例重置 renderer
  // 侧；core 侧无 reset 入口，用各用例独立 pluginId 隔离（声明分区互不重叠）
  __resetContentSlotsForTesting()
})

afterEach(() => {
  __testing.lastInitHandles?.dispose()
  __testing.lastInitHandles = null
  __resetContentSlotsForTesting()
  vi.restoreAllMocks()
})

/** 装配桥 + bootstrap step4/5（step5 scanContributions 内建立 config.plugins 订阅——
 * 不建订阅则 dispatchGlobal 帧无人消费、快照不更新）。返回当次 contributions 实例。 */
function initBridgeWithSubscription(): ContributionRegistry {
  const app: { provide: () => unknown } = { provide: () => app }
  initExtensionHostBridge(app as never)
  const handles = __testing.lastInitHandles
  if (!handles) throw new Error('initExtensionHostBridge 未写入 __testing.lastInitHandles')
  void Promise.all([registerMountPoints(), scanContributions()])
  return handles.contributions
}

/** PluginInfo 最小 fixture（contributes 缺省 = 无清单声明，不清不注册） */
const pluginInfoOf = (
  pluginId: string,
  contributes: PluginInfo['contributes'],
  enabled = true,
): PluginInfo => ({
  pluginId,
  version: '1.0.0',
  displayName: pluginId,
  description: '',
  status: enabled ? 'active' : 'inactive',
  trustLevel: 'trusted',
  enabled,
  ...(contributes !== undefined ? { contributes } : {}),
})

/** config.plugins 帧（initial-state 与运行时广播同通道同形状——global 通道） */
const pluginsFrame = (plugins: PluginInfo[]) => ({
  type: 'config.plugins' as const,
  id: `plugins-replay-${plugins.map((p) => p.pluginId).join('_')}`,
  payload: { plugins },
})

/** 双注册表成对断言：插件容器位声明按 placement 出现在对应派生视图（drawer.tab 声明在
 * 抽屉派生 / sidebar.tab 声明在侧栏派生；两份注册表实例的对应派生视图同构）。 */
function expectPluginSlotEverywhere(declarationId: string, placement: 'drawer.tab' | 'sidebar.tab', present: boolean): void {
  if (placement === 'drawer.tab') {
    expect(drawerTabViews().some((v) => v.key === declarationId)).toBe(present)
    return
  }
  expect(
    getContentSlotRegistry().deriveSidebarTabs().some((v) => v.id === declarationId),
  ).toBe(present)
}

describe('U12 清理与重放接线（W-C-9：快照重放 + 容器位清理）', () => {
  it('U12-A（验收①）：inactive → handlePluginGone 追加 clearForPlugin，容器位消失、内置项不受影响', () => {
    initBridgeWithSubscription()
    dispatchGlobal(pluginsFrame([
      pluginInfoOf('probe-gone', {
        views: [{ id: 'probe-gone.panel', title: '探针面板', placement: 'drawer.tab' }],
      }),
    ]))
    // 灌入通路前置：帧到达后容器位在册（双实例成对）
    expectPluginSlotEverywhere('probe-gone.panel', 'drawer.tab', true)

    const builtinKeysBefore = drawerTabViews().filter((v) => v.source === 'builtin').map((v) => v.key)
    getExtensionBus().emit({ kind: 'plugin-status-change', pluginId: 'probe-gone', status: 'inactive' })

    // 验收①：清理后插件容器位消失（否则禁用插件后其容器位残留）
    expectPluginSlotEverywhere('probe-gone.panel', 'drawer.tab', false)
    // 内置项不受影响（注册表 host 保护）
    expect(drawerTabViews().filter((v) => v.source === 'builtin').map((v) => v.key)).toEqual(builtinKeysBefore)
  })

  it('U12-B（验收②）：active → 快照重放 external 声明（不发第二帧，容器位与贡献声明回来）', () => {
    const contributions = initBridgeWithSubscription()
    dispatchGlobal(pluginsFrame([
      pluginInfoOf('probe-back', {
        views: [{ id: 'probe-back.side', title: '侧栏面板', placement: 'sidebar.tab' }],
      }),
    ]))
    expectPluginSlotEverywhere('probe-back.side', 'sidebar.tab', true)
    expect(contributions.getContributions({ pluginId: 'probe-back' })).toHaveLength(1)

    // 禁用 → 全链清理（旧实现自此止步：active 只重放 builtin，external 声明等下一次广播）
    getExtensionBus().emit({ kind: 'plugin-status-change', pluginId: 'probe-back', status: 'inactive' })
    expectPluginSlotEverywhere('probe-back.side', 'sidebar.tab', false)
    expect(contributions.getContributions({ pluginId: 'probe-back' })).toEqual([])

    // 启用（模拟真实时序：statusChange(active) 先于下一次 config.plugins 广播到达）
    getExtensionBus().emit({ kind: 'plugin-status-change', pluginId: 'probe-back', status: 'active' })

    // 验收②：快照重放生效——无第二帧，external 声明与容器位即刻回来（此前只重放 builtin）
    expect(contributions.getContributions({ pluginId: 'probe-back' })).toHaveLength(1)
    expectPluginSlotEverywhere('probe-back.side', 'sidebar.tab', true)
  })

  it('U12-C（验收③）：禁用→启用后容器位回来且不残留已删 tab；正被选中的已删 tab 回退内置默认项', () => {
    initBridgeWithSubscription()
    // v1：插件带两个 drawer.tab 声明
    dispatchGlobal(pluginsFrame([
      pluginInfoOf('probe-cycle', {
        views: [
          { id: 'probe-cycle.tab-a', title: '面板A', placement: 'drawer.tab' },
          { id: 'probe-cycle.tab-b', title: '面板B', placement: 'drawer.tab' },
        ],
      }),
    ]))
    expectPluginSlotEverywhere('probe-cycle.tab-b', 'drawer.tab', true)

    // v2：声明收缩（插件新版本删除 tab-b）——帧驱动覆盖粒度 per pluginId，分区只剩 tab-a
    dispatchGlobal(pluginsFrame([
      pluginInfoOf('probe-cycle', {
        views: [{ id: 'probe-cycle.tab-a', title: '面板A', placement: 'drawer.tab' }],
      }),
    ]))
    expectPluginSlotEverywhere('probe-cycle.tab-a', 'drawer.tab', true)
    expectPluginSlotEverywhere('probe-cycle.tab-b', 'drawer.tab', false)

    // 禁用 → 启用（禁用期间用户分区选中值停在已删 tab 上）
    getExtensionBus().emit({ kind: 'plugin-status-change', pluginId: 'probe-cycle', status: 'inactive' })
    getExtensionBus().emit({ kind: 'plugin-status-change', pluginId: 'probe-cycle', status: 'active' })

    // 验收③：重放后容器位回来，且只含存活项——已删 tab 不残留（S8 前置）
    expectPluginSlotEverywhere('probe-cycle.tab-a', 'drawer.tab', true)
    expectPluginSlotEverywhere('probe-cycle.tab-b', 'drawer.tab', false)
    // 选中态行为断言（§11.1-1 断言 3）：分区值指向已删 tab → 生效 tab 回退内置默认项
    expect(effectiveDrawerTab('probe-cycle.tab-b')).toBe(builtinDefaultDrawerTab())
    // 存活项仍可被选中生效（回退只针对未命中项，不误伤重放回来的容器位）
    expect(effectiveDrawerTab('probe-cycle.tab-a')).toBe('probe-cycle.tab-a')
  })

  it('U12-D：enabled=false 帧不灌入不注册（堵「禁用清理被 toggle 广播帧复活」）；重放信任 active 事件不看快照 enabled 位', () => {
    const contributions = initBridgeWithSubscription()
    // 禁用插件的帧（真实形态：togglePlugin 广播全量列表，mapper 无条件透传 contributes）
    dispatchGlobal(pluginsFrame([
      pluginInfoOf('probe-off', {
        views: [{ id: 'probe-off.panel', title: '停用面板', placement: 'drawer.tab' }],
      }, false),
    ]))
    // 过滤生效：声明不进容器位注册表、不喂 bootstrap 订阅回调
    expectPluginSlotEverywhere('probe-off.panel', 'drawer.tab', false)
    expect(contributions.getContributions({ pluginId: 'probe-off' })).toEqual([])

    // 启用时序：statusChange(active) 先到（此刻快照仍是 enabled=false 帧）——重放必须
    // 信任事件而非快照 enabled 位，否则启用后容器位要等下一次广播才回来
    getExtensionBus().emit({ kind: 'plugin-status-change', pluginId: 'probe-off', status: 'active' })
    expectPluginSlotEverywhere('probe-off.panel', 'drawer.tab', true)
    expect(contributions.getContributions({ pluginId: 'probe-off' })).toHaveLength(1)
  })

  it('U12-E：快照缺失时 handlePluginBack 不 throw——builtin 照常重放，external 声明待下一次广播', () => {
    const contributions = initBridgeWithSubscription()
    // 无任何 config.plugins 帧（快照为空）直接启用事件
    expect(() =>
      getExtensionBus().emit({ kind: 'plugin-status-change', pluginId: 'never-seen', status: 'active' }),
    ).not.toThrow()
    // builtin 静态表重放不受影响（scheduler-manager 的 headerAction 内置声明在册）
    expect(contributions.getContributions({ type: 'headerAction', pluginId: 'scheduler-manager' })).toHaveLength(1)
    expect(contributions.getContributions({ pluginId: 'never-seen' })).toEqual([])
  })

  it('U12-F：crashed 走同一清理链（plugin-crashed 事件 → 容器位消失）', () => {
    initBridgeWithSubscription()
    dispatchGlobal(pluginsFrame([
      pluginInfoOf('probe-crash', {
        views: [{ id: 'probe-crash.panel', title: '崩溃面板', placement: 'drawer.tab' }],
      }),
    ]))
    expectPluginSlotEverywhere('probe-crash.panel', 'drawer.tab', true)
    getExtensionBus().emit({ kind: 'plugin-crashed', pluginId: 'probe-crash' })
    expectPluginSlotEverywhere('probe-crash.panel', 'drawer.tab', false)
  })
})
