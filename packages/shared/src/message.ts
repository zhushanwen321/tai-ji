import type { Segment } from './segments'

export type MessageRole = 'user' | 'assistant' | 'system'

/** steer / follow-up 发送模式（pushPending / drainPending / abortPending 共用）。
 *  从 Message.sendMode 的子集抽出，避免 'steer' | 'follow-up' 字面量在三处手写漂移。 */
export type SteerFollowUpMode = 'steer' | 'follow-up'

/**
 * 完成通知类 customType SSOT（conversation-renderer-model-unification §3.3.2：
 * 黑名单已删，收敛为 display 单一判别）。
 *
 * 这些 custom_message 触发 pi triggerTurn 唤醒 agent 在后续 turn 处理结果——对用户是噪声，
 * 结果由 agent 后续 turn 体现。两条消费通路共用此 SSOT，避免字面量漂移：
 * - core apply-entry custom_message case：完成通知类覆写 display:false（实时 customStart
 *   喂 entry 与重开 replay 同一个 reducer 覆写点，2026-08-19 custom 双管线收敛；实时侧
 *   registry customStart 只构造 entry，不再独立覆写）
 * - runtime mapSessionEntries / entry-tree-builder：对称覆写 display:false（历史链路，方案 Z）
 */
export const COMPLETE_NOTIFY_CUSTOM_TYPES = new Set(['subagent-bg-notify', 'workflow-result'])

/**
 * subagent-directive customType SSOT（composer 四符号 `@` 定向对话，设计
 * docs/architecture/composer-symbol-system.md §3.3.3）。
 *
 * 用户经 @ subagent chip 发送的定向消息：subagent-workflow extension（/subagents message
 * 命令面）在 deliverMessage 成功后经 pi.sendMessage 落 custom_message entry——
 * customType 即本常量，content=定向文本原文，details={subagentId, slug, direction:'user'}，
 * display:false（false 是 pi TUI 渲染语义；xyz-agent 消费侧另行决定显隐，见
 * parseSubagentDirective 消费点）。留痕进主 agent 上下文但不 triggerTurn（留痕 ≠ 处理，§3.3.8）。
 *
 * 与 extension 端写入字符串严格一致（commit 21578c74f），改名需同步 extension + 测试。
 */
export const SUBAGENT_DIRECTIVE_CUSTOM_TYPE = 'subagent-directive'

/**
 * 定向消息数据——live 广播（subagent.directive payload 去掉 sessionId）与 reload 聊天流
 * 消息项（custom system message 的 content + details）的公共字段。两链路共用
 * parseSubagentDirective 单点解析，live ≡ reload 字段一致性构造性成立（关键规则 9）。
 */
export interface SubagentDirectiveData {
  subagentId: string
  slug: string
  /** 方向：'user' = 用户 → subagent（本期唯一方向，extension details.direction 同源） */
  direction: 'user'
  /** 定向文本原文（custom_message entry 的 content） */
  text: string
}

/**
 * 防御性解析 subagent-directive custom message → 定向数据。
 *
 * 消费点（单点解析，避免多处字段读取漂移——parseBgNotifyDetails 同款范式）：
 * - runtime live：event-adapter 组装 subagent.directive 广播 payload
 * - runtime reload：session-entry-mapper 对该 customType 的 display 覆写判定
 * - renderer（U2b）：定向气泡渲染（content + details → 结构化字段）
 *
 * details 必需字段（subagentId/slug/direction==='user'）缺失或类型异常 → null（消费侧
 * 降级不崩溃）；content 非 string 时 text 归空串（details 有效则气泡仍携带去向信息）。
 */
export function parseSubagentDirective(content: unknown, details: unknown): SubagentDirectiveData | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null
  const d = details as Record<string, unknown>
  if (typeof d.subagentId !== 'string' || typeof d.slug !== 'string' || d.direction !== 'user') return null
  return {
    subagentId: d.subagentId,
    slug: d.slug,
    direction: 'user',
    text: typeof content === 'string' ? content : '',
  }
}

