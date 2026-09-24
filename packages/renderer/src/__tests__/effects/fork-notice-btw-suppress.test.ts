/**
 * [M4-a / btw-question D4] ForkNotice suppress（btw 流渲染）——P-invisible 渲染面。
 *
 * 线是 fork 产物（header.parentSession 指向源）但「关联只删不显」：fork 反馈行/分支追踪
 * 状态不进 btw 流。抑制落 useForkNoticeFeed().notices 读口单点（MessageStream 全部消费方
 * 经此读取）；主会话 feed 行为回归对照在同用例。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/fork-notice-btw-suppress.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  useForkNoticeFeed,
  pushForkNoticeAsk,
  resetForkNoticeFeed,
} from '@/composables/effects/useForkNoticeEffect'

beforeEach(() => {
  resetForkNoticeFeed()
})

describe('ForkNotice suppress（btw 流）', () => {
  it('notice 推给 btw vid → notices(vid) 构造性空；主会话同型推送照常可见', () => {
    pushForkNoticeAsk('btw:line-fn-1', 'new-branch-1', '旁路提问预览')
    pushForkNoticeAsk('main-fn-1', 'new-branch-2', '主分支预览')

    const feed = useForkNoticeFeed()
    expect(feed.notices('btw:line-fn-1')).toHaveLength(0) // btw 流 suppress（D4）
    expect(feed.notices('main-fn-1')).toHaveLength(1) // 主会话行为不变（回归对照）

    // suppress 对交互幂等：dismiss/clear 对空表零动作不抛
    expect(() => feed.dismissNotice('btw:line-fn-1', 1)).not.toThrow()
    expect(() => feed.clearSession('btw:line-fn-1')).not.toThrow()
  })
})
