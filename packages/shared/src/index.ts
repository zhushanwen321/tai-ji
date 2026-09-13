export type {
  ClientMessageType, ClientMessage, ClientMessageMap,
  SetProviderData,
  ServerMessageType, ServerMessage, ServerMessageMap, ServerMessageMapBase, ServerMessageUnion,
  ReplyPayloadMap,
  BatchDeleteResult,
  RenameMode,
  SystemPromptConfig,
  CommandSourceInfo,
  WorktreeErrorCode, WorktreeUnknownErrorCode, WorktreeEnvelopeCode,
  TerminalConfig, TerminalErrorCode, TerminalUnknownErrorCode, TerminalEnvelopeCode,
  SkillCacheScope, SkillCacheInvalidatedPayload,
  SessionTraceHeaderPayload, SessionTraceMalformedLine, SessionTraceSessionEndPayload,
  SessionViewSnapshot,
  WatchdogMemoryLevel, WatchdogMemoryPressurePayload,
  RollingRestartState, RollingRestartReason, RollingRestartInflightSummary,
  RollingRestartDeferredPayload, RollingRestartCountdownPayload, RollingRestartForcedPayload,
  RollingRestartStatusPayload,
  ReattachDeferReason, ReattachDeferredPayload,
  ConnectionTestResultRow,
} from './protocol'
export { isMessage, isSessionSummary, isSubagentRecord } from './protocol'
export type {
  MessageRole, MessageStatus, ToolCallStatus,
  ToolCall, ThinkingBlock, ContentBlockType, ContentBlock, Usage, Message,
  FileChangeStatus, FileChange, ChangeSetStatus, ReviewDecision,
  CompactionSummary, BranchSummary, SteerFollowUpMode,
  BgNotifyRecord, BgNotifyDetails,
  SubagentDirectiveData,
  PiRespawnNoticeVariant,
} from './message'
export { parseBgNotifyDetails, COMPLETE_NOTIFY_CUSTOM_TYPES, SUBAGENT_DIRECTIVE_CUSTOM_TYPE, parseSubagentDirective, PI_RESPAWN_NOTICE_CUSTOM_TYPE, parseRespawnNoticeVariant } from './message'
// w21 pi-entry：pi session entry wire 类型（runtime 实时重构 ↔ core reducer ↔ protocol payload 三方共用）
export type {
  PiEntry, PiEntryBase, PiMessageEntry, PiMessageBody,
  PiCustomEntry, PiLabelEntry, PiCompactionEntry, PiBranchSummaryEntry, PiCustomMessageEntry,
  PiToolCallEntryForm,
} from './pi-entry'
export type { Segment } from './segments'
export { segmentsToText, textToSegments, segmentsToPrompt, normalizeContent, normalizeSegmentOrder, needsBoundarySpace } from './segments'
export type { SegmentsMetadataFile, SegmentsMetadataEntry } from './message-metadata'
export type {
  SessionStatus, SessionSummary, SessionGroup,
} from './session'
export type {
  ProviderStatus, ProviderInfo, BuiltinProviderTemplate, BuiltinOAuthConfig, ModelInfo,
  SkillInfo, AgentInfo,
  ScanSourceType, ScannedSkillInfo, ScannedAgentInfo,
  DiscoveryConfig, DiscoveryConfigV1, SkillDirConfig,
  ProviderId, ModelId,
} from './provider'
// v1→v2 discovery.json 迁移纯函数（discovery-migrate.ts）
export { migrateDiscoveryV1ToV2 } from './discovery-migrate'
export type { ToolPermission, ThemeMode, ThemePreset } from './settings'
export type {
  PanelLeaf, WindowState,
} from './panel'
// LLM 重试配置域（类型 + D8 合法域常量 + 校验纯函数，renderer 表单与 runtime 写入侧共用）
export type { LlmRetryConfig, LlmRetryProviderConfig } from './llm-retry'
export { LLM_RETRY_DOMAIN, validateLlmRetryConfig } from './llm-retry'
// RPC 超时校准链常量 SSOT（timeout-slow-flow-wallclock D2/D3，renderer/runtime 双端编译期对齐）
export { BASH_RPC_TIMEOUT_MS, COMPACT_RPC_TIMEOUT_MS, RENDERER_RPC_MARGIN_MS } from './timeouts'
export * from './extension'
export * from './git'
export * from './plugin'
export { BASE_PORT, DEV_PORT_OFFSET, MAX_PORT, ENV_WHITELIST_PREFIXES, AMBIENT_ENV_NAMES, SUBAGENT_TOOL_NAMES, WORKFLOW_TOOL_NAMES, SUBAGENT_RECORD_CUSTOM_TYPE, WORKFLOW_RECORD_CUSTOM_TYPE, PROVIDER_API_TYPES, KNOWN_PI_API_TYPES, SYSTEM_PROMPT_MAX_LENGTH, PRESET_SKILL_DIRS, PRESET_AGENT_DIRS, PRESET_EXTENSION_DIRS, IMAGE_LIMITS, MAX_WS_PAYLOAD_BYTES, PLUGIN_NOTIFY_LIMITS, UI_TOAST_LIMITS, ENGINE_LAUNCH_ENV_KEYS, XYZ_RUNTIME_PI_RECLAIM_IDLE_MS, XYZ_RUNTIME_PI_RECLAIM_TICK_MS, XYZ_RUNTIME_PI_RECLAIM_VIEWED_WINDOW_MS, DEFAULT_PI_RECLAIM_IDLE_MS, DEFAULT_PI_RECLAIM_TICK_MS, DEFAULT_PI_RECLAIM_VIEWED_WINDOW_MS } from './constants'
export type { ProviderApiType } from './constants'
// 崩溃韧性共享契约 SSOT（docs/design/crash-resilience.md §3.3，实施计划 u-foundation：
// 出站帧守卫阈值 D3 / 全量读预检阈值 D5 / 历史双预算 D4 / 日志保留期 D6-⑦）。
// 注意：readLogKeepDays 是 Node-only 函数（函数体访问 process.env）——本 barrel 被
// renderer（浏览器）整包 import，import 本身安全（constants.ts 模块顶层无 process 访问），
// 但 renderer 严禁调用（process 未定义 ReferenceError）；main / runtime 专用，
// 完整警示见 constants.ts 内 JSDoc。
export { OUTBOUND_FRAME_WARN_BYTES, OUTBOUND_FRAME_TRUNCATE_BYTES, READ_PRECHECK_MAX_BYTES, HISTORY_BUDGET, DEFAULT_LOG_KEEP_DAYS, readLogKeepDays, RUNTIME_PLANNED_EXIT_CODE } from './constants'
// Electron IPC 通道名 SSOT（crash-resilience u-foundation：renderer-log 上报通道 D2 /
// image-cache 落盘通道族首成员 D6-⑨）；既有通道仍内联于 preload/main 不在此收敛，
// 存量边界说明见 ipc-channels.ts 头注释。
export { RENDERER_LOG, IMAGE_CACHE_WRITE, DEBUG_RUN_LOG_RETENTION, DIAGNOSTICS_EXPORT_BUNDLE } from './ipc-channels'
// renderer-log 通道 payload 类型（crash-resilience u2：preload ElectronAPI 签名与 main
// handler 校验共用同一形态声明，防两端漂移；main 侧仍做运行时再校验，见 ipc-payloads.ts 头注释）。
export type { RendererErrorSource, RendererMemorySnapshot, RendererLogPayload } from './ipc-payloads'
// image-cache 落盘通道 payload 类型（crash-resilience u7 D6-⑨：core 编排层 / preload
// ElectronAPI 签名 / main handler 校验三方共用同一形态声明，防漂移）。
export type {
  ImageCacheWriteImage,
  ImageCacheWritePayload,
  ImageCacheWriteImageResult,
  ImageCacheWriteResult,
} from './ipc-payloads'
// debug:run-log-retention 通道返回类型（crash-resilience A9② 验收调试口：preload
// ElectronAPI 签名与 main handler 返回共用同一形态声明，防漂移）。
export type { DebugRunLogRetentionResult } from './ipc-payloads'
// diagnostics:export-bundle 通道契约（crash-forensics u3a：请求 payload / 三态返回类型 /
// 知情提示文案常量——main handler、preload ElectronAPI 与 u3b renderer 确认对话框三方共用）。
export {
  DIAGNOSTIC_EXPORT_PRIVACY_NOTICE,
  type DiagnosticExportBundlePayload,
  type DiagnosticExportSummary,
  type DiagnosticExportError,
  type DiagnosticExportBundleResult,
} from './ipc-payloads'
// 崩溃台账事件 Schema SSOT（docs/architecture/crash-forensics-and-watchdog.md §3.3 D1，
// 实施计划 u1a：layer/event/reason 枚举 + 字段集 + writer 接口——u1b runtime 与
// u1c main 两 writer 共用，禁止复制定义；纯类型/常量无 node 依赖，barrel 安全）。
export type {
  CrashJournalLayer,
  CrashJournalEventName,
  CrashJournalReason,
  CrashJournalMemPressure,
  CrashJournalEvent,
  CrashJournalFileRole,
  CrashJournalWriterOptions,
  CrashJournalWriter,
} from './crash-journal-schema'
export { CRASH_JOURNAL_LAYERS, CRASH_JOURNAL_EVENTS, CRASH_JOURNAL_KNOWN_REASONS } from './crash-journal-schema'
// 出站 env 契约 SSOT + 子进程 env 构建器（纯常量/纯函数无 node 依赖，renderer barrel 安全）。
// main 进程 safe-env 薄封装与 runtime infra/spawn-env.ts 门面均经此消费。
export type { BuildOutboundChildEnvOptions, SpawnEnvForwardEntry } from './spawn-env-contract'
export {
  SPAWN_ENV_OUTBOUND_DENY_LIST,
  SPAWN_ENV_FORWARD_REFERENCE,
  composeChildEnvBase,
  buildOutboundChildEnv,
} from './spawn-env-contract'
export { DEFAULT_PI_SYSTEM_PROMPT, DEFAULT_PI_SYSTEM_PROMPT_VERSION } from './pi-default-prompt'
// 推荐扩展列表 SSOT（runtime 读取，前端经 extension.recommended WS 拉取）
// 带类型断言：空 JSON [] 会被 TS 推断为 never[]，断言为 RecommendedExtension[] 保证未来追加条目时类型正确
import recommendedExtensionsRaw from './recommended-extensions.json'
import type { RecommendedExtension } from './extension'
const recommendedExtensions = recommendedExtensionsRaw as RecommendedExtension[]
export { recommendedExtensions }
// 强制安装扩展列表 SSOT（runtime boot 时自动安装+升级）
// 带类型断言：JSON import 默认推断为宽泛类型，断言为 MandatoryExtension[] 保证 tier 字段拼写错误编译期可捕获
import mandatoryExtensionsRaw from './mandatory-extensions.json'
import type { MandatoryExtension } from './extension'
const mandatoryExtensions = mandatoryExtensionsRaw as MandatoryExtension[]
export { mandatoryExtensions }
// 注意：paths.ts（getDataDir/getPiAgentDir）刻意不在此 barrel 导出。
// 它们依赖 node:os / node:path，而本 barrel 被 renderer（浏览器）整包 import。
// Node-only 消费方（main/runtime）从子路径 import：'@xyz-agent/shared/paths'
export * from './file-tree'
export type { RecentWorkspaceRecord } from './workspace'
export type { Project, ProjectStoreState } from './project'
export type { SubagentRecord, SubagentStatus, ClosedDisplayStatus } from './subagent'
// 导入 pi 会话 RPC 契约（设计 docs/design/import-session.md（已删除，git 可追溯）§3.3 D5，runtime/renderer 两端共同 import）
export type {
  ImportWarning, ImportErrorCode,
  ImportCandidatesRequest, ImportCandidatesReply, ImportCandidate, ImportCandidateDir,
  ImportRequest, ImportReply,
} from './import-session'
// 虚拟 session ID 工厂（subagent 三段式 / agent call 两段式）——跨层协议级 key 约定 SSOT
export {
  SUBAGENT_PREFIX,
  subagentVirtualId,
  isSubagentVirtualId,
  extractSubagentId,
  extractMainSessionId,
  AGENTCALL_PREFIX,
  agentCallVirtualId,
  isAgentCallVirtualId,
  extractAgentCallSessionId,
} from './virtual-session-id'
// subagent.stream_delta 帧父 session 解析（idle-refresh 桥接纯函数，双通道形态归一）
export { resolveSubagentParentSessionId } from './subagent-frame'
// Coding Plan 额度查询类型
export type {
  QuotaWindow,
  QuotaWins,
  NormalizedQuotaRow,
  ProviderQuotaFetcher,
  QuotaAuthKind,
  QuotaFetchFailureReason,
  QuotaFetchOutcome,
  QuotaFetcherConfig,
  QuotaWorkspaceNormalizeResult,
  // 凭证来源与 configure payload（D3/§7.1，coding-plan-quota-config-ux）
  QuotaCredentialSource,
  QuotaConfigurePayload,
} from './quota-types'
export { normalizeQuotaWorkspaceUrl, resolveQuotaCredentialSource, supportsExclusiveCredential } from './quota-types'
export type { QuotaPreset } from './quota-presets'
export { QUOTA_PRESETS, matchQuotaPreset } from './quota-presets'
// normalizeSubagentStatus 已下沉至 runtime（packages/runtime/src/services/session/subagent-status.ts，
// 单消费者归位）；shared 仅保留 renderer 消费的 deriveClosedDisplay 展示派生。
// SUBAGENT_STATUS_ALL：枚举值全集（B3 护栏，renderer bucket 测试的全集覆盖矩阵数据源）。
// SUBAGENT_OUTCOME_PLACEHOLDER：③级占位文案（D6 三端锚点 SSOT 值，core 同值字面量 /
// runtime 钉子断言 / renderer 思考行判据的消费入口）。
// projectSubagentExecutionStatus：占用两态投影（U8 旧数据只读兼容——legacy 六值 →
// running|idle，renderer U8b 分桶/过滤器对新旧词汇统一判定的映射 SSOT）。
export { deriveClosedDisplay, SUBAGENT_STATUS_ALL, SUBAGENT_OUTCOME_PLACEHOLDER, projectSubagentExecutionStatus } from './subagent'
export type {
  WorkflowRunStatus,
  WorkflowDoneReason,
  WorkflowAgentCall,
  WorkflowRunRecord,
} from './workflow'
// pi-preset 用具名导出（S-SH-3）：避免 export * 导致的命名冲突与 tree-shaking 不友好。
// 所有 type / const / 运行时守卫均显式列出，新增导出时同步在此登记。
export type {
  ToolMode,
  ExtensionMode,
  ThinkingLevel,
  PiLaunchPreset,
  PresetUsageEntry,
  PiPresetsFile,
  PresetExportPayload,
} from './pi-preset'
export {
  BUILTIN_TOOLS,
  BUILTIN_PRESET_IDS,
  DEFAULT_PRESETS,
  PI_THINKING_LEVELS,
  isPiLaunchPreset,
} from './pi-preset'
export type { UpdateSource, UpdateSourcePref, LatestReleaseInfo, ReleaseAsset, UpdateStage, UpdateState, IProxyConfig, UpdateSettings, UpdateErrorPayload, ProxyTestResult, LaunchResultStatus, LaunchResult, UpdateCheckResult, UpdateInstallResult } from './update'
export { LAUNCH_RESULT_STATUSES, UPDATE_STALE_RELEASE } from './update'
// 用量统计类型（W1 数据层）
export type { UsageMetrics, UsageRow, UsageStatsResult } from './usage-stats'
// Composer 生成指标类型 SSOT（docs/design/composer-gen-stats.md §3.4；帧 session.stats_update /
// RPC session.getGenStats 的 type→payload 登记在 protocol.ts，形状经 GenStatsFrame 引用防漂移）
export type { GenStatsSpeed, GenStatsCacheRatio, GenStatsFrame } from './gen-stats'
// 迁移功能（从其他 agent 迁移配置）类型
export type {
  ProviderSource,
  AgentSource,
  SourceDetectResult,
  ProviderPreviewItem,
  ProviderPreviewOrphanItem,
  ProviderImportPreview,
  ProviderImportedItem,
  ProviderImportResult,
} from './migration'
// 系统提示音默认映射 SSOT（main + renderer 共享，纯数据/类型无 node 依赖）
export type { SoundPlatform, SoundKind } from './sound-defaults'
export { DEFAULT_SUCCESS_PLATFORM, DEFAULT_ERROR_PLATFORM, getDefaultSound } from './sound-defaults'
// composer 多 skill 注入的标记语法与预算估算 SSOT（设计 docs/design/composer-multi-skill-injection.md
// §3.3 D3/D6/D7；runtime 注入器、序列化/反解析、scripts 探针三方同源消费，纯文本语法层无 node 依赖）
export type { ParsedSkillMarker, ParsedSkillsBlock, SkillDataBlockRange } from './skill-marker'
export {
  SKILL_MARKER_TAG,
  SKILLS_BLOCK_TAG,
  SKILL_DATA_BLOCK_TAG,
  SKILL_FALLBACK_GUIDANCE,
  CONTEXT_WINDOW_RATIO,
  CJK_TOKENS_PER_CHAR,
  NON_CJK_CHARS_PER_TOKEN,
  CODE_DENSE_NON_CJK_RATIO,
  CODE_DENSE_NON_CJK_CHARS_PER_TOKEN,
  CJK_CHAR_RE,
  escapeSkillAttr,
  unescapeSkillAttr,
  buildSkillMarker,
  parseSkillMarkers,
  buildSkillsFallbackBlock,
  parseSkillsFallbackBlocks,
  buildSkillDataBlockExpansions,
  buildSkillDataBlockFallback,
  findSkillDataBlockRange,
  estimateTokens,
} from './skill-marker'
