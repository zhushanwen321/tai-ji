/**
 * usePermissionRequest.test.ts —— permissionRequest 闭环单测（MF-9 补测）。
 *
 * 覆盖闭环（bus 订阅 → reactive state → transport 回传 → pending 重置）：
 *  - TC1: plugin-permission-request 事件 → state 更新（pluginId/permissions/pending=true）
 *  - TC2: approve 成功 → pending=false（弹窗关闭）
 *  - TC3: approve 失败（RPC reject）→ pending=false（错误路径重置，项目规则#3 状态卡死防护）
 *  - TC4: revoke 成功/失败 → pending=false
 *  - TC5: 重复初始化幂等（HMR 防 listener 翻倍）：bus.on 只注册一次 handler
 *  - TC6-TC8: plugin:permissionRequestExpired 超时撤窗（timeout-plugin-service D3，
 *    取消非判拒）：命中撤回 / pluginId 不匹配 noop / 无挂起 noop 幂等
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/shell/__tests__/usePermissionRequest.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InternalEventBus } from '@taiji/core'
import type { InternalEvent } from '@taiji/core'
import { initPermissionRequest, usePermissionRequest } from '../usePermissionRequest'
import { PERMISSION_TRANSPORT_KEY } from '@taiji/ui/extension-host'
import { dispatchGlobal } from '@taiji/core/transport/api'

// mock RPC 回传域（approve/revoke 走 command → ws-client，测试环境不连 WS）
const approvePermissions = vi.fn()
const revokePermissions = vi.fn()
vi.mock('@taiji/core/transport/api/domains/plugin', () => ({
  approvePermissions: (...args: unknown[]) => approvePermissions(...args),
  revokePermissions: (...args: unknown[]) => revokePermissions(...args),
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

describe('usePermissionRequest permissionRequest 闭环', () => {
  let bus: InternalEventBus

  beforeEach(() => {
    vi.restoreAllMocks()
    approvePermissions.mockReset()
    revokePermissions.mockReset()
    bus = new InternalEventBus()
  })

  it('TC1: plugin-permission-request 事件 → reactive state 更新（pluginId/permissions/pending=true）', () => {
    const { app } = makeApp()
    initPermissionRequest(app as never, bus)

    emitPermissionRequest(bus, 'tasks', ['shell', 'fs'])

    const state = usePermissionRequest()
    expect(state.pluginId).toBe('tasks')
    expect(state.permissions).toEqual(['shell', 'fs'])
    expect(state.pending).toBe(true)
  })

  it('TC2: approve 成功 → pending=false（弹窗关闭）', async () => {
    const { app, provided } = makeApp()
    initPermissionRequest(app as never, bus)
    const transport = provided.find((p) => p.key === PERMISSION_TRANSPORT_KEY)?.value as {
      approve: (pluginId: string, permissions: string[]) => void
      revoke: (pluginId: string) => void
    }

    emitPermissionRequest(bus)
    const state = usePermissionRequest()
    expect(state.pending).toBe(true)

    approvePermissions.mockResolvedValue(undefined)
    transport.approve('p1', ['shell'])
    await vi.waitFor(() => expect(state.pending).toBe(false))
    expect(approvePermissions).toHaveBeenCalledWith('p1', ['shell'])
  })

  it('TC3: approve 失败（RPC reject）→ pending=false（错误路径重置，防状态卡死）', async () => {
    const { app, provided } = makeApp()
    initPermissionRequest(app as never, bus)
    const transport = provided.find((p) => p.key === PERMISSION_TRANSPORT_KEY)?.value as {
      approve: (pluginId: string, permissions: string[]) => void
    }

    emitPermissionRequest(bus)
    const state = usePermissionRequest()
    expect(state.pending).toBe(true)

    approvePermissions.mockRejectedValue(new Error('rpc boom'))
    transport.approve('p1', ['shell'])
    await vi.waitFor(() => expect(state.pending).toBe(false))
  })

  it('TC4: revoke 成功 + 失败 → pending=false', async () => {
    const { app, provided } = makeApp()
    initPermissionRequest(app as never, bus)
    const transport = provided.find((p) => p.key === PERMISSION_TRANSPORT_KEY)?.value as {
      revoke: (pluginId: string) => void
    }

    emitPermissionRequest(bus)
    const state = usePermissionRequest()

    // 成功路径
    revokePermissions.mockResolvedValue(undefined)
    transport.revoke('p1')
    await vi.waitFor(() => expect(state.pending).toBe(false))
    expect(revokePermissions).toHaveBeenCalledWith('p1')

    // 失败路径（新请求触发 pending=true 后 revoke reject）
    emitPermissionRequest(bus)
    expect(state.pending).toBe(true)
    revokePermissions.mockRejectedValue(new Error('rpc boom'))
    transport.revoke('p1')
    await vi.waitFor(() => expect(state.pending).toBe(false))
  })

  it('TC5: 重复初始化幂等（HMR 防 listener 翻倍）：bus handler 数恒为 1', () => {
    const { app } = makeApp()

    initPermissionRequest(app as never, bus)
    initPermissionRequest(app as never, bus)

    // 白盒验证幂等本质：第二次 init 先调旧 unsub（退订）再注册新 handler——
    // bus 内 plugin-permission-request 的 handler 数恒为 1（不翻倍，项目规则#2）。
    const handlers = (bus as unknown as { handlers: Map<string, Set<unknown>> }).handlers
    expect(handlers.get('plugin-permission-request')?.size).toBe(1)

    // 行为验证：事件仍正常驱动 state
    emitPermissionRequest(bus)
    const state = usePermissionRequest()
    expect(state.pluginId).toBe('p1')
    expect(state.pending).toBe(true)
  })

  // ── plugin:permissionRequestExpired 超时撤窗（timeout-plugin-service D3） ──

  /** 通过 global 通道模拟 runtime 撤窗广播（payload { pluginId }，无 sessionId） */
  function emitPermissionExpired(pluginId: string) {
    dispatchGlobal({ type: 'plugin:permissionRequestExpired', payload: { pluginId } })
  }

  it('TC6: expired 广播命中当前弹窗 → pending=false（超时撤窗，取消非判拒）', () => {
    const { app } = makeApp()
    initPermissionRequest(app as never, bus)

    emitPermissionRequest(bus, 'p1', ['shell'])
    const state = usePermissionRequest()
    expect(state.pending).toBe(true)

    emitPermissionExpired('p1')
    expect(state.pending).toBe(false)
  })

  it('TC7: expired 广播 pluginId 不匹配 → noop（陈旧广播不得误撤后到插件的新审批弹窗）', () => {
    const { app } = makeApp()
    initPermissionRequest(app as never, bus)

    emitPermissionRequest(bus, 'p2', ['fs'])
    const state = usePermissionRequest()
    expect(state.pending).toBe(true)

    // 旧插件 p1 的迟到 expired 广播：当前弹窗属于 p2，不应被撤
    emitPermissionExpired('p1')
    expect(state.pending).toBe(true)
    expect(state.pluginId).toBe('p2')

    // p2 自己的 expired 才撤
    emitPermissionExpired('p2')
    expect(state.pending).toBe(false)
  })

  it('TC8: 无挂起弹窗时 expired 广播 → noop 幂等（迟到批准对已删 pending noop 的前端对称面）', () => {
    const { app } = makeApp()
    initPermissionRequest(app as never, bus)

    const state = usePermissionRequest()
    expect(state.pending).toBe(false)
    emitPermissionExpired('p1')
    expect(state.pending).toBe(false)
  })
})
