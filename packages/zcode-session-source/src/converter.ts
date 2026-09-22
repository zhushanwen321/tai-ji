/**
 * zcode → canonical session 转换器（自 runtime services/session/zcode-import/converter.ts
 * 迁入改造，session-reader-shared-core 设计 §3.3 D1 + §5 Phase 2；runtime 侧旧文件已
 * 随共享基座实施收口删除（git 可追溯），本包为其唯一现行承载）。
 *
 * 输入 = 单会话全量行集（message 按 sequence、part 按 (message.sequence, part.sequence)
 * 联合序，sqlite-access.getSessionTranscript）；输出 = canonical `Entry[]`（session-core
 * 严格 Entry 模型，parentId 顺序链完整）。三层映射：
 * ① 消息级投影分派——逐条消息先经 classifyMessage()（projection.ts，asar 移植体）判定
 *    六策略之一（或 unclassified），按消息投影对齐设计 §7.3 映射表落点（三类丢弃整条不产
 *    entry + L1/L2 聚合降级，unclassified 丢弃 + 独立告警码）；② part 级映射——消息内部
 *    按 session-import-unified 设计 §3.4 权威映射表逐条实现：T1 header/session_info /
 *    T2 user / T3 assistant 按 step-finish 切段 / T3b 工具名映射 / T3c stopReason 映射 /
 *    T4 tool output 三形态 / T5 其余 part / T6 entry id 递增链；③ compact_summary 合并——
 *    D2 完整规格（三路关联判据 + 单条 compaction entry + firstKeptEntryId 三级锚悬空门 +
 *    1:N 最早联合序锚 + 孤儿二分），关联在发射前预扫描趟建立（compaction.ts）。
 *
 * 来源注记：消息投影分派 / 结构化降级（ImportDegradation 五码闭集）/ compaction D2 全规格 /
 * usage RT-5#1 缺省语义 / 时间戳 RT-5#8 不伪造 1970，均自 runtime zcode-import dev 演进版
 * 移植（git 可追溯）；dev 版内部的降级通道（孤儿/悬空/summary 不可用 → custom +
 * compaction_unlinked）随规格一并移植。
 *
 * 相对 dev 版的改造（canonical 契约，设计 D1「canonical 模型 = pi 形态的严格 Entry 树」）：
 * - emitEntry 不再 stringify 落 JSONL 行，改产 Entry 对象（toCanonicalEntry 收口，键序仍按
 *   `{type, id, parentId, timestamp, ...payload}` 构造——serializeSession 的字节契约
 *   责任在构造方，导入侧薄包装拼 header 行 + serializeSession 即得与旧产物逐字节
 *   兼容的 JSONL）；message 内 pi 透传字段（timestamp/provider/model/usage/stopReason、
 *   toolResult 的 details/isError、session_info 的 name）是 canonical Entry 冻结接口外
 *   的合法载荷字段——经宽形态构造 + 边界收口守卫承载，序列化原样落盘、reader 渲染链
 *   可直接消费，不做有损裁剪。
 * - entry id 生成收敛基座单点：normalizeZcodeRowId（8-hex 零填充，与 pi 自身
 *   randomUUID().slice(0,8) 同形态；pi 侧对 entry id 仅作 opaque map key 消费）。
 * - 对外主函数 readZcodeSession(dbPath, sessionId) → NormalizedSession
 *   （{header, entries, degradations} 三键，形状由 session-core 类型强制）。
 *   header 由库内 session 行构造：id 归一化（normalizeZcodeSessionId）、timestamp 取
 *   session 创建时间、cwd 缺省留空——zcode 会话无 cwd 概念，不伪造（D1）。
 *   首行 `{type:'session', version:3, ...header}` 不由本模块产出（属序列化装配面：
 *   导入薄包装 / reader 侧各自拼装）。
 * - 时间不可解不伪造（RT-5#8）：session.timeCreated / message.time.created 不可解时
 *   timestamp 键缺省（header.timestamp / entry.timestamp / message.timestamp 均可选），
 *   降级登记一次，不以 0 产出 1970 假时间戳污染排序与按日统计。
 * - 错误面归消费侧（§1.5 契约第 4 条）：session 行不存在、归一化失败、查询/JSON
 *   解析失败均抛普通 Error 原样上抛——reader 侧映射 zcode_* 词表、runtime 导入侧
 *   映射 import_* 词表，本包不私建错误码与恢复话术（dev 版的 convertZcodeSession
 *   db 组合 + ImportServiceError 不移植）。
 *
 * 排序锚（C1 探针结论，2026-09-19 宿主库只读抽样）：3 个 interactive 会话（1534/1852/29
 * parts）在 ORDER BY message.sequence, part.sequence 联合序下，携带 time 字段的 part
 * （text/reasoning/compaction/timeline；tool/step-* 无 time 字段）其 time.start 全程
 * 非降（3415 parts 零逆序）——联合 sequence 序即事件时序，转换器按输入数组序线性消费，
 * 无需二次按时间排序。
 *
 * 产物正确性锚（D1）：产物必须能被 pi entry 消费链重放（parentId 链完整 + toolCall
 * 配对）——converter.test 以最小重放器 + parseSessionContent round-trip 为可证伪断言。
 */

import { normalizeZcodeRowId } from '@zhushanwen/session-core'
import type { Entry, ImportDegradation, NormalizedSession, SessionHeader } from '@zhushanwen/session-core'