/**
 * pi-respawn 恢复提示条 customType SSOT（crash-resilience §3.3 D7，u8-pi-respawn）。
 *
 * pi 进程非主动退出后自动恢复（session.restored / session.restoreFailed 推送）时，
 * renderer 在对话流插入的 ephemeral 系统提示条（Message.customType = 本常量）。
 * 该提示条是 runtime 推送 session.restored / session.restoreFailed 帧、renderer
 * （core chat store appendRespawnNotice）据此插入的 live-only 提示条（pi session
 * JSONL 无对应 entry，写入点置 liveOnly:true）——重开 session 后不出现，属一次性通知语义。
 *
 * 与 SUBAGENT_DIRECTIVE_CUSTOM_TYPE 同款约定：写入方（core chat store
 * appendRespawnNotice）与渲染方（ui SystemNotice 分支）共用本常量，禁字面量漂移。
 */
export const PI_RESPAWN_NOTICE_CUSTOM_TYPE = 'pi-respawn-notice'

/** 恢复提示条形态：restored = 恢复成功（T4 文案）；restoreFailed = 熔断终态（含重试按钮）。 */
export type PiRespawnNoticeVariant = 'restored' | 'restoreFailed'

/**
 * 防御性解析 pi-respawn-notice custom message 的 details → variant。
 * 解析失败（details 畸形 / variant 非法）→ null（消费侧降级为普通 system 文本行，不崩溃）。
 */
export function parseRespawnNoticeVariant(details: unknown): PiRespawnNoticeVariant | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null
  const v = (details as Record<string, unknown>).variant
  return v === 'restored' || v === 'restoreFailed' ? v : null
}
/** 消息生命周期状态（steer/followup 解耦后 pending 不再进消息流——m4 清理）。 */
export type MessageStatus = 'streaming' | 'complete' | 'error'
export type ToolCallStatus = 'running' | 'completed' | 'error' | 'end_not_received'

export interface ToolCall {
  id: string
  toolName: string
  input: unknown
  output?: string
  /** tool result 原始文本（含 ANSI 转义，未经 stripAnsi）。前端用 ansi_up 渲染着色。
   *  无此字段时回退到 output（已 stripAnsi 的纯文本）。 */
  outputRaw?: string
  /**
   * output/outputRaw 是否被 entryStates 条目级截断裁剪 [crash-resilience §3.3 D6-⑧]。
   * 累积态单条 tool output 超 64KB（ENTRY_TOOL_OUTPUT_MAX_BYTES）时为 true，文本尾部
   * 带截断标记。live（tool_call_end overlay）与 reload（reducer replay）经同一截断函数，
   * 两路径标记一致（D3 代价 C 根治）。可选字段：缺省 = 未截断。
   */
  outputTruncated?: boolean
  /** pi tool_execution_end result.details — 结构化扩展数据 */
  details?: Record<string, unknown>
  /** Extension tool_call_update 进度百分比 (0-100) */
  progress?: number
  /** Extension tool_call_update 详细信息。
   *  subagent sync 模式下存 pi-subagents 推送的 AgentProgress 快照（聚合摘要：
   *  currentTool/turnCount/tokens/recentTools 等），前端据此滚动更新 subagent 行。 */
  detail?: string | Record<string, unknown>
  /** 实时流式失败（tool_execution_end isError）时的错误文本，与 status:'error' 同源 */
  error?: string
  /**
   * 工具结果携带的图片（W5 提取，pi toolResult content 的 image 块：base64 data + mimeType）。
   * core apply-entry 保字段写入（normalizePiToolResult 归一）；渲染消费待后续 wave。
   */
  images?: Array<{ data: string; mimeType: string }>
  status: ToolCallStatus
  startTime: number
  endTime?: number
}

export interface ThinkingBlock {
  id: string
  content: string
  collapsed: boolean
  /** Thinking 开始的毫秒时间戳（由后端 thinking_start 事件或会话记录提供） */
  startTime?: number
  /** Thinking 结束的毫秒时间戳（由后端 thinking_end 事件提供） */
  endTime?: number
}

/** 有序内容块类型，保证流式消息各 block 按到达顺序渲染 */
export type ContentBlockType = 'thinking' | 'toolCall' | 'text'

