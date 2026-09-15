import { describe, expect, it } from 'vitest'

import { snapshotToTask, toTaskSnapshot } from '../types.js'
import type { ScheduledTask, TaskSnapshot } from '../types.js'

/**
 * B2 转换器收敛（ext-simplify-17）等价守卫：toTaskSnapshot canonical 取解构式，
 * 替换 importer 旧显式 14 字段式——期望值按旧显式式的输出形状逐字段锚定
 * （toEqual 严格比较键集合，解构式多带/漏带键即红），防字段演进中静默漂移。
 * 既有间接断言（importer/runtime 测试的 objectContaining）不覆盖键集合精确性与
 * 可选字段传递，此处补直接等价证据。
 */

/** 全字段 ScheduledTask（含全部可选字段 + 两个运行时字段 + 非空 history）。 */
function fullTask(): ScheduledTask {
  return {
    id: 'abcd1234',
    name: 'test task',
    prompt: 'do something',
    kind: 'recurring',
    schedule: { mode: 'interval', intervalMs: 60000 },
    enabled: true,
    createdAt: 1000,
    nextRunAt: 2000,
    expiresAt: 9999,
    runCount: 3,
    lastRunAt: 1500,
    lastStatus: 'success',
    lastError: 'prev error',
    history: [
      { at: 1400, status: 'failed' },
      { at: 1500, status: 'success' },
    ],
    ownerSessionFile: '/x/sess.json',
    pending: true,
  }
}

/**
 * fullTask 对应的期望快照——字面量逐字段写出（不用解构从 fullTask 推导，
 * 避免期望值与被测实现共享同一剥离逻辑而失去独立性），形状 = 旧显式式输出。
 */
function expectedSnapshot(): TaskSnapshot {
  return {
    id: 'abcd1234',
    name: 'test task',
    prompt: 'do something',
    kind: 'recurring',
    schedule: { mode: 'interval', intervalMs: 60000 },
    enabled: true,
    createdAt: 1000,
    nextRunAt: 2000,
    expiresAt: 9999,
    runCount: 3,
    lastRunAt: 1500,
    lastStatus: 'success',
    lastError: 'prev error',
    history: [
      { at: 1400, status: 'failed' },
      { at: 1500, status: 'success' },
    ],
  }
}

describe('toTaskSnapshot / snapshotToTask（B2 收敛等价）', () => {
  it('toTaskSnapshot: 全字段 task → 恰好 14 字段快照（剥离 ownerSessionFile/pending，值逐一相等）', () => {
    expect(toTaskSnapshot(fullTask())).toEqual(expectedSnapshot())
  })

  it('toTaskSnapshot: history 是数组拷贝——task 后续 push/shift 不污染已产出的快照', () => {
    const task = fullTask()
    const snapshot = toTaskSnapshot(task)
    expect(snapshot.history).not.toBe(task.history)
    task.history.push({ at: 9999, status: 'failed' })
    task.history.shift()
    expect(snapshot.history).toEqual([
      { at: 1400, status: 'failed' },
      { at: 1500, status: 'success' },
    ])
  })

  it('snapshotToTask: 快照 → 恢复 task 不含运行时字段、字段逐一相等、history 逐项拷贝', () => {
    const source = expectedSnapshot()
    const task = snapshotToTask(source)
    expect(task).toEqual(source)
    expect('ownerSessionFile' in task).toBe(false)
    expect('pending' in task).toBe(false)
    // 逐项深拷贝：恢复的 task 后续 mutate 不污染快照（数组与元素均独立）
    expect(task.history).not.toBe(source.history)
    expect(task.history[0]).not.toBe(source.history[0])
  })
})
