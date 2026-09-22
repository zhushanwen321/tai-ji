/**
 * canonical session 模型（设计 D1）：「与 pi 结构一致」的严格定义。
 *
 * 数据语义（冻结接口，消费方 session-reader / runtime 导入 / zcode source 共享）：
 * - type / id / parentId：树结构字段。root（session header）在文件里无 parentId，
 *   归一化为 null。
 * - message：仅 type=message（role/content/toolCalls）。toolName/toolCallId：仅
 *   role=toolResult 的 message 透出（probe 实测 515/515 带，用于精确关联同 turn 内
 *   toolCall 取参数）。
 * - customType / data：仅 type=custom。
 * - parentSession / cwd：仅 type=session；parentSession 是 fork 文件指向来源的路径指针。
 * - summary：仅 type=compaction。
 *
 * 冻结接口未列的 per-type 附加字段不在此暴露；消费方需要时先扩展本接口——解析层
 * 不私自保留未知字段，保证「读到的就是模型声明的」。
 */

/** pi message entry 的 role 域（窄联合：解析时值守卫收窄，非法 role 计坏行）。 */
export type SessionMessageRole = 'user' | 'assistant' | 'toolResult'

export interface Entry {
  type: string
  id: string
  parentId: string | null
  timestamp?: string
  message?: {
    role: SessionMessageRole
    content: unknown
    toolCalls?: unknown[]
    /** toolResult 的工具名（仅 role=toolResult 时存在） */
    toolName?: string
    /** toolResult 关联的 toolCall.id（仅 role=toolResult 时存在） */
    toolCallId?: string
  }
  customType?: string
  data?: unknown
  parentSession?: string
  cwd?: string
  summary?: unknown
}

export interface ParseResult {
  entries: Entry[]
  /** JSON 解析失败（含缺必填结构字段）的行数 */
  skippedLines: number
  totalBytes: number
  /** 最后一行疑似半行（活跃 session 写入中），区别于中间坏行 */
  lastLinePartial: boolean
}

/**
 * session header（首行 type='session' entry 的模型）。
 *
 * runtime / reader 两版消费形态的并集：reader 侧仅消费 id（cwd 可缺），
 * runtime 侧要求 id+cwd 非空（乐观约定 timestamp 必有）。「缺 cwd 的 header 算不算
 * 合法」是两侧不同的行为契约，由各消费侧谓词裁决（基座不导出 header 谓词），
 * 本接口只声明字段形状：除 id 外全部可选。
 */
export interface SessionHeader {
  id: string
  cwd?: string
  timestamp?: string
  /** 父 session 血缘键（fork 出的 session header 指回源文件/源 sessionId）。 */
  parentSession?: string
  /** fork 锚点 entry id（截断点）。 */
  forkEntryId?: string
}

/**
 * 转换降级记录（zcode→canonical 转换的信息损失按性质分档）。
 *
 * 与 `@taiji/shared` 的 wire 契约类型 `ImportDegradation` 为结构等价声明：基座是零
 * 依赖包（设计负面清单），不 import shared——两处定义字段逐一同步（code 五值闭集 /
 * kind / source / count / sample / zcodeSchemaVersion），漂移由消费侧（runtime 导入
 * 薄包装把本类型赋给 wire 契约类型）的类型检查拦截。档位语义：
 * - `dropped_redundant`（L1）：内容已由 tool 通道保留的运行时注入丢弃，无损
 * - `dropped_transient`（L2）：无对话语义的瞬态/注入形态丢弃 + part 级诊断登记
 * - `truncated_output` / `compaction_unlinked`（L3）：保真损失
 * - `unclassified`（L4）：超出闭集无法分类，丢弃 + 独立告警
 */
export interface ImportDegradation {
  /** 降级码（五值闭集） */
  code:
    | 'dropped_redundant'
    | 'dropped_transient'
    | 'truncated_output'
    | 'compaction_unlinked'
    | 'unclassified'
  /** zcode semantics.kind 原值（按可得性携带的聚合维度） */
  kind?: string
  /** metadata.source / source 原值（按可得性携带的聚合维度） */
  source?: string
  /** 该 (code, kind, source) 维度的聚合计数 */
  count: number
  /** 定位样本（unclassified 必带；part 级诊断可携带便于日志定位） */
  sample?: {
    messageId: string
    preview: string
  }
  /** zcode schema_migration.app_version（回归定位锚，按可得性携带） */
  zcodeSchemaVersion?: string
}

/**
 * source 包读取链的统一返回类型：`readZcodeSession(dbPath, sessionId)` 等具体读取
 * 函数产出本形状。
 * - header：canonical 化后的会话头（pi 侧 = 直读 JSONL 首行的 SessionHeader；zcode 侧
 *   由 converter 从库内 session 行构造——zcode 无 cwd 概念，缺省留空不伪造）。
 * - entries：严格 Entry 树（parentId 链完整，坏行/未知 part 不占位）。
 * - degradations：结构化降级明细（pi 恒为 []——JSONL 直读无转换损失；zcode 侧由
 *   converter 在降级点登记，不静默丢弃）。
 */
export interface NormalizedSession {
  header: SessionHeader
  entries: Entry[]
  degradations: ImportDegradation[]
}
