/**
 * zcode 会话语义闭集 SSOT（消息投影对齐设计 §4.2 值域表 + §6-D5）。
 *
 * 五个值域全部是闭集：zcode 升级新增枚举值时，本文件是仓内唯一单点；parity 测试锚
 * （packages/runtime/test/zcode-semantics-parity.test.ts）把期望值逐段写死，SSOT 改错
 * 或 zcode 侧值域漂移均构建期红。值逐字取自设计 §4.2 值域表（源头 = ZCode app.asar
 * 内 getConversationMessageProjectionPolicy 及其配套 schema，本机 ZCode 3.14.x / 宿主库
 * schema_migration.app_version = 0.16.5 实证，见 .tmp/dev-flow/u1-asar-parity.md 对拍报告）。
 *
 * 刻意不导出 PART_TYPES（设计 §6-D5 被否条目）：仓内无判定职责消费 part 类型闭集
 * （未知 part type 的前向兼容由 converter 既有「跳过 + 降级登记」覆盖），part 类型登记
 * 职责由 docs/architecture/session-import-sources.md §6 文档速查层承担——避免制造
 * 「闭集常量必有消费方」的假象。
 */

// ── semantics.kind（12 值）：结构化语义注解的消息类型 ────────────────────────────────
export const SEMANTICS_KINDS = Object.freeze([
  'user_prompt',
  'slash_command',
  'system_reminder',
  'background_notification',
  'subagent_notification',
  'todo_reminder',
  'rewind_notice',
  'fork_notice',
  'timeline_event',
  'compact_summary',
  'shared_context',
  'assistant_response',
] as const)

// ── semantics.origin（5 值）：消息的生产者 ───────────────────────────────────────────
export const SEMANTICS_ORIGINS = Object.freeze([
  'real_user',
  'agent_runtime',
  'system',
  'migration',
  'import',
] as const)

// ── source（顶层，12 值）：现行来源字段 ──────────────────────────────────────────────
export const MESSAGE_SOURCES = Object.freeze([
  'background_task',
  'fork',
  'goal_state_change',
  'goal-continuation',
  'plugin_reference',
  'rewind',
  'selection_side_chat',
  'subagent',
  'subagent_message',
  'todo_reminder',
  'workflow_launch',
  'shared_context',
] as const)

// ── metadata.source（旧字段，17 值）：分类器仍兼容的历史来源（asar 内 legacy 集合，
//    注意不含 'fork'——fork 走 timelineOnly 专用分支，不在 providerContextOnly 集内）──
export const LEGACY_METADATA_SOURCES = Object.freeze([
  'agent_control_message',
  'background_task',
  'goal-continuation',
  'goal_completion_verification',
  'goal_state_change',
  'plugin_reference',
  'queued_system_notification',
  'resume_goal_state',
  'resume_referenced_session_context',
  'rewind',
  'selection_side_chat',
  'subagent',
  'subagent_message',
  'target_continuation',
  'task_notification',
  'task_status',
  'todo_reminder',
] as const)

// ── 投影策略（6 值）：zcode 原生 5 策略 + taiji 侧 compactSummary 特判落点 ───────────
// zcode 原生（asar getConversationMessageProjectionPolicy 返回域）：realUserInput /
// visibleAssistant / providerContextOnly / hiddenSynthetic / timelineOnly。
// compactSummary 是 taiji 特判落点（设计 §6-D2/§6-D5）：同一条 compact_summary 消息在
// zcode 原函数返回 providerContextOnly，taiji 侧改落 compaction entry（摘要合并规格 D2），
// 故作为第六策略单列。降级态 'unclassified' 不在闭集内（设计 D4：未知枚举的显形降级，
// 不是投影策略——不参与策略 → entry 落点映射）。
export const PROJECTION_POLICIES = Object.freeze([
  'realUserInput',
  'visibleAssistant',
  'providerContextOnly',
  'hiddenSynthetic',
  'timelineOnly',
  'compactSummary',
] as const)

/** 消息投影策略：PROJECTION_POLICIES 六策略 + unclassified 降级态（D4，不在闭集）。 */
export type ProjectionPolicy = (typeof PROJECTION_POLICIES)[number] | 'unclassified'

export type SemanticsKind = (typeof SEMANTICS_KINDS)[number]
export type SemanticsOrigin = (typeof SEMANTICS_ORIGINS)[number]
export type MessageSource = (typeof MESSAGE_SOURCES)[number]
export type LegacyMetadataSource = (typeof LEGACY_METADATA_SOURCES)[number]

// ── 闭集成员判定集（数组 = 可枚举权威，Set = 分类器 O(1) 消费形态；二者同源派生）──────
export const SEMANTICS_KIND_SET: ReadonlySet<string> = new Set(SEMANTICS_KINDS)
export const SEMANTICS_ORIGIN_SET: ReadonlySet<string> = new Set(SEMANTICS_ORIGINS)
export const MESSAGE_SOURCE_SET: ReadonlySet<string> = new Set(MESSAGE_SOURCES)
export const LEGACY_METADATA_SOURCE_SET: ReadonlySet<string> = new Set(LEGACY_METADATA_SOURCES)
export const PROJECTION_POLICY_SET: ReadonlySet<string> = new Set(PROJECTION_POLICIES)
