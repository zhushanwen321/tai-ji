/**
 * SessionRecords 送达水位对账直测（reload-closeout D2+D6，u1）。
 *
 * 覆盖（A3 全部沉淀单测 + A5 反向 + 定时腿/实施期门③/profiling 门①）：
 * - 发布门换基线：发布判定 = 当前派生快照 vs 已发布快照（水位），补发帧构造来源 =
 *   水位 diff 差异集（非 merge 变化信号）；稳态快照==水位零帧。
 * - A3a/A3b 守卫/发布门跳自愈：hasSession 瞬态 false / bus 未注入窗口 → publish 未发生
 *   → 水位滞留 → 对账触发补发（fetch 空增量下仍补发——merge 信号基线对事故主形态失明的
 *   反证）；补发后快照==水位==权威。
 * - A3c 断连空投行为锁定：publish 完成（零订阅者不可观测于 runtime 侧）→ 水位推进 →
 *   重连后 diff 空（该形态由 stateSnapshot 回放覆盖，水位结构性不触发）。
 * - 定时腿（15s 服务级单例 timer）：内容落缓存自启、cursor=null 跳过（门③）、扫描域
 *   清零随 onSessionDisposed 停、与在途拉取经 inflight 合并。
 * - A5 反向：无 reload 演进序列帧只在真实变化时发（帧序列为改动前子集），消费端最终
 *   视图等价；fullRebuild 内容不变零帧（cursor 自愈全量重拉旧形态发冗余帧——已知差异）。
 * - profiling 门①：单轮对账耗时 ≤100ms/session/轮（real timers，faux 规模）。
 *
 * 分层：mock 层 = deps 5 方法（与 session-records.test.ts 同形态）；extractor 生产代码
 * 真实执行；fake timers（项目规范）。fixture 复制自 session-records.test.ts（测试文件
 * 间不互相 import）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import type { SessionRecordsDeps } from '../session-records.js'
import {
  SessionRecords,
  RECORD_RECONCILE_INTERVAL_MS,
  RECORD_RECONCILE_ROUND_BUDGET_MS,
} from '../session-records.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../replicated-states.config.js'

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
function workflowRecordEntry(
  runId: string,
  status: 'running' | 'done',
  entryId: string,
  reason?: string,
  trace: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
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
        state: { status, reason, budget: { usedTokens: 1, usedCost: 0 }, calls: [], trace },
        meta: { startedAt: '2026-08-19T00:00:00Z' },
      },
    },
  }
}

/** plan-state entry fixture（data 平铺四必填 + 三 optional）。 */
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
    skills: ['tech-design', 'dev-flow'],
    docs: [{ fileName: 'design.md', absPath: '/tmp/taiji-plan/auth/design.md', sourceSkill: 'tech-design', version: 1 }],
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

/** 推进一个定时对账间隔（含微任务冲刷，拉取落定）。 */
async function advanceReconcileInterval(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await vi.advanceTimersByTimeAsync(RECORD_RECONCILE_INTERVAL_MS)
    await Promise.resolve()
    await Promise.resolve()
  }
}

/** 按帧类型过滤 publish 调用（消息形状由调用处断言收窄，与 session-records.test.ts 同宽松度）。 */
function framesOf(publish: ReturnType<typeof vi.fn>, type: string): Array<[string, unknown]> {
  return publish.mock.calls.filter(([, m]) => (m as { type: string }).type === type) as Array<[string, unknown]>
}

/** 走一轮「失效 → 防抖 → 全量拉取」把派生缓存落上内容（发布与否随守卫/bus 状态）。 */
async function seedRound(
  records: SessionRecords,
  fire: (sid: string) => void,
  client: { getEntries: ReturnType<typeof vi.fn> },
  entries: unknown[],
  leafId: string,
  sid = 's1',
): Promise<void> {
  fire(sid)
  client.getEntries.mockResolvedValue({ data: { entries, leafId } })
  records.invalidateRecordEntries(sid, 'subagent-record')
  await flushDebounce()
}

// ── 发布门换基线（D2：发布判定 = 派生快照 vs 已发布快照）────────────────────