import { openZcodeSessionDb } from './sqlite-access.ts'
import { normalizeZcodeSessionId } from './normalize.ts'
import { classifyMessage } from './projection.ts'
import { precomputeCompactionAssociation, resolveFirstKeptEntryId, summaryBodyOf } from './compaction.ts'
import {
  asFinite,
  asNonEmptyString,
  isRecord,
  mapStopReason,
  unsealedStopReason,
  usageFromStepFinish,
  zeroUsage,
} from './assistant-mapping.ts'
import type { ProjectionPolicy } from './semantics.ts'

// 公共面：resolveFirstKeptEntryId 实现在 compaction.ts，经再导出维持从本模块导入的
// 既有路径（compaction-firstkept.test 等锚点；dev 版同款先例）。
export { resolveFirstKeptEntryId }

/**
 * 纯转换函数的 message 输入（内存行结构——测试直接构造，不建真库）。parts 元素 =
 * part.data 已解析对象本体（与 sqlite-access ZcodeTranscriptMessageRow.parts 同构——
 * 曾因行壳 {sequence, data} 包装让结构类型静默可赋值、part.type 全体读成 undefined，
 * 见 sqlite-access 该接口注释；勿再包壳）。
 */
export interface ZcodeMessageInput {
  id: string
  data: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

/** 纯转换函数的 session 行输入（ZcodeSessionRow 的消费列子集）。 */
export interface ZcodeSessionInput {
  /** 原始 session.id（`sess_<uuid>` 形态）——header.id 由 normalizeZcodeSessionId 归一化。 */
  id: string
  title: string
  /** 毫秒时间戳（session.time_created）；header.timestamp = ISO 串、消息级时间兜底。 */
  timeCreated: number
}

// ── 降级登记（D4 结构化分档，设计 §7.4）──────────────────────────────────────────────
// 两条登记通道，按损失性质区分：
// ① part 级诊断（pushDegradation）：消息内部局部损失（file part 丢弃、running tool 整对
//    丢弃、malformed 形态跳过、usage 不可解等）——逐条独立 count=1 + sample（messageId
//    定位源消息），code 恒 'dropped_transient'（这些不是消息级丢弃分档 L1/L2/L4——那由
//    分类器在消息边界裁决，走 convertZcodeTranscript 内的 recordDroppedMessage 聚合）。
// ② 消息级丢弃聚合（recordDroppedMessage）：分类器判弃的三类策略 + unclassified，按
//    (code, kind, source) 维度聚合计数（§7.4：count = 该维度聚合计数）；sample 仅
//    unclassified 携带（保首条）。
const DEGRADATION_PREVIEW_MAX = 80

function pushDegradation(
  degradations: ImportDegradation[],
  text: string,
  messageId?: string,
): void {
  degradations.push({
    code: 'dropped_transient',
    count: 1,
    ...(messageId !== undefined && {
      sample: { messageId, preview: text.slice(0, DEGRADATION_PREVIEW_MAX) },
    }),
  })
}

/** 宿主消息的 (kind, source) 注解（ImportDegradation 的聚合维度；字符串才携带）。 */
function degradationMeta(data: Record<string, unknown>): { kind?: string; source?: string } {
  const semantics = isRecord(data.semantics) ? data.semantics : undefined
  const kind = typeof semantics?.kind === 'string' ? semantics.kind : undefined
  const metadata = isRecord(data.metadata) ? data.metadata : undefined
  let source: string | undefined
  if (typeof data.source === 'string') source = data.source
  else if (typeof metadata?.source === 'string') source = metadata.source
  return { ...(kind !== undefined && { kind }), ...(source !== undefined && { source }) }
}

// L1 判据（D3）：source 命中 background_*/subagent_* 前缀或 'subagent' 裸值 → 该消息内容在
// 产物中已有 tool 通道的更完整副本（Agent toolCall/toolResult 对），丢弃冗余、重托管 = 上下文重复。
function isToolPreservedSource(source: string): boolean {
  return source.startsWith('background_') || source.startsWith('subagent_') || source === 'subagent'
}

/**
 * 消息级丢弃的降级码：L1 冗余（tool 通道已保留）/ L2 无语义（非 L1/L3/L4 的丢弃类全量归入）。
 * 分档只消费顶层 data.source / legacy metadata.source 两路——semantics.source / part 级
 * source 等前向通道缺省时粗化落 L2（设计 §7.3 表按策略列档位、本判据按 D4 source 前缀，
 * 两者口径差有意为之：同一丢弃均计入 droppedCount，无 wire 语义差）。
 */
function droppedMessageCode(data: Record<string, unknown>): 'dropped_redundant' | 'dropped_transient' {
  const { source } = degradationMeta(data)
  return source !== undefined && isToolPreservedSource(source) ? 'dropped_redundant' : 'dropped_transient'
}

/** unclassified sample 的文本源：全部有效 text part 拼接（对齐分类器 textFromParts 语义）。 */
function messageTextPreview(parts: ReadonlyArray<Record<string, unknown>>): string {
  return parts
    .filter((p) => p.type === 'text' && p.ignored !== true)
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
}

// ── T3b 工具名映射（§3.4）：zcode 首字母大写 → taiji 渲染判定层的全小写匹配域 ──────────
// 不映射则工具图标退通用、edit/write 的 diff 卡片与 ChangeSetCard 静态提取失效。
// 未知名保底原样输出（不计 degradations——渲染走通用工具块，属正常降形态而非内容丢失）。
const TOOL_NAME_MAP: Readonly<Record<string, string>> = Object.freeze({
  Edit: 'edit',
  Bash: 'bash',
  Read: 'read',
  Write: 'write',
  Grep: 'grep',
  Glob: 'glob',
  Skill: 'skill',
})

function mapToolName(zcodeTool: string): string {
  return TOOL_NAME_MAP[zcodeTool] ?? zcodeTool
}

// ── T6 entry id 链：8-hex 递增计数器（'00000001' 起），parentId 顺序链（首条 null）──────
// 确定性（可测试）、session 内唯一；pi 不解析 entry id 语义——id 在 pi 侧仅作 opaque map
// key / leaf 指针 / 相等比较（pi 0.84.4 dist/core/session-manager.js:681-682 与 :758-759，
// _buildIndex/_appendEntry 均 byId.set(entry.id, entry) + leafId = entry.id，全库无
// parseInt/形态校验类消费；pi 自身 id 生成 = randomUUID().slice(0,8)，同 8-hex 形态）。
// 依据条目：docs/architecture/session-import-sources.md §5-I8；id 值域归一化收敛基座
// 单点 normalizeZcodeRowId（D1 最小例子）。
class EntryChain {
  private counter = 0
  private lastId: string | null = null

