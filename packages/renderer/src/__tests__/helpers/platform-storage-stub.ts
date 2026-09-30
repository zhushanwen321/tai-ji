/**
 * PlatformPort.storage 的 in-memory KV 桩（mount 类测试 providePlatform({ kind: 'mock' })
 * 的 storage 形状单源；Map 承载，测试内无持久化诉求）。
 *
 * 实现取方法简写形态：@taiji/ui 侧 provider-edit-body.test.ts 有同语义副本，但跨包测试
 * 基建无法共享（ui 不得反向依赖 renderer 的测试 helper），两副本无法单源——本侧刻意用
 * 与该副本不同的等价写法，避免构成逐字克隆组（同 api-facade-mock.ts 循环生成形态先例）。
 */
export function inMemoryStorage() {
  const map = new Map<string, string>()
  return {
    async get(k: string) { return map.get(k) ?? null },
    async set(k: string, v: string) { map.set(k, v) },
    async remove(k: string) { map.delete(k) },
  }
}