describe('送达水位发布门', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('正常路径首发：三家族帧发布且内容等价（帧形态与水位门前逐一等价）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    await seedRound(records, fire, client, [
      subagentRecordEntry('sa-1', 'running', 'e1'),
      workflowRecordEntry('run-1', 'running', 'e2'),
      planStateEntry(fullPlanData('awaiting'), 'e3'),
    ], 'e3')

    expect(framesOf(publish, 'session.subagents')).toHaveLength(1)
    expect((framesOf(publish, 'session.subagents')[0][1] as { payload: { subagents: Array<{ subagentId: string }> } }).payload.subagents)
      .toEqual([expect.objectContaining({ subagentId: 'sa-1', status: 'running' })])
    expect(framesOf(publish, 'session.workflowUpdate')).toHaveLength(1)
    expect((framesOf(publish, 'session.workflowUpdate')[0][1] as { payload: { update: { runId: string; status: string } } }).payload.update)
      .toEqual({ runId: 'run-1', status: 'running', reason: undefined })
    expect(framesOf(publish, 'session.planState')).toHaveLength(1)
  })

  it('稳态零帧：快照==水位 → 重复对账（agent_settled 腿 + 定时腿）零帧', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    await seedRound(records, fire, client, [subagentRecordEntry('sa-1', 'running', 'e1')], 'e1')
    expect(publish).toHaveBeenCalledTimes(1)

    // 空增量：派生不变、水位已推进 → agent_settled 腿零帧
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'e1' } })
    records.reconcileRecordEntries('s1')
    await Promise.resolve()
    await Promise.resolve()
    expect(publish).toHaveBeenCalledTimes(1)

    // 定时腿两轮同样零帧
    await advanceReconcileInterval(2)
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('同值增量（新 entryId 同内容）不发布（水位 diff 恒空）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    await seedRound(records, fire, client, [subagentRecordEntry('sa-1', 'running', 'e1')], 'e1')
    expect(publish).toHaveBeenCalledTimes(1)

    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e9')], leafId: 'e9' } })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('workflowUpdate 按差异 run 构造：多 run 仅差异 run 出信号；步骤数变化也出信号', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    await seedRound(records, fire, client, [
      workflowRecordEntry('run-1', 'running', 'e1'),
      workflowRecordEntry('run-2', 'running', 'e2'),
    ], 'e2')
    expect(framesOf(publish, 'session.workflowUpdate')).toHaveLength(2) // 两个新 run 各一条

    // delta：仅 run-2 翻终态 → 只出 run-2 的信号（run-1 无差异不出）
    client.getEntries.mockResolvedValue({
      data: { entries: [workflowRecordEntry('run-2', 'done', 'e3', 'completed')], leafId: 'e3' },
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    const signals = framesOf(publish, 'session.workflowUpdate').map(([, m]) => (m as { payload: { update: { runId: string; status: string; reason?: string } } }).payload.update)
    expect(signals).toHaveLength(3)
    expect(signals[2]).toEqual({ runId: 'run-2', status: 'done', reason: 'completed' })

    // running 中仅步骤数变化（trace +1）也出信号（GUI 步骤实时可见维度保留）
    client.getEntries.mockResolvedValue({
      data: { entries: [workflowRecordEntry('run-1', 'running', 'e4', undefined, [
        { stepIndex: 1, agent: 'reviewer', task: 't', model: 'default', status: 'running', phase: 'R1', startedAt: '2026-08-19T00:00:02Z' },
      ])], leafId: 'e4' },
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    const after = framesOf(publish, 'session.workflowUpdate').map(([, m]) => (m as { payload: { update: { runId: string } } }).payload.update)
    expect(after).toHaveLength(4)
    expect(after[3]!.runId).toBe('run-1')
  })

  it('fullRebuild 内容不变零帧（cursor 自愈全量重拉旧形态发冗余帧——A5 已知差异锁定）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    await seedRound(records, fire, client, [subagentRecordEntry('sa-1', 'running', 'e1')], 'e1')
    expect(publish).toHaveBeenCalledTimes(1)

    // 游标失效自愈：丢 cursor → 全量重建，全集内容不变 → 水位存续 diff 空 → 零新帧
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since !== undefined) throw new Error('Entry not found: e1')
      return { data: { entries: [subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } } as GetEntriesResult
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledWith() // 全量重建确已发生
    expect(publish).toHaveBeenCalledTimes(1) // 但零冗余帧
  })
})

// ── A3：守卫/发布门跳静默丢自愈（注入单测）──────────────────────────────────

