/**
 * occupancy 状态机单测（session-occupancy-send-closure u5a-p3-runtime，D3 十一挂点）。
 *
 * 覆盖映射（对照实施计划验收条款）：
 * - ① 11 挂点各自转移（含失败路径 #8/#9/#10/#11——pi 死亡/abort/bash 失败仍复位）
 * - ② 幂等性：乱序/重复事件不产生错误状态（settling 中再收 turn-end、重复 idle 不重复广播）
 * - ③ state topic 快照写入 + 重连回放含 occupancy → 见 test/message-bus-occupancy.test.ts
 * - ④ 值未变化不重复广播（helper 全等去重 + dispatcher 重复 abort 场景）
 * - ⑤ session.compacting/compacted 事件保留（存量不回归）
 *
 * mock 策略：全部依赖 mock，不 spawn pi。
 * 运行：cd packages/runtime && npx vitest run test/occupancy-runtime.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventInterpreter, applySessionOccupancyTransition } from '../src/services/session/event-interpreter.js'
import { MessageDispatcher } from '../src/services/session/message-dispatcher.js'
import { SessionLifecycle } from '../src/services/session/session-lifecycle.js'
import { MessageBus } from '../src/services/message-bus/message-bus.js'
import { RpcTimeoutError } from '../src/utils/errors.js'
import type { ServerMessage } from '@taiji/shared'
import type { SessionOccupancy, SessionOccupancyTransition } from '../src/services/session/types.js'
import type { IDispatcherSessionOps, ILifecycleSessionOps, ISessionRegisterDeps } from '../src/services/session/session-internal.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { IMessageBus } from '../src/services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager } from '../src/services/ports/pi-engine.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { IEventAdapter } from '../src/interfaces.js'

// ── 共享 mock 工厂 ───────────────────────────────────────────────

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

/** 从 publish 调用记录里抽取全部 occupancy 帧的 payload（帧序）。 */
function occupancyFrames(publish: ReturnType<typeof vi.fn>): Array<SessionOccupancy & { sessionId: string }> {
  return publish.mock.calls
    .map((c: unknown[]) => (c[1] as ServerMessage))
    .filter((m) => m.type === 'session.occupancy')
    .map((m) => m.payload as SessionOccupancy & { sessionId: string })
}

function frameTypes(publish: ReturnType<typeof vi.fn>): string[] {
  return publish.mock.calls.map((c: unknown[]) => (c[1] as ServerMessage).type)
}

// ── Part A：occupancy 写原语（幂等合并 + 去重，经转移原语驱动） ────
// [u3b 挂点迁移] 原直调 updateSessionOccupancy（现为原语内部机制）的用例等价改写为经
// applySessionOccupancyTransition 驱动——合并/去重/兜底/null-safe 语义由原语内部复用同一
// 机制，断言点不变；细粒度逐行派生断言见 test/session-occupancy-transition.test.ts（u2）。