  next(): { id: string; parentId: string | null } {
    this.counter += 1
    const id = normalizeZcodeRowId(this.counter)
    const parentId = this.lastId
    this.lastId = id
    return { id, parentId }
  }

  /** 最后一条已发射 entry 的 id（无则 null）——D2 firstKeptEntryId ② 级锚（紧邻前驱）。 */
  last(): string | null {
    return this.lastId
  }

  /**
   * 下一个 id 预览（不推进计数器）。compaction entry 的 ③ 级锚 = 其自身 id，而 id 由
   * 发射时才生成、firstKeptEntryId 又必须在发射前进入 payload——peek 让两者解耦，
   * next() 产出的 id 与 peek 结果严格一致（同一确定性公式）。
   */
  peek(): string {
    return normalizeZcodeRowId(this.counter + 1)
  }
}

// ── canonical Entry 边界收口（宽形态构造 → 严格模型）────────────────────────────────
// 转换器自构造的 entry 行携带 canonical 冻结接口外的合法载荷字段（message.usage 等，
// 见模块头注），全程以宽形态构造；唯一收口点在此——必填结构字段守卫不满足即抛
// （converter 自产物违约 = 编程错误，fail-fast 优于让下游拿到结构坏 entry）。
const MESSAGE_ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'toolResult'])

function toCanonicalEntry(raw: Record<string, unknown>): Entry {
  const type = raw.type
  const id = raw.id
  const parentId = raw.parentId
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error(`converter 内部错误：entry 缺 type（${JSON.stringify(raw).slice(0, 120)}）`)
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`converter 内部错误：entry 缺 id（type=${type}）`)
  }
  if (parentId !== null && typeof parentId !== 'string') {
    throw new Error(`converter 内部错误：entry parentId 非 string|null（type=${type}，id=${id}）`)
  }
  const message = raw.message
  if (message !== undefined) {
    if (!isRecord(message) || typeof message.role !== 'string' || !MESSAGE_ROLES.has(message.role)) {
      throw new Error(`converter 内部错误：entry message.role 非法（type=${type}，id=${id}）`)
    }
  }
  // 上方守卫已核验必填结构字段（type/id/parentId/message.role）；接口外载荷字段
  // （message.usage 等，见模块头注）是合法产物，Record → Entry 的剩余差距仅为
  // TS 无法从守卫推定的必填键存在性，两段断言收窄（守卫即运行时 guard）
  return raw as unknown as Entry
}

/** assistant 切段累积器（T3）：一个 step 循环段 = 一条 pi assistant entry。 */
interface AssistantSegment {
  content: Array<Record<string, unknown>>
  /** 段内 tool part 的 toolResult message 体（紧随 assistant entry 之后逐条产出，T3①②） */
  toolResults: Array<Record<string, unknown>>
  /** 段时间戳（段内首个携带 time.start 的 part；全无则 undefined → 消息级兜底） */
  startMs: number | undefined
}

function newSegment(): AssistantSegment {
  return { content: [], toolResults: [], startMs: undefined }
}

// T3c stopReason / usage 映射与共享守卫（isRecord / asFinite / asNonEmptyString）在
// assistant-mapping.ts（字段映射域：mapStopReason / unsealedStopReason（取消轮 error 优先）/
// zeroUsage（pi 读面不变量门）/ usageFromStepFinish——RT-5#1 缺省语义见其头注）。

/**
 * T4：tool part 的 state.output → pi toolResult 的 content/details 三形态。
 *
 * C2 探针结论（2026-09-19 宿主库全库只读抽样，345,632 条 tool part）：state 恒为内嵌
 * JSON 对象（字符串旧形态 0 条）；state.output typeof 全库仅两形态——string ≈341.8k
 * （completed 态全部）/ 缺失 3,829（其中 error 态 3,807 条 output 全缺失且 state.error
 * 100% 非空，running 22 条无输出）。object 形态当前全库 0 条——object 分支是前向防御
 * （沿用 reader.ts 已确立的 string/object 惯例，不发明第二形状）；未覆盖形态
 * （number/boolean/array）按「跳过+降级登记」处理（实施计划 §5.3 C2 裁决）。
 */
