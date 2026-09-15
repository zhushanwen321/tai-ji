/**
 * ensureActive exited 防御测试（fix-respawn-pi Wave 2，设计文档
 * pi-exit-notification-and-respawn §6.6/§6.9/§7.3）。
 *
 * 锁定语义：
 * - 活 client（exited=false）直返，不触发 restoreSession；
 * - 死 client（exited=true，processes Map 竞态残留）视同无 client 走 restoreSession，
 *   返回 restore 后的新活 client（纵深防御——上游清理竞态时消费端不把死 client 交给 prompt）；
 * - 并发 restore join（crash-resilience D7-③，u8 改造）：同 sessionId 的并发 ensureActive
 *   等待同一 in-flight restore Promise（不报错不双跑，只 restore 一次）——[HISTORICAL]
 *   原为第二个调用被 already being restored 拒绝（throw），随 D7-③ 改造同步更新；
 * - restoreSession 找不到持久化 session 时错误文案含恢复指引「请新建会话」（§6.9/§7.3，
 *   白盒表「SESSION_NOT_FOUND 恢复指引文案」断言项）。
 *
 * restoreSession mock 策略：用例 a/b/c 用 vi.spyOn(svc, 'restoreSession')（既有模式，
 * test/session-service.test.ts ensureActive dedup 用例同款）——真 restoreSession 会做磁盘
 * IO（scanSessions + readFileSync + spawn pi），本测试聚焦 ensureActive 分支逻辑。
 * 文案用例走真 restoreSession 的 not-found 分支（sessionStore.scanSessions mock 恒 []，
 * 在任何磁盘访问之前 throw，无 IO）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-service-ensure-active.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionService } from '../services/session/session-service.js'
import type { IMessageBroker } from '../interfaces.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { ServerMessage, SessionSummary } from '@taiji/shared'

/** 最小假 client：ensureActive 只消费身份 + exited 标志。 */
function makeClient(exited: boolean): IPiEngine {
  return { exited } as unknown as IPiEngine
}

/**
 * 构造真实 SessionService + 可编程 pm.getClient（session-service-w07-bus.test.ts makeEnv
 * 同款轻量模式：mock pm/broker/adapterFactory，构造参数中未被测路径消费的依赖给最小桩）。
 */
function makeEnv(getClientImpl: (sessionId: string) => IPiEngine | undefined) {
  const broker = { broadcast: vi.fn((_: ServerMessage) => {}) } as unknown as IMessageBroker
  const pm = {
    onSessionExit: vi.fn(() => () => {}),
    getClient: vi.fn(getClientImpl),
  } as unknown as IProcessManager
  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never, // configStore
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never, // sessionStore
    { readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService：SessionLifecycle 构造存引用，被测路径未触发
  )
  return { svc, pm }
}

