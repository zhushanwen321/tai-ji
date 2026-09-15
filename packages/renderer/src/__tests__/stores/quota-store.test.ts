/**
 * Quota store 单测。
 *
 * 覆盖 w4（Composer hover 合并浮层）的 store 层：
 * - setCache 写入 + getEntry 读取
 * - markPending / unmarkPending 并发保护
 * - isPending 查询
 * - clearCache 清除
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/quota-store.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useQuotaStore } from '@/stores/quota'
import type { NormalizedQuotaRow } from '@taiji/shared'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useQuotaStore', () => {
  const mockRow: NormalizedQuotaRow = {
    label: '智谱 GLM Coding Plan',
    wins: [
      { pct: 68, resetSec: 4980 },
      { pct: 42, resetSec: 266400 },
      { pct: null, resetSec: null },
    ],
  }

  it('setCache + getEntry：写入后可读取', () => {
    const store = useQuotaStore()
    store.setCache('zhipu', mockRow, 1000)

    const entry = store.getEntry('zhipu')
    expect(entry).toBeDefined()
    expect(entry!.data).toEqual(mockRow)
    expect(entry!.lastFetchAt).toBe(1000)
  })

  it('getEntry：不存在的 key 返回 undefined', () => {
    const store = useQuotaStore()
    expect(store.getEntry('nonexistent')).toBeUndefined()
  })

  it('setCache：覆盖写入', () => {
    const store = useQuotaStore()
    store.setCache('zhipu', mockRow, 1000)
    store.setCache('zhipu', null, 2000)

    const entry = store.getEntry('zhipu')
    expect(entry!.data).toBeNull()
    expect(entry!.lastFetchAt).toBe(2000)
  })

  it('markPending：首次标记返回 true，重复标记返回 false', () => {
    const store = useQuotaStore()
    expect(store.markPending('zhipu')).toBe(true)
    expect(store.markPending('zhipu')).toBe(false)
    expect(store.isPending('zhipu')).toBe(true)
  })

  it('unmarkPending：取消后可重新标记', () => {
    const store = useQuotaStore()
    store.markPending('zhipu')
    store.unmarkPending('zhipu')
    expect(store.isPending('zhipu')).toBe(false)
    expect(store.markPending('zhipu')).toBe(true)
  })

  it('isPending：未标记的 key 返回 false', () => {
    const store = useQuotaStore()
    expect(store.isPending('zhipu')).toBe(false)
  })

  it('clearCache：清除指定 provider 缓存', () => {
    const store = useQuotaStore()
    store.setCache('zhipu', mockRow, 1000)
    store.clearCache('zhipu')
    expect(store.getEntry('zhipu')).toBeUndefined()
  })

  it('clearCache：不影响其他 provider', () => {
    const store = useQuotaStore()
    store.setCache('zhipu', mockRow, 1000)
    store.setCache('kimi', mockRow, 2000)
    store.clearCache('zhipu')
    expect(store.getEntry('zhipu')).toBeUndefined()
    expect(store.getEntry('kimi')).toBeDefined()
  })

  it('多 provider 隔离：pending 和 cache 互不干扰', () => {
    const store = useQuotaStore()
    store.markPending('zhipu')
    store.setCache('kimi', mockRow, 1000)

    expect(store.isPending('zhipu')).toBe(true)
    expect(store.isPending('kimi')).toBe(false)
    expect(store.getEntry('zhipu')).toBeUndefined()
    expect(store.getEntry('kimi')).toBeDefined()
  })
})
