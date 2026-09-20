/**
 * zcode → pi session JSONL 转换器。
 *
 * 输入 = 单会话全量行集（message 按 sequence、part 按 (message.sequence, part.sequence)
 * 联合序，sqlite-access.getSessionTranscript）；输出 = pi session JSONL 文本（首行 header +
 * entry 序列）。两层映射：① 消息级投影分派——逐条消息先经 classifyMessage()（projection.ts
 * 移植体）判定六策略之一（或 unclassified），按消息投影对齐设计 §7.3 映射表落点（三类丢弃
 * 整条不产 entry + L1/L2 聚合降级，unclassified 丢弃 + 独立告警码）；② part 级映射——消息
 * 内部按 session-import-unified 设计 §3.4 权威映射表逐条实现：T1 header/session_info /
 * T2 user / T3 assistant 按 step-finish 切段 / T3b 工具名映射 / T3c stopReason 映射 /
 * T4 tool output 三形态 / T5 其余 part / T6 entry id 递增链；③ compact_summary 合并——
 * D2 完整规格（三路关联判据 + 单条 compaction entry + firstKeptEntryId 三级锚悬空门 +
 * 1:N 最早联合序锚 + 孤儿二分），关联在发射前预扫描趟建立。
 *
 * 排序锚（C1 探针结论，2026-09-19 宿主库只读抽样）：3 个 interactive 会话（1534/1852/29
 * parts）在 ORDER BY message.sequence, part.sequence 联合序下，携带 time 字段的 part
 * （text/reasoning/compaction/timeline；tool/step-* 无 time 字段）其 time.start 全程
 * 非降（3415 parts 零逆序）——联合 sequence 序即事件时序，转换器按输入数组序线性消费，
 * 无需二次按时间排序。
 *
 * 产物正确性锚（设计 §3.4 末）：产物必须能被 taiji 现有消费链（mapSessionEntries →
 * convertPiHistory → replayEntries(applyEntry)）重放——converter.test 以此为可证伪断言。
 */

import type { ImportDegradation } from '@taiji/shared'

import { ImportServiceError } from '../import-source.js'
import { classifyMessage } from './projection.js'
import type { ZcodeReadonlyDb, ZcodeTranscriptMessageRow } from './sqlite-access.js'

/** 目标 pi header（与 ImportArtifact.header 同构；由 prepareImport 产出后传入）。 */
export interface ZcodeImportHeader {
  id: string
  timestamp: string
  cwd: string
}

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

/** 转换产物：JSONL 全文（每行含尾随 '\n'）+ 保真度降级明细（D6/D7，结构化记录）。 */
export interface ZcodeConversionOutput {
  content: string
  degradations: ImportDegradation[]
}

// ── 降级登记（D4 结构化分档，设计 §7.4）──────────────────────────────────────────────
// 两条登记通道，按损失性质区分：
// ① part 级诊断（pushDegradation）：消息内部局部损失（file part 丢弃、running tool 整对
//    丢弃、malformed 形态跳过、usage 不可解等）——逐条独立 count=1 + sample（messageId
//    定位源消息），code 恒 'dropped_transient'（这些不是消息级丢弃分档 L1/L2/L4——那由
//    分类器在消息边界裁决，走 buildZcodeSessionFile 内的 recordDroppedMessage 聚合）。
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

/** 消息级丢弃的降级码：L1 冗余（tool 通道已保留）/ L2 无语义（非 L1/L3/L4 的丢弃类全量归入）。 */
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

// ── T3c stopReason 映射（§3.4）：zcode finish 实测全域 → pi StopReason 封闭枚举 ─────────
// 尾段（消息结束未收口）/ other / undefined / 未知取值 → 'stop' 保底：taiji 渲染链对
// message 级 stopReason 零消费（设计已核实），stop 是 pi 恢复语义的安全终态。
const STOP_REASON_MAP: Readonly<Record<string, string>> = Object.freeze({
  'tool-calls': 'toolUse',
  stop: 'stop',
  completed: 'stop',
  length: 'length',
  interrupted: 'aborted',
  failed: 'error',
  stream_recovery_discarded: 'error',
  start_plan_admission_retry_discarded: 'error',
})

function mapStopReason(zcodeFinish: unknown): string {
  return typeof zcodeFinish === 'string' ? (STOP_REASON_MAP[zcodeFinish] ?? 'stop') : 'stop'
}