export interface ContentBlock {
  type: ContentBlockType
  /** thinking/toolCall 指向对应数组的元素 id；text 指向 'text' */
  refId: string
  /**
   * pi content array 中的产出顺序索引（模型输出顺序，非到达顺序）。
   * 两条 contentBlocks 填充路径（streaming 事件流 / 持久化 content array）统一按此排序，
   * 消除「同 turn 内 text 在 tool 之后」时 streaming 的 toolCall 块延迟到达导致的顺序错位。
   * 旧数据/无 index 事件缺省（渲染层不读该字段，仅排序语义）。
   */
  contentIndex?: number
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

/** 上下文压缩摘要（W07-C，对应 message.compactionSummary） */
export interface CompactionSummary {
  summary?: string
  tokensBefore?: number
  timestamp?: number
}

/** 分支摘要（W07-C，对应 message.branchSummary） */
export interface BranchSummary {
  summary?: string
  fromId?: string
  timestamp?: number
}

/**
 * Bash 执行结果（composer-bash-execute W1，对应 message.bashResult）。
 *
 * composer 直接执行 bash 命令（不经 LLM agent turn），结果进对话流渲染为 BashResult 气泡。
 * exitCode 用 number | null：pi 返回 number|undefined，shared 统一转 null 防 JSON 丢值
 * （undefined 在 JSON.stringify 会丢字段，前端读到就是 undefined 而非 null）。
 */
export interface BashExecutionData {
  command: string
  output: string
  exitCode: number | null
  cancelled: boolean
  truncated: boolean
  /** 是否排除出 LLM 上下文（透传自 message.bash 请求，pi bash excludeFromContext 参数） */
  excludeFromContext?: boolean
  timestamp: number
  /** pi truncated 时的完整输出文件路径（前端按需读取全文，避免大输出撑爆 WS 帧） */
  fullOutputPath?: string
}

/**
 * Background subagent 完成通知的单条记录。
 *
 * 对应 pi-subagent-workflow 扩展 notifier.ts 的 BgNotifyRecord，经 customType:"subagent-bg-notify"
 * 的 CustomMessage details 传递。扩展在主对话流注入此通知，triggerTurn:true 唤醒
 * 父 agent 接力处理结果。
 *
 * 来源：extensions/universal/subagent-workflow/src/execution/notifier.ts（本仓源码；
 * 运行时安装在 ~/.xyz-agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/）
 */
export interface BgNotifyRecord {
  id: string
  /** 扩展状态枚举（v4 B-1 两态）：
   *  running = 对话模式轮次完成（每轮送达，携带本轮结果，等待下一轮续聊，非终态）；
   *  closed = 统一终态载体（含 cancelled/gc 等，closedReason 表达 L2 原因；永久会话
   *  模型 U5 起 close（收起）的「已收起」提示与 one-shot 轮终亦经本值送达——终态概念
   *  删除后 closed 只是通知文案族的载荷词，不再代表会话结束）。
   *  done/failed/cancelled 为 legacy 兼容值（v4 之前旧版扩展产物，历史 session 落盘存在）。 */
  status: 'done' | 'failed' | 'cancelled' | 'closed' | 'running'
  agent: string
  /** 执行所用 model（用于通知展示） */
  model?: string
  /** 完成结果文本（closed 终态结果 / running 轮次结果；进 LLM context，不截断） */
  result?: string
  /** 错误文本（closed 失败终态 / legacy failed 状态） */
  error?: string
  startedAt: number
  endedAt?: number
  /** fork+worktree 模式下子 agent 改动的 patch 路径（worktree cleanup 后留存）。
   *  closed 时通知显式提示 git apply，否则改动会静默丢失。 */
  patchFile?: string
  /** L2 关闭原因子枚举（仅 status="closed" 时有意义）。对齐 notifier.ts ClosedReason。 */
  closedReason?: string
  /** 对话轮次计数（仅 running 轮次通知有意义，非 chatMode 恒定）。dedup key 按 id:round 去重。 */
  round?: number
}

/**
 * Background subagent 完成通知（单条或批量合并）。
 *
 * pi-subagents notifier 的滑动窗口在 60s 内合并多个完成，批量时 details 为 {batch, items}。
 * 单条时 details 直接是 BgNotifyRecord。
 */
export type BgNotifyDetails = BgNotifyRecord | { batch: true; items: BgNotifyRecord[] }

/**
 * 防御性解析 customType:"subagent-bg-notify" 的 details 字段。
 *
 * details 两种形态（notifier.ts flushPendingNotifications）：
 *   - 单条：BgNotifyRecord
 *   - 批量：{ batch: true, items: BgNotifyRecord[] }
 *
 * runtime（convertPiHistory）与 renderer（customStart effect）共用此纯函数，
 * 避免两处重复实现 + 字段读取不一致。任何字段缺失/类型异常返回 null（渲染层降级为纯文本）。
 */
export function parseBgNotifyDetails(details: unknown): BgNotifyDetails | null {
  if (!details || typeof details !== 'object') return null
  // as 安全性：上方 typeof check 已排除 null/primitive，此处 details 一定是 object。
  // Record<string, unknown> 比 object 更窄（可索引），用于后续属性访问。
  // 每个字段读取都做 typeof 收窄（string/number/boolean），不信任运行时形状。
  const d = details as Record<string, unknown>
  // 批量形态
  if (d.batch === true && Array.isArray(d.items)) {
    const items = d.items.map(parseSingleRecord).filter((r): r is BgNotifyRecord => r !== null)
    return items.length > 0 ? { batch: true, items } : null
  }
  // 单条形态
  return parseSingleRecord(d)
}

// ── parseSingleRecord 内部 helper（按处理阶段拆分：必需字段解析 / 可选字段拷贝）──────
// 模块私有，不进导出面。判定语义（含空串拒绝、属性写入顺序）与拆分前逐字节一致。

/** 字符串字段窄化：非 string → null（防御性解析，不信任运行时形状） */
function asRecordString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/** 数值字段窄化：非 number → null */
function asRecordNumber(v: unknown): number | null {
  return typeof v === 'number' ? v : null
}

/** status 字面量校验：=== 链与 BgNotifyRecord.status 联合逐一对齐（v4 两态 + legacy 三态），非法值 → null */
function asBgNotifyStatus(v: unknown): BgNotifyRecord['status'] | null {
  return v === 'done' || v === 'failed' || v === 'cancelled' || v === 'closed' || v === 'running' ? v : null
}

/** 必需字段（id/status/agent/startedAt）解析：任一缺失/空串/类型非法 → null */
function parseRequiredRecordFields(d: Record<string, unknown>): Pick<BgNotifyRecord, 'id' | 'status' | 'agent' | 'startedAt'> | null {
  const id = asRecordString(d.id)
  const status = asBgNotifyStatus(d.status)
  const agent = asRecordString(d.agent)
  const startedAt = asRecordNumber(d.startedAt)
  // !id / !agent 沿用空串拒绝语义（空串视为缺失，与拆分前一致）
  if (!id || !status || !agent || startedAt === null) return null
  return { id, status, agent, startedAt }
}

/** 单个可选字段的拷贝 writer（窄化 + 条件写入） */
type RecordFieldWriter = (record: BgNotifyRecord, d: Record<string, unknown>) => void

function stringFieldWriter(field: 'model' | 'result' | 'error' | 'patchFile' | 'closedReason'): RecordFieldWriter {
  return (record, d) => {
    const value = asRecordString(d[field])
    if (value !== null) record[field] = value
  }
}

function numberFieldWriter(field: 'endedAt' | 'round'): RecordFieldWriter {
  return (record, d) => {
    const value = asRecordNumber(d[field])
    if (value !== null) record[field] = value
  }
}

/** 可选字段拷贝表：数组顺序 = record 属性写入顺序（JSON.stringify 序列化依赖属性序，重排即 WS 帧/落盘字节漂移） */
const OPTIONAL_RECORD_FIELD_WRITERS: ReadonlyArray<RecordFieldWriter> = [
  stringFieldWriter('model'),
  stringFieldWriter('result'),
  stringFieldWriter('error'),
  numberFieldWriter('endedAt'),
  stringFieldWriter('patchFile'),
  stringFieldWriter('closedReason'),
  numberFieldWriter('round'),
]

function copyOptionalRecordFields(d: Record<string, unknown>, record: BgNotifyRecord): void {
  for (const write of OPTIONAL_RECORD_FIELD_WRITERS) {
    write(record, d)
  }
}

/** 防御性解析单条 BgNotifyRecord（必需字段 id/status/agent/startedAt 缺失返回 null） */
function parseSingleRecord(d: Record<string, unknown>): BgNotifyRecord | null {
  const required = parseRequiredRecordFields(d)
  if (!required) return null
  const record: BgNotifyRecord = { ...required }
  copyOptionalRecordFields(d, record)
  return record
}

// ── Flow-2 代码变更审查数据契约（FileChanges 通道）──────────────────
// 依据：docs/architecture/v3-specs/flow-2-code-review/spec.md（§S3 变更集聚合 + §状态机·变更集卡）
//      （v3 重建审计档案 wave-W11/W14 已随 .v3-audit/ 清理，需求追溯见 git 历史）
// 本契约只定义类型，runtime 解析方案见 ADR-0024，chat store 数据流由 flow-2 完整实施落地。

/**
 * 单个文件的变更状态。映射 pi 工具语义 + git A/M/D/U：
 * - write 新建文件 → added；覆盖既有文件 → modified
 * - edit 永远 → modified
 * - bash 驱动的删除/移动 → deleted（需 git 对账判定，见 ADR-0024）
 * - unmerged → git 冲突态（由 runtime git.status 推送，见 protocol.ts GitFileStatus；
 *   file_changes 与 git.status 共用本枚举，FR-11/C15）
 */
export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'unmerged'

/**
 * 单个文件的变更记录。挂在 assistant message 上（见 Message.fileChanges）。
 * filePath 为相对工作根的路径（pi write/edit 工具 args.path 已 resolveToCwd 归一）。
 * addLines/delLines 为可选：edit 工具可从 details.patch 解析；write 新文件无基线 diff，
 * bash 改动需 git 对账才有，故非必填。
 */
export interface FileChange {
  filePath: string
  status: FileChangeStatus
  addLines?: number
  delLines?: number
}

/**
 * 变更集卡 5 态状态机（flow-2 spec §状态机·变更集卡）。
 * accumulating：agent 仍在改，文件数实时增长（带 loading 指示）
 * ready：agent 完成回合，等待用户审查
 * partially-reviewed：部分文件已 accept/reject
 * resolved：全部处理完，变更集卡折叠
 * superseded：agent 又改了一轮，旧变更集折叠归档
 */
export type ChangeSetStatus = 'accumulating' | 'ready' | 'partially-reviewed' | 'resolved' | 'superseded'

/**
 * 单文件审查决策（W14 ChangeSet Detail Accept/Reject 用）。
 * pending 为初始默认值，accepted/rejected 由用户在 Side Drawer 落定。
 */
export type ReviewDecision = 'pending' | 'accepted' | 'rejected'

export interface Message {
  id: string
  role: MessageRole
  /**
   * 消息内容。按 role 语义区分（ADR-0043）：
   * - user message → Segment[]（badge 载体，含 skill/file/mention 结构化片段）
   * - assistant message → string（流式 text_delta 热路径）
   * - system/custom message → string（提示文本）
   *
   * 消费纯文本时用 normalizeContent() 归一化（处理 string | Segment[] 联合类型）。
   */
  content: string | Segment[]
  status: MessageStatus
  toolCalls?: ToolCall[]
  thinking?: ThinkingBlock[]
  /** 有序内容块，记录 thinking/toolCall/text 的实际到达顺序 */
  contentBlocks?: ContentBlock[]
  usage?: Usage
  timestamp: number
  /**
   * 该 assistant 消息产生的文件变更集合（flow-2 FileChanges 通道）。
   * runtime 经 pi 工具事件解析后推送，变更集卡（W11 WP-L3-11）据此渲染。
   * 仅 assistant 消息有值；user/system 消息不设置。
   */
  fileChanges?: FileChange[]
  /** 发送模式，仅 user 消息有值（'send' 成员已删——无写入点，§3.3.6） */
  sendMode?: 'steer' | 'follow-up'
  /** 是否被 abort 中断，仅 assistant 消息有值 */
  isInterrupted?: boolean
  /**
   * 消息级错误文本/标记（status:'error' 同源）。
   * - assistant turn：message.error / send.rejected 通道写入错误文本
   * - bash 消息：markBashError abortBash 失败兜底写入错误文本
   * 前端按值区分渲染（如 BashOutputBlock 消费 'timeout' 显示「超时」而非「已取消」——
   * 'timeout' 值的原写方 bash timer 收口已随 dormant 契约删除
   * （docs/design/timeout-streaming-ui-idle.md §5.4 D4），渲染兼容分支保留）。
   */
  error?: string
  /**
   * [premature-timeout] UI idle 超时收口标记（docs/design/timeout-streaming-ui-idle.md §5.2 D2）。
   * true = 该气泡是 idle timer 收口的「UI 误判窗口」产物（timeout → error 是前端兜底强推，
   * 非 pi 真实终态）：renderer 据此显示超时提示 + 恢复指引；迟到的 message.complete 到达时
   * 由 registry 恢复分支清标并恢复真实终态（权威 content/usage 覆盖）。
   * live 态标记，不持久化——reload 从 session JSONL 重建权威状态（设计 §4.2 恢复窗口矩阵④）。
   */
  prematureTimeout?: boolean
  /** 上下文压缩摘要（W07-C，message.compactionSummary） */
  compactionSummary?: CompactionSummary
  /** 分支摘要（W07-C，message.branchSummary） */
  branchSummary?: BranchSummary
  /** pi CustomMessage 的 customType（识别来源扩展，如 "subagent-bg-notify"）。
   *  来自 pi sendMessage 注入的 custom message，role 还原为 system。 */
  customType?: string
  /** pi CustomMessage 的 display 字段透传（ADR-0048）。
   *  pi 协议层是必填 boolean：false=隐藏不渲染，true=用区别于 user message 的样式渲染。
   *  xyz-agent 当前只消费 false 分支（filterDisplayableMessages 按 `!== false` 过滤），
   *  true 与 undefined 在渲染上等价（ADR-0048 决策点 3 scope 只做过滤，未实现区别样式）。
   *  shared.Message 是聚合类型含非 custom 消息，故 optional——
   *  消费侧（renderer filterDisplayableMessages）按 `display !== false` 判断：
   *  仅 false 隐藏，undefined/true 都显示（undefined 来自无 customType 的普通消息或旧数据）。 */
  display?: boolean
  /** Bash 执行结果（composer-bash-execute）。system 消息有值：实时经 message.bashResult
   *  effect 创建 system 消息，历史经 converter 还原为 system 消息，统一走 BashOutputBlock 渲染。
   *  与 toolCall 互斥（bash 不走工具链）。 */
  bashExecution?: BashExecutionData
  /**
   * 消息携带的图片（W5 提取）：user 消息 image part（pi UserMessage.content 的
   * ImageContent 块：base64 data + mimeType）。core apply-entry-convert 保字段写入
   *（extension sendMessage images 通道 / 手写 session 文件可达）；渲染消费待后续 wave。
   */
  images?: Array<{ data: string; mimeType: string }>
  /** pi CustomMessage details 原始字段（含 __gui__ 结构化渲染数据）。
   *  前端检测 details.__gui__ 路由到 GuiComponentRenderer。 */
  details?: Record<string, unknown>
  /**
   * pi session JSONL 中对应 entry 的 id（entry 树节点标识）。
   * 仅文件路径读取（session-history）时填充——RPC 路径（pi get_messages）不返回 entryId。
   * fork session 时用于在 pi 端定位截断点（runtime 按 piEntryId 在 JSONL 树回溯截断）。
   * 缺失时（在线重开的 session 走 RPC）fork 需 fallback 读 JSONL 按 timestamp 匹配。
   */
  piEntryId?: string
  /**
   * live-only 消息标记（conversation-turn-attribution D4）：该消息在 pi session 文件中
   * 无对应 entry（如 stream_warn 健康警告），重开 session 后不存在。唯一写入点 = 消息
   * 创建处（registry stream_warn handler）；分组层据此归为 turn 内 notice（不切断 turn），
   * 不参与「live ≡ reload」等价性断言。
   */
  liveOnly?: boolean
}
