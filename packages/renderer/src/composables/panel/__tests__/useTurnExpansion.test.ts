/**
 * useTurnExpansion 单测——w1 wave IF1 契约验证（w4 store 重构后底层为 turn-expansion store）。
 *
 * 覆盖：默认折叠、per-session 隔离、toggle/expand/collapse 边沿、批量操作、
 * null sid no-op、cleanup 后重置、响应式（expand 触发下游 effect 重跑）。
 *
 * w4 改造：底层由 useSessionScopedState（per-instance Map）改为 Pinia store 单例。
 * 每个 case 通过 setActivePinia(createPinia()) 获得独立 store，互不污染。
 * 模块级 cleanup registry（store 注册了 clearSession）仍需重置，防注册残留跨 case 污染。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref, effectScope, effect } from 'vue'
import { useTurnExpansion } from '../useTurnExpansion'
import { useTurnExpansionStore } from '@/stores/turn-expansion'
import {
  triggerSessionCleanups,
  __clearSessionCleanupRegistryForTest,
} from '@/composables/useSessionScopedState'

beforeEach(() => {
  // 独立 Pinia 实例：每个 case 拿到全新 store（store 单例 per Pinia）
  setActivePinia(createPinia())
  // 重置模块级 cleanup 注册表，防上例注册残留污染下例（store 注册了 clearSession）
  __clearSessionCleanupRegistryForTest()
})

describe('useTurnExpansion (w1 wave IF1)', () => {
  it('TC-w1-1 isExpanded 默认折叠（key 不存在返回 false）', () => {
    const sid = ref<string | null>('s1')
    const { isExpanded } = useTurnExpansion(sid)
    expect(isExpanded(0)).toBe(false)
  })

  it('TC-w1-2 per-session 隔离：s1 expand(0) 不影响 s2', () => {
    const sid = ref<string | null>('s1')
    const { isExpanded, expand } = useTurnExpansion(sid)
    expand(0)
    expect(isExpanded(0)).toBe(true)

    // 切到 s2：store 按 sid 分区查 s2 分区（空），isExpanded 返回默认 false
    sid.value = 's2'
    expect(isExpanded(0)).toBe(false)

    // 切回 s1：s1 分区数据保留（store Map 切 sid 不丢数据），仍 true
    sid.value = 's1'
    expect(isExpanded(0)).toBe(true)
  })

  it('TC-w1-3 toggle 边沿：两次翻转回到原态', () => {
    const sid = ref<string | null>('s1')
    const { toggle, isExpanded } = useTurnExpansion(sid)

    toggle(1)
    expect(isExpanded(1)).toBe(true)

    toggle(1)
    expect(isExpanded(1)).toBe(false)
  })

  it('TC-w1-4 expandAll/collapseAll 批量设置', () => {
    const sid = ref<string | null>('s1')
    const { expandAll, collapseAll, isExpanded } = useTurnExpansion(sid)
    const indices = [0, 1, 2]

    expandAll(indices)
    for (const i of indices) {
      expect(isExpanded(i)).toBe(true)
    }

    collapseAll(indices)
    for (const i of indices) {
      expect(isExpanded(i)).toBe(false)
    }
  })

  it('TC-w1-5 null sessionId：所有写方法 no-op 不抛，isExpanded 返回 false', () => {
    const sid = ref<string | null>(null)
    const { isExpanded, toggle, expand, collapse, expandAll, collapseAll } = useTurnExpansion(sid)

    expect(() => {
      toggle(0)
      expand(0)
      collapse(0)
      expandAll([0, 1, 2])
      collapseAll([0, 1, 2])
    }).not.toThrow()

    expect(isExpanded(0)).toBe(false)
  })

  it('TC-w1-6 cleanup 后状态重置（triggerSessionCleanups 移除分区）', () => {
    const sid = ref<string | null>('s1')
    const { isExpanded, expand } = useTurnExpansion(sid)
    expand(0)
    expect(isExpanded(0)).toBe(true)

    // 触发该 sid 的所有 cleanup（turn-expansion store 注册了 clearSession 到 cleanup registry）
    triggerSessionCleanups('s1')

    // store 分区被 clearSession 删除，下次访问惰性新建空分区 → isExpanded 回到默认 false
    expect(isExpanded(0)).toBe(false)
  })

  it('TC-w1-7 响应式：expand 后下游 effect 重跑（依赖失效）', () => {
    const sid = ref<string | null>('s1')
    const { isExpanded, expand } = useTurnExpansion(sid)

    let runCount = 0
    const scope = effectScope()
    scope.run(() => {
      effect(() => {
        // 读 isExpanded 建立对 reactive 容器中该 key 的响应式依赖
        void isExpanded(0)
        runCount++
      })
    })

    expect(runCount).toBe(1) // 首次跑建立依赖

    expand(0) // mutate reactive 容器，effect 应失效重跑

    expect(runCount).toBe(2) // effect 重跑
    expect(isExpanded(0)).toBe(true)

    scope.stop() // 清理 effect
  })

  describe('TC-w1-8 hasAnyExpanded（IF1 公开方法）', () => {
    it('全折叠时 hasAnyExpanded([0,1,2]) 返回 false', () => {
      const sid = ref<string | null>('s1')
      const { hasAnyExpanded } = useTurnExpansion(sid)
      expect(hasAnyExpanded([0, 1, 2])).toBe(false)
    })

    it('部分展开（expand(1) 后）hasAnyExpanded([0,1,2]) 返回 true', () => {
      const sid = ref<string | null>('s1')
      const { expand, hasAnyExpanded } = useTurnExpansion(sid)
      expand(1)
      expect(hasAnyExpanded([0, 1, 2])).toBe(true)
    })

    it('空数组 hasAnyExpanded([]) 返回 false', () => {
      const sid = ref<string | null>('s1')
      const { hasAnyExpanded } = useTurnExpansion(sid)
      expect(hasAnyExpanded([])).toBe(false)
    })

    it('展开的 turnIndex 不在传入数组时不受其他 idx 影响（expand(5) 后 hasAnyExpanded([0,1]) 仍 false）', () => {
      const sid = ref<string | null>('s1')
      const { expand, hasAnyExpanded } = useTurnExpansion(sid)
      expand(5)
      expect(hasAnyExpanded([0, 1])).toBe(false)
    })
  })

  it('TC-w1-9 响应式：collapse（false↔true 来回切）effect 持续重跑', () => {
    const sid = ref<string | null>('s1')
    const { isExpanded, expand, collapse } = useTurnExpansion(sid)

    let runCount = 0
    const scope = effectScope()
    scope.run(() => {
      effect(() => {
        // 读 isExpanded 建立对 reactive 容器中该 key 的响应式依赖
        void isExpanded(0)
        runCount++
      })
    })

    expect(runCount).toBe(1) // 首次跑建立依赖

    expand(0) // mutate reactive 容器（false→true），effect 失效重跑
    expect(runCount).toBe(2)
    expect(isExpanded(0)).toBe(true)

    collapse(0) // 再次 mutate（true→false，赋值不 delete），effect 应再次失效重跑
    expect(runCount).toBe(3)
    expect(isExpanded(0)).toBe(false)

    scope.stop() // 清理 effect
  })
})

/* ──────────────────────────────────────────────────────────────
 * TC-w4-9：store per-session 隔离（w4 store 重构新增）
 * 验证：store 单例下，不同 sid 分区互不影响（w4 接线修复的核心场景）。
 * ────────────────────────────────────────────────────────────── */
