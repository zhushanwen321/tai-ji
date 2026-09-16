/**
 * Workflow/subagent mock fixture —— E2E 验证任务列表渲染（composer 任务托盘面板 /
 * drawer workflow tab）+ 跟随 session 切换。
 *
 * 从 mock/index.ts 拆出（文件行数超 500 限制）。
 * [HISTORICAL] 2026-09-16 侧栏 Flows/Agents tab 退役后，列表渲染断言面迁至任务托盘
 * （workflow 详情视图 2 = drawer WorkflowTab）。
 */
import type { SubagentRecord, WorkflowRunRecord } from '@taiji/shared'

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
      { id: 0, agent: 'dev-W1', status: 'completed', phase: 'Dev', sessionId: 'sess-agent-mock-1' },
      { id: 1, agent: 'review-W1', status: 'completed', phase: 'Review', sessionId: 'sess-agent-mock-2' },
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
