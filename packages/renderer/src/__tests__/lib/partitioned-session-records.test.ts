/**
 * partitioned-session-records 单测 —— createEmptyResultStrikeGuard strike 机制全行为直测。
 *
 * R7 归一（test-infra-source-simplify §3 R7）：subagent / workflow 两 store 的 loadXxx
 * 空结果守卫共享本模块工厂（strike 语义单源，S4 A1 迁移），strike 机制全部行为锁定在
 * 本文件——直测工厂、不 import 任何 store（无环）：
 * - 放行路径：非空结果 / 空分区（含「分区空期间不累计 strike」）
 * - strike 路径：连续空达 limit 判真实删空 / 非空打断重置 / reset() 清零 / 多 sid 独立 / limit 参数化
 * - warn 文案结构（tag/label/strike n/limit 拼接 = 工厂职责；本文件用中性 tag，
 *   store 实际接线参数文案由各 store 冒烟锁定）
 *
 * 两 store 测试只留接线冒烟（守卫经 store 真实可达 + clearSession 联动）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/lib/partitioned-session-records.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { createEmptyResultStrikeGuard } from '@/lib/partitioned-session-records'

// 阈值与两 store 接线一致（EMPTY_RESULT_STRIKE_LIMIT = 2）；tag/label 用中性值——
// 文案结构（工厂拼接职责）在此锁定，store 名与 RPC 方法名属于接线参数，不在此重复锁
const LIMIT = 2
const LOG_TAG = 'guard-test'
const FETCH_LABEL = 'loadXxx'

/** 建守卫 + 捕获 console.warn（工厂 warn 文案断言用） */
function makeGuard(limit = LIMIT) {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  return { guard: createEmptyResultStrikeGuard(limit, LOG_TAG, FETCH_LABEL), warnSpy }
}

