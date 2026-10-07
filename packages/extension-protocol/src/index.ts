// @zhushanwen/extension-protocol
// pi extension 跨层契约包：类型 + helper 函数 + 共享行为原语，零运行时依赖。
//
// 包结构：
// - core/                  通用协议层（所有 extension 共用：GuiComponent + 布局原语 + 传输编码 + 双模 widget helper）
// - extensions/            有运行时定制逻辑的 extension（marker + helper；子协议模块不在此逐名列举，
//                          唯一清单 = 本文件导出段各 `── ./extensions/<name>` 注释，防双副本漂移）
// - pending-entries        pending 事件流差集核心（纯算法，落盘形态语义）
// - background-task        base-tool-enhance 后台任务 registry.json 文件契约（src 平级文件）
//
// 含 node 内建依赖的后台任务行为原语（进程处置 / registry 文件 IO / output tail）
// 经独立子出口 `./background-task`（src/background-task-entry.ts）暴露，**不进
// index 桶出口**——renderer/core 等浏览器消费面结构性不触达 node 内建。
//
// core 只保留结构性、中性的通用原语（card/stats-line/progress-bar/list-tree/
// columns/tab-bar/ansi-text）。特定 extension 的领域数据结构不进协议层——
// extension 用通用原语组合表达，形状太特殊时走 custom 通道。

// ── core：通用类型 ──
export type {
  GuiComponent,
  GuiComponentType,
  GuiComponentProps,
  GuiRenderResult,
  PlanDocMeta,
  PlanReviewComment,
  PlanReviewDecision,
  PlanReviewRequest,
  PlanReviewResponse,
  StatItem,
  TreeItem,
  TreeItemIcon,
  WidgetMeta,
} from './core/types'

// ── core：通用常量 ──
export { PROTOCOL_VERSION } from './core/types'
export { GUI_WIDGET_MARKER, PLAN_REVIEW_MARKER } from './core/markers'

// ── core：通用 helper ──
export {
  isGuiCapable,
  isGuiComponent,
  isGuiRenderResult,
  guiResult,
  guiComponent,
  guiSetWidget,
  setWidgetDual,
  validateWidgetIconPaths,
  extractGui,
  firstContentText,
} from './core/helpers'
export type { DualWidgetContent, WidgetIconPathsValidation, WidgetIconPathsRejection } from './core/helpers'

// ── core：ctx 接口 ──
export type { GuiContext } from './core/gui-context'

// ── core：select+marker 通道 RPC 原语（D8：传输核 + 失败折叠契约 + 错误回包形状单源）──
export type { MarkerRpcResult, MarkerRpcOptions, ChannelErrorResult } from './core/select-rpc'
export { callMarkerRpc, isChannelErrorResult, formatChannelErrorText } from './core/select-rpc'

// ── ./extensions/ask-user：富交互解码契约（GUI 提问已迁统一表单协议 ui-form；askUserInteract 已退役，ASK_USER_MARKER 留作 legacy 帧识别随 D7 窗口末清理）──
export type { AskUserQuestion, AskUserOption, AskUserAnswers } from './extensions/ask-user/types'
export { ASK_USER_MARKER } from './extensions/ask-user/marker'
export {
  getAskUserAnswer,
  getAskUserOther,
  isAskUserQuestion,
} from './extensions/ask-user/helpers'

// ── ./extensions/scheduler：scheduler 任务条目契约 + 折叠器 + 时间格式化（扩展与插件同源单实现；entry 实现在 extensions/universal/scheduler，写侧经 /schedule 扩展命令，本分组只承载纯契约与纯函数）──
export type {
  ScheduleSpec,
  TaskKind,
  TaskStatus,
  ScheduledTask,
  ExecutionRecord,
  TaskSnapshot,
  SchedulerEntryOp,
} from './extensions/scheduler/types'
export {
  TASK_ENTRY_TYPE,
  HISTORY_LIMIT,
  appendExecutionRecord,
  snapshotToTask,
  SCHEDULER_MODAL_VIEW_ID,
} from './extensions/scheduler/types'
export type { SchedulerEntryLike, ReplayFoldOptions } from './extensions/scheduler/replay'
export { replayFoldEntries } from './extensions/scheduler/replay'
export {
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  formatDuration,
  formatSchedule,
  formatRelativeTime,
} from './extensions/scheduler/format'