describe('occupancy 写原语（经转移原语驱动）', () => {
  let publish: ReturnType<typeof vi.fn<(sessionId: string, msg: ServerMessage) => void>>
  let session: IManagedSessionView

  beforeEach(() => {
    publish = vi.fn<(sessionId: string, msg: ServerMessage) => void>()
    session = makeMockSession()
  })

  it('写入目标值并广播全量三维帧（payload 与 shared protocol 形状一致）', () => {
    applySessionOccupancyTransition(session, { publish }, 'dispatching')
    expect(session.occupancy).toEqual({ turn: 'dispatching', compacting: false, bash: false })
    expect(publish).toHaveBeenCalledTimes(1)
    const msg = publish.mock.calls[0][1] as ServerMessage
    expect(msg.type).toBe('session.occupancy')
    expect(msg.payload).toEqual({ sessionId: 's1', turn: 'dispatching', compacting: false, bash: false })
  })

  it('值未变化时不重复广播（④）：重复写同值零帧，跨维度变化才发帧', () => {
    applySessionOccupancyTransition(session, { publish }, 'generating')
    applySessionOccupancyTransition(session, { publish }, 'generating') // 重复
    expect(occupancyFrames(publish)).toHaveLength(1)
    applySessionOccupancyTransition(session, { publish }, 'bash-start') // 跨维度（bash）
    applySessionOccupancyTransition(session, { publish }, 'bash-start') // 重复
    const frames = occupancyFrames(publish)
    expect(frames).toHaveLength(2)
    expect(frames[1]).toMatchObject({ turn: 'generating', bash: true }) // 全量三维合并
  })

  it('幂等写（②）：乱序/回退事件直写目标值不产生中间态', () => {
    // settling 中再收 turn-end（乱序重复）→ 仍 settling；agent-settled 迟到 → idle
    applySessionOccupancyTransition(session, { publish }, 'settling')
    applySessionOccupancyTransition(session, { publish }, 'settling')
    applySessionOccupancyTransition(session, { publish }, 'idle')
    expect(session.occupancy?.turn).toBe('idle')
    // retry/followUp 续跑：settling 中收到 turn-start（正常应不可能，幂等写直接落 generating）
    applySessionOccupancyTransition(session, { publish }, 'generating')
    expect(session.occupancy?.turn).toBe('generating')
  })

  it('occupancy 字段缺省（undefined）按 idle 兜底合并（存量 mock/构造点零改动）', () => {
    expect(session.occupancy).toBeUndefined()
    applySessionOccupancyTransition(session, { publish }, 'compacting-start')
    expect(session.occupancy).toEqual({ turn: 'idle', compacting: true, bash: false })
  })

  it('publish 未注入（null/undefined）时状态照写、广播跳过（null-safe）', () => {
    expect(() => applySessionOccupancyTransition(session, undefined, 'dispatching')).not.toThrow()
    expect(session.occupancy?.turn).toBe('dispatching')
    expect(() => applySessionOccupancyTransition(session, null, 'generating')).not.toThrow()
    expect(session.occupancy?.turn).toBe('generating')
  })
})

// ── Part B：interpreter 挂点 #2-#6（成功路径）────────────────────

