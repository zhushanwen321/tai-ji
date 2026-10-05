/**
 * useSessionScopedState 只读分区存在性查询 hasPartition 单测（remote-use U6 / D5 exited 分区清理段）。
 *
 * hasPartition 是「先查后清」类重置动作的前置检查原语（与 isDeleted 同风格的只读导出）：
 * 消费方 = ui DialogRequestQueue.resetFor（session.exited 分通道重置）——updateFor 经
 * getOrCreatePartition 惰性建分区，照搬会把清理动作本身变成常驻空分区的制造点（无清理
 * 路径，与 S7 内存有界目标相悖），故 resetFor 先查后清。本文件锁原语语义；resetFor 的
 * 队列级行为断言在 packages/ui（dialog-request-queue.test.ts TC-12~TC-14）。
 *
 * 与既有 foundation/use-session-scoped-state.test.ts（W1 工厂契约全量）分文件：本文件
 * 只覆盖 U6 新增导出，不重复既有断言面。
 *
 * 运行：cd packages/core && npx vitest run src/foundation/__tests__/use-session-scoped-state.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { useSessionScopedState } from '../use-session-scoped-state'

/** 在独立 effectScope 内运行 composable，测试后 dispose 模拟卸载（既有测试同款 harness） */
function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

describe('U6 hasPartition: 只读分区存在性查询', () => {
  it('分区未建立 → false；经 updateFor 写入建立后 → true', () => {
    const { result } = runWithScope(() =>
      useSessionScopedState(ref<string | null>('A'), () => ({ v: 0 })),
    )

    expect(result.hasPartition('A')).toBe(false)
    result.updateFor('A', (s) => { s.v = 1 })
    expect(result.hasPartition('A')).toBe(true)
  })

  it('current 读取建立的分区同样计数（同一份分区表，无第二口径）', () => {
    const { result } = runWithScope(() =>
      useSessionScopedState(ref<string | null>('read-sid'), () => ({ v: 0 })),
    )

    expect(result.hasPartition('read-sid')).toBe(false)
    void result.current.value
    expect(result.hasPartition('read-sid')).toBe(true)
  })

  it('只读零副作用：对不存在 sid 查询不惰性建分区（init 不被调）', () => {
    const init = vi.fn(() => ({ v: 0 }))
    const { result } = runWithScope(() =>
      useSessionScopedState(ref<string | null>(null), init),
    )

    expect(result.hasPartition('ghost')).toBe(false)
    expect(result.hasPartition('another-ghost')).toBe(false)
    expect(init).not.toHaveBeenCalled()
  })

  it('cleanup 后 → false；同 sid 重建（current 读出列）后 → true（生命周期与分区表同步）', () => {
    const { result } = runWithScope(() =>
      useSessionScopedState(ref<string | null>('cycle'), () => ({ v: 0 })),
    )

    result.updateFor('cycle', (s) => { s.v = 1 })
    expect(result.hasPartition('cycle')).toBe(true)

    result.cleanup('cycle')
    expect(result.hasPartition('cycle')).toBe(false)

    void result.current.value // current 路径重建（出列点）
    expect(result.hasPartition('cycle')).toBe(true)
  })

  it('先查后清范式（resetFor 前置检查语义）：查询为 false 时跳过写入则不建分区', () => {
    const init = vi.fn(() => ({ v: 0 }))
    const { result } = runWithScope(() =>
      useSessionScopedState(ref<string | null>(null), init),
    )

    // resetFor 的实现形态：hasPartition 前置检查 + 条件写入——对不存在的分区整体跳过
    if (result.hasPartition('no-reset-target')) {
      result.updateFor('no-reset-target', (s) => { s.v = 99 })
    }
    expect(init).not.toHaveBeenCalled() // 清理动作未制造常驻空分区
    expect(result.hasPartition('no-reset-target')).toBe(false)
  })
})
