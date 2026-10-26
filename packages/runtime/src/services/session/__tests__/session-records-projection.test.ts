/**
 * SessionRecords 投影/观测切面合并测试（plan-state 首帧 / W0 观测 / subagent-model 详情 / workflow 可视化投影 / workflow 信号门）。
 *
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper/mock 随节下沉）：
 * - session-records.test.ts
 * - plan-state-first-entry-frame.test.ts
 * - session-records-w0-observe.test.ts
 * - subagent-model-detail.test.ts
 * - workflow-viz-projection.test.ts
 * - session-records-workflow-signal-gate.test.ts
 *
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/services/session/__tests__/session-records-projection.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, utimesSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { ServerMessage, SubagentModelOverrideStatus, SubagentRecord } from '@taiji/shared'
import { getSessionStoreDir } from '@taiji/shared/paths'
import type { SubagentJournalEvent, SubagentJournalReport } from '@zhushanwen/extension-protocol'
import type { RunEventFoldCheckpoint, WorkflowRecordRegisteredEntryData } from '@zhushanwen/subagent-core'
import { getSubagentRecordsDir, resolvePiWorkflowRunsDir, getSubagentMessageResultsDir, WORKFLOW_RECORD_CUSTOM_TYPE } from '@zhushanwen/subagent-core'
import { logger } from '../../../infra/logger.js'
import { EventAdapter } from '../../../infra/pi/event-adapter.js'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import { MessageBus } from '../../message-bus/message-bus.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import { EventInterpreter } from '../event-interpreter.js'
import { routeJournalReport } from '../journal-report-router.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../replicated-states.config.js'
import type { SessionRecordsDeps } from '../session-records.js'
import { SessionRecords, encodeDirectiveText, filterReadableWorkflowSignals } from '../session-records.js'
import type { SessionRegisteredSource } from '../session-state-projection.js'
import type { SkillInjector, SkillInjectionResult } from '../skill-injector.js'
import { readPiSessionLatestModelChange, DEFAULT_SUBAGENT_ENGINE } from '../subagent-engine-history.js'
import { extractSubagentsFromSessionFile } from '../subagent-extractor.js'
import { extractWorkflowsFromSessionFile } from '../workflow-extractor.js'
import { projectSubagentModelDetailIntoRuns, projectV2Workflow } from '../workflow-record-projection.js'

const loggerInfo = vi.mocked((await import('../../../infra/logger.js')).logger.info)
const loggerWarn = vi.mocked((await import('../../../infra/logger.js')).logger.warn)

describe('plan-state-first-entry-frame', () => {
/**
 * 全链锁定测试：新 session 的首个 plan-state entry → session.planState 帧及时发布
 *（plan-mode 状态带延迟 P1 排障，2026-09-24 真机会话 01a0d49f 的机器证据固化）。
 *
 * 链路形态对齐生产组合根（index.ts createAdapter + SessionRecords.subscribe）：
 *
 *   pi 广播 entry_appended(plan-state)
 *     → EventAdapter.handleEntryAppended（翻译 record-entry-appended）
 *     → EventInterpreter.handleConversationEvent → onRecordEntriesInvalidated
 *     → SessionRecords.invalidateRecordEntries（防抖 SCALAR_STATE_DEBOUNCE_MS）
 *     → refreshRecordEntries（getEntries 全量，cursor=null 首次拉取）
 *     → applyRecordEntries → mergePlanState → publishRecordChanges
 *     → MessageBus.publish（state 类 typeKey='plan'：stateSnapshot 覆盖 + 定向推送订阅 ws）
 *
 * 真机证据锚点（排障会话已核实，此处以测试固化语义防回归）：
 * - pi stdout tee：/plan command handler 的 appendEntry 同步 _emit entry_appended
 *   （agent-session.js bindCore appendEntry：appendCustomEntry 后立即广播，无 turn 边界延迟）；
 * - W18 防抖 300ms 后的 getEntries 首次拉取返回全量 entries 含 plan-state（cursor 随 leafId 推进，
 *   后续 15s 对账 sweep 全走增量——tee rpc_14→rpc_17 链）。
 *
 * 两个用例分别锁定「实时路径」（订阅在发布前建立，帧经 broadcastText 直达）与
 * 「恢复路径」（发布早于订阅，帧经 subscribe 应答 stateSnapshot 回放——切走再切回/
 * 断连重连的恢复语义）。
 *
 * 第四用例锁定「丢弃且不补发机制」（2026-09-24 真机会话 01a0d509 形态 B 判定固化）：
 * publish 时无订阅者 → 水位照样推进（u0 校准：publish 调用完成即推进）→ 15s 定时路径与
 * agent_settled 路径 diff 恒空不补发 → 帧仅经 subscribe stateSnapshot 恢复。该形态下
 * 黑洞持续 = 设计内（对账路径只覆盖「merge 已对、publish 跳丢」，丢弃靠快照兜底），
 * 恢复触发点全在消费侧（重连/切回的重订阅）——本用例把这一判定固定为，防止后续把
 * 水位语义改掉时无测试显形。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/plan-state-first-entry-frame.test.ts
 */
/** pi entry_appended 事件载荷形态（agent-session bindCore appendEntry 的 _emit 原文）。 */
function piEntryAppendedEvent(customType: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'entry_appended',
    entry: { type: 'custom', customType, data, id: 'e-plan-1', parentId: null, timestamp: '2026-09-24T18:13:41.942Z' },
  }
}

/** 首 plan-state entry 的 data（真机 fixture 派生视图：/plan 进入 planning 态）。 */
const PLAN_ENTRY_DATA: Record<string, unknown> = {
  isActive: true,
  planFilePath: '/tmp/taiji-plan/theme/plan.md',
  requirement: '给设置页加主题切换',
  templateName: '',
  skills: ['tech-design'],
  docs: [],
  state: 'planning',
}

/** get_entries 全量响应（cursor=null 首次拉取形态：entries + leafId）。 */
function getEntriesResponse(entries: unknown[], leafId: string): Record<string, unknown> {
  return { data: { entries, leafId } }
}

/**
 * 最小装置：真 EventAdapter + 真 EventInterpreter + 真 SessionRecords + 真 MessageBus，
 * 只 mock pi client（onEvent 分发 + getEntries RPC）与 ws 订阅者（send 收集）。
 * 装配顺序对齐生产：SessionRecords.subscribe 先注册（组合根装配期），session 注册
 * （fire）→ adapter 构造 + attach → 事件流入。
 */
