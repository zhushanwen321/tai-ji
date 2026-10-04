/**
 * permission-request-controller.test.ts —— 权限审批编排状态机 factory 单测
 * （双壳共享本体，自两壳状态机用例收敛：桌面 usePermissionRequest.test.ts +
 * 移动 mobile-permission.spec.ts 的状态机用例平移至此，两壳只留装配 smoke）。
 *
 * 覆盖（行为不变量逐条钉住）：
 *  - TC1 正常事件 → state 弹窗（pending/error/pluginId/permissions）+ permissions
 *    拷贝防串改（emit 后外部数组变更不串入 state）
 *  - TC2 畸形事件守卫 warn+skip：空 pluginId / permissions 非数组 / 非字符串项
 *    均不写 state，后续合法事件照常（不毒害状态）
 *  - TC3 新请求覆盖旧弹窗：error 清零 + pluginId/permissions 全量重置
 *  - TC4 approve 成功收口 / 失败 BM3（pending 保持 true + error=true）+ 重试成功
 *  - TC5 deny 走 denyPermissions（拒绝本次申请）：成功/失败同构收口
 *  - TC6/TC7 expired 超时撤窗（D3，取消非判拒）：命中撤回（含清 error）/
 *    pluginId 不匹配 noop（陈旧广播）/ 无挂起 noop 幂等
 *  - TC8 dispose 退订：bus 事件与 expired 广播均不再驱动 state
 *  - TC9/TC10 expired 按 requestId 精确匹配：同 pluginId 先后两单，前单陈旧
 *    expired 广播只在其 requestId 命中时撤回（不误撤后到弹窗）；payload 缺
 *    requestId（旧版广播）回退按 pluginId 匹配
 *  - TC11/TC12 resolved 终局撤窗（S5-V3，bridge 归一 bus 事件）：按 requestId
 *    精确撤回（多连接端中非操作端撤窗）；requestId 空串（bridge 对旧版广播的宽容
 *    窄化产物）回退按 pluginId 匹配；陈旧 resolved 不误撤后到弹窗
 *  - TC8/TC13 dispose 退订：request/expired/resolved 三订阅 dispose 后均不再驱动
 *    state（断言先置 pending=true 再 dispose，防终局态下泄漏恒 noop 的空洞证明）
 *
 * 策略：真实 InternalEventBus（bus.emit）+ dispatchGlobal（events 通道，对齐
 * shell-adapters.test.ts 全链路范式）；plugin 域 vi.mock 隔离 WS（断言回传形状）。
 *
 * 运行：cd packages/ui && npx vitest run src/extension-host/__tests__/permission-request-controller.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InternalEventBus } from '@taiji/core'
import type { InternalEvent } from '@taiji/core'
import { dispatchGlobal } from '@taiji/core/transport/api'

// mock RPC 回传域（approve/deny 走 command → ws-client，测试环境不连 WS）
const approvePermissions = vi.fn()
const denyPermissions = vi.fn()
vi.mock('@taiji/core/transport/api/domains/plugin', () => ({
  approvePermissions: (...args: unknown[]) => approvePermissions(...args),
  denyPermissions: (...args: unknown[]) => denyPermissions(...args),
}))

import {
  createPermissionRequestController,
  type PermissionRequestController,
} from '../permission-request-controller'

/** 通过 bus.emit 模拟 bridge 归一后的 permission 事件（requestId 默认合成形态） */
function emitPermissionRequest(
  bus: InternalEventBus,
  pluginId = 'p1',
  permissions: string[] = ['shell'],
  requestId = `perm_${pluginId}`,
): void {
  bus.emit({
    kind: 'plugin-permission-request',
    request: { pluginId, permissions, requestId },
  } as InternalEvent)
}

/** 通过 global 通道模拟 runtime 撤窗广播（payload { pluginId }，无 sessionId） */
function emitExpired(pluginId: string, requestId?: string): void {
  dispatchGlobal({
    type: 'plugin:permissionRequestExpired',
    payload: { pluginId, ...(requestId !== undefined ? { requestId } : {}) },
  })
}

/** 通过 bus.emit 模拟 bridge 归一后的 resolved 终局事件（S5-V3；requestId 空串 = 旧版广播窄化形态） */
function emitResolved(
  bus: InternalEventBus,
  pluginId: string,
  requestId: string,
  approved = true,
): void {
  bus.emit({
    kind: 'plugin-permission-request-resolved',
    resolved: { pluginId, requestId, approved },
  } as InternalEvent)
}

