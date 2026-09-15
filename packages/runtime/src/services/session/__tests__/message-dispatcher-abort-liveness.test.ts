/**
 * MessageDispatcher abort RPC 超时路径——三信号判据 + 三级阶梯测试
 * （chat-domain-v1x-liveness-governance W7 / 设计 §3.2 D3）。
 *
 * 锁定（验收：每级有终点断言无无界重试；阶梯 1 耗尽 → 阶梯 2 迁移断言；真冻结直达强杀
 * 断言；正常收敛零误判断言）：
 * - L0: abort 秒级收敛 → 零误判（无探测 / 无重试 / 无强杀，走成功收口）
 * - L1: 探测有响应 + 重试收敛 → 终点 A（message.complete{aborted} + stopped）
 * - L1x: 重试耗尽（探测仍响应）→ 迁移阶梯 2（message.error 指引，不杀）；abort 恰
 *        1+ABORT_STALL_RETRY_LIMIT 次、探测次数有界（无无界重试断言）
 * - L2: 探测无响应 + 事件窗有产出（事故形态：RPC 饿死）→ message.error + 不杀
 * - L2m: 阶梯 1 中途探测失联 → 落事件窗判定（近窗有产出 → 阶梯 2）
 * - L3: 探测无响应 + 事件窗静默超保守窗（真冻结）→ 直达强杀（forceQuitSession 全链）
 * - L3c: 窗值 env 可配置（TAIJI_RUNTIME_ABORT_FROZEN_SILENCE_MS 生效翻转判定）
 * - R1: 防重入——并发 abort 超时共享同一阶梯（探测/重试次数不翻倍）
 * - R2: 阶梯判定期间 session 被用户处置（client 解绑）→ 阶梯静默中止
 * - E1: RpcClient.lastEventAt 记录语义（事件帧更新 / response 帧不更新 / 无事件 undefined）
 *
 * mock 模式参考 src/__tests__/message-dispatcher-force-quit.test.ts 的 makeMocks。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/message-dispatcher-abort-liveness.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MessageDispatcher, resetAbortLivenessForTest } from '../message-dispatcher.js'
import { RpcTimeoutError } from '../../../utils/errors.js'
import type { IDispatcherSessionOps } from '../session-internal.js'
import type { IManagedSessionView } from '../types.js'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { IPiEngine, IProcessManager } from '../../ports/pi-engine.js'
import type { ServerMessage } from '@taiji/shared'
import type { WorkspaceService } from '../../workspace/workspace-service.js'

/** abort() / getState() 序列脚本：按调用序消费，越界回退 'ok'。 */
interface ClientScript {
  abortResults: Array<'ok' | 'timeout' | Error>
  probeResults: Array<'ok' | 'fail'>
  /** 模拟 RpcClient.lastEventAt（W7 桥事件窗信号）；undefined = 无该成员（旧形态/mock） */
  lastEventAt?: number
}

interface LadderMocks {
  dispatcher: MessageDispatcher
  client: { abort: ReturnType<typeof vi.fn>; getState: ReturnType<typeof vi.fn>; lastEventAt?: number }
  destroySessionFn: ReturnType<typeof vi.fn>
  persistOutcomeFn: ReturnType<typeof vi.fn>
  broadcasts: ServerMessage[]
  /** 重新绑定控制：置 undefined 模拟「阶梯判定期间 session 被处置」（R2） */
  setClientBinding: (c: unknown) => void
}

function makeMockSession(): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: true,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
  }
}

function makeMocks(script: ClientScript): LadderMocks {
  let abortIdx = 0
  let probeIdx = 0
  const client = {
    abort: vi.fn(async () => {
      const r = script.abortResults[abortIdx++] ?? 'ok'
      if (r === 'timeout') throw new RpcTimeoutError('abort', 60_000)
      if (r instanceof Error) throw r
      return {}
    }),
    getState: vi.fn(async () => {
      const r = script.probeResults[probeIdx++] ?? 'ok'
      if (r === 'fail') throw new RpcTimeoutError('get_state', 10_000)
      return {}
    }),
    ...(script.lastEventAt !== undefined ? { lastEventAt: script.lastEventAt } : {}),
  }

  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus

  const svc: IDispatcherSessionOps = {
    getSessionByClient: vi.fn(() => makeMockSession()),
    detachSession: vi.fn(),
    persistSessionOutcome: vi.fn(),
    removeSessionEntry: vi.fn(),
    ensureActive: vi.fn(),
    getSession: vi.fn(() => makeMockSession()),
  }

  let boundClient: unknown = client
  const pm = {
    getClient: vi.fn(() => boundClient),
    destroySession: vi.fn(async () => {}),
  } as unknown as IProcessManager

  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  return {
    dispatcher,
    client,
    destroySessionFn: pm.destroySession as ReturnType<typeof vi.fn>,
    persistOutcomeFn: svc.persistSessionOutcome as ReturnType<typeof vi.fn>,
    broadcasts,
    setClientBinding: (c: unknown) => { boundClient = c },
  }
}