function toolResultShape(
  state: Record<string, unknown>,
  partData: Record<string, unknown>,
  msgId: string,
  degradations: ImportDegradation[],
): { content: Array<Record<string, unknown>>; details?: Record<string, unknown>; isError: boolean } {
  const status = state.status
  const output = state.output
  if (status === 'error') {
    // 错误原因必须可见（G3）：error 态实测 output 恒缺失、文本在 state.error（100% 有值）；
    // 兜底链 state.error → output（string 时）→ 空串
    const errText =
      typeof state.error === 'string' ? state.error : typeof output === 'string' ? output : ''
    return { content: [{ type: 'text', text: errText }], isError: true }
  }
  // completed（及未来新增的已完成类 status）
  if (typeof output === 'string') {
    return { content: [{ type: 'text', text: output }], isError: false }
  }
  if (output === null || output === undefined) {
    // completed + output 缺失：content 留空（实测 completed 态恒有 string output，本分支为边界防御）
    return { content: [], isError: false }
  }
  if (isRecord(output)) {
    return { content: [], details: output, isError: false }
  }
  pushDegradation(
    degradations,
    `tool「${String(partData.tool)}」output 形态超出已验证域（typeof ${typeof output}），跳过输出：message=${msgId}`,
    msgId,
  )
  return { content: [], isError: false }
}

// ── 纯转换主体 ─────────────────────────────────────────────────────────────────────

/**
 * 把联合序排好的 message 行集转换为 canonical entries（纯函数，映射全表）。
 *
 * 结构（复杂度门禁拆分后）：本函数只保留装配骨架——T1 session_info / 消息循环趟 /
 * 聚合并入；D2 关联预扫描 → precomputeCompactionAssociation，逐消息分派 →
 * convertMessageByPolicy（compactSummary 合并发射在 emitCompactSummary），拆分不改
 * 任何判定与发射顺序。
 *
 * @param messages 联合序排好的 message 行集（含 parts）
 * @param session  session 行消费列（header 来源：id 归一化 / timestamp = timeCreated ISO）
 */
export function convertZcodeTranscript(
  messages: ZcodeMessageInput[],
  session: ZcodeSessionInput,
): NormalizedSession {
  const degradations: ImportDegradation[] = []
  const entries: Entry[] = []

  // RT-5#8：session.timeCreated 不可解（纯函数直接调用绕过 sqlite-access 行守卫时）不以 0
  // 兜底——0 会产出 1970 假时间戳污染排序与按日统计。降级登记一次，header.timestamp /
  // entry.timestamp / message.timestamp 键缺省（SessionHeader/Entry 字段均可选）。
  const sessionCreatedMs = asFinite(session.timeCreated)
  const headerTimestamp = sessionCreatedMs !== undefined ? new Date(sessionCreatedMs).toISOString() : undefined
  if (sessionCreatedMs === undefined) {
    pushDegradation(
      degradations,
      `session.timeCreated 不可解（${String(session.timeCreated)}），header/message 时间戳缺省：不伪造 1970`,
    )
  }
  const header: SessionHeader = {
    id: normalizeZcodeSessionId(session.id),
    ...(headerTimestamp !== undefined && { timestamp: headerTimestamp }),
  }

  const chain = new EntryChain()
  const emitEntry = (type: string, timestamp: string | undefined, rest: Record<string, unknown>): string => {
    const { id, parentId } = chain.next()
    // 键序 = serializeSession 字节契约（pi appendMessage 同款）：{type, id, parentId, timestamp, ...payload}
    const entry = toCanonicalEntry({ type, id, parentId, ...(timestamp !== undefined && { timestamp }), ...rest })
    entries.push(entry)
    return entry.id
  }

  // messageId → entryId 映射表（设计 §6-D2）：D2 合并的 firstKeptEntryId ① 级锚在发射趟
  // 内消费——compaction part 的 tail_start_id（zcode messageId）在此查 entry id。首条
  // wins——「保留起点」锚语义 = 该消息的首条 entry（多段 assistant 消息以其最早段为起点）。
  const messageIdToEntryId = new Map<string, string>()

  const policies = messages.map((msg) => classifyMessage(msg.data, msg.parts))
  const { linkedParts, compactionDisposition } = precomputeCompactionAssociation(messages, policies)

  // 消息级丢弃聚合组（L1/L2/L4）：按 (code, kind, source) 维度 count 累加，插入序 = 首遇序（确定性）。
  const dropGroups = new Map<string, ImportDegradation>()
  const recordDroppedMessage = (degradation: ImportDegradation): void => {
    const key = `${degradation.code}|${degradation.kind ?? ''}|${degradation.source ?? ''}`
    const existing = dropGroups.get(key)
    if (existing === undefined) {
      dropGroups.set(key, { ...degradation })
      return
    }
    existing.count += degradation.count
  }

  const deps: MessageDispatchDeps = {
    chain,
    linkedParts,
    compactionDisposition,
    degradations,
    messageIdToEntryId,
    recordDroppedMessage,
  }

  // T1：session_info entry（name = session.title；空 title 不带 name 字段——可选语义）。
  // 首行 header（{type:'session', version:3, ...header}）不在此产出（序列化装配面）。
  emitEntry('session_info', headerTimestamp, typeof session.title === 'string' && session.title.length > 0 ? { name: session.title } : {})

  for (const [msgIndex, msg] of messages.entries()) {
    // 分派以投影分类结果为准（§7.3 映射表）——role 不再是分派依据（D1：显隐与 zcode GUI
    // 同源，合成消息/隐藏注入不再冒充用户消息；无标记未知 role 由分类器兜底链裁决落点）。
    // 分类结果已在 D2 预扫描趟计算（关联判据需要全行集策略视图），此处复用。
    const policy = policies[msgIndex]
    const time = isRecord(msg.data.time) ? msg.data.time : {}
    const createdMs = asFinite(time.created) ?? sessionCreatedMs
    // entry 时间戳不可解时退 header 时间形态（缺省键，保真 > 伪造）；message.timestamp（ms）缺省键
    const createdIso = createdMs !== undefined ? new Date(createdMs).toISOString() : headerTimestamp
    // 每消息发射包装：entry 发射时登记 messageId → entryId（首条 wins）
    const emitForMessage = (type: string, timestamp: string | undefined, rest: Record<string, unknown>): void => {
      const entryId = emitEntry(type, timestamp, rest)
      if (!messageIdToEntryId.has(msg.id)) messageIdToEntryId.set(msg.id, entryId)
    }

    convertMessageByPolicy(msg, policy, createdMs, createdIso, emitForMessage, deps)
  }

  // 丢弃聚合组按首遇序并入（part 级诊断条目保持逐条在前的登记形态）
  degradations.push(...dropGroups.values())

  return { header, entries, degradations }
}

