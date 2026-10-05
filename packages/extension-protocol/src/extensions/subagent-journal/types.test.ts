import { describe, it, expect } from 'vitest'
import { SUBAGENT_JOURNAL_MARKER } from './marker'
import {
  JOURNAL_REPORT_ACK,
  isJournalReportAck,
  isSubagentJournalReport,
  type SubagentJournalEvent,
  type SubagentJournalReport,
} from './types'
import { SUBAGENT_INFLIGHT_MARKER } from '../subagent-inflight/marker'
import { SESSION_MANAGER_MARKER } from '../session-manager/marker'
import { ASK_USER_MARKER } from '../ask-user/marker'

/**
 * marker 精确值 + NUL 前缀 + 形状守卫：journal 推送通道（event-push-channel）的
 * SSOT 契约——pi 侧壳层 reporter 与 runtime event-adapter 两侧都按此序列化/识别
 * 通道帧（值漂移 = 通道静默失联，此层测试在漂移时早炸）。
 */
describe('subagent-journal marker 精确值', () => {
  it('SUBAGENT_JOURNAL_MARKER 精确值为 \\x00TAIJI_SUBAGENT_JOURNAL', () => {
    expect(SUBAGENT_JOURNAL_MARKER).toBe('\x00TAIJI_SUBAGENT_JOURNAL')
  })

  it('SUBAGENT_JOURNAL_MARKER 以 NUL 字符开头', () => {
    expect(SUBAGENT_JOURNAL_MARKER.charCodeAt(0)).toBe(0)
  })

  it('SUBAGENT_JOURNAL_MARKER 不与其他 select 通道 marker 冲突', () => {
    expect(SUBAGENT_JOURNAL_MARKER).not.toBe(SUBAGENT_INFLIGHT_MARKER)
    expect(SUBAGENT_JOURNAL_MARKER).not.toBe(SESSION_MANAGER_MARKER)
    expect(SUBAGENT_JOURNAL_MARKER).not.toBe(ASK_USER_MARKER)
  })
})

describe('isSubagentJournalReport 形状守卫', () => {
  const event: SubagentJournalEvent = { type: 'run_started', ts: 1_000 }
  const valid: SubagentJournalReport = {
    domain: 'run',
    fileKey: 'run-1',
    events: [event],
    emittedAt: 2_000,
  }

  it('合法帧（run 域，sessionId 缺席）放行', () => {
    expect(isSubagentJournalReport(valid)).toBe(true)
  })

  it('合法帧（record 域 + sessionId 在场 + 空 events）放行', () => {
    expect(
      isSubagentJournalReport({
        domain: 'record',
        fileKey: 'sa-1',
        events: [],
        sessionId: 's-1',
        emittedAt: 2_000,
      }),
    ).toBe(true)
  })

  it('无 seq 事件放行（W1 前存量行兼容——不参与缺口判定）', () => {
    expect(isSubagentJournalReport(valid)).toBe(true)
  })

  it('domain 落两域词表外拒绝', () => {
    expect(isSubagentJournalReport({ ...valid, domain: 'other' })).toBe(false)
    expect(isSubagentJournalReport({ ...valid, domain: undefined })).toBe(false)
  })

  it('fileKey 缺失 / 空串拒绝', () => {
    expect(isSubagentJournalReport({ ...valid, fileKey: '' })).toBe(false)
    const { fileKey: _omit, ...noFileKey } = valid
    expect(isSubagentJournalReport(noFileKey)).toBe(false)
  })

  it('events 缺失 / 非数组拒绝', () => {
    expect(isSubagentJournalReport({ ...valid, events: undefined })).toBe(false)
    expect(isSubagentJournalReport({ ...valid, events: {} })).toBe(false)
  })

  it('events 内事件信封非法拒绝（逐条过守卫）', () => {
    expect(isSubagentJournalReport({ ...valid, events: [{ type: '', ts: 1 }] })).toBe(false)
    expect(isSubagentJournalReport({ ...valid, events: [{ type: 'x' }] })).toBe(false)
    expect(isSubagentJournalReport({ ...valid, events: [{ type: 'x', ts: '1' }] })).toBe(false)
    expect(isSubagentJournalReport({ ...valid, events: ['x'] })).toBe(false)
  })

  it('seq 非正安全整数拒绝；正整数放行', () => {
    expect(isSubagentJournalReport({ ...valid, events: [{ type: 'x', ts: 1, seq: 0 }] })).toBe(false)
    expect(isSubagentJournalReport({ ...valid, events: [{ type: 'x', ts: 1, seq: -1 }] })).toBe(false)
    expect(isSubagentJournalReport({ ...valid, events: [{ type: 'x', ts: 1, seq: 1.5 }] })).toBe(false)
    expect(isSubagentJournalReport({ ...valid, events: [{ type: 'x', ts: 1, seq: '1' }] })).toBe(false)
    expect(
      isSubagentJournalReport({ ...valid, events: [{ type: 'x', ts: 1, seq: 3 }] }),
    ).toBe(true)
  })

  it('emittedAt 缺失 / 非数字拒绝', () => {
    expect(isSubagentJournalReport({ ...valid, emittedAt: undefined })).toBe(false)
    expect(isSubagentJournalReport({ ...valid, emittedAt: '1000' })).toBe(false)
  })

  it('sessionId 非字符串拒绝；非对象输入拒绝', () => {
    expect(isSubagentJournalReport({ ...valid, sessionId: 7 })).toBe(false)
    expect(isSubagentJournalReport(null)).toBe(false)
    expect(isSubagentJournalReport('frame')).toBe(false)
    expect(isSubagentJournalReport([valid])).toBe(false)
  })
})

describe('JOURNAL_REPORT_ACK 确认回包', () => {
  it('精确值 = {"ack":true}（runtime fold 应用后 resolve，漂移即全部上报误判失败）', () => {
    expect(JOURNAL_REPORT_ACK).toBe('{"ack":true}')
  })

  it('isJournalReportAck 精确匹配，其余值拒绝（写侧非本字符串即未确认）', () => {
    expect(isJournalReportAck('{"ack":true}')).toBe(true)
    expect(isJournalReportAck(undefined)).toBe(false)
    expect(isJournalReportAck(null)).toBe(false)
    expect(isJournalReportAck('{"ack":false}')).toBe(false)
    expect(isJournalReportAck('')).toBe(false)
  })
})
