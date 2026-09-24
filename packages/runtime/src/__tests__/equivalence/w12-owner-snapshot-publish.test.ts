/**
 * W12 等价性断言：5 个 state 话题 publish 数据源切换为 ReplicatedState / 包装实例快照
 * （data-source-governance P1.5 / D7 投影一次）。
 *
 * 验收对照（.taiji-harness/2026-08-19-data-source-governance-p1p4/acceptance/w12-acceptance.md
 * 通过命令 2）：每阶段附「切换前后同场景 stateSnapshot 内容一致」断言——本文件按 5 阶段
 * 分 describe（阶段 1 commands / 2 context.update / 3 state_changed / 4 subagents /
 * 5 workflowUpdate），两层断言：
 * - 等价层：RPC mock 稳定返回权威值时，publish 进 stateSnapshot 的 last-value 与
 *   「切换前口径」（RPC 直连投影 / 事件 payload 投影）逐字段一致；
 * - 数据源层（证伪影子路径）：播种 fetch 与发布路径 RPC 返回不同值时，last-value ==
 *   实例快照（owner），证明 payload 不再取自事件/RPC 直连的影子数据。
 *
 * mock 层用例用 fake timers（项目规范，禁真实 sleep）；事件/RPC 驱动路径的收敛等待
 * （W12 waitForSettled 轮询）由 advanceTimersByTimeAsync 推进。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServerMessage } from '@taiji/shared'
import { SessionService } from '../../services/session/session-service.js'
import { EventInterpreter } from '../../services/session/event-interpreter.js'
import type { PiTranslatedEvent } from '../../services/session/types.js'
import { MessageBus } from '../../services/message-bus/message-bus.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../../services/session/replicated-states.config.js'
import type { IMessageBroker } from '../../interfaces.js'
import type { IPiEngine, IProcessManager, PiCommandInfo } from '../../services/ports/pi-engine.js'
import type { BusClient } from '../../services/message-bus/types.js'

/** 收集型 mock ws（BusClient 契约），收集收到的原始 JSON payload。 */
function createMockWs(): BusClient & { sent: string[] } {
  const sent: string[] = []
  return { readyState: 1, send: (payload: string) => { sent.push(payload) }, sent }
}

/** stateSnapshot 里按 type 找 last-value。 */
function findStateMsg(msgs: ServerMessage[], type: string): ServerMessage | undefined {
  return msgs.find((m) => m.type === type)
}

/**
 * 最小 SessionService 装置（对齐 w10-usage-switchmodel-race.test.ts 构造形态）：
 * 真 MessageBus（subscribe 拿 stateSnapshot 断言 last-value）+ 全能 mock client
 * （getState / getSessionStats / getCommands / setModel 均可编程）。
 */
function makeFixture(overrides: {
  state?: Record<string, unknown>
  stats?: Record<string, unknown>
  commands?: PiCommandInfo[]
} = {}) {
  const state = {
    sessionName: 'w12',
    thinkingLevel: 'low',
    model: { id: 'model-a', provider: 'p' },
    pendingMessageCount: 0,
    ...overrides.state,
  }
  const stats = { contextUsage: { tokens: 5000, contextWindow: 128000, percent: 3.90625 }, ...overrides.stats }
  const client = {
    // mock 返回宽化为 Record：用例中 mockResolvedValue 翻新权威值（含 tokens:null 等边界形态）
    getCommands: vi.fn(async () => overrides.commands ?? [{ name: 'cmd-a' }] as PiCommandInfo[]),
    getState: vi.fn(async () => state as Record<string, unknown>),
    getSessionStats: vi.fn(async () => stats as Record<string, unknown>),
    setModel: vi.fn(async () => undefined),
  }
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client as unknown as IPiEngine),
  } as unknown as IProcessManager
  const bus = new MessageBus()
  const svc = new SessionService(
    pm,
    { broadcast: vi.fn() } as unknown as IMessageBroker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'p', modelId: 'model-a' }) } as never, // configStore
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never, // sessionStore
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService
    bus,
  )
  svc.setMessageBus(bus)
  return { svc, bus, client }
}

