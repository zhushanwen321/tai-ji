/* eslint-disable no-magic-numbers -- mock fixture 数据（workflow/subagent 记录、事件流行、预置 DAG）的字面量数值属领域数据，非逻辑魔数（data.ts 同款先例） */
/**
 * Workflow/subagent mock fixture —— E2E 验证任务列表渲染（composer 任务托盘面板 /
 * drawer workflow tab）+ 跟随 session 切换 + workflow-viz overlay 边界态演员。
 *
 * 从 mock/index.ts 拆出（文件行数超 500 限制）。
 * [HISTORICAL] 2026-09-16 侧栏 Flows/Agents tab 退役后，列表渲染断言面迁至任务托盘
 * （workflow 详情视图 2 = drawer WorkflowTab）。
 *
 * [D8] workflow-overlay-refine §3.3 演员清单（SSOT = .tmp/dev-flow/ui-redesign-combined.runlog/
 * u-wf-mock.md 冻结清单）：既有 done（wf-mock-001）之外 10 个演员定义 = 6 类边界态
 * （running / pending / failed / retrying / interrupted / stopped-time-limited）+
 * parse_failed 降级回执 + 空节点 DAG + 2 形态（单 phase 7+ agent / calls-DAG 错位）。
 * interrupted 与 stopped-time-limited 共用事件基座（sharedStopBase），仅终局行不同。
 * runId 命名 wf-mock-<语义>（u-wf-e2e 按冻结清单 runId 写断言）；sessionId 沿用
 * sess-agent-mock-N 递增；各演员独立日期锚（2026-07-11 起 1h 步进）互不干扰；
 * argsSummary 恒 JSON 串形态（实锤：引擎写侧 summarizeRunArgs = JSON.stringify(args)，
 * terminal-actions.ts——任何 --k=v 拆分前提已被证伪）。
 *
 * 通道契约（D8 定稿②③）：getWorkflowRunEvents / getWorkflowDag 按 runId 查本文件
 * 预置表返回——DAG 一律**预置成品**（fixtureDagByRun 成功臂 / fixtureDagErrors 错误臂），
 * mock 内不跑 DAG 解析器（解析器属产品路径，mock 复刻它是第二套解析实现）。
 * 预置 DAG 的 id/字段形态与解析器产物同构（节点 agent-L<行>-N<seq 全局递增> /
 * 边 edge-<i> / matchPattern ^字面$ 或 ^字面.*$，workflow-dag-parser.ts）。
 */
import type { SubagentRecord, WorkflowDag, WorkflowDagErrorCode, WorkflowDagNode, WorkflowRunEventEntry, WorkflowRunRecord } from '@taiji/shared'

