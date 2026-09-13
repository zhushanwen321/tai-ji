import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeSubagentStatus } from '../src/services/session/subagent-status.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('normalizeSubagentStatus', () => {
  it('done / completed / success → done', () => {
    expect(normalizeSubagentStatus('done')).toBe('done')
    expect(normalizeSubagentStatus('completed')).toBe('done')
    expect(normalizeSubagentStatus('success')).toBe('done')
  })

  it('failed / error → failed', () => {
    expect(normalizeSubagentStatus('failed')).toBe('failed')
    expect(normalizeSubagentStatus('error')).toBe('failed')
  })

  it('cancelled / canceled → cancelled', () => {
    expect(normalizeSubagentStatus('cancelled')).toBe('cancelled')
    expect(normalizeSubagentStatus('canceled')).toBe('cancelled')
  })

  it('crashed → crashed', () => {
    expect(normalizeSubagentStatus('crashed')).toBe('crashed')
  })

  it('running / pending / active → running', () => {
    expect(normalizeSubagentStatus('running')).toBe('running')
    expect(normalizeSubagentStatus('pending')).toBe('running')
    expect(normalizeSubagentStatus('active')).toBe('running')
  })

  it('closed → closed', () => {
    expect(normalizeSubagentStatus('closed')).toBe('closed')
  })

  it('undefined / 空串 → running（无状态信息，保持初始运行态）', () => {
    expect(normalizeSubagentStatus(undefined)).toBe('running')
    expect(normalizeSubagentStatus('')).toBe('running')
  })

  it('idle → idle（U8 两态新词直投：无任务在飞可续聊）', () => {
    // [U8 / 永久会话模型 §3.2.2] entry 写面 U2 起产出 idle——此前被当未知值落 closed
    // 兜底（「空闲」被误读成终态），U8 投影面切直投。不再触发 unknown warn（下方
    // warn 用例反向钉住）。
    expect(normalizeSubagentStatus('idle')).toBe('idle')
  })

  it('未知值 → closed（终态方向兜底，不把已结束记录翻回运行中）', () => {
    expect(normalizeSubagentStatus('unknown')).toBe('closed')
    expect(normalizeSubagentStatus('whatever')).toBe('closed')
  })

  it('未知状态触发 console.warn 兜底告警（idle 属已知两态词，不触发）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    normalizeSubagentStatus('future-status')
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[normalizeSubagentStatus] unknown status'),
    )
    // 已知状态不触发 warn
    warnSpy.mockClear()
    normalizeSubagentStatus('done')
    normalizeSubagentStatus('idle')
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