/** 消息级分派依赖：发射趟的共享可变状态，拆分后经本对象传递（避免长参数列）。 */
interface MessageDispatchDeps {
  chain: EntryChain
  linkedParts: Map<string, Array<Record<string, unknown>>>
  compactionDisposition: WeakMap<Record<string, unknown>, 'merged' | 'dangling'>
  degradations: ImportDegradation[]
  messageIdToEntryId: Map<string, string>
  recordDroppedMessage: (degradation: ImportDegradation) => void
}

/**
 * 单条消息的策略分派（§7.3 映射表）：三类丢弃整条不产 entry + L1/L2 聚合降级
 * （droppedMessageCode 分档）、unclassified 丢弃 + 独立告警码、compactSummary 走
 * D2 合并发射（emitCompactSummary）。
 */
function convertMessageByPolicy(
  msg: ZcodeMessageInput,
  policy: ProjectionPolicy,
  createdMs: number | undefined,
  createdIso: string | undefined,
  emitForMessage: (type: string, timestamp: string | undefined, rest: Record<string, unknown>) => void,
  deps: MessageDispatchDeps,
): void {
  switch (policy) {
    case 'realUserInput':
      convertUserMessage(msg, createdMs, createdIso, emitForMessage, deps.degradations, deps.compactionDisposition)
      break
    case 'visibleAssistant':
      convertAssistantMessage(msg, msg.data, createdMs, createdIso, emitForMessage, deps.degradations, deps.compactionDisposition)
      break
    case 'compactSummary':
      emitCompactSummary(msg, createdMs, createdIso, emitForMessage, deps)
      break
    case 'providerContextOnly':
    case 'hiddenSynthetic':
    case 'timelineOnly':
      // D3：整条丢弃不产 entry——内容已由 tool 通道保留（L1）或无对话语义（L2）
      deps.recordDroppedMessage({ code: droppedMessageCode(msg.data), count: 1, ...degradationMeta(msg.data) })
      break
    case 'unclassified':
      // D4/L4：丢弃 + 独立告警码 + 首条 sample（messageId + 文本前 80 字）
      deps.recordDroppedMessage({
        code: 'unclassified',
        count: 1,
        ...degradationMeta(msg.data),
        sample: { messageId: msg.id, preview: messageTextPreview(msg.parts).slice(0, DEGRADATION_PREVIEW_MAX) },
      })
      break
    default: {
      const exhaustive: never = policy
      throw new Error(`未处理的投影策略：${String(exhaustive)}`)
    }
  }
}

/**
 * compactSummary 策略的 D2 合并发射（§6-D2）：compact_summary 宿主消息与其关联 compaction
 * part 合并为单条 pi compaction entry（替换旧版 user entry + custom 通道——失败模式
 * C：摘要以 user 消息形态进上下文却无压缩语义）。summary 不可用 → 不伪造，整条退化为现状
 * 形态。
 */
