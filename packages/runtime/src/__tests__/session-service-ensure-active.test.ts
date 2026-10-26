/**
 * SessionService.ensureActive（exited 防御 / btw 分支 / W09 单通道验收）合并测试。
 *
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper/mock 随节下沉）：
 * - session-service-ensure-active.test.ts
 * - btw-ensure-branch.test.ts
 * - w09-single-channel-v1.test.ts
 *
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/session-service-ensure-active.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServerMessage, SessionSummary } from '@taiji/shared'
import type { IMessageBroker } from '../interfaces.js'
import { MessageBus } from '../services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import { BtwError } from '../services/session/btw-service.js'
import { SessionService } from '../services/session/session-service.js'

describe('session-service-ensure-active', () => {
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
})

describe('btw-ensure-branch', () => {
/**
 * ensureActive 的 btw 分支（btw-question B3 裁决，M2-b）——回收后续问的附着入口。
 *
 * 锁定语义：
 * - btw 线 session id + 已注入 BtwService → 转 ensureProcess（自建附着编排：alive → markActivity
 *   直返 / 回收死亡 → spawn→switch→附着断言 reattach，D1⑥/V5），分支先于既有
 *   pm.getClient / restore 链（restore 路径 findScannedSession 只扫 sessions/，对 btw 线
 *   构造性失败——V5 核实结论）；
 * - 非 btw sid + 已注入 → 分支不命中，既有链零变更；
 * - btw 线 session id + 未注入 BtwService（存量测试构造）→ fall through 零变更；
 * - 附着失败 BtwError 原样上抛（code 保留）——message.send 路径由
 *   dispatcher.ensureActiveOrBroadcast 统一处理 message.error（错误文案带恢复指引）。
 *
 * 构造模式：session-service-ensure-active.test.ts 的 makeEnv 轻量桩（mock pm/broker/
 * adapterFactory，未被测路径的依赖给最小桩）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/btw-ensure-branch.test.ts
 */
/** btw 线 session id（W4a 键统一后 = pi 真实会话 id，与生产同形态）。 */
const LINE_ID = 'thread-para'

/** 最小假 client：ensureActive 分支只消费身份。 */
function makeClient(exited: boolean): IPiEngine {
  return { exited } as unknown as IPiEngine
}

function makeEnv(getClientImpl: (sessionId: string) => IPiEngine | undefined) {
  const broker = { broadcast: vi.fn((_: ServerMessage) => {}) } as unknown as IMessageBroker
  const getClient = vi.fn(getClientImpl)
  const pm = {
    onSessionExit: vi.fn(() => () => {}),
    getClient,
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
    {} as never, // workspaceService
  )
  return { svc, pm, getClient }
}

