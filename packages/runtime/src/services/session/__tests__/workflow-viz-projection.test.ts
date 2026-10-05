/**
 * workflow 可视化 U3 runtime 投影测试（workflow-visualization 设计 §3.1-4）：
 *
 * - ① 投影消费 fold 新字段透出（workflow-record-projection）：phases 折叠
 *   （last-wins 单行快照，settledBy 不透出）/ created.argsSummary / per-call
 *   attempts / lastRetry / usage 分项 → inputTokens/outputTokens/turns（core
 *   AgentUsage = SDK AgentOutcomeUsage 别名含 turns，有供源故填）。W2 D7 单源红线：
 *   投影只读 fold 骨架字段。
 * - ② workflowUpdate 水位 diff 扩两维（session-records 全链）：per-ask attempt
 *   计数（重试边沿发信号——坑③盲区②）+ phases 折叠（纯脚本 phase 转态发信号——
 *   盲区①）；worker-log 不纳入 diff 维度（D4 已接受代价的回归锚）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/workflow-viz-projection.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import type { SessionRecordsDeps } from '../session-records.js'
import { SessionRecords } from '../session-records.js'
// [event-push-channel] journal 推送喂入生产路径路由（SessionRecords 构造期注册 sink）
import { routeJournalReport } from '../journal-report-router.js'
import type { SubagentJournalEvent } from '@zhushanwen/extension-protocol'
import { SCALAR_STATE_DEBOUNCE_MS } from '../replicated-states.config.js'
import { projectV2Workflow } from '../workflow-record-projection.js'
import type { RunEventFoldCheckpoint } from '@zhushanwen/subagent-core'
import type { WorkflowRecordRegisteredEntryData } from '@zhushanwen/subagent-core'

// ── ① 投影透出（纯函数直调）────────────────────────────────

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

/** 构造 fold 检查点最小形态（投影只读 created/asks/phases/state.lifecycle/runSettled）。 */
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

const SID = 's1'
let dir: string
let runJournalPath: string

const piAgentDirRef = vi.hoisted(() => ({ dir: '' }))

vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => piAgentDirRef.dir }
})

/** journal 追加一帧（append-only，与引擎写侧同构）+ 推送喂入（写侧落盘提交点推
 *  报告，经 journal-report-router 生产路径路由到本 session 投影）。 */
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

/** 订阅 + 首轮拉取（注册条目经 get_entries 喂投影），返回 workflowUpdate 信号读取器。 */
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
    const runJournalDir = join(dir, 'workflow-state')
    mkdirSync(runJournalDir, { recursive: true })
    runJournalPath = join(runJournalDir, 'run-1.record.jsonl')
    piAgentDirRef.dir = dir
  })

  afterEach(() => {
    piAgentDirRef.dir = ''
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
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