function makePipeline(entriesForFirstPull: unknown[], leafId = 'leaf-1') {
  const bus: IMessageBus = new MessageBus()
  const received: ServerMessage[] = []
  const ws = { readyState: 1, send: (text: string) => { received.push(JSON.parse(text) as ServerMessage) } }

  const listeners: Array<(event: unknown) => void> = []
  const client = {
    onEvent: (listener: (event: unknown) => void) => {
      listeners.push(listener)
      return () => {
        const idx = listeners.indexOf(listener)
        if (idx >= 0) listeners.splice(idx, 1)
      }
    },
    // 按生产 cursor 三路径分流：无参（cursor=null 全量）返回 fixture；带 since（增量）
    // 返回空批——对账路径的稳态形态（真机 15s sweep 空增量 rpc 同形）。
    getEntries: vi.fn(async (since?: string) =>
      since === undefined ? getEntriesResponse(entriesForFirstPull, leafId) : { data: { entries: [], leafId } },
    ),
    prompt: vi.fn(async () => undefined),
  }

  const deps: SessionRecordsDeps = {
    pm: { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager,
    sessionStore: { scanSessions: vi.fn(() => []) } as unknown as ISessionStore,
    hasSession: vi.fn(() => true),
    getMessageBus: () => bus,
  }
  const records = new SessionRecords(deps)

  // 组合根装配期订阅（生产：Facade 构造器先调 subscribe(lifecycle)）
  const registeredHandlers: Array<(sessionId: string) => void> = []
  records.subscribe({ onSessionRegistered: (h) => { registeredHandlers.push(h) } })

  // session 注册（生产：registerSession 的 emitSessionRegistered 同步直发 → ensureRecordEntriesCache）
  const fireRegistered = (sessionId: string) => { for (const h of registeredHandlers) h(sessionId) }

  // interpreter + adapter 装配（生产：createAdapter 闭包，registerSession 内 attach）
  const makeAdapter = (sessionId: string) => {
    const interpreter = new EventInterpreter(sessionId, {
      send: () => {},
      onRecordEntriesInvalidated: (sid, customType) => { records.invalidateRecordEntries(sid, customType) },
    })
    return new EventAdapter(sessionId, (events) => { interpreter.interpret(events) })
  }

  const emitPiEvent = (event: unknown) => { for (const l of [...listeners]) l(event) }

  return { bus, received, ws, client, records, fireRegistered, makeAdapter, emitPiEvent }
}

/** 从收到的帧里取 planState 帧。 */
function planStateFrames(frames: ServerMessage[]): ServerMessage[] {
  return frames.filter((m) => m.type === 'session.planState')
}

describe('全链：首个 plan-state entry → session.planState 帧及时发布', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('实时路径：订阅先建立，entry_appended → 防抖 → 全量拉取 → 帧经 ws 直达（isActive:true 首帧）', async () => {
    const entries = [
      { type: 'model_change', id: 'e0' },
      { type: 'thinking_level_change', id: 'e1' },
      { type: 'custom', customType: 'plan-state', data: PLAN_ENTRY_DATA, id: 'e-plan-1' },
    ]
    const p = makePipeline(entries)
    p.fireRegistered('s1')
    p.bus.subscribe('s1', p.ws)
    p.makeAdapter('s1').attach(p.client)

    // pi 广播（/plan command handler 的 appendEntry 同步 emit）
    p.emitPiEvent(piEntryAppendedEvent('plan-state', PLAN_ENTRY_DATA))

    // 帧未发布于防抖窗口内（300ms 削峰语义保持：提前到 299ms 仍零帧）
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS - 1)
    expect(planStateFrames(p.received)).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    const frames = planStateFrames(p.received)
    expect(frames).toHaveLength(1)
    expect((frames[0].payload as { planState: { isActive: boolean; state: string } }).planState)
      .toMatchObject({ isActive: true, state: 'planning' })
    // 拉取走全量（cursor=null 首次拉取，无 since 参数）
    expect(p.client.getEntries).toHaveBeenCalledWith()
  })

  it('恢复路径：帧发布早于订阅，subscribe 应答 stateSnapshot 含 plan 帧（切走再切回恢复语义）', async () => {
    const entries = [{ type: 'custom', customType: 'plan-state', data: PLAN_ENTRY_DATA, id: 'e-plan-1' }]
    const p = makePipeline(entries)
    p.fireRegistered('s1')
    p.makeAdapter('s1').attach(p.client)

    // 订阅尚未建立（renderer 激活竞态窗口）：帧照常发布
    p.emitPiEvent(piEntryAppendedEvent('plan-state', PLAN_ENTRY_DATA))
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS)
    expect(planStateFrames(p.received)).toHaveLength(0) // 无订阅者：无直推

    // 订阅建立（切回/重连）：stateSnapshot 回放恢复
    const sub = p.bus.subscribe('s1', p.ws)
    const snapshotFrames = planStateFrames(sub.stateSnapshot)
    expect(snapshotFrames).toHaveLength(1)
    expect((snapshotFrames[0].payload as { planState: { isActive: boolean } }).planState.isActive).toBe(true)
  })

  it('稳态零帧：同值 entry 再到达（防抖合并 + 水位 diff 恒等）不重复发布', async () => {
    const entries = [{ type: 'custom', customType: 'plan-state', data: PLAN_ENTRY_DATA, id: 'e-plan-1' }]
    const p = makePipeline(entries)
    p.fireRegistered('s1')
    p.bus.subscribe('s1', p.ws)
    p.makeAdapter('s1').attach(p.client)

    p.emitPiEvent(piEntryAppendedEvent('plan-state', PLAN_ENTRY_DATA))
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS)
    expect(planStateFrames(p.received)).toHaveLength(1)

    // 同值 entry（state 无变化不写新 entry 的探索期后首次重写同值）——水位 diff 恒等零帧
    p.emitPiEvent(piEntryAppendedEvent('plan-state', PLAN_ENTRY_DATA))
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS)
    expect(planStateFrames(p.received)).toHaveLength(1)
  })

  it('丢弃且不补发机制（真机 01a0d509 形态 B）：无订阅者 publish 后水位推进 → 定时/settled 两路径不补发，帧仅经 subscribe 快照恢复', async () => {
    const entries = [{ type: 'custom', customType: 'plan-state', data: PLAN_ENTRY_DATA, id: 'e-plan-1' }]
    const p = makePipeline(entries)
    p.fireRegistered('s1')
    p.makeAdapter('s1').attach(p.client)

    // renderer 订阅窗口（真机 20:09:35.89-20:18:24 订阅未建立）：publish 照常发生但丢弃
    p.emitPiEvent(piEntryAppendedEvent('plan-state', PLAN_ENTRY_DATA))
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS)
    expect(planStateFrames(p.received)).toHaveLength(0) // 无订阅者：无直推（真机 20:09:36.204）

    // agent_settled 路径同样不补（publish 调用已完成，水位已推进——对账路径只覆盖 publish 跳丢形态）
    p.records.reconcileRecordEntries('s1')
    await vi.advanceTimersByTimeAsync(0)
    expect(planStateFrames(p.received)).toHaveLength(0)

    // 恢复路径（真机 20:18:25.082 重连重订阅）：帧仅经 subscribe 应答 stateSnapshot 回放
    const sub = p.bus.subscribe('s1', p.ws)
    const snapshotFrames = planStateFrames(sub.stateSnapshot)
    expect(snapshotFrames).toHaveLength(1)
    expect((snapshotFrames[0].payload as { planState: { isActive: boolean } }).planState.isActive).toBe(true)
  })
})
})

describe('session-records-w0-observe', () => {
/**
 * SessionRecords W0 观测范围 + R11/6c3 从根源修复回归（pull-push-architecture W0 / D7）。
 *
 * 覆盖：
 * - 6c3 从根源修复回归：纯 plan session 首次拉取失败（pi client 不可得 / RPC 错误）后，修复前
 *   planState 恒 null 不在对账域、agent_settled 路径永久跳过 → 「全程零发布」持续态；
 *   修复后 awaitingFirstPull 纳入对账域，对账路径持续重试直至首轮拉取成功并补发 planState。
 * - 首次拉取未决解除语义：成功一轮（含空增量轮）清 awaitingFirstPull——纯聊天 session
 *   （缓存全空）回归既有域外语义（reconcile.test.ts 扫描域门用例的对偶面）。
 * - P-1 探针（cursor 管线与 WS 推送独立路径）：真实 MessageBus 无订阅者丢弃形态 / bus
 *   未注入形态下，cursor 照常推进（后续失效走增量 RPC）、派生缓存照常正确——推送路径
 *   完全缺席不伤缓存路径（pull-push §2 前提 P-1 的行为证据，W1 缓存优先的前置确认）。
 * - 断点显形 warn：失效无缓存（未注册/已销毁）、pi client 不可得、bus 未注入三处此前
 *   静默断点（R11「发布/订阅侧零日志」的排障盲点）落结构化 warn。
 * - 发布观测：水位门后有帧落 info（域键 frames + 触发路径 trigger + 耗时 elapsedMs）；
 *   稳态零帧零日志（S5「无噪声」锚）。
 *
 * 分层：mock 层 = deps（与 session-records.test.ts 同形态）+ vi.mock logger；fixture
 * 复制自 session-records-reconcile.test.ts（测试文件间不互相 import）。fake timers。
 */
vi.mock('../../../infra/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))




/** get_entries RPC 返回形态（pi GetEntriesResponse：{entries, leafId}）。 */
type GetEntriesResult = { data?: { entries?: unknown[]; leafId?: string | null } }

/** plan-state entry fixture（data 平面四必填 + reviewState；复制自 reconcile.test.ts）。 */
function planStateEntry(data: Record<string, unknown>, entryId: string): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'plan-state',
    id: entryId,
    parentId: null,
    timestamp: '2026-09-18T00:00:00Z',
    data,
  }
}

function fullPlanData(reviewState: 'awaiting' | 'revising'): Record<string, unknown> {
  return {
    isActive: true,
    planFilePath: '/tmp/taiji-plan/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'tech-design',
    skills: ['tech-design'],
    docs: [],
    reviewState,
  }
}

/** 最小装置：deps 全 mock（publish spy 收集 bus 发布；client 可编程）。 */
function makeRecords(depsOverrides: Partial<SessionRecordsDeps> = {}) {
  const publish = vi.fn()
  const client = {
    getEntries: vi.fn(async (_since?: string) => ({ data: { entries: [], leafId: null } }) as GetEntriesResult),
    prompt: vi.fn(async (_text: string) => undefined),
  }
  const deps: SessionRecordsDeps = {
    pm: { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager,
    sessionStore: { scanSessions: vi.fn(() => [] as Array<{ id: string; filePath: string }>) } as unknown as ISessionStore,
    hasSession: vi.fn(() => true),
    getMessageBus: () => ({ publish } as unknown as IMessageBus),
    ...depsOverrides,
  }
  const records = new SessionRecords(deps)
  return { records, publish, client, deps }
}

/** subscribe 后收集注册 handler，返回手动触发器（模拟 lifecycle 同步直发）。 */
function registerSession(records: SessionRecords): (sessionId: string) => void {
  const handlers: Array<(sessionId: string) => void> = []
  records.subscribe({ onSessionRegistered: (h) => { handlers.push(h) } })
  return (sessionId: string) => { for (const h of handlers) h(sessionId) }
}

/** 推进防抖并等待在途拉取落定。 */
async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS)
}

/** 冲刷微任务（对账路径的 fire-and-forget 拉取落定）。 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function planFramesOf(publish: ReturnType<typeof vi.fn>): unknown[] {
  return publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.planState')
}

/** v2 workflow 注册条目 entry（fixture 形态对齐 events-projection.test.ts 同名 helper）。 */
function workflowRegisteredEntry(runId: string, recordPath: string): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'workflow-record',
    id: 'e-wf-1',
    parentId: null,
    timestamp: '2026-10-02T00:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      runId,
      workflowName: 'test-flow',
      scriptName: 'test-flow',
      slug: 'tf',
      startedAt: 1000,
      recordPath,
    },
  }
}

function workflowFramesOf(publish: ReturnType<typeof vi.fn>): unknown[] {
  return publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.workflowUpdate')
}

function framesPublishedEvents(): Array<[string, Record<string, unknown>]> {
  return loggerInfo.mock.calls.filter(
    ([m]) => m === '[session-records] record frames published',
  ) as unknown as Array<[string, Record<string, unknown>]>
}

