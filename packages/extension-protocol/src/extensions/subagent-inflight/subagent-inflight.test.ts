import { describe, it, expect } from 'vitest'
import { SUBAGENT_INFLIGHT_MARKER } from './marker'
import {
  INFLIGHT_REPORT_ACK,
  isInFlightReportAck,
  isSubagentInFlightReport,
  type SubagentInFlightReport,
} from './types'
import { BRIDGE_MARKER } from '../plugin-bridge/marker'
import { SESSION_MANAGER_MARKER } from '../session-manager/marker'
import { ASK_USER_MARKER } from '../ask-user/marker'

/**
 * marker 精确值 + NUL 前缀 + 形状守卫：形状是 SSOT 契约，
 * pi 侧壳层 reporter（u7a）与 runtime event-adapter（u7b）两侧都按此
 * 序列化/识别通道帧（值漂移 = 通道静默失联，此层测试在漂移时早炸）。
 * kind 字段已删（2026-09-13 oe-audit：消费端不读，死字段）。
 */
describe('subagent-inflight marker 精确值', () => {
  it('SUBAGENT_INFLIGHT_MARKER 精确值为 \\x00XYZ_SUBAGENT_INFLIGHT', () => {
    expect(SUBAGENT_INFLIGHT_MARKER).toBe('\x00XYZ_SUBAGENT_INFLIGHT')
  })

  it('SUBAGENT_INFLIGHT_MARKER 以 NUL 字符开头', () => {
    expect(SUBAGENT_INFLIGHT_MARKER.charCodeAt(0)).toBe(0)
  })

  it('SUBAGENT_INFLIGHT_MARKER 不与其他 select 通道 marker 冲突', () => {
    expect(SUBAGENT_INFLIGHT_MARKER).not.toBe(SESSION_MANAGER_MARKER)
    expect(SUBAGENT_INFLIGHT_MARKER).not.toBe(ASK_USER_MARKER)
    expect(SUBAGENT_INFLIGHT_MARKER).not.toBe(BRIDGE_MARKER)
  })
})

describe('isSubagentInFlightReport 形状守卫', () => {
  const valid: SubagentInFlightReport = { inFlight: 0, emittedAt: 1_000 }

  it('合法帧（sessionId 缺席）放行', () => {
    expect(isSubagentInFlightReport(valid)).toBe(true)
  })

  it('合法帧（sessionId 在场 + 大计数）放行', () => {
    expect(
      isSubagentInFlightReport({ inFlight: 3, sessionId: 's-1', emittedAt: 2_000 }),
    ).toBe(true)
  })

  it('冗余 kind 字段容忍（历史帧兼容——守卫不因多余字段拒绝）', () => {
    expect(isSubagentInFlightReport({ ...valid, kind: 'delta' } as unknown)).toBe(true)
  })

  it('inFlight 负数 / 非整数 / 非数字拒绝', () => {
    expect(isSubagentInFlightReport({ ...valid, inFlight: -1 })).toBe(false)
    expect(isSubagentInFlightReport({ ...valid, inFlight: 1.5 })).toBe(false)
    expect(isSubagentInFlightReport({ ...valid, inFlight: '0' })).toBe(false)
  })

  it('emittedAt 缺失 / 非数字拒绝', () => {
    expect(isSubagentInFlightReport({ inFlight: 0 })).toBe(false)
    expect(isSubagentInFlightReport({ ...valid, emittedAt: '1000' })).toBe(false)
  })

  it('sessionId 非字符串拒绝；非对象输入拒绝', () => {
    expect(isSubagentInFlightReport({ ...valid, sessionId: 7 })).toBe(false)
    expect(isSubagentInFlightReport(null)).toBe(false)
    expect(isSubagentInFlightReport('frame')).toBe(false)
  })
})

describe('INFLIGHT_REPORT_ACK 确认回包', () => {
  it('精确值 = {"ack":true}（pi 侧送达判据，漂移即全部上报误判失败）', () => {
    expect(INFLIGHT_REPORT_ACK).toBe('{"ack":true}')
  })

  it('isInFlightReportAck 精确匹配，其余值拒绝（undefined=超时/无路由不算送达）', () => {
    expect(isInFlightReportAck('{"ack":true}')).toBe(true)
    expect(isInFlightReportAck(undefined)).toBe(false)
    expect(isInFlightReportAck(null)).toBe(false)
    expect(isInFlightReportAck('{"ack":false}')).toBe(false)
  })
})