/** 从广播集合里取指定 type 的消息（忽略 session.occupancy 等状态帧干扰）。 */
function findBroadcast(b: ServerMessage[], type: string): ServerMessage | undefined {
  return b.find((m) => m.type === type)
}

beforeEach(() => {
  resetAbortLivenessForTest()
  delete process.env.TAIJI_RUNTIME_ABORT_FROZEN_SILENCE_MS
})

afterEach(() => {
  delete process.env.TAIJI_RUNTIME_ABORT_FROZEN_SILENCE_MS
  vi.restoreAllMocks()
})

describe('abort RPC 超时三级阶梯 —— 正常收敛与阶梯 1（有界重试）', () => {
  it('L0: abort 秒级收敛 → 零误判：无探测/无重试/无强杀，成功收口（stopped + message.complete{aborted}）', async () => {
    const m = makeMocks({ abortResults: ['ok'], probeResults: [] })

    await m.dispatcher.abort('s1')

    expect(m.client.abort).toHaveBeenCalledTimes(1)
    expect(m.client.getState).not.toHaveBeenCalled()
    expect(m.destroySessionFn).not.toHaveBeenCalled()
    expect(m.persistOutcomeFn).toHaveBeenCalledWith('s1', 'stopped', 'User aborted')
    const complete = findBroadcast(m.broadcasts, 'message.complete')
    expect(complete).toMatchObject({ payload: { sessionId: 's1', stopReason: 'aborted' } })
    expect(findBroadcast(m.broadcasts, 'message.error')).toBeUndefined()
  })

  it('L1: 探测有响应 + 重试收敛 → 终点 A：message.complete{aborted} + stopped（retry 诊断），不杀进程', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = makeMocks({ abortResults: ['timeout', 'ok'], probeResults: ['ok'] })

    await m.dispatcher.abort('s1')

    // 有界性：原始 1 次 + 重试 1 次即收敛，不再增长
    expect(m.client.abort).toHaveBeenCalledTimes(2)
    expect(m.client.getState).toHaveBeenCalledTimes(1)
    expect(m.destroySessionFn).not.toHaveBeenCalled()
    expect(m.persistOutcomeFn).toHaveBeenCalledWith('s1', 'stopped', expect.stringContaining('stall retry 1/2'))
    expect(findBroadcast(m.broadcasts, 'message.complete')).toMatchObject({ payload: { stopReason: 'aborted' } })
    expect(findBroadcast(m.broadcasts, 'message.error')).toBeUndefined()
    // 上报「abort 迟滞」日志（阶梯 1 动作）
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('abort stalled but pi responsive'))
  })

  it('L1x: 重试耗尽（探测仍响应）→ 迁移阶梯 2：message.error 强制关闭指引，不杀进程；调用次数封顶（无无界重试）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = makeMocks({ abortResults: ['timeout', 'timeout', 'timeout'], probeResults: ['ok', 'ok', 'ok'] })

    await m.dispatcher.abort('s1')

    // 终点断言：abort 恰 1(原始)+2(重试上限)=3 次，不再增长；探测 = 入口 1 + 每次超时后复查 2
    expect(m.client.abort).toHaveBeenCalledTimes(3)
    expect(m.client.getState).toHaveBeenCalledTimes(3)
    expect(m.destroySessionFn).not.toHaveBeenCalled()
    expect(m.persistOutcomeFn).not.toHaveBeenCalled()
    const err = findBroadcast(m.broadcasts, 'message.error')
    expect(err).toBeDefined()
    // 用户显式动作出口 + 后果说明（阶梯 2 广播三要素）
    expect((err?.payload as { message: string }).message).toContain('强制退出')
    expect((err?.payload as { message: string }).message).toContain('恢复')
    expect(findBroadcast(m.broadcasts, 'message.complete')).toBeUndefined()
    expect(findBroadcast(m.broadcasts, 'session.exited')).toBeUndefined()
    // 迁移证据：迟滞日志（阶梯 1）与移交日志/广播（阶梯 2）同现
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bounded retry 1/2'))
  })
})