/** Mock workflow fixture（11 条：wf-mock-001 既有 done + D8 十演员，全量入 's3' 托盘列表） */
export const fixtureWorkflows: WorkflowRunRecord[] = [
  {
    runId: 'wf-mock-001',
    scriptName: 'deploy-flow',
    slug: 'deploy',
    status: 'done',
    reason: 'completed',
    startedAt: '2026-07-10T10:00:00Z',
    completedAt: '2026-07-10T10:30:00Z',
    usedTokens: 50000,
    totalCallCount: 2,
    agentCalls: [
      { id: 0, agent: 'dev-W1', status: 'done', phase: 'Dev', sessionId: 'sess-agent-mock-1' },
      { id: 1, agent: 'review-W1', status: 'done', phase: 'Review', sessionId: 'sess-agent-mock-2' },
    ],
    stateFilePath: '/data/wf-mock-001.jsonl',
  },
  {
    // [D8] 边界态 running：agent-started 无对应 settled 行（进行中的单 call run）
    runId: 'wf-mock-running',
    scriptName: 'feature-impl',
    slug: 'running',
    status: 'running',
    startedAt: '2026-07-11T09:00:00Z',
    usedTokens: 12000,
    totalCallCount: 1,
    agentCalls: [
      { id: 0, agent: 'impl-W1', status: 'running', phase: 'Impl', sessionId: 'sess-agent-mock-3', startedAt: '2026-07-11T09:00:02Z' },
    ],
    stateFilePath: '/data/wf-mock-running.jsonl',
  },
  {
    // [D8] 边界态 pending：run-created 后无 agent 行（DAG 节点全部未挂接 → pending）
    runId: 'wf-mock-pending',
    scriptName: 'dual-review',
    slug: 'pending',
    status: 'running',
    startedAt: '2026-07-11T10:00:00Z',
    agentCalls: [],
    stateFilePath: '/data/wf-mock-pending.jsonl',
  },
  {
    // [D8] 边界态 failed：settled 带 error（V6 errorCode 截断断言的载体——run 级码取
    // engine_${string} 词表形态的足额长串，驱动 200px 截断 + title 原样）
    runId: 'wf-mock-failed',
    scriptName: 'ship-flow',
    slug: 'failed',
    status: 'done',
    reason: 'failed',
    outcome: 'failed',
    errorCode: 'engine_call_failed_schema_validation_unexpected_field_config_at_step_shipper_W1_attempt_1',
    startedAt: '2026-07-11T11:00:00Z',
    completedAt: '2026-07-11T11:00:50Z',
    usedTokens: 8000,
    totalCallCount: 1,
    agentCalls: [
      {
        id: 0, agent: 'shipper-W1', status: 'failed', phase: 'Ship', sessionId: 'sess-agent-mock-4',
        startedAt: '2026-07-11T11:00:02Z', completedAt: '2026-07-11T11:00:45Z', durationMs: 43000,
        error: 'schema_deterministic: 输出缺少必填字段 result',
      },
    ],
    stateFilePath: '/data/wf-mock-failed.jsonl',
  },
  {
    // [D8] 边界态 retrying：agent-retrying 行 + attempts ≥1（重试派生态载体）
    runId: 'wf-mock-retrying',
    scriptName: 'heal-flow',
    slug: 'retrying',
    status: 'running',
    startedAt: '2026-07-11T12:00:00Z',
    usedTokens: 6000,
    totalCallCount: 1,
    agentCalls: [
      {
        id: 0, agent: 'healer-W1', status: 'running', phase: 'Heal', sessionId: 'sess-agent-mock-5',
        startedAt: '2026-07-11T12:00:02Z',
        attempts: 1,
        lastRetry: { attempt: 1, backoffMs: 4000, reason: 'schema_deterministic: 输出缺少必填字段 result' },
      },
    ],
    stateFilePath: '/data/wf-mock-retrying.jsonl',
  },
  {
    // [D8] 边界态 interrupted（基座 A 变体 1）：run-interrupted 行、其后无 resume（neutral 停止档）
    runId: 'wf-mock-interrupted',
    scriptName: 'migrate-flow',
    slug: 'interrupted',
    status: 'interrupted',
    startedAt: '2026-07-11T13:00:00Z',
    usedTokens: 4000,
    totalCallCount: 1,
    agentCalls: [
      { id: 0, agent: 'migrator-W1', status: 'running', phase: 'Migrate', sessionId: 'sess-agent-mock-6', startedAt: '2026-07-11T13:00:02Z' },
    ],
    stateFilePath: '/data/wf-mock-interrupted.jsonl',
  },
  {
    // [D8] 边界态 stopped-time-limited（基座 A 变体 2）：run-settled outcome=time_limited
    // 且存在在途 call（走查 E-4：stopTone failed 档的数据载体）
    runId: 'wf-mock-stopped-time-limited',
    scriptName: 'migrate-flow',
    slug: 'time-limited',
    status: 'done',
    reason: 'time_limited',
    outcome: 'time_limited',
    startedAt: '2026-07-11T14:00:00Z',
    completedAt: '2026-07-11T14:00:40Z',
    usedTokens: 4000,
    totalCallCount: 1,
    agentCalls: [
      // 在途 call 无 settled 行——run 终局后投影保持 running（stopped-time-limited 语义）
      { id: 0, agent: 'migrator-W1', status: 'running', phase: 'Migrate', sessionId: 'sess-agent-mock-7', startedAt: '2026-07-11T14:00:02Z' },
    ],
    stateFilePath: '/data/wf-mock-stopped-time-limited.jsonl',
  },
  {
    // [D8] parse_failed 降级回执演员：run 本身正常（事件流成功回执），仅 DAG 通道
    // 返回预置 parse_failed 错误臂——V5① / OV4 降级断言（原因码透出 + 重试钮）唯一数据源
    runId: 'wf-mock-parse-failed',
    scriptName: 'broken-flow',
    slug: 'parse-failed',
    status: 'done',
    reason: 'completed',
    startedAt: '2026-07-11T15:00:00Z',
    completedAt: '2026-07-11T15:00:35Z',
    usedTokens: 9000,
    totalCallCount: 1,
    agentCalls: [
      { id: 0, agent: 'worker-W1', status: 'done', phase: 'Do', sessionId: 'sess-agent-mock-8', startedAt: '2026-07-11T15:00:02Z', completedAt: '2026-07-11T15:00:32Z', durationMs: 30000 },
    ],
    stateFilePath: '/data/wf-mock-parse-failed.jsonl',
  },
  {
    // [D8] 空节点 DAG 演员：纯门禁脚本零 agent 调用点——E3 空 DAG 占位（居中摘要）载体
    runId: 'wf-mock-empty-dag',
    scriptName: 'gate-flow',
    slug: 'empty-dag',
    status: 'done',
    reason: 'completed',
    startedAt: '2026-07-11T16:00:00Z',
    completedAt: '2026-07-11T16:00:05Z',
    usedTokens: 0,
    totalCallCount: 0,
    agentCalls: [],
    stateFilePath: '/data/wf-mock-empty-dag.jsonl',
  },
  {
    // [D8] 形态演员「单 phase 7+ agent」：W-2 纵向边界载体（单 phase 容量 6，7+ 需 pan）
    runId: 'wf-mock-wide-phase',
    scriptName: 'batch-flow',
    slug: 'wide-phase',
    status: 'running',
    startedAt: '2026-07-11T17:00:00Z',
    usedTokens: 60000,
    totalCallCount: 7,
    agentCalls: [
      { id: 0, agent: 'builder-W1', status: 'done', phase: 'Build', sessionId: 'sess-agent-mock-9', startedAt: '2026-07-11T17:00:02Z', completedAt: '2026-07-11T17:01:02Z', durationMs: 60000 },
      { id: 1, agent: 'builder-W2', status: 'done', phase: 'Build', sessionId: 'sess-agent-mock-10', startedAt: '2026-07-11T17:00:03Z', completedAt: '2026-07-11T17:01:03Z', durationMs: 60000 },
      { id: 2, agent: 'builder-W3', status: 'done', phase: 'Build', sessionId: 'sess-agent-mock-11', startedAt: '2026-07-11T17:00:04Z', completedAt: '2026-07-11T17:01:04Z', durationMs: 60000 },
      { id: 3, agent: 'builder-W4', status: 'done', phase: 'Build', sessionId: 'sess-agent-mock-12', startedAt: '2026-07-11T17:00:05Z', completedAt: '2026-07-11T17:01:05Z', durationMs: 60000 },
      { id: 4, agent: 'builder-W5', status: 'running', phase: 'Build', sessionId: 'sess-agent-mock-13', startedAt: '2026-07-11T17:00:06Z' },
      { id: 5, agent: 'builder-W6', status: 'running', phase: 'Build', sessionId: 'sess-agent-mock-14', startedAt: '2026-07-11T17:00:07Z' },
      { id: 6, agent: 'builder-W7', status: 'running', phase: 'Build', sessionId: 'sess-agent-mock-15', startedAt: '2026-07-11T17:00:08Z' },
    ],
    stateFilePath: '/data/wf-mock-wide-phase.jsonl',
  },
  {
    // [D8] 形态演员「calls 与 DAG 节点错位」：UC-12 未匹配实例构造载体——call 的 phase
    // （Review）与 agentName（mystery-agent-N）对 DAG 节点（Audit / ^reviewer-.*$）双错开，
    // 5 实例必入未匹配分组（V5③ 分组挂上区底部且超高滚动）
    runId: 'wf-mock-mismatched-calls',
    scriptName: 'audit-flow',
    slug: 'mismatched',
    status: 'done',
    reason: 'completed',
    startedAt: '2026-07-11T18:00:00Z',
    completedAt: '2026-07-11T18:01:30Z',
    usedTokens: 45000,
    totalCallCount: 5,
    agentCalls: [
      { id: 0, agent: 'mystery-agent-1', status: 'done', phase: 'Review', sessionId: 'sess-agent-mock-16', startedAt: '2026-07-11T18:00:02Z', completedAt: '2026-07-11T18:00:50Z', durationMs: 48000 },
      { id: 1, agent: 'mystery-agent-2', status: 'done', phase: 'Review', sessionId: 'sess-agent-mock-17', startedAt: '2026-07-11T18:00:03Z', completedAt: '2026-07-11T18:00:55Z', durationMs: 52000 },
      { id: 2, agent: 'mystery-agent-3', status: 'done', phase: 'Review', sessionId: 'sess-agent-mock-18', startedAt: '2026-07-11T18:00:04Z', completedAt: '2026-07-11T18:01:00Z', durationMs: 56000 },
      { id: 3, agent: 'mystery-agent-4', status: 'done', phase: 'Review', sessionId: 'sess-agent-mock-19', startedAt: '2026-07-11T18:00:05Z', completedAt: '2026-07-11T18:01:10Z', durationMs: 65000 },
      { id: 4, agent: 'mystery-agent-5', status: 'done', phase: 'Review', sessionId: 'sess-agent-mock-20', startedAt: '2026-07-11T18:00:06Z', completedAt: '2026-07-11T18:01:20Z', durationMs: 74000 },
    ],
    stateFilePath: '/data/wf-mock-mismatched-calls.jsonl',
  },
]

