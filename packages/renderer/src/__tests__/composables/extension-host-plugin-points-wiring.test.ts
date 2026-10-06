// @vitest-environment node

/**
 * useExtensionHostBridge 接线测试（plugin-header-action-modal-points u4b）。
 *
 * renderer 侧断言新帧的订阅链存在（core 侧 PLUGIN_HANDLERS 表项与丢帧行为由
 * core message-bus-bridge.test.ts 承担，此处补 renderer 消费链）：
 * - plugin:headerActionUpdate → HeaderActionStore reactive 分区（provide source 消费）
 * - 未知帧型 → error 事件出声（禁静默丢帧，bridge ERR2 契约的 renderer 复核）
 * - E2 触发链：plugin-crashed / plugin-status-change(inactive) → 声明镜像清 +
 *   命令注销；active → registerBuiltin 静态表重放（按钮恢复）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/extension-host-plugin-points-wiring.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, inject, nextTick } from 'vue'
import {
  InternalEventBus,
  MessageBusBridge,
  type IncomingPluginMessage,
  type PluginMessageSource,
} from '@taiji/core'
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

  it('丢帧出声（renderer 复核）：bridge 对新帧 emit 对应事件、未知 type emit error', () => {
    const bus = new InternalEventBus()
    const seen: string[] = []
    bus.on('plugin:headerActionUpdate', () => seen.push('headerActionUpdate'))
    bus.on('error', () => seen.push('error'))
    let handler: ((msg: IncomingPluginMessage) => void) | null = null
    const source: PluginMessageSource = { subscribe: (h) => { handler = h; return () => { handler = null } } }
    new MessageBusBridge({ source, bus })
    handler!({ type: 'plugin:headerActionUpdate', payload: { pluginId: 'p1', headerActionId: 'p1.open', sessionId: 's1' } })
    expect(seen).toEqual(['headerActionUpdate'])
    handler!({ type: 'plugin:notRegisteredAnywhere', payload: {} })
    expect(seen).toEqual(['headerActionUpdate', 'error'])
  })

  it('E2：crashed → 声明镜像清；active → registerBuiltin 静态表重放（按钮恢复）', async () => {
    const { bus, contributions } = initBridge()
    // bootstrap step5 等价：builtin 声明注册（含 scheduler-manager）
    contributions.registerBuiltin()
    expect(contributions.getContributions({ type: 'headerAction', pluginId: 'scheduler-manager' })).toHaveLength(1)

    bus.emit({ kind: 'plugin-crashed', pluginId: 'scheduler-manager' })
    await nextTick()
    // E2：headerAction 声明消失（按钮消失）
    expect(contributions.getContributions({ type: 'headerAction' })).toEqual([])

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