describe('abort RPC 超时三级阶梯 —— 阶梯 2（pi 活但 RPC 饿死）与阶梯 3（真冻结直杀）', () => {
  it('L2: 探测无响应 + 事件窗有产出（事故形态）→ message.error 指引 + 不杀进程 + 无终态谎报', async () => {
    const m = makeMocks({ abortResults: ['timeout'], probeResults: ['fail'], lastEventAt: Date.now() - 1_000 })

    await m.dispatcher.abort('s1')

    expect(m.client.abort).toHaveBeenCalledTimes(1)
    expect(m.client.getState).toHaveBeenCalledTimes(1)
    expect(m.destroySessionFn).not.toHaveBeenCalled()
    expect(m.persistOutcomeFn).not.toHaveBeenCalled()
    expect(findBroadcast(m.broadcasts, 'message.error')).toBeDefined()
    expect(findBroadcast(m.broadcasts, 'session.exited')).toBeUndefined()
  })

  it('L2m: 阶梯 1 中途探测失联 + 近窗有产出 → 落事件窗判定走阶梯 2（不空耗剩余重试名额）', async () => {
    const m = makeMocks({ abortResults: ['timeout', 'timeout'], probeResults: ['ok', 'fail'], lastEventAt: Date.now() - 500 })

    await m.dispatcher.abort('s1')

    // 中途失联即止：abort 恰 2 次（原始 + 重试 1），不再消耗第 2 个重试名额
    expect(m.client.abort).toHaveBeenCalledTimes(2)
    expect(m.destroySessionFn).not.toHaveBeenCalled()
    expect(findBroadcast(m.broadcasts, 'message.error')).toBeDefined()
  })

  it('L3: 探测无响应 + 事件窗静默超保守窗（真冻结）→ 直达强杀：forceQuitSession 全链收敛', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 默认窗 600s：lastEventAt 在 700s 前 → 静默超窗
    const m = makeMocks({ abortResults: ['timeout'], probeResults: ['fail'], lastEventAt: Date.now() - 700_000 })

    await m.dispatcher.abort('s1')

    expect(m.client.abort).toHaveBeenCalledTimes(1)
    expect(m.client.getState).toHaveBeenCalledTimes(1)
    expect(m.destroySessionFn).toHaveBeenCalledWith('s1')
    // record 如实：stopped 终态 + 冻结判据原因（探测无响应 + 静默秒数）
    expect(m.persistOutcomeFn).toHaveBeenCalledWith('s1', 'stopped', expect.stringContaining('pi frozen'))
    const exited = findBroadcast(m.broadcasts, 'session.exited')
    expect(exited).toMatchObject({ payload: { sessionId: 's1', code: null } })
    expect((exited?.payload as { reason: string }).reason).toContain('冻结')
    // 直杀判定日志（诊断）
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('force-destroying'))
  })

  it('L3c: 窗值 env 可配置——TAIJI_RUNTIME_ABORT_FROZEN_SILENCE_MS 收窄后同数据翻转为直杀', async () => {
    // 同一 lastEventAt（2s 前）：默认窗（600s）下属阶梯 2（近窗有产出）；env 收窄到 1s 后
    // 静默超窗 → 翻转阶梯 3。resetAbortLivenessForTest 清缓存后 env 才对场景 b 生效。
    const a = makeMocks({ abortResults: ['timeout'], probeResults: ['fail'], lastEventAt: Date.now() - 2_000 })
    await a.dispatcher.abort('s1')
    expect(a.destroySessionFn).not.toHaveBeenCalled()
    expect(findBroadcast(a.broadcasts, 'message.error')).toBeDefined()

    process.env.TAIJI_RUNTIME_ABORT_FROZEN_SILENCE_MS = '1000'
    resetAbortLivenessForTest()
    const b = makeMocks({ abortResults: ['timeout'], probeResults: ['fail'], lastEventAt: Date.now() - 2_000 })
    await b.dispatcher.abort('s1')
    expect(b.destroySessionFn).toHaveBeenCalledWith('s1')
    expect(findBroadcast(b.broadcasts, 'session.exited')).toBeDefined()
  })
})

describe('abort RPC 超时阶梯 —— 并发与处置竞态', () => {
  it('R1: 并发 abort 超时共享同一阶梯（防重入）——探测/重试次数不翻倍，终点广播恰一份', async () => {
    const m = makeMocks({ abortResults: ['timeout', 'timeout', 'ok'], probeResults: ['ok'] })

    await Promise.all([m.dispatcher.abort('s1'), m.dispatcher.abort('s1')])

    // 第二个超时 catch 复用进行中阶梯：总 abort = 原始 2 次（两个入口）+ 阶梯重试 1 次；
    // 若无防重入会各自跑阶梯（探测 ×2、广播 ×2）
    expect(m.client.abort).toHaveBeenCalledTimes(3)
    expect(m.client.getState).toHaveBeenCalledTimes(1)
    expect(findBroadcast(m.broadcasts, 'message.complete')).toBeDefined()
    expect(m.broadcasts.filter((b) => b.type === 'message.complete')).toHaveLength(1)
    expect(m.persistOutcomeFn).toHaveBeenCalledTimes(1)
  })

  it('R2: 阶梯判定期间 session 被用户处置（client 解绑）→ 阶梯静默中止，不再广播/重试', async () => {
    const m = makeMocks({ abortResults: ['timeout'], probeResults: ['ok'] })
    // 首个探测后解绑：getState 第一次调用后置 undefined（模拟用户已 forceQuit + removeEntry）
    let probes = 0
    const origGetState = m.client.getState
    m.client.getState = vi.fn(async (...args: unknown[]) => {
      const r = await (origGetState as (...a: unknown[]) => Promise<unknown>)(...args)
      if (++probes >= 1) m.setClientBinding(undefined)
      return r
    })

    await m.dispatcher.abort('s1')

    expect(m.client.abort).toHaveBeenCalledTimes(1)
    expect(findBroadcast(m.broadcasts, 'message.error')).toBeUndefined()
    expect(findBroadcast(m.broadcasts, 'message.complete')).toBeUndefined()
    expect(m.destroySessionFn).not.toHaveBeenCalled()
  })
})
