/**
 * reaper 汇总日志触发条件测试（code-harden RT-5#9）。
 *
 * 锁定：logReapSummary 的触发条件含 conservativelySkipped——只有保守跳过、无任何
 * 收殓动作的拍次也必须落日志（此前完全零记录，跳过是否在发生不可观测）。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/services/session/__tests__/background-task-reaper-summary.test.ts
 */
import { describe, it, expect, vi, type MockInstance, afterEach } from 'vitest'
import { logReapSummary, type BackgroundTaskReapResult } from '../background-task-reaper.js'

let logSpy: MockInstance<typeof console.log>

afterEach(() => {
  logSpy.mockRestore()
})

function result(partial: Partial<BackgroundTaskReapResult>): BackgroundTaskReapResult {
  return {
    scannedDirs: 0,
    ownerAliveSkipped: 0,
    killedOrphans: 0,
    finalizedOrphans: 0,
    conservativelySkipped: 0,
    staleLocksRemoved: 0,
    ...partial,
  }
}

describe('logReapSummary 触发条件（RT-5#9）', () => {
  it('只有 conservativelySkipped>0 的拍次也落日志（修复前零记录）', () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logReapSummary('startup full scan', result({ conservativelySkipped: 2 }))
    expect(logSpy).toHaveBeenCalledTimes(1)
    const msg = String(logSpy.mock.calls[0]![0])
    expect(msg).toContain('conservativelySkipped=2')
  })

  it('有收殓动作时照常落日志且含全部计数', () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logReapSummary('session reap (sessionId=s1)', result({ killedOrphans: 1, ownerAliveSkipped: 3 }))
    expect(logSpy).toHaveBeenCalledTimes(1)
    const msg = String(logSpy.mock.calls[0]![0])
    expect(msg).toContain('killed=1')
    expect(msg).toContain('ownerAliveSkipped=3')
    expect(msg).toContain('conservativelySkipped=0')
  })

  it('全零拍次不打点（无事件不刷日志）', () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logReapSummary('startup full scan', result({ scannedDirs: 5 }))
    expect(logSpy).not.toHaveBeenCalled()
  })
})
