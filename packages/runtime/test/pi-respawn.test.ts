/**
 * RespawnOrchestrator 单测（crash-resilience §3.3 D7 / 实施计划 u8-pi-respawn）。
 *
 * 覆盖（验收必测断言，timer 全部 fake timers）：
 * - ①非主动退出 5s 后触发一次 restore（且只一次）；
 * - ③join（ensureRestored）：并发调用等待同一 in-flight Promise（③c = 自动恢复执行
 *   路径也登记 in-flight——timer 触发后 restore 进行中，并发 join 不双跑，D7-③ 双向）；
 * - ④in-flight 恢复时自动恢复跳过（schedule 与 timer 触发两道守卫）；
 * - ⑤熔断：连续失败 2 次停止自动重试；
 * - ⑥成功清零：任一次恢复成功（notifyRestored）后熔断计数归零，未来崩溃获得全新额度；
 * - ⑦shutdown 取消语义：cancelAll 清全部 pending timer（timer unref 断言）；
 * - ⑧session 删除取消：cancel 清该 session 的 pending timer；
 * - ⑨restored/restoreFailed 消息形态（sessionId 必带，仓规规则 7）。
 *
 * 挂点/forceQuit 反向/join 等组装级行为在 session-service-respawn.test.ts（真实构造器
 * 接线 + dispatcher 链路）。本文件零 IO、零真实 pi、零真实数据目录。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RespawnOrchestrator, RESPAWN_DELAY_MS, RESPAWN_MAX_CONSECUTIVE_FAILURES } from '../src/services/session/pi-respawn.js'
import type { RespawnDeps } from '../src/services/session/pi-respawn.js'
import type { ServerMessage } from '@taiji/shared'

function createDeps(overrides: Partial<RespawnDeps> = {}): RespawnDeps & {
  restore: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
  setActive: (id: string, active: boolean) => void
} {
  const active = new Set<string>()
  const restore = vi.fn<(id: string) => Promise<unknown>>().mockResolvedValue(undefined)
  const publish = vi.fn<(id: string, msg: ServerMessage) => void>()
  return {
    isActive: (id: string) => active.has(id),
    restore,
    publish,
    setActive: (id: string, on: boolean) => { if (on) active.add(id); else active.delete(id) },
    ...overrides,
  } as never
}

describe('RespawnOrchestrator（crash-resilience D7）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('①非主动退出：schedule 后 5s 触发一次 restore（且只一次），成功推 session.restored', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.schedule('s1')
    // 5s 前不触发
    vi.advanceTimersByTime(RESPAWN_DELAY_MS - 1)
    expect(deps.restore).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(deps.restore).toHaveBeenCalledTimes(1)
    expect(deps.restore).toHaveBeenCalledWith('s1')
    // restore 是异步链：flush 微任务后发布 restored
    await vi.runAllTimersAsync()
    await Promise.resolve()
    expect(deps.publish).toHaveBeenCalledTimes(1)
    const [sid, msg] = deps.publish.mock.calls[0] as [string, ServerMessage]
    expect(sid).toBe('s1')
    expect(msg.type).toBe('session.restored')
    // ⑨sessionId 必带（仓规规则 7）
    expect(msg.payload).toMatchObject({ sessionId: 's1' })
    // 只触发一次：后续时间推进不再 restore
    await vi.runAllTimersAsync()
    expect(deps.restore).toHaveBeenCalledTimes(1)
  })

  it('④a schedule 时 in-flight 恢复在跑 → 跳过自动恢复（不挂 timer 不 restore）', async () => {
    const deps = createDeps()
    // 用户先发消息触发的惰性恢复（ensureRestored）在途
    let resolveRestore!: () => void
    deps.restore.mockImplementationOnce(() => new Promise<unknown>((res) => { resolveRestore = () => res(undefined) }))
    const orchestrator = new RespawnOrchestrator(deps)
    const lazy = orchestrator.ensureRestored('s1')
    expect(orchestrator.isRestoring('s1')).toBe(true)
    orchestrator.schedule('s1')
    expect(orchestrator.pendingSessionIds()).toEqual([])
    resolveRestore()
    await lazy
    vi.advanceTimersByTime(RESPAWN_DELAY_MS * 2)
    // 只有一次 restore（用户的惰性恢复），自动恢复让位
    expect(deps.restore).toHaveBeenCalledTimes(1)
    expect(deps.publish).not.toHaveBeenCalled()
  })

  it('④b timer 触发时已 active / in-flight（5s 窗口内用户先恢复）→ 跳过（不双跑）', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.schedule('s1')
    // 5s 窗口内用户发消息触发惰性恢复并完成
    deps.setActive('s1', true)
    await vi.runAllTimersAsync()
    expect(deps.restore).not.toHaveBeenCalled()
    expect(deps.publish).not.toHaveBeenCalled()

    // in-flight 变体：触发瞬间恢复仍在跑 → 跳过且不计失败（join 语义下用户恢复负责终态）
    const deps2 = createDeps()
    let resolveRestore!: () => void
    deps2.restore.mockImplementation(() => new Promise<unknown>((res) => { resolveRestore = () => res(undefined) }))
    const orchestrator2 = new RespawnOrchestrator(deps2)
    const lazy = orchestrator2.ensureRestored('s2')
    orchestrator2.schedule('s2') // in-flight 让位，不挂 timer
    // 直接把 timer 挂回去再触发（模拟「schedule 后用户才发起恢复」的窗口内竞态）
    resolveRestore()
    await lazy
    expect(deps2.restore).toHaveBeenCalledTimes(1)
    await vi.runAllTimersAsync()
    expect(deps2.restore).toHaveBeenCalledTimes(1)
  })

  it('③join（ensureRestored）：并发调用等待同一 in-flight Promise，restore 内核只跑一次', async () => {
    const deps = createDeps()
    let resolveRestore!: () => void
    deps.restore.mockImplementationOnce(() => new Promise<unknown>((res) => { resolveRestore = () => res(undefined) }))
    const orchestrator = new RespawnOrchestrator(deps)
    const p1 = orchestrator.ensureRestored('s9')
    const p2 = orchestrator.ensureRestored('s9')
    expect(deps.restore).toHaveBeenCalledTimes(1)
    let settled = false
    void Promise.all([p1, p2]).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    resolveRestore()
    await Promise.all([p1, p2])
    expect(settled).toBe(true)
    // join 完成后注册表清空：后续调用发起新恢复
    expect(orchestrator.isRestoring('s9')).toBe(false)
  })

  it('③b join 失败传导：原恢复失败时 join 方得到同一失败，注册表清空后可重试', async () => {
    const deps = createDeps()
    let rejectRestore!: (e: unknown) => void
    deps.restore.mockImplementationOnce(() => new Promise<unknown>((_res, rej) => { rejectRestore = (e) => rej(e) }))
    const orchestrator = new RespawnOrchestrator(deps)
    const p1 = orchestrator.ensureRestored('s9')
    const p2 = orchestrator.ensureRestored('s9')
    rejectRestore(new Error('attach failed'))
    await expect(p1).rejects.toThrow('attach failed')
    await expect(p2).rejects.toThrow('attach failed')
    expect(orchestrator.isRestoring('s9')).toBe(false)
    await expect(orchestrator.ensureRestored('s9')).resolves.toBeUndefined()
    expect(deps.restore).toHaveBeenCalledTimes(2)
  })

  it('③c 自动恢复执行登记 in-flight：timer 已触发、restore 进行中（spawn+attach 未完成）→ 并发 ensureRestored join 同一 Promise，restore 内核只跑一次', async () => {
    const deps = createDeps()
    let resolveRestore!: () => void
    deps.restore.mockImplementationOnce(() => new Promise<unknown>((res) => { resolveRestore = () => res(undefined) }))
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.schedule('s1')
    await vi.advanceTimersByTimeAsync(RESPAWN_DELAY_MS)
    // 自动恢复已启动且进行中：in-flight 注册表已登记（D7-③ 双向 join 的构造前提——
    // attemptRespawn 经 ensureRestored 执行，不再直呼 deps.restore）
    expect(deps.restore).toHaveBeenCalledTimes(1)
    expect(orchestrator.isRestoring('s1')).toBe(true)
    // 恢复窗口内用户发消息（ensureActive 恢复腿）→ join 同一 Promise，不发起第二路恢复
    const join = orchestrator.ensureRestored('s1')
    expect(deps.restore).toHaveBeenCalledTimes(1)
    let settled = false
    void join.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    resolveRestore()
    await join
    expect(settled).toBe(true)
    // 只 spawn 一个：restore 内核全程只进入一次；restored 恰好一推（join 方不重复终态）
    expect(deps.restore).toHaveBeenCalledTimes(1)
    expect(deps.publish).toHaveBeenCalledTimes(1)
    const [, msg] = deps.publish.mock.calls[0] as [string, ServerMessage]
    expect(msg.type).toBe('session.restored')
    expect(msg.payload).toMatchObject({ sessionId: 's1' })
  })

  it('⑤熔断：连续失败 2 次后停止自动重试（第 1 次失败续排，第 2 次失败不再续排）', async () => {
    const deps = createDeps()
    deps.restore.mockRejectedValue(new Error('MissingSessionCwdError: cwd does not exist'))
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.schedule('s1')
    // 第 1 次尝试失败 → willRetry=true
    await vi.advanceTimersByTimeAsync(RESPAWN_DELAY_MS)
    expect(deps.restore).toHaveBeenCalledTimes(1)
    // 第 2 次尝试失败 → 熔断，不再续排
    await vi.runAllTimersAsync()
    expect(deps.restore).toHaveBeenCalledTimes(RESPAWN_MAX_CONSECUTIVE_FAILURES)
    expect(deps.publish).toHaveBeenCalledTimes(2)
    const [, lastMsg] = deps.publish.mock.calls[1] as [string, ServerMessage]
    expect(lastMsg.type).toBe('session.restoreFailed')
    expect(lastMsg.payload).toMatchObject({ sessionId: 's1', willRetry: false })
    expect(orchestrator.isTripped('s1')).toBe(true)
    // 熔断后再 schedule（同 session 再次崩溃的场景）→ 不再自动恢复
    orchestrator.schedule('s1')
    await vi.runAllTimersAsync()
    expect(deps.restore).toHaveBeenCalledTimes(2)
    // session 保持 dead：无 restored 推送
    expect(deps.publish.mock.calls.some(([, m]) => (m as ServerMessage).type === 'session.restored')).toBe(false)
  })

  it('⑤willRetry=true 中间失败帧：第 1 次失败推 willRetry=true', async () => {
    const deps = createDeps()
    deps.restore.mockRejectedValueOnce(new Error('spawn failed'))
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.schedule('s1')
    await vi.advanceTimersByTimeAsync(RESPAWN_DELAY_MS)
    const [, firstMsg] = deps.publish.mock.calls[0] as [string, ServerMessage]
    expect(firstMsg.type).toBe('session.restoreFailed')
    expect(firstMsg.payload).toMatchObject({ sessionId: 's1', attempts: 1, willRetry: true })
    // 重试成功 → 计数清零 + restored
    await vi.runAllTimersAsync()
    const [, secondMsg] = deps.publish.mock.calls[1] as [string, ServerMessage]
    expect(secondMsg.type).toBe('session.restored')
    expect(orchestrator.isTripped('s1')).toBe(false)
  })

  it('⑥成功清零：手动恢复成功（notifyRestored）后熔断解除，未来崩溃获得全新自动恢复额度', async () => {
    const deps = createDeps()
    deps.restore.mockRejectedValue(new Error('attach failed'))
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.schedule('s1')
    await vi.runAllTimersAsync()
    expect(orchestrator.isTripped('s1')).toBe(true)
    // 用户手动重试成功（facade.restoreSession 成功路径回调）
    orchestrator.notifyRestored('s1')
    expect(orchestrator.isTripped('s1')).toBe(false)
    // 未来崩溃 → 正常调度并自动恢复
    deps.restore.mockResolvedValue(undefined)
    orchestrator.schedule('s1')
    await vi.runAllTimersAsync()
    expect(deps.restore).toHaveBeenCalledTimes(3)
    expect(deps.publish).toHaveBeenLastCalledWith('s1', expect.objectContaining({ type: 'session.restored' }))
  })

  it('⑦shutdown 取消：cancelAll 清全部 pending timer（不触发 restore）', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.schedule('s1')
    orchestrator.schedule('s2')
    expect(orchestrator.pendingSessionIds()).toEqual(['s1', 's2'])
    // shutdown 序列：cancelAll 先于 destroyAll（index.ts 顺序），此后 timer 不再触发
    orchestrator.cancelAll()
    expect(orchestrator.pendingSessionIds()).toEqual([])
    await vi.runAllTimersAsync()
    expect(deps.restore).not.toHaveBeenCalled()
    expect(deps.publish).not.toHaveBeenCalled()
  })

  // unref 断言需真实 Node Timeout 原型（fake timers 的句柄不是 Timeout 实例），本用例独立用真实 timer。
  it('⑦b timer 恒 unref：管理面 timer 不阻塞进程退出（unref 被调用）', () => {
    vi.useRealTimers()
    // 探针取 Node Timeout 原型（1h 后自毁——用例内 clearTimeout 即清，无泄漏）
    const probe = setTimeout(() => { /* never */ }, 3_600_000)
    const timeoutProto = Object.getPrototypeOf(probe)
    clearTimeout(probe)
    const unrefSpy = vi.spyOn(timeoutProto, 'unref')
    try {
      const deps = createDeps()
      const orchestrator = new RespawnOrchestrator(deps)
      orchestrator.schedule('s1')
      expect(unrefSpy).toHaveBeenCalledTimes(1)
      orchestrator.cancelAll() // 收尾清 timer（用例秒级结束，不触发 restore）
    } finally {
      unrefSpy.mockRestore()
    }
  })

  it('⑧session 删除取消：cancel 清该 session 的 pending timer，其他 session 不受影响', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.schedule('s1')
    orchestrator.schedule('s2')
    // s1 被用户删除（removeSessionEntry 汇聚点调 cancel）
    orchestrator.cancel('s1')
    expect(orchestrator.pendingSessionIds()).toEqual(['s2'])
    await vi.runAllTimersAsync()
    expect(deps.restore).toHaveBeenCalledTimes(1)
    expect(deps.restore).toHaveBeenCalledWith('s2')
  })

  it('schedule 对活跃 session no-op（防御：exit 链正常已清 processes）', async () => {
    const deps = createDeps()
    deps.setActive('s1', true)
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.schedule('s1')
    await vi.runAllTimersAsync()
    expect(deps.restore).not.toHaveBeenCalled()
  })

  it('同一 session 重复 schedule（防御）：不产生双 timer，只触发一次 restore', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.schedule('s1')
    orchestrator.schedule('s1')
    expect(orchestrator.pendingSessionIds()).toEqual(['s1'])
    await vi.runAllTimersAsync()
    expect(deps.restore).toHaveBeenCalledTimes(1)
  })
})