/** Mock subagent fixture（E2E 验证托盘 subagent 面板渲染）[U6] legacy done 收窄出类型，用归一后两态词 */
export const fixtureSubagents: SubagentRecord[] = [
  {
    subagentId: 'sub-mock-001',
    sessionFile: null,
    agent: 'reviewer',
    slug: 'review-task',
    task: 'Review the code changes',
    status: 'idle',
    stopReason: 'completed',
    turns: 3,
    totalTokens: 5000,
    elapsedSeconds: 12,
  },
]

// ── 事件流 fixture（getWorkflowRunEvents 按 runId 查表）────────────────────────
// wf-mock-001 时间锚对账（[HISTORICAL] 原单 run 形态）：T0 = startedAt、T_END =
// completedAt（10:00 → 10:30），帧序与 agentCalls 逐 call 对得上。D8 起扩为
// fixtureRunEventsByRun（runId → 行集），十演员各有最小事件行集。

/** 事件行 timestamp 便捷锚（epoch ms，ISO 直读保持与 record 字段同源换算）。 */
const at = (iso: string): number => Date.parse(iso)

/** 相对偏移便捷（秒；行内 ts = 基准 + offset 秒 × 1000，避免散落四则运算）。 */
const plus = (base: number, seconds: number): number => base + seconds * 1000

