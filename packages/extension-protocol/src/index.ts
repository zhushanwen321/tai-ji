// @zhushanwen/extension-protocol
// pi extension 跨层契约包：类型 + helper 函数 + 共享行为原语，零运行时依赖。
//
// 包结构：
// - core/                  通用协议层（所有 extension 共用：GuiComponent + 布局原语 + 传输编码 + 双模 widget helper）
// - extensions/            有运行时定制逻辑的 extension（marker + helper）
//   - ask-user/            富交互（select 通道 + marker）
//   - scheduler-create/    scheduler 创建确认共享资产（类型 + 形状/时间折叠守卫）
//   - ui-form/             统一提问表单协议（类型 + marker + 交互 helper + 守卫）
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

// ── session-manager 协议（agent-managed session：select 通道 + marker；实现在 extensions/universal/session-manager）──
export type {
  SessionManagerAction,
  SessionManagerParams,
  SessionManagerCreateParams,
  SessionManagerSendParams,
  SessionManagerHistoryParams,
  SessionManagerStatusParams,
  SessionManagerListParams,
  SessionManagerAbortParams,
  SessionManagerCreateResult,
  SessionManagerSendResult,
  SessionManagerHistoryResult,
  SessionManagerStatusResult,
  SessionManagerListResult,
  SessionManagerSessionSummary,
  SessionManagerAbortResult,
  SessionManagerErrorResult,
} from './extensions/session-manager/types'
export {
  isSessionManagerCreateParams,
  isSessionManagerSendParams,
  isSessionManagerHistoryParams,
  isSessionManagerStatusParams,
  isSessionManagerListParams,
  isSessionManagerAbortParams,
} from './extensions/session-manager/types'
export { SESSION_MANAGER_MARKER, SESSION_MANAGER_ACTIONS } from './extensions/session-manager/marker'

// ── subagent-inflight 协议（在途聚合上报：绝对计数帧经 select 通道 + marker；写侧实现在 extensions/universal/subagent-workflow host/inflight-reporter + subagent-core 出口，读侧在 runtime event-adapter u7b）──
export type { SubagentInFlightReport } from './extensions/subagent-inflight/types'
export {
  SUBAGENT_INFLIGHT_MARKER,
} from './extensions/subagent-inflight/marker'
export {
  INFLIGHT_REPORT_ACK,
  isSubagentInFlightReport,
  isInFlightReportAck,
} from './extensions/subagent-inflight/types'

// ── plugin-bridge 协议（plugin system bridge：插件工具/事件/拦截经 select 通道 + marker 桥接；实现在 extensions/taiji/plugin-bridge + runtime bridge-handler）──
export type {
  BridgeMethod,
  BridgeRequest,
  BridgeToolExecuteResponse,
  BridgeSyncPayload,
  BridgeInterceptResponse,
  BridgeErrorResponse,
} from './extensions/plugin-bridge/types'
export { BRIDGE_MARKER, BRIDGE_METHODS } from './extensions/plugin-bridge/marker'
// 回包形状守卫族（D11：marker + types + 守卫同住，自 plugin-bridge index.ts 迁入）
export {
  isBridgeErrorResponse,
  isBridgeToolExecuteResponse,
  isBridgeSyncPayload,
  isBridgeInterceptResponse,
  isSyncedTool,
} from './extensions/plugin-bridge/guards'

// ── subagent-engine 协议（引擎可发现性：engines.json 状态文件 + 引擎配置视图；实现在 extensions/universal/subagent-workflow + runtime RPC）──
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
