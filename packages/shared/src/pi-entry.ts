/**
 * pi session entry 的 wire 类型（data-source-governance W21 自 core/domain/chat/apply-entry.ts 下沉）。
 *
 * 下沉动机：entry 形态成为 runtime（event-adapter 实时重构）↔ core（reducer 投影）↔ shared
 * （protocol.ts message.* payload 类型）三方共用的 wire 契约——shared 是唯一不破坏包依赖方向
 * （core→shared、runtime→shared）的归属地（plan W20「W21/W22 上收到 protocol 层时重新评估包边界」
 * 的裁决兑现）。core/apply-entry.ts 改为 re-export 本文件保持 API 兼容。
 *
 * 结构镜像 pi session-manager.ts SessionEntry 联合（TS 结构类型，runtime 侧无需 import 本文件
 * 类型即可喂入 reducer）。pi 还有 thinking_level_change / model_change / session_info 三个 entry
 * 类型，taiji 未建模——reducer 对未建模 type 走 default no-op（不丢弃 entry 语义 = 不崩溃
 * 不吞整个重放，见 apply-entry.ts default 分支注释）。
 *
 * id 可选的原因：pi 真实 entry 恒有 id（uuidv7）；但两个来源无真实 id——
 * ① wire 层 lift 无真实 entry id 的伪消息（get_messages 扁平列表 / __entryId 缺失）；
 * ② 实时路径 message_end 事件重构（pi 在 emit message_end **之后**才 appendMessage 分配 entry id，
 *   agent-session.ts:545-561 持久化时序，事件上拿不到）——此时 piEntryId 不回填，id 由 reducer
 *   按喂入序确定性派生（`e<N>`，见 apply-entry.ts deriveBaseId）。
 */

/** entry 公共字段（pi SessionEntryBase 镜像；timestamp 是 ISO string）。 */
export interface PiEntryBase {
  type: string
  id?: string
  parentId?: string | null
  timestamp: string
}

/**
 * message entry 体（user/assistant/toolResult/bashExecution 四种 role 都在 message 字段里，
 * pi messages.ts AgentMessage 联合镜像）。字段按「消费到的」宽形态声明为 unknown，
 * 读取点全部运行时守卫收窄（禁 any，malformed 数据降级不抛错——session JSONL 可能截断）。
 */
export interface PiMessageBody {
  /** role 可选：wire 层 lift 无 role 的畸形记录时为 undefined——reducer 按 unknown role 降级（warn + 跳过） */
  role?: string
  content?: unknown
  timestamp?: number
  usage?: unknown
  /** toolResult role 专属 */
  toolCallId?: unknown
  toolName?: unknown
  isError?: unknown
  details?: unknown
  /** bashExecution role 专属 */
  command?: unknown
  output?: unknown
  exitCode?: unknown
  cancelled?: unknown
  truncated?: unknown
  excludeFromContext?: unknown
  fullOutputPath?: unknown
  /** compactionSummary role 专属 */
  summary?: unknown
  tokensBefore?: unknown
  /** custom role 专属 */
  customType?: unknown
  display?: unknown
  /** branchSummary role 专属 */
  fromId?: unknown
}

export interface PiMessageEntry extends PiEntryBase {
  type: 'message'
  message: PiMessageBody
}

/** custom entry（extension appendEntry 写入，不进 LLM 上下文）。 */
export interface PiCustomEntry extends PiEntryBase {
  type: 'custom'
  customType: string
  data?: unknown
}

/** label entry（用户书签；重放侧不产出消息，显式 no-op case）。 */
export interface PiLabelEntry extends PiEntryBase {
  type: 'label'
  label?: string
  targetId?: string
}

/** compaction entry（compact 摘要）。summary/tokensBefore 在 pi 是必填，lift 容忍缺失。 */
export interface PiCompactionEntry extends PiEntryBase {
  type: 'compaction'
  summary?: string
  tokensBefore?: number
}

/** branch_summary entry（branch 摘要）。 */
export interface PiBranchSummaryEntry extends PiEntryBase {
  type: 'branch_summary'
  fromId?: string
  summary?: string
}

/** custom_message entry（扩展 sendMessage 注入，进 LLM 上下文 + 对话流渲染）。 */
export interface PiCustomMessageEntry extends PiEntryBase {
  type: 'custom_message'
  customType: string
  content?: unknown
  display?: boolean
  details?: unknown
}

/** reducer 输入的 pi entry 联合（6 个 taiji 建模类型）。 */
export type PiEntry =
  | PiMessageEntry
  | PiCustomEntry
  | PiLabelEntry
  | PiCompactionEntry
  | PiBranchSummaryEntry
  | PiCustomMessageEntry

/**
 * toolCall entry 形态（W21 实时路径 tool_execution_start 的重构载体）。
 *
 * pi entry schema 中 toolCall 不是独立 entry（是 assistant message content 的 block）——
 * 本形态是「对齐 pi entry 字段风格」的实时 overlay 载体（W21 plan 步骤 1 映射表的
 * toolCall 侧），携带模型产出顺序锚点（contentIndex）与挂载目标（messageId），
 * 供前端 overlay 挂 running toolCall；不进 reducer（reducer 只消费上方 PiEntry 联合，
 * 权威 toolCalls 随 assistant message entry 提交）。
 *
 * 字段来源：toolCallId/toolName/arguments 来自 pi tool_execution_start 事件
 * （pi 用 args 是规范字段名，此处命名对齐 pi entry schema 用 arguments）；
 * contentIndex 来自 message_update{toolcall_start} 的产出顺序锚点（interpreter 缓存后补）；
 * messageId 来自 message_start 翻译产物（interpreter 的 currentMessageId）；
 * turnId 留 optional：pi 事件不带 turn 边界信息，值填充归 fix-chat-flow-order 分组 wave
 * （本 wave 只保证字段在类型契约上稳定存在，构造点不填——不写投机代码）。
 */
export interface PiToolCallEntryForm extends PiEntryBase {
  type: 'toolCall'
  /** pi toolCall 的稳定 id（assistant content block 的 id，与 toolResult.toolCallId 配对） */
  toolCallId: string
  toolName: string
  /** 工具入参（pi tool_execution_start.args 原值；plugin hook 改写后为改写值） */
  arguments: Record<string, unknown>
  /** 模型产出顺序锚点（§11 检查点 3）。缺失（旧 pi/异常）时前端退化为 append 尾部 */
  contentIndex?: number
  /** 挂载目标：所属 assistant 消息的翻译层 messageId（interpreter currentMessageId） */
  messageId?: string
  /** turn 分组字段：值填充归 fix-chat-flow-order（本 wave 恒缺省，见上方注释） */
  turnId?: string
}