describe('W12 阶段 2：context.update publish 数据源 = usage 实例快照（mock RPC 层）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('等价层：turn 事件失效收敛后，stateSnapshot 的 context last-value == 旧口径（事件值 + resolver 重算）同值', async () => {
    // 旧口径：applyContextUpdate(8000) + resolver(128000) → round(8000/128000*100) = 6
    // 新口径：权威 stats percent 6.25 → 快照投影 round = 6（同值——pi percent 与事件值同源）
    const fx = makeFixture({ stats: { contextUsage: { tokens: 8000, contextWindow: 128000, percent: 6.25 } } })
    const sid = 'w12-ctx-eq'
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1) // 播种（contextUsage 旧值 5000/128000/3.9 投影）

    fx.svc.applyContextUpdate(sid, 8000, 8000) // turn_end 事件（W12 后只失效）
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50) // 防抖 + fetch + 挂钩发布

    const late = fx.bus.subscribe(sid, createMockWs())
    const snapshotMsg = findStateMsg(late.stateSnapshot, 'context.update')
    expect(snapshotMsg?.payload).toEqual({
      sessionId: sid,
      inputTokens: 8000,
      contextLimit: 128000,
      usagePercent: 6,
    })
    // 数据源 = usage 实例快照：last-value 与快照逐字段相等
    expect(fx.svc.getScalarReplicatedStates(sid)?.usage.get()).toEqual({
      inputTokens: 8000, contextLimit: 128000, usagePercent: 6,
    })
  })

  it('数据源层：事件即时值 ≠ 权威值时，last-value == 权威快照投影（事件 payload 不再进广播）', async () => {
    const fx = makeFixture({ stats: { contextUsage: { tokens: 7000, contextWindow: 128000, percent: 5.47 } } })
    const sid = 'w12-ctx-src'
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)

    // 事件即时值 9999 与权威 7000 刻意不同——切换前广播 9999（事件直转发），切换后广播快照 7000
    fx.svc.applyContextUpdate(sid, 9999, 9999)
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)

    const late = fx.bus.subscribe(sid, createMockWs())
    const snapshotMsg = findStateMsg(late.stateSnapshot, 'context.update')
    expect(snapshotMsg?.payload).toEqual({
      sessionId: sid,
      inputTokens: 7000,
      contextLimit: 128000,
      usagePercent: 5, // round(5.47)
    })
  })

  it('无值态（compact 后空投影）：fetch 成功且 tokens=null → 发无值占位帧，last-value 被占位帧覆盖（D1）', async () => {
    const fx = makeFixture()
    const sid = 'w12-ctx-null'
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)
    // 播种后 last-value = 5000/128000/4
    const seeded = fx.bus.subscribe(sid, createMockWs())
    expect(findStateMsg(seeded.stateSnapshot, 'context.update')?.payload).toMatchObject({ inputTokens: 5000 })

    // compact 后 tokens=null：fetch 成功但投影为空快照 {}——D1 协议收敛后发「无值占位帧」
    //（仅含 sessionId，last-value 显式登记无值态，切回回放可区分「无值」与「从未收到帧」）。
    // 实例快照经 ownerSnapshotMerge 保持旧值（空快照不覆盖——无值态值要等新 turn）。
    fx.client.getSessionStats.mockResolvedValue({ contextUsage: { tokens: null, contextWindow: 128000, percent: null } })
    fx.svc.applyContextUpdate(sid, 0, 0)
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)

    const late = fx.bus.subscribe(sid, createMockWs())
    const snapshotMsg = findStateMsg(late.stateSnapshot, 'context.update')
    expect(snapshotMsg?.payload).toEqual({ sessionId: sid }) // 占位帧：仅 sessionId，字段缺失 = 无值
    // usage 实例快照保持旧值（无值态不覆盖，W8 语义不变）
    expect(fx.svc.getScalarReplicatedStates(sid)?.usage.get()).toEqual({
      inputTokens: 5000, contextLimit: 128000, usagePercent: 4,
    })
  })
})

