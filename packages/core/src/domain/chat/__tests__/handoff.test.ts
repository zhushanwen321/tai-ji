/**
 * handingOff 子域独立单测（MF-1，createHandoffController factory 行为锁定）。
 *
 * 直接调 createHandoffController() 工厂构造实例，不 mock 被测模块内部依赖。
 *
 * 覆盖分支（对应 R1 MF-1）：
 * - handingOffSessions Set 置位/复位（不可变写、per-session 隔离）
 * - ref 响应性形态
 *
 * [ADR-0122] 无墙钟兜底 timer（原 700s 超时兜底已删）：复位完全依赖事件
 * （handoffComplete / handoffAborted 广播、RPC reject catch、abort 编排），无定时器可测。
 */
import { describe, it, expect } from 'vitest'
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
