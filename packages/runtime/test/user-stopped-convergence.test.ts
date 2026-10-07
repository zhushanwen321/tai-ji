/**
 * userStopped 标记单测（原 D4 收敛环时间窗已随 ADR-0122 清查删除；本文件锁定
 * 事件顺序契约终态：标记存活期 = 旁路 turn 拦截存续期，标记清除只由显式意图
 * 事件驱动——显式投递 / 会话删除 / shutdown，无任何自动收敛）。
 *
 * 覆盖映射：
 * - UserStoppedGate 契约：标记存活 → agent_start 一律拦截再 abort；显式投递清标记
 *   放行；agent_settled 不清标记（同边沿补投击穿反例的契约锁）；
 * - interpreter 挂点接线：hook agent_start → noteAgentStart；
 * - dispatcher 置位分型：K1 forceQuit → source='user_force_quit'、K2 abort 超时强杀
 *   → source='abort_timeout'；
 * - sendPrompt / deliverText 显式投递清标记放行。
 *
 * mock 策略：全部依赖 mock，不 spawn pi。
 * 运行：cd packages/runtime && npx vitest run test/user-stopped-convergence.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  UserStoppedGate,
  userStoppedGate,
} from '../src/services/session/event-interpreter.js'
import { EventInterpreter } from '../src/services/session/event-interpreter.js'
import { MessageDispatcher } from '../src/services/session/message-dispatcher.js'
import {
  createSessionDeliveryRegistry,
} from '../src/services/session/session-delivery-registry.js'
import { RpcTimeoutError } from '../src/utils/errors.js'
import type { ServerMessage } from '@taiji/shared'
import type { UserStoppedMarkStore } from '../src/services/session/types.js'
import type { IDispatcherSessionOps } from '../src/services/session/session-internal.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { IMessageBus } from '../src/services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager } from '../src/services/ports/pi-engine.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import { flushDelivery } from './helpers/flush-delivery.js'

/** 记账式 mock 标记宿主（模拟 session-service.ts 模块级 Map 的语义）。 */
function makeMarkStore(): UserStoppedMarkStore & {
  marks: Map<string, { source: string }>
} {
  const marks = new Map<string, { source: string }>()
  return {
    marks,
    markUserStopped: vi.fn((sessionId: string, source: string) => { marks.set(sessionId, { source }) }),
    hasUserStoppedMark: vi.fn((sessionId: string) => marks.has(sessionId)),
    clearUserStoppedMark: vi.fn((sessionId: string) => { marks.delete(sessionId) }),
    clearAllUserStoppedMarks: vi.fn(() => marks.clear()),
  }
}

/** 组装 gate + 注入 mock 依赖（abort spy 可控）。 */
function makeGate() {
  const store = makeMarkStore()
  const abortSession = vi.fn<(sessionId: string) => Promise<void>>(async () => {})
  const gate = new UserStoppedGate()
  gate.configure({ marks: store, abortSession })
  return { gate, store, abortSession }
}

// ── Part A：UserStoppedGate 事件顺序契约 ──────────────────────

