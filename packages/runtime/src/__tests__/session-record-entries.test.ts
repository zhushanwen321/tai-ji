/**
 * W18 单测：record entry 派生缓存——get_entries 增量拉取编排（mock RPC 层）。
 *
 * 验收对照（w18-acceptance 通过命令 3 / plan W18 验收标准 4）：
 * - 增量拉取：cursor 建立后失效 → client.getEntries(since=cursor)
 * - 游标失效全量自愈："Entry not found" → 丢 cursor → getEntries() 全量重建
 * - legacy 兜底：旧 session 无自描述 entry 重开列表仍显示（extractor 层单测覆盖
 *   scanSubagentEntries/scanWorkflowEntries 的 legacy 分支；本文件覆盖 RPC 编排链）
 *
 * mock 层级 = RPC（client.getEntries 可编程返回 entry 数组，entry 形态对齐 pi
 * appendCustomEntry 契约：{type:'custom', customType, data:{v:1,...}}）——生产代码
 * （invalidateRecordEntries → refreshRecordEntries → scan → merge → bus.publish）
 * 全部真实执行，不 mock。
 *
 * fake timers（项目规范）：SCALAR_STATE_DEBOUNCE_MS 防抖由 advanceTimersByTimeAsync 推进。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'
import { SessionService } from '../services/session/session-service.js'
import { MessageBus } from '../services/message-bus/message-bus.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../services/session/replicated-states.config.js'
import type { IMessageBroker } from '../interfaces.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { BusClient } from '../services/message-bus/types.js'

/** 收集型 mock ws（BusClient 契约）。 */
function createMockWs(): BusClient & { sent: string[] } {
  const sent: string[] = []
  return { readyState: 1, send: (payload: string) => { sent.push(payload) }, sent }
}

/** get_entries RPC 返回形态（pi GetEntriesResponse：{entries, leafId}）。 */
type GetEntriesResult = { data?: { entries?: unknown[]; leafId?: string | null } }

/** 自描述 subagent-record entry（W16 v1 完整快照）。 */
function subagentRecordEntry(id: string, status: string, entryId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: entryId,
    parentId: null,
    timestamp: '2026-08-19T00:00:00Z',
    data: {
      v: 1,
      id,
      agent: 'worker',
      task: 'Do work',
      slug: 'work',
      status,
      startedAt: 1000,
      ...extra,
    },
  }
}

/** 自描述 workflow-record entry（W17 v1：{v:1, snapshot, updatedAt}）。 */
function workflowRecordEntry(runId: string, status: 'running' | 'done', entryId: string, reason?: string): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'workflow-record',
    id: entryId,
    parentId: null,
    timestamp: '2026-08-19T00:00:00Z',
    data: {
      v: 1,
      updatedAt: '2026-08-19T00:00:01Z',
      snapshot: {
        v: 'wf-run-v2',
        runId,
        spec: { scriptName: 'test-flow' },
        state: { status, reason, budget: { usedTokens: 1, usedCost: 0 }, calls: [], trace: [] },
        meta: { startedAt: '2026-08-19T00:00:00Z' },
      },
    },
  }
}

/**
 * 最小装置：真 MessageBus + mock client（getEntries / getState / getSessionStats /
 * getCommands 可编程）。SessionService 构造形态对齐 w12-owner-snapshot-publish。
 */
function makeFixture() {
  const client = {
    getEntries: vi.fn(async (_since?: string) => ({ data: { entries: [], leafId: null } }) as GetEntriesResult),
    getState: vi.fn(async () => ({ sessionName: 'w18', thinkingLevel: 'low', model: { id: 'm', provider: 'p' }, pendingMessageCount: 0 }) as Record<string, unknown>),
    getSessionStats: vi.fn(async () => ({ contextUsage: { tokens: 1000, contextWindow: 128000, percent: 1 } }) as Record<string, unknown>),
    getCommands: vi.fn(async () => [] as unknown),
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
    { getDefaultModel: () => ({ provider: 'p', modelId: 'm' }) } as never, // configStore
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never, // sessionStore
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService
    bus,
  )
  svc.setMessageBus(bus)
  return { svc, bus, client }
}

