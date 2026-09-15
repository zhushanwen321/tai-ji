/**
 * useBackgroundTaskBucketFilter 单测 —— 三桶筛选状态 per-session 分区（D10②）。
 *
 * 核心回归锚（subagent MF-A 同款死锁级坑）：分区容器必须是 reactive 对象包装——
 * setFilter mutate 分区后 current computed 必须失效重算。若实现退化为 plain object
 * （裸 { value: 'active' }），mutate 不建立响应式依赖，computed 命中缓存返回旧值，
 * 「筛选点击后 current 更新」用例即红——本文件第一条用例就是该回归的行为锁。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-background-task-bucket-filter.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { defineComponent, h, ref, nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import {
  useBackgroundTaskBucketFilter,
  BACKGROUND_TASK_DEFAULT_FILTER,
  type UseBackgroundTaskBucketFilterReturn,
} from '@/composables/features/sidebar/useBackgroundTaskBucketFilter'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'

const wrappers: VueWrapper[] = []

interface HostHandle {
  sidRef: ReturnType<typeof ref<string | null>>
  filter: UseBackgroundTaskBucketFilterReturn
}

function mountHost(initialSid: string | null): HostHandle {
  const sidRef = ref<string | null>(initialSid)
  const wrapper = mount(
    defineComponent({
      setup() {
        const filter = useBackgroundTaskBucketFilter(sidRef)
        return { filter }
      },
      render: () => h('div'),
    }),
  )
  wrappers.push(wrapper)
  const candidate = (wrapper.vm as { filter?: unknown }).filter
  if (!candidate || typeof candidate !== 'object' || !('current' in candidate)) {
    throw new Error('host 组件未暴露 filter')
  }
  return { sidRef, filter: candidate as UseBackgroundTaskBucketFilterReturn }
}

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers.length = 0
  __clearSessionCleanupRegistryForTest()
})

describe('useBackgroundTaskBucketFilter（D10② reactive 容器分区）', () => {
  it('默认「运行中」（active）', () => {
    const host = mountHost('A')
    expect(BACKGROUND_TASK_DEFAULT_FILTER).toBe('active')
    expect(host.filter.current.value).toBe('active')
  })

  it('回归锚：setFilter mutate 后 current computed 失效重算（plain object 容器会停旧值）', () => {
    const host = mountHost('A')
    host.filter.setFilter('ended')
    expect(host.filter.current.value).toBe('ended')
    host.filter.setFilter('all')
    expect(host.filter.current.value).toBe('all')
    host.filter.setFilter('active')
    expect(host.filter.current.value).toBe('active')
  })

  it('跨 session 分区记忆：A 切 ended，B 仍默认 active，切回 A 保留 ended', async () => {
    const host = mountHost('A')
    host.filter.setFilter('ended')
    host.sidRef.value = 'B'
    await nextTick()
    expect(host.filter.current.value).toBe('active') // B 是新分区，默认值
    host.filter.setFilter('all')
    expect(host.filter.current.value).toBe('all')
    host.sidRef.value = 'A'
    await nextTick()
    expect(host.filter.current.value).toBe('ended') // A 分区记忆保留（挂载期内）
  })

  it('卸载重置：重开 tab（新 mount）同 sid 回默认「运行中」，不跨挂载记忆', () => {
    const host = mountHost('A')
    host.filter.setFilter('ended')
    expect(host.filter.current.value).toBe('ended')
    const w = wrappers[0]
    w.unmount()
    wrappers.splice(wrappers.indexOf(w), 1)
    const host2 = mountHost('A')
    expect(host2.filter.current.value).toBe('active')
  })

  it('null sid 时 setFilter no-op（不污染任何分区）', async () => {
    const host = mountHost(null)
    expect(host.filter.current.value).toBe('active') // 临时默认实例
    host.filter.setFilter('ended') // update 对 null sid no-op
    expect(host.filter.current.value).toBe('active')
    host.sidRef.value = 'A'
    await nextTick()
    expect(host.filter.current.value).toBe('active') // A 分区未被写入
  })
})