/** wf-mock-001 事件行集（10 行骨架帧，无大字段截断——截断展示面由组件测试覆盖）。 */
const wfMock001Events: WorkflowRunEventEntry[] = [
  { type: 'run-created', ts: at('2026-07-10T10:00:00Z'), seq: 1, runId: 'wf-mock-001', workflowName: 'deploy-flow', argsSummary: '{"task":"demo"}' },
  { type: 'phase-started', ts: plus(at('2026-07-10T10:00:00Z'), 1), seq: 2, phase: 'Dev' },
  { type: 'agent-started', ts: plus(at('2026-07-10T10:00:00Z'), 2), seq: 3, taskIndex: 0, agentName: 'dev-W1', attempt: 1, phase: 'Dev' },
  { type: 'agent-settled', ts: plus(at('2026-07-10T10:00:00Z'), 62), seq: 4, taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 60_000 },
  { type: 'phase-settled', ts: plus(at('2026-07-10T10:00:00Z'), 63), seq: 5, phase: 'Dev' },
  { type: 'phase-started', ts: plus(at('2026-07-10T10:00:00Z'), 64), seq: 6, phase: 'Review' },
  { type: 'agent-started', ts: plus(at('2026-07-10T10:00:00Z'), 65), seq: 7, taskIndex: 1, agentName: 'review-W1', attempt: 1, phase: 'Review' },
  { type: 'agent-settled', ts: plus(at('2026-07-10T10:00:00Z'), 965), seq: 8, taskIndex: 1, attempt: 1, outcome: 'done', durationMs: 900_000 },
  { type: 'phase-settled', ts: plus(at('2026-07-10T10:00:00Z'), 966), seq: 9, phase: 'Review' },
  { type: 'run-settled', ts: at('2026-07-10T10:30:00Z'), seq: 10, outcome: 'done', artifactsDir: '/data/artifacts/wf-mock-001' },
]

/** wf-mock-running 事件行集（agent-started 无对应 settled——进行中）。 */
const wfRunningEvents: WorkflowRunEventEntry[] = [
  { type: 'run-created', ts: at('2026-07-11T09:00:00Z'), seq: 1, runId: 'wf-mock-running', workflowName: 'feature-impl', argsSummary: '{"task":"implement login form"}' },
  { type: 'phase-started', ts: plus(at('2026-07-11T09:00:00Z'), 1), seq: 2, phase: 'Impl' },
  { type: 'agent-started', ts: plus(at('2026-07-11T09:00:00Z'), 2), seq: 3, taskIndex: 0, agentName: 'impl-W1', attempt: 1, phase: 'Impl' },
]

/** wf-mock-pending 事件行集（run-created 后无 agent 行）。 */
const wfPendingEvents: WorkflowRunEventEntry[] = [
  { type: 'run-created', ts: at('2026-07-11T10:00:00Z'), seq: 1, runId: 'wf-mock-pending', workflowName: 'dual-review', argsSummary: '{"scope":"ui-polish"}' },
]