function warnsOf(prefix: string): Array<unknown[]> {
  return loggerWarn.mock.calls.filter(([m]) => String(m).startsWith(prefix))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('R11/6c3 从根源修复：首次拉取未决纳入对账域（awaitingFirstPull）', () => {
  it('首次拉取失败（pi client 不可得）→ 对账路径重试 → planState 补发（从根源修复回归主锚）', async () => {
    let piUp = false
    const { records, publish, client } = makeRecords({
      pm: { getClient: vi.fn(() => (piUp ? (client as unknown as IPiEngine) : null)) } as unknown as IProcessManager,
    })
    const fire = registerSession(records)
    fire('s1')

    // 首轮失效：pi 未就绪 → 拉取未执行、零发布（修复前此后永久断链）
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(publish).not.toHaveBeenCalled()
    expect(warnsOf('[session-records] refresh skipped: pi client unavailable')).toHaveLength(1)

    // pi 就绪，无任何新失效信号——agent_settled 对账路径触发（修复前：域外 no-op）
    piUp = true
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    records.reconcileRecordEntries('s1')
    await flushMicrotasks()

    expect(client.getEntries).toHaveBeenCalledWith() // 全量首次拉取发生
    expect(planFramesOf(publish)).toHaveLength(1) // planState 补发（零发布持续态被打破）
    // 首次拉取成功后 awaitingFirstPull 清除：planState 已派生非 null → session 回归内容域
    // （对账照常触发走增量），但水位 diff 空 → 零新帧（未决重试语义不残留）
    client.getEntries.mockClear()
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'e1' } })
    const framesBefore = publish.mock.calls.length
    records.reconcileRecordEntries('s1')
    await flushMicrotasks()
    expect(client.getEntries).toHaveBeenCalledTimes(1) // 内容域内：增量对账正常
    expect(client.getEntries).toHaveBeenCalledWith('e1')
    expect(publish.mock.calls.length).toBe(framesBefore) // 水位 diff 空：零新帧
  })

  it('首次拉取失败（RPC 错误）→ 对账路径重试 → planState 补发', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    client.getEntries.mockRejectedValueOnce(new Error('rpc transport boom'))
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(publish).not.toHaveBeenCalled()

    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    records.reconcileRecordEntries('s1')
    await flushMicrotasks()
    expect(planFramesOf(publish)).toHaveLength(1)
  })

  it('成功一轮（空增量轮）即解除未决：纯聊天 session 回归域外语义（无高频全量放大）', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    // 失效触发全量拉取：全集无 record entry（空轮成功，leafId 推进）
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'e1' } })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledTimes(1)

    // 未决已清 + 缓存全空 → 对账域外：定时路径 sweep 亦不触发 RPC
    client.getEntries.mockClear()
    records.reconcileRecordEntries('s1')
    await flushMicrotasks()
    expect(client.getEntries).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(16_000)
    expect(client.getEntries).not.toHaveBeenCalled()
  })
})

describe('P-1 探针：cursor 管线与 WS 推送独立路径（pull-push §2 前提 P-1）', () => {
  it('丢弃形态（真实 MessageBus 无订阅者）：推送路径缺席，cursor 照常推进、派生照常发生', async () => {
    const realBus = new MessageBus() // 无订阅者：publish 即丢弃（6c3 类形态）
    const { records, client } = makeRecords({ getMessageBus: () => realBus })
    const fire = registerSession(records)
    fire('s1')

    // 轮 1：全量首次拉取（丢弃发生——不抛错、不阻断）
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    // 轮 2：cursor 已推进 → 失效走增量 RPC（since='e1'）——缓存路径健康的行为证据
    client.getEntries.mockClear()
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'e1' } })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledWith('e1')

    // 未决已清（首轮成功）+ planState 派生非空 → 对账域由内容承载（后续对账走增量）
    client.getEntries.mockClear()
    records.reconcileRecordEntries('s1')
    await flushMicrotasks()
    expect(client.getEntries).toHaveBeenCalledWith('e1')
  })

  it('bus 未注入形态：cursor 管线照常推进（推送路径完全缺失不伤缓存路径）', async () => {
    const { records, client } = makeRecords({ getMessageBus: () => null })
    const fire = registerSession(records)
    fire('s1')

    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    client.getEntries.mockClear()
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'e1' } })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledWith('e1') // cursor 推进证据（增量拉取）
  })
})

describe('断点显形 warn + 发布观测（W0 观测范围）', () => {
  it('失效无缓存（未注册 session）落结构化 warn（此前静默 no-op 零日志）', () => {
    const { records } = makeRecords()
    records.invalidateRecordEntries('s-unknown', 'plan-state')
    const hits = warnsOf('[session-records] invalidate dropped')
    expect(hits).toHaveLength(1)
    expect(hits[0]![1]).toMatchObject({ sessionId: 's-unknown', customType: 'plan-state' })
  })

  it('bus 未注入 publish 短路落结构化 warn；水位门后有帧落发布观测（域键+触发路径+耗时）', async () => {
    let bus: IMessageBus | null = null
    const { records, client } = makeRecords({ getMessageBus: () => bus })
    const fire = registerSession(records)
    fire('s1')

    // 轮 1：有内容但 bus 未注入 → publish 短路 warn + 零帧观测
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    expect(warnsOf('[session-records] publish skipped: message bus not injected')).toHaveLength(1)

    // 轮 2：bus 注入 + 对账路径 → 补发帧 + 发布观测 info（trigger=reconcile-settled）
    bus = { publish: vi.fn() } as unknown as IMessageBus
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'e1' } })
    records.reconcileRecordEntries('s1')
    await flushMicrotasks()
    const pubEvents = loggerInfo.mock.calls.filter(([m]) => m === '[session-records] record frames published')
    expect(pubEvents).toHaveLength(1)
    const [, meta] = pubEvents[0]!
    expect(meta).toMatchObject({ sessionId: 's1', trigger: 'reconcile-settled' })
    expect(meta!.frames).toContain('session.planState')
    expect(meta!.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('稳态零帧零日志：重复对账 diff 空 → 无发布观测行（S5 无噪声锚）', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    loggerInfo.mockClear()

    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'e1' } })
    records.reconcileRecordEntries('s1')
    await flushMicrotasks()
    const pubEvents = loggerInfo.mock.calls.filter(([m]) => m === '[session-records] record frames published')
    expect(pubEvents).toHaveLength(0)
  })

  it('失效路径发布观测：trigger=invalidate', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()
    const pubEvents = loggerInfo.mock.calls.filter(([m]) => m === '[session-records] record frames published')
    expect(pubEvents).toHaveLength(1)
    expect(pubEvents[0]![1]).toMatchObject({ sessionId: 's1', trigger: 'invalidate' })
  })
})