// ── ./extensions/scheduler-create：scheduler 创建确认的共享资产（定制交互 helper 已随统一表单协议退役；ScheduleDraft/FormResult 类型 + 形状/时间折叠守卫；实现在 extensions/universal/scheduler——交互入口 uiFormInteract，runtime event-adapter 保留 legacy 分支至退役窗口）──
export type {
  ScheduleKind,
  ScheduleDraft,
  ScheduleFormResult,
} from './extensions/scheduler-create/types'
export { SCHEDULE_CREATE_MARKER } from './extensions/scheduler-create/marker'
export {
  isScheduleDraft,
  isScheduleFormResult,
  dateToOnceCron,
  onceCronToDate,
} from './extensions/scheduler-create/helpers'

// ── ./extensions/plan：plan 模式生命周期状态机（D1：states/events/transition/derivePhase）+
// 审阅回传值域契约（D3①⑤/D9③：值域守卫 + error envelope + selfReview 有界截断）+
// 旧 entry legacy 读取（D-B4-1：lifecycle/resumeHint 映射 + entry customType 常量单源）——
// 纯数据 + 纯函数零 pi 依赖，pi-plan 扩展（转移接管）/ runtime（派生归一）/ renderer（呈现映射）三层共用；
// 消费面勾销锚 = src/extensions/plan/consumers.md ──
export type {
  PlanLifecycleState,
  PlanLifecycleEvent,
  PlanTransitionResult,
  PlanPhase,
} from './extensions/plan/state-machine'
export {
  PLAN_LIFECYCLE_STATES,
  PLAN_LIFECYCLE_EVENTS,
  transition,
  derivePhase,
} from './extensions/plan/state-machine'
export type { PlanReviewResponseEnvelope } from './extensions/plan/review-contract'
export {
  PLAN_SELF_REVIEW_MAX_BYTES,
  truncateSelfReview,
  isPlanReviewRequest,
  isPlanReviewResponse,
  parsePlanReviewResponse,
} from './extensions/plan/review-contract'
export {
  PLAN_STATE_CUSTOM_TYPE,
  readLifecycleState,
  readResumeHint,
} from './extensions/plan/legacy-entries'

// ── ./extensions/ui-form：统一提问表单协议（plan / scheduler / ask-user 三方提问的统一入口：select 通道 + marker + 类型化问题集；设计 ui-presentation-protocol，ask-user / scheduler-create 两定制协议随 u5/u6 迁移退役）──
export type {
  FormQuestion,
  ChoiceQuestion,
  TextQuestion,
  ScheduleQuestion,
  FormOption,
  FormAnswers,
} from './extensions/ui-form/types'
export { UI_FORM_MARKER } from './extensions/ui-form/marker'
export { uiFormInteract } from './extensions/ui-form/helpers'
export type {
  UiFormInteractResult,
  UiFormInteractOptions,
} from './extensions/ui-form/helpers'
export { isFormQuestion, isFormAnswers } from './extensions/ui-form/guards'

// ── ./extensions/session-manager：agent-managed session 协议（select 通道 + marker；实现在 extensions/universal/session-manager）──
export type {
  SessionManagerAction,
  SessionManagerParams,
  SessionManagerCreateParams,
  SessionManagerSendParams,
  SessionManagerHistoryParams,
  SessionManagerStatusParams,
  SessionManagerListParams,
  SessionManagerAbortParams,
  SessionManagerWatchParams,
  SessionManagerCreateResult,
  SessionManagerSendResult,
  SessionManagerHistoryResult,
  SessionManagerStatusResult,
  SessionManagerListResult,
  SessionManagerSessionSummary,
  SessionManagerAbortResult,
  SessionManagerErrorResult,
  SessionManagerWatchReason,
  SessionManagerWatchRespondPayload,
} from './extensions/session-manager/types'
export {
  isSessionManagerCreateParams,
  isSessionManagerSendParams,
  isSessionManagerHistoryParams,
  isSessionManagerStatusParams,
  isSessionManagerListParams,
  isSessionManagerAbortParams,
  isSessionManagerNotifyId,
  isSessionManagerWatchParams,
  isSessionManagerWatchRespondPayload,
} from './extensions/session-manager/types'
export { SESSION_MANAGER_MARKER, SESSION_MANAGER_ACTIONS } from './extensions/session-manager/marker'

