/**
 * createFrameBookkeeping 单测：recency 序号表的原语行为
 * （消费方 useGenStats / useContextUsage 收敛自此处，见模块头注登记；
 * 原 suppressed 抑制表随 D-B2-1 退役——已删分区拦截收进 useSessionScopedState
 * 工厂单点，拦截断言在 use-session-scoped-state.test.ts）。
 *
 * 运行：cd packages/core && npx vitest run src/foundation/create-frame-bookkeeping.test.ts
 */
import { describe, it, expect } from 'vitest'
import { createFrameBookkeeping } from './create-frame-bookkeeping'

describe('createFrameBookkeeping recency 序号表', () => {
  it('初始序号为 0（无帧史，RPC 发起捕获 seqAtIssue = 0）', () => {
    const bk = createFrameBookkeeping()
    expect(bk.seqAt('s1')).toBe(0)
  })

  it('bumpSeq 单调递增；seqAt 反映最新序号', () => {
    const bk = createFrameBookkeeping()
    bk.bumpSeq('s1')
    bk.bumpSeq('s1')
    expect(bk.seqAt('s1')).toBe(2)
  })

  it('hasNewerFrame：seqAtIssue 与当前序号一致 → false（无更新帧）；bump 后 → true', () => {
    const bk = createFrameBookkeeping()
    expect(bk.hasNewerFrame('s1', 0)).toBe(false)
    bk.bumpSeq('s1')
    expect(bk.hasNewerFrame('s1', 0)).toBe(true)
    // 发起后无新帧（seqAtIssue 即当前序号）→ 不弃写
    expect(bk.hasNewerFrame('s1', bk.seqAt('s1'))).toBe(false)
  })

  it('各 sid 序号独立', () => {
    const bk = createFrameBookkeeping()
    bk.bumpSeq('a')
    expect(bk.seqAt('b')).toBe(0)
    expect(bk.hasNewerFrame('b', 0)).toBe(false)
  })
})
