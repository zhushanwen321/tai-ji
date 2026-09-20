/**
 * zcode → canonical session 转换器（自 runtime services/session/zcode-import/converter.ts
 * 迁入改造，session-reader-shared-core 设计 §3.3 D1 + §5 Phase 2；runtime 侧旧文件已
 * 随共享基座实施收口删除（git 可追溯），本包为其唯一现行承载）。
 *
 * 输入 = 单会话全量行集（message 按 sequence、part 按 (message.sequence, part.sequence)
 * 联合序，sqlite-access.getSessionTranscript）；输出 = canonical `Entry[]`（session-core
 * 严格 Entry 模型，parentId 顺序链完整）。映射逐条实现：T1 header/session_info /
 * T2 user / T3 assistant 按 step-finish 切段 / T3b 工具名映射 / T3c stopReason 映射 /
 * T4 tool output 三形态 / T5 其余 part / T6 entry id 递增链。
 *
 * 相对 runtime 旧版的改造（设计 D1「canonical 模型 = pi 形态的严格 Entry 树」）：
 * - emitEntry 不再 stringify 落 JSONL 行，改产 Entry 对象（键序仍按
 *   `{type, id, parentId, timestamp, ...payload}` 构造——serializeSession 的字节契约
 *   责任在构造方，导入侧薄包装拼 header 行 + serializeSession 即得与旧产物逐字节
 *   兼容的 JSONL）；message 内 pi 透传字段（timestamp/provider/model/usage/stopReason、
 *   toolResult 的 details/isError、session_info 的 name）是 canonical Entry 冻结接口外
 *   的合法载荷字段——经宽形态构造 + 边界收口守卫（toCanonicalEntry）承载，序列化
 *   原样落盘、reader 渲染链可直接消费，不做有损裁剪。
 * - entry id 生成收敛基座单点：normalizeZcodeRowId（8-hex 零填充，与 pi 自身
 *   randomUUID().slice(0,8) 同形态；pi 侧对 entry id 仅作 opaque map key 消费）。
 * - 对外主函数 readZcodeSession(dbPath, sessionId) → NormalizedSession
 *   （{header, entries, degradations} 三键，形状由 session-core 类型强制）。
 *   header 由库内 session 行构造：id 归一化（normalizeZcodeSessionId）、timestamp 取
 *   session 创建时间、cwd 缺省留空——zcode 会话无 cwd 概念，不伪造（D1）。
 *   首行 `{type:'session', version:3, ...header}` 不由本模块产出（属序列化装配面：
 *   导入薄包装 / reader 侧各自拼装）。
 * - 错误面归消费侧（§1.5 契约第 4 条）：session 行不存在、归一化失败、查询/JSON
 *   解析失败均抛普通 Error 原样上抛——reader 侧映射 zcode_* 词表、runtime 导入侧
 *   映射 import_* 词表，本包不私建错误码与恢复话术。
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
import type { Entry, NormalizedSession, SessionHeader } from '@zhushanwen/session-core'

import { openZcodeSessionDb } from './sqlite-access.ts'
import { normalizeZcodeSessionId } from './normalize.ts'

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

// ── T3b 工具名映射：zcode 首字母大写 → taiji 渲染判定层的全小写匹配域 ──────────────
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

// ── T3c stopReason 映射：zcode finish 实测全域 → pi StopReason 封闭枚举 ─────────────
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

function finiteMs(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function asFinite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

// ── T6 entry id 链：8-hex 递增计数器（'00000001' 起），parentId 顺序链（首条 null）──────
// 确定性（可测试）、session 内唯一；pi 不解析 entry id 语义——id 在 pi 侧仅作 opaque map
// key / leaf 指针 / 相等比较（pi 0.84.4 dist/core/session-manager.js:681-682 与 :758-759，
// _buildIndex/_appendEntry 均 byId.set(entry.id, entry) + leafId = entry.id，全库无
// parseInt/形态校验类消费；pi 自身 id 生成 = randomUUID().slice(0,8)，同 8-hex 形态）。
// id 值域归一化收敛基座单点 normalizeZcodeRowId（D1 最小例子）。
const ENTRY_ID_START = 1

class EntryChain {
  private counter = ENTRY_ID_START - 1
  private lastId: string | null = null

  next(): { id: string; parentId: string | null } {
    this.counter += 1
    const id = normalizeZcodeRowId(this.counter)
    const parentId = this.lastId
    this.lastId = id
    return { id, parentId }
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

/** step-finish 的 tokens/cost → pi Usage（字段映射表见 T3：同名直通/total→totalTokens/…）。 */
function usageFromStepFinish(partData: Record<string, unknown>): Record<string, unknown> | undefined {
  const tokens = partData.tokens
  if (!isRecord(tokens)) return undefined
  const cache = isRecord(tokens.cache) ? tokens.cache : {}
  // cost 是 number（zcode 形态）→ usage.cost.total，其余 cost 分量补 0（pi Usage.cost 是
  // 对象形态，直塞 number 产出非法类型）
  const costTotal = asFinite(partData.cost) ?? 0
  const reasoning = asFinite(tokens.reasoning)
  return {
    input: asFinite(tokens.input) ?? 0,
    output: asFinite(tokens.output) ?? 0,
    cacheRead: asFinite(cache.read) ?? 0,
    cacheWrite: asFinite(cache.write) ?? 0,
    ...(reasoning !== undefined && { reasoning }),
    totalTokens: asFinite(tokens.total) ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
  }
}