// ── ./extensions/subagent-inflight：在途聚合上报协议（绝对计数帧经 select 通道 + marker；写侧实现在 extensions/universal/subagent-workflow host/inflight-reporter + subagent-core 出口，读侧在 runtime event-adapter u7b）──
export type { SubagentInFlightReport } from './extensions/subagent-inflight/types'
export {
  SUBAGENT_INFLIGHT_MARKER,
} from './extensions/subagent-inflight/marker'
export {
  INFLIGHT_REPORT_ACK,
  isSubagentInFlightReport,
  isInFlightReportAck,
} from './extensions/subagent-inflight/types'

// ── ./extensions/subagent-journal：journal 事件推送协议（事件报告帧经 select 通道 + marker；
// 写侧实现在 extensions/universal/subagent-workflow host/journal-reporter + subagent-core 落盘出口
// notifyJournalAppended，读侧在 runtime event-adapter marker 路由 → session-records 派生视图）──
export type {
  SubagentJournalDomain,
  SubagentJournalEvent,
  SubagentJournalReport,
} from './extensions/subagent-journal/types'
export {
  SUBAGENT_JOURNAL_MARKER,
} from './extensions/subagent-journal/marker'
export {
  JOURNAL_REPORT_ACK,
  isSubagentJournalReport,
  isJournalReportAck,
} from './extensions/subagent-journal/types'

// ── ./extensions/subagent-notify：subagent-workflow 通知通道词表（custom_message customType 单源：
// 写侧 = 壳 sendMessage / subagent-core notifier+ledger，读侧 = shared/runtime/core；
// 等值锁在壳 __tests__/contract.notify-custom-types.test.ts）──
export {
  WORKFLOW_RESULT_CUSTOM_TYPE,
  SUBAGENT_BG_NOTIFY_CUSTOM_TYPE,
  SUBAGENT_DIRECTIVE_CUSTOM_TYPE,
} from './extensions/subagent-notify/custom-types'

// [pi1-disposition-chat-flow D7①] plugin-bridge 协议段（marker/types/guards + 桶导出）
// 随 plugin-bridge 整体退役删除；select 通道原语（core/select-rpc.ts）为公共层保留。

// ── ./extensions/subagent-engine：引擎可发现性协议（engines.json 状态文件 + 引擎配置视图；实现在 extensions/universal/subagent-workflow + runtime RPC）──
export type {
  SubagentEnginesFile,
  SubagentEngineConfigView,
} from './extensions/subagent-engine/contract'
export { SUBAGENTS_ENGINES_FILENAME } from './extensions/subagent-engine/contract'

// ── pending-entries 差集核心（pending 事件流落盘形态语义：register 去重 + unregister 抵消；纯算法零 node 依赖）──
export type {
  CollectPendingIdsOptions,
  MappedPendingStatus,
  PendingEntriesScan,
} from './pending-entries'
export {
  PENDING_REGISTER_ENTRY_TYPE,
  PENDING_UNREGISTER_ENTRY_TYPE,
  scanPendingEntries,
  applyPendingDiff,
  collectActivePendingIds,
  mapReasonToStatus,
} from './pending-entries'

// ── background-task 协议（base-tool-enhance 后台任务 registry.json 契约；写侧实现在 extensions/universal/base-tool-enhance，收殓读侧在 runtime）──
// 行为原语（进程处置 / registry 文件 IO / output tail）不在此桶出口——经子出口
// `./background-task`（background-task-entry.ts）暴露，见文件头说明。
export type {
  BackgroundTaskState,
  BackgroundTaskEndReason,
  BackgroundTaskRegistryFile,
  BackgroundTaskRegistryEntry,
} from './background-task'
export {
  BACKGROUND_TASK_REGISTRY_FILENAME,
  BASE_TOOL_ENHANCE_DIRNAME,
  BACKGROUND_TASK_ID_PREFIX,
  BACKGROUND_TASK_REGISTRY_VERSION,
  MAX_TERMINAL_REGISTRY_ENTRIES,
  isActiveBackgroundTaskState,
  isTerminalBackgroundTaskState,
  isBackgroundTaskRegistryEntry,
} from './background-task'
