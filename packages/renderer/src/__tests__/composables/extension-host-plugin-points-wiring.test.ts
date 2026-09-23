/**
 * useExtensionHostBridge 接线测试（plugin-header-action-modal-points u4b）。
 *
 * renderer 侧断言两条新帧的订阅链存在（core 侧 PLUGIN_HANDLERS 表项与丢帧行为由
 * core message-bus-bridge.test.ts 承担，此处补 renderer 消费链）：
 * - plugin:modalState → plugin-modal-slot 槽镜像（subscribePluginModalSlot）
 * - plugin:headerActionUpdate → HeaderActionStore reactive 分区（provide source 消费）
 * - 未知帧型 → error 事件出声（禁静默丢帧，bridge ERR2 契约的 renderer 复核）
 * - modalState closed → ViewHostStore 分区清理（AP-2 开帧残留治理）
 * - E2 触发链：plugin-crashed / plugin-status-change(inactive) → 声明镜像清 + 槽清 +
 *   命令注销；active → registerBuiltin 静态表重放（按钮恢复）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/extension-host-plugin-points-wiring.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, inject, nextTick } from 'vue'
import {
  getPluginModalSlot,
  resetPluginModalSlot,
  InternalEventBus,
  MessageBusBridge,
  type IncomingPluginMessage,
  type PluginMessageSource,
} from '@taiji/core'
import { VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'
// commandStore 依赖 getPlatform().storage（bridge 测试不注入平台端口），stub 掉判定输入
vi.mock('@/composables/features/command/useCommandStore', () => ({
  useCommandStore: () => ({ getCommands: () => [] as Array<{ name: string }> }),
}))

import {
  getExtensionBus,
  initExtensionHostBridge,
  __testing,
  HEADER_ACTIONS_SOURCE_KEY,
  type HeaderActionsSource,
} from '@/composables/shell/useExtensionHostBridge'

beforeEach(() => {
  setActivePinia(createPinia())
  resetPluginModalSlot()
  vi.clearAllMocks()
})

function initBridge() {
  const app = createApp({ render: () => null })
  initExtensionHostBridge(app)
  const handles = __testing.lastInitHandles
  if (!handles) throw new Error('initExtensionHostBridge did not record handles')
  return { app, bus: getExtensionBus(), contributions: handles.contributions }
}

describe('useExtensionHostBridge plugin points wiring (u4b)', () => {
  it('订阅链：plugin:modalState open 帧 → 槽镜像更新（层开合真值消费链存在）', () => {
    const { bus } = initBridge()
    bus.emit({
      kind: 'plugin:modalState',
      modalState: { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'open', epoch: 1 },
    })
    expect(getPluginModalSlot()).toMatchObject({ pluginId: 'p1', modalId: 'm1', epoch: 1 })
    bus.emit({
      kind: 'plugin:modalState',
      modalState: { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'closed', epoch: 1, reason: 'dismissed' },
    })
    expect(getPluginModalSlot()).toBeNull()
  })

  it('订阅链：plugin:headerActionUpdate 帧 → per-session 分区镜像（provide source 消费）', () => {
    const { app, bus } = initBridge()
    bus.emit({
      kind: 'plugin:headerActionUpdate',
      headerAction: { pluginId: 'scheduler-manager', headerActionId: 'scheduler-manager.open', sessionId: 's1', badge: '7', disabled: false },
    })
    const source = app.runWithContext(() => inject(HEADER_ACTIONS_SOURCE_KEY)) as HeaderActionsSource
    expect(source).not.toBeNull()
    expect(source.getRuntimeState('s1', 'scheduler-manager.open')?.badge).toBe('7')
    expect(source.getRuntimeState('s2', 'scheduler-manager.open')).toBeUndefined()
  })

  it('丢帧出声（renderer 复核）：bridge 对两条新帧 emit 对应事件、未知 type emit error', () => {
    const bus = new InternalEventBus()
    const seen: string[] = []
    bus.on('plugin:modalState', () => seen.push('modalState'))
    bus.on('plugin:headerActionUpdate', () => seen.push('headerActionUpdate'))
    bus.on('error', () => seen.push('error'))
    let handler: ((msg: IncomingPluginMessage) => void) | null = null
    const source: PluginMessageSource = { subscribe: (h) => { handler = h; return () => { handler = null } } }
    new MessageBusBridge({ source, bus })
    handler!({ type: 'plugin:modalState', payload: { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'open', epoch: 1 } })
    handler!({ type: 'plugin:headerActionUpdate', payload: { pluginId: 'p1', headerActionId: 'p1.open', sessionId: 's1' } })
    expect(seen).toEqual(['modalState', 'headerActionUpdate'])
    handler!({ type: 'plugin:notRegisteredAnywhere', payload: {} })
    expect(seen).toEqual(['modalState', 'headerActionUpdate', 'error'])
  })

  it('AP-2 开帧残留治理：closed 帧 → 清对应 (sessionId, viewId) ViewHostStore 分区', () => {
    const { app, bus } = initBridge()
    // 插件推树（plugin:viewUpdate → extension-widget 事件，桥接同 core bridge 生产行为）
    bus.emit({
      kind: 'extension-widget',
      sessionId: 's1',
      widget: {
        viewId: 'modal-p1-m1',
        pluginId: 'p1',
        guiTree: [{ type: 'ansi-text', props: { lines: ['row'] } }],
      },
    })
    const viewSource = app.runWithContext(() => inject(VIEW_HOST_SOURCE_KEY)) as {
      getView(sessionId: string, viewId: string): unknown
    }
    expect(viewSource.getView('s1', 'modal-p1-m1')).toBeDefined()
    bus.emit({
      kind: 'plugin:modalState',
      modalState: { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'closed', epoch: 2, reason: 'dismissed' },
    })
    // 重开首帧为空白（宁缺勿错）
    expect(viewSource.getView('s1', 'modal-p1-m1')).toBeUndefined()
  })

  it('E2：crashed → 声明镜像清 + 槽清；active → registerBuiltin 静态表重放（按钮恢复）', async () => {
    const { bus, contributions } = initBridge()
    // bootstrap step5 等价：builtin 声明注册（含 scheduler-manager）
    contributions.registerBuiltin()
    bus.emit({
      kind: 'plugin:modalState',
      modalState: { pluginId: 'scheduler-manager', modalId: 'scheduler-manager.panel', sessionId: 's1', state: 'open', epoch: 1 },
    })
    expect(getPluginModalSlot()).not.toBeNull()

    bus.emit({ kind: 'plugin-crashed', pluginId: 'scheduler-manager' })
    await nextTick()
    // E2：headerAction 声明消失（按钮消失）+ modal 槽清空（层关闭 reason=plugin-gone 语义）
    expect(contributions.getContributions({ type: 'headerAction' })).toEqual([])
    expect(getPluginModalSlot()).toBeNull()

    // 用户重启用 → 静态表重放（registerBuiltin），按钮回来
    bus.emit({ kind: 'plugin-status-change', pluginId: 'scheduler-manager', status: 'active' })
    await nextTick()
    const restored = contributions.getContributions({ type: 'headerAction', pluginId: 'scheduler-manager' })
    expect(restored.map((c) => c.contributionId)).toEqual(['scheduler-manager.open'])
  })

  it('E2：statusChange inactive（禁用）→ 声明清 + 命令注销（E13 灰置的清理侧）', () => {
    const { bus, contributions } = initBridge()
    contributions.registerBuiltin()
    bus.emit({ kind: 'plugin-status-change', pluginId: 'scheduler-manager', status: 'inactive' })
    expect(contributions.getContributions({ type: 'command', pluginId: 'scheduler-manager' })).toEqual([])
    expect(contributions.getContributions({ type: 'modal', pluginId: 'scheduler-manager' })).toEqual([])
  })

  it('E3 执行面：provide source.executeCommand 对缺失命令返回 false（CommandRegistry emit error 出声）', () => {
    const { app, bus } = initBridge()
    const errors: string[] = []
    bus.on('error', (e) => errors.push(e.message))
    const source = app.runWithContext(() => inject(HEADER_ACTIONS_SOURCE_KEY)) as HeaderActionsSource
    expect(source.executeCommand('scheduler-manager.not-registered')).toBe(false)
    expect(errors.some((m) => m.includes('scheduler-manager.not-registered'))).toBe(true)
  })
})