describe('useTurnExpansionStore per-session 隔离（w4）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    __clearSessionCleanupRegistryForTest()
  })

  it('TC-w4-9 store per-session 隔离', () => {
    const store = useTurnExpansionStore()
    store.expand('s1', 0)
    expect(store.isExpanded('s1', 0)).toBe(true)
    // 隔离：s2 同 idx 默认折叠（独立分区）
    expect(store.isExpanded('s2', 0)).toBe(false)
  })

  it('TC-w4-10 store 跨调用方共享（w4 接线修复目标：Turn.vue 与 MessageStream.vue 共享展开态）', () => {
    // 两次 useTurnExpansion 调用拿到同一 store（同 Pinia 实例），展开态共享
    const sid = ref<string | null>('shared-1')
    const callerA = useTurnExpansion(sid)
    const callerB = useTurnExpansion(sid)

    // A 展开 turn 0 → B 立即可见（w1 的 per-instance Map 不共享，w4 store 共享）
    callerA.expand(0)
    expect(callerA.isExpanded(0)).toBe(true)
    expect(callerB.isExpanded(0)).toBe(true)

    // B collapse → A 立即可见
    callerB.collapse(0)
    expect(callerA.isExpanded(0)).toBe(false)
    expect(callerB.isExpanded(0)).toBe(false)
  })
})
