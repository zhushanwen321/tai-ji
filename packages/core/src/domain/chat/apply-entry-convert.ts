/**
 * apply-entry 模块群 · message body 转换群（apply-entry.ts + apply-entry-convert.ts +
 * apply-entry-utils.ts 三件套）。
 *
 * 本文件承载 message entry 体 → xyz Message 的转换链（content parts 解析 / skill block
 * 剖离 / usage / fileChanges 静态提取 / user-assistant 转换）与 toolResult 回填字段计算
 * （computeToolCallFill）。reducer 本体（apply* handler / applyEntry / replayEntries）在
 * apply-entry.ts，共享底层在 apply-entry-utils.ts；规则迁移源叙事见 apply-entry.ts 文件头。
 *
 * 本模块群自包含约束（runtime tsup 打包 / renderer vite 消费双重入口）：本模块群
 * （apply-entry.ts + apply-entry-convert.ts + apply-entry-utils.ts）只 import
 * '@xyz-agent/shared' 与群内文件，不 import core 内群外模块（防 vue 依赖渗入 runtime bundle）。
 * 依赖单向：本文件 → utils（apply-entry.ts → 本文件 + utils），禁止反向 import / 循环。
 */
import type {
  ContentBlock,
  FileChange,
  Message,
  PiMessageBody,
  Segment,
  ThinkingBlock,
  ToolCall,
} from '@xyz-agent/shared'
import {
  findSkillDataBlockRange,
  parseSkillMarkers,
  parseSkillsFallbackBlocks,
  textToSegments,
} from '@xyz-agent/shared'

import { isLooseRecord, isPlainRecord, normalizePiToolResult, truncateEntryToolOutput } from './apply-entry-utils'

/**
 * [簇 A2] defer 队列 flush 投递确认标记正则（SSOT，submitQueuedEntry 附加的形态）。
 *
 * 裸 uuid v4 形态（entry.id = crypto.randomUUID()，无 u- 前缀）——与 u- 前缀的 clientUuid
 * 标记（submitSegments / msg-id-mapper TAG_MATCH 族，`u-[0-9a-fA-F-]{36}`）id 空间互斥：
 * uuid 字符集不含字母 u，本正则结构上不可能命中 u- 标记（反之 TAG_MATCH 也不命中裸标记
 * ——msg-id-mapper input hook 不剥裸标记，标记经 pi prompt / steer 通路全程存活、落盘与
 * 回流文本携带标记——已锚定 PS-26 + 探针 pi-semantics-defer-marker-survival：prompt()
 * input hook 是 pi 唯一文本 transform 面且 steer 通路零 hook，回流文本携带 →
 * user-delivery ①a 按 id 确认出队）。全文搜索（标记在 skill 展开块拼接 /
 * BeforeSend hook 改写后可能不在文本尾）。
 *
 * 消费方：① convertMessageBody user 投影剥标记（下方，live 帧 / reload 重放同点——显示
 * 层不暴露实现标记，且剥后基线文本 = confirmDelivery overlay 文本，mergeBaselineWithLive
 * 文本去重命中不双计）；② effects/user-delivery ①a 提取 id；③ renderer QueueBubble
 * 快照文本剥标记。三处同 import 本常量，禁复制字面量。
 */
export const DEFER_FLUSH_MARKER_RE = /<!--xyz:msg:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-->/i

// ── user 消息 skill 标记反解析（D7 兜底通道，三链路共用 SSOT；R4 升级三形态）────────

/**
 * pi 原生 skill block 正则（存量格式，pi `_expandSkillCommand` 展开产物）：
 * `<skill name="..." location="..." ...>…</skill>`，紧随的空行分隔符一并吞入匹配区间——
 * pi 固定以 `block + "\n\n" + args` 拼接，吞掉 `\n\n` 后切片产出的 args 文本不带前导换行，
 * 与升级前 `match[3].trim()` 语义产出等价（场景 4⑤ 存量回归）。非贪婪匹配首个闭合标签
 * + g 标志全局迭代（多 block 全还原——升级前「只取首个」是捕获组锚定 `$` 的副产物，
 * 非契约）。骨架与升级前正则一致（属性 name → 可选 location → 其余属性透吃）。
 */
