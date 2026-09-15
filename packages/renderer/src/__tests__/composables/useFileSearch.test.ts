/**
 * useFileSearch composable 单测（U24-U26）。
 *
 * 覆盖：
 * - U24 debounce：连续 load 2 次（间隔0）→ fake timers advance 300，api 调 1 次
 * - U25 setupInvalidation：file_changes ready 转变（W19/D-9 经共享 helper）→ store.invalidate
 * - U26 invalidate 后不自动刷新（store.get 仍返回旧值，不触发 load）
 *
 * mock 策略：vi.mock('@/api') composer.getFileCandidates + git.status（helper overlay 回写）+
 * fake timers（debounce）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/composables/useFileSearch.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick } from 'vue'

const mockGetFileCandidates = vi.fn()
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  composer: { getFileCandidates: (...args: unknown[]) => mockGetFileCandidates(...args) },
  git: { status: vi.fn().mockResolvedValue({ sessionId: 's1', isRepo: false, stagedCount: 0, unstagedCount: 0, stats: { add: 0, del: 0 }, hasConflict: false, files: [] }) },
}))

import { useFileSearch } from '@/composables/features/search/useFileSearch'
import { useFileSearchStore, __resetFileSearchStoreForTesting } from '@/composables/features/search/useFileSearchStore'
import { useChatStore } from '@/stores/chat'

beforeEach(() => {
  setActivePinia(createPinia())
  // core 单例模块级缓存：reset 隔离用例间缓存（D7 收口，对齐 __resetCommandStoreForTesting 先例）
  __resetFileSearchStoreForTesting()
  vi.clearAllMocks()
})

describe('useFileSearch debouncedLoad', () => {
  it('U24 debounce 300ms：debouncedLoad 连续 2 次（间隔0）→ api 调 1 次', async () => {
    vi.useFakeTimers()
    try {
      mockGetFileCandidates.mockResolvedValue([{ path: 'a', name: 'a', type: 'file' }])
      const { debouncedLoad } = useFileSearch()

      // 连续 2 次（间隔 0），第二次的 timer 覆盖第一次（debounce 语义）
      debouncedLoad('s1', () => {})
      debouncedLoad('s1', () => {})

      // 未 advance 前 api 未调
      expect(mockGetFileCandidates).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(300)

      expect(mockGetFileCandidates).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('useFileSearch.setupInvalidation', () => {
  it('U25 file_changes ready 转变 → store.invalidate', async () => {
    mockGetFileCandidates.mockResolvedValue([{ path: 'a.ts', name: 'a.ts', type: 'file' }])
    const { load, setupInvalidation } = useFileSearch()
    const store = useFileSearchStore()
    const chatStore = useChatStore()

    // 先 load 建立缓存
    await load('s1')
    expect(store.get('s1')).toHaveLength(1)

    // 订阅 invalidation
    const sidRef = ref('s1')
    const unwatch = setupInvalidation(sidRef)

    // 模拟 agent 完成一轮改文件（W19/D-9：ready 帧经 applyFileChanges 写 messages +
    // changeSetStatuses，两者同步完成；accumulating 中间帧不触发失效）
    chatStore.setMessages('s1', [
      { id: 'a1', role: 'assistant', content: 'done', status: 'complete', timestamp: 1 },
    ])
    chatStore.applyFileChanges('s1', 'a1', [{ filePath: 'src/a.ts', status: 'modified' }], 'ready', true)

    await nextTick() // 触发 Vue watch（shallowRef .value 整体替换触发响应式）
    // 缓存被失效（G9：删缓存不重拉）
    expect(store.get('s1')).toBeUndefined()
    // 未自动重拉（load 未被触发）
    expect(mockGetFileCandidates).toHaveBeenCalledTimes(1)

    unwatch()
  })

  it('U26 invalidate 后不自动刷新：store.get 返回 undefined，下次 load 才重拉', async () => {
    mockGetFileCandidates.mockResolvedValueOnce([{ path: 'a.ts', name: 'a.ts', type: 'file' }])
    mockGetFileCandidates.mockResolvedValueOnce([{ path: 'b.ts', name: 'b.ts', type: 'file' }])
    const { load, setupInvalidation } = useFileSearch()
    const store = useFileSearchStore()
    const chatStore = useChatStore()
    const sidRef = ref('s1')
    const unwatch = setupInvalidation(sidRef)

    await load('s1')
    expect(store.get('s1')).toHaveLength(1)

    // 触发失效（ready 帧走 applyFileChanges 真实写路径，触发 shallowRef 响应式）
    chatStore.setMessages('s1', [
      { id: 'a1', role: 'assistant', content: 'done', status: 'complete', timestamp: 1 },
    ])
    chatStore.applyFileChanges('s1', 'a1', [{ filePath: 'x.ts', status: 'modified' }], 'ready', true)
    await nextTick()
    expect(store.get('s1')).toBeUndefined()

    // 下次 load 才重拉
    await load('s1')
    expect(mockGetFileCandidates).toHaveBeenCalledTimes(2)
    expect(store.get('s1')).toHaveLength(1)

    unwatch()
  })
})
