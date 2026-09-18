/**
 * parseWorkflowResultNotify 单测（对话流系统通知渲染升级 D5）。
 *
 * 覆盖：reason 三态判定（completed / 失败族四值 / 词表外与缺失 → neutral）+ 防御矩阵——
 * runId 缺失、非 string、空串、details 非对象形态 → null（消息级中性）。
 *
 * 判据词表 = shared/src/workflow.ts 的 WorkflowDoneReason 镜像：
 * completed / failed / aborted / budget_limited / time_limited（invalid_args 无生产方不列入）。
 *
 * 消费点：core message-turns notifySummary 派生（去重键 = runId；failed → failedCount，
 * neutral → neutralCount）。生产端 = extensions/universal/subagent-workflow notifyDone。
 *
 * 运行：cd packages/shared && npx vitest run __tests__/workflow-result-notify.test.ts
 */
import { describe, it, expect } from 'vitest'
import { parseWorkflowResultNotify } from '../src/message'

/** 生产端 notifyDone 的 details 形态（helpers.ts WorkflowNotifyDetails）。 */
const doneDetails: Record<string, unknown> = {
  runId: 'wf-1783679279983-hlpc46',
  name: 'dev-flow',
  status: 'done',
  reason: 'completed',
  traceLength: 12,
  __gui__: { component: 'list-tree' },
}

describe('parseWorkflowResultNotify 合法输入与三态判定', () => {
  it('reason = completed → outcome completed + reason 原值', () => {
    expect(parseWorkflowResultNotify(doneDetails)).toEqual({
      runId: 'wf-1783679279983-hlpc46',
      outcome: 'completed',
      reason: 'completed',
    })
  })

  it('reason 失败族四值 → outcome failed（failed / aborted / budget_limited / time_limited）', () => {
    for (const reason of ['failed', 'aborted', 'budget_limited', 'time_limited']) {
      expect(parseWorkflowResultNotify({ ...doneDetails, reason })).toEqual({
        runId: 'wf-1783679279983-hlpc46',
        outcome: 'failed',
        reason,
      })
    }
  })

  it('多余字段忽略（只取 runId 与 reason，__gui__ 不进解析结果）', () => {
    const parsed = parseWorkflowResultNotify(doneDetails)
    expect(Object.keys(parsed as object)).toEqual(['runId', 'outcome', 'reason'])
  })
})

describe('parseWorkflowResultNotify reason 缺失/词表外 → 记录级 neutral', () => {
  it('reason 缺失（status done 但无 reason 旧载荷）→ neutral（不静默当成功）', () => {
    const { reason: _drop, ...noReason } = doneDetails
    const parsed = parseWorkflowResultNotify(noReason)
    expect(parsed?.outcome).toBe('neutral')
    expect(parsed?.runId).toBe('wf-1783679279983-hlpc46')
    expect('reason' in (parsed as object)).toBe(false)
  })

  it('reason 非 string（number / null / 对象）→ neutral', () => {
    expect(parseWorkflowResultNotify({ ...doneDetails, reason: 1 })?.outcome).toBe('neutral')
    expect(parseWorkflowResultNotify({ ...doneDetails, reason: null })?.outcome).toBe('neutral')
    expect(parseWorkflowResultNotify({ ...doneDetails, reason: { kind: 'failed' } })?.outcome).toBe('neutral')
  })

  it('原型链键（toString / constructor / __proto__）→ neutral（词表判定只认自有键，不误命中）', () => {
    for (const reason of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(parseWorkflowResultNotify({ ...doneDetails, reason })?.outcome).toBe('neutral')
    }
  })

  it('reason 词表外（枚举漂移：invalid_args / circular / 未知新值）→ neutral', () => {
    // invalid_args：runAndWait 合成返回值，不进入 run.state.reason（无生产方、不入镜像词表）
    expect(parseWorkflowResultNotify({ ...doneDetails, reason: 'invalid_args' })?.outcome).toBe('neutral')
    expect(parseWorkflowResultNotify({ ...doneDetails, reason: 'circular' })?.outcome).toBe('neutral')
    expect(parseWorkflowResultNotify({ ...doneDetails, reason: 'completed ' })?.outcome).toBe('neutral')
  })
})

describe('parseWorkflowResultNotify runId 缺失/类型异常 → null（消息级中性）', () => {
  it('runId 缺失 → null（去重键不可得，不产出 record）', () => {
    const { runId: _drop, ...noRunId } = doneDetails
    expect(parseWorkflowResultNotify(noRunId)).toBeNull()
  })

  it('runId 非 string（number / null / 对象）→ null', () => {
    expect(parseWorkflowResultNotify({ ...doneDetails, runId: 1783679279983 })).toBeNull()
    expect(parseWorkflowResultNotify({ ...doneDetails, runId: null })).toBeNull()
    expect(parseWorkflowResultNotify({ ...doneDetails, runId: { id: 'wf-1' } })).toBeNull()
  })

  it('runId 空串 → null（空串视为缺失，与 parseBgNotifyDetails 同款语义）', () => {
    expect(parseWorkflowResultNotify({ ...doneDetails, runId: '' })).toBeNull()
  })

  it('runId 异常与 reason 异常并存 → 以 runId 判定为准返回 null（消息级优先）', () => {
    expect(parseWorkflowResultNotify({ reason: 'failed' })).toBeNull()
    expect(parseWorkflowResultNotify({ runId: '', reason: 'failed' })).toBeNull()
  })
})

describe('parseWorkflowResultNotify details 非对象形态 → null', () => {
  it('null / undefined / 原始类型 / 数组 → null', () => {
    expect(parseWorkflowResultNotify(null)).toBeNull()
    expect(parseWorkflowResultNotify(undefined)).toBeNull()
    expect(parseWorkflowResultNotify('wf-1')).toBeNull()
    expect(parseWorkflowResultNotify(42)).toBeNull()
    expect(parseWorkflowResultNotify([doneDetails])).toBeNull()
  })
})