const PI_SKILL_BLOCK_RE = /<skill\s+name="([^"]+)"(?:\s+location="([^"]+)")?[^>]*>[\s\S]*?<\/skill>(?:\n\n)?/g

/** name/location → skill segment（location 空串归一为缺省，与 buildSkillMarker 序列化端对称：往返幂等）。 */
function toSkillSegment(name: string, location: string | undefined): Segment {
  return location !== undefined && location !== ''
    ? { type: 'skill', name, location }
    : { type: 'skill', name }
}

/**
 * [R4 D7 三形态①] 剥除文本中全部 `<xyz-skill-data>...</xyz-skill-data>` 包裹块
 * （任意位置，findSkillDataBlockRange 循环切片——非贪婪语义止于首个闭合标签，逐块
 * 消费剩余后缀直至无完整块）。块是注入器产物非用户内容：块内内容整体丢弃、不参与
 * 后续标记解析（正常形态块内 `<skill>` 全文 / 降级形态块内标记清单 + 指引行均不
 * 还原）；块外正文全部保留（块与正文间的分隔空白属块外正文，逐字保留不 trim）。
 *
 * 任意位置而非仅末尾：防御 hook 改写/复述把块挪位，规则更鲁棒（D7 ①）。
 * 返回剥后正文与是否剥过块：剥过块的文本即使无标记命中也不得走「无命中返回 null →
 * 调用方回退原始文本」路径（否则整块全文泄漏进显示层），调用方（parseSkillBlock）
 * 据 stripped 区分「无命中返回 null」与「剥后纯正文」。
 */
function stripSkillDataBlocks(text: string): { body: string; stripped: boolean } {
  let body = ''
  let rest = text
  let stripped = false
  for (;;) {
    const range = findSkillDataBlockRange(rest)
    if (!range) return { body: body + rest, stripped }
    body += rest.slice(0, range.start)
    rest = rest.slice(range.end)
    stripped = true
  }
}

/**
 * 反解析 user 消息文本中的 skill 标记为 Segment[]（D7 兜底通道：sidecar 丢失/旧版本
 * 会话时的 chip 还原路径；live message_end 帧 / runtime 历史重建 / 文件重放三链路共用
 * 本函数，一处升级全覆盖）。无命中且无块可剥返回 null（调用方回退 textToSegments
 * 纯文本）。
 *
 * 三形态按优先序处理（R4 D7），命中区间按位置排序后与区间外正文交错产出
 * text + skill + text + …：
 * ① 剥块（最高优先，R4 新增）：`<xyz-skill-data>` 包裹块任意位置整块剔除，块内内容
 *   整体丢弃、不参与后续解析（见 stripSkillDataBlocks）；剥过块但正文无标记时返回
 *   剥后正文（不回退原始文本，防块全文泄漏）。
 * ② 标记还原：`<xyz-skill .../>` 单标记（本设计 segmentsToText 序列化产物，正文占位
 *   标记形态）。标记前后的正文全部保留为 text segment——专防升级前
 *   「捕获组从第一个 <skill 开始、block 前正文不在任何捕获组直接丢弃」的缺陷回归。
 *   与 ① 协调：块内标记已随块整体丢弃，标记命中区间与块区间互斥（区间不相交）。
 * ③ 存量形态兼容（零改动，对应设计 D7-③）：pi 原生 block 与 `<xyz-skills>` 降级块
 *   （升级前存量落盘，解析复用 shared skill-marker SSOT 的 index/length 位置切片）
 *   保持存量行为等价——block 前置 + `\n\nargs` 在后产出 `[skill, args-text]`
 *   （`\n\n` 吞入区间实现，见 PI_SKILL_BLOCK_RE）；block 前正文升级前直接丢弃，
 *   升级后保留（缺陷修复，D7）。
 *
 * 优先级实现（apply-entry 测试锁定）：① 先剥块改写扫描域；降级块先扫描并整体占用
 * 区间（含块内嵌套标记与紧随指引行——指引行是块的组成部分，不作正文残留）；单标记
 * 与 pi block 后扫描，起点落入已占用区间的命中跳过。pi block 与两类 xyz 标记的正则
 * 前缀互不重叠（`<skill` vs `<xyz-skill`），互不误命中；未闭合的 `<xyz-skill-data>`
 * 残段（无完整块）不匹配任何标记正则，按 D8 透传语义保留为正文。
 */
function parseSkillBlock(text: string): Segment[] | null {
  interface Hit {
    start: number
    end: number
    segs: Segment[]
  }
  const hits: Hit[] = []
  const occupied = (start: number) => hits.some((h) => start >= h.start && start < h.end)

  // ① 剥块优先（R4）：块内内容整体出局，后续解析只看剥后正文
  const { body: effective, stripped: dataBlockStripped } = stripSkillDataBlocks(text)

  // ② 降级块优先（整体区间消费块内全部标记，防单标记解析二次命中重复产出）
  for (const block of parseSkillsFallbackBlocks(effective)) {
    hits.push({
      start: block.index,
      end: block.index + block.length,
      segs: block.skills.map((s) => toSkillSegment(s.name, s.location)),
    })
  }
  // ②' xyz 单标记（降级块内嵌标记已被上方消费，区间内跳过；`<xyz-skill-data>` 块内
  // 标记已在 ① 随块丢弃，与块区间互斥）
  for (const m of parseSkillMarkers(effective)) {
    if (occupied(m.index)) continue
    hits.push({ start: m.index, end: m.index + m.length, segs: [toSkillSegment(m.name, m.location)] })
  }
  // ③ pi 原生 block（存量形态，规则与行为零改动）
  for (const m of effective.matchAll(PI_SKILL_BLOCK_RE)) {
    if (occupied(m.index)) continue
    hits.push({ start: m.index, end: m.index + m[0].length, segs: [toSkillSegment(m[1], m[2])] })
  }
  if (hits.length === 0) {
    if (!dataBlockStripped) return null
    // 剥过块但无标记命中：返回剥后正文（空串产空数组），不回退原始文本——
    // 块内容已按注入器产物丢弃，回退会让整块全文泄漏进显示层
    return effective ? [{ type: 'text', text: effective }] : []
  }

  // 区间排序 + 正文切片：标记间与首尾正文原样保留（空串不产 text segment）
  hits.sort((a, b) => a.start - b.start)
  const segments: Segment[] = []
  let cursor = 0
  for (const h of hits) {
    const before = effective.slice(cursor, h.start)
    if (before) segments.push({ type: 'text', text: before })
    segments.push(...h.segs)
    cursor = h.end
  }
  const tail = effective.slice(cursor)
  if (tail) segments.push({ type: 'text', text: tail })
  return segments
}

// ── assistant toolCalls → fileChanges 静态提取（迁移自 extractHistoryFileChanges）──────
//
// 历史路径无 cwd 做 existsSync 判定：write 一律 modified（AC-9.3 graceful），
// edit 恒 modified。filePath 取 toolCall.arguments.path（file_path 防御 fallback）。
// 下方工具名集合刻意宽匹配（历史数据含 write_file/str_replace 等别名）。

const WRITE_TOOL_NAMES = new Set(['write', 'write_file', 'writeFile', 'create_file'])
const EDIT_TOOL_NAMES = new Set(['edit', 'edit_file', 'editFile', 'str_replace', 'replace'])

function extractHistoryFileChanges(toolCalls: ToolCall[]): FileChange[] {
  const changes: FileChange[] = []
  const seen = new Set<string>()
  for (const tc of toolCalls) {
    const isWrite = WRITE_TOOL_NAMES.has(tc.toolName)
    const isEdit = EDIT_TOOL_NAMES.has(tc.toolName)
    if (!isWrite && !isEdit) continue
    const args = (tc.input ?? {}) as Record<string, unknown>
    const filePath = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : ''
    if (!filePath || seen.has(filePath)) continue
    seen.add(filePath)
    changes.push({ filePath, status: 'modified' })
  }
  return changes
}

// ── message entry 体 → Message（迁移自 convertSinglePiMessage）───────────────

/** message entry 的 content 数组元素（宽形态，读取点运行时守卫）。 */
interface PiContentPart {
  type: string
  text?: string
  thinking?: string
  /** [W5] image 块（pi ImageContent：base64 data + mimeType），user 消息可含。 */
  data?: string
  mimeType?: string
  id?: string
  name?: string
  arguments?: Record<string, unknown>
}

/** content parts 归集产物（按 part kind 分派收集的中间态，构造 Message 用）。 */
interface CollectedContent {
  /** text part 累加合并后的纯文本（多次 text part 拼接） */
  textContent: string
  thinking: ThinkingBlock[]
  toolCalls: ToolCall[]
  contentBlocks: ContentBlock[]
  /**
   * [W5] user 消息 image part 收集（pi UserMessage.content 可为 (TextContent | ImageContent)[]
   * ——pi-ai types.d.ts UserMessage；xyz 发送路径走 segments 路径模式不经此形态，但
   * extension sendMessage images 通道 / 外部手写 session 文件可达，此前静默丢弃无 warn。
   * Segment image 是磁盘路径形态，与 base64 ImageContent 不可互转 → 保 images 字段不丢）。
   */
  imageParts: Array<{ data: string; mimeType: string }>
  /** text 块只 push 一次的哨兵（多次 text part 只累加不重复 push，perf-w20 微项 2 同优化）。 */
  hasTextBlock: boolean
}

/** body.content 宽形态归一：数组原样透传，非数组包成单 text part（null → ''）。 */
function normalizeContentParts(body: PiMessageBody): PiContentPart[] {
  return Array.isArray(body.content)
    ? (body.content as PiContentPart[])
    : [{ type: 'text', text: body.content != null ? String(body.content) : '' }]
}

function collectTextPart(part: PiContentPart, index: number, acc: CollectedContent): void {
  acc.textContent += part.text ?? ''
  // text 块按真实到达顺序 push（首次遇到时 push 一次）。contentIndex = parts 下标
  //（pi content array 顺序），与 streaming 路径对称（§11 检查点 3）。
  if (!acc.hasTextBlock) {
    acc.hasTextBlock = true
    acc.contentBlocks.push({ type: 'text', refId: 'text', contentIndex: index })
  }
}

function collectThinkingPart(part: PiContentPart, index: number, baseId: string, acc: CollectedContent): void {
  const thkId = `${baseId}-th${index}`
  acc.thinking.push({
    id: thkId,
    content: part.thinking ?? '',
    collapsed: true,
  })
  acc.contentBlocks.push({ type: 'thinking', refId: thkId, contentIndex: index })
}

function collectToolCallPart(
  part: PiContentPart,
  index: number,
  baseId: string,
  body: PiMessageBody,
  fallbackTs: number,
  acc: CollectedContent,
): void {
  const tcId = part.id ?? `${baseId}-tc${index}`
  acc.toolCalls.push({
    id: tcId,
    toolName: part.name ?? '',
    input: part.arguments ?? {},
    status: 'completed',
    startTime: body.timestamp ?? fallbackTs,
  })
  acc.contentBlocks.push({ type: 'toolCall', refId: tcId, contentIndex: index })
}

function collectImagePart(part: PiContentPart, acc: CollectedContent): void {
  // 提取语义与 normalizePiToolResult 的 image 块一致（data/mimeType String 归一，
  // 过滤双空）；不进 contentBlocks（ContentBlockType 无 image，保序渲染归后续 wave）。
  const img = { data: String(part.data ?? ''), mimeType: String(part.mimeType ?? '') }
  if (img.data !== '' || img.mimeType !== '') acc.imageParts.push(img)
}

/** 逐 part 分派收集（text/thinking/toolCall/image 四类，其余 kind 忽略）。 */
function collectContentParts(
  parts: PiContentPart[],
  baseId: string,
  body: PiMessageBody,
  fallbackTs: number,
): CollectedContent {
  const acc: CollectedContent = {
    textContent: '',
    thinking: [],
    toolCalls: [],
    contentBlocks: [],
    imageParts: [],
    hasTextBlock: false,
  }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.type === 'text') {
      collectTextPart(part, i, acc)
    } else if (part.type === 'thinking') {
      collectThinkingPart(part, i, baseId, acc)
    } else if (part.type === 'toolCall' || part.type === 'tool_use') {
      collectToolCallPart(part, i, baseId, body, fallbackTs, acc)
    } else if (part.type === 'image') {
      collectImagePart(part, acc)
    }
  }
  return acc
}

