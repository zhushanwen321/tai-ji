/**
 * D2 compaction 关联域（设计 §6-D2 / §4.2 关联字段）：compact_summary 摘要宿主与
 * compaction part 的关联预扫描 + firstKeptEntryId 三级锚解析。
 * 来源注记：自 runtime services/session/zcode-import dev 演进版移植（判定逻辑零改动，
 * git 可追溯），本包为现行唯一承载（原拆分背景——max-lines 自 converter.ts 拆出、测试
 * 锚定 converter 公共面——见 git 历史）。
 *
 * 依赖方向：本模块只消费 assistant-mapping 的运行时守卫；对 converter 仅 `import type`
 * 取 ZcodeMessageInput 输入形态（类型引用编译期擦除，无运行时边——不构成循环依赖）。
 */

import { asNonEmptyString, isRecord } from './assistant-mapping.ts'
import type { ProjectionPolicy } from './semantics.ts'
import type { ZcodeMessageInput } from './converter.ts'

/**
 * compact_summary 消息的摘要正文（data.summary.body）。不可用（缺失/非串/空串）→ undefined，
 * 即「不伪造」：调用方退化为现状通道并计 compaction_unlinked（P-4 降级路径）。
 */
export function summaryBodyOf(data: Record<string, unknown>): string | undefined {
  const summary = isRecord(data.summary) ? data.summary : undefined
  return asNonEmptyString(summary?.body)
}

/**
 * compaction part 是否携带 timelineStatus——磁盘顶层形态（U0 考古 §2：存量 507/986 条在
 * part 顶层）与 asar schema 的 metadata 包装形态（projection.isTimelineOnlyMessage 的读取
 * 通道）取并集。为什么并集：D2 判据③（zcode 自家 compact-summary 判据）只应对「两处皆无」
 * 的 part 生效——若只查 metadata 通道，U0 的 195 条孤儿（全部携带顶层 timelineStatus）会被
 * 误关联进合并，孤儿比例归零与考古矛盾。
 */
function partHasTimelineStatus(part: Record<string, unknown>): boolean {
  if (typeof part.timelineStatus === 'string') return true
  const metadata = isRecord(part.metadata) ? part.metadata : undefined
  return typeof metadata?.timelineStatus === 'string'
}

/**
 * D2 firstKeptEntryId 三级锚解析（⛔ 悬空门：任何情况不发射悬空 id——P-1 实证悬空锚会把
 * 压缩点之前的历史全部静默截断）：
 * ① tail_start_id 经 messageId→entryId 映射命中——映射表只登记已发射 entry，命中即非悬空；
 * ② 未命中 → 紧邻前驱（保留全部历史，与摘要冗余但无损——「宁多保留不丢历史」保守方向）；
 * ③ compaction entry 是首条 entry（无前驱）→ 其自身 id。
 * 集成路径上 session_info 恒先于消息发射，② 级恒可用，③ 级仅规格完备性防御；独立导出
 * 是为让 ③ 路径可单测（convertZcodeTranscript 公共面构造不出「无前驱 entry」的输入）。
 */
export function resolveFirstKeptEntryId(
  tier1: string | undefined,
  lastEmittedId: string | null,
  ownId: string,
): string {
  if (tier1 !== undefined) return tier1
  if (lastEmittedId !== null) return lastEmittedId
  return ownId
}

// ── D2 关联预扫描（§6-D2 三路关联判据 + 1:N + 孤儿二分）──────────────────────────────
// 两趟结构的两个原因：① 判据①（summaryMessageId）的解析目标是「行集内存在即可」的任意
// 消息，而合并发射发生在目标消息的处理位次——关联关系必须先于发射趟建立；② 防双发要求在
// 指针 part 的宿主消息处理时就知道该 part 已被合并（U0 考古 §6：指针宿主 = timeline_event /
// 无 semantics，多为分类器丢弃类——宿主丢弃时 part 不再流经 part 级通道，无从回头抑制）。