function emitCompactSummary(
  msg: ZcodeMessageInput,
  createdMs: number | undefined,
  createdIso: string | undefined,
  emitForMessage: (type: string, timestamp: string | undefined, rest: Record<string, unknown>) => void,
  deps: MessageDispatchDeps,
): void {
  const body = summaryBodyOf(msg.data)
  if (body === undefined) {
    convertUserMessage(msg, createdMs, createdIso, emitForMessage, deps.degradations, deps.compactionDisposition)
    deps.degradations.push({ code: 'compaction_unlinked', count: 1, ...degradationMeta(msg.data) })
    return
  }
  // 合并发射：每个 compactSummary 消息至多一条 compaction entry。1:N 关联 part 合流，
  // 锚/tokensBefore/details 取联合序最早 part（首插 = 最早，见预扫描 linkedParts 注释；
  // 取偏晚锚会静默偏移续聊上下文——设计 §6-D2 否决）。宿主 text part 随合并被消费
  // （摘要正文走 summary 字段，P-4：312/312 宿主 data.summary.body 齐备）。
  const anchor = deps.linkedParts.get(msg.id)?.[0]
  let tokensBefore: number | undefined
  let anchorMs: number | undefined
  let tailId: string | undefined
  if (anchor !== undefined) {
    tokensBefore = asFinite(anchor.preCompactTokenCount)
    anchorMs = partStartTime(anchor)
    // ① 级锚发射前解析：messageIdToEntryId 只登记已发射 entry，命中即非悬空（⛔ 悬空门）
    tailId = asNonEmptyString(anchor.tail_start_id)
  }
  const tsMs = anchorMs ?? createdMs
  const tier1 = tailId !== undefined ? deps.messageIdToEntryId.get(tailId) : undefined
  // ③ 级锚需要自身 id、payload 又必须先于发射组装——peek() 预览不推进计数器
  const ownId = deps.chain.peek()
  emitForMessage('compaction', tsMs !== undefined ? new Date(tsMs).toISOString() : createdIso, {
    summary: body,
    firstKeptEntryId: resolveFirstKeptEntryId(tier1, deps.chain.last(), ownId),
    ...(tokensBefore !== undefined && { tokensBefore }),
    ...(anchor !== undefined && { details: anchor }),
  })
  // 合并路径不产 user entry；宿主自带的悬空指针 part 补发现状 custom entry +
  // compaction_unlinked 降级（§6-D2 孤儿② / §5.2：边界元数据留产物载体、漂移信号不吞）
  // ——直接复用 handleNonTextPart 的 dangling 落点，与指针宿主路径同语义（弱映射表共享）。
  // merged part 不入此循环：已被上方 compaction entry 消费（防双发；dangling 不是被
  // 合并消费的 part，不受防双发抑制）
  for (const part of msg.parts) {
    if (part.type === 'compaction' && deps.compactionDisposition.get(part) === 'dangling') {
      handleNonTextPart(part, msg, createdMs, createdIso, emitForMessage, deps.degradations, deps.compactionDisposition)
    }
  }
}

/** T2：user message → 一条 pi user entry（text part 逐条保留；file part 丢弃计降级）。 */
function convertUserMessage(
  msg: ZcodeMessageInput,
  createdMs: number | undefined,
  createdIso: string | undefined,
  emitEntry: (type: string, timestamp: string | undefined, rest: Record<string, unknown>) => void,
  degradations: ImportDegradation[],
  compactionDisposition: WeakMap<Record<string, unknown>, 'merged' | 'dangling'>,
): void {
  const content: Array<Record<string, unknown>> = []
  for (const part of msg.parts) {
    const type = part.type
    if (type === 'text') {
      pushTextPart(part, content, msg.id, degradations)
      continue
    }
    if (type === 'file') {
      // D6：zcode-artifact:// 私有协议引用，太极无法解析（artifact 二进制在 zcode 私有存储）
      pushDegradation(degradations, `user 消息 file part 丢弃（zcode-artifact 引用无法搬运，D6）：message=${msg.id}`, msg.id)
      continue
    }
    handleNonTextPart(part, msg, createdMs, createdIso, emitEntry, degradations, compactionDisposition)
  }
  // T2 时间双轨：entry.timestamp = ISO(ms)、message.timestamp = ms；ms 不可解时缺省键（RT-5#8）
  emitEntry('message', createdIso, {
    message: { role: 'user', content, ...(createdMs !== undefined && { timestamp: createdMs }) },
  })
}

/**
 * T3：assistant message 按 step-finish 切段为多条 pi assistant entry + 紧随的 toolResult。
 * 切分规则：每个 step-finish 闭合一条 entry（step-start/消息结束边界开段；空段不产出）。
 */