/** [W6 #9 G5] 历史路径还原 fileChanges（write/edit 工具静态提取，AC-9.1/9.3）。 */
function fileChangesField(body: PiMessageBody, toolCalls: ToolCall[]): { fileChanges?: FileChange[] } {
  if (body.role !== 'assistant' || toolCalls.length === 0) return {}
  const fc = extractHistoryFileChanges(toolCalls)
  return fc.length > 0 ? { fileChanges: fc } : {}
}

/** Extract usage from pi assistant messages (input/output token counts)。 */
function usageField(body: PiMessageBody): { usage?: { inputTokens: number; outputTokens: number } } {
  if (body.role !== 'assistant') return {}
  const u = body.usage
  if (!isLooseRecord(u)) return {}
  const input = typeof u.input === 'number' ? u.input : undefined
  const output = typeof u.output === 'number' ? u.output : undefined
  return { usage: { inputTokens: input ?? 0, outputTokens: output ?? 0 } }
}

function buildMessage(
  body: PiMessageBody,
  entryId: string | undefined,
  baseId: string,
  fallbackTs: number,
  acc: CollectedContent,
): Message {
  return {
    id: baseId,
    role: body.role === 'user' ? 'user' : 'assistant',
    content: acc.textContent,
    status: 'complete',
    timestamp: body.timestamp ?? fallbackTs,
    // piEntryId：fork 定位截断点用（RPC 路径无此字段时 fallback 读 JSONL 按 timestamp 匹配）
    ...(entryId !== undefined && { piEntryId: entryId }),
    ...(acc.thinking.length > 0 && { thinking: acc.thinking }),
    ...(acc.toolCalls.length > 0 && { toolCalls: acc.toolCalls }),
    ...(acc.contentBlocks.length > 0 && { contentBlocks: acc.contentBlocks }),
    ...(acc.imageParts.length > 0 && { images: acc.imageParts }),
    ...fileChangesField(body, acc.toolCalls),
    ...usageField(body),
  }
}

