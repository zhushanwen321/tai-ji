import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeSubagentStatus } from '../src/services/session/subagent-status.js'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * [two-state-convergence U6/D5] 契约收窄后归一器：两态直出 + legacy 值展示位合成。
 * 断言锚 = D5 归一映射表（done→idle+stopReason:'completed' / failed|crashed→idle+
 * stopReason:'failed' / cancelled→idle+stopReason:'cancelled' / closed→idle+
 * closedReason 保留 + deriveClosedDisplay 派生 stopReason）+ 第五归一（running &&
 * resumable===true → idle，存量桥接形态）。
 */
describe('normalizeSubagentStatus（[U6] 两态直出 + legacy 展示位合成）', () => {
  it('done / completed / success → idle + stopReason:completed + one-shot 形态位合成（§3.4 第 9 行「绿」的判据承载）', () => {
    for (const raw of ['done', 'completed', 'success']) {
      expect(normalizeSubagentStatus(raw), raw).toEqual({
        status: 'idle',
        derivedStopReason: 'completed',
        derivedChatMode: false,
      })
    }
  })

  it('failed / error / crashed → idle + stopReason:failed（crashed 同异常语义，D5 映射）', () => {
    for (const raw of ['failed', 'error', 'crashed']) {
      expect(normalizeSubagentStatus(raw), raw).toEqual({
        status: 'idle',
        derivedStopReason: 'failed',
      })
    }
  })

  it('cancelled / canceled → idle + stopReason:cancelled（interrupted 族灰点判据词）', () => {
    for (const raw of ['cancelled', 'canceled']) {
      expect(normalizeSubagentStatus(raw), raw).toEqual({
        status: 'idle',
        derivedStopReason: 'cancelled',
      })
    }
  })

  it('closed → idle + closedReason 保留 + deriveClosedDisplay 派生 stopReason（cancelled→cancelled）', () => {
    expect(
      normalizeSubagentStatus('closed', { closedReason: 'cancelled', error: 'aborted' }),
    ).toEqual({
      status: 'idle',
      derivedStopReason: 'cancelled',
      derivedClosedReason: 'cancelled',
    })
  })

  it('closed（gc + error）→ 派生 failed（deriveClosedDisplay gc+error → failed 映射，红点等价）', () => {
    expect(
      normalizeSubagentStatus('closed', { closedReason: 'gc', error: 'Model timeout' }),
    ).toEqual({
      status: 'idle',
      derivedStopReason: 'failed',
      derivedClosedReason: 'gc',
    })
  })

  it('closed（级联关闭，无 error）→ 派生 completed + one-shot 形态位（deriveClosedDisplay done → 绿点等价）', () => {
    expect(
      normalizeSubagentStatus('closed', { closedReason: 'parent-fork', error: 'closed due to parent-fork' }),
    ).toEqual({
      status: 'idle',
      derivedStopReason: 'completed',
      derivedClosedReason: 'parent-fork',
      derivedChatMode: false,
    })
  })

  it('running / pending / active → running（无 resumable 上下文）', () => {
    for (const raw of ['running', 'pending', 'active']) {
      expect(normalizeSubagentStatus(raw), raw).toEqual({ status: 'running' })
    }
  })

  it('[U6/D5 第五归一] running + resumable=true → idle（存量桥接形态——§3.4 第 2-5 行，不设 result 条件）', () => {
    expect(normalizeSubagentStatus('running', { resumable: true })).toEqual({ status: 'idle' })
    expect(normalizeSubagentStatus('pending', { resumable: true })).toEqual({ status: 'idle' })
    // resumable 非 true（含缺省 / U5 后新 entry 无此字段）不触发归一
    expect(normalizeSubagentStatus('running', { resumable: false })).toEqual({ status: 'running' })
    expect(normalizeSubagentStatus('running', {})).toEqual({ status: 'running' })
  })

  it('idle → idle（两态新词直投：无任务在飞可续聊）', () => {
    expect(normalizeSubagentStatus('idle')).toEqual({ status: 'idle' })
  })

  it('undefined / 空串 → running（无状态信息，保持初始运行态）', () => {
    expect(normalizeSubagentStatus(undefined)).toEqual({ status: 'running' })
    expect(normalizeSubagentStatus('')).toEqual({ status: 'running' })
  })

  it('未知值 → idle（非占用方向兜底，不把已结束记录翻回运行中；[U6] 兜底词随收窄改 idle）', () => {
    expect(normalizeSubagentStatus('unknown')).toEqual({ status: 'idle' })
    expect(normalizeSubagentStatus('whatever')).toEqual({ status: 'idle' })
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
