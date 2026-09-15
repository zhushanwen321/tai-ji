/**
 * 条数 LRU 缓存（用于 dedupe）。
 * 继承 MAX_NOTIFIED_RUN_IDS=1000 语义：按条数而非毫秒淘汰。
 */
export class LruSet {
  private readonly map: Map<string, void>

  constructor(private readonly maxKeys: number) {
    this.map = new Map()
  }

  /** 是否已包含 key。命中后刷新 LRU 位置。 */
  has(key: string): boolean {
    if (!this.map.has(key)) return false
    // 刷新 LRU 位置：删后重插到末尾
    this.map.delete(key)
    this.map.set(key)
    return true
  }

  /** 插入 key。超容量时淘汰最旧。 */
  add(key: string): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxKeys) {
      // 淘汰最旧（Map 迭代序 = 插入序，first = 最旧）
      const first = this.map.keys().next().value
      if (first !== undefined) this.map.delete(first)
    }
    this.map.set(key)
  }

  /** 清空。 */
  clear(): void {
    this.map.clear()
  }
}
