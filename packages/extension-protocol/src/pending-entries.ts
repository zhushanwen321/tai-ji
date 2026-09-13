/**
 * pending entries 差集核心（落盘形态语义：customType 字符串 + 抵消/去重规则）——
 * 跨端单一实现（ext-simplify-13 D3）。
 *
 * 契约两端（此前各持一份同构差集实现，对齐手段是注释）：
 *  - extension 侧：@zhushanwen/pi-base-tool-enhance 对账（原 collectUnsettledTaskIds：
 *    session_start 时对「entries 显示活跃但任务已终态」的 bt- 任务补写注销）
 *  - extension 侧：@zhushanwen/pi-pending-notifications 守卫判据（原
 *    scanPendingEntries + filterActiveRegisters；其 types/currentSessionId/normalize
 *    过滤是 pending 产品语义，留在 pending 侧，不在本模块）
 *
 * 规则本体（单点）：register 首见去重 + unregister 全局抵消 + id 非法跳过，
 * id 全局唯一（时间戳+随机）是前提。unregister 全局抵消 = 注销 entry 在 entries
 * 任意位置均抵消同 id（含「register→unregister→register 同 id」复用序列——id 唯一
 * 前提下真实数据不复现，语义锁定为已注销）。
 *
 * 零 node 依赖（纯算法），进 index 桶出口。
 */

/** pending register entry 的 customType 落盘字符串（协议 SSOT）。 */
export const PENDING_REGISTER_ENTRY_TYPE = 'pending:register' as const

/** pending unregister entry 的 customType 落盘字符串（协议 SSOT）。 */
export const PENDING_UNREGISTER_ENTRY_TYPE = 'pending:unregister' as const

/** collectActivePendingIds 的可选过滤（bte 对账便利入口用前缀过滤）。 */
export interface CollectPendingIdsOptions {
  /** 只保留该前缀的 id（如 'bt-'）；缺省不过滤。 */
  idPrefix?: string
}

/** scanPendingEntries 的结果：register 原始 data 列表 + 已注销 id 集合。 */
export interface PendingEntriesScan {
  registerEntries: Array<{ data: Record<string, unknown> }>
  unregisteredIds: Set<string>
}

/**
 * 单趟扫描 entries 按 customType 分流（容错对齐 pending 侧 S-10：null/非对象
 * 元素先守卫再访问字段）。register 侧不校验 id（合法性判定归差集层）；unregister
 * 仅收 string id。data 用最小结构类型 Record<string, unknown>，消费方自行窄化。
 */
export function scanPendingEntries(entries: unknown[]): PendingEntriesScan {
  const scan: PendingEntriesScan = { registerEntries: [], unregisteredIds: new Set() }
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as { customType?: unknown; data?: unknown }
    if (entry.customType === PENDING_REGISTER_ENTRY_TYPE) {
      scan.registerEntries.push({ data: (entry.data ?? {}) as Record<string, unknown> })
    } else if (entry.customType === PENDING_UNREGISTER_ENTRY_TYPE) {
      const data = (entry.data ?? {}) as Record<string, unknown>
      if (typeof data.id === 'string') scan.unregisteredIds.add(data.id)
    }
  }
  return scan
}

/**
 * 差集本体（规则单点）：register 首见去重 + unregister 全局抵消 + id 非法跳过。
 * 首见判定先于任何消费方过滤（seen.add 后即使调用方对首个 data 过滤丢弃，后续
 * 重复条目也不会顶上——与 pending 侧 filterActiveRegisters 的 seen 语义一致）。
 * 返回活跃 register 的原始 data 列表（按 entries 出现序）。
 */
export function applyPendingDiff(scan: PendingEntriesScan): Array<{ data: Record<string, unknown> }> {
  const active: Array<{ data: Record<string, unknown> }> = []
  const seen = new Set<string>()
  for (const { data } of scan.registerEntries) {
    if (typeof data.id !== 'string' || scan.unregisteredIds.has(data.id) || seen.has(data.id)) continue
    seen.add(data.id)
    active.push({ data })
  }
  return active
}

/**
 * 上层差集组合（bte 对账便利入口）：scan + diff + 可选前缀过滤 → 活跃 id 集。
 * 前缀过滤是差集之后的独立层（先抵消/去重，再按 id 字符串过滤）。
 */
export function collectActivePendingIds(entries: unknown[], opts?: CollectPendingIdsOptions): Set<string> {
  const active = applyPendingDiff(scanPendingEntries(entries))
  const prefix = opts?.idPrefix
  const ids = new Set<string>()
  for (const { data } of active) {
    const id = data.id
    if (typeof id !== 'string') continue
    if (prefix !== undefined && !id.startsWith(prefix)) continue
    ids.add(id)
  }
  return ids
}
