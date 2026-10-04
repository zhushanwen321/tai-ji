/**
 * RespawnOrchestrator 单测（crash-resilience §3.3 D7 / 实施计划 u8-pi-respawn；发布判别
 * 补充 msg-pipeline-debloat D3 四入口矩阵）。
 *
 * 覆盖（验收必测断言，timer 全部 fake timers）：
 * - ①非主动退出 5s 后触发一次 restore（且只一次）——D3 后成功发布走 facade 尾部三合一
 *   出口，本用例同时锁「首试成功（timer 已删 + 计数 0）仍恰好一条 restored」的信号②
 *   脆弱点；
 * - ③join（ensureRestored）：并发调用等待同一 in-flight Promise（③c = 自动恢复执行
 *   路径也登记 in-flight——timer 触发后 restore 进行中，并发 join 不双跑，D7-③ 双向）；
 * - ④in-flight 恢复时自动恢复跳过（schedule 与 timer 触发两道守卫）；
 * - ⑤熔断：连续失败 2 次停止自动重试；
 * - ⑥成功清零：任一次恢复成功（onRestoreSuccess 三合一出口）后熔断计数
 *   归零，未来崩溃获得全新额度；
 * - ⑦shutdown 取消语义：cancelAll 清全部 pending timer（timer unref 断言）；
 * - ⑧session 删除取消：cancel 清该 session 的 pending timer；
 * - ⑨restored/restoreFailed 消息形态（sessionId 必带，仓规规则 7）；
 * - D3 发布判别矩阵（信号① pending timer / ② attemptInFlight / ③ 失败计数，含
 *   attemptInFlight 置位/清除的黑盒观测）。
 *
 * mock 契约（D3）：restore 内核 = facade.restoreSession（生产装配 deps.restore = facade
 * 本尊），session.restored 的发布点 = facade 成功尾部（onRestoreSuccess）——需要发布
 * 断言的用例用 wireFacadeContract 把 restore 替身升级为同一契约，否则发布链断裂。
 * - ⑩respawn 终态命运信号源（notify-once D5）：emitRespawnFate 全部 7 处点位逐分支断言
 *   fate 值（schedule 正常→retry-pending / isActive·isRestoring·复活→recovered /
 *   熔断两态→terminal / 成功→recovered / cancel 不产生命运事件）——组合根 index.ts
 *   据该信号裁决死亡发声/静默，信号错值 = 死亡通知漏发/误发且完全静默。
 *
 * 挂点/forceQuit 反向/join 等组装级行为在 session-service-respawn.test.ts（真实构造器
 * 接线 + dispatcher 链路）。本文件零 IO、零真实 pi、零真实数据目录。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RespawnOrchestrator, RESPAWN_DELAY_MS, RESPAWN_MAX_CONSECUTIVE_FAILURES, onRespawnFate } from '../src/services/session/pi-respawn.js'
import type { RespawnDeps, RespawnFate, RespawnFateEvent } from '../src/services/session/pi-respawn.js'
import type { ServerMessage } from '@taiji/shared'

type RespawnTestDeps = RespawnDeps & {
  restore: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
  setActive: (id: string, on: boolean) => void
}

function createDeps(overrides: Partial<RespawnDeps> = {}): RespawnTestDeps {
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

/**
 * [D3] 把 restore 替身升级为「真实 facade 契约」形态：内核成功 = spawn+attach 完成
 * （pm 有活 client）+ facade 尾部三合一出口回调。生产装配 deps.restore = facade 本尊，
 * 不做此接线的替身（如纯 reject / 早期 join 用例）发布链断流属预期。
 */
function wireFacadeContract(deps: RespawnTestDeps, orchestrator: RespawnOrchestrator): void {
  deps.restore.mockImplementation(async (id: string) => {
    deps.setActive(id, true)
    orchestrator.onRestoreSuccess(id)
    return undefined
  })
}