function convertAssistantMessage(
  msg: ZcodeMessageInput,
  data: Record<string, unknown>,
  createdMs: number | undefined,
  createdIso: string | undefined,
  emitEntry: (type: string, timestamp: string | undefined, rest: Record<string, unknown>) => void,
  degradations: ImportDegradation[],
  compactionDisposition: WeakMap<Record<string, unknown>, 'merged' | 'dangling'>,
): void {
  const providerId = typeof data.providerId === 'string' ? data.providerId : undefined
  const modelId = typeof data.modelId === 'string' ? data.modelId : undefined
  let segment = newSegment()

  /** 闭合当前段：产出 assistant entry（空段不产出）+ 紧随的 toolResult entries。 */
  const closeSegment = (finishReason: unknown, usage: Record<string, unknown> | undefined): void => {
    if (segment.content.length === 0) return
    // 段时间戳 = 段内首个携带 time.start 的 part ?? message.time.created（§3.4 T3 顶级补充）
    const tsMs = segment.startMs ?? createdMs
    // ms 全链不可解（段无 time 锚 + 消息时间不可解）退消息级时间形态（缺省键保真）
    const tsIso = tsMs !== undefined ? new Date(tsMs).toISOString() : createdIso
    emitEntry('message', tsIso, {
      message: {
        role: 'assistant',
        content: segment.content,
        ...(tsMs !== undefined && { timestamp: tsMs }),
        ...(providerId !== undefined && { provider: providerId }),
        ...(modelId !== undefined && { model: modelId }),
        // 产物不变量门：usage 恒在场（缺 → 零值兜底，zeroUsage 注释）
        usage: usage ?? zeroUsage(),
        // 段有 step-finish 收口 → 采信其 finish；未收口段（取消/失败尾段）→ 消息级
        // data.error 优先，无 error 证据才 'stop' 保底（T3c 事故补强）
        stopReason: finishReason !== undefined ? mapStopReason(finishReason) : unsealedStopReason(data),
      },
    })
    for (const toolResult of segment.toolResults) {
      // timestamp 统一在闭口时注入：段内仅有 tool part 时 startMs 尚未落定（time 锚只在
      // text/reasoning part 上，C1 探针），避免 toolResult 与 assistant entry 时间戳分叉
      emitEntry('message', tsIso, { message: { ...toolResult, ...(tsMs !== undefined && { timestamp: tsMs }) } })
    }
    segment = newSegment()
  }

  for (const part of msg.parts) {
    const type = part.type
    // 段边界：step-start 开新段（前段若未收口仍有内容——异常形态防御，按尾段语义闭合）
    if (type === 'step-start') {
      closeSegment(undefined, undefined)
      continue
    }
    if (type === 'step-finish') {
      const { usage, degradation } = usageFromStepFinish(part)
      if (degradation !== undefined) pushDegradation(degradations, `${degradation}：message=${msg.id}`, msg.id)
      closeSegment(part.reason, usage)
      continue
    }
    if (type === 'text') {
      if (segment.startMs === undefined) segment.startMs = partStartTime(part)
      pushTextPart(part, segment.content, msg.id, degradations)
      continue
    }
    if (type === 'reasoning') {
      if (segment.startMs === undefined) segment.startMs = partStartTime(part)
      const thinking = part.text
      if (typeof thinking !== 'string') {
        pushDegradation(degradations, `reasoning part 文本形态异常（${typeof thinking}）跳过：message=${msg.id}`, msg.id)
        continue
      }
      segment.content.push({ type: 'thinking', thinking })
      continue
    }
    if (type === 'tool') {
      convertToolPart(part, msg, segment, degradations)
      continue
    }
    handleNonTextPart(part, msg, createdMs, createdIso, emitEntry, degradations, compactionDisposition)
  }
  // 消息结束边界：未收口且有内容则闭合（尾段 stopReason 走 data.error 优先的
  // unsealedStopReason；usage 无源则零值兜底——取消/失败轮的标准落点）
  closeSegment(undefined, undefined)
}

/**
 * tool arguments 解析（T3②）：state.input 为对象时直通；缺失/null → {}；其余形态按空入参
 * 转换并登记降级（非对象形态超出已验证域，不阻断该工具对的转换）。
 */
function toolCallArguments(
  input: unknown,
  toolName: string,
  callId: string,
  msgId: string,
  degradations: ImportDegradation[],
): Record<string, unknown> {
  if (input === undefined || input === null) return {}
  if (isRecord(input)) return input
  pushDegradation(
    degradations,
    `tool「${toolName}」input 形态超出已验证域（typeof ${typeof input}），按空入参转换：callID=${callId}`,
    msgId,
  )
  return {}
}

/**
 * L3 保真损失登记（§7.4）：serialization.truncated=true → 截断版 output 原样保留进
 * toolResult（保真损失非消息丢弃），另登记结构化降级。wire 契约 ImportDegradation 无
 * tool/bytes 字段——按现有信息可用性记宿主消息 (kind, source)；tool 名可从产物 toolCall
 * 流按 callID 回查，字节明细走 runtime 日志通道（§7.4「全量明细不入 wire」）。
 */
function registerTruncatedOutput(
  state: Record<string, unknown>,
  msgData: Record<string, unknown>,
  degradations: ImportDegradation[],
): void {
  const partMetadata = isRecord(state.metadata) ? state.metadata : undefined
  const serialization =
    partMetadata !== undefined && isRecord(partMetadata.serialization) ? partMetadata.serialization : undefined
  if (serialization?.truncated === true) {
    degradations.push({ code: 'truncated_output', count: 1, ...degradationMeta(msgData) })
  }
}

/** tool part → 段内 toolCall content part + 待紧随的 toolResult message 体（T3①②/T4）。 */
function convertToolPart(
  part: Record<string, unknown>,
  msg: ZcodeMessageInput,
  segment: AssistantSegment,
  degradations: ImportDegradation[],
): void {
  const callId = part.callID
  const toolName = part.tool
  const state = part.state
  if (typeof callId !== 'string' || typeof toolName !== 'string' || !isRecord(state)) {
    pushDegradation(degradations, `tool part 结构异常（callID/tool/state 形态）整对丢弃：message=${msg.id}`, msg.id)
    return
  }
  const status = state.status
  if (status !== 'completed' && status !== 'error') {
    // running/pending/未知 status：整对丢弃（不产 toolCall 也不产 toolResult）——dangling
    // toolCall 会破坏续聊请求形态（F5/F7）；未知 status 无从构造结果，同款处理
    pushDegradation(
      degradations,
      `未完成 tool（status=${String(status)}）整对丢弃（D7，防 dangling toolCall）：callID=${callId} tool=${toolName}`,
      msg.id,
    )
    return
  }
  const args = toolCallArguments(state.input, toolName, callId, msg.id, degradations)
  const mappedName = mapToolName(toolName)
  segment.content.push({ type: 'toolCall', id: callId, name: mappedName, arguments: args })
  const shape = toolResultShape(state, part, msg.id, degradations)
  registerTruncatedOutput(state, msg.data, degradations)
  // timestamp 由 closeSegment 统一注入（tool part 无 time 字段——C1 探针，与所属段共用段时间戳）
  segment.toolResults.push({
    role: 'toolResult',
    toolCallId: callId,
    toolName: mappedName,
    content: shape.content,
    ...(shape.details !== undefined && { details: shape.details }),
    ...(shape.isError && { isError: true }),
  })
}

