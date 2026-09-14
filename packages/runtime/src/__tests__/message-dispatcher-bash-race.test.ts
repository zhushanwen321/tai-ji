/**
 * MessageDispatcher 竞态守卫测试（PR#116 review W1 + W3）。
 *
 * 锁定：
 * - W1: sendBash 在 await client.bash() 期间被 abortBash 抢先收口时，
 *   pi 响应到达后 sendBash 静默跳过终态广播（不重复广播 bashResult / message.error）。
 *   验证两条终态不会同时出现：cancelled bashResult（来自 abortBash）+ 真实 output bashResult（来自 sendBash）。
 * - W1b: sendBash await 抛错时若已被 abortBash 抢先收口，也不广播 message.error（避免双重报错）。
 * - W3: compact() 在 isBashRunning=true 或 isGenerating=true 时被拒（广播 session.compacted{error} + throw）。
 *
 * 运行：npx vitest run src/__tests__/message-dispatcher-bash-race.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageDispatcher } from '../services/session/message-dispatcher.js'
import { applySessionOccupancyTransition } from '../services/session/event-interpreter.js'
import type { IDispatcherSessionOps } from '../services/session/session-internal.js'
import type { IManagedSessionView } from '../services/session/types.js'
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager, PiBashResult } from '../services/ports/pi-engine.js'
import type { ServerMessage } from '@xyz-agent/shared'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'

type BashResultMsg = ServerMessage<'message.bashResult'>
/** 返回所有 message.bashResult 广播（W1 竞态需断言「总数==1」故需数组而非首条）。 */
function findBashResults(b: ServerMessage[]): BashResultMsg[] {
  return b.filter((m): m is BashResultMsg => m.type === 'message.bashResult')
}

function makeMockSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    ...overrides,
  }
}

/**
 * W1 专用 mock：client.bash 用可控 Promise（bashResolve/bashReject），
 * 调用方可在 sendBash await 期间触发 abortBash，再 resolve/reject client.bash。
 */
function makeRaceMocks() {
  const session = makeMockSession()

  let bashResolve!: (r: PiBashResult) => void
  let bashReject!: (e: Error) => void
  const bashPromise = new Promise<PiBashResult>((res, rej) => {
    bashResolve = res
    bashReject = rej
  })
  const bashFn = vi.fn(() => bashPromise)
  const abortBashFn = vi.fn(async () => ({}) as Awaited<ReturnType<IPiEngine['abortBash']>>)
  const compactFn = vi.fn(async () => ({}) as Awaited<ReturnType<IPiEngine['compact']>>)

  const client = {
    prompt: vi.fn(async () => ({})),
    bash: bashFn,
    abortBash: abortBashFn,
    compact: compactFn,
  } as unknown as IPiEngine

  // wave:perf-w09（D1-2）：dispatcher 只依赖 publish 抽象（broker 双写腿已删），mock bus 收集发布消息
  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus

  // S2 ISP 化：结构性满足 dispatcher 窄接口（6 方法 = 实际消费面），无强转
  const svc: IDispatcherSessionOps = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    getSession: vi.fn(),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  }

  const pm = { getClient: vi.fn(() => client) } as unknown as IProcessManager
  const workspace = { record: vi.fn() } as unknown as WorkspaceService

  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  return { dispatcher, session, bashFn, abortBashFn, compactFn, broadcasts, bashResolve, bashReject }
}

