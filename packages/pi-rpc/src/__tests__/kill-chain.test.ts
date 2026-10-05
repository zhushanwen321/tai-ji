// src/__tests__/kill-chain.test.ts
//
// 杀链测试：SIGKILL 直杀 + 立即 resolve（exit 收尾钩子异步执行）。
// fake child 记录信号序列（KillableChild 结构子集注入）。
//
// 退役登记（ADR-0122 防御机制清查）：grace 优雅退出等待窗（SIGCONT → SIGTERM →
// grace → SIGKILL 阶梯）已删除——用例随机制退役，现契约 = SIGKILL 直杀。

import { describe, expect, it, vi } from 'vitest'

import { killPiProcess } from '../kill-chain.ts'
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
    pid: 4321,
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

describe('killPiProcess', () => {
  it('SIGKILL 直杀：发信号后立即 resolve（不等收尸）', async () => {
    const child = makeFakeChild()
    await expect(killPiProcess(child)).resolves.toBeUndefined()
    expect(child.signals).toEqual(['SIGKILL'])
  })

  it('exit 到达：onExit 收尾钩子被调（resolve 已先行）', async () => {
    const child = makeFakeChild()
    const onExit = vi.fn()
    await killPiProcess(child, { onExit })
    expect(onExit).not.toHaveBeenCalled()
    child.emitExit()
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('已退进程（exitCode 非 null）→ 前置短路零信号（K2：幂等 no-op，不抛、可重复）', async () => {
    const child = makeFakeChild({ exitCode: 0 })
    await killPiProcess(child)
    await killPiProcess(child) // 可重复
    expect(child.signals).toEqual([])
  })

  it('被信号杀死（signalCode 非 null）→ 前置短路零信号', async () => {
    const child = makeFakeChild({ signalCode: 'SIGKILL' })
    await killPiProcess(child)
    expect(child.signals).toEqual([])
  })

  it('无 exitCode/signalCode 字段的 fake（undefined）→ 视为存活，正常发信号', async () => {
    const child = makeFakeChild()
    await expect(killPiProcess(child)).resolves.toBeUndefined()
    expect(child.signals).toEqual(['SIGKILL'])
  })

  it('kill 抛错（进程恰在检查与 kill 之间自退）→ 吞掉不 reject，promise 照常 resolve', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const child = makeFakeChild()
      child.kill = (signal?: NodeJS.Signals | number) => {
        child.signals.push(String(signal))
        throw new Error('kill EPERM')
      }
      await expect(killPiProcess(child)).resolves.toBeUndefined()
      expect(child.signals).toEqual(['SIGKILL'])
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[rpc] SIGKILL on exited/invalid process (pid: 4321)'),
      )
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('kill EPERM'))
    } finally {
      warn.mockRestore()
    }
  })
})
