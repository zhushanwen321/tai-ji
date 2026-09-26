/**
 * reject-digest 单测（D6，plan-mode-audit-remediation 批次 4）。
 *
 * 「消化标记」原语行为锁定（bash / compact RPC reject 呈现消歧的收敛载体）：
 * - 构建者（白盒）：发起→置位→判定→收口的状态流转 + 「不污染」守卫（非发起路径的
 *   终态帧不置位）+ 单槽覆盖（重复发起重置）。
 * - 使用者（黑盒）：isDigestConsumed 的两值语义——true = 终态已呈现（抑制 toast），
 *   false = 无终态可呈现（toast 兜底）。
 * - 观察者（形态）：key 隔离（bash 与 compact 互不串扰）+ 三层清理出口（clearDigest /
 *   clearDigestSession / clearAllDigests）各自幂等且互不越界。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  markDigestInitiated,
  markDigestConsumed,
  isDigestConsumed,
  clearDigest,
  clearDigestSession,
  clearAllDigests,
} from '../reject-digest'

describe('reject-digest 消化标记原语（D6）', () => {
  beforeEach(() => {
    clearAllDigests()
  })

  it('发起前未决：isDigestConsumed 为 false（transport 级失败 → toast 兜底形态）', () => {
    expect(isDigestConsumed('bash', 's1')).toBe(false)
  })

  it('发起 → 未消化：catch 判定 false → toast 兜底（终态帧未到达）', () => {
    markDigestInitiated('bash', 's1')
    expect(isDigestConsumed('bash', 's1')).toBe(false)
  })

  it('发起 → 终态帧置位 → 已消化：catch 判定 true → 抑制 toast（帧先于回执契约）', () => {
    markDigestInitiated('compact', 's1')
    markDigestConsumed('compact', 's1')
    expect(isDigestConsumed('compact', 's1')).toBe(true)
  })

  it('「不污染」守卫：未发起路径的终态帧（auto-compaction）不置位', () => {
    markDigestConsumed('compact', 's1')
    expect(isDigestConsumed('compact', 's1')).toBe(false)
  })

  it('单槽覆盖：新一轮发起重置上一轮已消化残留', () => {
    markDigestInitiated('bash', 's1')
    markDigestConsumed('bash', 's1')
    expect(isDigestConsumed('bash', 's1')).toBe(true)
    // 上一轮 finally 收口后，新一轮发起重置
    clearDigest('bash', 's1')
    markDigestInitiated('bash', 's1')
    expect(isDigestConsumed('bash', 's1')).toBe(false)
  })

  it('key 隔离：bash 与 compact 同 session 互不串扰', () => {
    markDigestInitiated('bash', 's1')
    markDigestConsumed('bash', 's1')
    // compact 未发起，bash 的已消化不影响 compact 判定
    expect(isDigestConsumed('compact', 's1')).toBe(false)
  })

  it('clearDigest 单点收口：仅清指定 key × session，幂等', () => {
    markDigestInitiated('bash', 's1')
    markDigestInitiated('compact', 's1')
    markDigestInitiated('bash', 's2')
    clearDigest('bash', 's1')
    expect(isDigestConsumed('bash', 's1')).toBe(false)
    expect(isDigestConsumed('bash', 's2')).toBe(false)
    // s2 的 bash 条目仍在（发起未决 = false 而非「从未发起」同值——判定语义一致即可，
    // compact 侧条目不受 clearDigest('bash', s1) 影响
    markDigestConsumed('compact', 's1')
    expect(isDigestConsumed('compact', 's1')).toBe(true)
    // 幂等：重复 clear 不抛错
    clearDigest('bash', 's1')
  })

  it('clearDigestSession：该 session 全 key 一并清除，其他 session 不受影响', () => {
    markDigestInitiated('bash', 's1')
    markDigestInitiated('compact', 's1')
    markDigestInitiated('bash', 's2')
    clearDigestSession('s1')
    markDigestConsumed('bash', 's1') // 条目已清 → 守卫跳过（session 已销毁，置位无意义）
    expect(isDigestConsumed('bash', 's1')).toBe(false)
    expect(isDigestConsumed('compact', 's1')).toBe(false)
    // s2 条目仍在：发起未决态可正常流转到已消化
    markDigestConsumed('bash', 's2')
    expect(isDigestConsumed('bash', 's2')).toBe(true)
  })

  it('clearAllDigests：全量清空（测试隔离出口）', () => {
    markDigestInitiated('bash', 's1')
    markDigestConsumed('bash', 's1')
    clearAllDigests()
    // 全清后连「未决」信息也无——isDigestConsumed false，且再次置位被守卫拦（未发起）
    expect(isDigestConsumed('bash', 's1')).toBe(false)
    markDigestConsumed('bash', 's1')
    expect(isDigestConsumed('bash', 's1')).toBe(false)
  })
})