/**
 * 转换单条 message entry 体为 xyz Message（user/assistant）。
 * 未知 role → warn + null（调用方跳过；迁移前 convertSinglePiMessage 同语义）。
 *
 * @param entryId 真实 pi entry id（无则 undefined——piEntryId 不回填）
 * @param baseId 消息确定性 id 基（entryId ?? 下标派生，见 deriveBaseId）
 */
export function convertMessageBody(
  body: PiMessageBody,
  entryId: string | undefined,
  baseId: string,
  fallbackTs: number,
): Message | null {
  // 防御性收窄（正常路径由 applyEntry 的 message switch 分派保证只收 user/assistant）：
  // 非 user/assistant 返回 null 调用方跳过；warn 在 switch default 统一发出，此处不重复。
  if (body.role !== 'user' && body.role !== 'assistant') {
    return null
  }
  const acc = collectContentParts(normalizeContentParts(body), baseId, body, fallbackTs)
  const msg = buildMessage(body, entryId, baseId, fallbackTs, acc)

  // For user messages, resolve skill markers back to segments（D7 兜底通道）。
  // content 统一为 Segment[]：命中 xyz 私有标记 / pi 原生 block 时产出交错的
  // text + skill + text + …（标记前后正文全保留），无命中时 textToSegments 纯 text。
  if (body.role === 'user' && acc.textContent) {
    // [簇 A2] 先剥 defer flush 确认标记再反解析：标记只服务 user-delivery ①a 身份确认
    //（直接读 pi 原始 entry，不经本投影），显示层不暴露。live 帧与 reload 重放同经本点
    // → live ≡ reload 构造性保持；剥后基线文本 = 条目原文 = confirmDelivery 的 appendUser
    // overlay 文本 → mergeBaselineWithLive 文本去重命中（不剥则带标记基线 vs 无标记 overlay
    // 失配，同一条消息双条显示）。skill 块解析在剥后进行——标记在文本尾附加，不影响块区间。
    const deliveryText = acc.textContent.replace(DEFER_FLUSH_MARKER_RE, '').trimEnd()
    msg.content = parseSkillBlock(deliveryText) ?? textToSegments(deliveryText)
  }
  return msg
}

