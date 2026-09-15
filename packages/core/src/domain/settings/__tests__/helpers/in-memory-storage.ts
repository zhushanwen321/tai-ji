/**
 * 测试 helper：InMemoryStorage —— KVStorage 的内存实现（Map 承载）。
 * get 不存在 key 返回 null（对齐 KVStorage 契约：缺失 = null，非抛错）。
 * 供 system-storage / settings-store / settings-lifecycle 测试注入。
 */
import type { KVStorage } from '../../../../platform/port'

export class InMemoryStorage implements KVStorage {
  private map = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }

  /** 测试断言用：同步读当前值。 */
  peek(key: string): string | null {
    return this.map.get(key) ?? null
  }

  /** 测试用：整体清空。 */
  clear(): void {
    this.map.clear()
  }
}
