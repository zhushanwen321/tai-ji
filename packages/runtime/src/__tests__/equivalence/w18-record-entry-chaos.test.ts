/**
 * W18 混沌等价性用例（data-source-governance P3.1，场景 5 收尾）：
 * 丢失 entry_appended 广播 → 防抖/兜底重拉后状态收敛。
 *
 * 验收对照（w18-acceptance 交付物 5 / plan W18 验收标准 3）：「等价性测试注入
 * 丢失 entry_appended 广播（fixture 拦截不下发）→ 防抖/兜底重拉后状态收敛到正确值」。
 *
 * 注入层级选择（验收「真实 fixture 或 mock RPC 层二选一，禁 mock pi 本体逻辑」）：
 * mock RPC 层——EventInterpreter + SessionService + 真 MessageBus + mock client
 * （getEntries 返回 fixture 化 entry 数组，形态对齐 pi appendCustomEntry 契约 +
 * W16/W17 extension 写点 schema）。生产代码全链路真实执行（adapter translate →
 * interpreter 编排 → invalidateRecordEntries → 防抖 → get_entries 增量 → scan →
 * merge → publish），只拦截事件投递层模拟广播丢失。
 *
 * 收敛依据：extension 在 record 状态迁移点既 append 自描述 entry（entry_appended 主
 * 信号）又发 subagent-bg-notify / workflow-result 事件（兜底信号）——主信号被拦截时，
 * 兜底事件仍触发失效 → 重拉把「已持久化的 subagent-record entry」一并拉到 → 派生缓存
 * 收敛到 entry 扫描的权威值（与主信号在位时同值——这就是等价性断言）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'
import { translate } from '../../infra/pi/event-adapter.js'
import type { PiEvent } from '../../infra/pi/pi-protocol.js'
import { EventInterpreter } from '../../services/session/event-interpreter.js'
import { SessionService } from '../../services/session/session-service.js'
import { MessageBus } from '../../services/message-bus/message-bus.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../../services/session/replicated-states.config.js'
import type { IMessageBroker } from '../../interfaces.js'
import type { IPiEngine, IProcessManager } from '../../services/ports/pi-engine.js'
import type { BusClient } from '../../services/message-bus/types.js'

function createMockWs(): BusClient & { sent: string[] } {
  const sent: string[] = []
  return { readyState: 1, send: (payload: string) => { sent.push(payload) }, sent }
}

type GetEntriesResult = { data?: { entries?: unknown[]; leafId?: string | null } }

/** 自描述 subagent-record entry（W16 v1 完整快照，extension register/reportRecordTransition 写点产物）。 */
function subagentRecordEntry(id: string, status: string, entryId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: entryId,
    parentId: null,
    timestamp: '2026-08-19T00:00:00Z',
    data: { v: 1, id, agent: 'worker', task: 'Do work', slug: 'work', status, startedAt: 1000, ...extra },
  }
}

/** pi entry_appended 原始事件（agent-session appendEntry 回调发射形态：entry 内嵌）。 */
function entryAppendedPiEvent(entry: Record<string, unknown>): Record<string, unknown> {
  return { type: 'entry_appended', entry }
}

/** pi extension_ui_request{method:'notify'} 形态的 bg-notify 原始事件链的翻译替代：
 *  bg-notify 走 message_start{customType}（handleMessageStart customStart 分支）。 */
function bgNotifyMessageStartPiEvent(sessionId: string, details: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'message_start',
    message: { role: 'custom', customType: 'subagent-bg-notify', content: 'bg notify', details, display: false, timestamp: 0 },
    sessionId,
  }
}