// ── 小型运行时守卫（输入是外部宽形态 JSON，禁 any，malformed 降级不抛错）────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asFinite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 非空字符串守卫（空串不作为有效指针参与解析——与 projection asNonEmptyString 同语义）。 */
function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
// ── T6 entry id 链：8-hex 递增计数器（'00000001' 起），parentId 顺序链（首条 null）──────
// 确定性（可测试）、session 内唯一；pi 不解析 entry id 语义——id 在 pi 侧仅作 opaque map
// key / leaf 指针 / 相等比较（pi 0.84.4 dist/core/session-manager.js:681-682 与 :758-759，
// _buildIndex/_appendEntry 均 byId.set(entry.id, entry) + leafId = entry.id，全库无
// parseInt/形态校验类消费；pi 自身 id 生成 = randomUUID().slice(0,8)，同 8-hex 形态）。
// 依据条目：docs/architecture/session-import-sources.md §5-I8。
const ENTRY_ID_RADIX = 16
const ENTRY_ID_WIDTH = 8

class EntryChain {
  private counter = 0
  private lastId: string | null = null

  next(): { id: string; parentId: string | null } {
    this.counter += 1
    const id = this.counter.toString(ENTRY_ID_RADIX).padStart(ENTRY_ID_WIDTH, '0')
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
    return (this.counter + 1).toString(ENTRY_ID_RADIX).padStart(ENTRY_ID_WIDTH, '0')
  }
}

// ── D2 compaction 关联（设计 §6-D2 / §4.2 关联字段）──────────────────────────────────

/**
 * compact_summary 消息的摘要正文（data.summary.body）。不可用（缺失/非串/空串）→ undefined，
 * 即「不伪造」：调用方退化为现状通道并计 compaction_unlinked（P-4 降级路径）。
 */
function summaryBodyOf(data: Record<string, unknown>): string | undefined {
  const summary = isRecord(data.summary) ? data.summary : undefined
  return asNonEmptyString(summary?.body)
}

/**
 * compaction part 是否携带 timelineStatus——磁盘顶层形态（U0 考古 §2：存量 507/986 条在
 * part 顶层）与 asar schema 的 metadata 包装形态（projection.isTimelineOnlyMessage 的读取
 * 通道）取并集。为什么并集：D2 判据③（zcode 自家 compact-summary 判据）只应对「两处皆无」
 * 的 part 生效——若只查 metadata 通道，U0 的 195 条孤儿（全部携带顶层 timelineStatus）会被
 * 误关联进合并，孤儿比例归零与考古矛盾。
 */
function partHasTimelineStatus(part: Record<string, unknown>): boolean {
  if (typeof part.timelineStatus === 'string') return true
  const metadata = isRecord(part.metadata) ? part.metadata : undefined
  return typeof metadata?.timelineStatus === 'string'
}

/**
 * D2 firstKeptEntryId 三级锚解析（⛔ 悬空门：任何情况不发射悬空 id——P-1 实证悬空锚会把
 * 压缩点之前的历史全部静默截断）：
 * ① tail_start_id 经 messageId→entryId 映射命中——映射表只登记已发射 entry，命中即非悬空；
 * ② 未命中 → 紧邻前驱（保留全部历史，与摘要冗余但无损——「宁多保留不丢历史」保守方向）；
 * ③ compaction entry 是首条 entry（无前驱）→ 其自身 id。
 * 集成路径上 session_info 恒先于消息发射，② 级恒可用，③ 级仅规格完备性防御；独立导出
 * 是为让 ③ 路径可单测（buildZcodeSessionFile 公共面构造不出「无前驱 entry」的输入）。
 */