// ── toolResult 回填（迁移自 fillToolCallOutput，copy-on-write 化）──────────────

/** 计算 toolResult 回填字段（不含 id 匹配；返回增量字段对象）。 */
export function computeToolCallFill(body: PiMessageBody): {
  output: string
  outputRaw?: string
  isError: boolean
  details?: Record<string, unknown>
  /** [W5] toolResult content 的 ImageContent 块（live≡replay：此前仅实时路径可见）。 */
  images?: Array<{ data: string; mimeType: string }>
  /** [D6-⑧] output/outputRaw 被 64KB 累积截断裁剪（ToolCall.outputTruncated 回填源）。 */
  outputTruncated: boolean
} {
  const { output, outputRaw, images } = normalizePiToolResult(body)
  // [D6-⑧] 累积态条目级截断：live（applyEntryFrame）与 reload（replayEntries）共用本点，
  // 同函数同阈值——D3 代价 C 根治（非六类工具大结果两路径形态一致）。
  const outputT = truncateEntryToolOutput(output)
  const isError = body.isError === true
  // F1 透传 details（含 __gui__），排除数组形态（迁移前显式判定，关键规则 9 可重开恢复）。
  const details = isPlainRecord(body.details) ? body.details : undefined
  // outputRaw 与 output 同源（stripAnsi 前/后），任一超限即双双截断（保持两字段头部对齐），
  // truncated 标记取两者之或。
  const outputRawT = outputRaw !== undefined ? truncateEntryToolOutput(outputRaw) : undefined
  return {
    output: outputT.text,
    ...(outputRaw !== undefined && outputRawT !== undefined && { outputRaw: outputRawT.text }),
    isError,
    details,
    images,
    outputTruncated: outputT.truncated || (outputRawT?.truncated ?? false),
  }
}
