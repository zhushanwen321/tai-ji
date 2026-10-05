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
 *     → refreshRecordEntries（getEntries 全量，cursor=null 首拉）
 *     → applyRecordEntries → mergePlanState → publishRecordChanges
 *     → MessageBus.publish（state 类 typeKey='plan'：stateSnapshot 覆盖 + 定向推送订阅 ws）
 *
 * 真机证据锚点（排障会话已核实，此处以测试固化语义防回归）：
 * - pi stdout tee：/plan command handler 的 appendEntry 同步 _emit entry_appended
 *   （agent-session.js bindCore appendEntry：appendCustomEntry 后立即广播，无 turn 边界延迟）；
 * - W18 防抖 300ms 后的 getEntries 首拉返回全量 entries 含 plan-state（cursor 随 leafId 推进，
 *   后续 15s 对账 sweep 全走增量——tee rpc_14→rpc_17 链）。
 *
 * 两个用例分别锁定「实时腿」（订阅在发布前建立，帧经 broadcastText 直达）与
 * 「恢复腿」（发布早于订阅，帧经 subscribe 应答 stateSnapshot 回放——切走再切回/
 * 断连重连的恢复语义）。
 *
 * 第四用例锁定「空投黑洞机制」（2026-09-24 真机会话 01a0d509 形态 B 判定固化）：
 * publish 时无订阅者 → 水位照样推进（u0 校准：publish 调用完成即推进）→ 15s 定时腿与
 * agent_settled 腿 diff 恒空不补发 → 帧仅经 subscribe stateSnapshot 恢复。该形态下
 * 黑洞持续 = 设计内（对账腿只覆盖「merge 已对、publish 跳丢」，空投靠快照兜底），
 * 恢复触发点全在消费侧（重连/切回的重订阅）——本用例把这一判定钉死，防止后续把
 * 水位语义改掉时无测试显形。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/plan-state-first-entry-frame.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServerMessage } from '@taiji/shared'
import { EventAdapter } from '../../../infra/pi/event-adapter.js'
import { EventInterpreter } from '../event-interpreter.js'
import { SessionRecords } from '../session-records.js'
import type { SessionRecordsDeps } from '../session-records.js'
import { MessageBus } from '../../message-bus/message-bus.js'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../replicated-states.config.js'

/** pi entry_appended 事件载荷形态（agent-session bindCore appendEntry 的 _emit 原文）。 */
function piEntryAppendedEvent(customType: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'entry_appended',
    entry: { type: 'custom', customType, data, id: 'e-plan-1', parentId: null, timestamp: '2026-09-24T18:13:41.942Z' },
  }
}

/** 首 plan-state entry 的 data（真机 fixture 投影：/plan 进入 planning 态）。 */
const PLAN_ENTRY_DATA: Record<string, unknown> = {
  isActive: true,
  planFilePath: '/tmp/taiji-plan/theme/plan.md',
  requirement: '给设置页加主题切换',
  templateName: '',
  skills: ['tech-design'],
  docs: [],
  state: 'planning',
}

/** get_entries 全量响应（cursor=null 首拉形态：entries + leafId）。 */
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
    // 返回空批——对账腿的稳态形态（真机 15s sweep 空增量 rpc 同形）。
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

  it('实时腿：订阅先建立，entry_appended → 防抖 → 全量拉取 → 帧经 ws 直达（isActive:true 首帧）', async () => {
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
    // 拉取走全量（cursor=null 首拉，无 since 参数）
    expect(p.client.getEntries).toHaveBeenCalledWith()
  })

  it('恢复腿：帧发布早于订阅，subscribe 应答 stateSnapshot 含 plan 帧（切走再切回恢复语义）', async () => {
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

  it('空投黑洞机制（真机 01a0d509 形态 B）：无订阅者 publish 后水位推进 → 定时/settled 两腿不补发，帧仅经 subscribe 快照恢复', async () => {
    const entries = [{ type: 'custom', customType: 'plan-state', data: PLAN_ENTRY_DATA, id: 'e-plan-1' }]
    const p = makePipeline(entries)
    p.fireRegistered('s1')
    p.makeAdapter('s1').attach(p.client)

    // renderer 订阅窗口（真机 20:09:35.89-20:18:24 订阅未建立）：publish 照常发生但空投
    p.emitPiEvent(piEntryAppendedEvent('plan-state', PLAN_ENTRY_DATA))
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS)
    expect(planStateFrames(p.received)).toHaveLength(0) // 无订阅者：无直推（真机 20:09:36.204）

    // agent_settled 腿同样不补（publish 调用已完成，水位已推进——对账腿只覆盖 publish 跳丢形态）
    p.records.reconcileRecordEntries('s1')
    await vi.advanceTimersByTimeAsync(0)
    expect(planStateFrames(p.received)).toHaveLength(0)

    // 恢复腿（真机 20:18:25.082 重连重订阅）：帧仅经 subscribe 应答 stateSnapshot 回放
    const sub = p.bus.subscribe('s1', p.ws)
    const snapshotFrames = planStateFrames(sub.stateSnapshot)
    expect(snapshotFrames).toHaveLength(1)
    expect((snapshotFrames[0].payload as { planState: { isActive: boolean } }).planState.isActive).toBe(true)
  })
})
