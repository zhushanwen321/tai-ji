/**
 * usePermissionRequest.test.ts —— 桌面壳装配薄接线 smoke。
 *
 * 状态机本体（畸形事件守卫 / permissions 拷贝 / BM3 失败保持 / D3 expired 撤窗 /
 * 新请求覆盖）单测在 packages/ui extension-host
 * __tests__/permission-request-controller.test.ts（双壳共享 factory）。本文件只钉
 * 桌面壳装配契约：
 *  - TC0: init 前调 usePermissionRequest() → fail-fast（装配时序错误显形，不静默）
 *  - TC1: init → app.provide(PERMISSION_TRANSPORT_KEY) 注入 factory transport 且与
 *    usePermissionRequest() state 同源（transport 回传驱动 state 收口）
 *  - TC2: 重复初始化幂等（HMR 防 listener 翻倍）：bus handler 数恒 1
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/shell/__tests__/usePermissionRequest.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InternalEventBus } from '@taiji/core'
import type { InternalEvent } from '@taiji/core'
import { initPermissionRequest, usePermissionRequest } from '../usePermissionRequest'
import { PERMISSION_TRANSPORT_KEY, type PermissionTransport } from '@taiji/ui/extension-host'

// mock RPC 回传域（approve/deny 走 command → ws-client，测试环境不连 WS）
const approvePermissions = vi.fn()
vi.mock('@taiji/core/transport/api/domains/plugin', () => ({
  approvePermissions: (...args: unknown[]) => approvePermissions(...args),
  denyPermissions: () => Promise.resolve(),
}))

/** 通过 bus.emit 模拟 bridge 归一后的 permission 事件 */
function emitPermissionRequest(bus: InternalEventBus, pluginId = 'p1', permissions = ['shell']) {
  bus.emit({
    kind: 'plugin-permission-request',
    request: { pluginId, permissions, requestId: `perm_${pluginId}` },
  } as InternalEvent)
}

/** 收集 app.provide 调用（对齐 useExtensionHostBridge.test.ts TC10 范式） */
function makeApp() {
  const provided: Array<{ key: unknown; value: unknown }> = []
  const app = {
    provide(key: unknown, value: unknown) {
      provided.push({ key, value })
      return app
    },
  }
  return { provided, app }
}

describe('usePermissionRequest 桌面壳装配薄接线', () => {
  let bus: InternalEventBus

  beforeEach(() => {
    approvePermissions.mockReset()
    bus = new InternalEventBus()
  })

  it('TC0: init 前调 usePermissionRequest() → fail-fast（装配时序错误指向恢复动作，不静默返回空 state）', () => {
    expect(() => usePermissionRequest()).toThrow(/initPermissionRequest/)
  })

  it('TC1: init → provide 注入 factory transport，与 usePermissionRequest() state 同源（回传驱动收口）', async () => {
    const { app, provided } = makeApp()
    initPermissionRequest(app as never, bus)

    // provide 契约：PERMISSION_TRANSPORT_KEY 下注入 transport
    const transport = provided.find((p) => p.key === PERMISSION_TRANSPORT_KEY)?.value as PermissionTransport

    emitPermissionRequest(bus, 'tasks', ['shell', 'fs'])
    const state = usePermissionRequest()
    expect(state.pluginId).toBe('tasks')
    expect(state.pending).toBe(true)

    // 同源验证：provide 的 transport 回传成功 → usePermissionRequest() state 收口
    approvePermissions.mockResolvedValue(undefined)
    transport.approve('tasks', ['shell'])
    await vi.waitFor(() => expect(state.pending).toBe(false))
    expect(approvePermissions).toHaveBeenCalledWith('tasks', ['shell'])
  })

  it('TC2: 重复初始化幂等（HMR 防 listener 翻倍）：bus handler 数恒为 1', () => {
    const { app } = makeApp()

    initPermissionRequest(app as never, bus)
    initPermissionRequest(app as never, bus)

    // 白盒验证幂等本质：第二次 init 先 dispose 旧 controller（退订）再建新——
    // bus 内 plugin-permission-request 的 handler 数恒为 1（不翻倍，项目规则#2）。
    const handlers = (bus as unknown as { handlers: Map<string, Set<unknown>> }).handlers
    expect(handlers.get('plugin-permission-request')?.size).toBe(1)

    // 行为验证：事件驱动的是第二次 init 后的 state（旧 controller 已 dispose）
    emitPermissionRequest(bus)
    const state = usePermissionRequest()
    expect(state.pluginId).toBe('p1')
    expect(state.pending).toBe(true)
  })
})