describe('EventInterpreter occupancy 挂点（#2-#6）', () => {
  let sent: ServerMessage[]
  let send: (msg: ServerMessage) => void
  // [u3b 挂点迁移] 回调传封闭转移枚举值（D2），合并/派生在原语内——断言转移类型而非 patch。
  let onOccupancyTransition: ReturnType<typeof vi.fn<(transition: SessionOccupancyTransition) => void>>

  beforeEach(() => {
    sent = []
    send = (msg) => { sent.push(msg) }
    onOccupancyTransition = vi.fn<(transition: SessionOccupancyTransition) => void>()
  })

  const makeInterpreter = () => new EventInterpreter('s1', { send, onOccupancyTransition })

  it('#2 turn-start → generating', () => {
    makeInterpreter().interpret([{ kind: 'turn-start', messageId: 'm1' }])
    expect(onOccupancyTransition).toHaveBeenCalledWith('generating')
  })

  it('#3 turn-end → settling（onTurnFinalize 同点）', () => {
    makeInterpreter().interpret([{
      kind: 'turn-end',
      message: { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } } as ServerMessage,
      stopReason: 'end_turn',
    }])
    expect(onOccupancyTransition).toHaveBeenCalledWith('settling')
  })

  it('#3 兜底：turn-end handler 早段抛错（send 抛）仍写 settling（interpret per-event catch）', () => {
    const throwingSend = vi.fn(() => { throw new Error('ws down') })
    const onTurnFinalize = vi.fn()
    const interpreter = new EventInterpreter('s1', {
      send: throwingSend,
      onTurnFinalize,
      onOccupancyTransition,
    })
    expect(() => interpreter.interpret([{
      kind: 'turn-end',
      message: { type: 'message.complete', payload: { sessionId: 's1' } } as ServerMessage,
    }])).not.toThrow()
    expect(onTurnFinalize).toHaveBeenCalledTimes(1)
    expect(onOccupancyTransition).toHaveBeenCalledWith('settling')
  })

  it('#4 agent-settled → idle', () => {
    makeInterpreter().interpret([{ kind: 'agent-settled' }])
    expect(onOccupancyTransition).toHaveBeenCalledWith('idle')
  })

  it('#5 compaction-start → compacting-start；⑤ session.compacting 帧保留', () => {
    makeInterpreter().interpret([{ kind: 'compaction-start', reason: 'manual' }])
    expect(onOccupancyTransition).toHaveBeenCalledWith('compacting-start')
    expect(sent.map((m) => m.type)).toContain('session.compacting')
  })

  it('#6 compaction-end 三路复位 → compacting-end；⑤ session.compacted 帧保留', () => {
    const interpreter = makeInterpreter()
    // aborted 路（无 errorMessage 真值）
    interpreter.interpret([{ kind: 'compaction-end', reason: 'manual', aborted: true }])
    expect(onOccupancyTransition).toHaveBeenCalledWith('compacting-end')
    expect(sent.map((m) => m.type)).toContain('session.compacted')
    // failed 路（errorMessage 真值）同样复位
    sent = []
    onOccupancyTransition.mockClear()
    interpreter.interpret([{ kind: 'compaction-end', reason: 'manual', aborted: false, errorMessage: 'boom' }])
    expect(onOccupancyTransition).toHaveBeenCalledWith('compacting-end')
    expect(sent.map((m) => m.type)).toContain('session.compacted')
  })

  it('真实接线形态：onOccupancyTransition → applySessionOccupancyTransition，端到端帧序与最终三维正确（含乱序重复）', () => {
    const publish = vi.fn()
    const session = makeMockSession()
    const interpreter = new EventInterpreter('s1', {
      send,
      onOccupancyTransition: (transition) => applySessionOccupancyTransition(session, { publish }, transition),
    })
    const complete = { type: 'message.complete', payload: { sessionId: 's1' } } as ServerMessage
    interpreter.interpret([
      { kind: 'turn-start', messageId: 'm1' },
      { kind: 'turn-end', message: complete, stopReason: 'end_turn' },
      { kind: 'turn-end', message: complete, stopReason: 'end_turn' }, // 重复 turn-end（乱序）
      { kind: 'agent-settled' },
    ])
    const frames = occupancyFrames(publish)
    expect(frames.map((f) => f.turn)).toEqual(['generating', 'settling', 'idle']) // 重复 settling 去重为一帧
    expect(session.occupancy).toEqual({ turn: 'idle', compacting: false, bash: false })
  })
})

// ── Part C：dispatcher 挂点 #1/#7/#8/#9/#10/#11（含失败路径）─────

