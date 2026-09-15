/**
 * turn-expansion store takeover API 单测（streaming-trace-window window wave T8 / MF-1）。
 *
 * 验证 ADR-0049 不变式：takeoverPartitions 与 partitions 同构（Map<sid, reactive Map<turnKey, boolean>>），
 * per-session 隔离 + clearSession cleanup（与 isExpanded 同生命周期、同对称性）。
 *
 * - TC5: store API（isTakeover/setTakeover/getTakeoverPartition/takeoverPartitions 暴露 + 与 isExpanded 独立）
 * - TC6: clearSession 同时清 partitions + takeoverPartitions（ADR-0049 cleanup 对称 + 按 sid 精确）
 * - TC7: per-session 隔离（s1 takeover 不影响 s2）
 *
 * 运行：cd packages/renderer && npx vitest run src/stores/__tests__/turn-expansion.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTurnExpansionStore } from '@/stores/turn-expansion'
import {
  triggerSessionCleanups,
  __clearSessionCleanupRegistryForTest,
} from '@/composables/useSessionScopedState'

beforeEach(() => {
  // 独立 Pinia 实例：每个 case 拿到全新 store（store 单例 per Pinia）
  setActivePinia(createPinia())
  // 重置模块级 cleanup registry，防上例注册残留污染下例（store 注册了 clearSession）
  __clearSessionCleanupRegistryForTest()
})

describe('turn-expansion store takeover API (window wave TC5/TC6/TC7, ADR-0049)', () => {
  it('TC5: isTakeover 默认 false（key 不存在）；setTakeover(true) 后 isTakeover=true', () => {
    const store = useTurnExpansionStore()
    expect(store.isTakeover('s1', 'turn-1')).toBe(false)
    store.setTakeover('s1', 'turn-1', true)
    expect(store.isTakeover('s1', 'turn-1')).toBe(true)
  })

  it('TC5: setTakeover(false) 显式归位（赋值不 delete，保响应式链，同 collapse 范式）', () => {
    const store = useTurnExpansionStore()
    store.setTakeover('s1', 'turn-1', true)
    store.setTakeover('s1', 'turn-1', false)
    expect(store.isTakeover('s1', 'turn-1')).toBe(false)
  })

  it('TC5: takeoverPartitions 暴露 + getTakeoverPartition 惰性创建（与 partitions 同构范式）', () => {
    const store = useTurnExpansionStore()
    expect(store.takeoverPartitions).toBeInstanceOf(Map)
    // 惰性创建：isTakeover 读时建空分区
    store.isTakeover('s1', 'turn-1')
    expect(store.takeoverPartitions.has('s1')).toBe(true)
    expect(store.getTakeoverPartition('s1')).toBeInstanceOf(Map)
  })

  it('TC5: takeover 与 isExpanded 独立（同 turn 可同时为 true，互不干扰——窗口级 vs turn 级语义分离）', () => {
    const store = useTurnExpansionStore()
    store.expand('s1', 'turn-1')
    store.setTakeover('s1', 'turn-1', true)
    expect(store.isExpanded('s1', 'turn-1')).toBe(true)
    expect(store.isTakeover('s1', 'turn-1')).toBe(true)
    // collapse isExpanded 不影响 takeover（两者独立分区）
    store.collapse('s1', 'turn-1')
    expect(store.isExpanded('s1', 'turn-1')).toBe(false)
    expect(store.isTakeover('s1', 'turn-1')).toBe(true)
  })

  it('TC7: per-session 隔离（s1 setTakeover 不影响 s2）', () => {
    const store = useTurnExpansionStore()
    store.setTakeover('s1', 'turn-1', true)
    expect(store.isTakeover('s1', 'turn-1')).toBe(true)
    // s2 独立分区，默认 false
    expect(store.isTakeover('s2', 'turn-1')).toBe(false)
  })

  it('TC6: clearSession 同时清 partitions + takeoverPartitions（ADR-0049 cleanup 对称）', () => {
    const store = useTurnExpansionStore()
    store.expand('s1', 'turn-1')
    store.setTakeover('s1', 'turn-1', true)
    store.setTakeover('s1', 'turn-2', true)
    expect(store.isExpanded('s1', 'turn-1')).toBe(true)
    expect(store.isTakeover('s1', 'turn-2')).toBe(true)

    // 触发 s1 的 cleanup（store 注册了 clearSession 到 cleanup registry）
    triggerSessionCleanups('s1')

    // clearSession 删除了 s1 分区 key（delete 生效，在后续惰性重建前可观测）
    expect(store.partitions.has('s1')).toBe(false)
    expect(store.takeoverPartitions.has('s1')).toBe(false)
    // 数据清空（后续惰性访问重建空分区，回默认 false）
    expect(store.isExpanded('s1', 'turn-1')).toBe(false)
    expect(store.isTakeover('s1', 'turn-1')).toBe(false)
    expect(store.isTakeover('s1', 'turn-2')).toBe(false)
  })

  it('TC6: clearSession(s1) 不影响 s2（cleanup 按 sid 精确清理）', () => {
    const store = useTurnExpansionStore()
    store.setTakeover('s1', 'turn-1', true)
    store.setTakeover('s2', 'turn-1', true)

    triggerSessionCleanups('s1')

    // s1 清空，s2 保留
    expect(store.isTakeover('s1', 'turn-1')).toBe(false)
    expect(store.isTakeover('s2', 'turn-1')).toBe(true)
  })
})