export function resolveFirstKeptEntryId(
  tier1: string | undefined,
  lastEmittedId: string | null,
  ownId: string,
): string {
  if (tier1 !== undefined) return tier1
  if (lastEmittedId !== null) return lastEmittedId
  return ownId
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

/**
 * step-finish 的 tokens/cost → pi Usage（字段映射表见 §3.4 T3：同名直通/total→totalTokens/…）。
 *
 * RT-5#1 缺省语义：可解分量才写键——「无数据」写成测量值 0 会永久污染落盘用量/费用
 * 统计（usage-stats 扫描聚合即读本产物；gen-stats 同款「禁 ?? 0」纪律：0 只允许作为
 * 真实测量值出现）。全部分量不可解 → 整条 usage 不写 + degradations 显形计数。消费面
 * 已核实对缺键安全：usage-stats 的 `!message?.usage` 存在性守卫、apply-entry-convert
 * 的 isLooseRecord 均按「无数据」跳过。cost 是 number（zcode 形态）→ usage.cost.total
 * （pi Usage.cost 是对象形态，直塞 number 产出非法类型）；cost 分量 zcode 不采集，缺省
 * 不写 0。
 */
function usageFromStepFinish(
  partData: Record<string, unknown>,
  msgId: string,
  degradations: ImportDegradation[],
): Record<string, unknown> | undefined {
  const tokens = partData.tokens
  if (!isRecord(tokens)) return undefined
  const cache = isRecord(tokens.cache) ? tokens.cache : {}
  const input = asFinite(tokens.input)
  const output = asFinite(tokens.output)
  const cacheRead = asFinite(cache.read)
  const cacheWrite = asFinite(cache.write)
  const reasoning = asFinite(tokens.reasoning)
  const totalTokens = asFinite(tokens.total)
  const costTotal = asFinite(partData.cost)
  const usage: Record<string, unknown> = {
    ...(input !== undefined && { input }),
    ...(output !== undefined && { output }),
    ...(cacheRead !== undefined && { cacheRead }),
    ...(cacheWrite !== undefined && { cacheWrite }),
    ...(reasoning !== undefined && { reasoning }),
    ...(totalTokens !== undefined && { totalTokens }),
    ...(costTotal !== undefined && { cost: { total: costTotal } }),
  }
  if (Object.keys(usage).length === 0) {
    pushDegradation(degradations, `step-finish tokens/cost 分量全部不可解，整条 usage 不写：message=${msgId}`, msgId)
    return undefined
  }
  return usage
}

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
 * 组装目标 JSONL 全文（纯函数，设计 §3.4 全表）。
 *
 * @param messages 联合序排好的 message 行集（含 parts）
 * @param title    session.title（T1：第 2 行 session_info.name）
 * @param header   目标 pi header（U3 prepareImport 产出）
 */
export function buildZcodeSessionFile(
  messages: ZcodeMessageInput[],
  title: string,
  header: ZcodeImportHeader,
): ZcodeConversionOutput {
  const degradations: ImportDegradation[] = []
  const lines: string[] = []

  const chain = new EntryChain()
  const emitEntry = (type: string, timestamp: string, rest: Record<string, unknown>): string => {
    const { id, parentId } = chain.next()
    lines.push(JSON.stringify({ type, id, parentId, timestamp, ...rest }))
    return id
  }

  // messageId → entryId 映射表（设计 §6-D2）：D2 合并的 firstKeptEntryId ① 级锚在发射趟
  // 内消费——compaction part 的 tail_start_id（zcode messageId）在此查 entry id。首条
  // wins——「保留起点」锚语义 = 该消息的首条 entry（多段 assistant 消息以其最早段为起点）。
  const messageIdToEntryId = new Map<string, string>()

  // ── D2 关联预扫描（§6-D2 三路关联判据 + 1:N + 孤儿二分）────────────────────────────
  // 两趟结构的两个原因：① 判据①（summaryMessageId）的解析目标是「行集内存在即可」的任意
  // 消息，而合并发射发生在目标消息的处理位次——关联关系必须先于发射趟建立；② 防双发要求在
  // 指针 part 的宿主消息处理时就知道该 part 已被合并（U0 考古 §6：指针宿主 = timeline_event /
  // 无 semantics，多为分类器丢弃类——宿主丢弃时 part 不再流经 part 级通道，无从回头抑制）。
  const policies = messages.map((msg) => classifyMessage(msg.data, msg.parts))
  const messageIds = new Set(messages.map((msg) => msg.id))
  // 可合并 = compactSummary 策略 ∧ summary.body 可用；不可用 → 降级路径（现状通道），
  // 关联 part 不登记、随宿主走现状 custom 通道——断链降级责任在摘要宿主，不在指针 part。
  const mergeable = new Set<string>()
  messages.forEach((msg, i) => {
    if (policies[i] === 'compactSummary' && summaryBodyOf(msg.data) !== undefined) mergeable.add(msg.id)
  })
  // 关联 part 登记处：key = 摘要宿主消息 id；value 按 (message.sequence, part.sequence)
  // 联合序插入（本循环即联合序，首插 = 最早）——1:N 的锚/tokensBefore/details 取 value[0]。
  const linkedParts = new Map<string, Array<Record<string, unknown>>>()
  const pushLinked = (summaryId: string, part: Record<string, unknown>): void => {
    const list = linkedParts.get(summaryId)
    if (list !== undefined) list.push(part)
    else linkedParts.set(summaryId, [part])
  }
  // part 级处置分类（按 part 对象身份查——part 级发射点 handleNonTextPart 只持有 part 引用）：
  //   merged   = 已并入某摘要宿主的 compaction entry（防双发：不再发 custom entry）；
  //   dangling = summaryMessageId 指向的消息不在行集（schema 漂移信号 → custom + compaction_unlinked）。
  // 未登记 = 正常孤儿（走现状 custom 通道不计降级）或宿主被丢弃（随宿主消失，已被丢弃决策接受）。
  const compactionDisposition = new WeakMap<Record<string, unknown>, 'merged' | 'dangling'>()
  messages.forEach((msg, i) => {
    const semantics = isRecord(msg.data.semantics) ? msg.data.semantics : undefined
    for (const part of msg.parts) {
      if (part.type !== 'compaction') continue
      const summaryId = asNonEmptyString(part.summaryMessageId)
      if (summaryId !== undefined) {
        // ①（最高优先）：目标「行集内存在即可」，不限定 semantics.kind——U0 §7：指针目标
        // 167/479 是 legacy 无 semantics user 消息，限定 kind 会把 legacy 会话全量误判断链
        if (!messageIds.has(summaryId)) {
          compactionDisposition.set(part, 'dangling')
        } else if (mergeable.has(summaryId)) {
          compactionDisposition.set(part, 'merged')
          pushLinked(summaryId, part)
        }
        continue
      }
      // ②：宿主消息即 compact_summary（U0 §7：312 条 = 宿主 [compaction+text] 双 part 本体形态）
      if (semantics?.kind === 'compact_summary' && mergeable.has(msg.id)) {
        compactionDisposition.set(part, 'merged')
        pushLinked(msg.id, part)
        continue
      }
      // ③：zcode 自家判据（user 消息含无 timelineStatus 的 compaction part）。必须限定宿主
      // 策略为 compactSummary——否则关联落在一个不发射 compaction entry 的宿主上，part 被
      // 防双发抑制却无处合并 = 静默丢失。
      if (msg.data.role === 'user' && !partHasTimelineStatus(part) && mergeable.has(msg.id)) {
        compactionDisposition.set(part, 'merged')
        pushLinked(msg.id, part)
        continue
      }
    }
  })

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

  // T1：首行 header（version=3 = pi CURRENT_SESSION_VERSION）+ 第 2 行 session_info
  lines.push(JSON.stringify({ type: 'session', version: 3, ...header }))
  emitEntry('session_info', header.timestamp, typeof title === 'string' && title.length > 0 ? { name: title } : {})

  // 消息级时间兜底：message.data.time.created 缺失时回落 session 创建时刻（确定性，无
  // Date.now）。RT-5#8：header.timestamp 不可解（生产链路由 prepareImport 的
  // Number.isFinite 守卫恒合法，此处防御直接构造坏 header 的输入）不以 0 兜底——0 会
  // 产出 1970 假时间戳污染排序与按日统计；降级登记一次，各时间戳退 header 原串/缺省。
  const headerMs = Date.parse(header.timestamp)
  const fallbackMs = Number.isFinite(headerMs) ? headerMs : undefined
  if (fallbackMs === undefined) {
    pushDegradation(degradations, `header.timestamp 不可解（${header.timestamp}），时间戳退原串/缺省：不伪造 1970`)
  }

  for (const [msgIndex, msg] of messages.entries()) {
    const data = msg.data
    // 分派以投影分类结果为准（§7.3 映射表）——role 不再是分派依据（D1：显隐与 zcode GUI
    // 同源，合成消息/隐藏注入不再冒充用户消息；无标记未知 role 由分类器兜底链裁决落点）。
    // 分类结果已在 D2 预扫描趟计算（关联判据需要全行集策略视图），此处复用。
    const policy = policies[msgIndex]
    const time = isRecord(data.time) ? data.time : {}
    const createdMs = asFinite(time.created) ?? fallbackMs
    // entry 时间戳不可解时退 header 原串（保真 > 伪造）；message.timestamp（ms）缺省键
    const createdIso = createdMs !== undefined ? new Date(createdMs).toISOString() : header.timestamp
    // 每消息发射包装：entry 发射时登记 messageId → entryId（首条 wins）
    const emitForMessage = (type: string, timestamp: string, rest: Record<string, unknown>): void => {
      const entryId = emitEntry(type, timestamp, rest)
      if (!messageIdToEntryId.has(msg.id)) messageIdToEntryId.set(msg.id, entryId)
    }

    switch (policy) {
      case 'realUserInput':
        convertUserMessage(msg, createdMs, createdIso, emitForMessage, degradations, compactionDisposition)
        break
      case 'visibleAssistant':
        convertAssistantMessage(msg, data, createdMs, createdIso, emitForMessage, degradations, compactionDisposition)
        break
      case 'compactSummary': {
        // D2 合并（§6-D2）：compact_summary 宿主消息与其关联 compaction part 合并为单条 pi
        // compaction entry（替换 U3 现状的 user entry + custom 通道——失败模式 C：摘要以 user
        // 消息形态进上下文却无压缩语义）。summary 不可用 → 不伪造，整条退化为现状形态。
        const body = summaryBodyOf(data)
        if (body === undefined) {
          convertUserMessage(msg, createdMs, createdIso, emitForMessage, degradations, compactionDisposition)
          degradations.push({ code: 'compaction_unlinked', count: 1, ...degradationMeta(data) })
          break
        }
        // 合并发射：每个 compactSummary 消息至多一条 compaction entry。1:N 关联 part 合流，
        // 锚/tokensBefore/details 取联合序最早 part（首插 = 最早，见预扫描 linkedParts 注释；
        // 取偏晚锚会静默偏移续聊上下文——设计 §6-D2 否决）。宿主 text part 随合并被消费
        // （摘要正文走 summary 字段，P-4：312/312 宿主 data.summary.body 齐备）。
        const anchor = linkedParts.get(msg.id)?.[0]
        const tokensBefore = anchor !== undefined ? asFinite(anchor.preCompactTokenCount) : undefined
        const anchorMs = anchor !== undefined ? partStartTime(anchor) : undefined
        const tsMs = anchorMs ?? createdMs
        // ① 级锚发射前解析：messageIdToEntryId 只登记已发射 entry，命中即非悬空（⛔ 悬空门）
        const tailId = anchor !== undefined ? asNonEmptyString(anchor.tail_start_id) : undefined
        const tier1 = tailId !== undefined ? messageIdToEntryId.get(tailId) : undefined
        // ③ 级锚需要自身 id、payload 又必须先于发射组装——peek() 预览不推进计数器
        const ownId = chain.peek()
        emitForMessage('compaction', tsMs !== undefined ? new Date(tsMs).toISOString() : createdIso, {
          summary: body,
          firstKeptEntryId: resolveFirstKeptEntryId(tier1, chain.last(), ownId),
          ...(tokensBefore !== undefined && { tokensBefore }),
          ...(anchor !== undefined && { details: anchor }),
        })
        // 合并路径不迭代 part（不产 user entry / custom entry），宿主自带的悬空指针 part
        // 在此显式登记漂移信号（流式路径的同一判定在 handleNonTextPart，弱映射表共享）
        for (const part of msg.parts) {
          if (part.type === 'compaction' && compactionDisposition.get(part) === 'dangling') {
            degradations.push({ code: 'compaction_unlinked', count: 1, ...degradationMeta(data) })
          }
        }
        break
      }
      case 'providerContextOnly':
      case 'hiddenSynthetic':
      case 'timelineOnly':
        // D3：整条丢弃不产 entry——内容已由 tool 通道保留（L1）或无对话语义（L2）
        recordDroppedMessage({ code: droppedMessageCode(data), count: 1, ...degradationMeta(data) })
        break
      case 'unclassified':
        // D4/L4：丢弃 + 独立告警码 + 首条 sample（messageId + 文本前 80 字）
        recordDroppedMessage({
          code: 'unclassified',
          count: 1,
          ...degradationMeta(data),
          sample: { messageId: msg.id, preview: messageTextPreview(msg.parts).slice(0, DEGRADATION_PREVIEW_MAX) },
        })
        break
      default: {
        const exhaustive: never = policy
        throw new Error(`未处理的投影策略：${String(exhaustive)}`)
      }
    }
  }

  // 丢弃聚合组按首遇序并入（part 级诊断条目保持逐条在前的登记形态）
  degradations.push(...dropGroups.values())

  return { content: lines.map((l) => `${l}\n`).join(''), degradations }
}

/** T2：user message → 一条 pi user entry（text part 逐条保留；file part 丢弃计降级）。 */
function convertUserMessage(
  msg: ZcodeMessageInput,
  createdMs: number | undefined,
  createdIso: string,
  emitEntry: (type: string, timestamp: string, rest: Record<string, unknown>) => void,
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
  createdIso: string,
  emitEntry: (type: string, timestamp: string, rest: Record<string, unknown>) => void,
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
    // ms 全链不可解（段无 time 锚 + 消息时间不可解）退消息级 ISO 兜底（header 原串保真）
    const tsIso = tsMs !== undefined ? new Date(tsMs).toISOString() : createdIso
    emitEntry('message', tsIso, {
      message: {
        role: 'assistant',
        content: segment.content,
        ...(tsMs !== undefined && { timestamp: tsMs }),
        ...(providerId !== undefined && { provider: providerId }),
        ...(modelId !== undefined && { model: modelId }),
        ...(usage !== undefined && { usage }),
        stopReason: mapStopReason(finishReason),
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
      closeSegment(part.reason, usageFromStepFinish(part, msg.id, degradations))
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
  // 消息结束边界：未收口且有内容则闭合（T3c 尾段 → stop 保底；无 step-finish 即无 usage）
  closeSegment(undefined, undefined)
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
  // arguments：state.input 为对象时直通；缺失/非对象 → {}（非对象形态登记降级）
  let args: Record<string, unknown> = {}
  if (state.input === undefined || state.input === null) {
    args = {}
  } else if (isRecord(state.input)) {
    args = state.input
  } else {
    pushDegradation(
      degradations,
      `tool「${toolName}」input 形态超出已验证域（typeof ${typeof state.input}），按空入参转换：callID=${callId}`,
      msg.id,
    )
  }
  const mappedName = mapToolName(toolName)
  segment.content.push({ type: 'toolCall', id: callId, name: mappedName, arguments: args })
  const shape = toolResultShape(state, part, msg.id, degradations)
  // L3 保真损失（§7.4）：serialization.truncated=true → 截断版 output 原样保留进 toolResult
  // （保真损失非消息丢弃），另登记结构化降级。wire 契约 ImportDegradation 无 tool/bytes 字段
  // （U2 已收窄并提交）——按现有信息可用性记宿主消息 (kind, source)；tool 名可从产物 toolCall
  // 流按 callID 回查，字节明细走 runtime 日志通道（§7.4「全量明细不入 wire」）。
  const partMetadata = isRecord(state.metadata) ? state.metadata : undefined
  const serialization =
    partMetadata !== undefined && isRecord(partMetadata.serialization) ? partMetadata.serialization : undefined
  if (serialization?.truncated === true) {
    degradations.push({ code: 'truncated_output', count: 1, ...degradationMeta(msg.data) })
  }
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
  createdIso: string,
  emitEntry: (type: string, timestamp: string, rest: Record<string, unknown>) => void,
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

// ── db 读取 + 纯转换组合（write 闭包的数据源）────────────────────────────────────────

/**
 * 读单会话全量行集并转换（sqlite-access 查询面 + 纯转换）。
 *
 * 错误语义（§3.6）：session 行在写入阶段复查不存在（prepareImport 校验与会话写入间的
 * 竞态窗口）→ import_invalid_session；查询/JSON 解析失败抛原始 Error，由调用方
 * （import-source-zcode write 闭包）按 schema 漂移映射 import_invalid_session。
 */
export function convertZcodeSession(
  db: ZcodeReadonlyDb,
  sessionId: string,
  header: ZcodeImportHeader,
): ZcodeConversionOutput {
  const row = db.getSessionRow(sessionId)
  if (!row) {
    throw new ImportServiceError(
      'import_invalid_session',
      `该会话已不在 zcode 库中（sessionId=${sessionId}，写入阶段复查不存在），请刷新列表后重选`,
    )
  }
  const transcript: ZcodeTranscriptMessageRow[] = db.getSessionTranscript(sessionId)
  return buildZcodeSessionFile(transcript, row.title, header)
}
