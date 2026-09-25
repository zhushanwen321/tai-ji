// src/execution/notify/notify-ledger-helpers.ts
//
// notify-ledger 的自包含运行时 guard / 回执扫描 helper（自 notify-ledger.ts 按
// lint 行数上限抽出，行为零变化）。二者都不依赖账本闭包状态、也不反向 import
// notify-ledger.ts——依赖方向单向（notify-ledger → 本文件），无循环依赖。

// ─── entry 形态判定（运行时 guard，无 unsafe cast） ──────────────

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 收集 wanted 集合中已送达（custom_message entry 出现）的 notifyId。
 *  送达 entry 两种形态都匹配：单条 details.notifyId / 批量 details.items[].notifyId
 *  （对齐 courier 合并投递的 details 结构）。[u9] channelTypes = 回执接受域
 *  （默认通道 ∪ 在账条目声明的外部通道）——送达 customType 必须在域内才参与
 *  notifyId 匹配，防止无关 custom_message 的 details 撞键误销账。 */
export function collectDeliveredNotifyIds(
  entries: readonly unknown[],
  wanted: Set<string>,
  channelTypes: ReadonlySet<string>,
): Set<string> {
  const delivered = new Set<string>();
  if (wanted.size === 0) return delivered;
  for (const entry of entries) {
    if (!isPlainObject(entry) || entry["type"] !== "custom_message") continue;
    if (typeof entry["customType"] !== "string" || !channelTypes.has(entry["customType"])) continue;
    const details = entry["details"];
    if (!isPlainObject(details)) continue;
    const notifyId = details["notifyId"];
    if (typeof notifyId === "string" && wanted.has(notifyId)) {
      delivered.add(notifyId);
    }
    const items = details["items"];
    if (Array.isArray(items)) {
      for (const item of items) {
        if (isPlainObject(item)) {
          const id = item["notifyId"];
          if (typeof id === "string" && wanted.has(id)) delivered.add(id);
        }
      }
    }
  }
  return delivered;
}