describe('UserStoppedGate 事件顺序契约（无自动收敛）', () => {
  it('标记存活：agent_start 一律拦截再 abort（多次旁路 turn 逐个掐）', () => {
    const { gate, store, abortSession } = makeGate()
    gate.markUserStopped('s1', 'user_force_quit')
    expect(store.hasUserStoppedMark('s1')).toBe(true)

    // 补发腿 #1：notify replay turn 开跑 → 拦截再 abort
    gate.noteAgentStart('s1')
    expect(abortSession).toHaveBeenCalledTimes(1)
    // 补发腿 #2（多通知场景第二条 parked 通知经下一 settled 边沿补投）
    gate.noteAgentStart('s1')
    expect(abortSession).toHaveBeenCalledTimes(2)
    // 标记未被任何事件清除（拦截持续到显式意图）
    expect(store.hasUserStoppedMark('s1')).toBe(true)
  })

  it('标记不在：agent_start 零拦截（正常会话/显式投递后零开销）', () => {
    const { gate, abortSession } = makeGate()
    gate.noteAgentStart('s1')
    expect(abortSession).not.toHaveBeenCalled()
  })

  it('agent_settled 不清标记（契约锁：被掐 turn 的 settled 边沿正是 notify-ledger 补投触发点，此处清标记会被同边沿补投击穿）', () => {
    const { gate, store, abortSession } = makeGate()
    gate.markUserStopped('s1', 'user_force_quit')
    gate.noteAgentStart('s1')
    expect(abortSession).toHaveBeenCalledTimes(1)

    // settled 边沿到达（模拟被掐 turn 收尾）：UserStoppedGate 无 settled 消费面——
    // 标记保持存活，下一补投 turn 仍被拦截
    expect(store.hasUserStoppedMark('s1')).toBe(true)
    gate.noteAgentStart('s1')
    expect(abortSession).toHaveBeenCalledTimes(2)
  })

  it('显式投递清标记放行：consumeForExplicitDelivery 清标记，后续 agent_start 不再被拦', () => {
    const { gate, store, abortSession } = makeGate()
    gate.markUserStopped('s1', 'user_force_quit')
    gate.consumeForExplicitDelivery('s1')
    expect(store.hasUserStoppedMark('s1')).toBe(false)
    // 新意图开 turn 的 agent_start（事件回流晚于清标记）不再被拦截
    gate.noteAgentStart('s1')
    expect(abortSession).not.toHaveBeenCalled()
  })

  it('disposeForDelete 清标记；disposeAll 清全部标记（destroyAll shutdown 路径）', () => {
    const { gate, store } = makeGate()
    gate.markUserStopped('a', 'user_force_quit')
    gate.markUserStopped('b', 'abort_timeout')
    gate.disposeForDelete('a')
    expect(store.hasUserStoppedMark('a')).toBe(false)
    expect(store.hasUserStoppedMark('b')).toBe(true)
    gate.disposeAll()
    expect(store.hasUserStoppedMark('b')).toBe(false)
  })

  // ── 未 configure 防御分支（R3 S-3 补测）：生产 SessionService 构造恒 configure，
  //    本组用例锁定降级语义，防回归成静默成功或裸 TypeError ──

  it('防御：未 configure 时 markUserStopped 降级 no-op（warn 出声不抛，标记不落盘）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const gate = new UserStoppedGate() // 未 configure（deps = null）
    expect(() => gate.markUserStopped('s1', 'user_force_quit')).not.toThrow()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls.map(String).join(' ')).toContain('userStoppedGate not configured')
    warnSpy.mockRestore()
  })

  it('未 configure（deps 缺省）：hasMark false，消费/观测 no-op 不抛（存量测试环境零接线兼容）', () => {
    const gate = new UserStoppedGate()
    expect(gate.hasUserStoppedMark('s1')).toBe(false)
    expect(() => gate.consumeForExplicitDelivery('s1')).not.toThrow()
    expect(() => gate.noteAgentStart('s1')).not.toThrow()
    expect(() => gate.disposeForDelete('s1')).not.toThrow()
  })
})

// ── Part B：interpreter 挂点接线（agent_start）──

describe('EventInterpreter userStopped 挂点接线', () => {
  afterEach(() => {
    userStoppedGate.resetForTest()
  })

  it('hook agent_start（标记存活）→ 触发拦截再 abort', () => {
    const store = makeMarkStore()
    const abortSession = vi.fn(async () => {})
    // 挂点读模块级单例——置标记必须作用在同一单例上（与生产 SessionService.configure 形态一致）
    userStoppedGate.configure({ marks: store, abortSession })
    userStoppedGate.markUserStopped('s1', 'user_force_quit')

    const sent: ServerMessage[] = []
    const interpreter = new EventInterpreter('s1', { send: (m) => { sent.push(m) } })
    interpreter.interpret([{ kind: 'hook', eventType: 'agent_start', data: {} }])
    expect(abortSession).toHaveBeenCalledTimes(1)
  })

  it('agent_settled 事件不清标记：settled 后的旁路 agent_start 仍被拦截（无自动收敛契约的挂点级锁定）', () => {
    const store = makeMarkStore()
    const abortSession = vi.fn(async () => {})
    userStoppedGate.configure({ marks: store, abortSession })
    userStoppedGate.markUserStopped('s1', 'user_force_quit')

    const sent: ServerMessage[] = []
    const interpreter = new EventInterpreter('s1', { send: (m) => { sent.push(m) } })
    interpreter.interpret([{ kind: 'hook', eventType: 'agent_start', data: {} }])
    expect(abortSession).toHaveBeenCalledTimes(1)
    // 被掐 turn 收尾的 settled 到达：标记保持，补投开的新 turn 仍被拦
    interpreter.interpret([{ kind: 'agent-settled' }])
    interpreter.interpret([{ kind: 'hook', eventType: 'agent_start', data: {} }])
    expect(abortSession).toHaveBeenCalledTimes(2)
    expect(store.hasUserStoppedMark('s1')).toBe(true)
  })
})

