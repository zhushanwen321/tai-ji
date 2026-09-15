/**
 * useSubagentBucketFilter composable 单测（设计 subagent-sidebar-filter D5 / T3）。
 *
 * 覆盖：
 * - 分区默认值：新 session 首次进入 = 'active'（D1）
 * - 工厂分区语义（同 composable 实例切 sid）：新 sid 初值 active、切回旧 sid 恢复其选择
 *   （per-instance Map 挂载期内分区独立，D5）
 * - MF-A 响应式回归：setFilter 后 filter computed 立即反映（响应式容器契约——init 若是
 *   plain object，mutate 不触发 computed 失效，本断言必红，锁死 MF-A）
 * - null sid（Overview 态）：filter 默认 active，setFilter no-op
 *
 * 运行：cd packages/renderer && pnpm test src/__tests__/composables/useSubagentBucketFilter.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { computed, effectScope, ref } from 'vue'
import { __clearSessionCleanupRegistryForTest } from '@taiji/core/foundation/use-session-scoped-state'
import { useSubagentBucketFilter } from '@/composables/features/sidebar/useSubagentBucketFilter'

// 模块级 cleanup registry 跨测试可能残留（未包 effectScope 的用例无法触发反注册），
// 每个用例前清空，防污染下游断言
beforeEach(() => {
  __clearSessionCleanupRegistryForTest()
})

/** 在独立 effectScope 内运行 composable，测试后 dispose 模拟宿主卸载 */
function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

describe('useSubagentBucketFilter（D5 工厂分区）', () => {
  it('新 session 分区默认值 = active（D1 默认「进行中」）', () => {
    const sid = ref<string | null>('sess-default')
    const { result } = runWithScope(() => useSubagentBucketFilter(sid))
    expect(result.filter.value).toBe('active')
  })

  it('同实例切 sid：新 sid 初值 active，切回旧 sid 恢复其选择（挂载期内分区独立）', () => {
    const sid = ref<string | null>('sess-a')
    const { result } = runWithScope(() => useSubagentBucketFilter(sid))

    // session A 切到「已结束」
    result.setFilter('ended')
    expect(result.filter.value).toBe('ended')

    // 切到 session B：新分区，默认 active（不是 A 的 ended）
    sid.value = 'sess-b'
    expect(result.filter.value).toBe('active')

    // B 独立选择，不影响 A
    result.setFilter('all')
    expect(result.filter.value).toBe('all')

    // 切回 A：恢复 A 上次的选择（ended，而非 B 的 all 或默认 active）
    sid.value = 'sess-a'
    expect(result.filter.value).toBe('ended')
  })

  it('MF-A 响应式回归：setFilter 后 filter computed 及下游 computed 立即反映', () => {
    const sid = ref<string | null>('sess-mf')
    const { result } = runWithScope(() => useSubagentBucketFilter(sid))

    // 先求值建立响应式依赖
    expect(result.filter.value).toBe('active')

    // 下游 computed（模拟消费方派生），setFilter 后必须同步重算
    const label = computed(() => `bucket:${result.filter.value}`)
    expect(label.value).toBe('bucket:active')

    result.setFilter('ended')
    expect(result.filter.value).toBe('ended')
    expect(label.value).toBe('bucket:ended')

    result.setFilter('all')
    expect(result.filter.value).toBe('all')
    expect(label.value).toBe('bucket:all')
  })

  it('null sid（Overview 态）：filter 默认 active，setFilter no-op 不可改', () => {
    const sid = ref<string | null>(null)
    const { result } = runWithScope(() => useSubagentBucketFilter(sid))

    expect(result.filter.value).toBe('active')
    result.setFilter('ended')
    // 工厂 update 对 null sid no-op：保持默认，不落任何分区
    expect(result.filter.value).toBe('active')
  })

  it('宿主 scope dispose 后新实例从默认值起步（per-instance Map 随宿主实例存活，切 tab 重置语义）', () => {
    const sid = ref<string | null>('sess-lifecycle')
    const first = runWithScope(() => useSubagentBucketFilter(sid))
    first.result.setFilter('ended')
    expect(first.result.filter.value).toBe('ended')
    first.dispose()

    // 新实例（模拟切 tab 后重新挂载）：分区已随旧实例丢弃，重置默认 active
    const second = runWithScope(() => useSubagentBucketFilter(sid))
    expect(second.result.filter.value).toBe('active')
    second.dispose()
  })
})
