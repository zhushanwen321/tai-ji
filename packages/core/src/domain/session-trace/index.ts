/**
 * session-trace 域入口 —— pi session JSONL 的 trace 台账纯函数层（design §5 单元 2）。
 *
 * 三块能力：entry→TraceRow 映射（A21）、context 边界计算 + 影子化标记（A22，复刻
 * pi buildContextEntries 语义）、过滤（A23）。无 IO、无 Vue 依赖（runtime 路径 B 与
 * renderer TraceView 共用；活跃路径 A 的 leafId 由 runtime 传入）。
 */
export { parseSessionTraceJsonl } from './parse-jsonl'
export type { ParsedSessionTraceLine } from './parse-jsonl'
export {
  buildTraceSessionPath,
  computeTraceContextBoundary,
  convertsToContextMessages,
} from './context-boundary'
export type { TraceContextBoundary } from './context-boundary'
export {
  mapSessionTraceRows,
  resolveTraceRowKind,
  SYSTEM_PROMPT_CUSTOM_TYPE,
} from './trace-rows'
export type { SessionTraceInput, TraceRow, TraceRowMeta } from './trace-rows'
export { blockHeadline, extractContentBlocks } from './trace-blocks'
export type { TraceContentBlock } from './trace-blocks'
export { filterTraceRows, TRACE_KIND_GROUPS } from './trace-filter'
export type { TraceFilterState, TraceKindGroup } from './trace-filter'
export {
  extractSessionIdFromTraceFilePath,
  isTraceParentSessionPath,
  resolveTraceParentSession,
} from './parent-session'
export type { TraceParentSessionCandidate } from './parent-session'
export type {
  TraceAgentMessage,
  TraceBranchSummaryEntry,
  TraceCompactionEntry,
  TraceCustomEntry,
  TraceCustomMessageEntry,
  TraceEntryBase,
  TraceFileEntry,
  TraceHandoffMarker,
  TraceLabelEntry,
  TraceMessageEntry,
  TraceModelChangeEntry,
  TraceRowKind,
  TraceSessionEndMeta,
  TraceSessionEntry,
  TraceSessionHeader,
  TraceSessionInfoEntry,
  TraceThinkingLevelChangeEntry,
} from './types'
