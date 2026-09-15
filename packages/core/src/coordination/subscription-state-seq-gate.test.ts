/**
 * subscription-state-seq-gate.test.ts —— seq 协议 MF-3 接口级钉住（D1 归位验收，设计 §3.1/§4 A7）。
 *
 * 背景：MF-3（基线提前推进 → reconcile 失败后缺失段永久不可恢复）与 PR #175 R1（gap
 * 触发消息与回放双实体）历史上都不是 evalSeqGap 判定错误，而是「判定 + 簿记写入 +
 * 基线推进」三者配对在跨文件交互层出错——纯函数单测测不到。D1 把三者收进
 * subscription-state 后，本文件只读本模块（seqGate + setSubscriptionPorts +
 * subscribeSession + getSubscriptionState 公共面，零 vi.mock），在接口级锁死配对：
 *
 * 1. feed gap 消息序列 → 断言 reconcile 意图（reconcileFromSeq = 基线）+ gap 簿记
 *    配对（gap 写入 / 重复到达 drop / 基线递进时清理已覆盖条目、保留超前条目）
 * 2. 模拟 reconcile 失败 → 断言基线原位不动（MF-3 回归钉住）+ 簿记去重仍生效 +
 *    后续 gap 消息可再次触发 reconcile（自愈重试）
 * 3. reconcile 成功 → 基线 max() 收敛推进 + 簿记清理（失败原位的对照面）
 *
 * 运行：cd packages/core && npx vitest run src/coordination/subscription-state-seq-gate.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import {
  seqGate,
  subscribeSession,
  getSubscriptionState,
  resetSubscriptionStates,
  setSubscriptionPorts,
} from './subscription-state'
import type { TransportPorts } from './route-inbound'

function setup() {
  const subscribe = vi.fn() as Mock<TransportPorts['subscribe']>
  const replay = vi.fn()
  setSubscriptionPorts({ subscribe, replay })
  return { subscribe, replay }
}

/** 建立基线 10 的已订阅 session（initial subscribe，空回放） */
async function seedBaseline10(subscribe: Mock<TransportPorts['subscribe']>): Promise<void> {
  subscribe.mockResolvedValueOnce({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
  await subscribeSession('s1')
  expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 10, subscribed: true })
}

describe('seqGate — MF-3 接口级钉住（判定 + 簿记 + 基线配对）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
    vi.restoreAllMocks()
  })

  it('1. gap 消息序列 → reconcile 意图（fromSeq=基线）+ 簿记配对（写入/drop/递进清理）', async () => {
    const { subscribe } = setup()
    await seedBaseline10(subscribe)

    // gap：seq 13 > 10+1 → dispatch + reconcile 意图（fromSeq = 基线 10，排他下界非 12）
    expect(seqGate('s1', { seq: 13 })).toEqual({ action: 'dispatch', reconcileFromSeq: 10 })
    // 簿记写入与意图配对：触发消息已 dispatch 但基线未推进（MF-3）
    expect(getSubscriptionState('s1')?.gapDispatchedSeqs).toEqual(new Set([13]))
    expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(10)

    // 第二条 gap（reconcile 未完成，基线仍 10）：同样配对
    expect(seqGate('s1', { seq: 15 })).toEqual({ action: 'dispatch', reconcileFromSeq: 10 })
    expect(getSubscriptionState('s1')?.gapDispatchedSeqs).toEqual(new Set([13, 15]))

    // 触发消息重复到达（seq 超前于基线，常规去重覆盖不到）→ 簿记 drop（PR #175 R1）
    expect(seqGate('s1', { seq: 13 })).toEqual({ action: 'drop' })

    // 正常递进 seq=11（=10+1）→ dispatch 无 reconcile 意图 + 基线推进 11
    expect(seqGate('s1', { seq: 11 })).toEqual({ action: 'dispatch' })
    expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(11)
    // 簿记清理配对：<= 新基线的条目已无独立价值（常规 seq 去重接管），超前条目（13、15）保留
    expect(getSubscriptionState('s1')?.gapDispatchedSeqs).toEqual(new Set([13, 15]))
  })

  it('2. reconcile 失败 → 基线原位不动（MF-3 回归钉住）+ 簿记去重仍生效 + 自愈重试可用', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { subscribe } = setup()
    await seedBaseline10(subscribe)

    // gap 触发：gate 给出 reconcile 意图 + 写簿记
    expect(seqGate('s1', { seq: 13 })).toEqual({ action: 'dispatch', reconcileFromSeq: 10 })

    // 模拟 route-inbound 的 fire-and-forget reconcile 触发（applySeqGap 的唯一剩余职责）
    subscribe.mockRejectedValueOnce(new Error('network flap'))
    await subscribeSession('s1', 10)
    expect(warnSpy).toHaveBeenCalled() // ES2：失败 console.warn 消化，不抛不挂起

    // MF-3 钉住：reconcile 失败后基线原位（若 gate 曾提前推进到 13，缺失段 11-12 永久不可恢复）
    expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(10)
    expect(getSubscriptionState('s1')?.subscribed).toBe(true)
    // 簿记不受失败影响：触发消息重复到达仍 drop（去重语义在失败路径保持配对）
    expect(getSubscriptionState('s1')?.gapDispatchedSeqs).toEqual(new Set([13]))
    expect(seqGate('s1', { seq: 13 })).toEqual({ action: 'drop' })

    // 自愈重试：基线原位 → 后续新 gap 消息再次给出 reconcile 意图（fromSeq 仍是基线 10）
    expect(seqGate('s1', { seq: 14 })).toEqual({ action: 'dispatch', reconcileFromSeq: 10 })
    warnSpy.mockRestore()
  })

  it('3. reconcile 成功 → 基线 max() 收敛推进 + 簿记清理（失败原位的对照面）', async () => {
    const { subscribe, replay } = setup()
    await seedBaseline10(subscribe)

    expect(seqGate('s1', { seq: 13 })).toEqual({ action: 'dispatch', reconcileFromSeq: 10 })

    // reconcile 成功：缺失段（11、12）+ 触发消息（13）都在回放 snapshot 内
    subscribe.mockResolvedValueOnce({
      snapshot: [
        { type: 'session.compacted', seq: 11, payload: { sessionId: 's1' } },
        { type: 'session.compacted', seq: 12, payload: { sessionId: 's1' } },
        { type: 'session.compacted', seq: 13, payload: { sessionId: 's1' } },
      ],
      stateSnapshot: [],
      lastSeq: 13,
    })
    await subscribeSession('s1', 10)
    expect(replay).toHaveBeenCalledTimes(3)

    // 基线收敛到 13（>= 触发消息 seq，不回退）；簿记清理（基线已覆盖）
    expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(13)
    expect(getSubscriptionState('s1')?.gapDispatchedSeqs).toBeUndefined()
    // 收敛后重复到达由常规 seq<=lastSeenSeq 去重接管（无需簿记）
    expect(seqGate('s1', { seq: 13 })).toEqual({ action: 'drop' })
  })
})
