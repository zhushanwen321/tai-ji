// pending-todos 聚合范围单测（remote-use-mobile-v2 §6.18 聚合半 / u-activity 验收条款 1）。
//
// 锁定聚合范围裁决（§6.18 收窄口径）：
// - 可归属待办（form/planReview/dialog，有效 sessionId）进会话区；
// - 无归属待办（permission——V-6 降级分支恒无归属；无效归属键兜底分支）进全局区；
// - 排序 = sessionOrder 序（未知 sid 殿后，客户端不重排原则）；total = 全部条目合计
//   （BottomNav 导航计数角的同源口径）。
// 三视角：构建者（分组/计数结构断言）+ 使用者（total 与组内 total 数字语义）；
// 纯函数无 DOM，观察者面（四空态/条目渲染）在 activity-screen.test 承接。
import { describe, expect, it } from 'vitest'
import { summarizePendingTodos } from '../pending-todos'

const SID_A = 'sid-aaa'
const SID_B = 'sid-bbb'

describe('summarizePendingTodos（§6.18 聚合范围）', () => {
  it('可归属进会话区：form/planReview/dialog 按分区键分组计数，无 permission 时全局区为零', () => {
    const summary = summarizePendingTodos({
      formCounts: new Map([[SID_A, { form: 2, planReview: 1 }]]),
      dialogCounts: new Map([[SID_B, 3]]),
      permissionPending: false,
      sessionOrder: [SID_A, SID_B],
    })
    expect(summary.sessionGroups).toHaveLength(2)
    const groupA = summary.sessionGroups.find((g) => g.sessionId === SID_A)!
    expect(groupA.formCount).toBe(2)
    expect(groupA.planReviewCount).toBe(1)
    expect(groupA.dialogCount).toBe(0)
    expect(groupA.total).toBe(3)
    const groupB = summary.sessionGroups.find((g) => g.sessionId === SID_B)!
    expect(groupB.dialogCount).toBe(3)
    expect(groupB.total).toBe(3)
    expect(summary.global.permissionCount).toBe(0)
    expect(summary.global.unattributedCount).toBe(0)
    expect(summary.total).toBe(6)
  })

  it('无归属进全局区：permission 在场计 1（V-6 降级分支恒无归属）；空串归属键兜底进 unattributed', () => {
    const summary = summarizePendingTodos({
      formCounts: new Map([
        [SID_A, { form: 1, planReview: 0 }],
        ['', { form: 1, planReview: 1 }], // 无归属一等分支：无效归属键不进会话区
      ]),
      dialogCounts: new Map(),
      permissionPending: true,
      sessionOrder: [SID_A],
    })
    expect(summary.sessionGroups).toHaveLength(1)
    expect(summary.sessionGroups[0]!.sessionId).toBe(SID_A)
    expect(summary.global.permissionCount).toBe(1)
    expect(summary.global.unattributedCount).toBe(2)
    expect(summary.total).toBe(4)
  })

  it('排序 = sessionOrder 序 + 未知 sid 殿后（客户端不重排原则的聚合侧落点）', () => {
    const SID_C = 'sid-ccc'
    const summary = summarizePendingTodos({
      formCounts: new Map([
        [SID_C, { form: 1, planReview: 0 }],
        [SID_A, { form: 1, planReview: 0 }],
      ]),
      dialogCounts: new Map([[SID_B, 1]]),
      permissionPending: false,
      sessionOrder: [SID_B, SID_A], // C 不在清单（快照外新会话）→ 殿后
    })
    expect(summary.sessionGroups.map((g) => g.sessionId)).toEqual([SID_B, SID_A, SID_C])
  })

  it('计数与 total 的使用者语义：total = 会话区条目合计 + 全局条目（导航计数角的同一数字）', () => {
    const summary = summarizePendingTodos({
      formCounts: new Map([[SID_A, { form: 3, planReview: 2 }]]),
      dialogCounts: new Map([[SID_A, 1]]),
      permissionPending: true,
      sessionOrder: [SID_A],
    })
    expect(summary.sessionGroups[0]!.total).toBe(6)
    expect(summary.total).toBe(7)
  })
})
