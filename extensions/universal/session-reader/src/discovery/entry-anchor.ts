import { readFileSync } from 'node:fs'

import { parseSessionContent, type Entry } from '@zhushanwen/session-core'

/**
 * zcode 锚的 entry 兜底定位（设计 session-reader-shared-core §3.1 第②步）。
 *
 * 定位链第②层：zcode manifest 直读（第①层，zcode-manifest.ts）缺位/残缺时，
 * 在候选主 session 文件里按 sa-id 扫 `subagent-record` custom entry，取其
 * `engineHandle.sessionRef`（zcode 形态 = `{sessionId, dbPath}`）。
 *
 * 边界承载（设计四要素登记）：本函数只认「候选文件列表」，越界语义（不做根内
 * 全扫、liveSessionDir 优先排序）由调用方构造候选集时决定——第一梯队只传
 * liveSessionDir 内的主 session 文件，越界查询返回 not-found 信号（undefined，
 * 调用方映射 `zcode_record_not_found` 错误码，§3.4）。
 */

/**
 * zcode 锚（zcode 引擎自描述定位符的 zcode 形态）。与 manifest 直读产出的锚同形；
 * `sessionRef` 写侧整体透传不枚举内部键（subagent-core record-entry.ts
 * engineHandle.sessionRef 注释），本单元按 zcode 形态校验并窄化为双键。
 */
export interface ZcodeAnchor {
  sessionId: string
  dbPath: string
}

/**
 * `subagent-record` custom entry 的 customType 值。
 *
 * 磁盘 JSONL 协议字符串（跨侧契约）：写侧单源 = subagent-core record-entry.ts 的
 * SUBAGENT_RECORD_CUSTOM_TYPE。reader 生产依赖面不引 subagent-core（该包是
 * devDependency + vitest alias 形态），故按协议字符串本地持有；两侧漂移由
 * entry-anchor.test.ts 的跨包断言守卫。
 */
const SUBAGENT_RECORD_CUSTOM_TYPE = 'subagent-record'

/**
 * 从单条 entry 提取 zcode 锚。形状校验窄而严，任一不满足 = 该条不算命中（返回
 * undefined，调用方继续扫——缺键条目不遮蔽更早的完整条目）：
 * - `type === 'custom'` ∧ `customType === 'subagent-record'`
 * - `data.v === 1`（schema 版本守卫，不认识的版本跳过而非猜测——写侧 record-entry.ts v 注释同口径）
 * - `data.id === saId`（record id 即 sa-id，record-access.ts `sa-${uuid}`）
 * - `engineHandle.sessionRef.sessionId` / `.dbPath` 均为非空 string（F8 双键齐判据的
 *   锚字段部分；pi record 的 sessionRef 无 dbPath → 天然不命中，无需 engine 判别）
 */
function zcodeAnchorOfEntry(entry: Entry, saId: string): ZcodeAnchor | undefined {
  if (entry.type !== 'custom' || entry.customType !== SUBAGENT_RECORD_CUSTOM_TYPE) return undefined
  const data: unknown = entry.data
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (d.v !== 1 || d.id !== saId) return undefined
  const handle: unknown = d.engineHandle
  if (typeof handle !== 'object' || handle === null) return undefined
  const ref: unknown = (handle as Record<string, unknown>).sessionRef
  if (typeof ref !== 'object' || ref === null) return undefined
  const r = ref as Record<string, unknown>
  const { sessionId, dbPath } = r
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  if (typeof dbPath !== 'string' || dbPath === '') return undefined
  return { sessionId, dbPath }
}

/**
 * 在候选主 session 文件里按 sa-id 定位 zcode 锚。
 *
 * 取条语义（设计 §2.5 裁决，subagent-core collectLastRecordEntries 逐字同构——
 * 「主 session 全文 → 每 id 末条 record data」，record-store-rebuild.ts:212-227）：
 * 同一 sa-id 每次状态迁移写一条全量快照 entry 且 sessionRef 每轮覆写（F16），故
 * 同文件内后条覆盖前条 = 文件顺序末条。**禁止另创取首条/合并语义**（附录 B-6）。
 *
 * 多候选文件：按候选列表顺序逐文件扫，文件内有命中锚（含末条裁决后）即止——
 * 候选顺序 = 调用方声明的优先级（liveSessionDir 优先），不跨文件合并。
 *
 * 行级容错：逐行解析由基座 parseSessionContent 承担（坏行跳过继续、末行半行记
 * lastLinePartial 不中断）——best-effort，不因一行坏 JSON 失败整文件。
 *
 * 候选文件读失败（不存在/不可读）= 该候选无命中，跳过继续下一候选；本函数契约
 * 是「锚或 not-found」，IO 错误同样收敛到 not-found 信号（调用方映射错误码），
 * 不向上抛。
 *
 * @returns 命中的锚；所有候选均未命中（或全部候选不可读）→ undefined（not-found 信号）
 */
export function findZcodeEntryAnchor(
  candidateFiles: readonly string[],
  saId: string,
): ZcodeAnchor | undefined {
  for (const file of candidateFiles) {
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const { entries } = parseSessionContent(content)
    let anchor: ZcodeAnchor | undefined
    for (const entry of entries) {
      const hit = zcodeAnchorOfEntry(entry, saId)
      if (hit !== undefined) anchor = hit
    }
    if (anchor !== undefined) return anchor
  }
  return undefined
}
