/**
 * SessionRecords W0 观测面 + R11/6c3 根修回归（pull-push-architecture W0 / D7）。
 *
 * 覆盖：
 * - 6c3 根修回归：纯 plan session 首拉失败（pi client 不可得 / RPC 错误）后，修复前
 *   planState 恒 null 不在对账域、agent_settled 腿永久跳过 → 「全程零发布」持续态；
 *   修复后 awaitingFirstPull 纳入对账域，对账腿持续重试直至首轮拉取成功并补发 planState。
 * - 首拉未决解除语义：成功一轮（含空增量轮）清 awaitingFirstPull——纯聊天 session
 *   （缓存全空）回归既有域外语义（reconcile.test.ts 扫描域门用例的对偶面）。
 * - P-1 探针（cursor 管线与 WS 推送独立腿）：真实 MessageBus 无订阅者空投形态 / bus
 *   未注入形态下，cursor 照常推进（后续失效走增量 RPC）、派生缓存照常正确——推送腿
 *   完全缺席不伤缓存腿（pull-push §2 前提 P-1 的行为证据，W1 缓存优先的前置确认）。
 * - 断点显形 warn：失效无缓存（未注册/已销毁）、pi client 不可得、bus 未注入三处此前
 *   静默断点（R11「发布/订阅侧零日志」的排障盲点）落结构化 warn。
 * - 发布观测：水位门后有帧落 info（域键 frames + 触发腿 trigger + 耗时 elapsedMs）；
 *   稳态零帧零日志（S5「无噪声」锚）。
 *
 * 分层：mock 层 = deps（与 session-records.test.ts 同形态）+ vi.mock logger；fixture
 * 复制自 session-records-reconcile.test.ts（测试文件间不互相 import）。fake timers。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import { MessageBus } from '../../message-bus/message-bus.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import type { SessionRecordsDeps } from '../session-records.js'
import { SessionRecords } from '../session-records.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../replicated-states.config.js'

vi.mock('../../../infra/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const loggerInfo = vi.mocked((await import('../../../infra/logger.js')).logger.info)
const loggerWarn = vi.mocked((await import('../../../infra/logger.js')).logger.warn)

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

/** 冲刷微任务（对账腿的 fire-and-forget 拉取落定）。 */
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