describe('createEmptyResultStrikeGuard — 放行路径（false = 允许覆盖，不告警）', () => {
  let warnSpy: MockInstance

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('非空结果 → false，不进 strike 计数不告警', () => {
    const guard = createEmptyResultStrikeGuard(LIMIT, LOG_TAG, FETCH_LABEL)
    expect(guard.shouldKeepExisting('s1', 3, 1)).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('空结果但分区本就为空 → false（空分区 [] 是合法结果）', () => {
    const guard = createEmptyResultStrikeGuard(LIMIT, LOG_TAG, FETCH_LABEL)
    expect(guard.shouldKeepExisting('s1', 0, 0)).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('分区为空期间空结果不累计 strike：空×2（分区空）后预置非空分区，下次空仍是 strike 1/2 保留', () => {
    const guard = createEmptyResultStrikeGuard(LIMIT, LOG_TAG, FETCH_LABEL)
    expect(guard.shouldKeepExisting('s1', 0, 0)).toBe(false)
    expect(guard.shouldKeepExisting('s1', 0, 0)).toBe(false)
    // 分区非空后首次空：若上面累计过，此处会是 2/2 放行（误清）
    expect(guard.shouldKeepExisting('s1', 0, 1)).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('empty strike 1/2'),
      's1',
    )
  })
})

describe('createEmptyResultStrikeGuard — strike 连续计数（true = 保留旧分区）', () => {
  let warnSpy: MockInstance

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('首次空命中（分区非空）→ true + warn1 文案结构（tag/label/keeping existing records/strike n/limit）', () => {
    const guard = createEmptyResultStrikeGuard(LIMIT, LOG_TAG, FETCH_LABEL)
    expect(guard.shouldKeepExisting('s1', 0, 1)).toBe(true)
    // warn1 完整结构：[${logTag}] ${fetchLabel} ... keeping existing records (empty strike 1/2):
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`[${LOG_TAG}] ${FETCH_LABEL} returned empty list but partition non-empty, keeping existing records (empty strike 1/${LIMIT})`),
      's1',
    )
  })

  it('连续空达 limit → 第 limit 次 false（判真实删空）+ warn2 clearing partition', () => {
    const guard = createEmptyResultStrikeGuard(LIMIT, LOG_TAG, FETCH_LABEL)
    expect(guard.shouldKeepExisting('s1', 0, 1)).toBe(true) // 1/2
    expect(guard.shouldKeepExisting('s1', 0, 1)).toBe(false) // 2/2 放行
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('treating as real deletion and clearing partition'),
      's1',
    )
  })

  it('非空结果 → false 且 strike 计数保留（factory 不自动重置，重置职责在调用方显式 reset）', () => {
    const guard = createEmptyResultStrikeGuard(LIMIT, LOG_TAG, FETCH_LABEL)
    expect(guard.shouldKeepExisting('s1', 0, 1)).toBe(true) // 1/2
    expect(guard.shouldKeepExisting('s1', 2, 1)).toBe(false) // 非空放行，计数不清
    // 计数残留生效：本次累计到 2/2 放行（若 factory 在非空分支顺手清了计数，此处会是 true）
    expect(guard.shouldKeepExisting('s1', 0, 1)).toBe(false)
  })

  it('接线模式组合（keep→return；放行→reset+覆盖，两 store 同款）：非空打断 / 达限放行后均重新从 1 计', () => {
    // 「非空打断重置」「达限放行后重置」由接线层在放行路径调 reset() 完成——上一条已锁
    // factory 不自动清计数，本条锁两 store 同款组合用法下打断/放行后重新计数的完整闭环。
    const guard = createEmptyResultStrikeGuard(LIMIT, LOG_TAG, FETCH_LABEL)
    const load = (fetchedCount: number, partitionCount: number): 'kept' | 'applied' => {
      if (guard.shouldKeepExisting('s1', fetchedCount, partitionCount)) return 'kept'
      guard.reset('s1')
      return 'applied'
    }
    expect(load(0, 1)).toBe('kept') // strike 1/2
    expect(load(2, 1)).toBe('applied') // 非空打断：放行 + reset
    expect(load(0, 1)).toBe('kept') // 重新 1/2（未累计误清）
    expect(load(0, 1)).toBe('applied') // 2/2 达限放行 + reset
    expect(load(0, 1)).toBe('kept') // 放行后再次从 1 计
  })

  it('reset() 清零（RPC 失败 catch / clearSession 通道）：空(1/2) → reset → 空(重新 1/2)', () => {
    const guard = createEmptyResultStrikeGuard(LIMIT, LOG_TAG, FETCH_LABEL)
    expect(guard.shouldKeepExisting('s1', 0, 1)).toBe(true)
    guard.reset('s1')
    expect(guard.shouldKeepExisting('s1', 0, 1)).toBe(true)
    expect(warnSpy).toHaveBeenLastCalledWith(
      expect.stringContaining('empty strike 1/2'),
      's1',
    )
  })

  it('多 sid 计数独立：s1 连续 2 次空放行时，s2 仍需自己累计满 limit', () => {
    const guard = createEmptyResultStrikeGuard(LIMIT, LOG_TAG, FETCH_LABEL)
    expect(guard.shouldKeepExisting('s1', 0, 1)).toBe(true) // s1 1/2
    expect(guard.shouldKeepExisting('s2', 0, 1)).toBe(true) // s2 1/2（不受 s1 影响）
    expect(guard.shouldKeepExisting('s1', 0, 1)).toBe(false) // s1 2/2 放行
    expect(guard.shouldKeepExisting('s2', 0, 1)).toBe(false) // s2 自己的 2/2（若串号此处已是第 3 次）
  })

  it('limit 参数化：limit=3 时前 2 次空保留，第 3 次才放行（阈值非硬编码）', () => {
    const guard = createEmptyResultStrikeGuard(3, LOG_TAG, FETCH_LABEL)
    expect(guard.shouldKeepExisting('s1', 0, 1)).toBe(true) // 1/3
    expect(guard.shouldKeepExisting('s1', 0, 1)).toBe(true) // 2/3
    expect(guard.shouldKeepExisting('s1', 0, 1)).toBe(false) // 3/3 放行
  })
})