/** 预扫描产物：发射趟消费的两张登记表（mergeable 仅预扫描内部使用，不外露）。 */
interface CompactionAssociation {
  /** 摘要宿主消息 id → 关联 part 列表（按联合序插入，首插 = 最早——1:N 的锚取 value[0]） */
  linkedParts: Map<string, Array<Record<string, unknown>>>
  /**
   * part 级处置分类（按 part 对象身份查——part 级发射点 handleNonTextPart 只持有 part 引用）：
   *   merged   = 已并入某摘要宿主的 compaction entry（防双发：不再发 custom entry）；
   *   dangling = summaryMessageId 指向的消息不在行集（schema 漂移信号 → custom + compaction_unlinked）。
   * 未登记 = 正常孤儿（走现状 custom 通道不计降级）或宿主被丢弃（随宿主消失，已被丢弃决策接受）。
   */
  compactionDisposition: WeakMap<Record<string, unknown>, 'merged' | 'dangling'>
}

/**
 * 单个 compaction part 的关联判据（①②③ = 原序，命中高优先判据后低优先不再参与）：
 * 返回 merged 时附带 summaryId（关联登记的宿主消息 id）。三判据注释从原预扫描循环体
 * 原样搬入——判据语义与顺序是行为契约，拆分（复杂度门禁）不改判。
 */
function compactionPartDisposition(
  msg: ZcodeMessageInput,
  part: Record<string, unknown>,
  messageIds: Set<string>,
  mergeable: Set<string>,
): { disposition: 'dangling' } | { disposition: 'merged'; summaryId: string } | undefined {
  const summaryId = asNonEmptyString(part.summaryMessageId)
  // ①（最高优先）：目标「行集内存在即可」，不限定 semantics.kind——U0 §7：指针目标
  // 167/479 是 legacy 无 semantics user 消息，限定 kind 会把 legacy 会话全量误判断链。
  // 目标在行集但宿主不可合并（summary 缺失）→ 不登记，随宿主走现状通道。
  if (summaryId !== undefined) {
    if (!messageIds.has(summaryId)) return { disposition: 'dangling' }
    if (mergeable.has(summaryId)) return { disposition: 'merged', summaryId }
    return undefined
  }
  // ②：宿主消息即 compact_summary（U0 §7：312 条 = 宿主 [compaction+text] 双 part 本体形态）
  const semantics = isRecord(msg.data.semantics) ? msg.data.semantics : undefined
  if (semantics?.kind === 'compact_summary' && mergeable.has(msg.id)) {
    return { disposition: 'merged', summaryId: msg.id }
  }
  // ③：zcode 自家判据（user 消息含无 timelineStatus 的 compaction part）。必须限定宿主
  // 策略为 compactSummary——否则关联落在一个不发射 compaction entry 的宿主上，part 被
  // 防双发抑制却无处合并 = 静默丢失。
  if (msg.data.role === 'user' && !partHasTimelineStatus(part) && mergeable.has(msg.id)) {
    return { disposition: 'merged', summaryId: msg.id }
  }
  return undefined
}

/**
 * 发射趟前的 D2 关联预扫描：先按策略 + summary.body 可用性圈出可合并宿主集，再逐消息
 * 逐 part 走三路关联判据，产出 linkedParts / compactionDisposition 两张登记表。
 * 可合并 = compactSummary 策略 ∧ summary.body 可用；不可用 → 降级路径（现状通道），
 * 关联 part 不登记、随宿主走现状 custom 通道——断链降级责任在摘要宿主，不在指针 part。
 */
export function precomputeCompactionAssociation(
  messages: ZcodeMessageInput[],
  policies: ProjectionPolicy[],
): CompactionAssociation {
  const messageIds = new Set(messages.map((msg) => msg.id))
  const mergeable = new Set<string>()
  for (const [i, msg] of messages.entries()) {
    if (policies[i] === 'compactSummary' && summaryBodyOf(msg.data) !== undefined) mergeable.add(msg.id)
  }
  const linkedParts = new Map<string, Array<Record<string, unknown>>>()
  const compactionDisposition = new WeakMap<Record<string, unknown>, 'merged' | 'dangling'>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== 'compaction') continue
      const result = compactionPartDisposition(msg, part, messageIds, mergeable)
      if (result === undefined) continue
      if (result.disposition === 'dangling') {
        compactionDisposition.set(part, 'dangling')
        continue
      }
      compactionDisposition.set(part, 'merged')
      const list = linkedParts.get(result.summaryId)
      if (list !== undefined) list.push(part)
      else linkedParts.set(result.summaryId, [part])
    }
  }
  return { linkedParts, compactionDisposition }
}