describe('W18 equivalence: 丢失 entry_appended 广播 → 兜底失效重拉收敛（mock RPC 层）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('场景 5 收尾：拦截 entry_appended 不投递 → bg-notify 兜底事件触发失效 → 重拉收敛到 entry 扫描权威值', async () => {
    const sid = 'w18-chaos-drop'
    // pi 内存 entry 集合（get_entries 权威视图）：register(running) + 终态(closed) 两条自描述 entry
    const piEntries = [
      subagentRecordEntry('sa-chaos-1', 'running', 'e-1'),
      subagentRecordEntry('sa-chaos-1', 'closed', 'e-2', { closedReason: 'gc', endedAt: 61000, error: 'Model timeout' }),
    ]
    const client = {
      getEntries: vi.fn(async (_since?: string) => ({ data: { entries: [...piEntries], leafId: 'e-2' } }) as GetEntriesResult),
      getState: vi.fn(async () => ({ sessionName: 'w18', thinkingLevel: 'low', model: { id: 'm', provider: 'p' }, pendingMessageCount: 0 }) as Record<string, unknown>),
      getSessionStats: vi.fn(async () => ({ contextUsage: { tokens: 1000, contextWindow: 128000, percent: 1 } }) as Record<string, unknown>),
      getCommands: vi.fn(async () => [] as unknown),
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
      {} as never,
      { getDefaultModel: () => ({ provider: 'p', modelId: 'm' }) } as never,
      { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never,
      { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never,
      {} as never,
      bus,
    )
    svc.setMessageBus(bus)
    const ws = createMockWs()
    bus.subscribe(sid, ws)
    await svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)

    // 完整生产事件链：adapter translate → interpreter 编排（失效回调接线同组合根 index.ts）
    const interpreter = new EventInterpreter(sid, {
      send: (msg) => { bus.publish(sid, msg) },
      onRecordEntriesInvalidated: (s, customType) => { svc.invalidateRecordEntries(s, customType) },
    })

    // ── 正常路径基线（对照组）：entry_appended 投递 → 失效 → 重拉收敛 ──
    interpreter.interpret(translate(entryAppendedPiEvent(piEntries[1]!) as unknown as PiEvent, sid))
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    const normalMsgs = ws.sent.map((s) => JSON.parse(s) as ServerMessage).filter((m) => m.type === 'session.subagents')
    expect(normalMsgs).toHaveLength(1)
    expect(normalMsgs[0]!.payload).toEqual({
      sessionId: sid,
      // [U6/D5] closed 归一 idle + closedReason 保留（gc+error → 派生 stopReason:failed）
      subagents: [expect.objectContaining({ subagentId: 'sa-chaos-1', status: 'idle', closedReason: 'gc', stopReason: 'failed', error: 'Model timeout' })],
    })

    // ── 混沌注入：丢失 entry_appended 广播（拦截不下发）──
    // 终态迁移的第二条 subagent-record entry 已持久化进 pi entry 集合（append 与广播是
    // 两个环节——广播可丢，持久化不丢），但 entry_appended 事件被拦截。
    const droppedEntry = subagentRecordEntry('sa-chaos-2', 'running', 'e-3')
    piEntries.push(droppedEntry)
    // （不投递 entryAppendedPiEvent(droppedEntry)——这就是混沌注入）

    // sa-chaos-2 状态变化的另一路证据：bg-notify 事件照常到达（custom_message 不受
    // entry_appended 拦截影响）→ W18 兜底失效信号
    interpreter.interpret(translate(bgNotifyMessageStartPiEvent(sid, { id: 'sa-chaos-2', status: 'running', agent: 'worker' }) as unknown as PiEvent, sid))
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)

    // 收敛断言：兜底失效触发重拉，get_entries 把被拦截的 subagent-record entry 拉到 →
    // 派生缓存收敛到与「主信号在位」等价的权威值（sa-chaos-2 出现在列表中）
    const healedMsgs = ws.sent.map((s) => JSON.parse(s) as ServerMessage).filter((m) => m.type === 'session.subagents')
    expect(healedMsgs).toHaveLength(2)
    const healedSubs = (healedMsgs[1]!.payload as { subagents: Array<{ subagentId: string; status: string }> }).subagents
    expect(healedSubs.map((r) => r.subagentId).sort()).toEqual(['sa-chaos-1', 'sa-chaos-2'])
    expect(healedSubs.find((r) => r.subagentId === 'sa-chaos-2')!.status).toBe('running')
  })

  it('双信号全丢的兜底：entry_appended 与 bg-notify 都被拦截 → 后续任一事件（如下一条 entry_appended）触发重拉，历史丢失 entry 一并收敛', async () => {
    const sid = 'w18-chaos-both-drop'
    const piEntries = [subagentRecordEntry('sa-a', 'running', 'e-1')]
    const client = {
      getEntries: vi.fn(async (_since?: string) => ({ data: { entries: [...piEntries], leafId: `e-${piEntries.length}` } }) as GetEntriesResult),
      getState: vi.fn(async () => ({ sessionName: 'w18', thinkingLevel: 'low', model: { id: 'm', provider: 'p' }, pendingMessageCount: 0 }) as Record<string, unknown>),
      getSessionStats: vi.fn(async () => ({ contextUsage: { tokens: 1000, contextWindow: 128000, percent: 1 } }) as Record<string, unknown>),
      getCommands: vi.fn(async () => [] as unknown),
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
      {} as never,
      { getDefaultModel: () => ({ provider: 'p', modelId: 'm' }) } as never,
      { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never,
      { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never,
      {} as never,
      bus,
    )
    svc.setMessageBus(bus)
    const ws = createMockWs()
    bus.subscribe(sid, ws)
    await svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)

    const interpreter = new EventInterpreter(sid, {
      send: (msg) => { bus.publish(sid, msg) },
      onRecordEntriesInvalidated: (s, customType) => { svc.invalidateRecordEntries(s, customType) },
    })

    // 第一条 entry 的 entry_appended 与 bg-notify 全部被拦截（极端丢失）：无失效 → 无拉取
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    expect(client.getEntries).not.toHaveBeenCalled()

    // 第二条 entry_appended 正常到达（下一状态迁移）：触发重拉
    piEntries.push(subagentRecordEntry('sa-b', 'running', 'e-2'))
    interpreter.interpret(translate(entryAppendedPiEvent(piEntries[1]!) as unknown as PiEvent, sid))
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)

    // 收敛断言：重拉全量（cursor 为 null——首拉）把被丢失的 sa-a entry 一并拉到，
    // 派生缓存 == pi entry 集合扫描的权威全集（丢失窗口的 entry 不静默缺失）
    const subMsgs = ws.sent.map((s) => JSON.parse(s) as ServerMessage).filter((m) => m.type === 'session.subagents')
    expect(subMsgs).toHaveLength(1)
    const subs = (subMsgs[0]!.payload as { subagents: Array<{ subagentId: string }> }).subagents
    expect(subs.map((r) => r.subagentId).sort()).toEqual(['sa-a', 'sa-b'])
  })
})