describe('W12 阶段 3：session.state_changed payload 全字段来自实例快照（mock RPC 层；D1 后仅 modelId/thinkingLevel 两实例）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('等价层：switchModel 收敛后 state_changed payload == 旧口径（新模型）同值；usage 只在 context.update 帧（D1）', async () => {
    const fx = makeFixture()
    const sid = 'w12-state-eq'
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1) // 播种（model-a / low / 5000·128k·4%）

    // pi 侧 setModel 已生效：getState.model 与 getSessionStats.contextUsage 同步翻新为 model-b
    fx.client.getState.mockResolvedValue({
      sessionName: 'w12',
      thinkingLevel: 'medium',
      model: { id: 'model-b', provider: 'p' },
      pendingMessageCount: 0,
    })
    fx.client.getSessionStats.mockResolvedValue({
      contextUsage: { tokens: 20000, contextWindow: 100000, percent: 20 },
    })

    await fx.svc.switchModel(sid, 'p' as unknown as Parameters<typeof fx.svc.switchModel>[1], 'model-b')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)

    const late = fx.bus.subscribe(sid, createMockWs())
    // D1 协议收敛：state_changed payload 仅 sessionId/modelId/thinkingLevel（usage 三字段已删）。
    // 等价层：modelId 'p/model-b'、thinkingLevel 'medium' 与旧口径同值。
    expect(findStateMsg(late.stateSnapshot, 'session.state_changed')?.payload).toEqual({
      sessionId: sid,
      modelId: 'p/model-b',
      thinkingLevel: 'medium',
    })
    // usage 终态仍收敛（switchModel 失效 → 防抖重拉）：快照与 context.update last-value 同值
    const states = fx.svc.getScalarReplicatedStates(sid)
    expect(states?.modelId.get()).toEqual({ modelId: 'p/model-b' })
    expect(states?.thinkingLevel.get()).toEqual({ thinkingLevel: 'medium' })
    expect(states?.usage.get()).toEqual({ inputTokens: 20000, contextLimit: 100000, usagePercent: 20 })
    expect(findStateMsg(late.stateSnapshot, 'context.update')?.payload).toEqual({
      sessionId: sid,
      inputTokens: 20000,
      contextLimit: 100000,
      usagePercent: 20,
    })
  })

  it('数据源层：usage 快照窗口只进 context.update 帧（state_changed 无 usage 字段；W18 起 resolver 注入链已删，快照唯一数据源）', async () => {
    const fx = makeFixture({ stats: { contextUsage: { tokens: 5000, contextWindow: 64000, percent: 7.8 } } })
    // W12 曾注入窗口 ≠ pi 的 resolver 证伪「resolver 影子」；W18 死代码移交删除注入链后
    // 结构上不可能有 resolver 参与路径——快照读 pi（64000 / round(7.8) = 8）。
    // D1：contextLimit 只出现在 context.update 帧（state_changed 协议层已删 usage 三字段）。
    const sid = 'w12-state-src'
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)

    const late = fx.bus.subscribe(sid, createMockWs())
    expect(findStateMsg(late.stateSnapshot, 'session.state_changed')?.payload).toMatchObject({
      sessionId: sid,
      modelId: 'p/model-a',
    })
    expect(findStateMsg(late.stateSnapshot, 'context.update')?.payload).toMatchObject({
      inputTokens: 5000,
      contextLimit: 64000,
      usagePercent: 8,
    })
  })

  it('diff 抑制：失效驱动重拉（同值）不重复发 state_changed 帧；值变恢复发帧（U6：30s 周期兜底已删）', async () => {
    const fx = makeFixture()
    const sid = 'w12-state-diff'
    const ws = createMockWs()
    fx.bus.subscribe(sid, ws)
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)

    const countStateChanged = (): number =>
      ws.sent.map((s) => JSON.parse(s) as ServerMessage).filter((m) => m.type === 'session.state_changed').length
    expect(countStateChanged()).toBe(1) // 播种后发布一次

    // U6 删除 thinkingLevel 实例的 30s 周期兜底轮询（D9 C.4）——长时段无失效即无拉取、无重复帧
    await vi.advanceTimersByTimeAsync(95_000)
    expect(countStateChanged()).toBe(1)

    // 权威翻新后失效驱动重拉（switchModel RPC 成功响应 markDirty，替代旧周期 poll）：
    // 组合值变化 → 恢复发帧
    fx.client.getState.mockResolvedValue({
      sessionName: 'w12',
      thinkingLevel: 'high',
      model: { id: 'model-a', provider: 'p' },
      pendingMessageCount: 0,
    })
    await fx.svc.switchModel(sid, 'p' as never, 'model-a')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    expect(countStateChanged()).toBe(2)
    const late = fx.bus.subscribe(sid, createMockWs())
    expect(findStateMsg(late.stateSnapshot, 'session.state_changed')?.payload).toMatchObject({
      thinkingLevel: 'high',
    })
  })
})

