/**
 * Segment —— user message content 的结构化模型（ADR-0043）。
 *
 * Message.content 从纯 string 重构为 `string | Segment[]`：
 * - user message → Segment[]（badge 载体，含 skill/file/mention 等结构化片段）
 * - assistant message → string（流式 text_delta 热路径，无 badge 需求）
 * - system/custom message → string（提示文本）
 *
 * 全链路（composer DOM → store → 渲染）保持 Segment[] 结构化，
 * 只在 pi 边界序列化/反序列化（segmentsToPrompt / convertPiHistory）。
 *
 * 新增 badge 类型只需在此判别联合加一个 case + 渲染层加一个分支，
 * 不需要改正则、加 Message 字段、改 send 链路签名。
 */
import { buildSkillMarker } from './skill-marker'

/**
 * Segment 判别联合。type 字段是判别器（discriminant），switch(type) 可穷尽检查。
 *
 * - slash: 命令段（行首 `/` 命令浮层选中的命令项，D4-b），name 不含 `/` 前缀。
 *   视觉上 chip 就地插在草稿光标处（D4-a），序列化时由 segmentsToText 归位提为首段，
 *   保证产物以 `/cmd` 开头满足 pi 行首命令协议（设计 §2.5）——pi 协议零改动
 * - text: 纯文本段（用户输入的文字）
 * - skill: skill 命令段，含 name 和可选的 SKILL.md 文件路径
 *   （序列化为 `<xyz-skill/>` 私有标记，见 segmentsToText；D3）
 * - file: 文件引用段（未来从 drawer/diff 选取追加到 composer），含路径和可选行范围
 * - mention: @mention 段（未来 @user 等），含 name。保持死类型不激活（无生产者），
 *   也不承载 session/subagent 引用——mention 是通用提及语义，独占给单一实体会
 *   命名与语义错位，三个月后「mention 是什么」成考古题；各实体独立 type 自描述
 * - session: session 引用段（composer # session chip），sessionId 是 TUI session_read
 *   协议消费的定位 id；label 仅用于 UI 展示（badge/气泡），不参与 prompt 序列化
 * - subagent: subagent 定向段（composer @ subagent chip），是消息路由标记而非内容——
 *   发送链路据此分流到 session.subagentAction（不经主 agent LLM），序列化为空串不进 prompt
 * - image: 图片附件段（Cmd+V 粘贴的截图等）：
 * - handoff: 交接来源标记段（fast-handoff 产出），含 sourceLabel（来源 session 名称）：
 *   - id：composer chip 的稳定唯一标识（crypto.randomUUID），同一文件附两次时供
 *     ContextChipsBar :key 区分（path 会重复）
 *   - path：磁盘绝对路径（tmpdir 下落盘文件），不变
 *   - fileName：磁盘文件全名（含 uuid 前缀，如 `dbfdb3c8-...-image.png`），用于磁盘定位/日志
 *   - displayName：用户可读名（如 `截图-20260725-1530.png` 或 `照片.png`），用于 badge/
 *     占位/缩略图 alt 显示
 *   - needsMigrate：是否需要 tmpdir → attachments 迁移。只有 landing 态 writeSessionImage
 *     落 OS tmpdir 的图才标记 true（session 创建后需迁移到 attachments 持久化）。
 *     +菜单选的用户磁盘文件、normal 态 writeSessionImage 落 attachments 的图，都不设
 *     （undefined 等同 false）。迁移判断用此字段，不猜路径（避免把用户磁盘文件误当
 *     tmpdir 文件被 renameSync 移走——数据丢失）。
 *   segmentsToText 把 path 裸路径插进 prompt 文本（对齐 pi TUI），LLM 自己调 read 工具
 *   读路径（vision/非 vision 模型都能处理）。不走 base64 message.send.images 通道。
 */
export type Segment =
  | { type: 'slash'; name: string }
  | { type: 'text'; text: string }
  | { type: 'skill'; name: string; location?: string }
  | { type: 'file'; path: string; lineRange?: [number, number] }
  | { type: 'mention'; name: string }
  | { type: 'session'; sessionId: string; label: string }
  | { type: 'subagent'; subagentId: string; slug: string }
  | { type: 'image'; id: string; path: string; fileName: string; displayName: string; needsMigrate?: boolean }
  | { type: 'handoff'; sourceLabel: string }