describe('发布归因 + workflowFolds fold 证据（可观测性 2026-10-02，event-push-channel 重演）', () => {
  // 事故场景重放（workflow 详情空窗）：run journal 先落 run-created，entry 路径送注册条目
  // 后写侧追加 agent-started 并经 marker 通道推送——两路径发布在观测范围上必须可归因、fold
  // 证据可分形。（原「tailer 路径」随 event-tail watch 退役换轨为推送喂入；读活动事实 =
  // routeJournalReport 送达并应用，不再有 tailer 观测行。）
  it('推送路径发布落 trigger=event-projection + fold 证据推进；entry 路径对称', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-observe-'))
    try {
      const sessionDir = join(dir, 'sessions', 'enc-proj')
      // 生产同源目录（session-store-layout-inversion D1）：run journal 冷读目录 =
      // resolvePiWorkflowRunsDir = `<root>/<sid>/workflow/runs/`；旧 fixture 写
      // `sessions/<enc>/workflow-state/`（旧布局形态），与冷读目录对不上 → fold 恒 absent
      const runDir = resolvePiWorkflowRunsDir('s1')
      mkdirSync(runDir, { recursive: true })
      const sessionFile = join(sessionDir, '2026-01-01T00-00-00-000Z_s1.jsonl')
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(sessionFile, '')
      const journal = join(runDir, 'wf-1.record.jsonl')
      writeFileSync(
        journal,
        JSON.stringify({ type: 'run-created', runId: 'wf-1', workflowName: 'f', argsSummary: '', ts: 1000, seq: 1 }) + '\n',
      )

      const meta = { id: 's1', filePath: sessionFile, cwd: '/proj' }
      const { records, publish, client } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => [meta]) } as unknown as ISessionStore,
      })
      const fire = registerSession(records)
      fire('s1')
      client.getEntries.mockResolvedValue({
        data: { entries: [workflowRegisteredEntry('wf-1', journal)], leafId: 'e1' },
      })

      // 轮 1（entry 路径送注册条目；attach 冷读抢跑 fold，asks=0）
      records.invalidateRecordEntries('s1', 'workflow-record')
      await flushDebounce()
      await flushMicrotasks()
      expect(workflowFramesOf(publish)).toHaveLength(1)
      const round1 = framesPublishedEvents()
      expect(round1).toHaveLength(1)
      expect(round1[0]![1]).toMatchObject({
        sessionId: 's1',
        trigger: 'invalidate',
        frames: ['session.workflowUpdate'],
        workflowFolds: { 'wf-1': { fold: 'present', asks: 0 } },
      })

      // 轮 2（journal 追加 agent-started：写侧落盘后经 marker 通道推送 → 派生视图 fold
      // 推进 → 归因发布；event-tail watch 已随 event-push-channel 退役，读活动事实
      // = routeJournalReport 送达并应用，不再有 tailer 观测行）
      const agentStarted: SubagentJournalEvent = {
        type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, ts: 1100, seq: 2,
      }
      appendFileSync(journal, JSON.stringify(agentStarted) + '\n')
      loggerInfo.mockClear()
      const report: SubagentJournalReport = {
        domain: 'run', fileKey: 'wf-1', events: [agentStarted], sessionId: 's1', emittedAt: 1200,
      }
      expect(routeJournalReport('s1', report)).toBe(true)

      // 发布归因行：trigger=event-projection + fold 证据推进 + 无 elapsedMs（推送路径无轮概念）
      const round2 = framesPublishedEvents()
      expect(round2).toHaveLength(1)
      expect(round2[0]![1]).toMatchObject({
        sessionId: 's1',
        trigger: 'event-projection',
        frames: ['session.workflowUpdate'],
        workflowFolds: { 'wf-1': { fold: 'present', asks: 1, lifecycle: 'running', lastSeq: 2 } },
      })
      expect('elapsedMs' in round2[0]![1]).toBe(false)
      expect(workflowFramesOf(publish)).toHaveLength(2) // 两路径各一条 workflowUpdate
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      // 树内 fixture 清理（globalSetup 钉扎的 tmp 数据目录内，fs-guard 白名单）
      rmSync(join(getSessionStoreDir(), 's1'), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('降级派生视图闩死修复（2026-10-02）', () => {
  // 事故形态同源：meta 缺席窗口（pi flush 前）创建的 entry-only 派生视图此前被 ensureProjection
  // 早退永久复用——fold 通道终身死亡。修复后 meta 可得即升级（读写触点驱动，零定时器）。
  it('meta 缺席时降级（agentCalls 空）；meta 可得后 getWorkflows 触发升级——fold 冷读补齐 + event-projection 发布归因', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-upgrade-'))
    try {
      const sessionDir = join(dir, 'sessions', 'enc-cwd')
      // 生产同源目录（同上：`<root>/<sid>/workflow/runs/`，升级腿 attachEventSources 冷读锚点）
      const runDir = resolvePiWorkflowRunsDir('s1')
      mkdirSync(runDir, { recursive: true })
      const sessionFile = join(sessionDir, '2026-01-01T00-00-00-000Z_s1.jsonl')
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(sessionFile, '')
      const journal = join(runDir, 'wf-1.record.jsonl')
      writeFileSync(
        journal,
        [
          JSON.stringify({ type: 'run-created', runId: 'wf-1', workflowName: 'f', argsSummary: '', ts: 1000, seq: 1 }),
          JSON.stringify({ type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, ts: 1100, seq: 2 }),
        ].join('\n') + '\n',
      )

      const meta = { id: 's1', filePath: sessionFile, cwd: '/proj' }
      let metaVisible = false
      const { records, publish, client } = makeRecords({
        sessionStore: { scanSessions: vi.fn(() => (metaVisible ? [meta] : [])) } as unknown as ISessionStore,
      })
      const fire = registerSession(records)
      fire('s1')
      client.getEntries.mockResolvedValue({
        data: { entries: [workflowRegisteredEntry('wf-1', journal)], leafId: 'e1' },
      })

      // 阶段 1：meta 不可得 → 降级派生视图（无 tailer）→ entry 路径仍发布 run 信号（icon 形态），
      // fold 证据 = absent（事故签名：有 icon 无 agent 的构造性成因可观测分形）
      records.invalidateRecordEntries('s1', 'workflow-record')
      await flushDebounce()
      await flushMicrotasks()
      expect(workflowFramesOf(publish)).toHaveLength(1)
      const round1 = framesPublishedEvents()
      expect(round1[0]![1]).toMatchObject({
        sessionId: 's1',
        trigger: 'invalidate',
        workflowFolds: { 'wf-1': { fold: 'absent' } },
      })

      // 阶段 2：meta 可得（pi 已 flush）→ ensureProjection 升级路径 → tailer 冷读 fold
      metaVisible = true
      const upgraded = await records.getWorkflows('s1')
      expect(upgraded.records.find((r) => r.runId === 'wf-1')?.agentCalls).toHaveLength(1)
      // 升级的 rescan 经 fireChange → 发布路径：归因 event-projection（旧代码此处永远静默）
      expect(framesPublishedEvents().some(([, m]) => m.trigger === 'event-projection')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      // 树内 fixture 清理（globalSetup 钉扎的 tmp 数据目录内，fs-guard 白名单）
      rmSync(join(getSessionStoreDir(), 's1'), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
})

describe('subagent-model-detail', () => {
/**
 * subagent / workflow run 详情载荷模型字段侧测试（subagent-model-switch §7.1 入口层，
 * U1 详情载荷透传验收侧）。
 *
 * 覆盖（字段侧单测四项 + 出口接线）：
 * - 覆盖状态（modelOverride）：查询端口在场且有覆盖 → 载荷携带；无覆盖 / 端口缺席 →
 *   不造键；workflow origin 成员跳过 chat 域查询（覆盖作用域归 run 级）；
 * - 最近生效值（recentEffectiveModel）：pi 成员且有 model_change 尾条目 → 携带尾条目
 *   值；无条目 / 文件不存在 → 不造键；非 pi 成员不参与派生、不携带；
 * - 出口接线：getSubagents（读 RPC）与 publishRecordChanges（live 全量帧）两出口都
 *   增强（renderer store 分区整帧替换语义，单出口增强会被另一出口冲掉）；
 * - run 详情侧逐成员携带：projectSubagentModelDetailIntoRuns（run 级覆盖分发全部
 *   agentCall；成员生效值按 (parentRunId, stepIndex) 圈定透传；聚合范围不取单一值）。
 *
 * 测试框架：vitest（从子包目录运行）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/subagent-model-detail.test.ts
 */
// ── fixture ──────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'subagent-model-detail-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** pi session JSONL 行写入口（model_change 条目形态 = pi appendModelChange 落盘形态）。 */
function modelChangeLine(provider: string, modelId: string, timestamp = '2026-10-06T00:00:00Z'): string {
  return JSON.stringify({ type: 'model_change', id: 'mc-1', parentId: null, timestamp, provider, modelId })
}

/** 主 session JSONL 写入（subagent-record 条目族，与 pi appendCustomEntry 落盘形态同构）。 */
function writeMainSession(sessionId: string, entries: Array<Record<string, unknown>>): string {
  const filePath = join(tmpDir, `${sessionId}.jsonl`)
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  return filePath
}

function registeredEntry(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: `${id}-reg`,
    parentId: null,
    timestamp: '2026-08-19T00:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      id,
      agent: 'worker',
      task: 'Do work',
      slug: 'work',
      origin: 'tool',
      rootSessionId: 'main-1',
      depth: 0,
      startedAt: 1000,
      ...extra,
    },
  }
}

function settledEntry(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: `${id}-set`,
    parentId: null,
    timestamp: '2026-08-19T00:00:01Z',
    data: {
      v: 2,
      kind: 'settled',
      id,
      status: 'idle',
      stopReason: 'completed',
      endedAt: 2000,
      turns: 1,
      totalTokens: 10,
      model: 'p/old',
      thinkingLevel: undefined,
      sessionFile: undefined,
      ...extra,
    },
  }
}

/** 最小装置（与 session-records.test.ts 同手法：deps 全 mock + publish spy 收集）。 */
function makeRecords(depsOverrides: Partial<SessionRecordsDeps> = {}) {
  const publish = vi.fn()
  const client = {
    getEntries: vi.fn(async () => ({ data: { entries: [], leafId: null } })),
    prompt: vi.fn(async () => undefined),
  }
  const deps: SessionRecordsDeps = {
    pm: { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager,
    sessionStore: { scanSessions: vi.fn(() => [] as Array<{ id: string; filePath: string }>) } as unknown as ISessionStore,
    hasSession: vi.fn(() => true),
    getMessageBus: () => ({ publish } as unknown as IMessageBus),
    ...depsOverrides,
  }
  const records = new SessionRecords(deps)
  return { records, publish, deps }
}

/** subscribe 后收集注册 handler，返回手动触发器（模拟 lifecycle 同步直发，激活派生缓存）。 */
function registerSession(records: SessionRecords): (sessionId: string) => void {
  const handlers: Array<(sessionId: string) => void> = []
  records.subscribe({ onSessionRegistered: (h) => { handlers.push(h) } })
  return (sessionId: string) => { for (const h of handlers) h(sessionId) }
}

// ── readPiSessionLatestModelChange（派生函数直测）────────────────

describe('readPiSessionLatestModelChange — model_change 尾条目派生', () => {
  it('文件不存在（pi 首次 flush 前延迟写入）→ undefined（按无值处理）', () => {
    expect(readPiSessionLatestModelChange(join(tmpDir, 'missing.jsonl'))).toBeUndefined()
  })

  it('无 model_change 条目（未发生热切）→ undefined', () => {
    const file = join(tmpDir, 'no-change.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', id: 's1', cwd: '/w' }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: [] } }),
      ].join('\n') + '\n',
    )
    expect(readPiSessionLatestModelChange(file)).toBeUndefined()
  })

  it('多条 model_change → 尾条目胜出（最后生效值）', () => {
    const file = join(tmpDir, 'multi.jsonl')
    writeFileSync(
      file,
      [
        modelChangeLine('p-a', 'model-a', '2026-10-06T00:00:01Z'),
        modelChangeLine('p-b', 'model-b', '2026-10-06T00:00:02Z'),
        modelChangeLine('p-c', 'model-c', '2026-10-06T00:00:03Z'),
      ].join('\n') + '\n',
    )
    expect(readPiSessionLatestModelChange(file)).toEqual({ provider: 'p-c', modelId: 'model-c' })
  })

  it('尾部畸形行（半写行 / 非 JSON）跳过不炸，命中更早的合法条目', () => {
    const file = join(tmpDir, 'torn.jsonl')
    writeFileSync(
      file,
      [modelChangeLine('p', 'm'), '{"type":"model_change","provider":"tor'].join('\n') + '\n',
    )
    expect(readPiSessionLatestModelChange(file)).toEqual({ provider: 'p', modelId: 'm' })
  })

  it('字段畸形条目（provider 非串 / 空串）按无效处理', () => {
    const file = join(tmpDir, 'malformed.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'model_change', provider: 42, modelId: 'm' }),
        JSON.stringify({ type: 'model_change', provider: '', modelId: 'm' }),
      ].join('\n') + '\n',
    )
    expect(readPiSessionLatestModelChange(file)).toBeUndefined()
  })
})

// ── getSubagents / live 帧两出口的字段侧 ─────────────────────────

