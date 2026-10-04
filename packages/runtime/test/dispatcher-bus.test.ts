/**
 * MessageDispatcher × MessageBus 单通道集成测试（wave:perf-w09，02 文档 D1-2）。
 *
 * 删双写后 dispatcher 只依赖 publish 抽象（broker 依赖已删除）——锁定全部 session 级
 * 命令编排消息（message.error / send.rejected / message.bashStart / message.bashResult /
 * message.complete）经 bus.publish 定向发布且恰好发布一次（无双发）；compaction 生命周期
 * 消息零发布（M4：归 interpreter 唯一编排）。
 *
 * 覆盖：
 * - sendMessage error path → bus.publish(message.error)
 * - sendMessage busy → bus.publish(send.rejected)
 * - hook blocked → bus.publish(message.error)
 * - hook error → bus.publish(message.error)
 * - abort failure → bus.publish(message.error)
 * - abort success → bus.publish(message.complete)
 * - sendBash ensureActive fail → bus.publish(message.error)
 * - sendBash busy → bus.publish(send.rejected)
 * - sendBash start → bus.publish(message.bashStart)
 * - sendBash success → bus.publish(message.bashResult)
 * - sendBash error → bus.publish(message.bashResult + message.error)
 * - abortBash cancelled → bus.publish(message.bashResult{cancelled:true})
 * - compact（M4 事件驱动）→ 零 compaction 广播（busy/start/fail/summary/success 各路径，生命周期归 interpreter）
 * - messageBus undefined → no crash（null-safety）
 *
 * mock 策略：全部依赖 mock，不 spawn pi。
 *
 * 运行：npx vitest run test/dispatcher-bus.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageDispatcher } from '../src/services/session/message-dispatcher.js'
import type { IDispatcherSessionOps } from '../src/services/session/session-internal.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { IMessageBus } from '../src/services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager } from '../src/services/ports/pi-engine.js'
import type { ServerMessage } from '@taiji/shared'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'

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

function makeMocks(opts: {
  isGenerating?: boolean
  isCompacting?: boolean
  isBashRunning?: boolean
  promptError?: Error
  session?: IManagedSessionView
  messageBus?: { publish: ReturnType<typeof vi.fn> }
} = {}) {
  const isGenerating = opts.isGenerating ?? false
  const isCompacting = opts.isCompacting ?? false
  const isBashRunning = opts.isBashRunning ?? false
  // [u3b 预检改读 occupancy] sendPrompt 预检输入源改为 occupancy 投影。fixture 镜像真实
  // 链路的原子同步（原语「合并 + 派生」双写合一）。
  const session = opts.session ?? makeMockSession({
    isGenerating,
    isCompacting,
    isBashRunning,
    occupancy: { turn: isGenerating ? 'generating' : 'idle', compacting: isCompacting, bash: isBashRunning },
  })
  const promptFn = opts.promptError
    ? vi.fn(async () => { throw opts.promptError! })
    : vi.fn(async () => ({}) as unknown as Awaited<ReturnType<IPiEngine['prompt']>>)
  const bashFn = vi.fn(async () => ({ output: 'ok', exitCode: 0, cancelled: false, truncated: false }))
  const abortFn = vi.fn(async () => {})
  const abortBashFn = vi.fn(async () => {})
  const steerFn = vi.fn(async () => {})
  const followUpFn = vi.fn(async () => {})
  const compactFn = vi.fn(async () => ({ summary: 'compacted summary', tokensBefore: 100, estimatedTokensAfter: 50 }))
  const client = {
    prompt: promptFn,
    bash: bashFn,
    abort: abortFn,
    abortBash: abortBashFn,
    steer: steerFn,
    followUp: followUpFn,
    compact: compactFn,
    // touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）经 pm.getClient
    // 到达 fake client——fake 须补齐该接口成员
    touchActivity: vi.fn(),
  } as unknown as IPiEngine

  // S2 ISP 化：结构性满足 dispatcher 窄接口（6 方法 = 实际消费面），无强转；
  // applyContextUpdate 不在窄接口（event-interpreter 组合根回调消费），随迁移移除
  const svc: IDispatcherSessionOps = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    getSession: vi.fn(),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  }

  const pm = {
    getClient: vi.fn(() => client),
  } as unknown as IProcessManager

  const workspace = { record: vi.fn() } as unknown as WorkspaceService

  const messageBus = opts.messageBus ?? { publish: vi.fn() }

  // wave:perf-w09（D1-2）：broker 双写腿已删，dispatcher 只依赖 publish 抽象（4 参构造）
  const dispatcher = new MessageDispatcher(svc, pm, workspace, messageBus as unknown as IMessageBus)
  return { dispatcher, session, promptFn, bashFn, abortFn, abortBashFn, compactFn, svc, pm, messageBus }
}

describe('message-dispatcher bus integration', () => {
  beforeEach(() => vi.clearAllMocks())

  // ── sendMessage paths ──

  it('sendMessage error path → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus } = makeMocks({
      promptError: new Error('pi crashed'),
    })
    await dispatcher.sendMessage('s1', 'hello')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'message.error' }))
    // occupancy 帧（u5a-p3）先于 message.error 入列，按 type 定位（原 calls[0] 断言失真同步）
    const errCall = messageBus.publish.mock.calls.map((c: any[]) => c[1]).find((m: ServerMessage) => m.type === 'message.error')
    expect(errCall).toBeDefined()
    expect(errCall!.payload.message).toContain('pi crashed')
  })

  it('sendMessage busy → bus.publish(send.rejected)', async () => {
    const { dispatcher, messageBus } = makeMocks({ isGenerating: true })
    await dispatcher.sendMessage('s1', 'hello')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'send.rejected' }))
  })

  it('hook blocked → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus } = makeMocks()
    dispatcher.setSendMessageHook(vi.fn().mockResolvedValue({ blocked: true, reason: 'blocked by hook' }))
    await dispatcher.sendMessage('s1', 'hello')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.error',
      payload: expect.objectContaining({ message: 'blocked by hook' }),
    }))
  })

  it('hook error → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus } = makeMocks()
    dispatcher.setSendMessageHook(vi.fn().mockRejectedValue(new Error('hook exploded')))
    await dispatcher.sendMessage('s1', 'hello')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.error',
      payload: expect.objectContaining({ message: expect.stringContaining('hook exploded') }),
    }))
  })

  // ── abort paths ──

  it('abort failure → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus, abortFn } = makeMocks()
    abortFn.mockRejectedValue(new Error('abort timeout'))
    await dispatcher.abort('s1')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.error',
      payload: expect.objectContaining({ message: expect.stringContaining('abort timeout') }),
    }))
  })

  it('abort success → bus.publish(message.complete{stopReason:aborted})', async () => {
    const { dispatcher, messageBus } = makeMocks()
    await dispatcher.abort('s1')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.complete',
      payload: expect.objectContaining({ sessionId: 's1', stopReason: 'aborted' }),
    }))
  })

  // ── sendBash paths ──

  it('sendBash ensureActive fail → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus, svc } = makeMocks()
    svc.ensureActive = vi.fn(async () => { throw new Error('restore failed') })
    await expect(dispatcher.sendBash('s1', 'ls')).rejects.toThrow('restore failed')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'message.error' }))
  })

  it('sendBash busy → bus.publish(send.rejected)', async () => {
    const { dispatcher, messageBus } = makeMocks({ isBashRunning: true })
    const result = await dispatcher.sendBash('s1', 'ls')
    expect(result.blocked).toBe(true)
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'send.rejected' }))
  })

  it('sendBash start → bus.publish(message.bashStart)', async () => {
    const { dispatcher, messageBus, bashFn } = makeMocks()
    bashFn.mockResolvedValue({ output: 'file.txt', exitCode: 0, cancelled: false, truncated: false })
    await dispatcher.sendBash('s1', 'ls')
    // bashStart should be published
    const bashStartCall = messageBus.publish.mock.calls.find(
      (c: any[]) => c[1].type === 'message.bashStart',
    )
    expect(bashStartCall).toBeDefined()
    expect(bashStartCall![1].payload.command).toBe('ls')
  })

  it('sendBash success → bus.publish(message.bashResult)', async () => {
    const { dispatcher, messageBus, bashFn } = makeMocks()
    bashFn.mockResolvedValue({ output: 'file.txt', exitCode: 0, cancelled: false, truncated: false })
    await dispatcher.sendBash('s1', 'ls')
    const bashResultCall = messageBus.publish.mock.calls.find(
      (c: any[]) => c[1].type === 'message.bashResult',
    )
    expect(bashResultCall).toBeDefined()
    expect(bashResultCall![1].payload.output).toBe('file.txt')
    expect(bashResultCall![1].payload.exitCode).toBe(0)
  })

  it('sendBash error → bus.publish(message.bashResult + message.error)', async () => {
    const { dispatcher, messageBus, bashFn } = makeMocks()
    bashFn.mockRejectedValue(new Error('bash failed'))
    const result = await dispatcher.sendBash('s1', 'bad-cmd')
    expect(result.blocked).toBe(true)
    // Should have both bashResult and message.error
    const types = messageBus.publish.mock.calls.map((c: any[]) => c[1].type)
    expect(types).toContain('message.bashResult')
    expect(types).toContain('message.error')
  })

  // ── abortBash path ──

  it('abortBash cancelled → bus.publish(message.bashResult{cancelled:true})', async () => {
    const session = makeMockSession({ isBashRunning: true, bashRunToken: 'bash_123_abc' })
    const { dispatcher, messageBus } = makeMocks({ session })
    await dispatcher.abortBash('s1')
    const bashResultCall = messageBus.publish.mock.calls.find(
      (c: any[]) => c[1].type === 'message.bashResult',
    )
    expect(bashResultCall).toBeDefined()
    expect(bashResultCall![1].payload.cancelled).toBe(true)
  })

  // ── compact paths ──

  it('compact busy reject → 零 compaction 广播（M4：错误归 interpreter）', async () => {
    const { dispatcher, messageBus } = makeMocks({ isGenerating: true })
    await expect(dispatcher.compact('s1')).rejects.toThrow()
    // 零 compaction bus.publish（dispatcher 退化为预检+RPC+复位，生命周期由 interpreter 唯一编排）
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('compact start → 零 compaction 广播（compacting 由 interpreter 从 compaction_start 驱动）', async () => {
    const { dispatcher, messageBus, compactFn } = makeMocks()
    compactFn.mockResolvedValue({ summary: '', tokensBefore: 0, estimatedTokensAfter: 0 })
    await dispatcher.compact('s1')
    expect(compactFn).toHaveBeenCalled()
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('compact fail → 零 compaction 广播（失败提示归 interpreter 的 compaction_end{errorMessage}）', async () => {
    const { dispatcher, messageBus, compactFn } = makeMocks()
    compactFn.mockRejectedValue(new Error('compact exploded'))
    await expect(dispatcher.compact('s1')).rejects.toThrow('compact exploded')
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('compact summary → 零 compaction 广播（compactionSummary 由 interpreter 从 compaction_end 驱动）', async () => {
    const { dispatcher, messageBus, compactFn } = makeMocks()
    compactFn.mockResolvedValue({ summary: 'Did stuff', tokensBefore: 200, estimatedTokensAfter: 100 })
    await dispatcher.compact('s1')
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('compact success → 零 compaction 广播（compacted 由 interpreter 从 compaction_end 驱动）', async () => {
    const { dispatcher, messageBus, compactFn } = makeMocks()
    compactFn.mockResolvedValue({ summary: 'ok', tokensBefore: 100, estimatedTokensAfter: 50 })
    await dispatcher.compact('s1')
    expect(compactFn).toHaveBeenCalled()
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('[RT-4#10] compact 两连发：预检通过即置位（先于 RPC），第二发在事件回流前已被预检拦截', async () => {
    // 第一发 RPC 挂起（模拟压缩进行中、pi compaction_start 事件未回流的窗口——
    // 旧实现此窗口 isCompacting 恒 false，第二发预检照样通过 → 双 compaction 事件流）
    let releaseFirst!: (v: { summary: string; tokensBefore: number; estimatedTokensAfter: number }) => void
    const firstGate = new Promise<{ summary: string; tokensBefore: number; estimatedTokensAfter: number }>((resolve) => { releaseFirst = resolve })
    const { dispatcher, compactFn, session } = makeMocks()
    compactFn.mockImplementation(() => firstGate)

    const first = dispatcher.compact('s1')
    // async 函数体同步执行到第一个 await（client.compact）：置位（'compacting-start' →
    // isCompacting=true 派生）已落 session 视图
    expect(session.isCompacting).toBe(true)
    expect(session.occupancy?.compacting).toBe(true)

    // 第二发：预检读 isCompacting=true → 拒绝（不发出第二个 RPC）
    await expect(dispatcher.compact('s1')).rejects.toThrow('Cannot compact while compaction already running')
    expect(compactFn).toHaveBeenCalledTimes(1)

    // 第一发完成：finally 复位（compacting-end）
    releaseFirst({ summary: 'ok', tokensBefore: 100, estimatedTokensAfter: 50 })
    await first
    expect(session.isCompacting).toBe(false)
    expect(session.occupancy?.compacting).toBe(false)
  })

  it('[RT-4#10] compact RPC 失败：finally 复位置位（transport 级失败不卡 compacting）', async () => {
    const { dispatcher, compactFn, session } = makeMocks()
    compactFn.mockRejectedValue(new Error('transport gone'))
    await expect(dispatcher.compact('s1')).rejects.toThrow('transport gone')
    expect(session.isCompacting).toBe(false)
    expect(session.occupancy?.compacting).toBe(false)
  })

  // ── null safety ──

  it('messageBus undefined → no crash on sendMessage', async () => {
    const session = makeMockSession()
    const promptFn = vi.fn(async () => ({}) as unknown as Awaited<ReturnType<IPiEngine['prompt']>>)
    const client = { prompt: promptFn } as unknown as IPiEngine
    const svc: IDispatcherSessionOps = {
      ensureActive: vi.fn(async () => client),
      getSessionByClient: vi.fn(() => session),
      persistSessionOutcome: vi.fn(),
      getSession: vi.fn(),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    }
    // getClient → undefined：无附着 client 形态（sendPrompt 入口 touch 的空守卫分支）
    const pm = { getClient: vi.fn(() => undefined) } as unknown as IProcessManager
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const dispatcher = new MessageDispatcher(svc, pm, workspace)
    // Should not throw
    const result = await dispatcher.sendMessage('s1', 'hello')
    expect(result.blocked).toBe(false)
  })

  it('messageBus undefined → no crash on abort', async () => {
    const session = makeMockSession()
    const client = { abort: vi.fn(async () => {}) } as unknown as IPiEngine
    const svc: IDispatcherSessionOps = {
      getSessionByClient: vi.fn(() => session),
      persistSessionOutcome: vi.fn(),
      ensureActive: vi.fn(),
      getSession: vi.fn(),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    }
    const pm = { getClient: vi.fn(() => client) } as unknown as IProcessManager
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const dispatcher = new MessageDispatcher(svc, pm, workspace)
    await dispatcher.abort('s1')
    // wave:perf-w09：messageBus 未注入时 abort 的 complete 终态静默丢失（旧 broadcast 腿已删），
    // 但不得 throw——组合根恒注入 bus，此处只锁 null-safety
  })

  it('messageBus undefined → no crash on compact（零广播，null-safety）', async () => {
    const session = makeMockSession()
    const compactFn = vi.fn(async () => ({ summary: 'done', tokensBefore: 100, estimatedTokensAfter: 50 }))
    const client = { compact: compactFn } as unknown as IPiEngine
    const messageBus = { publish: vi.fn() }
    const svc: IDispatcherSessionOps = {
      getSessionByClient: vi.fn(() => session),
      ensureActive: vi.fn(),
      persistSessionOutcome: vi.fn(),
      getSession: vi.fn(),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    }
    const pm = { getClient: vi.fn(() => client) } as unknown as IProcessManager
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const dispatcher = new MessageDispatcher(svc, pm, workspace, messageBus as unknown as IMessageBus)
    await dispatcher.compact('s1')
    // M4：零 compaction 发布（no crash + 无 compaction 消息）
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  // ── 单通道语义（wave:perf-w09 D1-2）──

  it('sendMessage error path → messageBus.publish 恰好 1 次（单通道，无双发）', async () => {
    const { dispatcher, messageBus } = makeMocks({
      promptError: new Error('test'),
    })
    await dispatcher.sendMessage('s1', 'hello')
    // occupancy 帧（u5a-p3：dispatching + catch 复位 idle）与 message.error 并存，
    // 本用例锁的是 message.error 单通道无双发——按 type 过滤后计数（原全量计数失真同步）。
    const errCalls = messageBus.publish.mock.calls.filter(
      (c: any[]) => c[1].type === 'message.error',
    )
    expect(errCalls).toHaveLength(1)
    expect(errCalls[0][1].type).toBe('message.error')
  })

  // ── sessionId passes through correctly ──

  it('bus.publish receives correct sessionId from sendMessage', async () => {
    const { dispatcher, messageBus } = makeMocks({
      promptError: new Error('test'),
    })
    await dispatcher.sendMessage('my-session-123', 'hello')
    expect(messageBus.publish).toHaveBeenCalledWith('my-session-123', expect.any(Object))
  })
})