describe('SessionService.ensureActive · btw 分支（B3 裁决，M2-b）', () => {
  it('btw 线 session id + 已注入 BtwService → 转 ensureProcess，不进 pm.getClient / restore 链', async () => {
    const attached = makeClient(false)
    const ensureProcess = vi.fn(async () => attached)
    const { svc, getClient } = makeEnv(() => {
      throw new Error('pm.getClient 不应被调用（btw 分支先于既有链）')
    })
    // W4a 判别器 = registry 成员查询（getLine 注入；旧 isBtwVirtualId 前缀判别已删）
    svc.setBtwService({ ensureProcess, getLine: ((id: string) => (id === LINE_ID ? { mainSid: 'main-x' } : undefined)) as never })
    const restoreSpy = vi.spyOn(svc, 'restoreSession')

    const got = await svc.ensureActive(LINE_ID)

    expect(got).toBe(attached)
    expect(ensureProcess).toHaveBeenCalledTimes(1)
    expect(ensureProcess).toHaveBeenCalledWith(LINE_ID)
    expect(getClient).not.toHaveBeenCalled()
    expect(restoreSpy).not.toHaveBeenCalled()
    restoreSpy.mockRestore()
  })

  it('非 btw sid + 已注入 BtwService → 分支不命中，既有链零变更', async () => {
    const live = makeClient(false)
    const ensureProcess = vi.fn()
    const { svc, getClient } = makeEnv(() => live)
    svc.setBtwService({ ensureProcess })
    // 快路径前提 = 完整注册态 [switch-race-window]：活 client + Map 缺条目 = 恢复窗口
    // 半成品，会走恢复内核而非快路径——initializeManagedSession 播种注册态
    await svc.initializeManagedSession('plain-session', live, '/test/cwd', 'label')

    const got = await svc.ensureActive('plain-session')

    expect(got).toBe(live)
    expect(ensureProcess).not.toHaveBeenCalled()
    expect(getClient).toHaveBeenCalledWith('plain-session')
  })

  it('btw 线 session id + 未注入 BtwService → fall through 既有链（存量构造零变更）', async () => {
    const live = makeClient(false)
    const { svc, getClient } = makeEnv(() => live)
    // 快路径前提 = 完整注册态 [switch-race-window]（同上）
    await svc.initializeManagedSession(LINE_ID, live, '/test/cwd', 'label')

    const got = await svc.ensureActive(LINE_ID)

    expect(got).toBe(live)
    expect(getClient).toHaveBeenCalledWith(LINE_ID)
  })

  it('附着失败：BtwError 原样上抛且 code 保留（message.error 收尾链的输入契约）', async () => {
    const ensureProcess = vi.fn(async () => {
      throw new BtwError('thread_file_missing', `[btw] thread session file missing (line had never flushed): /x/${LINE_ID}`)
    })
    const { svc } = makeEnv(() => undefined)
    // getLine 注入命中 = btw 线分支（W4a 判别器）
    svc.setBtwService({ ensureProcess, getLine: ((id: string) => (id === LINE_ID ? { mainSid: 'main-x' } : undefined)) as never })

    await expect(svc.ensureActive(LINE_ID)).rejects.toMatchObject({
      name: 'BtwError',
      code: 'thread_file_missing',
      message: expect.stringContaining('line had never flushed'),
    })
  })
})
})

describe('w09-single-channel-v1', () => {
/**
 * W09 单通道确定性验收（02 文档 §4 V1 的脚本化断言，wave:perf-w09 D1-2）。
 *
 * V1 原文：「同一 session 级消息在 send/bus 层只被 JSON.stringify 一次（ws 层打点计数 = 1）、
 * 只推给订阅该 sid 的连接」。本文件把两条都做成确定性断言（不依赖真实 ws / 真实 pi）：
 *
 * - TC-V1a（bus 层）：publish 一条 stream 消息 → JSON.stringify 恰好 1 次；
 *   订阅该 sid 的 ws 收到 1 条、订阅其它 sid 的 ws / 未订阅 ws 均 0 条。
 * - TC-V1b（send 层集成）：SessionService 的 send 回调（EventAdapter 透传路径）转发
 *   session 级消息 → 全程 JSON.stringify 恰好 1 次（只有 bus 的定向推送一次），
 *   broker.broadcast 0 次（盲广播路径已删）。
 * - TC-V1c（transient）：delta 类不占 seq，同一窗口 stringify 仍恰好 1 次。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/w09-single-channel-v1.test.ts
 */
/** mock ws（BusClient 契约：readyState + send），收集收到的原始 payload 字符串。 */
function createMockWs() {
  const sent: string[] = []
  return {
    readyState: 1 as const,
    sent,
    send: (payload: string) => { sent.push(payload) },
  }
}

/**
 * 构造真实 SessionService + 真实 MessageBus（对齐 session-service-w07-bus.test.ts 的 makeEnv），
 * sendCb 捕获 initializeManagedSession 注入 adapterFactory 的 send 回调。
 */
function makeEnv() {
  const broadcasts: ServerMessage[] = []
  const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker

  const client = { getCommands: vi.fn(async () => []) } as unknown as IPiEngine
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client),
  } as unknown as IProcessManager

  let sendCb: ((msg: ServerMessage) => void) | null = null
  const captureAdapterFactory = (_sid: string, send: (msg: ServerMessage) => void) => {
    sendCb = send
    return { attach: vi.fn(), detach: vi.fn() }
  }

  const bus = new MessageBus()
  const svc = new SessionService(
    pm,
    broker,
    captureAdapterFactory,
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never,
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never,
    { pruneStaleCache: vi.fn() } as never,
    {} as never, // workspaceService
    bus,
  )
  svc.setMessageBus(bus)
  return { svc, bus, broker, broadcasts, getSendCb: () => sendCb! }
}

