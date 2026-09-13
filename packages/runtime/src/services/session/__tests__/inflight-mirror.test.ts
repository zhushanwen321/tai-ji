/**
 * inflight-mirror 单元测试（u7b，设计权威源 docs/architecture/crash-forensics-and-watchdog.md
 * §3.3 D5「缺席与丢失的语义收敛」①-⑤）。
 *
 * 覆盖（u7b 验收）：
 * - errs 判别真值表三形态：「已注入 + 从未收到上报」→ 'absent-report'；「已注入 + 上报过 0」
 *   → null（按镜像值判）；「未注入」（无论有无上报）→ null（D5 ①：未注入 ⇒ 判「无在途」）；
 * - 绝对计数语义：applyReport 整值覆盖（非增量），后帧纠正前帧；
 * - 五 spawn 形态预置 0（presetZero，调用方 u4/u5 收敛为 registerSession 单挂点）：条目
 *   建立为 inFlight=0（respawn 对账同挂点——resetFor 已删，2026-09-13 oe-audit：生产零
 *   调用且与 presetZero 实现逐字同款）；
 * - 条目与 session 生命周期同删（dropSession）；
 * - 快照隔离（query 返回副本，外部改写不影响内部态）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/inflight-mirror.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createInFlightMirror,
  inflightMirror,
} from '../inflight-mirror.js'
import type { InFlightMirror } from '../inflight-mirror.js'
import type { SubagentInFlightReport } from '@xyz-agent/extension-protocol'

const SID = 'sess-mirror-1'

function report(inFlight: number): SubagentInFlightReport {
  return { inFlight, sessionId: SID, emittedAt: 1_700_000_000_000 }
}

/** 模块级单例在文件内跨用例共享——每例前清该 sid 的条目（其它 sid 不受影响）。 */
function freshMirror(): InFlightMirror {
  inflightMirror.dropSession(SID)
  return inflightMirror
}

beforeEach(() => {
  inflightMirror.dropSession(SID)
})

describe('inflight-mirror: errs 判别真值表（D5 ④）', () => {
  it('未注入 + 无条目 → 无快照，errs=null（不是 errs——未注入判「无在途」）', () => {
    const m = freshMirror()
    expect(m.query(SID)).toBeUndefined()
    expect(m.errsShape(SID)).toBeNull()
  })

  it('未注入 + 收到上报 → errs 恒 null（D5 ①：未注入 ⇒ 判「无在途」）', () => {
    const m = freshMirror()
    m.applyReport(SID, report(3))
    expect(m.query(SID)?.inFlight).toBe(3)
    expect(m.errsShape(SID)).toBeNull()
  })

  it('已注入 + 从未收到上报 → errs=absent-report（reporter 放弃 / 通道结构性故障形态）', () => {
    const m = freshMirror()
    m.setInjected(SID, true)
    expect(m.errsShape(SID)).toBe('absent-report')
    expect(m.query(SID)).toEqual({ injected: true, hasEverReported: false, inFlight: 0 })
  })

  it('已注入 + 上报过 0 → errs=null，镜像值 0（0 = 在场且无在途的已证事实，非未知）', () => {
    const m = freshMirror()
    m.setInjected(SID, true)
    m.applyReport(SID, report(0))
    expect(m.errsShape(SID)).toBeNull()
    expect(m.query(SID)?.inFlight).toBe(0)
    expect(m.query(SID)?.hasEverReported).toBe(true)
  })

  it('已注入 + 上报过非 0 → errs=null，按镜像值判', () => {
    const m = freshMirror()
    m.setInjected(SID, true)
    m.applyReport(SID, report(2))
    expect(m.errsShape(SID)).toBeNull()
    expect(m.query(SID)?.inFlight).toBe(2)
  })

  it('setInjected(false) 复位注入态 → errs 立即回 null（不误伤未注入 session）', () => {
    const m = freshMirror()
    m.setInjected(SID, true)
    expect(m.errsShape(SID)).toBe('absent-report')
    m.setInjected(SID, false)
    expect(m.errsShape(SID)).toBeNull()
  })
})

describe('inflight-mirror: 绝对计数 + 预置/删除', () => {
  it('applyReport 整值覆盖（非增量）：后帧纠正前帧', () => {
    const m = freshMirror()
    m.applyReport(SID, report(5))
    m.applyReport(SID, { ...report(2), emittedAt: 1_700_000_000_123 })
    expect(m.query(SID)?.inFlight).toBe(2)
  })

  it('presetZero（五 spawn 形态收敛单挂点）建条目为 inFlight=0，不触碰 injected', () => {
    const m = freshMirror()
    m.setInjected(SID, true)
    m.applyReport(SID, report(4))
    m.presetZero(SID)
    expect(m.query(SID)).toEqual({ injected: true, hasEverReported: false, inFlight: 0 })
    // 新 epoch 未上报 → errs（新 pi 进程的 extension 实例尚未上报）
    expect(m.errsShape(SID)).toBe('absent-report')
  })

  it('presetZero 对无条目 session 幂等建条目（不抛）', () => {
    const m = freshMirror()
    m.presetZero(SID)
    expect(m.query(SID)).toEqual({ injected: false, hasEverReported: false, inFlight: 0 })
  })

  it('dropSession（session 删除/回收摘除）删条目：查询与 errs 双归零', () => {
    const m = freshMirror()
    m.setInjected(SID, true)
    m.applyReport(SID, report(1))
    m.dropSession(SID)
    expect(m.query(SID)).toBeUndefined()
    expect(m.errsShape(SID)).toBeNull()
  })

  it('query 返回快照副本：外部改写不污染内部态', () => {
    const m = freshMirror()
    m.setInjected(SID, true)
    m.applyReport(SID, report(1))
    const snapshot = m.query(SID)
    snapshot!.inFlight = 99
    snapshot!.injected = false
    expect(m.query(SID)?.inFlight).toBe(1)
    expect(m.query(SID)?.injected).toBe(true)
  })

  it('session 隔离：不同 sid 条目互不影响', () => {
    const m = freshMirror()
    m.setInjected('sess-a', true)
    m.setInjected('sess-b', false)
    expect(m.errsShape('sess-a')).toBe('absent-report')
    expect(m.errsShape('sess-b')).toBeNull()
    m.dropSession('sess-a')
    m.dropSession('sess-b')
  })
})

describe('inflight-mirror: 实例与单例', () => {
  it('createInFlightMirror 返回独立实例（与模块级单例不串台）', () => {
    const isolated = createInFlightMirror()
    isolated.setInjected(SID, true)
    // 单例未被工厂实例写入（beforeEach 已清单例条目 → 仍 undefined）
    expect(inflightMirror.query(SID)).toBeUndefined()
    expect(isolated.errsShape(SID)).toBe('absent-report')
  })

  it('模块级单例导出可用（对齐 runtime 单例风格；resetFor 已删——2026-09-13 oe-audit 生产零调用）', () => {
    expect(typeof inflightMirror.setInjected).toBe('function')
    expect(typeof inflightMirror.presetZero).toBe('function')
    expect(typeof inflightMirror.dropSession).toBe('function')
    expect(typeof inflightMirror.applyReport).toBe('function')
    expect(typeof inflightMirror.query).toBe('function')
    expect(typeof inflightMirror.errsShape).toBe('function')
    expect((inflightMirror as unknown as Record<string, unknown>).resetFor).toBeUndefined()
  })
})
