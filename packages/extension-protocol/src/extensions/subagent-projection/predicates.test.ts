/**
 * subagent 投影判据单测——判据单点的包内行为锚定（[dmg-r1-4] 下沉后，
 * 插件侧托盘 widget 与宿主 renderer 的判据测试各自锚定端到端呈现，本文件
 * 锚定判据本体在协议包内的分支语义：stopReason 排除子句 / user.cancelled
 * 排除子句 / label 点拼形态）。
 */
import { describe, it, expect } from 'vitest'
import {
  failedRoundOf,
  failureCauseLabel,
  isRunningProjection,
  type SubagentProjectionRecord,
} from './predicates'

/** 最小合法入参（字段面 = SubagentProjectionRecord 全集）。 */
function makeRecord(over: Partial<SubagentProjectionRecord> = {}): SubagentProjectionRecord {
  return {
    status: 'idle',
    stopReason: 'completed',
    lastRound: undefined,
    ...over,
  }
}

describe('isRunningProjection 占用谓词', () => {
  it('running 且无停因 → true（「轮收条已写 = 本轮不在途」的等价信号）', () => {
    expect(isRunningProjection(makeRecord({ status: 'running', stopReason: undefined }))).toBe(true)
  })

  it('running + 停因在场（轮收条残留）→ false（stopReason 子句排除）', () => {
    expect(isRunningProjection(makeRecord({ status: 'running', stopReason: 'failed' }))).toBe(false)
    expect(isRunningProjection(makeRecord({ status: 'running', stopReason: 'completed' }))).toBe(false)
  })

  it('非 running → false（status 子句直接排除）', () => {
    expect(isRunningProjection(makeRecord({ status: 'idle', stopReason: undefined }))).toBe(false)
  })
})

describe('failedRoundOf 失败轮判据', () => {
  const providerFailure = { class: 'provider', kind: 'rate_limited', retryable: 'conditional', raw: 'x' }
  const userCancel = { class: 'user', kind: 'cancelled', retryable: false, raw: 'user aborted' }

  it('failure 在场且非 user.cancelled → 返回该 lastRound（失败轮）', () => {
    const lastRound = { engineStopReason: 'error', failure: providerFailure }
    const record = makeRecord({ status: 'idle', stopReason: 'error', lastRound })
    expect(failedRoundOf(record)).toBe(lastRound)
  })

  it('user.cancelled 是用户主动中止非失败 → undefined', () => {
    // lastRound 经变量中转携带真实载荷的额外字段（两侧 lastRound 均有 engineStopReason
    // 等 failure 外字段——结构兼容由本形态覆盖）
    const lastRound = { engineStopReason: 'aborted', failure: userCancel }
    const record = makeRecord({ status: 'idle', stopReason: 'aborted', lastRound })
    expect(failedRoundOf(record)).toBeUndefined()
  })

  it('无 lastRound / failure 缺席 → undefined', () => {
    expect(failedRoundOf(makeRecord({ status: 'running', stopReason: undefined }))).toBeUndefined()
    // failure 显式 undefined（与属性缺席在 `failure === undefined` 判据下等价）
    const lastRoundNoFailure = { failure: undefined }
    expect(
      failedRoundOf(makeRecord({ status: 'idle', stopReason: 'completed', lastRound: lastRoundNoFailure })),
    ).toBeUndefined()
  })
})

describe('failureCauseLabel 失败分类展示词', () => {
  it('"<class>.<kind>" 点拼（与 run 终局 failedMembers[].cause 序列化形态同形）', () => {
    expect(failureCauseLabel({ class: 'provider', kind: 'rate_limited' })).toBe('provider.rate_limited')
    expect(failureCauseLabel({ class: 'engine', kind: 'engine_crash' })).toBe('engine.engine_crash')
  })
})