describe('W09 单通道确定性验收（02 §4 V1）', () => {
  let stringifySpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stringifySpy = vi.spyOn(JSON, 'stringify')
  })
  afterEach(() => {
    stringifySpy.mockRestore()
  })

  it('TC-V1a: bus.publish 一条 stream 消息 → JSON.stringify 恰好 1 次 + 只推订阅该 sid 的连接', () => {
    const bus = new MessageBus()
    const wsA = createMockWs() // 订阅 sid-1（目标 session）
    const wsB = createMockWs() // 订阅 sid-2（其它 session）
    const wsC = createMockWs() // 未订阅任何 session
    bus.subscribe('sid-1', wsA)
    bus.subscribe('sid-2', wsB)

    stringifySpy.mockClear()
    bus.publish('sid-1', { type: 'message.status', payload: { sessionId: 'sid-1', status: 'thinking' } })

    // 只序列化一次（三个连接总共一次 stringify——序列化与订阅者数解耦）
    expect(stringifySpy).toHaveBeenCalledTimes(1)
    // 只有订阅 sid-1 的连接收到，恰好 1 条
    expect(wsA.sent).toHaveLength(1)
    expect(JSON.parse(wsA.sent[0]!)).toMatchObject({ type: 'message.status', seq: 1 })
    // 订阅其它 sid 的连接、未订阅连接均未收到（V1：每个 panel 只收到自己 session 的消息）
    expect(wsB.sent).toHaveLength(0)
    expect(wsC.sent).toHaveLength(0)
  })

  it('TC-V1b: send 层（SessionService send 回调）转发 session 级消息 → 全程 stringify 恰好 1 次、broadcast 0 次', async () => {
    const { svc, bus, broker, broadcasts, getSendCb } = makeEnv()
    await svc.initializeManagedSession('s-v1', {} as unknown as IPiEngine, '/tmp', 'test')
    const send = getSendCb()

    const online = createMockWs()
    bus.subscribe('s-v1', online)

    stringifySpy.mockClear()
    send({ type: 'message.status', payload: { sessionId: 's-v1', status: 'thinking' } })

    // 单次序列化：send 回调 → bus.publish（seq + ring + 定向推送）是唯一出口，
    // broker.broadcast 路径已删（D1-2），全程 stringify 计数 = 1。
    // 注：registerSession 汇聚点原 session.surfaces 全局广播（W4a 判别器通道）已随 W4b
    // 收编按协议收缩删除——本断言的对象是 send 层转发路径，全局注册事实帧不在单通道管辖范围。
    expect(stringifySpy).toHaveBeenCalledTimes(1)
    expect(broadcasts).toHaveLength(0)
    // 订阅者收到 1 条带 seq 的消息
    expect(online.sent).toHaveLength(1)
    const parsed = JSON.parse(online.sent[0]!) as ServerMessage & { seq?: number }
    expect(parsed.type).toBe('message.status')
    expect(typeof parsed.seq).toBe('number')
  })

  it('TC-V1c: transient delta 不占 seq，同窗口 stringify 仍恰好 1 次', async () => {
    const { svc, bus, getSendCb } = makeEnv()
    await svc.initializeManagedSession('s-v1', {} as unknown as IPiEngine, '/tmp', 'test')
    const send = getSendCb()

    const online = createMockWs()
    bus.subscribe('s-v1', online)

    stringifySpy.mockClear()
    send({ type: 'message.text_delta', payload: { sessionId: 's-v1', delta: 'hi' } })

    expect(stringifySpy).toHaveBeenCalledTimes(1)
    expect(online.sent).toHaveLength(1)
    // transient 类不分配 seq（D5-1）
    const parsed = JSON.parse(online.sent[0]!) as { type: string; seq?: number }
    expect(parsed.type).toBe('message.text_delta')
    expect(parsed.seq).toBeUndefined()
  })
})
})
