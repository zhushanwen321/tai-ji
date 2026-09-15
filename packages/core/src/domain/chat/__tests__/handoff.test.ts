/**
 * handingOff 子域独立单测（MF-1，createHandoffController factory 行为锁定）。
 *
 * 直接调 createHandoffController() 工厂构造实例，不 mock 被测模块内部依赖。
 * timer 相关用 vi.useFakeTimers() + vi.advanceTimersByTime() 模拟 700s 超时兜底，
 * 避免真实等待触发 vitest 5s 超时。
 *
 * 覆盖分支（对应 R1 MF-1）：
 * - setHandingOff(true) 挂 700s 超时 timer
 * - 超时后自复位 setHandingOff(sid,false)
 * - clearHandingOffTimer / clearAllTimers（HMR/dispose 清理，不复位 Set）
 * - 不可变 Set 写（new Set 整体替换，原 Set 不 mutate）
 * - 多 session 隔离 + 重复 setHandingOff(true) 不泄漏旧 timer
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isProxy, isReactive, isShallow } from 'vue'
import { createHandoffController } from '../handoff'

describe('createHandoffController — handingOffSessions ref', () => {
  it('初始为空 Set，isHandingOff 恒 false', () => {
    const c = createHandoffController()
    expect(c.handingOffSessions.value).toBeInstanceOf(Set)
    expect(c.handingOffSessions.value.size).toBe(0)
    expect(c.isHandingOff('any')).toBe(false)
  })

  it('setHandingOff(true) 加入 session；setHandingOff(false) 移除', () => {
    const c = createHandoffController()
    c.setHandingOff('s1', true)
    expect(c.isHandingOff('s1')).toBe(true)
    expect(c.handingOffSessions.value.has('s1')).toBe(true)

    c.setHandingOff('s1', false)
    expect(c.isHandingOff('s1')).toBe(false)
    expect(c.handingOffSessions.value.has('s1')).toBe(false)
  })

  it('不可变 Set 写：每次 setHandingOff 整体替换 handingOffSessions.value，原 Set 不 mutate', () => {
    const c = createHandoffController()
    const initial = c.handingOffSessions.value
    c.setHandingOff('s1', true)
    const afterAdd = c.handingOffSessions.value

    // 新 Set 引用（非原地 mutate）
    expect(afterAdd).not.toBe(initial)
    // 原 Set 不被污染
    expect(initial.has('s1')).toBe(false)
    expect(afterAdd.has('s1')).toBe(true)

    const beforeRemove = c.handingOffSessions.value
    c.setHandingOff('s1', false)
    const afterRemove = c.handingOffSessions.value
    expect(afterRemove).not.toBe(beforeRemove)
    expect(beforeRemove.has('s1')).toBe(true) // 旧 Set 不变
    expect(afterRemove.has('s1')).toBe(false)
  })

  it('per-session 隔离：s1/s2 各自独立置位/复位互不影响', () => {
    const c = createHandoffController()
    c.setHandingOff('s1', true)
    c.setHandingOff('s2', true)
    expect(c.isHandingOff('s1')).toBe(true)
    expect(c.isHandingOff('s2')).toBe(true)
    expect(c.handingOffSessions.value.size).toBe(2)

    c.setHandingOff('s1', false)
    expect(c.isHandingOff('s1')).toBe(false)
    expect(c.isHandingOff('s2')).toBe(true) // s2 不受影响
  })
})

describe('createHandoffController — 700s 超时兜底 timer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('setHandingOff(true) 挂一个 timer；700s 未到不自复位', () => {
    const c = createHandoffController()
    c.setHandingOff('s1', true)
    expect(vi.getTimerCount()).toBe(1)

    // 700s - 1ms：未超时，仍 handing off
    vi.advanceTimersByTime(700_000 - 1)
    expect(c.isHandingOff('s1')).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('700s 超时后自复位 setHandingOff(sid,false)：Set 移除 + timer 清理', () => {
    const c = createHandoffController()
    c.setHandingOff('s1', true)
    expect(c.isHandingOff('s1')).toBe(true)

    vi.advanceTimersByTime(700_000) // 触发超时回调

    expect(c.isHandingOff('s1')).toBe(false) // 自复位
    expect(c.handingOffSessions.value.has('s1')).toBe(false)
    expect(vi.getTimerCount()).toBe(0) // timer 已清
  })

  it('setHandingOff(false) 提前清 timer：之后 advance 700s 不会重复回调', () => {
    const c = createHandoffController()
    c.setHandingOff('s1', true)
    expect(vi.getTimerCount()).toBe(1)

    c.setHandingOff('s1', false) // 主动复位，应清 timer
    expect(vi.getTimerCount()).toBe(0)
    expect(c.isHandingOff('s1')).toBe(false)

    // advance 超过超时阈值：不应有回调执行（已清），状态保持 false
    vi.advanceTimersByTime(700_000)
    expect(c.isHandingOff('s1')).toBe(false)
  })

  it('重复 setHandingOff(true) 不泄漏旧 timer：先清旧再挂新（同一 session 只剩 1 个 timer）', () => {
    const c = createHandoffController()
    c.setHandingOff('s1', true)
    c.setHandingOff('s1', true) // 再次 true
    expect(vi.getTimerCount()).toBe(1) // 不叠加，仍 1 个

    // advance 到「旧 timer 假想」过期点不会有副作用；新 timer 仍驱动自复位
    // 注：两个 timer 起点不同，advance 推进全部。此处验证总计数为 1（旧已清）
  })
})

describe('createHandoffController — clearHandingOffTimer / clearAllTimers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('clearHandingOffTimer(sid) 清指定 session 的 timer（不复位 Set）', () => {
    const c = createHandoffController()
    c.setHandingOff('s1', true)
    expect(vi.getTimerCount()).toBe(1)

    c.clearHandingOffTimer('s1')
    expect(vi.getTimerCount()).toBe(0)

    // Set 不复位（clearHandingOffTimer 只清 timer，不碰 handingOffSessions）
    expect(c.isHandingOff('s1')).toBe(true)

    // advance 700s：timer 已清，不会自复位
    vi.advanceTimersByTime(700_000)
    expect(c.isHandingOff('s1')).toBe(true)
  })

  it('clearHandingOffTimer 幂等：清不存在的 session timer 不报错', () => {
    const c = createHandoffController()
    expect(() => c.clearHandingOffTimer('ghost')).not.toThrow()
  })

  it('clearAllTimers 清全部 timer（HMR/store dispose），不影响 Set 状态', () => {
    const c = createHandoffController()
    c.setHandingOff('s1', true)
    c.setHandingOff('s2', true)
    expect(vi.getTimerCount()).toBe(2)

    c.clearAllTimers()
    expect(vi.getTimerCount()).toBe(0)

    // Set 状态保留（clearAllTimers 只清 timer）
    expect(c.isHandingOff('s1')).toBe(true)
    expect(c.isHandingOff('s2')).toBe(true)

    // advance 700s：无自复位回调执行
    vi.advanceTimersByTime(700_000)
    expect(c.isHandingOff('s1')).toBe(true)
    expect(c.isHandingOff('s2')).toBe(true)
  })

  it('clearAllTimers 幂等：无 timer 时 no-op', () => {
    const c = createHandoffController()
    expect(() => c.clearAllTimers()).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clearAllTimers 后可重新挂 timer（实例可复用，不卡死）', () => {
    const c = createHandoffController()
    c.setHandingOff('s1', true)
    c.clearAllTimers()

    c.setHandingOff('s1', true) // 重新挂
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(700_000)
    expect(c.isHandingOff('s1')).toBe(false) // 超时自复位正常
  })
})

describe('createHandoffController — ref 响应性', () => {
  it('handingOffSessions 是 Vue ref（响应式 ref，非 shallow ref 非 reactive proxy）', () => {
    const c = createHandoffController()
    // ref 本身有 .value，是非 proxy；.value 内部是普通 Set（非 reactive 包裹）
    // 源码用 ref<Set<string>>（深 ref），不是 shallowRef
    expect(c.handingOffSessions).toHaveProperty('value')
    // ref 对象本身不是 reactive proxy
    expect(isProxy(c.handingOffSessions)).toBe(false)
    expect(isReactive(c.handingOffSessions)).toBe(false)
    expect(isShallow(c.handingOffSessions)).toBe(false)
  })
})
