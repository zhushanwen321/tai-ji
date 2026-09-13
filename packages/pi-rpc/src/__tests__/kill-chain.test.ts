// src/__tests__/kill-chain.test.ts
//
// 杀链顺序测试：SIGCONT → SIGTERM → grace 内 exit / grace 超时 SIGKILL 升级。
// fake child 记录信号序列（KillableChild 结构子集注入）。

import { describe, expect, it, vi } from 'vitest'

import { killPiProcess, DEFAULT_PI_KILL_GRACE_MS } from '../kill-chain.ts'
import type { KillableChild } from '../kill-chain.ts'

interface FakeChild extends KillableChild {
  signals: string[]
  /** 模拟进程退出：触发已注册的 exit listener。 */
  emitExit(): void
}

function makeFakeChild(overrides?: { exitCode?: number | null; signalCode?: string | null }): FakeChild {
  const signals: string[] = []
  let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  const child: FakeChild = {
    signals,
    ...(overrides?.exitCode !== undefined ? { exitCode: overrides.exitCode } : {}),
    ...(overrides?.signalCode !== undefined ? { signalCode: overrides.signalCode } : {}),
    kill(signal?: NodeJS.Signals | number) {
      signals.push(String(signal))
      return true
    },
    on(_event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) {
      exitListener = listener
      return child
    },
    emitExit() {
      exitListener?.(0, null)
      exitListener = undefined
    },
  }
  return child
}

/**
 * stub setTimeout 并跟踪各 timer 的 unref 调用（Node 运行时 timer 是 Timeout 对象，
 * DOM lib 类型面是 number——经 unknown 双重转换后 spyOn）。返回 unref 计数数组；
 * 调用方 finally 里 vi.unstubAllGlobals() 复原。
 */
function trackTimerUnrefs(): string[] {
  const unrefCalls: string[] = []
  const originalSetTimeout = globalThis.setTimeout
  vi.stubGlobal('setTimeout', ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const timer = originalSetTimeout(handler, timeout, ...(args as [])) as unknown as NodeJS.Timeout
    const spy = vi.spyOn(timer, 'unref')
    spy.mockImplementation(() => {
      unrefCalls.push('unref')
      return timer
    })
    return timer as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof globalThis.setTimeout)
  return unrefCalls
}

describe('killPiProcess', () => {
  it('缺省 grace = 2s（runtime KILL_TIMEOUT_MS 等值）', () => {
    expect(DEFAULT_PI_KILL_GRACE_MS).toBe(2_000)
  })

  it('杀链顺序：立即 SIGCONT → SIGTERM（SIGCONT 前置唤醒冻结形态）', async () => {
    const child = makeFakeChild()
    const done = killPiProcess(child, { graceMs: 50 })
    expect(child.signals).toEqual(['SIGCONT', 'SIGTERM'])
    child.emitExit()
    await done
  })

  it('grace 内 exit：无 SIGKILL，onExit 收尾钩子被调，promise resolve', async () => {
    const child = makeFakeChild()
    const onExit = vi.fn()
    const done = killPiProcess(child, { graceMs: 10_000, onExit })
    child.emitExit()
    await done
    expect(child.signals).toEqual(['SIGCONT', 'SIGTERM'])
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('grace 超时：onEscalate warn + SIGKILL + resolve（不等收尸）', async () => {
    const child = makeFakeChild()
    const onEscalate = vi.fn()
    const done = killPiProcess(child, { graceMs: 15, onEscalate })
    await done
    expect(child.signals).toEqual(['SIGCONT', 'SIGTERM', 'SIGKILL'])
    expect(onEscalate).toHaveBeenCalledTimes(1)
  })

  it('grace 窗口边界：恰在超时前 exit → 无 SIGKILL', async () => {
    const child = makeFakeChild()
    const done = killPiProcess(child, { graceMs: 60 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    child.emitExit()
    await done
    expect(child.signals).toEqual(['SIGCONT', 'SIGTERM'])
  })

  it('unrefTimers: true → grace timer 被 unref（dispose 路径不挂进程退出）', async () => {
    const unrefCalls = trackTimerUnrefs()
    try {
      const child = makeFakeChild()
      const done = killPiProcess(child, { graceMs: 20, unrefTimers: true })
      child.emitExit()
      await done
      expect(unrefCalls).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('unrefTimers 缺省（不传）→ grace timer 保持 ref\'d（runtime 主链路现状）', async () => {
    const unrefCalls = trackTimerUnrefs()
    try {
      const child = makeFakeChild()
      const done = killPiProcess(child, { graceMs: 20 })
      child.emitExit()
      await done
      expect(unrefCalls).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('已退进程（exitCode 非 null）→ 前置短路零信号（K2：幂等 no-op，不抛、可重复）', async () => {
    const child = makeFakeChild({ exitCode: 0 })
    await killPiProcess(child, { graceMs: 20 })
    await killPiProcess(child, { graceMs: 20 }) // 可重复
    expect(child.signals).toEqual([])
  })

  it('被信号杀死（signalCode 非 null）→ 前置短路零信号', async () => {
    const child = makeFakeChild({ signalCode: 'SIGKILL' })
    await killPiProcess(child, { graceMs: 20 })
    expect(child.signals).toEqual([])
  })

  it('无 exitCode/signalCode 字段的 fake（undefined）→ 视为存活，正常发信号', async () => {
    const child = makeFakeChild()
    const done = killPiProcess(child, { graceMs: 50 })
    expect(child.signals).toEqual(['SIGCONT', 'SIGTERM'])
    child.emitExit()
    await done
  })
})
