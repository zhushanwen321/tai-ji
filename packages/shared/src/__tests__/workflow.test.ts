// workflow.test.ts —— [W2 D5/D8] shared 侧 workflow 词表常量的在盘断言。
//
// 覆盖（V0 验收条款 4）：
// - WORKFLOW_RUN_OUTCOME_ALL：四值成员集（值级跟随锚的 shared 侧载体）；
// - WORKFLOW_RUN_OUTCOME_COVERAGE_LOCK：反向完备编译锁在盘（联合扩值漏改元组时
//   编译红——运行期仅断言锁值为 true）；
// - WORKFLOW_RUN_OUTCOME_LABELS：状态中文显示名四条（成功/失败/已取消/已中断，
//   「已取消」主动与「已中断」被动禁混用）。
import { describe, expect, it } from 'vitest'
import {
  WORKFLOW_RUN_OUTCOME_ALL,
  WORKFLOW_RUN_OUTCOME_COVERAGE_LOCK,
  WORKFLOW_RUN_OUTCOME_LABELS,
} from '../workflow'

describe('WORKFLOW_RUN_OUTCOME_ALL（[W2 D5] 四值词表全集常量）', () => {
  it('四成员与预期全表一致（扩缩值时本用例红——强制显式重审）', () => {
    expect([...WORKFLOW_RUN_OUTCOME_ALL].sort()).toEqual([
      'cancelled',
      'completed',
      'failed',
      'interrupted',
    ])
  })

  it('反向完备编译锁在盘且为 true（类型层承重，运行期仅验证在盘）', () => {
    expect(WORKFLOW_RUN_OUTCOME_COVERAGE_LOCK).toBe(true)
  })
})

describe('WORKFLOW_RUN_OUTCOME_LABELS（[W2 D8] 状态中文显示名单源词表）', () => {
  it('四条显示名与章程 D2 中文词表一致', () => {
    expect(WORKFLOW_RUN_OUTCOME_LABELS.completed).toBe('成功')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.failed).toBe('失败')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.cancelled).toBe('已取消')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.interrupted).toBe('已中断')
  })

  it('「已取消」（用户主动）与「已中断」（被动终局）是两个不同值（禁混用的词表前提）', () => {
    expect(WORKFLOW_RUN_OUTCOME_LABELS.cancelled).not.toBe(WORKFLOW_RUN_OUTCOME_LABELS.interrupted)
  })

  it('显示名覆盖与词表全集键数一致（Record 键型穷尽，扩值漏配编译红）', () => {
    expect(Object.keys(WORKFLOW_RUN_OUTCOME_LABELS).sort()).toEqual([
      ...WORKFLOW_RUN_OUTCOME_ALL,
    ].sort())
  })
})
