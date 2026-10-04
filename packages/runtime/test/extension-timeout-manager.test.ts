/**
 * ExtensionTimeoutManager 单测 —— 纯逻辑状态机（无超时：2026-07-16 取消 UI 超时，
 * 2026-09-17 死代码清理后职责 = session 跟踪 + pending 缓存）。
 *
 * 覆盖：
 * - registerRequest 登记（D-B2-2 挂起单表唯一写表点）
 * - removeRequest 单条清理（D-B2-2：旧 clearTimeout / removePendingRequest 按职责收敛
 *   到本原语，超时机制已删方法名不再残留）
 * - clearForSession（跨 session 隔离）
 * - invalidatePendingForSession（P2-2 失效链唯一摘除口：entry 摘除并出现在返回清单）
 * - B6（memory-leak-remediation §3.2-B6）应答即删（单表 entry 一体摘除）/
 *   sessionRequestCount 探针
 * - pending request 缓存族（register / get 非破坏快照 / remove / clearForSession）
 *
 * [pi1-disposition-chat-flow D7②/E 组] bridge 登记语义（addBridgeRequest /
 * isBridgeRequest / isBridge 标记）随 plugin-bridge 整体退役删除，相关用例同批删除。
 * [HISTORICAL] 旧 registerTimeout 的 bridge: 前缀登记分支已随旧通道清理删除（设计
 * bridge-rewrite-pi-0.84 §3.3-D6）；超时编排链（timedOutIds / handleExtensionTimeout /
 * extension.ui_timeout 广播）已随 2026-09-17 死代码清理整体删除。
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/extension-timeout-manager.test.ts
 */
import { describe, it, expect } from 'vitest'
import { ExtensionTimeoutManager } from '../src/services/extension-timeout-manager.js'

describe('ExtensionTimeoutManager', () => {
  it('registerRequest 登记挂起单表（extension-ui kind 交互式 method：select/confirm/input/editor/ask-user 无超时，block 等待）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.registerRequest('s1', 'r1', 'select')
    mgr.registerRequest('s1', 'r2', 'confirm', {})
    expect(mgr.sessionRequestCount('s1')).toBe(2)
  })

  it('removeRequest 移除登记（ui_response 应答后调）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.registerRequest('s1', 'r1', 'select')
    mgr.removeRequest('r1')
    expect(mgr.sessionRequestCount('s1')).toBe(0)
  })

  it('clearForSession 清掉该 session 的全部登记，不影响其他 session 的跟踪', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.registerRequest('s1', 'r1', 'select')
    mgr.registerRequest('s1', 'r2', 'confirm')
    mgr.registerRequest('s2', 'r3', 'select')

    mgr.clearForSession('s1')

    expect(mgr.sessionRequestCount('s1')).toBe(0) // s1 已清
    expect(mgr.sessionRequestCount('s2')).toBe(1) // s2 跟踪不误伤
  })

  it('clearForSession 对无请求的 session 是 no-op', () => {
    const mgr = new ExtensionTimeoutManager()
    expect(() => mgr.clearForSession('no-such-session')).not.toThrow()
  })

  it('invalidatePendingForSession：entry 摘除并出现在返回清单（payload 解包到顶层形态）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.registerRequest('s1', 'r1', 'select', { askUser: true })
    mgr.registerRequest('s1', 'r2', 'confirm', {})
    mgr.registerRequest('s2', 'r3', 'select')

    const invalidated = mgr.invalidatePendingForSession('s1')

    // 全部摘除并出现在返回清单
    expect(invalidated.map((r) => r.requestId).sort()).toEqual(['r1', 'r2'])
    const r1 = invalidated.find((r) => r.requestId === 'r1')
    expect(r1?.sessionId).toBe('s1')
    expect(r1?.method).toBe('select')
    expect(r1?.askUser).toBe(true) // payload 解包到顶层
    expect(mgr.sessionRequestCount('s1')).toBe(0)
    expect(mgr.getPendingRequests('s1')).toEqual([])
    // 跨 session 隔离
    expect(mgr.sessionRequestCount('s2')).toBe(1)
  })

  it('invalidatePendingForSession 对无请求 session 返回空数组（非抛错）', () => {
    const mgr = new ExtensionTimeoutManager()
    expect(mgr.invalidatePendingForSession('no-such-session')).toEqual([])
  })

  // B6（memory-leak-remediation §3.2-B6）应答即删：removeRequest 摘单表 entry
  //（挂起登记一体清理——只摘标记不删 entry 会留死条目驻留到 session 销毁）。
  it('B6：removeRequest 一体摘除——entry 归零且跨 session 隔离', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.registerRequest('s1', 'r1', 'select')
    mgr.registerRequest('s1', 'r2', 'confirm')
    mgr.registerRequest('s2', 'r3', 'select')
    expect(mgr.sessionRequestCount('s1')).toBe(2)

    mgr.removeRequest('r1')
    expect(mgr.sessionRequestCount('s1')).toBe(1)

    mgr.removeRequest('r2')
    expect(mgr.sessionRequestCount('s1')).toBe(0) // entry 归零（A5 验收断言）
    expect(mgr.sessionRequestCount('s2')).toBe(1) // 跨 session 隔离不误伤

    // 幂等：重复摘除 no-op
    expect(() => mgr.removeRequest('r2')).not.toThrow()
    expect(mgr.sessionRequestCount('s1')).toBe(0)
  })

  it('getPendingRequests 非破坏性：多次 peek 不清缓存，payload 解包到顶层', () => {
    const mgr = new ExtensionTimeoutManager()
    // registerRequest 签名：(sessionId, requestId, method, payload?)
    mgr.registerRequest('s1', 'r1', 'select', { title: 'ask', askUser: true, askUserQuestions: [] })
    mgr.registerRequest('s1', 'r2', 'confirm', { title: 'cf', message: 'sure?' })

    const first = mgr.getPendingRequests('s1')
    const second = mgr.getPendingRequests('s1')

    // 两次都拿到完整列表（非破坏）
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    // requestId 集合一致
    const ids = (arr: { requestId: string }[]) => arr.map(r => r.requestId).sort()
    expect(ids(first)).toEqual(ids(second))

    // payload 解包到顶层
    const askReq = first.find(r => r.requestId === 'r1')
    expect(askReq?.title).toBe('ask') // payload.title 解包到顶层
    expect(askReq?.askUser).toBe(true) // payload.askUser 解包到顶层
    expect(askReq?.method).toBe('select')
    expect(typeof askReq?.receivedAt).toBe('number')
  })

  it('getPendingRequests 对未激活/无 pending 的 session 返回空数组（非抛错）', () => {
    const mgr = new ExtensionTimeoutManager()
    expect(mgr.getPendingRequests('never-active')).toEqual([])
  })

  it('removeRequest 后 getPendingRequests 快照收缩（respond 生命周期）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.registerRequest('s1', 'r1', 'select', { askUser: true })
    mgr.registerRequest('s1', 'r2', 'confirm', {})

    mgr.removeRequest('r1') // 模拟 extension.ui_response 到达，r1 已 respond

    const pending = mgr.getPendingRequests('s1')
    expect(pending).toHaveLength(1)
    expect(pending[0].requestId).toBe('r2')
  })

  it('clearForSession 后 getPendingRequests 返回空数组（session 销毁清理）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.registerRequest('s1', 'r1', 'select', { askUser: true })
    mgr.clearForSession('s1')
    expect(mgr.getPendingRequests('s1')).toEqual([])
  })
})
