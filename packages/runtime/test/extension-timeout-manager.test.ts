/**
 * ExtensionTimeoutManager 单测 —— 纯逻辑状态机。
 *
 * 覆盖：
 * - registerTimeout 两分支（notify 早退 / 交互式 method 仅 session 跟踪不建 timer）
 * - addBridgeRequest：marker 通道（select+BRIDGE_MARKER）bridge 请求的唯一登记入口
 * - clearTimeout 单条清理
 * - clearForSession（含 bridgeRequestIds 清理 + 跨 session 隔离）
 * - [2026-07-16] 交互式 method（select/confirm/input/editor/ask-user）不再触发 onTimeout
 * - 重复 register 不再产生定时器
 * - isBridgeRequest / removeBridgeRequest
 * - B6（memory-leak-remediation §3.2-B6）removeBridgeRequest 双集合清理（bridgeRequestIds
 *   + per-session Set 同步归零，trackSessionRequest 对偶）/ sessionRequestCount 探针
 *
 * [HISTORICAL] registerTimeout 的 bridge: 前缀登记分支已随旧通道清理删除（设计
 * bridge-rewrite-pi-0.84 §3.3-D6）——bridge 登记单落在 addBridgeRequest（BridgeHandler
 * 入口调用），registerTimeout 只服务 extension-ui kind。
 *
 * 用 vi.useFakeTimers() 控制 setTimeout（manager 内部用真实 setTimeout + 300s 超时）。
 *
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/extension-timeout-manager.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ExtensionTimeoutManager } from '../src/services/extension-timeout-manager.js'

describe('ExtensionTimeoutManager', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('registerTimeout(method="notify") 不建 timer（早退）', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'notify', onTimeout)
    // 远超 5min 超时
    vi.advanceTimersByTime(mgr.TIMEOUT_MS + 1)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('addBridgeRequest 登记 bridgeRequestIds + session，不建 timer（marker 通道唯一登记入口）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.addBridgeRequest('s1', 'r1')
    expect(mgr.isBridgeRequest('r1')).toBe(true)
    // bridge 请求靠跨进程序列驱动，不建本地 timer
    vi.advanceTimersByTime(mgr.TIMEOUT_MS + 1)
    expect(() => mgr.isBridgeRequest('r1')).not.toThrow()
  })

  it('registerTimeout(method="bridge:*") 不再登记 bridge 请求（旧前缀分支已删，防回归）', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'bridge:something', onTimeout)
    // 登记责任单落在 addBridgeRequest——误传 bridge: method 不得进 bridgeRequestIds
    expect(mgr.isBridgeRequest('r1')).toBe(false)
    vi.advanceTimersByTime(mgr.TIMEOUT_MS + 1)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('registerTimeout(交互式 method) 仅 session 跟踪，不再建 timer/触发 onTimeout', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'select', onTimeout)
    // [2026-07-16] 交互式 method 统一不超时，block 等待用户决策
    vi.advanceTimersByTime(mgr.TIMEOUT_MS + 1)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('clearTimeout 对交互式 method 是 no-op（无 timer 可清，仍不触发回调）', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'select', onTimeout)
    mgr.clearTimeout('r1')
    vi.advanceTimersByTime(mgr.TIMEOUT_MS)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('clearForSession 清掉该 session 的 bridge 请求，不影响其他 session 的 session 跟踪', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout1 = vi.fn()
    const onTimeout2 = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'select', onTimeout1)
    mgr.addBridgeRequest('s1', 'r2')
    mgr.registerTimeout('s2', 'r3', 'select', onTimeout2)

    mgr.clearForSession('s1')

    vi.advanceTimersByTime(mgr.TIMEOUT_MS)
    expect(onTimeout1).not.toHaveBeenCalled() // 交互式 method 本就不触发
    expect(mgr.isBridgeRequest('r2')).toBe(false) // s1 bridge 请求已清
    expect(onTimeout2).not.toHaveBeenCalled() // 交互式 method 本就不触发
  })

  it('clearForSession 对无请求的 session 是 no-op', () => {
    const mgr = new ExtensionTimeoutManager()
    expect(() => mgr.clearForSession('no-such-session')).not.toThrow()
  })

  it('重复 registerTimeout(相同 requestId) 不再产生定时器，回调均不触发', () => {
    const mgr = new ExtensionTimeoutManager()
    const oldCb = vi.fn()
    const newCb = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'select', oldCb)
    mgr.registerTimeout('s1', 'r1', 'select', newCb) // 覆盖

    vi.advanceTimersByTime(mgr.TIMEOUT_MS)
    expect(oldCb).not.toHaveBeenCalled()
    expect(newCb).not.toHaveBeenCalled()
  })

  it('removeBridgeRequest 从 bridge 跟踪表移除', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.addBridgeRequest('s1', 'r1')
    expect(mgr.isBridgeRequest('r1')).toBe(true)
    mgr.removeBridgeRequest('r1')
    expect(mgr.isBridgeRequest('r1')).toBe(false)
  })

  // B6（memory-leak-remediation §3.2-B6）应答即删：removeBridgeRequest 同步清 per-session
  // Set（trackSessionRequest 对偶——只删全局 Set 会留空 Set 条目驻留到 session 销毁）。
  it('B6：removeBridgeRequest 双集合清理——bridgeRequestIds 与 per-session Set 同步归零', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.addBridgeRequest('s1', 'r1')
    mgr.addBridgeRequest('s1', 'r2')
    mgr.addBridgeRequest('s2', 'r3')
    expect(mgr.sessionRequestCount('s1')).toBe(2)

    mgr.removeBridgeRequest('r1')
    expect(mgr.isBridgeRequest('r1')).toBe(false)
    expect(mgr.sessionRequestCount('s1')).toBe(1)

    mgr.removeBridgeRequest('r2')
    expect(mgr.sessionRequestCount('s1')).toBe(0) // Set 归零（A5 验收断言）
    expect(mgr.sessionRequestCount('s2')).toBe(1) // 跨 session 隔离不误伤
    expect(mgr.isBridgeRequest('r3')).toBe(true)

    // 幂等：重复摘除 no-op
    expect(() => mgr.removeBridgeRequest('r2')).not.toThrow()
    expect(mgr.sessionRequestCount('s1')).toBe(0)
  })

  it('isBridgeRequest 对未登记 id 返回 false', () => {
    const mgr = new ExtensionTimeoutManager()
    expect(mgr.isBridgeRequest('never-registered')).toBe(false)
  })

  it('getPendingRequests 非破坏性：多次 peek 不清缓存，payload 解包到顶层', () => {
    const mgr = new ExtensionTimeoutManager()
    // cachePendingRequest 签名：(sessionId, requestId, method, payload)
    mgr.cachePendingRequest('s1', 'r1', 'select', { title: 'ask', askUser: true, askUserQuestions: [] })
    mgr.cachePendingRequest('s1', 'r2', 'confirm', { title: 'cf', message: 'sure?' })

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

  it('removePendingRequest 后 getPendingRequests 快照收缩（respond 生命周期）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.cachePendingRequest('s1', 'r1', 'select', { askUser: true })
    mgr.cachePendingRequest('s1', 'r2', 'confirm', {})

    mgr.removePendingRequest('s1', 'r1') // 模拟 extension.ui_response 到达，r1 已 respond

    const pending = mgr.getPendingRequests('s1')
    expect(pending).toHaveLength(1)
    expect(pending[0].requestId).toBe('r2')
  })

  it('clearForSession 后 getPendingRequests 返回空数组（session 销毁清理）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.cachePendingRequest('s1', 'r1', 'select', { askUser: true })
    mgr.clearForSession('s1')
    expect(mgr.getPendingRequests('s1')).toEqual([])
  })
})