// ── Part C：dispatcher 置位分型（K1/K2）与显式投递清标记 ─────────

describe('MessageDispatcher 置位分型与显式投递清标记', () => {
  /** [u2] 出厂交接 async 链持有的 timer（watchdog / 持有期轮询）在用例间清理。 */
  let cleanupRegistry: (() => void) | undefined

  function makeDispatcher(opts: {
    session?: IManagedSessionView
    abortBehavior?: 'ok' | 'rpc-timeout'
    /** U3 用例：pm.getClient 无条目（forceQuit 早退分支）。 */
    clientMissing?: boolean
  } = {}) {
    const session = opts.session ?? makeMockSession()
    const abortFn = opts.abortBehavior === 'rpc-timeout'
      ? vi.fn(async () => { throw new RpcTimeoutError('abort', 60000) })
      : vi.fn(async () => {})
    /** prompt 时刻的标记快照（时序构造性断言：清标记必须先于 prompt）。 */
    let markAtPrompt: boolean | undefined
    const client = {
      prompt: vi.fn(async () => {
        if (markAtPrompt === undefined) markAtPrompt = store.hasUserStoppedMark(session.id)
        return {} as unknown as Awaited<ReturnType<IPiEngine['prompt']>>
      }),
      abort: abortFn,
      // idle-pi-reclamation D6-1：dispatcher 入口同步 touch（attached client 必有该面）
      touchActivity: vi.fn(),
    } as unknown as IPiEngine
    const persistSessionOutcome = vi.fn()
    const svc: IDispatcherSessionOps = {
      ensureActive: vi.fn(async () => client),
      getSessionByClient: vi.fn(() => session),
      persistSessionOutcome,
      getSession: vi.fn(() => session),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    }
    const pm = {
      getClient: vi.fn(() => (opts.clientMissing ? undefined : client)),
      destroySession: vi.fn(async () => {}),
    } as unknown as IProcessManager
    const publish = vi.fn()
    // [u2 投递所有权内核] 出站交接经内核适配层（dispatcher 只提交；交接异步在注册表）——
    // fixture 按真实组合根装配接内核；显式投递清标记（D4）落在适配层 deliverOne
    const deliveryRegistry = createSessionDeliveryRegistry({
      getSession: (sid) => svc.getSession(sid),
      ensureActive: svc.ensureActive as (sid: string) => Promise<IPiEngine>,
      subscribeAgentSettled: () => () => {},
      recordWorkspace: () => {},
      getMessageBus: () => null,
    })
    cleanupRegistry = () => deliveryRegistry.disposeAll()
    const dispatcher = new MessageDispatcher(svc, pm, { record: vi.fn() } as unknown as WorkspaceService, { publish } as unknown as IMessageBus)
    dispatcher.setDeliveryRegistry(deliveryRegistry)
    return {
      dispatcher, session, publish, abortFn, persistSessionOutcome, deliveryRegistry,
      markAtPrompt: () => markAtPrompt,
    }
  }

  function makeMockSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
    return {
      id: 's1', cwd: '/test', label: 'test', modelId: 'm1', createdAt: 1, lastActiveAt: 1,
      tokenCount: 0, inputTokens: 0, isGenerating: false, isCompacting: false, isBashRunning: false,
      bashRunToken: undefined,
      ...overrides,
    }
  }

  let store: ReturnType<typeof makeMarkStore>
  let abortSession: (sessionId: string) => Promise<void>

  beforeEach(() => {
    // fake timers：U2 端到端用例经 advanceTimersByTimeAsync flush fire-and-forget abort
    // 微任务链（dispatcher.abort → persistSessionOutcome）。
    vi.useFakeTimers()
    store = makeMarkStore()
    abortSession = vi.fn(async (_sessionId: string) => {})
    userStoppedGate.configure({ marks: store, abortSession })
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanupRegistry?.()
    cleanupRegistry = undefined
    userStoppedGate.resetForTest()
  })

  it('K1：forceQuit（用户强制退出）→ 置标记 source=user_force_quit', async () => {
    const { dispatcher } = makeDispatcher()
    await dispatcher.forceQuit('s1')
    expect(store.marks.get('s1')).toEqual({ source: 'user_force_quit' })
  })

  it('U3 修复：无 client（进程已退出）时 forceQuit 早退分支仍置标记 source=user_force_quit', async () => {
    // 「用户要停」的意图与进程死活无关：无 client 早退不进 forceQuitSession，但标记必须
    // 置上——否则后续 restore 无闸（restore replay turn 跑起）。
    const { dispatcher } = makeDispatcher({ clientMissing: true })
    await dispatcher.forceQuit('s1')
    expect(store.marks.get('s1')).toEqual({ source: 'user_force_quit' })
  })

  it('U2 修复：默认 abort（用户语义）→ persistSessionOutcome reason=User aborted', async () => {
    const { dispatcher, persistSessionOutcome } = makeDispatcher()
    await dispatcher.abort('s1')
    expect(persistSessionOutcome).toHaveBeenCalledWith('s1', 'stopped', 'User aborted')
  })

  it('U2 修复：拦截链 abort（source=convergence）→ reason=Convergence abort (auto)，与用户 abort 可区分', async () => {
    const { dispatcher, persistSessionOutcome } = makeDispatcher()
    await dispatcher.abort('s1', 'convergence')
    expect(persistSessionOutcome).toHaveBeenCalledWith('s1', 'stopped', 'Convergence abort (auto)')
  })

  it('U2 修复：aborted 完成帧广播两种 source 均保持不变（前端 no-op 契约）', async () => {
    const user = makeDispatcher()
    await user.dispatcher.abort('s1')
    const conv = makeDispatcher()
    await conv.dispatcher.abort('s2', 'convergence')
    // 广播保持不变：两路都发 message.complete{stopReason:'aborted'}（U2 明确不动广播逻辑）
    expect(user.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'message.complete', payload: { sessionId: 's1', stopReason: 'aborted' } }))
    expect(conv.publish).toHaveBeenCalledWith('s2', expect.objectContaining({ type: 'message.complete', payload: { sessionId: 's2', stopReason: 'aborted' } }))
  })

  it('U2 端到端：agent_start 挂点 re-abort 经 gate.abortSession 接线（source=convergence）→ 终态写收敛语义', async () => {
    // 锁定 session-service.ts gate.configure 接线语义：abortSession 闭包必须传
    // source='convergence'（生产唯一接线点——接线丢参即本用例红）。
    const { dispatcher, persistSessionOutcome } = makeDispatcher()
    userStoppedGate.configure({ marks: store, abortSession: (sid) => dispatcher.abort(sid, 'convergence') })
    userStoppedGate.markUserStopped('s1', 'user_force_quit')
    // 旁路源开 turn → 拦截再 abort（生产通路：noteAgentStart → deps.abortSession）
    const interpreter = new EventInterpreter('s1', { send: () => {} })
    interpreter.interpret([{ kind: 'hook', eventType: 'agent_start', data: {} }])
    await vi.advanceTimersByTimeAsync(0)
    expect(persistSessionOutcome).toHaveBeenCalledWith('s1', 'stopped', 'Convergence abort (auto)')
  })

  it('sendPrompt 显式投递：投递前清标记放行，标记不在时照常投递（零开销）', async () => {
    const { dispatcher, markAtPrompt } = makeDispatcher()
    userStoppedGate.markUserStopped('s1', 'user_force_quit')
    const result = await dispatcher.sendMessage('s1', 'hello')
    expect(result.blocked).toBe(false)
    await flushDelivery() // 出站交接在适配层（u2）：清标记随 deliverOne 异步落地
    expect(store.hasUserStoppedMark('s1')).toBe(false) // 投递前已清
    // 时序构造性：prompt 发出时刻标记已清（清标记先于 prompt）
    expect(markAtPrompt()).toBe(false)
  })

  it('显式投递开 turn 的 agent_start 事件回流不被误掐（时序构造性：清标记先于 prompt）', async () => {
    const { dispatcher, markAtPrompt } = makeDispatcher()
    userStoppedGate.markUserStopped('s1', 'user_force_quit')
    await dispatcher.sendMessage('s1', 'hello') // 清标记 + prompt 发出
    await flushDelivery()
    expect(markAtPrompt()).toBe(false) // prompt 受理时标记已清
    // 模拟 pi 处理 prompt 后开 turn，agent_start 事件回流 interpreter
    const sent: ServerMessage[] = []
    const interpreter = new EventInterpreter('s1', { send: (m) => { sent.push(m) } })
    interpreter.interpret([{ kind: 'hook', eventType: 'agent_start', data: {} }])
    expect(abortSession).not.toHaveBeenCalled()
  })
})

