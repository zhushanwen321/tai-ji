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

function makeFakeChild(): FakeChild {
  const signals: string[] = []
  let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  const child: FakeChild = {
    signals,
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
})