/**
 * T4：tool part 的 state.output → pi toolResult 的 content/details 三形态。
 *
 * C2 探针结论（2026-09-19 宿主库全库只读抽样，345,632 条 tool part）：state 恒为内嵌
 * JSON 对象（字符串旧形态 0 条）；state.output typeof 全库仅两形态——string ≈341.8k
 * （completed 态全部）/ 缺失 3,829（其中 error 态 3,807 条 output 全缺失且 state.error
 * 100% 非空，running 22 条无输出）。object 形态当前全库 0 条——object 分支是前向防御
 * （沿用 reader.ts 已确立的 string/object 惯例，不发明第二形状）；未覆盖形态
 * （number/boolean/array）按「跳过+降级登记」处理。
 */
function toolResultShape(
  state: Record<string, unknown>,
  partData: Record<string, unknown>,
  msgId: string,
  degradations: string[],
): { content: Array<Record<string, unknown>>; details?: Record<string, unknown>; isError: boolean } {
  const status = state.status
  const output = state.output
  if (status === 'error') {
    // 错误原因必须可见：error 态实测 output 恒缺失、文本在 state.error（100% 有值）；
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
  degradations.push(
    `tool「${String(partData.tool)}」output 形态超出已验证域（typeof ${typeof output}），跳过输出：message=${msgId}`,
  )
  return { content: [], isError: false }
}

// ── 纯转换主体 ─────────────────────────────────────────────────────────────────────

/**
 * 把联合序排好的 message 行集转换为 canonical entries（纯函数，映射全表）。
 *
 * @param messages 联合序排好的 message 行集（含 parts）
 * @param session  session 行消费列（header 来源：id 归一化 / timestamp = timeCreated ISO）
 */
export function convertZcodeTranscript(
  messages: ZcodeMessageInput[],
  session: ZcodeSessionInput,
): NormalizedSession {
  const degradations: string[] = []
  const entries: Entry[] = []

  // session.timeCreated 非有限数（纯函数直接调用绕过 sqlite-access 行守卫时）归一为 0，
  // 与消息级时间兜底同源——ISO 产出恒确定，不因输入形态抛 RangeError
  const sessionCreatedMs = finiteMs(session.timeCreated, 0)
  const headerTimestamp = new Date(sessionCreatedMs).toISOString()
  const header: SessionHeader = {
    id: normalizeZcodeSessionId(session.id),
    timestamp: headerTimestamp,
  }

  const chain = new EntryChain()
  const emitEntry = (type: string, timestamp: string, rest: Record<string, unknown>): void => {
    const { id, parentId } = chain.next()
    // 键序 = serializeSession 字节契约（pi appendMessage 同款）：{type, id, parentId, timestamp, ...payload}
    entries.push(toCanonicalEntry({ type, id, parentId, timestamp, ...rest }))
  }

  // T1：session_info entry（name = session.title；空 title 不带 name 字段——可选语义）。
  // 首行 header（{type:'session', version:3, ...header}）不在此产出（序列化装配面）。
  emitEntry('session_info', headerTimestamp, typeof session.title === 'string' && session.title.length > 0 ? { name: session.title } : {})

  // 消息级时间兜底：message.data.time.created 缺失时回落 session 创建时刻（确定性，无 Date.now）
  const fallbackMs = sessionCreatedMs

  for (const msg of messages) {
    const data = msg.data
    const role = data.role
    const time = isRecord(data.time) ? data.time : {}
    const createdMs = finiteMs(time.created, fallbackMs)
    const createdIso = new Date(createdMs).toISOString()

    if (role === 'user') {
      convertUserMessage(msg, createdMs, createdIso, emitEntry, degradations)
      continue
    }
    if (role === 'assistant') {
      convertAssistantMessage(msg, data, createdMs, emitEntry, degradations)
      continue
    }
    // 前向兼容：zcode 未来新增 role 不炸读取（未知 part type 同款语义）
    degradations.push(`未知 message role「${String(role)}」跳过：message=${msg.id}`)
  }

  return { header, entries, degradations }
}

/** T2：user message → 一条 pi user entry（text part 逐条保留；file part 丢弃计降级）。 */
function convertUserMessage(
  msg: ZcodeMessageInput,
  createdMs: number,
  createdIso: string,
  emitEntry: (type: string, timestamp: string, rest: Record<string, unknown>) => void,
  degradations: string[],
): void {
  const content: Array<Record<string, unknown>> = []
  for (const part of msg.parts) {
    const type = part.type
    if (type === 'text') {
      pushTextPart(part, content, msg.id, degradations)
      continue
    }
    if (type === 'file') {
      // zcode-artifact:// 私有协议引用，太极无法解析（artifact 二进制在 zcode 私有存储）
      degradations.push(`user 消息 file part 丢弃（zcode-artifact 引用无法搬运）：message=${msg.id}`)
      continue
    }
    handleNonTextPart(part, msg, createdMs, emitEntry, degradations)
  }
  // T2 时间双轨：entry.timestamp = ISO(ms)、message.timestamp = ms
  emitEntry('message', createdIso, {
    message: { role: 'user', content, timestamp: createdMs },
  })
}

/**
 * T3：assistant message 按 step-finish 切段为多条 pi assistant entry + 紧随的 toolResult。
 * 切分规则：每个 step-finish 闭合一条 entry（step-start/消息结束边界开段；空段不产出）。
 */
function convertAssistantMessage(
  msg: ZcodeMessageInput,
  data: Record<string, unknown>,
  createdMs: number,
  emitEntry: (type: string, timestamp: string, rest: Record<string, unknown>) => void,
  degradations: string[],
): void {
  const providerId = typeof data.providerId === 'string' ? data.providerId : undefined
  const modelId = typeof data.modelId === 'string' ? data.modelId : undefined
  let segment = newSegment()

  /** 闭合当前段：产出 assistant entry（空段不产出）+ 紧随的 toolResult entries。 */
  const closeSegment = (finishReason: unknown, usage: Record<string, unknown> | undefined): void => {
    if (segment.content.length === 0) return
    // 段时间戳 = 段内首个携带 time.start 的 part ?? message.time.created
    const tsMs = segment.startMs ?? createdMs
    emitEntry('message', new Date(tsMs).toISOString(), {
      message: {
        role: 'assistant',
        content: segment.content,
        timestamp: tsMs,
        ...(providerId !== undefined && { provider: providerId }),
        ...(modelId !== undefined && { model: modelId }),
        ...(usage !== undefined && { usage }),
        stopReason: mapStopReason(finishReason),
      },
    })
    for (const toolResult of segment.toolResults) {
      // timestamp 统一在闭口时注入：段内仅有 tool part 时 startMs 尚未落定（time 锚只在
      // text/reasoning part 上，C1 探针），避免 toolResult 与 assistant entry 时间戳分叉
      emitEntry('message', new Date(tsMs).toISOString(), { message: { ...toolResult, timestamp: tsMs } })
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
      closeSegment(part.reason, usageFromStepFinish(part))
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
        degradations.push(`reasoning part 文本形态异常（${typeof thinking}）跳过：message=${msg.id}`)
        continue
      }
      segment.content.push({ type: 'thinking', thinking })
      continue
    }
    if (type === 'tool') {
      convertToolPart(part, msg, segment, degradations)
      continue
    }
    handleNonTextPart(part, msg, createdMs, emitEntry, degradations)
  }
  // 消息结束边界：未收口且有内容则闭合（T3c 尾段 → stop 保底；无 step-finish 即无 usage）
  closeSegment(undefined, undefined)
}