describe('W12→W18 阶段 4：session.subagents 数据源 = entry 扫描派生缓存（事件直写退役，mock 事件流）', () => {
  /**
   * 构造带 send 收集器 + 失效回调收集器的 EventInterpreter。
   * W18 起事件流不再直写 subagents 数据——全部 subagent 相关事件降级为失效信号
   * （onRecordEntriesInvalidated，组合根注入 sessionService.invalidateRecordEntries）。
   */
  function makeInterpreter(sessionId: string): {
    interpreter: EventInterpreter
    frames: ServerMessage[]
    invalidations: Array<{ sessionId: string; customType: string }>
  } {
    const frames: ServerMessage[] = []
    const invalidations: Array<{ sessionId: string; customType: string }> = []
    const interpreter = new EventInterpreter(sessionId, {
      send: (m) => { frames.push(m) },
      onRecordEntriesInvalidated: (sid, customType) => { invalidations.push({ sessionId: sid, customType }) },
    })
    return { interpreter, frames, invalidations }
  }

  /** subagent tool-call-start + tool-call-end 事件对（W12 曾直写建 running 记录的事件流）。 */
  function subagentStartEvents(toolCallId: string): PiTranslatedEvent[] {
    return [
      {
        kind: 'tool-call-start',
        toolCallId,
        toolName: 'subagent',
        input: { action: 'start', startParam: { agent: 'researcher', slug: 'res', task: 'do research' } },
        entry: { toolCallId, name: 'subagent', arguments: {} },
      } as unknown as PiTranslatedEvent,
      {
        kind: 'tool-call-end',
        toolCallId,
        toolName: 'subagent',
        isError: false,
        output: 'started',
        details: { action: 'start', subagentId: `sa-${toolCallId}`, sessionFile: `/tmp/sa-${toolCallId}.jsonl`, bgResponse: { status: 'running' } },
        images: undefined,
        entry: { toolCallId },
      } as unknown as PiTranslatedEvent,
    ]
  }

  /** bg-notify 事件（message 帧 customType=subagent-bg-notify；W12 曾是终态直写入口）。 */
  function bgNotifyEvent(sessionId: string, id: string, status: string, overrides: Record<string, unknown> = {}): PiTranslatedEvent {
    return {
      kind: 'message',
      message: {
        type: 'message.customStart' as ServerMessage['type'],
        payload: { sessionId, customType: 'subagent-bg-notify', details: { id, status, agent: 'researcher', startedAt: 100, ...overrides } },
      } as ServerMessage,
    } as PiTranslatedEvent
  }

  /** record-entry-appended 中间事件（entry_appended 主信号，adapter customType 过滤后产物）。 */
  function recordEntryAppendedEvent(): PiTranslatedEvent {
    return { kind: 'record-entry-appended', customType: 'subagent-record' } as PiTranslatedEvent
  }

  it('事件直写退役：tool-call-end / bg-notify / record-entry-appended 都只触发失效回调，不产 session.subagents 帧', () => {
    const sid = 'w18-sub-retire'
    const { interpreter, frames, invalidations } = makeInterpreter(sid)
    interpreter.interpret(subagentStartEvents('tc-1'))
    interpreter.interpret([bgNotifyEvent(sid, 'sa-tc-1', 'closed', { model: 'p/m', endedAt: 200 })])
    interpreter.interpret([recordEntryAppendedEvent()])

    // 证伪影子路径：事件 payload 不再进任何数据缓存——无 session.subagents 帧产出
    expect(frames.filter((m) => m.type === 'session.subagents')).toHaveLength(0)
    // 三路事件全部降级为 subagent-record 失效信号（tool-call-end 兜底 / bg-notify 兜底 / 主信号）
    expect(invalidations).toEqual([
      { sessionId: sid, customType: 'subagent-record' },
      { sessionId: sid, customType: 'subagent-record' },
      { sessionId: sid, customType: 'subagent-record' },
    ])
    // customStart WS 帧照常转发前端（BgNotifyCard 渲染不受 W18 退役影响）
    expect(frames.some((m) => m.type === 'message.customStart' && (m.payload as { customType?: string }).customType === 'subagent-bg-notify')).toBe(true)
  })

  it('未命中 customType 的事件不触发失效（守卫语义保持）', () => {
    const sid = 'w18-sub-miss'
    const { interpreter, invalidations } = makeInterpreter(sid)
    interpreter.interpret([{
      kind: 'message',
      message: {
        type: 'message.customStart' as ServerMessage['type'],
        payload: { sessionId: sid, customType: 'unrelated-notify', details: {} },
      } as ServerMessage,
    } as PiTranslatedEvent])
    expect(invalidations).toHaveLength(0)
  })

  it('customType 放宽：非 record 域主信号（pi-scheduler:task）同样触发失效回调并透传 customType', () => {
    // D5「失效转发的三段链路」②③：PiTranslatedEvent / interpreter 回调的 customType
    // 已从三字面量放宽为 string——镜像域信号原样透传，无字面量过滤。
    const sid = 'w18-sub-relaxed'
    const { interpreter, invalidations } = makeInterpreter(sid)
    interpreter.interpret([{ kind: 'record-entry-appended', customType: 'pi-scheduler:task' } as PiTranslatedEvent])
    expect(invalidations).toEqual([{ sessionId: sid, customType: 'pi-scheduler:task' }])
  })

  it('customType 放宽：无订阅者语境（onRecordEntriesInvalidated 缺省）派发 no-op 不炸', () => {
    // 派发层（组合根/u2c）无订阅者 → no-op；interpreter 层契约 = 回调缺省时
    // 可选链跳过，任何 customType 主信号都不抛错。
    const sid = 'w18-sub-no-subscriber'
    const frames: ServerMessage[] = []
    const interpreter = new EventInterpreter(sid, { send: (m) => { frames.push(m) } })
    expect(() => interpreter.interpret([{ kind: 'record-entry-appended', customType: 'pi-scheduler:task' } as PiTranslatedEvent])).not.toThrow()
    expect(frames).toHaveLength(0)
  })
})

