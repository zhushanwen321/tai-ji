/**
 * ensureActive exited 防御 + 恢复窗口注册态测试（fix-respawn-pi Wave 2 + switch-race-window）。
 *
 * 锁定语义：
 * - 快路径前提 = 完整注册态（client 存活 + sessions Map 条目在）[switch-race-window]：
 *   恢复窗口内（spawn 已登记 client、registerSession 未落 Map）直返半成品 client 会让
 *   调用方随后的 getSummary 等派生读点落空（「切换失败但实际能进」竞态根因）——条目缺失
 *   一律经 ensureRestored join 在途恢复或走内核自愈，不直返；
 * - 死 client（exited=true，processes Map 竞态残留）视同无 client 走 restore 内核，
 *   返回 restore 后的新活 client（纵深防御——上游清理竞态时消费端不把死 client 交给 prompt）；
 * - 并发 restore join（crash-resilience D7-③，u8 改造）：同 sessionId 的并发 ensureActive
 *   等待同一 in-flight restore Promise（不报错不双跑，只 restore 一次）——[HISTORICAL]
 *   原为第二个调用被 already being restored 拒绝（throw），随 D7-③ 改造同步更新；
 * - restoreSession 找不到持久化 session 时错误文案含恢复指引「请新建会话」（§6.9/§7.3，
 *   白盒表「SESSION_NOT_FOUND 恢复指引文案」断言项）。
 *
 * restore 内核 mock 策略 [switch-race-window]：恢复执行内核 = RespawnDeps.restore 直连
 * lifecycle.restoreSession（facade.restoreSession 只是 join 包装）——门控恢复执行须 spy
 * lifecycle（spyRestoreKernel helper，private 字段经类型收窄访问）；spy facade 只能拦截
 * 手动 restore 入口自身，拦不到 ensureActive 的恢复链。快路径用例经 initializeManagedSession
 * （registerSession 汇聚点的公开测试通道）播种注册态，不触碰 spawn 链 / 真实文件系统。
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

/** restore 执行内核 spy 挂点（lifecycle 为 private，类型收窄访问；理由见文件头 mock 策略）。 */
function spyRestoreKernel(svc: SessionService) {
  const lc = svc as unknown as { lifecycle: { restoreSession: (sessionId: string) => Promise<SessionSummary> } }
  return vi.spyOn(lc.lifecycle, 'restoreSession')
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

describe('SessionService.ensureActive（exited 防御 + 恢复窗口注册态）', () => {
  it('完整注册态（client 存活 + Map 条目在）快路径直返，不触发 restore 内核', async () => {
    const live = makeClient(false)
    const { svc } = makeEnv(() => live)
    await svc.initializeManagedSession('sid-live', live, '/test/cwd', 'label')
    const kernelSpy = spyRestoreKernel(svc)

    const got = await svc.ensureActive('sid-live')

    expect(got).toBe(live)
    expect(kernelSpy).not.toHaveBeenCalled()
    kernelSpy.mockRestore()
  })

  it('恢复窗口半成品（client 存活但 Map 条目缺失）不直返：经恢复内核补全注册态（switch-race-window）', async () => {
    const orphan = makeClient(false)
    const { svc } = makeEnv(() => orphan)
    // 不注册播种 → 活 client 也必须走恢复内核（join 在途或自愈），不得快路径直返半成品
    const kernelSpy = spyRestoreKernel(svc).mockResolvedValue({ id: 'sid-orphan' } as SessionSummary)

    const got = await svc.ensureActive('sid-orphan')

    expect(kernelSpy).toHaveBeenCalledTimes(1)
    // 内核替身未重开进程：恢复完成后 getClient 仍返回原 client
    expect(got).toBe(orphan)
    kernelSpy.mockRestore()
  })

  it('死 client（exited=true）视同无 client 走 restore 内核，返回 restore 后的新活 client', async () => {
    const dead = makeClient(true)
    const fresh = makeClient(false)
    // 第一次 getClient：processes Map 竞态残留的死 client；restore 完成后的第二次：新活 client
    let getCalls = 0
    const { svc } = makeEnv(() => {
      getCalls++
      return getCalls === 1 ? dead : fresh
    })
    const kernelSpy = spyRestoreKernel(svc).mockResolvedValue({ id: 'sid-dead' } as SessionSummary)

    const got = await svc.ensureActive('sid-dead')

    // 关键断言：死 client 不直通 prompt，restore 后拿到的是新活 client
    expect(got).not.toBe(dead)
    expect(got).toBe(fresh)
    expect(kernelSpy).toHaveBeenCalledTimes(1)
    expect(kernelSpy).toHaveBeenCalledWith('sid-dead')
    kernelSpy.mockRestore()
  })

  it('并发 ensureActive 同一 sessionId：join 语义——等待同一 in-flight restore，不报错不双跑（crash-resilience D7-③）', async () => {
    // [HISTORICAL] 本用例原断言第二个并发调用被 already being restored 拒绝（throw 语义）；
    // u8（crash-resilience D7-③）把 throw 改为 join：自动恢复落地后恢复窗口内用户发消息
    // 是常态路径，第二个调用必须等待同一 in-flight Promise 完成后继续。
    const { svc } = makeEnv(() => undefined)
    // 让 restore 内核挂起，模拟并发 restore 窗口
    let resolveRestore!: (v: SessionSummary) => void
    const pending = new Promise<SessionSummary>((r) => { resolveRestore = r })
    const kernelSpy = spyRestoreKernel(svc).mockReturnValueOnce(pending)

    const first = svc.ensureActive('sid-dedup')
    const second = svc.ensureActive('sid-dedup')
    // join：restore 内核只进入一次（没有第二路并发 restore）
    expect(kernelSpy).toHaveBeenCalledTimes(1)
    resolveRestore({} as SessionSummary)
    // 双方都等恢复完成后继续；随后都因 getClient 无 client 而 reject（符合无进程的真实场景，
    // 同一失败 = join 透传）
    await expect(first).rejects.toThrow('client not available')
    await expect(second).rejects.toThrow('client not available')
    expect(kernelSpy).toHaveBeenCalledTimes(1)
    kernelSpy.mockRestore()
  })

  it('seat 缺省（未注入）时 restore 内核同步进入：ensureActive() 调用零微任务让步（idle-pi-reclamation u2 回归锁定）', async () => {
    // u2（idle-pi-reclamation D6-2）曾把 seat 等待写成无条件 `await awaitReclaimSeatRelease`：
    // async 函数即使 seat 缺省同步 return，await 也让 restore 入口晚一个微任务，破坏
    // 「seat 缺省 = 行为不变」契约（同步断言 spy 次数得 0；respawn ③b 的 deferred 注册
    // 窗口失效 → 5s 超时）。现实现为同步短路检查：seat 未命中不产生任何微任务——
    // 本用例在首个 await 之前同步断言 restore 已进入，锁定零让步属性。
    const { svc } = makeEnv(() => undefined)
    const kernelSpy = spyRestoreKernel(svc).mockResolvedValue({} as SessionSummary)

    const active = svc.ensureActive('sid-sync-entry')

    // 同步断言（位于任何 await 之前）：restore 内核在 ensureActive() 调用的同步执行段内已进入
    expect(kernelSpy).toHaveBeenCalledTimes(1)

    // 收尾消费 rejection（restore 完成后 getClient 无 client，符合无进程场景），防 unhandled
    await expect(active).rejects.toThrow('client not available')
    kernelSpy.mockRestore()
  })

  it('restoreSession 找不到持久化 session 时错误文案含恢复指引（§6.9/§7.3）', async () => {
    // 真 restoreSession 的 not-found 分支：scanSessions 恒 [] → findScannedSession 落空，
    // 在任何磁盘读/spawn 之前 throw，无 IO。错误经 ensureRestored join 注册表原样透传 facade。
    const { svc } = makeEnv(() => undefined)

    await expect(svc.restoreSession('nope-session')).rejects.toThrow(
      'Persisted session nope-session not found — 该会话无已保存内容（进程在首次保存前退出），请新建会话',
    )
    await expect(svc.restoreSession('nope-session')).rejects.toThrow('请新建会话')
  })
})