/**
 * Segment[] → 纯文本（归一化展示用 + pi prompt 序列化的唯一实现）。
 *
 * skill → `<xyz-skill name=".." location=".."/>` 私有标记（D3，runtime 注入器只认该标记
 * 展开注入；构建复用 skill-marker SSOT 保证转义/属性顺序与解析端一致）。标记格式变更的
 * 展示面影响——复制消息、编辑重发草稿回填等 normalizeContent 消费方看到标记原文而非
 * `/skill:name`——已登记于设计 §3.5-⑤（composer-multi-skill-injection.md）判定可接受。
 * 手打 `/skill:name` 文本不经此路径也不被 runtime 处理（G5：与 pi 原生行为零偏差）。
 * file → `path`（可选 `:L<s>-L<e>` 行范围），mention → `@name`，
 * slash → `/name`（归位提为首段，见函数体 D4-c），
 * session → `#sessionId`（TUI session_read 协议），subagent → 空串（路由标记不进 prompt），
 * text → 原文，image → 裸 path 独占一行（对齐 pi TUI，LLM 自己调 read 工具读），
 * handoff → `[handoff from sourceLabel]`（来源标记，文档内容在 text segment 中）。
 * skill 段后若紧跟 text 段，中间补一个空格分隔（修复零宽空格被过滤导致的粘连 bug；
 * 标记形态下同样需要——`/>` 与正文直接粘连）。
 * image 后紧跟 text 不补空格（image 产出的 `\n${path}\n` 已有换行分隔，再补空格会污染行首）。
 *
 * 收敛说明：原本 segmentsToPrompt 与 segmentsToText 分两份实现，因为 file inline 需要
 * fileContexts Map 才分开。删除 file inline 后，所有 segment 序列化收敛到本函数一处，
 * segmentsToPrompt 只是同实现的语义别名（去 trim 后二者逐字同产出，见其上方 [HISTORICAL]）。
 * 首尾空白保真——本函数不 trim，空白拦截职责归调用方（useChat send/steer/followUp 的
 * !text.trim() 守卫），不再分两份逻辑。
 */
/**
 * 判定 seg 的序列化文本前是否补一个空格分隔（边界空格规则单点化，替代拆分前的两处 if）：
 * - prev 为 null（首段）/ text / image → 不补（text 自带间距；image 产出 `\n${path}\n` 前后已有换行）
 * - seg 是 image → 不补（补空格会污染行首，产出 `\n /path`）
 * - seg 是 text → 仅当文本非空且不以空格开头时补（chip→text 粘连修复；text 自带前导空格则不重复补）
 * - 其余 chip→chip / chip→text → 补
 *
 * 导出供展示侧共用（UserBubble.vue 按归位序渲染时，slash 段是纯文本、无 badge 的
 * `mr-1` 间距，段间边界空格必须显式渲染才与 segmentsToText 产物逐字一致）——
 * 边界空格规则保持单点实现，展示侧不复制第二份。
 */
export function needsBoundarySpace(prev: Segment | null, seg: Segment): boolean {
  if (!prev || prev.type === 'text' || prev.type === 'image' || seg.type === 'image') return false
  if (seg.type === 'text') {
    // truthiness 语义与基线一致：text 为 undefined/null 脏数据时不补空格（非空串才补）
    return !!seg.text && !seg.text.startsWith(' ')
  }
  return true
}

function serializeFileSegment(seg: Extract<Segment, { type: 'file' }>): string {
  // D2 格式：行范围序列化（path:L<n> 单行 / path:L<s>-L<e> 多行）。
  // lineRange 必须进 prompt 文本，否则 LLM 看不到行号（review M1）。
  let fileText = seg.path
  if (seg.lineRange) {
    // 归一化 lineRange：防负数 / s>e 产出非法 prompt 文本（L0、L5-L3 等）。
    // 输入边界防御——上游 composer/DiffView 正常不会传非法值，此处兜底保证序列化恒合法。
    const [s0, e0] = seg.lineRange
    const s = Math.max(1, s0)
    const e = Math.max(s, e0)
    fileText += s === e ? `:L${s}` : `:L${s}-L${e}`
  }
  return fileText
}

/**
 * 各 segment type 的序列化器表（表驱动分发）。
 * key 由映射类型穷尽声明：新增 Segment 成员而漏加 key 时 tsc 编译失败（穷尽守卫）。
 */
const SEGMENT_SERIALIZERS: { [K in Segment['type']]: (seg: Extract<Segment, { type: K }>) => string } = {
  text: (seg) => seg.text,
  // D4-b：`/` 前缀在此补（name 不含前缀），归位提首后产物满足 pi 行首命令协议
  slash: (seg) => `/${seg.name}`,
  // D3：`<xyz-skill/>` 私有标记（location 可得时带上）。反解析对偶实现在 core parseSkillBlock。
  skill: (seg) => buildSkillMarker(seg.name, seg.location),
  file: serializeFileSegment,
  mention: (seg) => `@${seg.name}`,
  session: (seg) => {
    // # 前缀对齐 TUI session_read 协议（stripHash 消费 #<sessionId>）；
    // label 只用于 UI 展示，不进 prompt（LLM 不需要标题，uuid 已可定位）
    return `#${seg.sessionId}`
  },
  subagent: () => {
    // 路由标记：发送链路据 segments 含 subagent 段分流到 subagentAction RPC，
    // 文本本体走 RPC text 字段；若序列化进 prompt 会污染主 agent 上下文（见设计 3.3.8）
    return ''
  },
  image: (seg) => {
    // 对齐 pi TUI 粘贴行为：裸路径进 prompt 文本，LLM 自己调 read 工具读。
    // 与 pi TUI（insertTextAtCursor 裸路径粘在光标处）的细微差异：xyz-agent 让每个图片
    // 路径独占一行（前后补换行），LLM 更易解析路径边界，多图时每行一个。
    // 不再用 [图片 N] 匿名占位——该占位对 LLM 无意义（非 vision 模型看不到图，
    // vision 模型不需要锚点），且会被 LLM 当文件名瞎找。
    // 图片持久化在 <dataDir>/attachments/<sessionId>/（非 pi TUI 的 /tmp），切换 session 不丢。
    return `\n${seg.path}\n`
  },
  handoff: (seg) => {
    // handoff badge 来源标记：sourceLabel 标识交接来源 session，pi 看到纯文本标记。
    // 文档内容在同一条消息的 text segment 中，此处只输出来源标记供 LLM 识别上下文。
    return `[handoff from ${seg.sourceLabel}]`
  },
}

