/**
 * session-trace 域类型（设计文档 session-trace/design.md（已删除，git 可追溯）§2.1 事实表 + §3.4 渲染模型）。
 *
 * entry 类型全集 = pi 官方 10 种 + xyz-agent 自定义（handoff_marker JSONL 行 / session_end sidecar）。
 * 建模为宽松结构（id/parentId 可选）：pi 的 session 解析不做校验（session-manager.ts
 * "Session files are parsed without validation"），真实文件存在无 id 的 session_info 侧支
 * （见 __fixtures__/real-mixed-kinds.jsonl，7 行无 id）与无 id/parentId 的 handoff_marker。
 * 消费方（runtime 路径 A/B）负责产出该形状；core 不读文件、无 IO、无 Vue 依赖。
 */

/** pi session header（JSONL 首行；`getEntries()` 不含它，路径 A 由 runtime 补读——design §3.4）。 */
export interface TraceSessionHeader {
  type: 'session'
  version?: number
  id?: string
  timestamp?: string
  cwd?: string
  /** fork 溯源：源 session 已落盘时为文件路径，未落盘时为 sessionId fallback（两种形态都要覆盖）。 */
  parentSession?: string
  forkEntryId?: string
}

/**
 * message entry 的 message 体（宽松建模）。
 * role 全集：user / assistant / toolResult / bashExecution / custom（pi messages.ts；
 * bashExecution/custom 是 pi coding-agent 层经 declaration merging 扩展的 role）。
 * content 结构随 role 变化（blocks 数组 / 文本 / toolCallId+content / command+output），具名
 * 字段按 design §2.1 表声明为可选，未知字段经索引签名透传（inspector 详情需要完整原文）。
 */
export interface TraceAgentMessage {
  role: string
  content?: unknown
  /** assistant：模型侧元数据。 */
  provider?: string
  model?: string
  usage?: unknown
  stopReason?: unknown
  /** toolResult。 */
  toolCallId?: string
  toolName?: string
  isError?: boolean
  /** bashExecution。 */
  command?: string
  output?: string
  exitCode?: number
  cancelled?: boolean
  truncated?: boolean
  fullOutputPath?: string
  /** role=custom / custom_message 语义字段。 */
  customType?: string
  display?: boolean
  details?: unknown
  timestamp?: number
  [key: string]: unknown
}

/** entry 公共字段（对应 pi SessionEntryBase；id/parentId 宽松可缺）。 */
export interface TraceEntryBase {
  type: string
  id?: string
  parentId?: string | null
  timestamp?: string
}

export interface TraceMessageEntry extends TraceEntryBase {
  type: 'message'
  message: TraceAgentMessage
}

export interface TraceCompactionEntry extends TraceEntryBase {
  type: 'compaction'
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  details?: unknown
  fromHook?: boolean
}

export interface TraceBranchSummaryEntry extends TraceEntryBase {
  type: 'branch_summary'
  fromId: string
  summary: string
  details?: unknown
  fromHook?: boolean
}

/** extension 纯数据 entry（不进 LLM context）。SYSTEM 行是 customType='xyz:system-prompt' 的特判。 */
export interface TraceCustomEntry extends TraceEntryBase {
  type: 'custom'
  customType: string
  data?: unknown
}

/** extension 消息 entry（进 LLM context）。 */
export interface TraceCustomMessageEntry extends TraceEntryBase {
  type: 'custom_message'
  customType: string
  content: string | unknown
  display?: boolean
  details?: unknown
}

export interface TraceThinkingLevelChangeEntry extends TraceEntryBase {
  type: 'thinking_level_change'
  thinkingLevel: string
}

export interface TraceModelChangeEntry extends TraceEntryBase {
  type: 'model_change'
  provider: string
  modelId: string
}

export interface TraceLabelEntry extends TraceEntryBase {
  type: 'label'
  targetId: string
  label?: string
}

export interface TraceSessionInfoEntry extends TraceEntryBase {
  type: 'session_info'
  name?: string
}

/** xyz-agent runtime 直接 append 的交接标记（session-file-utils.ts persistHandedOff；无 id/parentId，不参与链——类型上可选以共享 entry 基形状，真实数据恒缺）。 */
export interface TraceHandoffMarker {
  type: 'handoff_marker'
  handedOffTo: string
  timestamp?: string
  id?: string
  parentId?: string | null
}

/** session 终态 sidecar（`.jsonl.meta.json`；runtime 读取后传入，core 不读文件）。 */
export interface TraceSessionEndMeta {
  type: 'session_end'
  outcome: 'done' | 'error' | 'stopped'
  reason?: string
  timestamp?: string
}

/** JSONL 行 entry 全集（header 含在文件直读产物中；context 计算输入会排除 header）。 */
export type TraceFileEntry =
  | TraceSessionHeader
  | TraceMessageEntry
  | TraceCompactionEntry
  | TraceBranchSummaryEntry
  | TraceCustomEntry
  | TraceCustomMessageEntry
  | TraceThinkingLevelChangeEntry
  | TraceModelChangeEntry
  | TraceLabelEntry
  | TraceSessionInfoEntry
  | TraceHandoffMarker
  | (TraceEntryBase & Record<string, unknown>)

/** 排除 header 的 entry（pi getEntries 语义；context 边界计算的输入）。 */
export type TraceSessionEntry = Exclude<TraceFileEntry, TraceSessionHeader>

/** 行 kind（design §3.4 映射表 12 种 + 损坏行占位）。 */
export type TraceRowKind =
  | 'SESSION'
  | 'SYSTEM'
  | 'USER'
  | 'ASSISTANT'
  | 'TOOL'
  | 'BASH'
  | 'NOTICE'
  | 'COMPACTED'
  | 'BRANCH'
  | 'LIFECYCLE'
  | 'DATA'
  | 'BOUNDARY'
  /** 损坏行占位（§3.1 失败路径「⚠ 无法解析的 entry」）。不属任何 kind chips 分组。 */
  | 'MALFORMED'
