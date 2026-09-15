/**
 * useMemoryPressure 单元测试（crash-forensics-and-watchdog §3.3 D4，u6 验收 A5）。
 *
 * 覆盖：
 * - 通知消费：watchdog:memoryPressure 到达 → level 更新 + 收紧动作被调用（payload 透传）。
 * - critical 档：level='critical' + 动作收到 ('critical', payload)。
 * - 防重复注册（AGENTS 规则 2 / refCount）：多实例共享单条物理订阅——两次 useMemoryPressure()
 *   后单次 dispatch 只触发一次收紧动作。
 * - 卸载退订：effectScope stop（最后一个消费者卸载）后 dispatch 不再触发。
 * - 默认收紧动作：真实 chat store 上 evictIfNeeded 被调用（领地登记的领地内最大安全动作）。
 * - 动作抛错不逃逸（best-effort：降级动作失败不影响订阅链与状态更新）。
 *
 * 驱动方式：直接 dispatchGlobal（core events 层单例注册表，route-inbound 对无 sid 消息
 * 走 global 通道——生产 runtime broadcast 帧的到达形态等价）。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/__tests__/useMemoryPressure.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { dispatchGlobal } from '@taiji/core/transport/api'
import type { ServerMessage, WatchdogMemoryPressurePayload } from '@taiji/shared'
import {
  useMemoryPressure,
  LRU_RELIEF_MAX_SESSIONS,
  _setMemoryReliefActionForTest,
  _resetMemoryPressureForTest,
} from '../useMemoryPressure'
import { getLruMaxSessions } from '@taiji/core'
import { useChatStore } from '@/stores/chat'

/** 构造 watchdog:memoryPressure 帧（payload 契约 = WatchdogMemoryPressurePayload）。 */
function pressureMsg(
  level: 'warn' | 'critical',
  overrides: Partial<WatchdogMemoryPressurePayload> = {},
): ServerMessage<'watchdog:memoryPressure'> {
  return {
    type: 'watchdog:memoryPressure',
    payload: {
      level,
      heapUsed: 700_000_000,
      heapSizeLimit: 1_000_000_000,
      usedPercent: 70,
      warnPercent: 70,
      criticalPercent: 85,
      ...overrides,
    },
  }
}

describe('useMemoryPressure（A5 通知消费断言）', () => {
  beforeEach(() => {
    _resetMemoryPressureForTest()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    // 复位 spy 注入 + 状态 + 强制退订（refCount/订阅表清零，测试间隔离）
    _resetMemoryPressureForTest()
  })

  it('warn 通知到达 → level 更新 + 收紧动作被调用（level/payload 透传）', () => {
    const action = vi.fn()
    _setMemoryReliefActionForTest(action)
    const scope = effectScope()
    const state = scope.run(() => useMemoryPressure())
    expect(state?.level.value).toBe('normal')
    dispatchGlobal(pressureMsg('warn'))
    expect(state?.level.value).toBe('warn')
    expect(state?.lastPayload.value?.heapUsed).toBe(700_000_000)
    expect(action).toHaveBeenCalledTimes(1)
    expect(action).toHaveBeenCalledWith('warn', expect.objectContaining({ level: 'warn', usedPercent: 70 }))
    scope.stop()
  })

  it('critical 通知 → level=critical + 动作收到 critical 档', () => {
    const action = vi.fn()
    _setMemoryReliefActionForTest(action)
    const scope = effectScope()
    const state = scope.run(() => useMemoryPressure())
    dispatchGlobal(pressureMsg('critical', { usedPercent: 92, heapUsed: 920_000_000 }))
    expect(state?.level.value).toBe('critical')
    expect(action).toHaveBeenCalledWith('critical', expect.objectContaining({ usedPercent: 92 }))
    scope.stop()
  })

  it('防重复注册（refCount）：两个消费者实例只开一条物理订阅——单次 dispatch 动作只执行一次', () => {
    const action = vi.fn()
    _setMemoryReliefActionForTest(action)
    const scopeA = effectScope()
    scopeA.run(() => useMemoryPressure())
    const scopeB = effectScope()
    scopeB.run(() => useMemoryPressure())
    dispatchGlobal(pressureMsg('warn'))
    expect(action).toHaveBeenCalledTimes(1) // 非 2：多实例共享单条物理订阅
    scopeA.stop()
    scopeB.stop()
  })

  it('卸载退订：最后一个消费者 scope stop 后 dispatch 不再触发动作', () => {
    const action = vi.fn()
    _setMemoryReliefActionForTest(action)
    const scope = effectScope()
    scope.run(() => useMemoryPressure())
    dispatchGlobal(pressureMsg('warn'))
    expect(action).toHaveBeenCalledTimes(1)
    scope.stop() // refCount 归零 → 物理退订
    dispatchGlobal(pressureMsg('warn'))
    expect(action).toHaveBeenCalledTimes(1) // 退订后不再消费
  })

  it('部分卸载：两消费者仅其一卸载时订阅保持（refCount 递减不归零）', () => {
    const action = vi.fn()
    _setMemoryReliefActionForTest(action)
    const scopeA = effectScope()
    scopeA.run(() => useMemoryPressure())
    const scopeB = effectScope()
    scopeB.run(() => useMemoryPressure())
    scopeA.stop()
    dispatchGlobal(pressureMsg('warn'))
    expect(action).toHaveBeenCalledTimes(1) // scopeB 仍在，消费继续
    scopeB.stop()
    dispatchGlobal(pressureMsg('warn'))
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('默认收紧动作（#28②）：压窗到 LRU_RELIEF_MAX_SESSIONS(4) + evictIfNeeded 驱逐一轮', () => {
    const store = useChatStore()
    const evictSpy = vi.spyOn(store, 'evictIfNeeded')
    const scope = effectScope()
    scope.run(() => useMemoryPressure())
    dispatchGlobal(pressureMsg('warn'))
    expect(evictSpy).toHaveBeenCalledTimes(1)
    // 压窗生效：core lru 生效上限从默认 8 收到 4（#28② 的「真收紧」语义）
    expect(getLruMaxSessions()).toBe(LRU_RELIEF_MAX_SESSIONS)
    scope.stop()
  })

  it('恢复语义（D4 未指明，登记裁决）：压窗不自动恢复默认（协议 normal 不广播，无消退信号）', () => {
    const scope = effectScope()
    scope.run(() => useMemoryPressure())
    dispatchGlobal(pressureMsg('warn'))
    expect(getLruMaxSessions()).toBe(LRU_RELIEF_MAX_SESSIONS)
    // 不存在「消退」帧；后续任意帧（仍为压力态）不回弹默认
    dispatchGlobal(pressureMsg('warn'))
    expect(getLruMaxSessions()).toBe(LRU_RELIEF_MAX_SESSIONS)
    scope.stop()
  })

  it('收紧动作抛错不逃逸：状态仍更新、订阅链不破坏（best-effort 降级）', () => {
    _setMemoryReliefActionForTest(() => {
      throw new Error('relief action boom')
    })
    const scope = effectScope()
    const state = scope.run(() => useMemoryPressure())
    expect(() => dispatchGlobal(pressureMsg('warn'))).not.toThrow()
    expect(state?.level.value).toBe('warn') // 动作失败不影响状态更新
    // 订阅链存活：下一帧仍消费
    _setMemoryReliefActionForTest(vi.fn())
    dispatchGlobal(pressureMsg('warn'))
    expect(state?.level.value).toBe('warn')
    scope.stop()
  })
})
