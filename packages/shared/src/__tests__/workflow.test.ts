// workflow.test.ts —— [W2 D5/D8] shared 侧 workflow 词表常量的在盘断言。
//
// 覆盖（V0 验收条款 4）：
// - WORKFLOW_RUN_OUTCOME_ALL：五值成员集（值级跟随锚的 shared 侧载体；含
//   [subagent-observability §3.3.8] partially_succeeded 第五值）；
// - WORKFLOW_RUN_OUTCOME_COVERAGE_LOCK / WORKFLOW_DONE_REASON_COVERAGE_LOCK：反向
//   完备编译锁在盘（联合扩值漏改元组时编译红——运行期仅断言锁值为 true）；
// - WORKFLOW_RUN_OUTCOME_LABELS：状态中文显示名五条（成功/失败/已取消/已超时/
//   部分成功，「已取消」主动与「已中断」被动禁混用）；
// - WORKFLOW_DONE_REASON_ALL：done 终态原因六值全集对账锚（§3.3.8 消费链②——
//   runtime 收窄点 WORKFLOW_DONE_REASON_SET 扩值入对账的 shared 侧成员集合）。
import { describe, expect, it } from 'vitest'
import {
  WORKFLOW_DONE_REASON_ALL,
  WORKFLOW_DONE_REASON_COVERAGE_LOCK,
  WORKFLOW_RUN_OUTCOME_ALL,
  WORKFLOW_RUN_OUTCOME_COVERAGE_LOCK,
  WORKFLOW_RUN_OUTCOME_LABELS,
} from '../workflow'

describe('WORKFLOW_RUN_OUTCOME_ALL（[W2 D5] 词表全集常量）', () => {
  it('五成员与预期全表一致（扩缩值时本用例红——强制显式重审）', () => {
    // [D2] 四值 done/failed/cancelled/time_limited + [subagent-observability §3.3.8]
    // partially_succeeded（run 终局吸收成员交付的独立档）
    expect([...WORKFLOW_RUN_OUTCOME_ALL].sort()).toEqual([
      'cancelled',
      'done',
      'failed',
      'partially_succeeded',
      'time_limited',
    ])
  })

  it('反向完备编译锁在盘且为 true（类型层承重，运行期仅验证在盘）', () => {
    expect(WORKFLOW_RUN_OUTCOME_COVERAGE_LOCK).toBe(true)
  })
})

describe('WORKFLOW_DONE_REASON_ALL（[subagent-observability §3.3.8] done 终态原因对账锚）', () => {
  it('六成员与预期全表一致（联合扩值漏改元组由 COVERAGE_LOCK 编译红）', () => {
    expect([...WORKFLOW_DONE_REASON_ALL].sort()).toEqual([
      'aborted',
      'budget_limited',
      'completed',
      'failed',
      'partially_succeeded',
      'time_limited',
    ])
  })

  it('反向完备编译锁在盘且为 true（类型层承重，运行期仅验证在盘）', () => {
    expect(WORKFLOW_DONE_REASON_COVERAGE_LOCK).toBe(true)
  })
})

describe('WORKFLOW_RUN_OUTCOME_LABELS（[W2 D8] 状态中文显示名单源词表）', () => {
  it('五条显示名（[D2] 四值 + [§3.3.8] partially_succeeded）', () => {
    expect(WORKFLOW_RUN_OUTCOME_LABELS.done).toBe('成功')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.failed).toBe('失败')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.cancelled).toBe('已取消')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.time_limited).toBe('已超时')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.partially_succeeded).toBe('部分成功')
  })

  it('「已取消」（用户主动）与「已超时」（预算超时）是两个不同值（禁混用的词表前提）；中断语义已移出 outcome 入 status 三态', () => {
    expect(WORKFLOW_RUN_OUTCOME_LABELS.cancelled).not.toBe(WORKFLOW_RUN_OUTCOME_LABELS.time_limited)
    // [D2] 中断非 outcome——status 三态 'interrupted' 的显示归 WorkflowRunStatus 面
    expect(WORKFLOW_RUN_OUTCOME_ALL).not.toContain('interrupted')
  })

  it('显示名覆盖与词表全集键数一致（Record 键型穷尽，扩值漏配编译红）', () => {
    expect(Object.keys(WORKFLOW_RUN_OUTCOME_LABELS).sort()).toEqual([
      ...WORKFLOW_RUN_OUTCOME_ALL,
    ].sort())
  })
})
