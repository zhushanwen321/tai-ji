// workflow-outcome-vocab-parity.test.ts —— [W2 D5] outcome 词表双包值级等价断言。
//
// 覆盖：core ALL_RUN_OUTCOMES ≡ shared WorkflowRunOutcome 词表成员。core↔shared
// 依赖方向不允许物理单源（private 包 × npm 发布包），值级断言是可得的等价锚。
//
// [ADR-0095] runtime extractor 值级判定集合（WORKFLOW_RUN_OUTCOMES）随 v1 读侧删除——
// 原三方等价（core ≡ extractor ≡ shared）收敛为双包断言；经提取链的漏升回归行为范围
// 随提取器派生视图一并删除（runtime workflow 列表数据源 = events-projection 派生视图，
// outcome 派生视图判据单源在 core runSettledOutcomeToDoneReason）。
import { describe, expect, it } from 'vitest'

import { ALL_RUN_OUTCOMES } from '@zhushanwen/subagent-core'
import type { WorkflowRunOutcome } from '@taiji/shared'

/** shared WorkflowRunOutcome 词表成员（编译期 satisfies 锚定 shared 类型——词表收窄即此处编译红）。 */
const SHARED_WORKFLOW_RUN_OUTCOMES = [
  'done',
  'failed',
  'cancelled',
  'time_limited',
  'partially_succeeded',
] as const satisfies readonly WorkflowRunOutcome[]

describe('outcome 词表双包值级等价（[W2 D5] core ≡ shared）', () => {
  it('core ALL_RUN_OUTCOMES 与 shared 词表成员逐成员一致（[D2] 四值 + [subagent-observability §3.3.8] 第五值）', () => {
    expect([...ALL_RUN_OUTCOMES].sort()).toEqual([...SHARED_WORKFLOW_RUN_OUTCOMES].sort())
    expect(ALL_RUN_OUTCOMES).toContain('time_limited')
    // [subagent-observability §3.3.8] partially_succeeded 双侧同批扩值（成员交付结算派生）
    expect(ALL_RUN_OUTCOMES).toContain('partially_succeeded')
    // [D2] interrupted 已移出 outcome（入 status 三态）——词表不含
    expect(ALL_RUN_OUTCOMES).not.toContain('interrupted')
  })

  it('五值全表快照（词表扩缩值时本用例红——两侧同步显式重审）', () => {
    expect([...ALL_RUN_OUTCOMES].sort()).toEqual([
      'cancelled',
      'done',
      'failed',
      'partially_succeeded',
      'time_limited',
    ])
    expect([...SHARED_WORKFLOW_RUN_OUTCOMES].sort()).toEqual([
      'cancelled',
      'done',
      'failed',
      'partially_succeeded',
      'time_limited',
    ])
  })
})
