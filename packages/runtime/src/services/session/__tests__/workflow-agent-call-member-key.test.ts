/**
 * agentCall.memberRecordId 透出测试（run 级模型切换成员键对齐——dmg-r1-2 修复面）。
 *
 * 跨端成员键对齐锚：run 级切换聚合应答的成员标识（subagent-core
 * listAcceptedMemberRunIdsForSwitch 的 record id）≡ 详情载荷 agentCall.memberRecordId
 * （本文件锁定：投影透出值 = SubagentRecord.subagentId = record 创建事件 identity.id），
 * 前端成员回执显示态读取键 = subagentMemberDisplayKey(runId, memberRecordId)（renderer
 * useSubagentModel 测试锁定读取端同键命中）——两端共同值域 = 成员 record id，session id
 * （pi uuidv7）/ taskIndex 都不在键域。
 *
 * 纯函数单测（无 IO、无 SessionRecords 装置）；与 subagent-model-detail.test.ts 的
 * 差异 = 本文件只锁成员标识透出，模型字段派生（覆盖状态/最近生效值）见该文件。
 * 测试框架：vitest（从子包目录运行）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/workflow-agent-call-member-key.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { SubagentRecord, WorkflowRunRecord } from '@taiji/shared'
import { projectSubagentModelDetailIntoRuns } from '../workflow-record-projection.js'

function memberRecord(over: Partial<SubagentRecord> & Pick<SubagentRecord, 'subagentId' | 'parentRunId' | 'stepIndex'>): SubagentRecord {
  return {
    sessionFile: null,
    agent: 'dev-W1',
    slug: 'dev',
    task: 'do work',
    status: 'running',
    startedAt: 1000,
    ...over,
  }
}

function runRecord(agentCalls: WorkflowRunRecord['agentCalls']): WorkflowRunRecord {
  return {
    runId: 'wf-1',
    scriptName: 'demo',
    status: 'running',
    startedAt: '2026-10-07T00:00:00.000Z',
    stateFilePath: '/tmp/wf-1.record.jsonl',
    agentCalls,
  }
}

describe('projectSubagentModelDetailIntoRuns — agentCall.memberRecordId 透出（成员键单源）', () => {
  it('权威成员在场 → agentCall.memberRecordId = 成员 record id（无覆盖/生效值也透出——回执态读取键在首次切换前就位）', () => {
    const runs = [runRecord([{ id: 0, agent: 'dev-W1', status: 'running' }])]
    const subagents = [
      memberRecord({ subagentId: 'rec-member-1', parentRunId: 'wf-1', stepIndex: 0 }),
    ]

    const [projected] = projectSubagentModelDetailIntoRuns('main-1', runs, subagents, undefined)

    expect(projected?.agentCalls[0]?.memberRecordId).toBe('rec-member-1')
    // 覆盖/生效值缺席时不造这两键（成员标识是唯一恒透出字段）
    expect(projected?.agentCalls[0]?.modelOverride).toBeUndefined()
    expect(projected?.agentCalls[0]?.recentEffectiveModel).toBeUndefined()
  })

  it('成员圈定全 miss（无成员 record / parentRunId·stepIndex 缺席）→ 不造键（原引用返回）', () => {
    const run = runRecord([{ id: 0, agent: 'dev-W1', status: 'running' }])
    const runs = [run]

    expect(projectSubagentModelDetailIntoRuns('main-1', runs, [], undefined)).toBe(runs)
    expect(
      projectSubagentModelDetailIntoRuns(
        'main-1',
        runs,
        [memberRecord({ subagentId: 'rec-x', parentRunId: undefined, stepIndex: 0 })],
        undefined,
      ),
    ).toBe(runs)
    expect(run.agentCalls[0]?.memberRecordId).toBeUndefined()
  })

  it('一键多 attempt：权威成员（running 优先）的 record id 透出——显示权威与步骤行一致', () => {
    const runs = [runRecord([{ id: 0, agent: 'dev-W1', status: 'running' }])]
    const subagents = [
      memberRecord({ subagentId: 'rec-attempt-1', parentRunId: 'wf-1', stepIndex: 0, status: 'idle', startedAt: 900 }),
      memberRecord({ subagentId: 'rec-attempt-2', parentRunId: 'wf-1', stepIndex: 0, status: 'running', startedAt: 1100 }),
    ]

    const [projected] = projectSubagentModelDetailIntoRuns('main-1', runs, subagents, undefined)

    expect(projected?.agentCalls[0]?.memberRecordId).toBe('rec-attempt-2')
  })
})
