/**
 * history-rebuild-cache clearAll 出口单测（u7c，偏差 #28① ①）。
 *
 * 覆盖（B1 验收）：
 * - HistoryRebuildCache.clearAll：清空全部条目 + 返回清除条目数（观测面）+ 空缓存幂等；
 * - clearAll 后 get 走未命中（下次 getHistory 全量重建的缓存前提）；
 * - SessionHistoryReader.clearHistoryCache 透传出口在场（组合根 watchdog onRelief 接线面，
 *   接线行为由 watchdog.test.ts 的 onRelief 回调断言覆盖）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/history-rebuild-clearall.test.ts
 */
import { describe, it, expect } from 'vitest'
import { HistoryRebuildCache, SessionHistoryReader } from '../history-rebuild-cache.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'

function entry(): { leafId: string | null; messages: []; truncated: boolean } {
  return { leafId: 'leaf-1', messages: [], truncated: false }
}

describe('HistoryRebuildCache.clearAll（u7c memory-relief 可回收物 ①）', () => {
  it('清空全部条目并返回清除条目数', () => {
    const cache = new HistoryRebuildCache()
    cache.set('a', entry())
    cache.set('b', entry())
    cache.set('c', entry())

    expect(cache.clearAll()).toBe(3)
    expect(cache.size).toBe(0)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toBeUndefined()
  })

  it('空缓存 clearAll 返回 0（幂等，重复 relief 不误报）', () => {
    const cache = new HistoryRebuildCache()
    expect(cache.clearAll()).toBe(0)
    cache.set('a', entry())
    expect(cache.clearAll()).toBe(1)
    expect(cache.clearAll()).toBe(0)
  })
})

describe('SessionHistoryReader.clearHistoryCache 透传出口（组合根 onRelief 接线面）', () => {
  it('出口在场且转发 clearAll（窄注入 deps 仅类型约束，clearAll 不触达 deps）', () => {
    const reader = new SessionHistoryReader({
      pm: {} as IProcessManager,
      sessionStore: {} as ISessionStore,
    })
    expect(reader.clearHistoryCache()).toBe(0)
  })
})
