/**
 * PlatformPort.storage 的 in-memory KV 桩（mount 类测试 providePlatform({ kind: 'mock' })
 * 的 storage 形状单源；Map 承载，测试内无持久化诉求）。
 */
export function inMemoryStorage() {
  const map = new Map<string, string>()
  return {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => { map.set(k, v) },
    remove: async (k: string) => { map.delete(k) },
  }
}
