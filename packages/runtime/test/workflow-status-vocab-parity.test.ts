// workflow-status-vocab-parity.test.ts —— [§2.2] status 词表双包值级等价断言。
//
// 对齐既有 outcome 轴先例（workflow-outcome-vocab-parity.test.ts）——outcome 轴有
// 值级一致性锚，status 轴此前没有，这正是「同一状态在三处各写一份字面量、漂移了没人
// 拦」的缺口（登记 §2.2）。
//
// 覆盖：
// - shared `WorkflowRunStatus` 三值快照（编译期 `satisfies` 锚定——shared 收窄即此处
//   编译红；扩值未跟即运行期红）。
// - core 投影面（`runSummary`，run 状态的唯一投影）三种形态逐一产出的 status 全部落
//   在 shared 词表内，且三形态恰好覆盖词表三成员（running / interrupted / done）。
//
// 为什么在 runtime 侧断言：core 与 shared 不允许物理单源（private 包 × npm 发布包），
// 值级断言是可得的等价锚；runtime 同时依赖两者。
import { describe, expect, it } from 'vitest'

import {
  doneReasonToRunOutcome,
  noteRebuiltSettlement,
  runSummary,
  type DoneReason,
  type WorkflowRun,
} from '@zhushanwen/subagent-core'
import type { WorkflowRunStatus } from '@taiji/shared'

/** shared WorkflowRunStatus 词表成员（编译期 satisfies 锚定 shared 类型）。 */
const SHARED_WORKFLOW_RUN_STATUSES = [
  'running',
  'interrupted',
  'done',
] as const satisfies readonly WorkflowRunStatus[]

/** 最小 run 形态（runSummary 读 runId/spec/meta/state 与注册表条目）。
 *  [D6(a) 第 3 步] 终局判定源 = 终局记录注册表：done 形态经 noteRebuiltSettlement
 *  注入终局事实（生产 = 活体 dispatch 链 note / 壳重建点注入），聚合快照不持 status。 */
function makeRun(shape: {
  status?: string
  interruptedAt?: string
  reason?: string
}): WorkflowRun {
  const runId = `wf-status-parity-${shape.status ?? 'running'}-${shape.interruptedAt ?? 'live'}`
  if (shape.status === 'done') {
    noteRebuiltSettlement(runId, {
      outcome: doneReasonToRunOutcome((shape.reason ?? 'completed') as DoneReason),
      settledAt: 0,
    })
  }
  return {
    runId,
    spec: { scriptName: 'status-parity' },
    meta: {
      startedAt: '2026-09-30T00:00:00.000Z',
      ...(shape.interruptedAt !== undefined ? { interruptedAt: shape.interruptedAt } : {}),
    },
    state: {
      ...(shape.reason !== undefined ? { reason: shape.reason } : {}),
      budget: { usedTokens: 0, maxTokens: 1000, usedCost: 0 },
      trace: { toArray: () => [] },
      errorLogs: [],
    },
  } as unknown as WorkflowRun
}

describe('status 词表双包值级等价（[§2.2] core 投影 ≡ shared）', () => {
  it('shared 词表快照（三值；扩缩值即本用例红——两侧同步显式重审）', () => {
    expect([...SHARED_WORKFLOW_RUN_STATUSES].sort()).toEqual(['done', 'interrupted', 'running'])
  })

  it('core runSummary 三形态逐一投影，恰好覆盖 shared 三成员', () => {
    const projected = [
      runSummary(makeRun({})).status,
      runSummary(makeRun({ interruptedAt: '2026-09-30T01:00:00.000Z' })).status,
      runSummary(makeRun({ status: 'done', reason: 'completed' })).status,
    ]
    expect(new Set(projected)).toEqual(new Set(SHARED_WORKFLOW_RUN_STATUSES))
  })

  it('投影值恒落在 shared 词表内（含终局原因各形态）', () => {
    const shapes = [
      {},
      { interruptedAt: '2026-09-30T01:00:00.000Z' },
      { status: 'done', reason: 'completed' },
      { status: 'done', reason: 'failed' },
      { status: 'done', reason: 'aborted' },
      { status: 'done', reason: 'budget_limited' },
      { status: 'done', reason: 'time_limited' },
    ]
    for (const shape of shapes) {
      const status = runSummary(makeRun(shape)).status
      expect(SHARED_WORKFLOW_RUN_STATUSES as readonly string[]).toContain(status)
    }
  })
})
