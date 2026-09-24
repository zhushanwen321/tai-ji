/**
 * 乐观更新协议单测（C5 归一：回滚语义唯一 = 失败回滚后 rethrow）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/core && npx vitest run src/foundation/optimistic-update.test.ts
 *
 * 覆盖（协议行为矩阵）：
 * - apply 先于 commit 生效（乐观可见性）
 * - commit 成功：透传 resolve 值、不回滚
 * - commit 失败：还原快照 / 执行逆操作后 rethrow（原错误对象）
 * - 异步 rollback 被 await 后再 rethrow
 * - 值单元形态：快照在写前捕获、失败还原旧值
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { runOptimisticUpdate, optimisticUpdate, refCell } from './optimistic-update'

describe('runOptimisticUpdate', () => {
  it('apply 先于 commit 生效 + 成功透传 resolve 值', async () => {
    const state = { value: 'old' }
    const order: string[] = []
    const result = await runOptimisticUpdate({
      apply: () => {
        order.push('apply')
        state.value = 'new'
      },
      rollback: () => {
        order.push('rollback')
      },
      commit: async () => {
        order.push('commit')
        expect(state.value).toBe('new') // 乐观值在 commit 时已可见
        return 42
      },
    })
    expect(result).toBe(42)
    expect(order).toEqual(['apply', 'commit'])
  })

  it('commit 失败 → 执行 rollback 后 rethrow 原错误', async () => {
    const state = { value: 'old' }
    const failure = new Error('disk full')
    await expect(
      runOptimisticUpdate({
        apply: () => {
          state.value = 'new'
        },
        rollback: () => {
          state.value = 'old'
        },
        commit: async () => {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
    expect(state.value).toBe('old')
  })

  it('异步 rollback 被 await 完成后才 rethrow', async () => {
    const state = { value: 'new' }
    let rollbackDone = false
    await expect(
      runOptimisticUpdate({
        apply: () => {},
        rollback: async () => {
          await Promise.resolve()
          rollbackDone = true
          state.value = 'restored'
        },
        commit: async () => {
          throw new Error('rpc rejected')
        },
      }),
    ).rejects.toThrow('rpc rejected')
    expect(rollbackDone).toBe(true)
    expect(state.value).toBe('restored')
  })
})

describe('optimisticUpdate（值单元形态）', () => {
  it('快照写前捕获 + 成功保留新值', async () => {
    const cell = ref('old')
    const result = await optimisticUpdate(refCell(cell), 'new', async (applied) => {
      expect(applied).toBe('new')
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(cell.value).toBe('new')
  })

  it('失败 → 还原写前快照 + rethrow', async () => {
    const cell = ref('old')
    await expect(
      optimisticUpdate(refCell(cell), 'new', async () => {
        throw new Error('quota exceeded')
      }),
    ).rejects.toThrow('quota exceeded')
    expect(cell.value).toBe('old')
  })

  it('vi.fn 断言面：commit 只调一次、rollback 不在成功路径调用', async () => {
    const commit = vi.fn(async () => 'done')
    const rollback = vi.fn()
    const state = { value: 0 }
    await runOptimisticUpdate({
      apply: () => {
        state.value = 1
      },
      rollback,
      commit,
    })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(rollback).not.toHaveBeenCalled()
  })
})