function runJournalAppliedEvents(): Array<[string, Record<string, unknown>]> {
  return loggerInfo.mock.calls.filter(
    ([m]) => m === '[events-projection] run journal events applied',
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

describe('R11/6c3 根修：首拉未决纳入对账域（awaitingFirstPull）', () => {
  it('首拉失败（pi client 不可得）→ 对账腿重试 → planState 补发（根修回归主锚）', async () => {
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

    // pi 就绪，无任何新失效信号——agent_settled 对账腿触发（修复前：域外 no-op）
    piUp = true
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    records.reconcileRecordEntries('s1')
    await flushMicrotasks()

    expect(client.getEntries).toHaveBeenCalledWith() // 全量首拉发生
    expect(planFramesOf(publish)).toHaveLength(1) // planState 补发（零发布持续态被打破）
    // 首拉成功后 awaitingFirstPull 清除：planState 已派生非 null → session 回归内容域
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

  it('首拉失败（RPC 错误）→ 对账腿重试 → planState 补发', async () => {
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

    // 未决已清 + 缓存全空 → 对账域外：定时腿 sweep 亦不触发 RPC
    client.getEntries.mockClear()
    records.reconcileRecordEntries('s1')
    await flushMicrotasks()
    expect(client.getEntries).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(16_000)
    expect(client.getEntries).not.toHaveBeenCalled()
  })
})

describe('P-1 探针：cursor 管线与 WS 推送独立腿（pull-push §2 前提 P-1）', () => {
  it('空投形态（真实 MessageBus 无订阅者）：推送腿缺席，cursor 照常推进、派生照常发生', async () => {
    const realBus = new MessageBus() // 无订阅者：publish 即空投（6c3 类形态）
    const { records, client } = makeRecords({ getMessageBus: () => realBus })
    const fire = registerSession(records)
    fire('s1')

    // 轮 1：全量首拉（空投发生——不抛错、不阻断）
    client.getEntries.mockResolvedValue({
      data: { entries: [planStateEntry(fullPlanData('awaiting'), 'e1')], leafId: 'e1' },
    })
    records.invalidateRecordEntries('s1', 'plan-state')
    await flushDebounce()

    // 轮 2：cursor 已推进 → 失效走增量 RPC（since='e1'）——缓存腿健康的行为证据
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

  it('bus 未注入形态：cursor 管线照常推进（推送腿完全缺失不伤缓存腿）', async () => {
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

describe('断点显形 warn + 发布观测（W0 观测面）', () => {
  it('失效无缓存（未注册 session）落结构化 warn（此前静默 no-op 零日志）', () => {
    const { records } = makeRecords()
    records.invalidateRecordEntries('s-unknown', 'plan-state')
    const hits = warnsOf('[session-records] invalidate dropped')
    expect(hits).toHaveLength(1)
    expect(hits[0]![1]).toMatchObject({ sessionId: 's-unknown', customType: 'plan-state' })
  })

  it('bus 未注入 publish 短路落结构化 warn；水位门后有帧落发布观测（域键+触发腿+耗时）', async () => {
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

    // 轮 2：bus 注入 + 对账腿 → 补发帧 + 发布观测 info（trigger=reconcile-settled）
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

  it('失效腿发布观测：trigger=invalidate', async () => {
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

describe('发布归因 + workflowFolds fold 证据（可观测性 2026-10-02）', () => {
  // 事故场景重放（workflow 详情空窗）：run journal 先落 run-created，entry 腿送注册条目
  // 后 tailer 再读到 agent-started——两腿发布在观测面上必须可归因、fold 证据可分形。
  it('tailer 腿发布落 trigger=event-projection + fold 证据推进；读活动落 events-projection 观测行；entry 腿对称', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-observe-'))
    try {
      const sessionDir = join(dir, 'sessions', 'enc-proj')
      const runDir = join(sessionDir, 'workflow-state')
      mkdirSync(runDir, { recursive: true })
      const sessionFile = join(sessionDir, '2026-01-01T00-00-00-000Z_s1.jsonl')
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

      // 轮 1（entry 腿送注册条目；attach 冷读抢跑 fold，asks=0）
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

      // 轮 2（journal 追加 agent-started → tailer recheck 拾取 → fold 推进 → 归因发布）
      appendFileSync(
        journal,
        JSON.stringify({ type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, ts: 1100, seq: 2 }) + '\n',
      )
      loggerInfo.mockClear()
      await vi.advanceTimersByTimeAsync(120)

      // 读活动观测行（events-projection 域）：tail 读到了什么，一步可见
      const applied = runJournalAppliedEvents()
      expect(applied).toHaveLength(1)
      expect(applied[0]![1]).toMatchObject({ runId: 'wf-1', events: 1, lastSeq: 2, lifecycle: 'running', asks: 1 })

      // 发布归因行：trigger=event-projection + fold 证据推进 + 无 elapsedMs（tailer 无轮概念）
      const round2 = framesPublishedEvents()
      expect(round2).toHaveLength(1)
      expect(round2[0]![1]).toMatchObject({
        sessionId: 's1',
        trigger: 'event-projection',
        frames: ['session.workflowUpdate'],
        workflowFolds: { 'wf-1': { fold: 'present', asks: 1, lifecycle: 'running', lastSeq: 2 } },
      })
      expect('elapsedMs' in round2[0]![1]).toBe(false)
      expect(workflowFramesOf(publish)).toHaveLength(2) // 两腿各一条 workflowUpdate
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('降级投影闩死修复（2026-10-02）', () => {
  // 事故形态同源：meta 缺席窗口（pi flush 前）创建的 entry-only 投影此前被 ensureProjection
  // 早退永久复用——fold 通道终身死亡。修复后 meta 可得即升级（读写触点驱动，零定时器）。
  it('meta 缺席时降级（agentCalls 空）；meta 可得后 getWorkflows 触发升级——fold 冷读补齐 + event-projection 发布归因', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-upgrade-'))
    try {
      const sessionDir = join(dir, 'sessions', 'enc-cwd')
      const runDir = join(sessionDir, 'workflow-state')
      mkdirSync(runDir, { recursive: true })
      const sessionFile = join(sessionDir, '2026-01-01T00-00-00-000Z_s1.jsonl')
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

      // 阶段 1：meta 不可得 → 降级投影（无 tailer）→ entry 腿仍发布 run 信号（icon 形态），
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

      // 阶段 2：meta 可得（pi 已 flush）→ ensureProjection 升级腿 → tailer 冷读 fold
      metaVisible = true
      const upgraded = await records.getWorkflows('s1')
      expect(upgraded.records.find((r) => r.runId === 'wf-1')?.agentCalls).toHaveLength(1)
      // 升级的 rescan 经 fireChange → 发布腿：归因 event-projection（旧代码此处永远静默）
      expect(framesPublishedEvents().some(([, m]) => m.trigger === 'event-projection')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
