/**
 * LocalStorageAdapter —— KVStorage 的 localStorage 实现（W4 壳接入）。
 *
 * core 零 localStorage 直连（架构 §9 PlatformPort）：system-storage 等 core 域经
 * getPlatform().storage 抽象读写，renderer 壳（W4）providePlatform 时注入本适配。
 *
 * 语义对齐 core KVStorage：get 不存在 key 返 null（不抛）、set/remove 转 localStorage。
 * 损坏 JSON 的回退由 core 侧 getSystem 处理（adapter 只做 raw 字符串读写）。
 */
import type { KVStorage } from '@taiji/core/platform/port'

export class LocalStorageAdapter implements KVStorage {
  private readonly storage: Storage

  constructor(storage: Storage = globalThis.localStorage) {
    this.storage = storage
  }

  async get(key: string): Promise<string | null> {
    return this.storage.getItem(key)
  }

  async set(key: string, value: string): Promise<void> {
    this.storage.setItem(key, value)
  }

  async remove(key: string): Promise<void> {
    this.storage.removeItem(key)
  }
}
