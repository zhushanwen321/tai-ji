/* eslint-disable no-magic-numbers -- mock fixture 数据（workflow/subagent 记录、事件流帧）的字面量数值属领域数据，非逻辑魔数（data.ts 同款先例） */
/**
 * Workflow/subagent mock fixture —— E2E 验证任务列表渲染（composer 任务托盘面板 /
 * drawer workflow tab）+ 跟随 session 切换。
 *
 * 从 mock/index.ts 拆出（文件行数超 500 限制）。
 * [HISTORICAL] 2026-09-16 侧栏 Flows/Agents tab 退役后，列表渲染断言面迁至任务托盘
 * （workflow 详情视图 2 = drawer WorkflowTab）。
 */
import type { SubagentRecord, WorkflowRunEventEntry, WorkflowRunRecord } from '@taiji/shared'

/** Mock workflow fixture（至少 1 条含 agentCalls，供托盘面板 + drawer WorkflowTab E2E） */
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

// ── wf-mock-001 事件流 fixture（workflow-visualization e2e：overlay 事件流/Gantt
//    子页的正向对账数据）─────────────────────────────────────────────────────────
// 时间锚与 fixtureWorkflows[0] 对账：T0 = startedAt、T_END = completedAt（10:00 →
// 10:30）。帧序 = run-created → Dev 相（started/#0 dev-W1/settled/settled 相）→
// Review 相（同构）→ run-settled，与 agentCalls（id 0 Dev / id 1 Review，均 done）
// 逐 call 对得上；taskIndex 与 agentCalls[].id 同键域。

/** run 起止锚（epoch ms，与 record 字段同源换算）。 */
const RUN_T0 = Date.parse('2026-07-10T10:00:00Z')
const RUN_T_END = Date.parse('2026-07-10T10:30:00Z')

/**
 * Mock 事件流 fixture（10 行骨架帧，无大字段截断——截断展示面由组件测试覆盖）。
 * 仅 getWorkflowRunEvents 对 wf-mock-001 返回；DAG 通道仍恒降级（record_not_found，
 * 见 mock/index.ts getWorkflowDag）——两通道形态分立是刻意的测试数据组合：
 * DAG 降级驱动 overlay 左栏降级列表形态、事件流成功驱动右栏子页正向对账，
 * 二者在 e2e 里分别断言（e2e/workflow-viz-overlay.spec.ts）。
 */
export const fixtureRunEvents: WorkflowRunEventEntry[] = [
  { type: 'run-created', ts: RUN_T0, seq: 1, runId: 'wf-mock-001', workflowName: 'deploy-flow', argsSummary: '{"task":"demo"}' },
  { type: 'phase-started', ts: RUN_T0 + 1_000, seq: 2, phase: 'Dev' },
  { type: 'agent-started', ts: RUN_T0 + 2_000, seq: 3, taskIndex: 0, agentName: 'dev-W1', attempt: 1, phase: 'Dev' },
  { type: 'agent-settled', ts: RUN_T0 + 62_000, seq: 4, taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 60_000 },
  { type: 'phase-settled', ts: RUN_T0 + 63_000, seq: 5, phase: 'Dev' },
  { type: 'phase-started', ts: RUN_T0 + 64_000, seq: 6, phase: 'Review' },
  { type: 'agent-started', ts: RUN_T0 + 65_000, seq: 7, taskIndex: 1, agentName: 'review-W1', attempt: 1, phase: 'Review' },
  { type: 'agent-settled', ts: RUN_T0 + 965_000, seq: 8, taskIndex: 1, attempt: 1, outcome: 'done', durationMs: 900_000 },
  { type: 'phase-settled', ts: RUN_T0 + 966_000, seq: 9, phase: 'Review' },
  { type: 'run-settled', ts: RUN_T_END, seq: 10, outcome: 'done', artifactsDir: '/data/artifacts/wf-mock-001' },
]