/** 订阅 ws 上指定 type 的已收消息列表。 */
function received(ws: { sent: string[] }, type: string): ServerMessage[] {
  return ws.sent.map((s) => JSON.parse(s) as ServerMessage).filter((m) => m.type === type)
}

describe('W18：record entry 派生缓存——增量拉取编排（mock RPC 层）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('初始态全量：首次失效（cursor=null）→ getEntries() 无参全量 → 发布 session.subagents / session.workflowUpdate', async () => {
    const fx = makeFixture()
    const sid = 'w18-full'
    const ws = createMockWs()
    fx.bus.subscribe(sid, ws)
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)

    fx.client.getEntries.mockResolvedValueOnce({
      data: {
        entries: [
          subagentRecordEntry('sa-1', 'running', 'e-1'),
          workflowRecordEntry('wf-1', 'running', 'e-2'),
        ],
        leafId: 'e-2',
      },
    } as GetEntriesResult)

    fx.svc.invalidateRecordEntries(sid, 'subagent-record')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)

    // 首拉全量：getEntries 无 since 参数
    expect(fx.client.getEntries).toHaveBeenCalledWith()
    const subMsgs = received(ws, 'session.subagents')
    expect(subMsgs).toHaveLength(1)
    expect(subMsgs[0]!.payload).toEqual({
      sessionId: sid,
      subagents: [expect.objectContaining({ subagentId: 'sa-1', status: 'running' })],
    })
    const wfMsgs = received(ws, 'session.workflowUpdate')
    expect(wfMsgs).toHaveLength(1)
    expect(wfMsgs[0]!.payload).toEqual({ sessionId: sid, update: { runId: 'wf-1', status: 'running', reason: undefined } })
    // stateSnapshot last-value（重连恢复语义）：subagents 帧入快照
    const late = fx.bus.subscribe(sid, createMockWs())
    expect(late.stateSnapshot.some((m: ServerMessage) => m.type === 'session.subagents')).toBe(true)
  })

  it('增量拉取：cursor 建立后失效 → getEntries(since=cursor)，merge 增量快照', async () => {
    const fx = makeFixture()
    const sid = 'w18-inc'
    const ws = createMockWs()
    fx.bus.subscribe(sid, ws)
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)

    // 首次全量：sa-1 running + leafId e-2
    fx.client.getEntries.mockResolvedValueOnce({
      data: { entries: [subagentRecordEntry('sa-1', 'running', 'e-1')], leafId: 'e-1' },
    } as GetEntriesResult)
    fx.svc.invalidateRecordEntries(sid, 'subagent-record')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    expect(received(ws, 'session.subagents')).toHaveLength(1)

    // 第二次失效：增量窗口（since=e-1）只带终态快照
    fx.client.getEntries.mockResolvedValueOnce({
      data: { entries: [subagentRecordEntry('sa-1', 'closed', 'e-2', { closedReason: 'gc', endedAt: 61000, error: 'boom' })], leafId: 'e-2' },
    } as GetEntriesResult)
    fx.svc.invalidateRecordEntries(sid, 'subagent-record')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)

    // 增量拉取带 since=上次 leafId
    expect(fx.client.getEntries).toHaveBeenCalledWith('e-1')
    const subMsgs = received(ws, 'session.subagents')
    expect(subMsgs).toHaveLength(2)
    // merge 后终态收敛（增量快照覆盖 running 基线，列表仍是全量派生）
    expect(subMsgs[1]!.payload).toEqual({
      sessionId: sid,
      // [U6/D5] closed 归一 idle + closedReason 保留（gc+error → 派生 stopReason:failed）
      subagents: [expect.objectContaining({ subagentId: 'sa-1', status: 'idle', closedReason: 'gc', stopReason: 'failed' })],
    })
  })

  it('防抖合并 + 变化抑制：窗口内多次失效只拉一次；无变化的拉取不重复发布', async () => {
    const fx = makeFixture()
    const sid = 'w18-debounce'
    const ws = createMockWs()
    fx.bus.subscribe(sid, ws)
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)

    fx.client.getEntries.mockResolvedValue({
      data: { entries: [subagentRecordEntry('sa-1', 'running', 'e-1')], leafId: 'e-1' },
    } as GetEntriesResult)

    // 窗口内连续三次失效（主信号 + 双兜底事件的真实形态）
    fx.svc.invalidateRecordEntries(sid, 'subagent-record')
    fx.svc.invalidateRecordEntries(sid, 'subagent-record')
    fx.svc.invalidateRecordEntries(sid, 'subagent-record')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    expect(fx.client.getEntries).toHaveBeenCalledTimes(1)
    expect(received(ws, 'session.subagents')).toHaveLength(1)

    // 窗口后再失效但权威无变化（同快照重拉）→ 不重复发布（diff 抑制）
    fx.svc.invalidateRecordEntries(sid, 'subagent-record')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    expect(fx.client.getEntries).toHaveBeenCalledTimes(2)
    expect(received(ws, 'session.subagents')).toHaveLength(1)
  })

  it('游标失效自愈：getEntries(since) 报 Entry not found → 丢 cursor → getEntries() 全量重建收敛', async () => {
    const fx = makeFixture()
    const sid = 'w18-heal'
    const ws = createMockWs()
    fx.bus.subscribe(sid, ws)
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)

    // 首次全量建立 cursor e-1
    fx.client.getEntries.mockResolvedValueOnce({
      data: { entries: [subagentRecordEntry('sa-1', 'running', 'e-1')], leafId: 'e-1' },
    } as GetEntriesResult)
    fx.svc.invalidateRecordEntries(sid, 'subagent-record')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)

    // 增量拉取报 Entry not found（pi 文案 'Entry not found: <id>'，rpc-client 经 sendCommand reject Error）
    fx.client.getEntries.mockRejectedValueOnce(new Error('Entry not found: e-1'))
    // 自愈全量：新 entry 集合（旧 entry 已被外部改写消失，新基线 e-9）
    fx.client.getEntries.mockResolvedValueOnce({
      data: { entries: [subagentRecordEntry('sa-2', 'closed', 'e-9', { closedReason: 'gc', endedAt: 2000 })], leafId: 'e-9' },
    } as GetEntriesResult)

    fx.svc.invalidateRecordEntries(sid, 'subagent-record')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 200)

    // 增量尝试（since=e-1）失败 → 全量重拉（无 since）
    const calls = fx.client.getEntries.mock.calls
    expect(calls[calls.length - 2]![0]).toBe('e-1')
    expect(calls[calls.length - 1]).toHaveLength(0)
    // 全量重建 = 新基线整体替换（sa-1 消失、sa-2 在位）
    const subMsgs = received(ws, 'session.subagents')
    expect(subMsgs[subMsgs.length - 1]!.payload).toEqual({
      sessionId: sid,
      // [U6/D5] closed 归一 idle（gc 无 error → 派生 completed）
      subagents: [expect.objectContaining({ subagentId: 'sa-2', status: 'idle', stopReason: 'completed' })],
    })
  })

  it('其他 RPC 错误：保留 cursor 不发布，下次失效仍走增量重试', async () => {
    const fx = makeFixture()
    const sid = 'w18-retry'
    const ws = createMockWs()
    fx.bus.subscribe(sid, ws)
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)

    fx.client.getEntries.mockResolvedValueOnce({
      data: { entries: [subagentRecordEntry('sa-1', 'running', 'e-1')], leafId: 'e-1' },
    } as GetEntriesResult)
    fx.svc.invalidateRecordEntries(sid, 'subagent-record')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    expect(received(ws, 'session.subagents')).toHaveLength(1)

    // 超时类错误：不发布（快照未变）
    fx.client.getEntries.mockRejectedValueOnce(new Error('RPC timed out'))
    fx.svc.invalidateRecordEntries(sid, 'subagent-record')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    expect(received(ws, 'session.subagents')).toHaveLength(1)

    // 下次失效：仍走增量（cursor 未丢）
    fx.client.getEntries.mockResolvedValueOnce({
      data: { entries: [subagentRecordEntry('sa-1', 'closed', 'e-2', { closedReason: 'gc' })], leafId: 'e-2' },
    } as GetEntriesResult)
    fx.svc.invalidateRecordEntries(sid, 'subagent-record')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    expect(fx.client.getEntries).toHaveBeenLastCalledWith('e-1')
    const subMsgs = received(ws, 'session.subagents')
    expect(subMsgs[subMsgs.length - 1]!.payload).toEqual({
      sessionId: sid,
      // [U6/D5] closed 归一 idle
      subagents: [expect.objectContaining({ subagentId: 'sa-1', status: 'idle' })],
    })
  })

  it('无效 customType 不触发拉取（守卫）+ 未激活 session（无缓存条目）no-op', async () => {
    const fx = makeFixture()
    const sid = 'w18-guard'
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)

    fx.svc.invalidateRecordEntries(sid, 'some-other-custom-type')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    expect(fx.client.getEntries).not.toHaveBeenCalled()

    fx.svc.invalidateRecordEntries('ghost-session', 'subagent-record')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    expect(fx.client.getEntries).not.toHaveBeenCalled()
  })

  it('workflow 状态变化才发增量信号（同状态重拉不重复发 workflowUpdate 帧）', async () => {
    const fx = makeFixture()
    const sid = 'w18-wf-diff'
    const ws = createMockWs()
    fx.bus.subscribe(sid, ws)
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)

    fx.client.getEntries.mockResolvedValueOnce({
      data: { entries: [workflowRecordEntry('wf-1', 'running', 'e-1')], leafId: 'e-1' },
    } as GetEntriesResult)
    fx.svc.invalidateRecordEntries(sid, 'workflow-record')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    expect(received(ws, 'session.workflowUpdate')).toHaveLength(1)

    // 同状态快照重拉（running 未变）：不发 workflowUpdate
    fx.client.getEntries.mockResolvedValueOnce({
      data: { entries: [workflowRecordEntry('wf-1', 'running', 'e-2')], leafId: 'e-2' },
    } as GetEntriesResult)
    fx.svc.invalidateRecordEntries(sid, 'workflow-record')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    expect(received(ws, 'session.workflowUpdate')).toHaveLength(1)

    // 终态（done + reason）：发增量信号
    fx.client.getEntries.mockResolvedValueOnce({
      data: { entries: [workflowRecordEntry('wf-1', 'done', 'e-3', 'completed')], leafId: 'e-3' },
    } as GetEntriesResult)
    fx.svc.invalidateRecordEntries(sid, 'workflow-record')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    const wfMsgs = received(ws, 'session.workflowUpdate')
    expect(wfMsgs).toHaveLength(2)
    expect(wfMsgs[1]!.payload).toEqual({ sessionId: sid, update: { runId: 'wf-1', status: 'done', reason: 'completed' } })
  })

  it('session 删除：removeSessionEntry 清防抖定时器与缓存条目（无泄漏 / 删除后失效 no-op）', async () => {
    const fx = makeFixture()
    const sid = 'w18-cleanup'
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)

    // 失效排定防抖后立即删除 session：定时器应被清（不触发拉取）
    fx.svc.invalidateRecordEntries(sid, 'subagent-record')
    fx.svc.removeSessionEntry(sid)
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    expect(fx.client.getEntries).not.toHaveBeenCalled()
  })
})