describe('详情载荷字段侧 — getSubagents 出口', () => {
  it('覆盖状态 + 最近生效值在场：载荷携带（chat 域成员）', async () => {
    const subFile = join(tmpDir, 'sub.jsonl')
    writeFileSync(subFile, modelChangeLine('p-new', 'm-new') + '\n')
    writeMainSession('main-1', [
      registeredEntry('sa-1'),
      settledEntry('sa-1', { sessionFile: subFile }),
    ])
    const override: SubagentModelOverrideStatus = { model: 'p-new/m-new', thinkingLevel: 'high' }
    const { records } = makeRecords({
      sessionStore: {
        scanSessions: vi.fn(() => [{ id: 'main-1', filePath: join(tmpDir, 'main-1.jsonl') }]),
      } as unknown as ISessionStore,
      modelOverrideQuery: {
        getRecordOverride: vi.fn((_sessionId: string, recordId: string) => (recordId === 'sa-1' ? override : undefined)),
        getRunOverride: vi.fn(() => undefined),
      },
    })
    const fire = registerSession(records)
    fire('main-1')

    const { records: subagents } = await records.getSubagents('main-1')
    const record = subagents.find((s) => s.subagentId === 'sa-1')
    expect(record).toBeDefined()
    expect(record?.modelOverride).toEqual(override)
    expect(record?.recentEffectiveModel).toEqual({ provider: 'p-new', modelId: 'm-new' })
  })

  it('多 record 命中/未命中混合：逐条输出完整（未命中项不得丢 record，命中项不得丢原字段）', async () => {
    const subFile = join(tmpDir, 'sub-multi.jsonl')
    writeFileSync(subFile, modelChangeLine('p-a', 'm-a') + '\n')
    writeMainSession('main-1', [
      // 索引 0：双命中（覆盖 + pi model_change 派生）
      registeredEntry('sa-a'),
      settledEntry('sa-a', { sessionFile: subFile }),
      // 索引 1：未命中（pi 但无 sessionFile → 不派生；查询无覆盖）
      registeredEntry('sa-b'),
      settledEntry('sa-b'),
      // 索引 2：仅覆盖命中（非 pi 引擎成员）
      registeredEntry('sa-c'),
      settledEntry('sa-c', { engine: 'zcode', engineHandle: { sessionRef: { sessionId: 'z1', dbPath: '/db.sqlite' }, poolKey: 'shared' } }),
      // 索引 3：未命中（同索引 1 形态）
      registeredEntry('sa-d'),
      settledEntry('sa-d'),
    ])
    const overrides: Record<string, SubagentModelOverrideStatus> = {
      'sa-a': { model: 'p-x/m-x', thinkingLevel: 'high' },
      'sa-c': { model: 'p-y/m-y' },
    }
    const { records } = makeRecords({
      sessionStore: {
        scanSessions: vi.fn(() => [{ id: 'main-1', filePath: join(tmpDir, 'main-1.jsonl') }]),
      } as unknown as ISessionStore,
      modelOverrideQuery: {
        getRecordOverride: vi.fn((_sessionId: string, recordId: string) => overrides[recordId]),
        getRunOverride: vi.fn(() => undefined),
      },
    })
    const fire = registerSession(records)
    fire('main-1')

    const { records: subagents } = await records.getSubagents('main-1')
    // 输出完整性：4 条全在、逐条原字段保留（惰性拷贝越界读曾把首个命中项之后的
    // record 写成 undefined / 展开丢光原字段）
    expect(subagents).toHaveLength(4)
    for (const id of ['sa-a', 'sa-b', 'sa-c', 'sa-d']) {
      const record = subagents.find((s) => s.subagentId === id)
      expect(record, `record ${id} missing from payload`).toBeDefined()
      expect(record?.agent).toBe('worker')
      expect(record?.task).toBe('Do work')
      expect(record?.slug).toBe('work')
      expect(record?.model).toBe('p/old')
    }
    // 双命中项：两个增强字段在场
    const withBoth = subagents.find((s) => s.subagentId === 'sa-a')
    expect(withBoth?.modelOverride).toEqual({ model: 'p-x/m-x', thinkingLevel: 'high' })
    expect(withBoth?.recentEffectiveModel).toEqual({ provider: 'p-a', modelId: 'm-a' })
    // 仅覆盖命中项：覆盖在场、非 pi 不派生生效值
    const withOverride = subagents.find((s) => s.subagentId === 'sa-c')
    expect(withOverride?.modelOverride).toEqual({ model: 'p-y/m-y' })
    expect(withOverride?.recentEffectiveModel).toBeUndefined()
    // 未命中项：不造键
    for (const id of ['sa-b', 'sa-d']) {
      const plain = subagents.find((s) => s.subagentId === id)
      expect(plain?.modelOverride).toBeUndefined()
      expect(plain?.recentEffectiveModel).toBeUndefined()
    }
  })

  it('无覆盖 / 无 model_change / 查询端口缺席：字段不造键', async () => {
    writeMainSession('main-1', [registeredEntry('sa-1'), settledEntry('sa-1')])
    const { records } = makeRecords({
      sessionStore: {
        scanSessions: vi.fn(() => [{ id: 'main-1', filePath: join(tmpDir, 'main-1.jsonl') }]),
      } as unknown as ISessionStore,
      // 端口在场但查无覆盖 → 不造键
      modelOverrideQuery: {
        getRecordOverride: vi.fn(() => undefined),
        getRunOverride: vi.fn(() => undefined),
      },
    })
    const fire = registerSession(records)
    fire('main-1')

    const { records: subagents } = await records.getSubagents('main-1')
    const record = subagents.find((s) => s.subagentId === 'sa-1')
    expect(record).toBeDefined()
    expect(record?.modelOverride).toBeUndefined()
    expect(record?.recentEffectiveModel).toBeUndefined()
  })

  it('非 pi 引擎成员：不参与派生、不携带 recentEffectiveModel（model_change 只属 pi session）', async () => {
    writeMainSession('main-1', [
      registeredEntry('sa-z'),
      settledEntry('sa-z', { engine: 'zcode', engineHandle: { sessionRef: { sessionId: 'z1', dbPath: '/db.sqlite' }, poolKey: 'shared' } }),
    ])
    const { records } = makeRecords({
      sessionStore: {
        scanSessions: vi.fn(() => [{ id: 'main-1', filePath: join(tmpDir, 'main-1.jsonl') }]),
      } as unknown as ISessionStore,
      modelOverrideQuery: {
        getRecordOverride: vi.fn(() => ({ model: 'p/m' })),
        getRunOverride: vi.fn(() => undefined),
      },
    })
    const fire = registerSession(records)
    fire('main-1')

    const { records: subagents } = await records.getSubagents('main-1')
    const record = subagents.find((s) => s.subagentId === 'sa-z')
    expect(record).toBeDefined()
    expect(record?.engine).toBe('zcode')
    // 非 pi 成员覆盖状态照常携带（覆盖记账引擎无关），但最近生效值不派生
    expect(record?.modelOverride).toEqual({ model: 'p/m' })
    expect(record?.recentEffectiveModel).toBeUndefined()
  })

  it('workflow origin 成员跳过 chat 域覆盖查询（覆盖作用域归 run 级）', async () => {
    writeMainSession('main-1', [
      registeredEntry('sa-wf', { origin: 'workflow', parentRunId: 'wf-1', stepIndex: 0 }),
      settledEntry('sa-wf'),
    ])
    const getRecordOverride = vi.fn(() => ({ model: 'p/should-not-appear' }))
    const { records } = makeRecords({
      sessionStore: {
        scanSessions: vi.fn(() => [{ id: 'main-1', filePath: join(tmpDir, 'main-1.jsonl') }]),
      } as unknown as ISessionStore,
      modelOverrideQuery: { getRecordOverride, getRunOverride: vi.fn(() => undefined) },
    })
    const fire = registerSession(records)
    fire('main-1')

    const { records: subagents } = await records.getSubagents('main-1')
    const record = subagents.find((s) => s.subagentId === 'sa-wf')
    expect(record?.modelOverride).toBeUndefined()
    expect(getRecordOverride).not.toHaveBeenCalled()
  })
})

