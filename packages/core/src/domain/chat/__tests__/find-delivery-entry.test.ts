/**
 * findDeliveryEntry 谓词单测（[MF-1-4]）。
 *
 * 撤回「在途条目」判定谓词的单一数据点：UserBubble 三态路由（UI 展示）与
 * useChat.revokeMessage 双态路由（执行分派）共用——本测试锁定谓词行为契约，
 * 防两处消费方内联 find 漂移后 UI 展示与执行分派分叉。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/find-delivery-entry.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { findDeliveryEntry, replaceDeliveryProjection, resetDeliveryProjectionForTest } from '../effects/user-delivery'

function seed(sid: string, entries: Array<{ clientUuid: string; state: 'queued' | 'in-flight' | 'delivered' | 'failed'; lane?: 'direct' | 'steer' | 'queued' }>): void {
  replaceDeliveryProjection(
    sid,
    entries.map((e) => ({ clientUuid: e.clientUuid, preview: 'p', state: e.state, lane: e.lane ?? 'steer' })),
  )
}

describe('findDeliveryEntry（[MF-1-4] 撤回在途判定谓词单点）', () => {
  beforeEach(() => {
    resetDeliveryProjectionForTest()
  })

  it('投影命中 → 返回条目对象（调用方按 state 细分，非布尔）', () => {
    seed('s1', [{ clientUuid: 'u-1', state: 'in-flight', lane: 'direct' }])
    const entry = findDeliveryEntry('s1', 'u-1')
    expect(entry).toMatchObject({ clientUuid: 'u-1', state: 'in-flight', lane: 'direct' })
  })

  it('投影无该 session / 无该条目 → undefined（revokeMessage 据此走已送达腿）', () => {
    seed('s1', [{ clientUuid: 'u-1', state: 'queued' }])
    expect(findDeliveryEntry('s2', 'u-1')).toBeUndefined()
    expect(findDeliveryEntry('s1', 'u-404')).toBeUndefined()
  })

  it('delivered 条目同样返回（谓词只负责查取；在途判定 = 调用方的 state !== delivered）', () => {
    seed('s1', [{ clientUuid: 'u-2', state: 'delivered' }])
    const entry = findDeliveryEntry('s1', 'u-2')
    expect(entry?.state).toBe('delivered')
  })
})