/** wf-mock-failed 事件行集（call settled 带 error → run settled failed 带长 errorCode）。 */
const wfFailedEvents: WorkflowRunEventEntry[] = [
  { type: 'run-created', ts: at('2026-07-11T11:00:00Z'), seq: 1, runId: 'wf-mock-failed', workflowName: 'ship-flow', argsSummary: '{"env":"staging"}' },
  { type: 'phase-started', ts: plus(at('2026-07-11T11:00:00Z'), 1), seq: 2, phase: 'Ship' },
  { type: 'agent-started', ts: plus(at('2026-07-11T11:00:00Z'), 2), seq: 3, taskIndex: 0, agentName: 'shipper-W1', attempt: 1, phase: 'Ship' },
  { type: 'agent-settled', ts: plus(at('2026-07-11T11:00:00Z'), 45), seq: 4, taskIndex: 0, attempt: 1, outcome: 'failed', errorCode: 'schema_deterministic', durationMs: 43_000, stderrTeePath: '/data/tee/wf-mock-failed-call-0.log' },
  { type: 'run-settled', ts: plus(at('2026-07-11T11:00:00Z'), 50), seq: 5, outcome: 'failed', errorCode: 'engine_call_failed_schema_validation_unexpected_field_config_at_step_shipper_W1_attempt_1', reason: 'agent shipper-W1 failed (schema_deterministic)', artifactsDir: '/data/artifacts/wf-mock-failed' },
]

/** wf-mock-retrying 事件行集（agent-retrying 行 + attempts ≥1——退避中未终局）。 */
const wfRetryingEvents: WorkflowRunEventEntry[] = [
  { type: 'run-created', ts: at('2026-07-11T12:00:00Z'), seq: 1, runId: 'wf-mock-retrying', workflowName: 'heal-flow', argsSummary: '{"target":"api-gateway"}' },
  { type: 'phase-started', ts: plus(at('2026-07-11T12:00:00Z'), 1), seq: 2, phase: 'Heal' },
  { type: 'agent-started', ts: plus(at('2026-07-11T12:00:00Z'), 2), seq: 3, taskIndex: 0, agentName: 'healer-W1', attempt: 1, phase: 'Heal' },
  { type: 'agent-retrying', ts: plus(at('2026-07-11T12:00:00Z'), 30), seq: 4, taskIndex: 0, attempt: 1, backoffMs: 4000, reason: 'schema_deterministic: 输出缺少必填字段 result' },
]

/**
 * interrupted / stopped-time-limited 共用事件基座（[D8] 演员基座共用：同一序列、
 * 仅调用方追加的终局行不同——run-interrupted（neutral 停止档）vs run-settled
 * outcome=time_limited（failed 停止档，在途 call 保持无 settled））。
 */
const sharedStopBase = (runId: string, t0: string): WorkflowRunEventEntry[] => [
  { type: 'run-created', ts: at(t0), seq: 1, runId, workflowName: 'migrate-flow', argsSummary: '{"db":"main"}' },
  { type: 'phase-started', ts: plus(at(t0), 1), seq: 2, phase: 'Migrate' },
  { type: 'agent-started', ts: plus(at(t0), 2), seq: 3, taskIndex: 0, agentName: 'migrator-W1', attempt: 1, phase: 'Migrate' },
]

/** wf-mock-interrupted 事件行集（基座 A + run-interrupted 终局、其后无 resume）。 */
const wfInterruptedEvents: WorkflowRunEventEntry[] = [
  ...sharedStopBase('wf-mock-interrupted', '2026-07-11T13:00:00Z'),
  { type: 'run-interrupted', ts: plus(at('2026-07-11T13:00:00Z'), 40), seq: 4, reason: 'host shutdown' },
]

/** wf-mock-stopped-time-limited 事件行集（基座 A + run-settled time_limited，在途 call 无 settled）。 */
const wfStoppedTimeLimitedEvents: WorkflowRunEventEntry[] = [
  ...sharedStopBase('wf-mock-stopped-time-limited', '2026-07-11T14:00:00Z'),
  { type: 'run-settled', ts: plus(at('2026-07-11T14:00:00Z'), 40), seq: 4, outcome: 'time_limited', artifactsDir: '/data/artifacts/wf-mock-stopped-time-limited' },
]

/** wf-mock-parse-failed 事件行集（run 本身正常——仅 DAG 通道预置 parse_failed 错误臂）。 */
const wfParseFailedEvents: WorkflowRunEventEntry[] = [
  { type: 'run-created', ts: at('2026-07-11T15:00:00Z'), seq: 1, runId: 'wf-mock-parse-failed', workflowName: 'broken-flow', argsSummary: '{"step":1}' },
  { type: 'phase-started', ts: plus(at('2026-07-11T15:00:00Z'), 1), seq: 2, phase: 'Do' },
  { type: 'agent-started', ts: plus(at('2026-07-11T15:00:00Z'), 2), seq: 3, taskIndex: 0, agentName: 'worker-W1', attempt: 1, phase: 'Do' },
  { type: 'agent-settled', ts: plus(at('2026-07-11T15:00:00Z'), 32), seq: 4, taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 30_000 },
  { type: 'phase-settled', ts: plus(at('2026-07-11T15:00:00Z'), 33), seq: 5, phase: 'Do' },
  { type: 'run-settled', ts: at('2026-07-11T15:00:35Z'), seq: 6, outcome: 'done', artifactsDir: '/data/artifacts/wf-mock-parse-failed' },
]