describe('详情载荷字段侧 — publishRecordChanges live 帧出口', () => {
  it('live 全量帧同样增强（整帧替换语义下两出口必须一致）', async () => {
    vi.useFakeTimers()
    try {
      const subFile = join(tmpDir, 'sub-live.jsonl')
      writeFileSync(subFile, modelChangeLine('p-live', 'm-live') + '\n')
      const mainEntries = [
        registeredEntry('sa-1'),
        settledEntry('sa-1', { sessionFile: subFile }),
      ]
      writeMainSession('main-1', mainEntries)
      const { records, publish } = makeRecords({
        sessionStore: {
          scanSessions: vi.fn(() => [{ id: 'main-1', filePath: join(tmpDir, 'main-1.jsonl') }]),
        } as unknown as ISessionStore,
        modelOverrideQuery: {
          getRecordOverride: vi.fn(() => ({ model: 'p-live/m-live' })),
          getRunOverride: vi.fn(() => undefined),
        },
      })
      // get_entries 全量返回条目集（pi 内存 entries 与磁盘 JSONL 行同构；全量拉取
      // fullRebuild 先清派生视图再应用——entries 空会清掉冷读产物，故必须喂条目）。
      // makeRecords 的默认 client 被 depsOverrides 前置，这里经 deps.pm 直改不可行，
      // 改为构造后替换：refreshRecordEntries 每次经 pm.getClient 取 client。
      const recordsAny = records as unknown as { deps: SessionRecordsDeps }
      const pmGetClient = recordsAny.deps.pm.getClient as unknown as ReturnType<typeof vi.fn>
      pmGetClient.mockImplementation(() => ({
        getEntries: vi.fn(async () => ({ data: { entries: mainEntries, leafId: null } })),
        prompt: vi.fn(async () => undefined),
      }))
      const fire = registerSession(records)
      fire('main-1') // 激活派生缓存（未注册 session 的失效是 no-op）
      records.invalidateRecordEntries('main-1', 'subagent-record')
      await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)

      const subagentFrames = publish.mock.calls.filter(
        (call) => (call[1] as { type?: string }).type === 'session.subagents',
      )
      expect(subagentFrames.length).toBeGreaterThan(0)
      const payload = (subagentFrames[0]?.[1] as { payload: { subagents: SubagentRecord[] } }).payload
      const record = payload.subagents.find((s) => s.subagentId === 'sa-1')
      expect(record?.modelOverride).toEqual({ model: 'p-live/m-live' })
      expect(record?.recentEffectiveModel).toEqual({ provider: 'p-live', modelId: 'm-live' })
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── run 详情侧逐成员携带（projectSubagentModelDetailIntoRuns 直测）──

describe('projectSubagentModelDetailIntoRuns — run 详情逐成员携带', () => {
  const runBase = {
    runId: 'wf-1',
    scriptName: 'flow',
    status: 'running' as const,
    startedAt: '2026-10-06T00:00:00Z',
    stateFilePath: '',
  }

  const memberA: SubagentRecord = {
    subagentId: 'sa-a',
    sessionFile: null,
    agent: 'worker-a',
    slug: 'a',
    task: 't',
    status: 'running',
    origin: 'workflow',
    parentRunId: 'wf-1',
    stepIndex: 0,
    model: 'p/old',
    engine: DEFAULT_SUBAGENT_ENGINE,
    recentEffectiveModel: { provider: 'p', modelId: 'effective-a' },
  }
  const memberB: SubagentRecord = {
    subagentId: 'sa-b',
    sessionFile: null,
    agent: 'worker-b',
    slug: 'b',
    task: 't',
    status: 'running',
    origin: 'workflow',
    parentRunId: 'wf-1',
    stepIndex: 1,
    model: 'p/old',
    engine: 'zcode',
    // 非 pi 成员：无生效值派生（成员增强产物本就不携带）
  }

  it('run 级覆盖分发全部成员 + 成员生效值逐成员透传（聚合范围不取单一值）', () => {
    const runs = [
      {
        ...runBase,
        agentCalls: [
          { id: 0, agent: 'worker-a', status: 'running' as const, model: 'p/old' },
          { id: 1, agent: 'worker-b', status: 'running' as const, model: 'p/old' },
        ],
      },
    ]
    const query = {
      getRecordOverride: vi.fn(() => undefined),
      getRunOverride: vi.fn(() => ({ model: 'p/new', thinkingLevel: 'high' }) satisfies SubagentModelOverrideStatus),
    }
    const result = projectSubagentModelDetailIntoRuns('main-1', runs, [memberA, memberB], query)

    // resolved additive 可选参：调用方未传 = undefined 透传（缺省自扫语义不变）
    expect(query.getRunOverride).toHaveBeenCalledWith('main-1', 'wf-1', undefined)
    const calls = result[0]?.agentCalls
    expect(calls).toHaveLength(2)
    // run 级覆盖：全成员携带同值（run 作用域意图）
    expect(calls?.[0]?.modelOverride).toEqual({ model: 'p/new', thinkingLevel: 'high' })
    expect(calls?.[1]?.modelOverride).toEqual({ model: 'p/new', thinkingLevel: 'high' })
    // 最近生效值：逐成员独立（同族替换可只发生在部分成员）
    expect(calls?.[0]?.recentEffectiveModel).toEqual({ provider: 'p', modelId: 'effective-a' })
    expect(calls?.[1]?.recentEffectiveModel).toBeUndefined()
  })

  it('无覆盖无成员增强但有权威成员：重建并恒透出 memberRecordId（dmg-r1-2 成员键单源——回执态读取键须在首次切换前就位，零拷贝快路径仅剩成员圈定全 miss 形态）', () => {
    const runs = [{ ...runBase, agentCalls: [{ id: 0, agent: 'w', status: 'running' as const }] }]
    const plainMember: SubagentRecord = { ...memberA, recentEffectiveModel: undefined }
    const result = projectSubagentModelDetailIntoRuns('main-1', runs, [plainMember], undefined)
    // 成员标识透出即发生重建（引用不等）——但模型字段两键不造（无覆盖/无生效值）
    expect(result).not.toBe(runs)
    expect(result[0]?.agentCalls[0]?.memberRecordId).toBe(plainMember.subagentId)
    expect(result[0]?.agentCalls[0]?.modelOverride).toBeUndefined()
    expect(result[0]?.agentCalls[0]?.recentEffectiveModel).toBeUndefined()
  })

  it('成员圈定按 (parentRunId, stepIndex)：其他 run 的成员不串扰', () => {
    const runs = [{ ...runBase, agentCalls: [{ id: 0, agent: 'w', status: 'running' as const }] }]
    const otherRunMember: SubagentRecord = { ...memberA, parentRunId: 'wf-other' }
    const result = projectSubagentModelDetailIntoRuns('main-1', runs, [otherRunMember], undefined)
    expect(result[0]?.agentCalls[0]?.recentEffectiveModel).toBeUndefined()
  })

  // ── 盖章模型透传（call.model 唯一填充点——v2 骨架行无 model 域，五级回退兜底的数据面）──

  it('盖章模型透传：member.model 经注入的显示词汇翻译落 call.model（引擎原生 ref → pi 词汇，engineId 随行透传）', () => {
    const runs = [{ ...runBase, agentCalls: [{ id: 0, agent: 'w', status: 'running' as const }] }]
    const zcodeMember: SubagentRecord = {
      ...memberA,
      model: 'account:bigmodel-individual-coding-plan/GLM-5.3-Flash',
      engine: 'zcode',
      recentEffectiveModel: undefined,
    }
    const translate = vi.fn((_engineId: string, ref: string) => ref.replace('account:bigmodel-individual-coding-plan', 'zai-coding-cn'))
    const result = projectSubagentModelDetailIntoRuns('main-1', runs, [zcodeMember], undefined, undefined, translate)
    expect(translate).toHaveBeenCalledWith('zcode', 'account:bigmodel-individual-coding-plan/GLM-5.3-Flash')
    expect(result[0]?.agentCalls[0]?.model).toBe('zai-coding-cn/GLM-5.3-Flash')
  })

  it('盖章模型透传：未注入翻译按原值透传（pi 成员 ref 本就是 pi 词汇——恒等语义）', () => {
    const runs = [{ ...runBase, agentCalls: [{ id: 0, agent: 'w', status: 'running' as const }] }]
    const piMember: SubagentRecord = { ...memberA, model: 'xiaomi-token-plan-cn/mimo-v2.6-flash', recentEffectiveModel: undefined }
    const result = projectSubagentModelDetailIntoRuns('main-1', runs, [piMember], undefined)
    expect(result[0]?.agentCalls[0]?.model).toBe('xiaomi-token-plan-cn/mimo-v2.6-flash')
  })

  it('盖章模型透传：member.model 缺席（缺省派发存量 record）不造键；成员圈定 miss 的 call 不触碰', () => {
    const runs = [
      { ...runBase, agentCalls: [
        { id: 0, agent: 'w', status: 'running' as const },
        { id: 1, agent: 'w2', status: 'running' as const, model: 'p/kept' },
      ] },
    ]
    const noModelMember: SubagentRecord = { ...memberA, model: undefined, recentEffectiveModel: undefined }
    const result = projectSubagentModelDetailIntoRuns('main-1', runs, [noModelMember], undefined, undefined, () => 'should-not-appear')
    expect(result[0]?.agentCalls[0]?.model).toBeUndefined()
    // id 1 无成员圈定：原值保留（翻译函数不得被无关 call 触发）
    expect(result[0]?.agentCalls[1]?.model).toBe('p/kept')
  })

  it('changed/skip 交错多 run：输出完整不丢 run（dmg-r2-1——惰性 slice + push 追加式曾把首个 changed 之后 skip run 整条丢失）', () => {
    const mkRun = (runId: string) => ({
      ...runBase,
      runId,
      agentCalls: [{ id: 0, agent: 'worker-a', status: 'running' as const, model: 'p/old' }],
    })
    // 索引 1/3 是 changed（有成员携带生效值），0/2/4 是 skip（成员圈定全 miss）——
    // 首个 changed（索引 1）触发惰性 slice 后，其后 skip run 必须原样保留在位。
    const runs = [mkRun('wf-0'), mkRun('wf-1'), mkRun('wf-2'), mkRun('wf-3'), mkRun('wf-4')]
    const memberOf = (runId: string, subagentId: string): SubagentRecord => ({
      ...memberA,
      subagentId,
      parentRunId: runId,
    })
    const result = projectSubagentModelDetailIntoRuns(
      'main-1',
      runs,
      [memberOf('wf-1', 'sa-1'), memberOf('wf-3', 'sa-3')],
      undefined,
    )

    // 输出完整性：5 条全在、顺序保持、逐条对位
    expect(result).toHaveLength(5)
    expect(result.map((r) => r.runId)).toEqual(['wf-0', 'wf-1', 'wf-2', 'wf-3', 'wf-4'])
    // skip run 原样写回（引用相等，不重建不带增强键）——索引 2/4 在首个 changed 之后，曾整条丢失
    expect(result[0]).toBe(runs[0])
    expect(result[2]).toBe(runs[2])
    expect(result[4]).toBe(runs[4])
    expect(result[2]?.agentCalls[0]?.memberRecordId).toBeUndefined()
    expect(result[4]?.agentCalls[0]?.recentEffectiveModel).toBeUndefined()
    // changed run：增强字段在场（成员标识 + 生效值逐成员透传）
    expect(result[1]?.agentCalls[0]?.memberRecordId).toBe('sa-1')
    expect(result[1]?.agentCalls[0]?.recentEffectiveModel).toEqual({ provider: 'p', modelId: 'effective-a' })
    expect(result[3]?.agentCalls[0]?.memberRecordId).toBe('sa-3')
    expect(result[3]?.agentCalls[0]?.recentEffectiveModel).toEqual({ provider: 'p', modelId: 'effective-a' })
  })
})
})

describe('workflow-viz-projection', () => {
/**
 * workflow 可视化 U3 runtime 派生视图测试（workflow-visualization 设计 §3.1-4）：
 *
 * - ① 派生视图消费 fold 新字段透出（workflow-record-projection）：phases 折叠
 *   （last-wins 单行快照，settledBy 不透出）/ created.argsSummary / per-call
 *   attempts / lastRetry / usage 分项 → inputTokens/outputTokens/turns（core
 *   AgentUsage = SDK AgentOutcomeUsage 别名含 turns，有供源故填）。W2 D7 单源红线：
 *   派生视图只读 fold 骨架字段。
 * - ② workflowUpdate 水位 diff 扩两维（session-records 全链）：per-ask attempt
 *   计数（重试边沿发信号——坑③盲区②）+ phases 折叠（纯脚本 phase 转态发信号——
 *   盲区①）；worker-log 不纳入 diff 维度（D4 已接受代价的回归锚）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/workflow-viz-projection.test.ts
 */
// [event-push-channel] journal 推送喂入生产路径路由（SessionRecords 构造期注册 sink）
// [session-store-layout-inversion D2/D3] run journal 生产同源目录 + 树清理
// ── ① 派生视图透出（纯函数直调）────────────────────────────────

const REGISTERED: WorkflowRecordRegisteredEntryData = {
  v: 2,
  kind: 'registered',
  runId: 'run-1',
  workflowName: 'flow',
  scriptName: 'flow',
  slug: 'flow',
  startedAt: 1000,
  recordPath: '/tmp/agent/sessions/x/workflow-state/run-1.record.jsonl',
}

/** 构造 fold 检查点最小形态（派生视图只读 created/asks/phases/state.lifecycle/runSettled）。 */
function makeFold(overrides: Partial<RunEventFoldCheckpoint> = {}): RunEventFoldCheckpoint {
  return {
    state: { lifecycle: 'running' },
    lastSeq: 5,
    created: { runId: 'run-1', workflowName: 'flow', argsSummary: 'task=demo', ts: 1000 },
    asks: new Map(),
    phases: new Map(),
    runSettled: undefined,
    ...overrides,
  }
}

describe('projectV2Workflow：fold 新字段透出（U3 §3.1-4）', () => {
  it('per-call attempts / lastRetry / usage 分项透传（usage → inputTokens/outputTokens/turns，不造嵌套 usage）', () => {
    const fold = makeFold({
      asks: new Map([
        [
          0,
          {
            taskIndex: 0,
            agentName: 'reviewer',
            phase: 'review',
            startedAt: 1100,
            lastProgressAt: 1200,
            attempts: 2,
            lastRetry: { attempt: 1, backoffMs: 500, reason: 'transient boom' },
            // core AgentUsage = SDK AgentOutcomeUsage 别名（含 turns/contextTokens）
            usage: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2, cost: 0.5, contextTokens: 40, turns: 3 },
            settled: { outcome: 'done', durationMs: 150, ts: 1300 },
          },
        ],
      ]),
    })
    const record = projectV2Workflow(REGISTERED, undefined, fold)
    expect(record).not.toBeNull()
    const call = record!.agentCalls[0]!
    expect(call.attempts).toBe(2)
    expect(call.lastRetry).toEqual({ attempt: 1, backoffMs: 500, reason: 'transient boom' })
    expect(call.inputTokens).toBe(10)
    expect(call.outputTokens).toBe(20)
    expect(call.turns).toBe(3)
    // usage 分项数据进协议但只经 inputTokens/outputTokens/turns 三字段——同一信息禁止双轨（u2 冻结裁决）
    expect((call as unknown as Record<string, unknown>)['usage']).toBeUndefined()
  })

  it('无重试记录的 call 不造 attempts/lastRetry 键（缺省语义）', () => {
    const fold = makeFold({
      asks: new Map([
        [0, { taskIndex: 0, agentName: 'dev', startedAt: 1100, lastProgressAt: 1200, settled: { outcome: 'done', ts: 1300 } }],
      ]),
    })
    const call = projectV2Workflow(REGISTERED, undefined, fold)!.agentCalls[0]!
    expect(call).not.toHaveProperty('attempts')
    expect(call).not.toHaveProperty('lastRetry')
    expect(call).not.toHaveProperty('inputTokens')
  })

  it('phases 折叠透出（last-wins 单行快照；settledBy 是 fold 内部标记不透出）', () => {
    const fold = makeFold({
      phases: new Map([
        ['preflight', { phase: 'preflight', startedAt: 1010 }],
        ['review', { phase: 'review', startedAt: 1050, settledAt: 1300, settledBy: 'frame' }],
      ]),
    })
    const record = projectV2Workflow(REGISTERED, undefined, fold)
    expect(record!.phases).toEqual([
      { phase: 'preflight', startedAt: 1010 },
      { phase: 'review', startedAt: 1050, settledAt: 1300 },
    ])
    expect((record!.phases![0] as unknown as Record<string, unknown>)['settledBy']).toBeUndefined()
  })

  it('created.argsSummary 透传；fold 缺席（entry-only 降级）不造 phases/argsSummary 键', () => {
    const withArgs = projectV2Workflow(REGISTERED, undefined, makeFold())
    expect(withArgs!.argsSummary).toBe('task=demo')
    expect(withArgs!.phases).toBeUndefined()

    const bare = makeFold({ created: undefined, phases: new Map(), asks: new Map() })
    const record = projectV2Workflow(REGISTERED, undefined, bare)
    expect(record).not.toBeNull()
    expect(record).not.toHaveProperty('argsSummary')
    expect(record).not.toHaveProperty('phases')
  })
})

// ── ② 水位 diff 扩两维（全链：真实 run journal + journal 推送喂入）──

// [文件级并行防互踩] 分区键不用 's1'：同包 session-records-w0-observe.test.ts 的
// 树内 fixture 同用该 sid，vitest 多文件并行下双方 finally/afterEach 的整树清理会删掉
// 对方正在 append 的 journal（ENOENT 偶发红）——本文件用独立 sid 分区，互不可见。
const SID = 's-viz'
let dir: string
let runJournalPath: string

/** journal 追加一帧（append-only，与引擎写侧同构）+ 推送喂入（写侧落盘提交点推
 *  报告，经 journal-report-router 生产路径路由到本 session 派生视图）。 */
function appendFrame(frame: Record<string, unknown>): void {
  writeFileSync(runJournalPath, `${JSON.stringify(frame)}\n`, { flag: 'a' })
  expect(routeJournalReport(SID, {
    domain: 'run',
    fileKey: 'run-1',
    events: [frame as SubagentJournalEvent],
    sessionId: SID,
    emittedAt: Date.now(),
  })).toBe(true)
}

function makeRecords() {
  const publish = vi.fn()
  const client = {
    getEntries: vi.fn(async () => ({
      data: {
        entries: [
          {
            type: 'custom',
            customType: 'workflow-record',
            id: 'e1',
            parentId: null,
            timestamp: '2026-10-02T00:00:00Z',
            data: {
              v: 2,
              kind: 'registered',
              runId: 'run-1',
              workflowName: 'flow',
              scriptName: 'flow',
              slug: 'flow',
              startedAt: 1000,
              recordPath: runJournalPath,
            },
          },
        ],
        leafId: 'e1',
      },
    })),
    prompt: vi.fn(async () => undefined),
  }
  const deps: SessionRecordsDeps = {
    pm: { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager,
    sessionStore: {
      scanSessions: vi.fn(() => [{ id: SID, filePath: join(dir, 's1.jsonl') }]),
    } as unknown as ISessionStore,
    hasSession: vi.fn(() => true),
    getMessageBus: () => ({ publish } as unknown as IMessageBus),
  }
  const records = new SessionRecords(deps)
  return { records, publish, client }
}

/** 订阅 + 首轮拉取（注册条目经 get_entries 喂派生视图），返回 workflowUpdate 信号读取器。 */
async function setupFirstRound(records: SessionRecords, client: ReturnType<typeof makeRecords>['client']) {
  const handlers: Array<(sessionId: string) => void> = []
  records.subscribe({ onSessionRegistered: (h) => { handlers.push(h) } })
  for (const h of handlers) h(SID)
  records.invalidateRecordEntries(SID, 'workflow-record')
  await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS)
  void client
}

function workflowUpdates(publish: ReturnType<typeof vi.fn>): Array<{ runId: string; status: string; reason?: string }> {
  return publish.mock.calls
    .filter(([, m]) => (m as { type: string }).type === 'session.workflowUpdate')
    .map(([, m]) => (m as { payload: { update: { runId: string; status: string; reason?: string } } }).payload.update)
}

describe('workflowUpdate 水位 diff 扩两维（U3 坑③盲区修复）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'wf-viz-projection-'))
    // [session-store-layout-inversion] 生产同源目录 `<root>/<sid>/workflow/runs/`：
    // 冷读目录（ensureProjection 注入 resolvePiWorkflowRunsDir）必须与 fixture 一致，
    // 否则 fold 无 run-created 前置、推送增量（agent-retrying/phase-*）落空不发信号
    const runJournalDir = resolvePiWorkflowRunsDir(SID)
    mkdirSync(runJournalDir, { recursive: true })
    runJournalPath = join(runJournalDir, 'run-1.record.jsonl')
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    // 树内 fixture 清理（globalSetup 钉扎的 tmp 数据目录内，fs-guard 白名单）
    rmSync(join(getSessionStoreDir(), SID), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('重试边沿发信号：agent-retrying 落盘（status 仍 running）→ 新增一条 workflowUpdate', async () => {
    writeFileSync(
      runJournalPath,
      `${JSON.stringify({ type: 'run-created', runId: 'run-1', workflowName: 'flow', argsSummary: '', ts: 1000 })}\n` +
      `${JSON.stringify({ type: 'agent-started', taskIndex: 0, agentName: 'reviewer', attempt: 1, phase: 'review', ts: 1100 })}\n`,
    )
    const { records, publish, client } = makeRecords()
    await setupFirstRound(records, client)
    expect(workflowUpdates(publish)).toHaveLength(1) // 新 run 首发

    appendFrame({ type: 'agent-retrying', taskIndex: 0, attempt: 1, backoffMs: 500, reason: 'transient', ts: 1200 })
    const updates = workflowUpdates(publish)
    expect(updates).toHaveLength(2) // 重试边沿：attempts 入 stepStatuses 指纹（盲区②修复）
    expect(updates[1]).toEqual({ runId: 'run-1', status: 'running' })
  })

  it('纯脚本 phase 转态发信号：phase-started 落盘（零 agent 事件）→ 新增一条 workflowUpdate', async () => {
    writeFileSync(
      runJournalPath,
      `${JSON.stringify({ type: 'run-created', runId: 'run-1', workflowName: 'flow', argsSummary: '', ts: 1000 })}\n`,
    )
    const { records, publish, client } = makeRecords()
    await setupFirstRound(records, client)
    expect(workflowUpdates(publish)).toHaveLength(1)

    appendFrame({ type: 'phase-started', phase: 'preflight', ts: 1050 })
    const updates = workflowUpdates(publish)
    expect(updates).toHaveLength(2) // phases 折叠入指纹（盲区①修复：纯脚本 phase 无 agent 事件也发信号）
    expect(updates[1]).toEqual({ runId: 'run-1', status: 'running' })

    // phase 收束（phase-settled）同样翻动指纹
    appendFrame({ type: 'phase-settled', phase: 'preflight', ts: 1060 })
    expect(workflowUpdates(publish)).toHaveLength(3)
  })

  it('worker-log 不纳入 diff 维度（D4 已接受代价）：追加日志帧不发新信号', async () => {
    writeFileSync(
      runJournalPath,
      `${JSON.stringify({ type: 'run-created', runId: 'run-1', workflowName: 'flow', argsSummary: '', ts: 1000 })}\n`,
    )
    const { records, publish, client } = makeRecords()
    await setupFirstRound(records, client)
    expect(workflowUpdates(publish)).toHaveLength(1)

    appendFrame({ type: 'worker-log', entry: { level: 'log', message: 'noise' }, ts: 1060 })
    expect(workflowUpdates(publish)).toHaveLength(1) // 滞后到下一转态信号，不放大为拉取频率
  })
})
})

describe('session-records-workflow-signal-gate', () => {
/**
 * workflowUpdate 信号发射前可读性门（待裁决项 5 根治 2026-10-04）单测。
 *
 * 两段：
 * - filterReadableWorkflowSignals 直测（纯函数契约）：不可读 run 被过滤（信号不发）、
 *   可读 run 保留、判定不可得（readableRunIds=null）放行、全不可读 → 空集（水位不推进，
 *   下一轮派生视图变更 / 对账路径重新进入 diff = 推迟到下一轮触发，不给定时器）。
 * - 发射链路构造性锁（端到端）：真实 SessionRecords + fake 依赖，驱动
 *   subscribe → invalidate → 防抖 → get_entries 拉取 → publish，断言 bus 收到
 *   session.workflowUpdate 且 getWorkflows 同刻返回该 run（found=true）——「信号发出时
 *   数据必然可读」由本测试固定；信号源与读源解耦的实现漂移会打红此测试。
 *
 * 背景：renderer 的 500ms running 信号盲等重试已随本项删除（时间平抑类兜底），其正确性
 * 依据 = 本构造性时序；登记见 stores/workflow.ts triggerWorkflowReload 的
 * [时间平抑红线登记] 与 session-records.ts filterReadableWorkflowSignals JSDoc。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-records-workflow-signal-gate.test.ts
 */
// ── filterReadableWorkflowSignals 直测（发射前可读性门的纯函数契约）──

describe('filterReadableWorkflowSignals — 发射前可读性门（待裁决项 5）', () => {
  const signals = [
    { runId: 'wf-readable', status: 'running' },
    { runId: 'wf-unreadable', status: 'running' },
  ]

  /** 可读 run id 集（Map 键域形态 = 发布点实参 projection.workflows 的同构）。 */
  function readable(ids: string[]): ReadonlyMap<string, unknown> {
    return new Map(ids.map((id) => [id, true]))
  }

  it('不可读 run 被过滤（信号不发），可读 run 保留', () => {
    const filtered = filterReadableWorkflowSignals(signals, readable(['wf-readable']))
    expect(filtered).toEqual([{ runId: 'wf-readable', status: 'running' }])
  })

  it('全部不可读 → 空集（本轮不发；水位不推进 → 下一轮派生视图变更 / 对账路径重试 = 推迟语义）', () => {
    expect(filterReadableWorkflowSignals(signals, readable([]))).toEqual([])
  })

  it('全部可读 → 原样通过', () => {
    const all = filterReadableWorkflowSignals(signals, readable(['wf-readable', 'wf-unreadable']))
    expect(all).toEqual(signals)
  })

  it('readableRunIds=null（派生视图不可得，防御读法）→ 放行（判据缺失不拦截信号）', () => {
    expect(filterReadableWorkflowSignals(signals, null)).toEqual(signals)
  })

  it('空候选信号 → 空集（无可发布内容）', () => {
    expect(filterReadableWorkflowSignals([], readable(['wf-readable']))).toEqual([])
  })
})

// ── 发射链路构造性锁（端到端）：信号发出时 getWorkflows 同刻可读 ──

describe('SessionRecords workflowUpdate 发射链路 — 信号发出时数据必然可读（构造性时序锁）', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wf-signal-gate-'))
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** v2 workflow 注册条目（events-projection scanWorkflowV2Entry 的键检查最小子集 + 常用字段）。 */
  function workflowRegisteredEntry(runId: string): Record<string, unknown> {
    return {
      type: 'custom',
      customType: WORKFLOW_RECORD_CUSTOM_TYPE,
      id: `e-${runId}`,
      parentId: null,
      timestamp: '2026-10-04T10:00:00Z',
      data: {
        v: 2,
        kind: 'registered',
        runId,
        workflowName: 'gate-flow',
        scriptName: 'gate-flow',
        slug: 'gate-flow',
        startedAt: 1756000000000,
        recordPath: join(tempDir, 'workflow-state', `${runId}.record.jsonl`),
      },
    }
  }

  function makeHarness(entries: unknown[]): {
    records: SessionRecords
    published: ServerMessage[]
    register: () => void
  } {
    const published: ServerMessage[] = []
    const bus = {
      publish: vi.fn((_sessionId: string, message: ServerMessage) => {
        published.push(message)
      }),
    } as unknown as IMessageBus
    const sessionFilePath = join(tempDir, 'main.jsonl') // 冷扫描按缺文件空条目处理（pi 延迟写入窗口同形态）
    // mtime 是文件属性：文件未写入时跨扫描稳定（真实 scanSessions = fstat）。每次调用
    // 现取 Date.now() 会模拟出「每次 stat mtime 都变」的不可能形态，触发查询通道 mtime
    // 对账（session-records rebuildProjectionIfSourceChanged）每查必重建投影——测试域
    // 内会话文件从未变化，必须返回同一 mtime。
    const scanTarget = { id: 'sid-gate', filePath: sessionFilePath, cwd: tempDir, timestamp: new Date().toISOString(), name: null, lastModified: Date.now(), size: 0, outcome: null }
    const sessionStore = {
      scanSessions: () => [scanTarget],
      invalidateScanCache: () => {},
      refreshAll: () => {},
    } as unknown as ISessionStore
    const pm = {
      getClient: () => ({
        getEntries: vi.fn(async () => ({ data: { entries, leafId: 'e-wf-gate-1' } })),
      }),
    } as unknown as IProcessManager
    let onRegistered: ((sessionId: string) => void) | undefined
    const source = {
      onSessionRegistered: (cb: (sessionId: string) => void) => {
        onRegistered = cb
      },
    } as unknown as SessionRegisteredSource
    const records = new SessionRecords({
      pm,
      sessionStore,
      hasSession: () => true,
      getMessageBus: () => bus,
    })
    records.subscribe(source)
    return { records, published, register: () => onRegistered?.('sid-gate') }
  }

  it('invalidate → 防抖拉取 → bus 收到 workflowUpdate，且同刻 getWorkflows 返回该 run（found=true）', async () => {
    const harness = makeHarness([workflowRegisteredEntry('wf-gate-1')])
    harness.register()

    // entry_appended 失效信号（防抖 SCALAR_STATE_DEBOUNCE_MS=300 后拉取）
    harness.records.invalidateRecordEntries('sid-gate', WORKFLOW_RECORD_CUSTOM_TYPE)
    await vi.advanceTimersByTimeAsync(300)
    await vi.waitFor(() => {
      expect(harness.published.some((m) => m.type === 'session.workflowUpdate')).toBe(true)
    })

    // 信号载荷 = 派生视图内可读 run；同刻读路径立即返回同一 run（构造性：信号源 = 读源派生视图）
    const updateFrame = harness.published.find((m) => m.type === 'session.workflowUpdate')
    const update = (updateFrame!.payload as { update: { runId: string; status: string } }).update
    expect(update.runId).toBe('wf-gate-1')

    const workflows = await harness.records.getWorkflows('sid-gate')
    expect(workflows.found).toBe(true)
    expect(workflows.records.map((r) => r.runId)).toContain('wf-gate-1')
  })
})
})