describe('A3 守卫/发布门跳自愈（注入单测）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('A3a hasSession 瞬态 false：publish 未发生 → 水位滞留 → 对账触发补发（fetch 空增量）', async () => {
    let alive = false // 瞬态 false：session 未销毁（如 bus 重建窗口），守卫拦发布
    const { records, publish, client } = makeRecords({ hasSession: vi.fn(() => alive) })
    const fire = registerSession(records)
    await seedRound(records, fire, client, [subagentRecordEntry('sa-1', 'running', 'e1')], 'e1')
    // merge 已完成（cache 有 record）但 publish 未发生 → 水位滞留
    expect(publish).not.toHaveBeenCalled()

    // 守卫恢复 + pi 侧无新增（fetch 空增量）——merge 信号基线下无帧可发，水位门必须补发
    alive = true
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'e1' } })
    records.reconcileRecordEntries('s1')
    await Promise.resolve()
    await Promise.resolve()
    expect(client.getEntries).toHaveBeenCalledWith('e1') // 增量拉取（空 delta）
    const subFrames = framesOf(publish, 'session.subagents')
    expect(subFrames).toHaveLength(1)
    expect((subFrames[0][1] as { payload: { subagents: Array<{ subagentId: string; status: string }> } }).payload.subagents)
      .toEqual([expect.objectContaining({ subagentId: 'sa-1', status: 'running' })])

    // 补发后快照==水位==权威：重复对账零帧
    records.reconcileRecordEntries('s1')
    await Promise.resolve()
    await Promise.resolve()
    expect(framesOf(publish, 'session.subagents')).toHaveLength(1)
  })

  it('A3b bus 未注入窗口：publish 短路（水位滞留）→ bus 注入后对账补发', async () => {
    let bus: IMessageBus | null = null
    const { records, publish, client } = makeRecords({ getMessageBus: () => bus })
    const fire = registerSession(records)
    await seedRound(records, fire, client, [subagentRecordEntry('sa-1', 'running', 'e1')], 'e1')
    expect(publish).not.toHaveBeenCalled() // getMessageBus() 短路：无帧、水位未推进

    bus = { publish } as unknown as IMessageBus
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'e1' } })
    records.reconcileRecordEntries('s1')
    await Promise.resolve()
    await Promise.resolve()
    expect(framesOf(publish, 'session.subagents')).toHaveLength(1)
  })

  it('A3c 断连空投行为锁定：publish 完成（零订阅者形态）→ 水位推进 → 重连后 diff 空', async () => {
    // runtime 侧不可观测订阅者——fake bus 的 publish 恒完成 = 断连空投形态的可达注入。
    // 行为锁定：publish 完成即推进（回放覆盖该形态，水位结构性不触发补发）
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    await seedRound(records, fire, client, [subagentRecordEntry('sa-1', 'running', 'e1')], 'e1')
    expect(publish).toHaveBeenCalledTimes(1)

    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'e1' } })
    await advanceReconcileInterval(2) // 重连后两轮对账
    records.reconcileRecordEntries('s1')
    await Promise.resolve()
    await Promise.resolve()
    expect(publish).toHaveBeenCalledTimes(1) // diff 恒空：零补发帧
  })
})

// ── agent_settled 腿（reconcileRecordEntries 入口）──────────────────────────

describe('agent_settled 腿（reconcileRecordEntries）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('扫描域门：纯聊天 session（缓存为空、从未派生 record）对账 no-op', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1') // 注册即缓存就位，但从未有 record → 域外
    records.reconcileRecordEntries('s1')
    await Promise.resolve()
    await Promise.resolve()
    expect(client.getEntries).not.toHaveBeenCalled()
  })

  it('未注册 session 对账 no-op', () => {
    const { records, client } = makeRecords()
    records.reconcileRecordEntries('s-unknown')
    expect(client.getEntries).not.toHaveBeenCalled()
  })

  it('与在途防抖拉取经 inflight 合并（对账撞在途不重复 RPC）', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    await seedRound(records, fire, client, [subagentRecordEntry('sa-1', 'running', 'e1')], 'e1')

    let release!: (v: GetEntriesResult) => void
    client.getEntries.mockImplementation(async () => new Promise<GetEntriesResult>((resolve) => { release = resolve }))
    records.reconcileRecordEntries('s1') // 腿 A：拉取挂起（inflight 已设）
    await Promise.resolve()
    await advanceReconcileInterval(1) // 腿 B：定时器撞在途 → 复用 inflight
    release({ data: { entries: [], leafId: 'e1' } })
    await Promise.resolve()
    await Promise.resolve()
    expect(client.getEntries).toHaveBeenCalledTimes(2) // seedRound 1 次 + 对账 1 次（无第三次）
  })
})

// ── 定时腿（15s 服务级单例 timer）───────────────────────────────────────────

