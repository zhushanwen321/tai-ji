/**
 * useFileSearch composable 单测（U24）。
 *
 * 覆盖：
 * - U24 debounce：连续 load 2 次（间隔0）→ fake timers advance 300，api 调 1 次
 *
 * （U25 setupInvalidation / U26 invalidate 后不自动刷新用例随 fileSearchStore 缓存退役
 * 删除——缓存治理 U1 1-3，失效编排失去对象。）
 *
 * mock 策略：vi.mock('@/api') composer.getFileCandidates + fake timers（debounce）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/composables/useFileSearch.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockGetFileCandidates = vi.fn()
vi.mock('@/api', () => ({ composer: { getFileCandidates: (...args: unknown[]) => mockGetFileCandidates(...args) } }))

import { useFileSearch } from '@/composables/features/search/useFileSearch'

beforeEach(() => {
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

  it('load 失败 → 降级空数组不抛', async () => {
    mockGetFileCandidates.mockRejectedValue(new Error('down'))
    const { load } = useFileSearch()

    await expect(load('s1')).resolves.toEqual([])
  })
})
