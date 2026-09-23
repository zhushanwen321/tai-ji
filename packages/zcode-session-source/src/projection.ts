/**
 * zcode 消息投影分类器（消息投影对齐设计 §6-D1 / §7.2——ZCode app.asar 内
 * `getConversationMessageProjectionPolicy`（minified 标识 `Ss`）的逐条移植体）。
 * 来源注记：自 runtime services/session/zcode-import dev 演进版移植（判定逻辑零改动，
 * git 可追溯），本包为现行唯一承载。
 *
 * 移植纪律：判定顺序即语义，禁止重排——设计 §6-D1 实证反例：`providerVisibility==='visible'`
 * 先于 `origin==='agent_runtime'` 判定，颠倒会把 background_notification 从
 * providerContextOnly 误判为 hiddenSynthetic。与 asar 原函数的两处有意偏离（均设计裁决）：
 * ① compact_summary 特判返回 taiji 侧落点 'compactSummary'（D2：合并 compaction part 落
 *    compaction entry），asar 原函数同分支返回 'providerContextOnly'；
 * ② 闭集检查前置返回 'unclassified'（D4：未知枚举显形降级），asar 无此概念（未知值静默
 *    落入兜底链）。
 * 除此之外逐分支与 asar 等价（asar 全量对拍 0 分歧——对拍报告属 .tmp 工作流产物不入库，
 * 实测口径以 projection.test 期望值为准）。
 *
 * asar 符号对照（移植时核对用，提取方式见 dev 演进线记录）：Ss=本函数 / ur=asRecord /
 * bs=asNonEmptyString / kN=messageSource / xN=hasModelOnlyPart / _N=isTimelineOnlyMessage /
 * RN=hasSessionForkContext / IN=hasLegacyReminderText / CN=hasLegacyNotifyText / mx=textFromParts /
 * Nf='model-only' / Uf='fork' / vN=LEGACY_METADATA_SOURCE_SET。
 *
 * 纯函数（无 IO 无时钟），输入 = message.data 与已解析 part 对象数组（宿主库 JSON 行集，
 * 外部宽形态——全部经运行时守卫读取，禁 any，malformed 字段按 undefined 语义消费）。
 */

import {
  LEGACY_METADATA_SOURCE_SET,
  MESSAGE_SOURCE_SET,
  SEMANTICS_KIND_SET,
  SEMANTICS_ORIGIN_SET,
  type ProjectionPolicy,
} from './semantics.ts'

/** 顶层 visibility 的「仅模型可见」值（asar Nf）。 */
const MODEL_ONLY = 'model-only'
/** fork 来源值（asar Uf）：命中即 timelineOnly，独立于 legacy 17 值集合。 */
const FORK = 'fork'

// ── 遗留文本特征常量（asar 内为具名常量 + 字面量，此处逐字还原；对拍校准）──────────────
// 特征源：asar IN（hasLegacySystemReminderContextText）/ CN（hasLegacyNotificationContextText）
// 的实现常量 gN/fN/hN/yN/bN/SN——精确特征集，非最小化近似。
const GOAL_CONTINUATION_PREFIX = '<system-reminder source="goal-continuation">'
const SYSTEM_REMINDER_TAG = '<system-reminder>'
const GOAL_CONTINUATION_SENTINEL = 'Continue working toward the active session goal.'
const GOAL_STATE_SENTINEL = 'Current session goal state'
const REWIND_APPLIED_TEXTS: ReadonlyArray<string> = Object.freeze([
  'Conversation rewind applied.',
  'Workspace rewind applied.',
])
const TASK_NOTIFICATION_TAG = '<task-notification>'
const SUBAGENT_NOTIFICATION_TAG = '<subagent-notification>'
/** part.metadata.source 上的 goal-continuation 通道（asar xN 第二判据）。 */
const GOAL_CONTINUATION_SOURCE = 'goal-continuation'

// ── 运行时守卫（asar ur / bs 的等价移植）─────────────────────────────────────────────

/** 对象守卫（asar ur/metadataRecord）：null / 数组 / 原始值 → undefined。 */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** 非空字符串守卫（asar bs/stringValue）：空串不作为有效值参与 `??` 兜底链。 */
function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** 闭集成员判定（非字符串值一律视为不在集内，与 Set.has 的宽松语义对齐）。 */
function inClosedSet(v: unknown, set: ReadonlySet<string>): boolean {
  return typeof v === 'string' && set.has(v)
}

// ── 辅助谓词（全部纯函数，与 asar 同名符号一一对应）─────────────────────────────────

/**
 * 消息来源四路回退（asar kN/messageSource）：data.source → metadata.source →
 * semantics.source → 首个携带 metadata.source 的 part。非空字符串守卫只挂第二路与第四路
 * （asar bs 同款）；首路与第三路 semantics.source 裸取，`??` 只跳过 null/undefined
 * （kN 函数体 2026-09-21 按对拍口径重提取核实：
 * `e.source??bs(o?.source)??e.semantics?.source`——第三路无守卫，实现与其一致）。
 * 注意：data.source 为空串时本函数返回空串（falsy），由闭集前置检查按未知值处理（asar
 * 原函数空串 falsy 直接跳过 source 分支——空串在真实数据中不存在，对拍报告核验节）。
 */