/**
 * 单段序列化分发。cast 安全性：seg.type 是判别器，查表命中必然是同 type 的序列化器；
 * 表 key 由映射类型穷尽（tsc 守卫）。`| undefined` 落空分支 = 运行时脏数据（TS 类型外），
 * 与拆分前 switch 无 default 的落空行为一致——产出空文本，不抛错。
 */
function serializeSegment(seg: Segment): string {
  const serialize = SEGMENT_SERIALIZERS[seg.type] as ((seg: Segment) => string) | undefined
  return serialize ? serialize(seg) : ''
}

/**
 * slash 段归位（D4-c 单一实现）：slash 段（命令 chip）提为首段，其余段保持原序。
 *
 * 命令 chip 视觉就地（D4-a）后段序不再以 `/` 开头，归位保证序列化产物以 `/cmd` 开头
 * （pi 行首命令协议）。多个 slash 段防御性全前置按原序（正常态至多一个）。
 *
 * 两个消费方共用本实现（不复制第二份归位实现）：
 * - segmentsToText：pi prompt / 展示序列化的前缀步
 * - UserBubble.vue：chat 流气泡按归位序渲染——live 段序与 reload 侧序列化产物
 *   （apply-entry-convert 的 textToSegments(deliveryText)）同序，live ≡ reload
 *   （AGENTS.md 关键规则 9）
 *
 * 空数组返回空数组；本函数不做过滤/去重，仅重排。
 */
export function normalizeSegmentOrder(segments: Segment[]): Segment[] {
  const slash: Segment[] = []
  const rest: Segment[] = []
  for (const seg of segments) {
    if (seg.type === 'slash') slash.push(seg)
    else rest.push(seg)
  }
  return [...slash, ...rest]
}

export function segmentsToText(segments: Segment[]): string {
  if (segments.length === 0) return ''
  // D4-c 归位：slash 段提首（判定与理由见 normalizeSegmentOrder）；needsBoundarySpace
  // 在归位后的序上执行，slash 段视同 chip 类段（default 补空格分支覆盖）。
  const ordered = normalizeSegmentOrder(segments)
  const parts: string[] = []
  for (let i = 0; i < ordered.length; i++) {
    const seg = ordered[i]
    const prev = i > 0 ? ordered[i - 1] : null
    if (needsBoundarySpace(prev, seg)) {
      parts.push(' ')
    }
    parts.push(serializeSegment(seg))
  }
  return parts.join('')
}

/**
 * 纯文本 → Segment[]（无 badge 时产出单个 text segment）。
 *
 * 用于构造不含 badge 的 user message（如 mock 数据、从纯文本恢复的消息）。
 * 不做反向解析（本函数不做任何标记提取）——结构化 segments 应从 composer DOM 直接产出；
 * 历史 user message 中的 skill 标记反解析由 core parseSkillBlock 负责（D7 兜底通道，
 * 两形态含 xyz 私有标记与 pi 原生 block），不经此函数。
 */
export function textToSegments(text: string): Segment[] {
  if (!text) return []
  return [{ type: 'text', text }]
}

/**
 * Segment[] → pi prompt 字符串（pi 边界序列化）。
 *
 * 删除 file inline 后，所有 segment 序列化逻辑收敛到 segmentsToText 一处，
 * 本函数是「pi 边界序列化」的语义锚点（与展示用 segmentsToText 同实现、不同意图）。
 *
 * [HISTORICAL] 曾内置 .trim()（「pi prompt 不需要首尾空白」）——用户输入首尾空白被
 * 静默剥除，pi 落盘文本 ≠ 提交原文（2026-08 Gate B AC-4 实测；pi 本身不 trim，剥除
 * 纯粹由本层引入）。去 trim 后提交原文 → pi 入队帧 → message_end(user) → 基线落盘
 * 全链同文本。空白拦截职责归调用方（useChat send/steer/followUp 各自 !text.trim() 守卫）。
 */
export function segmentsToPrompt(segments: Segment[]): string {
  return segmentsToText(segments)
}

/**
 * 归一化 Message.content（string | Segment[] 联合类型）为纯文本。
 *
 * 所有只需纯文本的消费点统一走此函数，避免每处各自处理联合类型：
 * - string → 直传（assistant/system message）
 * - Segment[] → segmentsToText（user message）
 */
export function normalizeContent(content: string | Segment[]): string {
  return typeof content === 'string' ? content : segmentsToText(content)
}
