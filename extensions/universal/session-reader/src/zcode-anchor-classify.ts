/**
 * [§3.5 entry 兜底归因] zcode subagent-record「在场但锚不完整」的缺失归因判定
 *（classifyIncompleteEntryAnchor 的 entry 级纯逻辑提取，metrics-gate 复杂度偿还，
 * 判定语义零变化；文件扫描与 readFile I/O 留在 tool-handler.ts）。零 I/O 纯函数，
 * 可完全单测。
 *
 * 判定与 entry-anchor.ts 的 zcodeAnchorOfEntry 双键判据同构，协议字面量同值
 *（写侧 subagent-core record-entry.ts SUBAGENT_RECORD_CUSTOM_TYPE，漂移由
 * entry-anchor.test.ts 守卫）。
 */
import type { Entry } from '@zhushanwen/session-core'
import type { ZcodeAnchorMissingReason } from './discovery/zcode-manifest.js'

/**
 * 目标 sa-id 的 zcode 形态 subagent-record data：type/customType/v=1/id/engine 五关
 * 全过才返回。engine 判别（D5）在此——`d.engine !== 'zcode'` 的记录（pi 形态：
 * engine 缺省、sessionRef 无 dbPath）不是「zcode 锚不完整」，返回 undefined 跳过
 * 不归因：误归因 missing-dbPath 会把「pi record 先于 manifest settle 落盘」的正常
 * 窗口错报成 zcode_anchor_missing（旧版本产物指引不适用）；正确归因 = undefined
 * → 上层落 zcode_record_not_found。
 */
function zcodeRecordDataOf(entry: Entry, saId: string): Record<string, unknown> | undefined {
  if (entry.type !== 'custom' || entry.customType !== 'subagent-record') return undefined
  const data: unknown = entry.data
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (d.v !== 1 || d.id !== saId) return undefined
  if (d.engine !== 'zcode') return undefined
  return d
}

/** 已匹配 zcode record 的锚完整性链：返回第一个缺失键的归因；锚完整返回 undefined。 */
function anchorMissingReasonOf(record: Record<string, unknown>): ZcodeAnchorMissingReason | undefined {
  const handle = record.engineHandle
  if (typeof handle !== 'object' || handle === null) return 'missing-engineHandle'
  const ref = (handle as Record<string, unknown>).sessionRef
  if (typeof ref !== 'object' || ref === null) return 'missing-sessionRef'
  const r = ref as Record<string, unknown>
  if (typeof r.sessionId !== 'string' || r.sessionId === '') return 'missing-sessionId'
  if (typeof r.dbPath !== 'string' || r.dbPath === '') return 'missing-dbPath'
  return undefined
}

/**
 * entries 中第一条「在场但锚不完整」的 zcode subagent-record 的缺失归因；记录完全
 * 不在场（或命中的记录锚全完整）返回 undefined。锚完整的命中不终止扫描——同 sa-id
 * 多条记录时后续残缺记录仍可归因（与提取前的整循环行为一致）。
 */
export function firstIncompleteAnchorReason(
  entries: readonly Entry[],
  saId: string,
): ZcodeAnchorMissingReason | undefined {
  for (const entry of entries) {
    const record = zcodeRecordDataOf(entry, saId)
    if (record === undefined) continue
    const reason = anchorMissingReasonOf(record)
    if (reason !== undefined) return reason
  }
  return undefined
}