function messageSource(
  data: Record<string, unknown>,
  parts: ReadonlyArray<Record<string, unknown>>,
): unknown {
  const metadata = asRecord(data.metadata)
  const semantics = asRecord(data.semantics)
  return (
    data.source ??
    asNonEmptyString(metadata?.source) ??
    semantics?.source ??
    parts.map((p) => asNonEmptyString(asRecord(p.metadata)?.source)).find((s) => s !== undefined)
  )
}

/** 消息级 ∨ 任一 part 级 synthetic（asar 主函数末段内联判据 + part 级兜底）。 */
function isSyntheticMessage(
  data: Record<string, unknown>,
  parts: ReadonlyArray<Record<string, unknown>>,
): boolean {
  return data.synthetic === true || parts.some((p) => p.synthetic === true)
}

/**
 * model-only part 检测（asar xN/hasModelOnlyPart）：part.metadata.visibility ===
 * 'model-only'，或 part.metadata.source === 'goal-continuation'（第二通道同样把消息
 * 归入 providerContextOnly——goal 续跑提醒对用户不可见）。
 */
function hasModelOnlyPart(parts: ReadonlyArray<Record<string, unknown>>): boolean {
  return parts.some((p) => {
    const metadata = asRecord(p.metadata)
    return metadata?.visibility === MODEL_ONLY || asNonEmptyString(metadata?.source) === GOAL_CONTINUATION_SOURCE
  })
}

/** metadata.forkContext.kind === 'session_fork'（asar RN/hasSessionForkContext）。 */
function hasSessionForkContext(metadata: Record<string, unknown> | undefined): boolean {
  return asRecord(metadata?.forkContext)?.kind === 'session_fork'
}

/**
 * timeline-only 消息检测（asar _N/isTimelineOnlyMessage）。覆盖通道：
 * ① semantics.kind === 'timeline_event'（有 semantics 时主链分支②已先行返回，此路仅对
 *   「semantics 存在但六分支全落空」的形态兜底）；② data.source === 'fork'；
 * ③ metadata.source === 'fork'；④ part.type === 'timeline'；⑤ part 级 forkContext 通道；
 * ⑥ compaction part 携带 timelineStatus（part.metadata 上）或 summaryMessageId（part 本体上）。
 */
function isTimelineOnlyMessage(
  data: Record<string, unknown>,
  parts: ReadonlyArray<Record<string, unknown>>,
): boolean {
  if (asRecord(data.semantics)?.kind === 'timeline_event') return true
  const metadata = asRecord(data.metadata)
  if (data.source === FORK || asNonEmptyString(metadata?.source) === FORK) return true
  return parts.some((p) => {
    const partMetadata = asRecord(p.metadata)
    return (
      p.type === 'timeline' ||
      hasSessionForkContext(partMetadata) ||
      (p.type === 'compaction' &&
        (typeof partMetadata?.timelineStatus === 'string' || typeof p.summaryMessageId === 'string'))
    )
  })
}

/** 遗留系统提醒文本特征（asar IN/hasLegacySystemReminderContextText）——见头部常量注释。 */
function hasLegacyReminderText(parts: ReadonlyArray<Record<string, unknown>>): boolean {
  const text = textFromParts(parts).trimStart()
  return (
    text.startsWith(GOAL_CONTINUATION_PREFIX) ||
    (text.startsWith(SYSTEM_REMINDER_TAG) &&
      (text.includes(GOAL_CONTINUATION_SENTINEL) || text.includes(GOAL_STATE_SENTINEL))) ||
    REWIND_APPLIED_TEXTS.some((t) => text.includes(t))
  )
}

/** 遗留系统通知文本特征（asar CN/hasLegacyNotificationContextText）——见头部常量注释。 */
function hasLegacyNotifyText(parts: ReadonlyArray<Record<string, unknown>>): boolean {
  const text = textFromParts(parts).trimStart()
  return text.startsWith(TASK_NOTIFICATION_TAG) || text.startsWith(SUBAGENT_NOTIFICATION_TAG)
}

/** 拼接全部有效 text part 的文本（asar mx/textFromParts：ignored!==true 才计入）。 */
function textFromParts(parts: ReadonlyArray<Record<string, unknown>>): string {
  return parts
    .filter((p) => p.type === 'text' && p.ignored !== true)
    .map((p) => p.text ?? '')
    .join('')
}

// ── 主判定（顺序即语义，逐段对照设计 §7.2 伪代码 / asar Ss 函数体）───────────────────
// classifyMessage 按判定阶段拆为三个私有判定器（闭集前置 / semantics 六分支 / 无 semantics
// 兜底链）——拆分只为满足复杂度门禁，各判定器内部的分支顺序与 asar 原序逐段一致，不改判。

/**
 * 闭集检查前置（D4）：未知 kind / origin / source 即显形，不进入任何语义分支。
 * 值域 = 12 kind ∪ 5 origin ∪ (12 source ∪ 17 legacy source)。
 */
