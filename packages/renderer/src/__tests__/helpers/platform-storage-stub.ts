/**
 * PlatformPort.storage 的 in-memory KV 桩（mount 类测试 providePlatform({ kind: 'mock' })
 * 的 storage 形状单源；Map 承载，测试内无持久化诉求）。
 *
 * @taiji/ui 侧 settings 测试 helper 有同语义副本——跨包包边界真差异（ui 不得依赖
 * renderer 测试基建），实现层两副本、契约层经 KVStorage 类型锚定单源——类型漂移由
 * 两包 typecheck 拦截。
 */
import type { KVStorage } from '@taiji/core'

export function inMemoryStorage(): KVStorage {
  const map = new Map<string, string>()
  return {
    async get(k: string) { return map.get(k) ?? null },
    async set(k: string, v: string) { map.set(k, v) },
    async remove(k: string) { map.delete(k) },
  }
}
