// @xyz-agent/extension-protocol
// Extension GUI 渲染协议：类型 + helper 函数，零运行时依赖。
//
// 包结构：
// - core/             通用协议层（所有 extension 共用：GuiComponent + 布局原语 + 传输编码）
// - extensions/       有运行时定制逻辑的 extension（marker + helper）
//   - ask-user/       富交互（select 通道 + marker）
// - background-task   base-tool-enhance 后台任务 registry.json 文件契约（src 平级文件）
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
  StatItem,
  TreeItem,
  TreeItemIcon,
  WidgetMeta,
} from './core/types'

// ── core：通用常量 ──
export { PROTOCOL_VERSION } from './core/types'
export { GUI_WIDGET_MARKER } from './core/markers'

// ── core：通用 helper ──
export {
  isGuiCapable,
  isGuiComponent,
  isGuiRenderResult,
  guiResult,
  guiComponent,
  guiSetWidget,
  extractGui,
} from './core/helpers'

// ── core：ctx 接口 ──
export type { GuiContext } from './core/gui-context'

// ── ./extensions/ask-user：富交互（select 通道 + marker，本包内子目录）──
export type { AskUserQuestion, AskUserOption, AskUserAnswers } from './extensions/ask-user/types'
export { ASK_USER_MARKER } from './extensions/ask-user/marker'
export {
  askUserInteract,
  getAskUserAnswer,
  getAskUserOther,
  isAskUserQuestion,
} from './extensions/ask-user/helpers'

// ── session-manager 协议（agent-managed session：select 通道 + marker；实现在 extensions/universal/session-manager）──
export type {
  SessionManagerAction,
  SessionManagerRequest,
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

// ── subagent-engine 协议（引擎可发现性：engines.json 状态文件 + 引擎配置视图；实现在 extensions/universal/subagent-workflow + runtime RPC）──
export type {
  SubagentEnginesFile,
  SubagentEngineConfigView,
} from './extensions/subagent-engine/contract'
export { SUBAGENTS_ENGINES_FILENAME } from './extensions/subagent-engine/contract'

// ── background-task 协议（base-tool-enhance 后台任务 registry.json 契约；写侧实现在 extensions/universal/base-tool-enhance，收殓读侧在 runtime）──
export type {
  BackgroundTaskState,
  BackgroundTaskEndReason,
  BackgroundTaskRegistryFile,
  BackgroundTaskRegistryEntry,
} from './background-task'
export {
  BACKGROUND_TASK_REGISTRY_FILENAME,
  BASE_TOOL_ENHANCE_DIRNAME,
  BACKGROUND_TASK_REGISTRY_VERSION,
  MAX_TERMINAL_REGISTRY_ENTRIES,
  isActiveBackgroundTaskState,
  isTerminalBackgroundTaskState,
  isBackgroundTaskRegistryEntry,
} from './background-task'