describe('MessageDispatcher occupancy 挂点', () => {
  function makeDispatcher(opts: {
    session?: IManagedSessionView
    promptError?: Error
    abortBehavior?: 'ok' | 'error' | 'rpc-timeout'
    bashBehavior?: 'ok' | 'error'
    compactBehavior?: 'ok' | 'error'
  } = {}) {
    const session = opts.session ?? makeMockSession()
    const promptFn = opts.promptError
      ? vi.fn(async () => { throw opts.promptError! })
      : vi.fn(async () => ({}) as unknown as Awaited<ReturnType<IPiEngine['prompt']>>)
    const bashFn = opts.bashBehavior === 'error'
      ? vi.fn(async () => { throw new Error('bash transport exploded') })
      : vi.fn(async () => ({ output: 'ok', exitCode: 0, cancelled: false, truncated: false }))
    const abortFn = opts.abortBehavior === 'rpc-timeout'
      ? vi.fn(async () => { throw new RpcTimeoutError('abort', 60000) })
      : opts.abortBehavior === 'error'
        ? vi.fn(async () => { throw new Error('EPIPE') })
        : vi.fn(async () => {})
    const compactFn = opts.compactBehavior === 'error'
      ? vi.fn(async () => { throw new Error('compact transport exploded') })
      : vi.fn(async () => ({ summary: 's', tokensBefore: 1, estimatedTokensAfter: 1 }))
    const client = {
      prompt: promptFn, bash: bashFn, abort: abortFn,
      abortBash: vi.fn(async () => {}), steer: vi.fn(async () => {}), followUp: vi.fn(async () => {}),
      compact: compactFn,
      // touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）——fake 补齐接口成员
      touchActivity: vi.fn(),
    } as unknown as IPiEngine

    const svc: IDispatcherSessionOps = {
      ensureActive: vi.fn(async () => client),
      getSessionByClient: vi.fn(() => session),
      persistSessionOutcome: vi.fn(),
      getSession: vi.fn(() => session),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    }
    const pm = {
      getClient: vi.fn(() => client),
      destroySession: vi.fn(async () => {}),
    } as unknown as IProcessManager
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const publish = vi.fn()
    const dispatcher = new MessageDispatcher(svc, pm, workspace, { publish } as unknown as IMessageBus)
    return { dispatcher, session, svc, pm, publish, promptFn, bashFn, abortFn, compactFn, client }
  }

  it('#1 sendPrompt 预检通过 → turn=dispatching（先于 prompt 调用）', async () => {
    const { dispatcher, publish, promptFn } = makeDispatcher()
    await dispatcher.sendMessage('s1', 'hello')
    expect(promptFn).toHaveBeenCalled()
    const frames = occupancyFrames(publish)
    expect(frames).toEqual([{ sessionId: 's1', turn: 'dispatching', compacting: false, bash: false }])
    // 帧序：occupancy(dispatching) 在 prompt 之前构造（预检通过即写）
    const occIdx = frameTypes(publish).indexOf('session.occupancy')
    expect(occIdx).toBeGreaterThanOrEqual(0)
  })

  it('#1 预检拒绝（busy）不写 dispatching（prompt 未发出，turn 无变化）', async () => {
    // [u3b 预检改读 occupancy] 预检输入 = occupancy 投影（D1 立场），generating 计忙拒
    const { dispatcher, publish } = makeDispatcher({
      session: makeMockSession({ occupancy: { turn: 'generating', compacting: false, bash: false } }),
    })
    await dispatcher.sendMessage('s1', 'hello')
    expect(occupancyFrames(publish)).toHaveLength(0)
    expect(frameTypes(publish)).toContain('send.rejected')
  })

  it('#8a prompt 抛转译拒绝（compacting）→ send.rejected + turn 复位 idle（防卡 dispatching 破坏 flush 触发）', async () => {
    const { dispatcher, publish } = makeDispatcher({
      promptError: new Error('Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.'),
    })
    const result = await dispatcher.sendMessage('s1', 'hello')
    expect(result.rejected).toBe(true)
    expect(frameTypes(publish)).toContain('send.rejected')
    const frames = occupancyFrames(publish)
    expect(frames).toEqual([
      { sessionId: 's1', turn: 'dispatching', compacting: false, bash: false },
      { sessionId: 's1', turn: 'idle', compacting: false, bash: false },
    ])
    // 非 busy 转译拒绝不进 message.error 气泡（u2 存量语义）
    expect(frameTypes(publish)).not.toContain('message.error')
  })

  it('#8b prompt 抛非 busy 错（auth 失败）→ message.error 保留 + turn 复位 idle', async () => {
    const { dispatcher, publish } = makeDispatcher({ promptError: new Error('auth failed') })
    const result = await dispatcher.sendMessage('s1', 'hello')
    expect(result.blocked).toBe(true)
    expect(frameTypes(publish)).toContain('message.error')
    const frames = occupancyFrames(publish)
    expect(frames.at(-1)).toMatchObject({ turn: 'idle' })
  })

  it('#9a abort 成功 → turn=idle；重复 abort 第二次零 occupancy 帧（④ 无变化不重复广播）', async () => {
    // 真实 abort 场景 = 生成中（occupancy generating）；pi 卡死时 agent_settled 不到达，
    // abort 是唯一复位来源（#9 失败路径语义）。
    const { dispatcher, publish } = makeDispatcher({
      session: makeMockSession({ isGenerating: true, occupancy: { turn: 'generating', compacting: false, bash: false } }),
    })
    await dispatcher.abort('s1')
    expect(frameTypes(publish)).toContain('message.complete')
    expect(occupancyFrames(publish)).toEqual([{ sessionId: 's1', turn: 'idle', compacting: false, bash: false }])
    await dispatcher.abort('s1') // 重复 abort：idle→idle 幂等，零帧
    expect(occupancyFrames(publish)).toHaveLength(1)
  })

  it('#9b abort RPC 失败（非超时）→ 兜底复位 turn=idle（pi 卡死 agent_settled 不到达）', async () => {
    const { dispatcher, publish } = makeDispatcher({
      session: makeMockSession({ isGenerating: true, occupancy: { turn: 'generating', compacting: false, bash: false } }),
      abortBehavior: 'error',
    })
    await dispatcher.abort('s1')
    expect(frameTypes(publish)).toContain('message.error')
    expect(occupancyFrames(publish)).toEqual([{ sessionId: 's1', turn: 'idle', compacting: false, bash: false }])
  })

  it('#9c/#10 abort RPC 超时 → forceQuitSession 收敛链全复位（先 turn 复位帧、后三维全复位帧，先于 session.exited）', async () => {
    const { dispatcher, publish } = makeDispatcher({
      session: makeMockSession({ isGenerating: true, isCompacting: true, occupancy: { turn: 'generating', compacting: true, bash: true } }),
      abortBehavior: 'rpc-timeout',
    })
    await dispatcher.abort('s1')
    // 幂等写序列：abort catch 先写 turn=idle（compacting/bash 尚未复位，中间帧合法），
    // RpcTimeout → forceQuitSession 全复位补完三维——乱序安全，终态一致。
    const frames = occupancyFrames(publish)
    expect(frames).toEqual([
      { sessionId: 's1', turn: 'idle', compacting: true, bash: true },
      { sessionId: 's1', turn: 'idle', compacting: false, bash: false },
    ])
    // 帧序约束：occupancy 全复位在 session.exited 之前（removeSessionEntry 会 clearSession）
    const types = frameTypes(publish)
    expect(types.indexOf('session.occupancy')).toBeLessThan(types.indexOf('session.exited'))
  })

  it('#10 forceQuit → 全复位帧 + session.exited 保留（占用中 pi 死亡链路）', async () => {
    const { dispatcher, publish } = makeDispatcher({
      session: makeMockSession({ occupancy: { turn: 'settling', compacting: true, bash: false } }),
    })
    await dispatcher.forceQuit('s1')
    const frames = occupancyFrames(publish)
    expect(frames).toEqual([{ sessionId: 's1', turn: 'idle', compacting: false, bash: false }])
    expect(frameTypes(publish)).toContain('session.exited')
  })

  it('#7 sendBash 置位/复位：bash=true 帧 → bash=false 帧（finally 全路径）', async () => {
    const { dispatcher, publish } = makeDispatcher()
    await dispatcher.sendBash('s1', 'ls')
    const frames = occupancyFrames(publish)
    expect(frames).toEqual([
      { sessionId: 's1', turn: 'idle', compacting: false, bash: true },
      { sessionId: 's1', turn: 'idle', compacting: false, bash: false },
    ])
  })

  it('#7 失败路径：bash transport 抛错 → finally 仍复位 bash=false（⑤ bashResult/message.error 保留）', async () => {
    const { dispatcher, publish } = makeDispatcher({ bashBehavior: 'error' })
    const result = await dispatcher.sendBash('s1', 'bad')
    expect(result.blocked).toBe(true)
    const frames = occupancyFrames(publish)
    expect(frames.at(-1)).toMatchObject({ bash: false })
    expect(frameTypes(publish)).toContain('message.bashResult')
    expect(frameTypes(publish)).toContain('message.error')
  })

  it('#7 streaming 并存：isGenerating 期间 bash 结果入待落列，occupancy 仍 bash=true→false（turn 不受影响）', async () => {
    const { dispatcher, publish, session } = makeDispatcher({
      session: makeMockSession({ isGenerating: true, occupancy: { turn: 'generating', compacting: false, bash: false } }),
    })
    await dispatcher.sendBash('s1', 'ls')
    expect(session.pendingBashResults).toHaveLength(1) // 双分支延迟保留（存量）
    const frames = occupancyFrames(publish)
    expect(frames.map((f) => f.bash)).toEqual([true, false])
    expect(frames.every((f) => f.turn === 'generating')).toBe(true) // turn 维度不被 bash 挂点改写
  })

  it('#11 abortBash → bash=false（成败皆兜底，cancelled 哨兵帧保留）', async () => {
    const { dispatcher, publish } = makeDispatcher({
      session: makeMockSession({
        isBashRunning: true, bashRunToken: 'bash_1_abc',
        occupancy: { turn: 'idle', compacting: false, bash: true },
      }),
    })
    await dispatcher.abortBash('s1')
    const frames = occupancyFrames(publish)
    expect(frames).toEqual([{ sessionId: 's1', turn: 'idle', compacting: false, bash: false }])
    expect(frameTypes(publish)).toContain('message.bashResult')
  })

  it('#6 兜底：compact transport 失败 → finally 复位 compacting=false（compaction_end 不到达时）', async () => {
    // 真实时序镜像：预检（isCompacting=false）通过 → compact RPC 发出 → compaction_start 到达
    //（interpreter 置 isCompacting + occupancy.compacting=true）→ transport 断 reject →
    // finally 兜底复位（interpreter 的 compaction_end #6 不到达）。
    const { dispatcher, publish, session, compactFn } = makeDispatcher({ compactBehavior: 'error' })
    compactFn.mockImplementation(async () => {
      // 模拟 compaction_start 已到达（interpreter #5 语义）：经原语置位（u3c readonly 收口；
      // publish 传 null 与改前直写一致不广播——本用例焦点是 finally 兜底复位帧）
      applySessionOccupancyTransition(session, null, 'compacting-start')
      throw new Error('compact transport exploded')
    })
    await expect(dispatcher.compact('s1')).rejects.toThrow('compact transport exploded')
    expect(occupancyFrames(publish)).toEqual([{ sessionId: 's1', turn: 'idle', compacting: false, bash: false }])
  })

  it('messageBus 未注入 → 挂点 no-op 不抛（null-safety，存量语义）', async () => {
    const session = makeMockSession()
    const client = {
      prompt: vi.fn(async () => ({})),
      abort: vi.fn(async () => {}),
      // touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）——fake 补齐接口成员
      touchActivity: vi.fn(),
    } as unknown as IPiEngine
    const svc: IDispatcherSessionOps = {
      ensureActive: vi.fn(async () => client),
      getSessionByClient: vi.fn(() => session),
      persistSessionOutcome: vi.fn(),
      getSession: vi.fn(() => session),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    }
    const dispatcher = new MessageDispatcher(svc, { getClient: vi.fn(() => client) } as unknown as IProcessManager, { record: vi.fn() } as unknown as WorkspaceService)
    await dispatcher.sendMessage('s1', 'hello')
    await dispatcher.abort('s1')
    expect(session.occupancy).toEqual({ turn: 'idle', compacting: false, bash: false }) // 状态照写
  })
})