function isUnclassifiedByClosedSets(
  semantics: Record<string, unknown> | undefined,
  src: unknown,
): boolean {
  if (semantics && !inClosedSet(semantics.kind, SEMANTICS_KIND_SET)) return true
  if (semantics && !inClosedSet(semantics.origin, SEMANTICS_ORIGIN_SET)) return true
  return (
    src !== undefined &&
    !(typeof src === 'string' && (MESSAGE_SOURCE_SET.has(src) || LEGACY_METADATA_SOURCE_SET.has(src)))
  )
}

/**
 * ② 有 semantics 的六分支判定（顺序 = asar 函数体原序）。全部落空返回 undefined——
 * 调用方继续走 ③ 兜底链（「semantics 存在但六分支全落空」的形态由此穿透）。
 */
function classifyBySemanticsBranches(
  semantics: Record<string, unknown>,
  data: Record<string, unknown>,
): ProjectionPolicy | undefined {
  if (semantics.kind === 'timeline_event') return 'timelineOnly'
  if (semantics.origin === 'real_user' && data.synthetic !== true && data.visibility !== MODEL_ONLY) {
    return 'realUserInput'
  }
  if (
    data.role === 'assistant' &&
    semantics.kind === 'assistant_response' &&
    semantics.uiVisibility === 'visible' &&
    semantics.transcriptVisibility === 'visible'
  ) {
    return 'visibleAssistant'
  }
  if (semantics.providerVisibility === 'visible') return 'providerContextOnly'
  if (semantics.kind === 'fork_notice') return 'timelineOnly'
  if (
    semantics.origin === 'agent_runtime' ||
    semantics.uiVisibility === 'hidden' ||
    semantics.transcriptVisibility === 'hidden'
  ) {
    return 'hiddenSynthetic'
  }
  return undefined
}

/** ③ 无 semantics（或六分支全落空穿透）的旧数据逐级兜底（顺序 = asar 函数体原序）。 */
function classifyLegacyFallback(
  data: Record<string, unknown>,
  parts: ReadonlyArray<Record<string, unknown>>,
  src: unknown,
): ProjectionPolicy {
  if (data.visibility === MODEL_ONLY || hasModelOnlyPart(parts)) return 'providerContextOnly'
  if (isTimelineOnlyMessage(data, parts)) return 'timelineOnly'
  // fork 独立分支（asar `r === Uf`，与设计 §7.2 同位）：isTimelineOnlyMessage 只查
  // message.source / metadata.source 两通道的 fork 值，semantics.source / part 级 source
  // 通道由本分支捕获，漏掉会穿透到 realUserInput（失败模式 A 在 fork 来源复发）。
  if (src === FORK) return 'timelineOnly'
  if (typeof src === 'string' && LEGACY_METADATA_SOURCE_SET.has(src)) return 'providerContextOnly'
  if (hasLegacyReminderText(parts)) return 'providerContextOnly'
  if (isSyntheticMessage(data, parts) && hasLegacyNotifyText(parts)) return 'providerContextOnly'
  if (isSyntheticMessage(data, parts)) return 'hiddenSynthetic'
  return data.role === 'assistant' ? 'visibleAssistant' : 'realUserInput'
}

/**
 * 单条消息的投影策略判定（zcode getConversationMessageProjectionPolicy 移植体）。
 * 判定序：闭集前置（D4）→ ① compactSummary 特判 → ② semantics 六分支 → ③ 兜底链；
 * src 在判定前一次性求值（messageSource 纯函数，求值点提前不影响判定顺序与结果）。
 *
 * @param data  message.data 已解析 JSON（含 role / semantics / visibility / source /
 *              synthetic / metadata / summary 等，外部宽形态）
 * @param parts 该消息的 part.data 已解析对象数组（联合序；元素含 type / text / synthetic /
 *              metadata / summaryMessageId 等）
 * @returns 六种投影策略之一（PROJECTION_POLICIES）或 'unclassified' 降级态（D4）
 */
export function classifyMessage(
  data: Record<string, unknown>,
  parts: ReadonlyArray<Record<string, unknown>>,
): ProjectionPolicy {
  const semantics = asRecord(data.semantics)
  const src = messageSource(data, parts)

  if (isUnclassifiedByClosedSets(semantics, src)) return 'unclassified'

  // ① 压缩摘要特判（先于一切语义分支与兜底链）：现行数据带 semantics.kind，旧版数据只有
  //    data.summary 字段（§4.2 实证：167 条旧版摘要消息 role=user 且 summary 字段齐备）。
  //    返回 'compactSummary'（taiji 落点，D2）——asar 原函数此分支返回 providerContextOnly。
  if (semantics?.kind === 'compact_summary' || data.summary !== undefined) return 'compactSummary'

  // ② 有 semantics：六分支；全落空穿透到 ③
  if (semantics) {
    const bySemantics = classifyBySemanticsBranches(semantics, data)
    if (bySemantics !== undefined) return bySemantics
  }

  return classifyLegacyFallback(data, parts, src)
}
