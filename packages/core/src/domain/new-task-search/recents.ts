/**
 * recents —— recents 持久化 + FIFO 淘汰（core 域迁移版，IF6）。
 *
 * [归位] 迁自 renderer composables/features/useRecents.ts（80 行），语义逐条等价。
 * C-W3-4：localStorage 直连改经注入的 KVStorage 端口（async），read/write 同步适配为 async；
 * 壳适配 getPlatform().storage（D8 收编）。
 *
 * 接线层级：叶子（storage 端口同步读/写 + JSON.parse try/catch）。
 * 依赖方向：types（SearchType/RecentEntry + 常量），无 store/api 依赖。
 *
 * 失败路径（MR-3.1/MR-3.3）：
 *  - read: storage 无 key（首用）→ []; JSON.parse 失败（脏数据）→ []（降级不崩溃）
 *  - write: 配额满 catch → 内存态保留本次写入（不回滚），本次会话显示成功，reload 丢失
 *
 * 并发（AC-3.6）：timestamp 用计数器兜底 Math.max(stored)+1，非裸 Date.now()（防同毫秒连续 write FIFO 不确定）。
 */
import type { KVStorage } from '../../platform/port'
import { RECENTS_PER_TYPE, RECENTS_STORAGE_KEY } from './types'
import type { RecentEntry, SearchType } from './types'

export function useRecents(storage: KVStorage) {
  /**
   * 读 recents（按 timestamp 倒序，每类 ≤5）。
   * MR-3.1：JSON.parse 失败→[]（脏数据降级），不崩溃。
   */
  async function read(): Promise<RecentEntry[]> {
    try {
      const raw = await storage.get(RECENTS_STORAGE_KEY)
      if (!raw) return [] // 首用（AC-3.3）
      const parsed = JSON.parse(raw) as RecentEntry[]
      // 按 type 分组 + 每类取最新 5 项（FIFO 倒序）
      return filterPerType(parsed)
    } catch {
      // MR-3.1：脏数据降级空数组，不崩溃
      return []
    }
  }

  /**
   * 写 recents（FIFO 淘汰，AC-3.2/3.5/3.6）。
   * MR-3.3：配额满 catch 内存态保留不回滚，返回 false 通知调用方持久化失败。
   * @returns true=已持久化；false=降级（配额满/序列化失败，内存态保留，reload 丢失）
   */
  async function write(entry: RecentEntry): Promise<boolean> {
    try {
      const existing = await read()
      // AC-3.5 幂等：同 key 更新 timestamp 不新增
      const withoutDup = existing.filter((e) => e.key !== entry.key)
      withoutDup.push(entry)
      // AC-3.6 计数器兜底：timestamp = Math.max(stored)+1（防同毫秒连续 write）
      const maxTs = withoutDup.reduce((m, e) => Math.max(m, e.timestamp), 0)
      entry.timestamp = maxTs + 1
      const trimmed = filterPerType(withoutDup)
      await storage.set(RECENTS_STORAGE_KEY, JSON.stringify(trimmed))
      return true
    } catch (e) {
      // MR-3.3：配额满/JSON.stringify 失败 → 内存态保留本次写入（不回滚，不抛）
      // recents 是偏好数据可丢失（D-007 容忍度），返回 false 让调用方知晓（但不阻断主流程）
      console.warn('[recents] write 降级（配额满或序列化失败），内存态保留', e)
      return false
    }
  }

  /** 按 type 分组，每类保留最新 RECENTS_PER_TYPE 项（FIFO，timestamp 倒序） */
  function filterPerType(entries: RecentEntry[]): RecentEntry[] {
    const byType = new Map<SearchType, RecentEntry[]>()
    for (const e of entries) {
      const arr = byType.get(e.type) ?? []
      arr.push(e)
      byType.set(e.type, arr)
    }
    const out: RecentEntry[] = []
    for (const arr of byType.values()) {
      arr.sort((a, b) => b.timestamp - a.timestamp)
      out.push(...arr.slice(0, RECENTS_PER_TYPE))
    }
    return out
  }

  return { read, write }
}