describe('定时腿（15s 服务级单例 timer）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('内容落缓存后 timer 自启：advance 15s → 域内 session 增量对账', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    await seedRound(records, fire, client, [subagentRecordEntry('sa-1', 'running', 'e1')], 'e1')

    client.getEntries.mockClear()
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'e1' } })
    await advanceReconcileInterval(1)
    expect(client.getEntries).toHaveBeenCalledWith('e1') // 增量拉取发生
  })

  it('cursor=null 本轮跳过（门③：全量重建 RPC 无 oversize 保护，等 agent_settled 腿）', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    // leafId 缺省 → 拉取成功但 cursor 保持 null（域内 + cursor 空的可达形态）
    await seedRound(records, fire, client, [subagentRecordEntry('sa-1', 'running', 'e1')], undefined as unknown as string)

    client.getEntries.mockClear()
    await advanceReconcileInterval(3)
    expect(client.getEntries).not.toHaveBeenCalled() // 定时腿跳过

    // agent_settled 腿不受门③限制（正常全量路径）
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    records.reconcileRecordEntries('s1')
    await Promise.resolve()
    await Promise.resolve()
    expect(client.getEntries).toHaveBeenCalledWith()
  })

  it('onSessionDisposed 扫描域清零 → timer 停（advance 45s 零拉取）', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    await seedRound(records, fire, client, [subagentRecordEntry('sa-1', 'running', 'e1')], 'e1')

    client.getEntries.mockClear()
    records.onSessionDisposed('s1')
    await advanceReconcileInterval(3)
    expect(client.getEntries).not.toHaveBeenCalled()
  })

  it('多 session：销毁其一，域内另一 session 仍被定时扫', async () => {
    // per-session client 预创建（getClient 每 refresh 都被调，spy 不能惰性新建——
    // 首拉发生在 flushDebounce 内，惰性创建时 mockResolvedValue 尚未挂上会拉到空）
    const mkClient = () => ({
      getEntries: vi.fn(async (_since?: string) => ({ data: { entries: [], leafId: null } }) as GetEntriesResult),
    })
    const clients = new Map<string, ReturnType<typeof mkClient>>([
      ['s1', mkClient()],
      ['s2', mkClient()],
    ])
    const { records } = makeRecords({
      pm: { getClient: vi.fn((sid: string) => clients.get(sid) as unknown as IPiEngine) } as unknown as IProcessManager,
    })
    const fire = registerSession(records)
    for (const sid of ['s1', 's2']) {
      clients.get(sid)!.getEntries.mockResolvedValue({
        data: { entries: [subagentRecordEntry(`sa-${sid}`, 'running', `e-${sid}`)], leafId: `e-${sid}` },
      })
      fire(sid)
      records.invalidateRecordEntries(sid, 'subagent-record')
      await flushDebounce()
    }

    for (const c of clients.values()) c.getEntries.mockClear()
    records.onSessionDisposed('s1')
    await advanceReconcileInterval(1)
    expect(clients.get('s1')!.getEntries).not.toHaveBeenCalled()
    expect(clients.get('s2')!.getEntries).toHaveBeenCalledWith('e-s2')
  })
})

// ── 重注册空水位（D3 ②：重注册即重建 + 空水位首发布）───────────────────────

describe('重注册空水位', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('销毁后重注册：新缓存空水位 → 首拉 diff 全量非空 → 全量首发布', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    await seedRound(records, fire, client, [subagentRecordEntry('sa-1', 'running', 'e1')], 'e1')
    expect(framesOf(publish, 'session.subagents')).toHaveLength(1)

    // 销毁（水位随 cache 同批清理）→ 重注册 → 首失效全量重拉（cursor=null）
    records.onSessionDisposed('s1')
    await seedRound(records, fire, client, [subagentRecordEntry('sa-1', 'running', 'e1')], 'e1')
    const subFrames = framesOf(publish, 'session.subagents')
    expect(subFrames).toHaveLength(2) // 空水位 vs 快照 diff 全量非空 → 重新发布
    expect(client.getEntries).toHaveBeenCalledWith() // 全量路径
  })
})

// ── A5 反向：无 reload 回归面（消费端最终视图等价 + 帧序列为改动前子集）──────