describe('MessageDispatcher —— W1 abortBash/sendBash 竞态守卫', () => {
  beforeEach(() => vi.clearAllMocks())

  it('W1a: abortBash 在 sendBash await 期间抢先收口后，pi resolve 到达时 sendBash 仍发布真实 bashResult（D1 closure——与 pi 落盘一致，例外①消灭）', async () => {
    const { dispatcher, broadcasts, bashResolve, abortBashFn } = makeRaceMocks()

    // sendBash 启动，await client.bash() 挂起
    const sendPromise = dispatcher.sendBash('s1', 'long-running-cmd', false)
    await Promise.resolve() // 让 sendBash 跑到 await client.bash

    // 此时 bashStart 已广播，client.bash 已被调用（pending）
    expect(broadcasts.some((m) => m.type === 'message.bashStart')).toBe(true)
    expect(abortBashFn).not.toHaveBeenCalled()

    // 用户调 abortBash：广播哨兵帧 cancelled bashResult（command:''，bash-effects 只清态不产 entry）
    await dispatcher.abortBash('s1')
    expect(abortBashFn).toHaveBeenCalledTimes(1)
    const cancelledResults = broadcasts.filter(
      (m) => m.type === 'message.bashResult' && (m as BashResultMsg).payload.cancelled === true,
    )
    expect(cancelledResults).toHaveLength(1)

    // pi 响应到达：client.bash resolve 带真实 output
    bashResolve({ output: 'real output', exitCode: 0, cancelled: false, truncated: false })
    const result = await sendPromise

    // 关键断言（D1 closure 修订，conversation-turn-attribution-closure D1）：旧逻辑静默跳过
    // 导致 pi 文件有 entry 而 live 无（登记例外①）；新逻辑发布真实数据——两条帧职责正交
    // （哨兵只清态、真实帧产 entry，均幂等），双终态担忧不成立。bashResult 总数 = 2。
    const allResults = findBashResults(broadcasts)
    expect(allResults).toHaveLength(2)
    // 第一条 = abortBash 哨兵（command:'' + cancelled:true 两字段共同构成哨兵形态，缺一不可——
    // bash-effects 判定依赖该不变式，锁定防未来改字段）
    expect(allResults[0]!.payload).toMatchObject({ command: '', cancelled: true })
    // 第二条 = sendBash 发布的真实数据（token 已旋转仍发布；cancelled 随 pi 返回值透传——
    // mock 刻意用 cancelled:false 显式验证「guard 命中与结果 cancelled 与否正交、照发不筛」）
    expect(allResults[1]!.payload).toMatchObject({ output: 'real output', cancelled: false })

    // 不广播 message.error（pi 是正常 resolve，无错误）
    expect(broadcasts.some((m) => m.type === 'message.error')).toBe(false)

    // sendBash 正常完成（发布路径走完）
    expect(result).toEqual({ blocked: false })
  })

  it('W1b: abortBash 抢先收口后，client.bash reject 到达时 sendBash 不广播 message.error（避免双重报错）', async () => {
    const { dispatcher, broadcasts, bashReject } = makeRaceMocks()

    const sendPromise = dispatcher.sendBash('s1', 'doomed-cmd', false)
    await Promise.resolve()

    // abortBash 抢先收口（广播 cancelled bashResult）
    await dispatcher.abortBash('s1')
    const cancelledCount = broadcasts.filter(
      (m) => m.type === 'message.bashResult' && (m as BashResultMsg).payload.cancelled === true,
    ).length
    expect(cancelledCount).toBe(1)

    // pi 响应到达：client.bash reject
    bashReject(new Error('stream closed by abort'))
    const result = await sendPromise

    // 关键断言：sendBash 检测到被 abort 抢先收口，不广播 message.error
    // （cancelled bashResult 已是终态，再补 message.error 会双重报错）。
    expect(broadcasts.some((m) => m.type === 'message.error')).toBe(false)

    // 仍只有 abortBash 广播的那条 cancelled bashResult，无 S2 兜底 bashResult（因已被 abort 抢先）
    const allResults = findBashResults(broadcasts)
    expect(allResults).toHaveLength(1)
    expect(allResults[0]!.payload.cancelled).toBe(true)

    expect(result).toEqual({ blocked: true })
  })

  it('W1c: 无 abort 时 sendBash 正常广播真实 bashResult（守卫不影响正常路径）', async () => {
    const { dispatcher, broadcasts, bashResolve } = makeRaceMocks()

    const sendPromise = dispatcher.sendBash('s1', 'normal-cmd', false)
    await Promise.resolve()

    // 无 abort：pi 正常 resolve
    bashResolve({ output: 'done', exitCode: 0, cancelled: false, truncated: false })
    const result = await sendPromise

    // 正常广播真实 bashResult（cancelled:false）
    const allResults = findBashResults(broadcasts)
    expect(allResults).toHaveLength(1)
    expect(allResults[0]!.payload).toMatchObject({ output: 'done', exitCode: 0, cancelled: false })
    // 不广播 message.error
    expect(broadcasts.some((m) => m.type === 'message.error')).toBe(false)
    expect(result).toEqual({ blocked: false })
  })
})

// [2026-09 测试舰队审查 r2-21] 'W3 compact busy 预检' describe（3 用例）已删：
// 与 message-dispatcher-compact.test.ts 的 TC5-busy预检（isBashRunning/isGenerating）+
// TC5-成功（正常进入压缩 + 零广播）逐条重复（同断言集合），compact dispatcher
// 唯一归并地在彼文件；本文件保留 W1 bashRunToken 竞态段（无重复替身）。