// ── Part D：deliverText 显式投递清标记（u3b 补线，D4）─────────────
//
// session_manager send / completion-backflow 回流 / landing 首发直投（sendDirect）三个
// 显式投递消费方全部汇聚于 SessionDeliveryRegistry.deliverText——投递前清标记放行与
// sendPrompt 同构（清标记先于 ensureActive/restore 与 client.prompt）。补发腿不经
// runtime delivery，不适用本放行（区分点 = 投递路径本身，D4）。

describe('deliverText 显式投递清标记（u3b 补线）', () => {
  let store: ReturnType<typeof makeMarkStore>
  let abortSession: (sessionId: string) => Promise<void>

  beforeEach(() => {
    store = makeMarkStore()
    abortSession = vi.fn(async (_sessionId: string) => {})
    // deliverText 读模块级单例——configure 必须作用在同一单例上（与生产 SessionService.configure 形态一致）
    userStoppedGate.configure({ marks: store, abortSession })
  })
  afterEach(() => {
    userStoppedGate.resetForTest()
  })

  /** 最小装置：真 registry + mock 材料（session-delivery-injection harness 同款形态）。 */
  async function sendDirectViaRegistry(sessionId: string): Promise<void> {
    const { createSessionDeliveryRegistry } = await import('../src/services/session/session-delivery-registry.js')
    const view = {
      id: sessionId, cwd: '/test/workspace', lastActiveAt: 1_000,
      isGenerating: false, isCompacting: false, isBashRunning: false,
    }
    const registry = createSessionDeliveryRegistry({
      getSession: (sid) => (sid === view.id ? (view as unknown as IManagedSessionView) : undefined),
      ensureActive: async () => ({ prompt: vi.fn(async () => ({})) } as unknown as never),
      subscribeAgentSettled: () => () => {},
      recordWorkspace: () => {},
      getMessageBus: () => null,
    })
    await registry.sendDirect(sessionId, 'backflow 回流通知 / session_manager send 文本')
  }

  it('sendDirect（backflow / session_manager send 汇聚点）投递前清标记', async () => {
    userStoppedGate.markUserStopped('s1', 'user_force_quit')
    await sendDirectViaRegistry('s1')
    expect(store.hasUserStoppedMark('s1')).toBe(false) // 投递前已清
    // 显式投递开 turn 的 agent_start 事件回流不被误掐（标记已清）
    const sent: ServerMessage[] = []
    const interpreter = new EventInterpreter('s1', { send: (m) => { sent.push(m) } })
    interpreter.interpret([{ kind: 'hook', eventType: 'agent_start', data: {} }])
    expect(abortSession).not.toHaveBeenCalled()
  })

  it('标记不在时（常规投递）deliverText 照常投递零额外开销', async () => {
    await expect(sendDirectViaRegistry('s2')).resolves.not.toThrow()
    expect(store.marks.size).toBe(0)
    expect(abortSession).not.toHaveBeenCalled()
  })
})
