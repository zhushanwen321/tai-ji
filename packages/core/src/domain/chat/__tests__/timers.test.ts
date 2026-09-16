/**
 * timers 子域独立单测（clearSessionTimer 行为锁定）。
 *
 * 历史上本文件还覆盖 initTimers streaming idle timer 三件套（arm/refresh/clear/
 * disposeAllTimers），该兜底机制已随「流式空闲超时」功能废弃整体删除。
 */
import { describe, it, expect } from 'vitest'
import { clearSessionTimer } from '../timers'

describe('clearSessionTimer — export 纯函数', () => {
  it('清指定 session 的 timer（从 Map 移除 + clearTimeout）', () => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    timers.set('s1', setTimeout(() => {}, 1000))
    timers.set('s2', setTimeout(() => {}, 1000))

    clearSessionTimer(timers, 's1')

    expect(timers.has('s1')).toBe(false)
    expect(timers.has('s2')).toBe(true) // s2 不受影响
  })

  it('幂等：清不存在的 session timer 不报错（Map 无该 key 时 no-op）', () => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    expect(() => clearSessionTimer(timers, 'ghost')).not.toThrow()
    expect(timers.size).toBe(0)
  })
})