describe('createPermissionRequestController 状态机（双壳共享）', () => {
  let bus: InternalEventBus
  let controller: PermissionRequestController

  beforeEach(() => {
    approvePermissions.mockReset()
    denyPermissions.mockReset()
    bus = new InternalEventBus()
    controller = createPermissionRequestController(bus)
  })

  afterEach(() => {
    controller.dispose()
  })

  it('TC1: 正常事件 → state 弹窗（pluginId/permissions/pending=true/error=false）；permissions 拷贝防串改', () => {
    const shared: string[] = ['fs.read', 'net.http']
    emitPermissionRequest(bus, 'tasks', shared)

    expect(controller.state.pluginId).toBe('tasks')
    expect(controller.state.permissions).toEqual(['fs.read', 'net.http'])
    expect(controller.state.pending).toBe(true)
    expect(controller.state.error).toBe(false)

    // 拷贝防串扰：emit 后外部数组变更不串入 state
    shared.push('later-mutation')
    expect(controller.state.permissions).toEqual(['fs.read', 'net.http'])
  })

  it('TC2: 畸形事件守卫 warn+skip：空 pluginId / permissions 非数组 / 非字符串项 均不写 state，后续合法事件照常', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 空 pluginId
      emitPermissionRequest(bus, '', ['fs.read'])
      expect(controller.state.pending).toBe(false)

      // permissions 非数组（测试注入坏形状，受控 cast）
      bus.emit({
        kind: 'plugin-permission-request',
        request: { pluginId: 'p1', permissions: 'fs.read' as unknown as string[], requestId: 'r' },
      } as InternalEvent)
      expect(controller.state.pending).toBe(false)

      // permissions 含非字符串项
      bus.emit({
        kind: 'plugin-permission-request',
        request: { pluginId: 'p1', permissions: ['ok', 42 as unknown as string], requestId: 'r' },
      } as InternalEvent)
      expect(controller.state.pending).toBe(false)
      expect(controller.state.pluginId).toBe('')

      expect(warnSpy).toHaveBeenCalledTimes(3)

      // 守卫只 skip 不毒害状态：合法事件照常弹出
      emitPermissionRequest(bus, 'p2', ['fs.read'])
      expect(controller.state.pending).toBe(true)
      expect(controller.state.pluginId).toBe('p2')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('TC3: 新请求覆盖旧弹窗：error 清零 + pluginId/permissions 全量重置（上一单失败错误态不残留）', async () => {
    // 先制造失败错误态（BM3）
    emitPermissionRequest(bus, 'p1', ['shell'])
    denyPermissions.mockRejectedValue(new Error('rpc boom'))
    controller.transport.deny('p1')
    await vi.waitFor(() => expect(controller.state.error).toBe(true))
    expect(controller.state.pending).toBe(true)

    // 新请求覆盖：error 清零，pluginId/permissions 换新
    emitPermissionRequest(bus, 'p2', ['fs.read', 'net.http'])
    expect(controller.state.error).toBe(false)
    expect(controller.state.pending).toBe(true)
    expect(controller.state.pluginId).toBe('p2')
    expect(controller.state.permissions).toEqual(['fs.read', 'net.http'])
  })

  it('TC4: approve 成功 → pending=false + error=false；失败 → pending 保持 true + error=true（BM3），重试成功收口', async () => {
    emitPermissionRequest(bus)
    approvePermissions.mockResolvedValue(undefined)
    controller.transport.approve('p1', ['shell'])
    await vi.waitFor(() => expect(controller.state.pending).toBe(false))
    expect(controller.state.error).toBe(false)
    expect(approvePermissions).toHaveBeenCalledWith('p1', ['shell'])

    // 失败路径（BM3 假成功红线）：弹窗保持打开 + 错误显形
    emitPermissionRequest(bus)
    approvePermissions.mockRejectedValue(new Error('rpc boom'))
    controller.transport.approve('p1', ['shell'])
    await vi.waitFor(() => expect(controller.state.error).toBe(true))
    expect(controller.state.pending).toBe(true)

    // 重试成功 → 正常收口
    approvePermissions.mockResolvedValue(undefined)
    controller.transport.approve('p1', ['shell'])
    await vi.waitFor(() => expect(controller.state.pending).toBe(false))
    expect(controller.state.error).toBe(false)
  })

  it('TC5: deny 走 denyPermissions（拒绝本次申请）：成功 pending=false；失败 pending 保持 true + error=true（BM3）', async () => {
    emitPermissionRequest(bus)
    denyPermissions.mockResolvedValue(undefined)
    controller.transport.deny('p1')
    await vi.waitFor(() => expect(controller.state.pending).toBe(false))
    expect(denyPermissions).toHaveBeenCalledWith('p1')
    expect(controller.state.error).toBe(false)

    // 失败路径：弹窗保持打开 + 错误显形
    emitPermissionRequest(bus)
    denyPermissions.mockRejectedValue(new Error('rpc boom'))
    controller.transport.deny('p1')
    await vi.waitFor(() => expect(controller.state.error).toBe(true))
    expect(controller.state.pending).toBe(true)
  })

  it('TC6: expired 命中当前弹窗（pluginId 匹配）→ pending=false + error=false（超时撤窗连错误行一起清）', async () => {
    emitPermissionRequest(bus, 'p1')
    // 先制造失败错误态，再撤窗——弹窗都撤了，错误无载体
    denyPermissions.mockRejectedValue(new Error('rpc boom'))
    controller.transport.deny('p1')
    await vi.waitFor(() => expect(controller.state.error).toBe(true))

    emitExpired('p1')
    expect(controller.state.pending).toBe(false)
    expect(controller.state.error).toBe(false)
  })

  it('TC7: expired pluginId 不匹配 → noop（陈旧广播不误撤新插件弹窗）；无挂起 → noop 幂等', () => {
    emitPermissionRequest(bus, 'p2')

    // 旧插件 p1 的迟到 expired 广播：当前弹窗属于 p2，不应被撤
    emitExpired('p1')
    expect(controller.state.pending).toBe(true)
    expect(controller.state.pluginId).toBe('p2')

    // p2 自己的 expired 才撤
    emitExpired('p2')
    expect(controller.state.pending).toBe(false)

    // 无挂起弹窗时再收 → noop 幂等
    emitExpired('p2')
    expect(controller.state.pending).toBe(false)
  })

  it('TC8: dispose 退订：bus 事件与 expired 广播均不再驱动 state', () => {
    // 先置 pending=true（弹窗在场）再 dispose——终局态（pending=false）下 expired 泄漏是恒 noop，测不出退订
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    expect(controller.state.pending).toBe(true)

    controller.dispose()

    // offRequest 退订锚：泄漏时新请求会覆盖 state（pluginId/requestId 被改写）
    emitPermissionRequest(bus, 'p2', ['fs.read'], 'req-b')
    expect(controller.state.pending).toBe(true)
    expect(controller.state.pluginId).toBe('p1')
    expect(controller.state.requestId).toBe('req-a')

    // offExpired 退订锚：泄漏时命中形态（同 pluginId 同 requestId）的 expired 广播会误撤窗
    emitExpired('p1', 'req-a')
    expect(controller.state.pending).toBe(true)
  })

  it('TC9: 同 pluginId 先后两单，expired 按 requestId 精确撤回——前单陈旧广播不误撤后到弹窗', () => {
    // 同插件 p1 的两次审批请求先后到达（弹窗全局单例，后者覆盖前者）
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    expect(controller.state.pending).toBe(true)
    expect(controller.state.requestId).toBe('req-a')
    emitPermissionRequest(bus, 'p1', ['net.http'], 'req-b')
    expect(controller.state.requestId).toBe('req-b')

    // 前单 req-a 的陈旧 expired 广播迟到：requestId 不匹配当前弹窗 → noop 不误撤
    emitExpired('p1', 'req-a')
    expect(controller.state.pending).toBe(true)
    expect(controller.state.requestId).toBe('req-b')

    // 当前单 req-b 的 expired 才撤
    emitExpired('p1', 'req-b')
    expect(controller.state.pending).toBe(false)

    // 撤回后同 pluginId 再收 expired → noop 幂等
    emitExpired('p1', 'req-b')
    expect(controller.state.pending).toBe(false)
  })

  it('TC10: expired payload 缺 requestId（旧版广播）→ 回退按 pluginId 匹配撤回', () => {
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    emitExpired('p1')
    expect(controller.state.pending).toBe(false)
  })

  it('TC11: resolved 按 requestId 精确撤回——同 pluginId 先后两单，前单陈旧 resolved 不误撤后到弹窗；命中时连错误行一起清', async () => {
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    emitPermissionRequest(bus, 'p1', ['net.http'], 'req-b')

    // 前单 req-a 的陈旧 resolved（A 端对旧弹窗的批准广播迟到）：requestId 不匹配 → noop
    emitResolved(bus, 'p1', 'req-a', true)
    expect(controller.state.pending).toBe(true)
    expect(controller.state.requestId).toBe('req-b')

    // 当前单 req-b 的 resolved 命中撤回；先制造错误态再撤（弹窗都撤了，错误无载体）
    denyPermissions.mockRejectedValue(new Error('rpc boom'))
    controller.transport.deny('p1')
    await vi.waitFor(() => expect(controller.state.error).toBe(true))
    emitResolved(bus, 'p1', 'req-b', true)
    expect(controller.state.pending).toBe(false)
    expect(controller.state.error).toBe(false)
  })

  it('TC12: resolved requestId 空串（bridge 对旧版广播的宽容窄化产物）→ 回退按 pluginId 匹配撤回', () => {
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    emitResolved(bus, 'p1', '', false)
    expect(controller.state.pending).toBe(false)
  })

  it('TC13: dispose 退订 resolved 订阅：dispose 后 resolved 命中形态不再撤窗', () => {
    // 先置 pending=true（弹窗在场）再 dispose——终局态（pending=false）下 resolved 泄漏是恒 noop，测不出退订
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    expect(controller.state.pending).toBe(true)

    controller.dispose()

    // offResolved 泄漏时：requestId 命中形态的 resolved 广播会误撤窗（pending 翻 false）
    emitResolved(bus, 'p1', 'req-a', true)
    expect(controller.state.pending).toBe(true)
  })
})