describe('RespawnOrchestrator（crash-resilience D7）', () => {
  // ⑩respawn 终态命运收集（notify-once D5 信号源断言面）：onRespawnFate 是模块级订阅
  //（组合根单消费方），beforeEach 挂 afterEach 退订——订阅残留会跨用例串扰。
  let fates: RespawnFateEvent[] = []
  let unsubFate: (() => void) | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    fates = []
    unsubFate = onRespawnFate((e) => { fates.push(e) })
  })
  afterEach(() => {
    unsubFate?.()
    unsubFate = undefined
    vi.useRealTimers()
  })
  /** 该 session 的 fate 事件序列（按序，含重复） */
  const fatesOf = (sessionId: string): RespawnFate[] =>
    fates.filter((e) => e.sessionId === sessionId).map((e) => e.fate)

  it('①非主动退出：schedule 后 5s 触发一次 restore（且只一次），成功经 facade 尾部出口推 session.restored', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    wireFacadeContract(deps, orchestrator)
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
    // [D3] 恰好一条（S3①）——首试成功时 timer 已删 + 计数 0，发布全靠信号②
    // attemptInFlight（脆弱点锁，r5 主审：缺此信号则本子走法 0 帧）
    expect(deps.publish).toHaveBeenCalledTimes(1)
    const [sid, msg] = deps.publish.mock.calls[0] as [string, ServerMessage]
    expect(sid).toBe('s1')
    expect(msg.type).toBe('session.restored')
    // ⑨sessionId 必带（仓规规则 7）；attempts 语义 = 成功前连续失败次数 + 1（首试 = 1）
    expect(msg.payload).toMatchObject({ sessionId: 's1', attempts: 1 })
    // 只触发一次：后续时间推进不再 restore
    await vi.runAllTimersAsync()
    expect(deps.restore).toHaveBeenCalledTimes(1)
    // ⑩信号源：schedule 正常路径 → retry-pending（respawn 链接管，静默）；自动恢复成功 → recovered
    expect(fatesOf('s1')).toEqual(['retry-pending', 'recovered'])
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
    // ⑩信号源：schedule 的 isRestoring 分支 → recovered（惰性恢复在跑 = session 将复活）
    expect(fatesOf('s1')).toEqual(['recovered'])
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
    // ⑩信号源：schedule 正常挂 retry-pending，timer 触发时已复活 → recovered（丢弃退出现场 stash）
    expect(fatesOf('s1')).toEqual(['retry-pending', 'recovered'])

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
    // ⑩信号源（deps2 变体）：schedule 的 isRestoring 分支 → recovered
    expect(fatesOf('s2')).toEqual(['recovered'])
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
    // [D3] 替身按 facade 契约收尾：内核成功（resolve）→ 尾部三合一出口
    deps.restore.mockImplementationOnce(async (id: string) => {
      await new Promise<unknown>((res) => { resolveRestore = () => res(undefined) })
      deps.setActive(id, true)
      orchestrator.onRestoreSuccess(id)
      return undefined
    })
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
    // 只 spawn 一个：restore 内核全程只进入一次；restored 恰好一推（join 方不重复终态；
    // [D3] 矩阵「fire 后 join 子态」= 信号②命中发布）
    expect(deps.restore).toHaveBeenCalledTimes(1)
    expect(deps.publish).toHaveBeenCalledTimes(1)
    const [, msg] = deps.publish.mock.calls[0] as [string, ServerMessage]
    expect(msg.type).toBe('session.restored')
    expect(msg.payload).toMatchObject({ sessionId: 's1', attempts: 1 })
    // ⑩信号源：join 场景下命运信号不重复——retry-pending → recovered 各恰一次
    expect(fatesOf('s1')).toEqual(['retry-pending', 'recovered'])
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
    // ⑩信号源：重试耗尽熔断 → terminal（按不可恢复 crash 发声，携退出现场 stash）；
    // 熔断已触发的后续死亡再 schedule → terminal（前次熔断时已销账则发声空转）
    expect(fatesOf('s1')).toEqual(['retry-pending', 'terminal', 'terminal'])
  })

  it('⑤willRetry=true 中间失败帧：第 1 次失败推 willRetry=true', async () => {
    const deps = createDeps()
    deps.restore.mockRejectedValueOnce(new Error('spawn failed'))
    const orchestrator = new RespawnOrchestrator(deps)
    wireFacadeContract(deps, orchestrator)
    orchestrator.schedule('s1')
    await vi.advanceTimersByTimeAsync(RESPAWN_DELAY_MS)
    const [, firstMsg] = deps.publish.mock.calls[0] as [string, ServerMessage]
    expect(firstMsg.type).toBe('session.restoreFailed')
    expect(firstMsg.payload).toMatchObject({ sessionId: 's1', attempts: 1, willRetry: true })
    // 重试成功 → facade 尾部出口发布 restored（attempts = 成功前失败次数 1 + 1 = 2）+ 计数清零
    await vi.runAllTimersAsync()
    const [, secondMsg] = deps.publish.mock.calls[1] as [string, ServerMessage]
    expect(secondMsg.type).toBe('session.restored')
    expect(secondMsg.payload).toMatchObject({ sessionId: 's1', attempts: 2 })
    expect(orchestrator.isTripped('s1')).toBe(false)
    // ⑩信号源：中间失败不产生 fate 事件（willRetry=true 仍由 respawn 链接管），成功 → recovered
    expect(fatesOf('s1')).toEqual(['retry-pending', 'recovered'])
  })

  it('⑥成功清零：手动恢复成功（onRestoreSuccess，信号③命中）后熔断解除，未来崩溃获得全新自动恢复额度', async () => {
    const deps = createDeps()
    deps.restore.mockRejectedValue(new Error('attach failed'))
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.schedule('s1')
    await vi.runAllTimersAsync()
    expect(orchestrator.isTripped('s1')).toBe(true)
    // 用户手动重试成功（facade.restoreSession 成功尾部回调）：失败计数 2 > 0 →
    // [D3] 矩阵「手动（熔断态）」= 信号③命中发布，attempts = 2 次失败 + 1 = 3
    orchestrator.onRestoreSuccess('s1')
    const manualMsg = deps.publish.mock.calls.at(-1) as [string, ServerMessage]
    expect(manualMsg[1].type).toBe('session.restored')
    expect(manualMsg[1].payload).toMatchObject({ sessionId: 's1', attempts: 3 })
    expect(orchestrator.isTripped('s1')).toBe(false)
    // 未来崩溃 → 正常调度并自动恢复（替身按 facade 契约收尾）
    deps.restore.mockImplementationOnce(async (id: string) => {
      deps.setActive(id, true)
      orchestrator.onRestoreSuccess(id)
      return undefined
    })
    orchestrator.schedule('s1')
    await vi.runAllTimersAsync()
    expect(deps.restore).toHaveBeenCalledTimes(3)
    expect(deps.publish).toHaveBeenLastCalledWith('s1', expect.objectContaining({ type: 'session.restored' }))
    // ⑩信号源：熔断 → terminal 发声；notifyRestored 清零后命运信号回到正常轨道（retry-pending → recovered）
    expect(fatesOf('s1')).toEqual(['retry-pending', 'terminal', 'retry-pending', 'recovered'])
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
    // ⑩信号源：cancel 取消 ≠ 终态命运——不发声不复活（claim 悬挂交 TTL 清扫，D7②取消语义）
    expect(fates).toEqual([
      { sessionId: 's1', fate: 'retry-pending' },
      { sessionId: 's2', fate: 'retry-pending' },
    ])
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
    // ⑩信号源：cancel('s1') 不产生命运事件（被删 session 的悬挂 claim 交 TTL 清扫）——
    // s1 只留 schedule 时的 retry-pending；s2 正常走完 respawn 链收口 recovered
    expect(fatesOf('s1')).toEqual(['retry-pending'])
    expect(fatesOf('s2')).toEqual(['retry-pending', 'recovered'])
  })

  it('schedule 对活跃 session no-op（防御：exit 链正常已清 processes）', async () => {
    const deps = createDeps()
    deps.setActive('s1', true)
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.schedule('s1')
    await vi.runAllTimersAsync()
    expect(deps.restore).not.toHaveBeenCalled()
    // ⑩信号源：isActive 防御分支 → recovered（非死亡终态，丢弃退出现场 stash）
    expect(fatesOf('s1')).toEqual(['recovered'])
  })

  it('同一 session 重复 schedule（防御）：不产生双 timer，只触发一次 restore', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.schedule('s1')
    orchestrator.schedule('s1')
    expect(orchestrator.pendingSessionIds()).toEqual(['s1'])
    await vi.runAllTimersAsync()
    expect(deps.restore).toHaveBeenCalledTimes(1)
    // ⑩信号源：重复 schedule 每次都发 retry-pending（重排即 respawn 链接管），成功后收口 recovered
    expect(fatesOf('s1')).toEqual(['retry-pending', 'retry-pending', 'recovered'])
  })

  // ── [D3] 发布判别四入口矩阵（msg-pipeline-debloat；restored 帧只在 respawn 编排上下文
  // 命中时发布，三信号皆空 = 普通懒 spawn / startup-reattach 静默）──

  it('D3-① 信号① pending timer：fire 前惰性抢占恢复成功 → 发布恰好一条；timer 到点 attempt 让位不双发', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    wireFacadeContract(deps, orchestrator)
    orchestrator.schedule('s1')
    // 5s 窗口内用户发消息 → 惰性恢复完成（timer 仍在册 → facade 尾部信号①命中）
    await orchestrator.ensureRestored('s1')
    expect(deps.publish).toHaveBeenCalledTimes(1)
    const [, msg] = deps.publish.mock.calls[0] as [string, ServerMessage]
    expect(msg.type).toBe('session.restored')
    expect(msg.payload).toMatchObject({ sessionId: 's1', attempts: 1 })
    // timer 到点：attempt 复查 isActive（内核成功 = pm 有活 client）→ 让位，无双发
    await vi.runAllTimersAsync()
    expect(deps.restore).toHaveBeenCalledTimes(1)
    expect(deps.publish).toHaveBeenCalledTimes(1)
  })

  it('D3-② 跨 fire 子态（D7-41 行为基线）：惰性恢复 fire 前发起、fire 后完成 → 三信号皆 miss 不发帧（收口归 message_start gate）', async () => {
    const deps = createDeps()
    let resolveRestore!: () => void
    const orchestrator = new RespawnOrchestrator(deps)
    // 替身按 facade 契约收尾（惰性恢复的 restore 内核 = facade）
    deps.restore.mockImplementationOnce(async (id: string) => {
      await new Promise<unknown>((res) => { resolveRestore = () => res(undefined) })
      deps.setActive(id, true)
      orchestrator.onRestoreSuccess(id)
      return undefined
    })
    orchestrator.schedule('s1')
    // fire 前惰性恢复发起（attempt 会在 in-flight 上让位）
    const lazy = orchestrator.ensureRestored('s1')
    expect(orchestrator.isRestoring('s1')).toBe(true)
    // timer 到点：attempt 复查 isRestoring → 让位裸 return（early return 不置 attemptInFlight）
    await vi.advanceTimersByTimeAsync(RESPAWN_DELAY_MS)
    expect(deps.restore).toHaveBeenCalledTimes(1)
    // fire 后惰性恢复完成：timer 已被 fire 回调删除、标志未置、计数 0 → 三信号皆 miss
    resolveRestore()
    await lazy
    expect(deps.publish).not.toHaveBeenCalled()
  })

  it('D3-③ early return 不置位（isActive 变体）：让位后再恢复不因标志泄漏误发假「崩溃恢复」帧', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    wireFacadeContract(deps, orchestrator)
    orchestrator.schedule('s1')
    // fire 时 session 已活跃（用户先恢复完成）→ attempt 让位（若此路径置位即泄漏）
    deps.setActive('s1', true)
    await vi.runAllTimersAsync()
    expect(deps.restore).not.toHaveBeenCalled()
    // 后续无上下文 restore（内核成功再回调出口）：timer 已删 / 计数 0 / 标志未置 → 静默
    await orchestrator.ensureRestored('s1')
    expect(deps.publish).not.toHaveBeenCalled()
  })

  it('D3-④ finally 清除：自动恢复成功后再做无上下文 restore 不双发（attemptInFlight 泄漏防线）', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    wireFacadeContract(deps, orchestrator)
    orchestrator.schedule('s1')
    await vi.runAllTimersAsync()
    // 首试成功：信号②命中恰好一条
    expect(deps.publish).toHaveBeenCalledTimes(1)
    // 成功后 attemptInFlight 已被 finally 清除 → 无上下文 restore（如再次手动 RPC /
    // startup-reattach 形态）三信号皆空，静默不发布
    await orchestrator.ensureRestored('s1')
    expect(deps.publish).toHaveBeenCalledTimes(1)
  })

  it('D3-⑤ 信号③ 失败窗口（非熔断）：1 次自动失败后无上下文恢复成功 → 命中计数>0 发布（attempts=2）', async () => {
    const deps = createDeps()
    deps.restore.mockRejectedValueOnce(new Error('spawn failed'))
    const orchestrator = new RespawnOrchestrator(deps)
    wireFacadeContract(deps, orchestrator)
    orchestrator.schedule('s1')
    // 第 1 次尝试失败：计数=1，restoreFailed{willRetry=true}，重试续排
    await vi.advanceTimersByTimeAsync(RESPAWN_DELAY_MS)
    const [, failMsg] = deps.publish.mock.calls[0] as [string, ServerMessage]
    expect(failMsg.type).toBe('session.restoreFailed')
    // 重试窗口内用户先手动/惰性恢复成功（不经 attemptRespawn，无上下文信号①②）
    // → 信号③ 计数>0 命中发布
    await orchestrator.ensureRestored('s1')
    const [, restoredMsg] = deps.publish.mock.calls.at(-1) as [string, ServerMessage]
    expect(restoredMsg.type).toBe('session.restored')
    expect(restoredMsg.payload).toMatchObject({ sessionId: 's1', attempts: 2 })
    // 计数已清零，熔断未触发
    expect(orchestrator.isTripped('s1')).toBe(false)
    // 已成功的恢复让后续 timer fire 走 isActive 让位，不产生第二路恢复/发布
    await vi.runAllTimersAsync()
    expect(deps.publish).toHaveBeenCalledTimes(2)
  })
})