describe('W12 阶段 1：session.commands publish 数据源 = commands 实例快照（mock RPC 层）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('等价层：激活后 stateSnapshot 的 commands last-value == RPC 权威值 == 实例快照（切换前口径一致）', async () => {
    const commands = [{ name: 'cmd-a' }, { name: 'cmd-b' }] as PiCommandInfo[]
    const fx = makeFixture({ commands })
    const sid = 'w12-cmds-eq'
    const ws = createMockWs()
    fx.bus.subscribe(sid, ws)
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    // 播种 fetch → applySnapshot（微任务）→ 挂钩发布（setTimeout 0 宏任务）
    await vi.advanceTimersByTimeAsync(1)

    const msgs = ws.sent.map((s) => JSON.parse(s) as ServerMessage)
    // 在线订阅者收到 session.commands（实时帧）
    expect(findStateMsg(msgs, 'session.commands')).toBeDefined()
    // 重连视角：stateSnapshot last-value 与切换前口径（getCommands RPC 直连返回）一致
    const late = fx.bus.subscribe(sid, createMockWs())
    const snapshotMsg = findStateMsg(late.stateSnapshot, 'session.commands')
    expect(snapshotMsg?.payload).toEqual({ sessionId: sid, commands })
    // 数据源 = 实例快照（owner）：last-value 与快照逐字段相等
    expect(fx.svc.getScalarReplicatedStates(sid)?.commands.get()?.commands).toEqual(commands)
  })

  it('数据源层：权威翻新后查询即失效重拉，last-value 刷新为新快照（owner 恒等，非 RPC 响应直转发）', async () => {
    const fx = makeFixture()
    const sid = 'w12-cmds-src'
    const seeded = [{ name: 'seed-cmd' }] as PiCommandInfo[]
    const renewed = [{ name: 'renewed-cmd' }] as PiCommandInfo[]
    fx.client.getCommands.mockResolvedValueOnce(seeded)

    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)
    // 播种快照 == 播种 fetch 值（切换前激活发布口径 = 同值直连 RPC）
    const late1 = fx.bus.subscribe(sid, createMockWs())
    expect(findStateMsg(late1.stateSnapshot, 'session.commands')?.payload).toEqual({
      sessionId: sid,
      commands: seeded,
    })

    // 权威翻新 + 查询即失效（renderer 主动 getCommands）：防抖重拉后挂钩刷新 last-value。
    // mock 调用序：#1 播种（seeded）→ #2 查询 RPC → #3 防抖重拉（#2/#3 起权威值 = renewed）
    fx.client.getCommands.mockResolvedValueOnce(seeded).mockResolvedValue(renewed)
    await fx.svc.getCommands(sid)
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    const late2 = fx.bus.subscribe(sid, createMockWs())
    expect(findStateMsg(late2.stateSnapshot, 'session.commands')?.payload).toEqual({
      sessionId: sid,
      commands: renewed,
    })
    expect(fx.svc.getScalarReplicatedStates(sid)?.commands.get()?.commands).toEqual(renewed)
  })
})