/** wf-mock-empty-dag 事件行集（纯门禁脚本：无任何 agent 行，创建即终局）。 */
const wfEmptyDagEvents: WorkflowRunEventEntry[] = [
  { type: 'run-created', ts: at('2026-07-11T16:00:00Z'), seq: 1, runId: 'wf-mock-empty-dag', workflowName: 'gate-flow', argsSummary: '{"strict":true}' },
  { type: 'run-settled', ts: plus(at('2026-07-11T16:00:00Z'), 5), seq: 2, outcome: 'done', artifactsDir: '/data/artifacts/wf-mock-empty-dag' },
]

/** wf-mock-wide-phase 事件行集（单 phase Build 7 call：#0-#3 done、#4-#6 在途）。 */
const wfWidePhaseEvents: WorkflowRunEventEntry[] = [
  { type: 'run-created', ts: at('2026-07-11T17:00:00Z'), seq: 1, runId: 'wf-mock-wide-phase', workflowName: 'batch-flow', argsSummary: '{"items":7}' },
  { type: 'phase-started', ts: plus(at('2026-07-11T17:00:00Z'), 1), seq: 2, phase: 'Build' },
  { type: 'agent-started', ts: plus(at('2026-07-11T17:00:00Z'), 2), seq: 3, taskIndex: 0, agentName: 'builder-W1', attempt: 1, phase: 'Build' },
  { type: 'agent-started', ts: plus(at('2026-07-11T17:00:00Z'), 3), seq: 4, taskIndex: 1, agentName: 'builder-W2', attempt: 1, phase: 'Build' },
  { type: 'agent-started', ts: plus(at('2026-07-11T17:00:00Z'), 4), seq: 5, taskIndex: 2, agentName: 'builder-W3', attempt: 1, phase: 'Build' },
  { type: 'agent-started', ts: plus(at('2026-07-11T17:00:00Z'), 5), seq: 6, taskIndex: 3, agentName: 'builder-W4', attempt: 1, phase: 'Build' },
  { type: 'agent-started', ts: plus(at('2026-07-11T17:00:00Z'), 6), seq: 7, taskIndex: 4, agentName: 'builder-W5', attempt: 1, phase: 'Build' },
  { type: 'agent-started', ts: plus(at('2026-07-11T17:00:00Z'), 7), seq: 8, taskIndex: 5, agentName: 'builder-W6', attempt: 1, phase: 'Build' },
  { type: 'agent-started', ts: plus(at('2026-07-11T17:00:00Z'), 8), seq: 9, taskIndex: 6, agentName: 'builder-W7', attempt: 1, phase: 'Build' },
  { type: 'agent-settled', ts: plus(at('2026-07-11T17:00:00Z'), 62), seq: 10, taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 60_000 },
  { type: 'agent-settled', ts: plus(at('2026-07-11T17:00:00Z'), 63), seq: 11, taskIndex: 1, attempt: 1, outcome: 'done', durationMs: 60_000 },
  { type: 'agent-settled', ts: plus(at('2026-07-11T17:00:00Z'), 64), seq: 12, taskIndex: 2, attempt: 1, outcome: 'done', durationMs: 60_000 },
  { type: 'agent-settled', ts: plus(at('2026-07-11T17:00:00Z'), 65), seq: 13, taskIndex: 3, attempt: 1, outcome: 'done', durationMs: 60_000 },
]