describe('A5 反向：无 reload 演进序列', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('帧只在真实内容变化时发；最终帧 == 派生终态（消费端视图等价）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)

    // 轮 1：subagent + workflow 起跑
    await seedRound(records, fire, client, [
      subagentRecordEntry('sa-1', 'running', 'e1'),
      workflowRecordEntry('run-1', 'running', 'e2'),
    ], 'e2')
    expect(publish).toHaveBeenCalledTimes(2) // subagents 全量帧 + workflow 新 run 信号

    // 轮 2（增量）：subagent 轮终（result 写入）+ run 终态 + plan 进入
    client.getEntries.mockResolvedValue({
      data: { entries: [
        subagentRecordEntry('sa-1', 'idle', 'e3', { result: 'round output' }),
        workflowRecordEntry('run-1', 'done', 'e4', 'completed'),
        planStateEntry(fullPlanData('awaiting'), 'e5'),
      ], leafId: 'e5' },
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(5) // +subagents +workflowUpdate +planState 各一

    // 轮 3（增量）：同值重复 entry（新 entryId 同内容）→ 零帧（帧序列为改动前子集：无内容变化必无帧）
    client.getEntries.mockResolvedValue({
      data: { entries: [
        subagentRecordEntry('sa-1', 'idle', 'e6', { result: 'round output' }),
        workflowRecordEntry('run-1', 'done', 'e7', 'completed'),
        planStateEntry(fullPlanData('awaiting'), 'e8'),
      ], leafId: 'e8' },
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(5)

    // 消费端最终视图等价：各家族最后帧 == 派生终态
    const lastSubagents = (framesOf(publish, 'session.subagents').at(-1)![1] as { payload: { subagents: Array<{ subagentId: string; status: string; result?: string }> } }).payload.subagents
    expect(lastSubagents).toEqual([expect.objectContaining({ subagentId: 'sa-1', status: 'idle', result: 'round output' })])
    const lastWf = (framesOf(publish, 'session.workflowUpdate').at(-1)![1] as { payload: { update: { runId: string; status: string; reason?: string } } }).payload.update
    expect(lastWf).toEqual({ runId: 'run-1', status: 'done', reason: 'completed' })
    const lastPlan = (framesOf(publish, 'session.planState').at(-1)![1] as { payload: { planState: { reviewState: string } } }).payload.planState
    expect(lastPlan.reviewState).toBe('awaiting')
  })
})

// ── profiling 门①（real timers：单轮对账耗时红绿线）────────────────────────

describe('profiling 门①：单轮对账耗时（real timers）', () => {
  let recordsUnderTest: SessionRecords | null = null

  afterEach(() => {
    // 清理：dispose 域内 session 停掉（unref 的）定时对账 timer
    recordsUnderTest?.onSessionDisposed('s1')
    recordsUnderTest = null
  })

  it('稳态单轮对账 ≤100ms/session/轮（faux 规模：50 subagent×2KB + 20 workflow + plan 全量比对）', async () => {
    const bigTask = 'x'.repeat(2048)
    const subEntries = Array.from({ length: 50 }, (_, i) => subagentRecordEntry(`sa-${i}`, 'idle', `e-sub-${i}`, { task: bigTask, result: bigTask }))
    const wfEntries = Array.from({ length: 20 }, (_, i) => workflowRecordEntry(`run-${i}`, 'done', `e-wf-${i}`, 'completed'))
    const entries = [...subEntries, ...wfEntries, planStateEntry(fullPlanData('awaiting'), 'e-plan')]

    const { records, publish, client } = makeRecords()
    recordsUnderTest = records
    const fire = registerSession(records)

    // 轮 1：全量拉取 + 首发布（建立水位）
    client.getEntries.mockResolvedValue({ data: { entries, leafId: 'e-plan' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await new Promise<void>((resolve) => { setTimeout(resolve, SCALAR_STATE_DEBOUNCE_MS + 50) })
    expect(publish).toHaveBeenCalled()

    // 轮 2（对账）：增量批返回全部同值 entry（新 entryId 同内容）——merge 全量 + 水位全量
    // 比对 + 零帧输出 = 单轮对账最重形态（稳态 diff 路径全走、无 publish 兜底）
    const sameValueDelta = entries.map((e) => ({ ...(e as Record<string, unknown>), id: `${(e as { id: string }).id}-r2` }))
    client.getEntries.mockResolvedValue({ data: { entries: sameValueDelta, leafId: 'e-plan-r2' } })
    const framesBefore = publish.mock.calls.length
    const t0 = performance.now()
    records.reconcileRecordEntries('s1')
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    const elapsedMs = performance.now() - t0

    expect(client.getEntries).toHaveBeenCalledWith('e-plan') // 增量路径确认
    expect(publish.mock.calls.length).toBe(framesBefore) // 全量比对后 diff 空（零帧）
    expect(elapsedMs).toBeLessThan(RECORD_RECONCILE_ROUND_BUDGET_MS)
  })
})