describe('W12→W18 阶段 5：session.workflowUpdate 数据源 = entry 扫描派生缓存（事件直写退役，mock 事件流）', () => {
  /** 构造带 send 收集器 + 失效回调收集器的 EventInterpreter（同阶段 4 模式）。 */
  function makeInterpreter(sessionId: string): {
    interpreter: EventInterpreter
    frames: ServerMessage[]
    invalidations: Array<{ sessionId: string; customType: string }>
  } {
    const frames: ServerMessage[] = []
    const invalidations: Array<{ sessionId: string; customType: string }> = []
    const interpreter = new EventInterpreter(sessionId, {
      send: (m) => { frames.push(m) },
      onRecordEntriesInvalidated: (sid, customType) => { invalidations.push({ sessionId: sid, customType }) },
    })
    return { interpreter, frames, invalidations }
  }

  it('事件直写退役：workflow tool-call-end / workflow-result / record-entry-appended 都只触发失效回调，不产 session.workflowUpdate 帧', () => {
    const sid = 'w18-wf-retire'
    const { interpreter, frames, invalidations } = makeInterpreter(sid)
    interpreter.interpret([
      {
        kind: 'tool-call-end',
        toolCallId: 'tc-wf-1',
        toolName: 'workflow',
        isError: false,
        output: 'ok',
        details: { action: 'run', runId: 'w-run-1', status: 'running', name: 'review' },
        images: undefined,
        entry: { toolCallId: 'tc-wf-1' },
      } as unknown as PiTranslatedEvent,
    ])
    interpreter.interpret([
      {
        kind: 'message',
        message: {
          type: 'message.customStart' as ServerMessage['type'],
          payload: { sessionId: sid, customType: 'workflow-result', details: { runId: 'w-run-1', status: 'done', reason: 'completed', traceLength: 3 } },
        } as ServerMessage,
      } as unknown as PiTranslatedEvent,
    ])
    interpreter.interpret([{ kind: 'record-entry-appended', customType: 'workflow-record' } as PiTranslatedEvent])

    // 证伪影子路径：事件 payload 不再进任何数据缓存——无 session.workflowUpdate 帧产出
    expect(frames.filter((m) => m.type === 'session.workflowUpdate')).toHaveLength(0)
    expect(invalidations).toEqual([
      { sessionId: sid, customType: 'workflow-record' },
      { sessionId: sid, customType: 'workflow-record' },
      { sessionId: sid, customType: 'workflow-record' },
    ])
    // workflow-result customStart 帧照常转发前端（完成 turn 注入渲染不受影响）
    expect(frames.some((m) => m.type === 'message.customStart' && (m.payload as { customType?: string }).customType === 'workflow-result')).toBe(true)
  })

  it('无 customType 命中的 workflow 相关通知不触发失效（守卫语义保持）', () => {
    const sid = 'w18-wf-miss'
    const { interpreter, invalidations } = makeInterpreter(sid)
    interpreter.interpret([
      {
        kind: 'message',
        message: {
          type: 'message.customStart' as ServerMessage['type'],
          payload: { sessionId: sid, customType: 'workflow-other', details: { status: 'done' } },
        } as ServerMessage,
      } as PiTranslatedEvent,
    ])
    expect(invalidations).toHaveLength(0)
  })
})

