/**
 * warn-once 去重集单测（code-harden RT-5#6）。
 *
 * 三处 session 读侧 extractor（segments sidecar / workflow state 文件 / subagent 目录
 * 扫描）的降级 catch 共用本 helper——按 key（文件路径/目录）去重，防扫描热路径刷屏。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/utils/__tests__/warn-once.test.ts
 */
import { describe, it, expect, vi, type MockInstance, beforeEach } from 'vitest'
import { warnOnce, _resetWarnOnceForTest } from '../warn-once.js'

let warnSpy: MockInstance<typeof console.warn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  warnSpy.mockClear() // 重复 spyOn 返回同一 spy，清累计调用
  _resetWarnOnceForTest()
})

describe('warnOnce（RT-5#6）', () => {
  it('同 key 只出声一次，不同 key 各出声一次', () => {
    warnOnce('/a/segments.json', 'msg-a')
    warnOnce('/a/segments.json', 'msg-a')
    warnOnce('/b/state.jsonl', 'msg-b')
    expect(warnSpy).toHaveBeenCalledTimes(2)
    expect(String(warnSpy.mock.calls[0]![0])).toBe('msg-a')
    expect(String(warnSpy.mock.calls[1]![0])).toBe('msg-b')
  })

  it('detail 参数透传（原始错误消息随行）', () => {
    warnOnce('/a/state.jsonl', 'read failed', 'EACCES: permission denied')
    expect(warnSpy.mock.calls[0]![1]).toBe('EACCES: permission denied')
  })

  it('reset 后同 key 可再次出声（测试隔离通道有效性）', () => {
    warnOnce('/a/segments.json', 'msg')
    _resetWarnOnceForTest()
    warnOnce('/a/segments.json', 'msg')
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })
})