/** wf-mock-mismatched-calls 事件行集（5 个 mystery-agent-N 实例，phase Review）。 */
const wfMismatchedEvents: WorkflowRunEventEntry[] = [
  { type: 'run-created', ts: at('2026-07-11T18:00:00Z'), seq: 1, runId: 'wf-mock-mismatched-calls', workflowName: 'audit-flow', argsSummary: '{"depth":2}' },
  { type: 'phase-started', ts: plus(at('2026-07-11T18:00:00Z'), 1), seq: 2, phase: 'Review' },
  { type: 'agent-started', ts: plus(at('2026-07-11T18:00:00Z'), 2), seq: 3, taskIndex: 0, agentName: 'mystery-agent-1', attempt: 1, phase: 'Review' },
  { type: 'agent-started', ts: plus(at('2026-07-11T18:00:00Z'), 3), seq: 4, taskIndex: 1, agentName: 'mystery-agent-2', attempt: 1, phase: 'Review' },
  { type: 'agent-started', ts: plus(at('2026-07-11T18:00:00Z'), 4), seq: 5, taskIndex: 2, agentName: 'mystery-agent-3', attempt: 1, phase: 'Review' },
  { type: 'agent-started', ts: plus(at('2026-07-11T18:00:00Z'), 5), seq: 6, taskIndex: 3, agentName: 'mystery-agent-4', attempt: 1, phase: 'Review' },
  { type: 'agent-started', ts: plus(at('2026-07-11T18:00:00Z'), 6), seq: 7, taskIndex: 4, agentName: 'mystery-agent-5', attempt: 1, phase: 'Review' },
  { type: 'agent-settled', ts: plus(at('2026-07-11T18:00:00Z'), 50), seq: 8, taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 48_000 },
  { type: 'agent-settled', ts: plus(at('2026-07-11T18:00:00Z'), 55), seq: 9, taskIndex: 1, attempt: 1, outcome: 'done', durationMs: 52_000 },
  { type: 'agent-settled', ts: plus(at('2026-07-11T18:00:00Z'), 60), seq: 10, taskIndex: 2, attempt: 1, outcome: 'done', durationMs: 56_000 },
  { type: 'agent-settled', ts: plus(at('2026-07-11T18:00:00Z'), 70), seq: 11, taskIndex: 3, attempt: 1, outcome: 'done', durationMs: 65_000 },
  { type: 'agent-settled', ts: plus(at('2026-07-11T18:00:00Z'), 80), seq: 12, taskIndex: 4, attempt: 1, outcome: 'done', durationMs: 74_000 },
  { type: 'phase-settled', ts: plus(at('2026-07-11T18:00:00Z'), 85), seq: 13, phase: 'Review' },
  { type: 'run-settled', ts: at('2026-07-11T18:01:30Z'), seq: 14, outcome: 'done', artifactsDir: '/data/artifacts/wf-mock-mismatched-calls' },
]

/**
 * Mock 事件流 fixture（runId → 行集；getWorkflowRunEvents 按 runId 查表，未登记
 * runId 返回结构化 record_not_found 领域回执——负例覆盖保留，L205 断言行为不变）。
 */
export const fixtureRunEventsByRun: Record<string, WorkflowRunEventEntry[]> = {
  'wf-mock-001': wfMock001Events,
  'wf-mock-running': wfRunningEvents,
  'wf-mock-pending': wfPendingEvents,
  'wf-mock-failed': wfFailedEvents,
  'wf-mock-retrying': wfRetryingEvents,
  'wf-mock-interrupted': wfInterruptedEvents,
  'wf-mock-stopped-time-limited': wfStoppedTimeLimitedEvents,
  'wf-mock-parse-failed': wfParseFailedEvents,
  'wf-mock-empty-dag': wfEmptyDagEvents,
  'wf-mock-wide-phase': wfWidePhaseEvents,
  'wf-mock-mismatched-calls': wfMismatchedEvents,
}

// ── 预置成品 DAG fixture（getWorkflowDag 按 runId 查表；[D8 定稿②] mock 内不跑解析器）──
// 字段形态与解析器产物同构（workflow-dag-parser.ts）：节点 id agent-L<行>-N<seq 全局
// 递增>、边 id edge-<i>、字面 agent 名 matchPattern = ^<名>$（正则字面量转义后锚定）。

/** 字面 agent 名调用点节点构造（id/matchPattern 按解析器惯例派生，消逐节点重复）。 */
const agentNode = (line: number, seq: number, name: string, phase: string): WorkflowDagNode => ({
  id: `agent-L${line}-N${seq}`,
  kind: 'agent',
  templateName: name,
  matchPattern: `^${name}$`,
  phase,
  line,
})

/** wf-mock-001 蓝图（[D8 定稿①] 既有 done 演员同批接 DAG 通道——Dev → Review 顺序两节点）。 */
const wfMock001Dag: WorkflowDag = {
  nodes: [
    agentNode(4, 0, 'dev-W1', 'Dev'),
    agentNode(7, 1, 'review-W1', 'Review'),
  ],
  edges: [{ id: 'edge-0', from: 'agent-L4-N0', to: 'agent-L7-N1', kind: 'sequence' }],
  phases: [{ name: 'Dev', order: 0 }, { name: 'Review', order: 1 }],
  parallelGroups: [],
  loops: [],
}