describe('SessionService.ensureActive（exited 防御，fix-respawn-pi Wave 2）', () => {
  it('活 client（exited=false）直返，不触发 restoreSession', async () => {
    const live = makeClient(false)
    const { svc } = makeEnv(() => live)
    const restoreSpy = vi.spyOn(svc, 'restoreSession')

    const got = await svc.ensureActive('sid-live')

    expect(got).toBe(live)
    expect(restoreSpy).not.toHaveBeenCalled()
    restoreSpy.mockRestore()
  })

  it('死 client（exited=true）视同无 client 走 restoreSession，返回 restore 后的新活 client', async () => {
    const dead = makeClient(true)
    const fresh = makeClient(false)
    // 第一次 getClient：processes Map 竞态残留的死 client；restore 完成后的第二次：新活 client
    let getCalls = 0
    const { svc } = makeEnv(() => {
      getCalls++
      return getCalls === 1 ? dead : fresh
    })
    const restoreSpy = vi.spyOn(svc, 'restoreSession').mockResolvedValue({ id: 'sid-dead' } as SessionSummary)

    const got = await svc.ensureActive('sid-dead')

    // 关键断言：死 client 不直通 prompt，restore 后拿到的是新活 client
    expect(got).not.toBe(dead)
    expect(got).toBe(fresh)
    expect(restoreSpy).toHaveBeenCalledTimes(1)
    expect(restoreSpy).toHaveBeenCalledWith('sid-dead')
    restoreSpy.mockRestore()
  })

  it('并发 ensureActive 同一 sessionId：join 语义——等待同一 in-flight restore，不报错不双跑（crash-resilience D7-③）', async () => {
    // [HISTORICAL] 本用例原断言第二个并发调用被 already being restored 拒绝（throw 语义）；
    // u8（crash-resilience D7-③）把 throw 改为 join：自动恢复落地后恢复窗口内用户发消息
    // 是常态路径，第二个调用必须等待同一 in-flight Promise 完成后继续。
    const { svc } = makeEnv(() => undefined)
    // 让 restoreSession 挂起，模拟并发 restore 窗口
    let resolveRestore!: (v: SessionSummary) => void
    const pending = new Promise<SessionSummary>((r) => { resolveRestore = r })
    const restoreSpy = vi.spyOn(svc, 'restoreSession').mockReturnValueOnce(pending)

    const first = svc.ensureActive('sid-dedup')
    const second = svc.ensureActive('sid-dedup')
    // join：restore 内核只进入一次（没有第二路并发 restore）
    expect(restoreSpy).toHaveBeenCalledTimes(1)
    resolveRestore({} as SessionSummary)
    // 双方都等恢复完成后继续；随后都因 getClient 无 client 而 reject（符合无进程的真实场景，
    // 同一失败 = join 透传）
    await expect(first).rejects.toThrow('client not available')
    await expect(second).rejects.toThrow('client not available')
    expect(restoreSpy).toHaveBeenCalledTimes(1)
    restoreSpy.mockRestore()
  })

  it('seat 缺省（未注入）时 restore 内核同步进入：ensureActive() 调用零微任务让步（idle-pi-reclamation u2 回归锁定）', async () => {
    // u2（idle-pi-reclamation D6-2）曾把 seat 等待写成无条件 `await awaitReclaimSeatRelease`：
    // async 函数即使 seat 缺省同步 return，await 也让 restore 入口晚一个微任务，破坏
    // 「seat 缺省 = 行为不变」契约（同步断言 spy 次数得 0；respawn ③b 的 deferred 注册
    // 窗口失效 → 5s 超时）。现实现为同步短路守卫：seat 未命中不产生任何微任务——
    // 本用例在首个 await 之前同步断言 restore 已进入，锁定零让步属性。
    const { svc } = makeEnv(() => undefined)
    const restoreSpy = vi.spyOn(svc, 'restoreSession').mockResolvedValue({} as SessionSummary)

    const active = svc.ensureActive('sid-sync-entry')

    // 同步断言（位于任何 await 之前）：restore 内核在 ensureActive() 调用的同步执行段内已进入
    expect(restoreSpy).toHaveBeenCalledTimes(1)

    // 收尾消费 rejection（restore 完成后 getClient 无 client，符合无进程场景），防 unhandled
    await expect(active).rejects.toThrow('client not available')
    restoreSpy.mockRestore()
  })

  it('restoreSession 找不到持久化 session 时错误文案含恢复指引（§6.9/§7.3）', async () => {
    // 真 restoreSession 的 not-found 分支：scanSessions 恒 [] → findScannedSession 落空，
    // 在任何磁盘读/spawn 之前 throw，无 IO。
    const { svc } = makeEnv(() => undefined)

    await expect(svc.restoreSession('nope-session')).rejects.toThrow(
      'Persisted session nope-session not found — 该会话无已保存内容（进程在首次保存前退出），请新建会话',
    )
    await expect(svc.restoreSession('nope-session')).rejects.toThrow('请新建会话')
  })
})
