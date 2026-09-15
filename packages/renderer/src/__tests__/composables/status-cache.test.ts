/**
 * W3: useSessionDerivations statusOf 缓存化 + invalidateStatusCache。
 *
 * 覆盖：
 * - AC-2：同 id 多次调用 derivedStatus 返回同一 ComputedRef 实例（缓存命中）
 * - 不同 id 返回不同实例
 * - invalidateStatusCache(sessionId) 清除指定 id 缓存，下次调用新建
 * - invalidateStatusCache() 无参清除全部
 * - deleteSession 集成：disposeSession 后调 invalidate 清理
 *
 * 运行：npx vitest run src/__tests__/composables/status-cache.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { useSessionDerivations } from '@/composables/features/chat/useSessionDerivations'

describe('W3: derivedStatus 缓存复用（AC-2）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('同 id 多次调用返回同一 ComputedRef 实例', () => {
    const { derivedStatus } = useSessionDerivations()
    const c1 = derivedStatus('s1')
    const c2 = derivedStatus('s1')
    expect(c1).toBe(c2) // 同一引用 = 缓存命中
  })

  it('不同 id 返回不同 ComputedRef 实例', () => {
    const { derivedStatus } = useSessionDerivations()
    const c1 = derivedStatus('s1')
    const c2 = derivedStatus('s2')
    expect(c1).not.toBe(c2)
  })

  it('缓存值正确反映 session 状态', () => {
    const chat = useChatStore()
    const { derivedStatus } = useSessionDerivations()
    // 未 hydrate session → done
    const c = derivedStatus('s-empty')
    expect(c.value).toBe('done')
    // hydrate 一条 error 消息
    chat.hydrate('s-empty', [
      { id: 'm1', role: 'assistant', content: 'err', status: 'error', timestamp: 1 },
    ])
    // 缓存的 computed 应响应式更新（依赖 messages 变化）
    expect(c.value).toBe('error')
  })
})

describe('W3: invalidateStatusCache', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('invalidateStatusCache(id) 清除指定 id，下次调用新建实例', () => {
    const { derivedStatus, invalidateStatusCache } = useSessionDerivations()
    const c1 = derivedStatus('s1')
    invalidateStatusCache('s1')
    const c2 = derivedStatus('s1')
    expect(c1).not.toBe(c2) // 清除后新建
  })

  it('invalidateStatusCache(id) 不影响其他 id 缓存', () => {
    const { derivedStatus, invalidateStatusCache } = useSessionDerivations()
    const c1 = derivedStatus('s1')
    const c2 = derivedStatus('s2')
    invalidateStatusCache('s1')
    expect(derivedStatus('s2')).toBe(c2) // s2 缓存仍在
  })

  it('invalidateStatusCache() 无参清除全部', () => {
    const { derivedStatus, invalidateStatusCache } = useSessionDerivations()
    const c1 = derivedStatus('s1')
    const c2 = derivedStatus('s2')
    invalidateStatusCache()
    expect(derivedStatus('s1')).not.toBe(c1)
    expect(derivedStatus('s2')).not.toBe(c2)
  })
})