/** tool part → 段内 toolCall content part + 待紧随的 toolResult message 体（T3①②/T4）。 */
function convertToolPart(
  part: Record<string, unknown>,
  msg: ZcodeMessageInput,
  segment: AssistantSegment,
  degradations: string[],
): void {
  const callId = part.callID
  const toolName = part.tool
  const state = part.state
  if (typeof callId !== 'string' || typeof toolName !== 'string' || !isRecord(state)) {
    degradations.push(`tool part 结构异常（callID/tool/state 形态）整对丢弃：message=${msg.id}`)
    return
  }
  const status = state.status
  if (status !== 'completed' && status !== 'error') {
    // running/pending/未知 status：整对丢弃（不产 toolCall 也不产 toolResult）——dangling
    // toolCall 会破坏续聊请求形态；未知 status 无从构造结果，同款处理
    degradations.push(
      `未完成 tool（status=${String(status)}）整对丢弃（防 dangling toolCall）：callID=${callId} tool=${toolName}`,
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
    degradations.push(
      `tool「${toolName}」input 形态超出已验证域（typeof ${typeof state.input}），按空入参转换：callID=${callId}`,
    )
  }
  const mappedName = mapToolName(toolName)
  segment.content.push({ type: 'toolCall', id: callId, name: mappedName, arguments: args })
  const shape = toolResultShape(state, part, msg.id, degradations)
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
 * compaction → custom entry 降级标记 + 明细登记；timeline 不产出（纯 UI 事件）；
 * 未知 type 跳过 + 明细登记（前向兼容）——两降级点均不静默丢弃（D1 degradations 契约：
 * 转换降级必须留痕；reader 侧只记日志、导入侧经 warning='conversion_degraded' 通道消费）。
 */
function handleNonTextPart(
  part: Record<string, unknown>,
  msg: ZcodeMessageInput,
  createdMs: number,
  emitEntry: (type: string, timestamp: string, rest: Record<string, unknown>) => void,
  degradations: string[],
): void {
  const type = part.type
  if (type === 'compaction') {
    // zcode compaction 无摘要文本：pi compaction 强依赖 summary（渲染为压缩系统消息），
    // 伪造摘要 = 污染上下文。custom 不进 LLM 上下文、GUI 跳过，无损保留元信息（data 原样）
    const tsMs = partStartTime(part) ?? createdMs
    emitEntry('custom', new Date(tsMs).toISOString(), {
      customType: 'zcode-import:compaction',
      data: part,
    })
    degradations.push(`compaction part 降级为 custom entry zcode-import:compaction（无摘要文本，不伪造 summary）：message=${msg.id}`)
    return
  }
  if (type === 'timeline') {
    return // 纯 UI 事件，无对话语义
  }
  degradations.push(`未知 part type「${String(type)}」跳过（前向兼容）：message=${msg.id}`)
}

/** text part → content text part（文本非 string 形态登记降级并跳过）。 */
function pushTextPart(
  part: Record<string, unknown>,
  content: Array<Record<string, unknown>>,
  msgId: string,
  degradations: string[],
): void {
  const text = part.text
  if (typeof text !== 'string') {
    degradations.push(`text part 文本形态异常（${typeof text}）跳过：message=${msgId}`)
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