/** wf-mock-running / failed / retrying 单 phase 单节点蓝图（各自字面名，结构同构）。 */
const singleNodeDag = (line: number, name: string, phase: string): WorkflowDag => ({
  nodes: [agentNode(line, 0, name, phase)],
  edges: [],
  phases: [{ name: phase, order: 0 }],
  parallelGroups: [],
  loops: [],
})

/** interrupted / stopped-time-limited 共用蓝图（[D8] 基座共用：同一调用点结构）。 */
const stopBaseDag: WorkflowDag = singleNodeDag(3, 'migrator-W1', 'Migrate')

/** wf-mock-pending 蓝图（两 phase 顺序两节点，全部未挂接 → 节点 pending）。 */
const wfPendingDag: WorkflowDag = {
  nodes: [agentNode(2, 0, 'plan-W1', 'Plan'), agentNode(4, 1, 'impl-W1', 'Impl')],
  edges: [{ id: 'edge-0', from: 'agent-L2-N0', to: 'agent-L4-N1', kind: 'sequence' }],
  phases: [{ name: 'Plan', order: 0 }, { name: 'Impl', order: 1 }],
  parallelGroups: [],
  loops: [],
}

/** wf-mock-empty-dag 蓝图（零节点——E3 空 DAG 占位居中摘要的驱动数据）。 */
const wfEmptyDagDag: WorkflowDag = {
  nodes: [],
  edges: [],
  phases: [],
  parallelGroups: [],
  loops: [],
}

/** wf-mock-wide-phase 蓝图（单 phase Build 7 节点并行组、无顺序边——W-2 纵向边界数据面）。 */
const wfWidePhaseDag: WorkflowDag = {
  nodes: [
    agentNode(3, 0, 'builder-W1', 'Build'),
    agentNode(3, 1, 'builder-W2', 'Build'),
    agentNode(3, 2, 'builder-W3', 'Build'),
    agentNode(3, 3, 'builder-W4', 'Build'),
    agentNode(3, 4, 'builder-W5', 'Build'),
    agentNode(3, 5, 'builder-W6', 'Build'),
    agentNode(3, 6, 'builder-W7', 'Build'),
  ],
  edges: [],
  phases: [{ name: 'Build', order: 0 }],
  parallelGroups: [{ nodeIds: ['agent-L3-N0', 'agent-L3-N1', 'agent-L3-N2', 'agent-L3-N3', 'agent-L3-N4', 'agent-L3-N5', 'agent-L3-N6'] }],
  loops: [],
}

/** wf-mock-mismatched-calls 蓝图（模板调用点 reviewer-${…}——动态模板形态保留通配段，
 * 与解析器 extractNameTemplate 产物同构；call 的 phase（Review）与正则双错开 → 必入未匹配）。 */
const wfMismatchedDag: WorkflowDag = {
  nodes: [
    { id: 'agent-L3-N0', kind: 'agent', templateName: 'reviewer-${…}', matchPattern: '^reviewer-.*$', phase: 'Audit', line: 3 },
  ],
  edges: [],
  phases: [{ name: 'Audit', order: 0 }],
  parallelGroups: [],
  loops: [],
}

/**
 * 预置成品 DAG（runId → WorkflowDag；getWorkflowDag 成功臂查此表）。十演员中除
 * parse-failed（错误臂）外全部在列；interrupted 与 stopped-time-limited 共用蓝图。
 */
export const fixtureDagByRun: Record<string, WorkflowDag> = {
  'wf-mock-001': wfMock001Dag,
  'wf-mock-running': singleNodeDag(3, 'impl-W1', 'Impl'),
  'wf-mock-pending': wfPendingDag,
  'wf-mock-failed': singleNodeDag(3, 'shipper-W1', 'Ship'),
  'wf-mock-retrying': singleNodeDag(3, 'healer-W1', 'Heal'),
  'wf-mock-interrupted': stopBaseDag,
  'wf-mock-stopped-time-limited': stopBaseDag,
  'wf-mock-empty-dag': wfEmptyDagDag,
  'wf-mock-wide-phase': wfWidePhaseDag,
  'wf-mock-mismatched-calls': wfMismatchedDag,
}

/**
 * 预置 DAG 错误回执（runId → 错误臂载荷；getWorkflowDag 错误臂查此表）。[D8 定稿③]
 * 仅 parse_failed 演员在列——wf-mock-001 接通 DAG 后，降级断言（原因码透出 + 重试钮）
 * 的唯一数据源；其余错误码（no_script_source / record_not_found / path_rejected）走
 * 未登记 runId 的 record_not_found 负例与组件测试覆盖，mock 不另造数据。
 */
export const fixtureDagErrors: Record<string, { code: WorkflowDagErrorCode; message: string }> = {
  'wf-mock-parse-failed': { code: 'parse_failed', message: 'Unexpected token (3:5)' },
}