/**
 * T5：text 以外的通用 part 分派（user/assistant 消息内同语义）。
 * compaction 按 D2 处置分类分流：merged（已并入摘要宿主的 compaction entry）不再发 custom
 * （防双发）；dangling（指针悬空）发 custom + compaction_unlinked 降级；未登记 = 正常孤儿，
 * 维持现状 custom 通道不计降级。timeline/step-* 不产出；未知 type 跳过 + 降级登记（前向兼容）。
 */
function handleNonTextPart(
  part: Record<string, unknown>,
  msg: ZcodeMessageInput,
  createdMs: number | undefined,
  createdIso: string | undefined,
  emitEntry: (type: string, timestamp: string | undefined, rest: Record<string, unknown>) => void,
  degradations: ImportDegradation[],
  compactionDisposition: WeakMap<Record<string, unknown>, 'merged' | 'dangling'>,
): void {
  const type = part.type
  if (type === 'compaction') {
    const disposition = compactionDisposition.get(part)
    if (disposition === 'merged') return // 已并入摘要宿主的 compaction entry——防双发
    if (disposition === 'dangling') {
      // 悬空指针 = summaryMessageId 指向的消息不在行集（schema 漂移信号，L3 有诊断价值）：
      // 现状 custom 通道保留边界元数据 + compaction_unlinked 降级（sample 仅 unclassified 携带）
      degradations.push({ code: 'compaction_unlinked', count: 1, ...degradationMeta(msg.data) })
    }
    // 正常孤儿 / 悬空指针共同落点：pi compaction 强依赖 summary（渲染为压缩系统消息），
    // 伪造摘要 = 污染上下文（D5）。custom 不进 LLM 上下文、GUI 跳过（F4），无损保留元信息
    const tsMs = partStartTime(part) ?? createdMs
    emitEntry('custom', tsMs !== undefined ? new Date(tsMs).toISOString() : createdIso, {
      customType: 'zcode-import:compaction',
      data: part,
    })
    return
  }
  if (type === 'timeline') {
    return // 纯 UI 事件，无对话语义（D6）
  }
  pushDegradation(degradations, `未知 part type「${String(type)}」跳过（前向兼容）：message=${msg.id}`, msg.id)
}

/** text part → content text part（文本非 string 形态登记降级并跳过）。 */
function pushTextPart(
  part: Record<string, unknown>,
  content: Array<Record<string, unknown>>,
  msgId: string,
  degradations: ImportDegradation[],
): void {
  const text = part.text
  if (typeof text !== 'string') {
    pushDegradation(degradations, `text part 文本形态异常（${typeof text}）跳过：message=${msgId}`, msgId)
    return
  }
  content.push({ type: 'text', text })
}

/** part.data.time.start（ms）——text/reasoning/compaction/timeline 携带，tool/step-* 无。 */
function partStartTime(part: Record<string, unknown>): number | undefined {
  return isRecord(part.time) ? asFinite(part.time.start) : undefined
}

// ── db 读取 + 纯转换组合（对外主入口）────────────────────────────────────────────

/**
 * 读单会话并转换为 NormalizedSession（zcode source 包对外主函数，D1）。
 *
 * 契约面说明：现生产消费方（reader 扩展 / runtime 导入薄包装）均走
 * openZcodeSessionDb + convertZcodeTranscript 组合形态（各自持有分相位错误映射），
 * 本函数当前无生产调用方——保留导出是设计 §1.5 声明的对外主函数（未来第三源契约锚），
 * 第二源落地前的契约面。
 *
 * 开库走 sqlite-access 的 openZcodeSessionDb（存在性 → 四级恢复阶梯 → schema 已知集
 * 闸门）；返回值三键 {header, entries, degradations}（NormalizedSession，session-core
 * 类型强制）。db 行存在性在查询阶段复查（定位校验与会话读取间的竞态窗口）。
 *
 * 错误面（归消费侧，调用方按各自词表映射——reader → zcode_* / runtime 导入 → import_*）：
 * - db 文件不存在 / 恢复阶梯耗尽 → Error（sqlite-access 抛出，消息含路径与已尝试级别）
 * - schema 版本超出已知集 → ZcodeSchemaDriftError（观测版本在 observedVersion 字段）
 * - session 行不存在（zcode 侧 GC / 从未落库）→ Error，消息含 sessionId 与事实归因
 * - 行 data 列 JSON 非法（schema 漂移域）→ 原始 Error 上抛（sqlite-access 不静默跳过）
 */
export async function readZcodeSession(dbPath: string, sessionId: string): Promise<NormalizedSession> {
  const handle = await openZcodeSessionDb(dbPath)
  try {
    const row = handle.db.getSessionRow(sessionId)
    if (!row) {
      throw new Error(
        `该会话已不在 zcode 库中（sessionId=${sessionId}）：该 id 可能已被 zcode 侧回收或从未落库`,
      )
    }
    const transcript = handle.db.getSessionTranscript(sessionId)
    return convertZcodeTranscript(transcript, { id: sessionId, title: row.title, timeCreated: row.timeCreated })
  } finally {
    handle.dispose()
  }
}
