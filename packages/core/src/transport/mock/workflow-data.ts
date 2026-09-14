/**
 * Workflow/subagent mock fixture —— E2E 验证 Flows/Agents tab 渲染 + 跟随 session 切换。
 *
 * 从 mock/index.ts 拆出（文件行数超 500 限制）。
 */
import type { SubagentRecord, WorkflowRunRecord } from '@xyz-agent/shared'

/** Mock workflow fixture（至少 1 条含 agentCalls，供 WorkflowDetail 视图2 + agent call overlay E2E） */
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

/** Mock subagent fixture（E2E 验证 Agents tab 渲染）[U6] legacy done 收窄出类型，用归一后两态词 */
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