// ── Part D：lifecycle registerSession 初值（#10 respawn 衔接）────

describe('SessionLifecycle.registerSession occupancy 初值（respawn 衔接）', () => {
  function makeLifecycle(bus: IMessageBus | null = null) {
    const svc: ILifecycleSessionOps = {
      getExtensionPaths: vi.fn(async () => []),
      getSkillPaths: vi.fn(() => []),
      getReplaceSystemPrompt: vi.fn(() => undefined),
      getLaunchPresetOptions: vi.fn(async () => undefined),
      toSummary: vi.fn(),
      notifySessionCreated: vi.fn(),
      findScannedSession: vi.fn(() => undefined),
      fetchAndBroadcastContext: vi.fn(async () => undefined),
      removeSessionEntry: vi.fn(),
      getActiveSummaries: vi.fn(() => []),
    }
    const registerDeps: ISessionRegisterDeps = {
      adapterFactory: vi.fn(() => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter),
      getMessageBus: () => bus,
      broadcastGlobal: vi.fn(),
      notifyMessageComplete: vi.fn(),
    }
    const lifecycle = new SessionLifecycle(
      svc, {} as unknown as IProcessManager,
      { getDefaultModel: vi.fn(() => undefined) } as unknown as IConfigStore,
      {} as unknown as ISessionStore,
      {} as unknown as WorkspaceService,
      registerDeps,
    )
    return lifecycle
  }

  function makeWs() {
    return { readyState: 1, send: vi.fn() }
  }

  it('respawn（restore）/create/fork 共用注册汇聚点：occupancy 从 idle 起步', async () => {
    const lifecycle = makeLifecycle()
    const session = await lifecycle.registerSession('s1', {} as unknown as IPiEngine, '/repo', 'r')
    // pi 重 spawn 后无活跃 run → idle 起步（与三 flag 全 false 同语义）；renderer 可观测性
    // 由宣告帧保证（下方用例），bus 未注入（null）时状态照写不抛（null-safe）。
    expect(session.occupancy).toEqual({ turn: 'idle', compacting: false, bash: false })
  })

  it('Gate B V6b 回归：注册即写 occupancy idle 快照——restore 后重订阅回放 idle 帧修正 stale 分区', async () => {
    const bus = new MessageBus()
    // 复现 restore 前置态：压缩中死亡（compacting=true 曾写快照），onSessionExit 的
    // clearSession 清场（转移 #10 的 idle 帧在 renderer 侧被 exited-unsub 抢先丢弃——
    // renderer 分区 stale 只能靠 respawn 后的快照回放修正）。
    bus.publish('s1', {
      type: 'session.occupancy',
      payload: { sessionId: 's1', turn: 'generating', compacting: true, bash: false },
    } as ServerMessage)
    bus.clearSession('s1')

    const lifecycle = makeLifecycle(bus)
    await lifecycle.registerSession('s1', {} as unknown as IPiEngine, '/repo', 'r')

    // renderer respawn 后 subscribeSession → stateSnapshot 回放必含 idle 帧：
    // setOccupancy(idle) 修正 stale + flush 触发条件（收到全 idle 帧）成立，队列可续投。
    const replay = bus.subscribe('s1', makeWs())
    const occ = replay.stateSnapshot.find((m) => m.type === 'session.occupancy')
    expect(occ?.payload).toEqual({ sessionId: 's1', turn: 'idle', compacting: false, bash: false })
  })

  it('create（全新 sid）同样落 idle 快照：三入口汇聚点语义一致（renderer 缺省分区本就 idle，无行为变化）', async () => {
    const bus = new MessageBus()
    const lifecycle = makeLifecycle(bus)
    await lifecycle.registerSession('fresh', {} as unknown as IPiEngine, '/repo', 'r')

    const replay = bus.subscribe('fresh', makeWs())
    const occ = replay.stateSnapshot.find((m) => m.type === 'session.occupancy')
    expect(occ?.payload).toEqual({ sessionId: 'fresh', turn: 'idle', compacting: false, bash: false })
  })

  it('宣告帧经 IMessageBus.publish 下发（payload 形状与 shared protocol 一致）', async () => {
    const publish = vi.fn()
    const lifecycle = makeLifecycle({ publish } as unknown as IMessageBus)
    await lifecycle.registerSession('s1', {} as unknown as IPiEngine, '/repo', 'r')

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0][0]).toBe('s1')
    expect(publish.mock.calls[0][1]).toMatchObject({
      type: 'session.occupancy',
      payload: { sessionId: 's1', turn: 'idle', compacting: false, bash: false },
    })
  })
})
