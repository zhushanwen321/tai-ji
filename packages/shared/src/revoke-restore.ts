/**
 * 草稿还原纯函数族（message revoke 设计 §3.3 D7 两层切条规则 + msg-pipeline-debloat
 * D5-2 剥除统一——本文件是 stripDeliveryMarkers 的唯一实现 SSOT）。
 *
 * 输入形态（session.revokeMessage reply 的 content）= transcript user entry 原文，含投递
 * 裸标记：单条逐段投递形态 = `原文\n<!--taiji:msg:<uuid>-->`（内核 withDeliveryMarker 恒
 * 尾附）；splitComposed 拆分失败的降级整批形态 = 各条已带标记的文本以 `\n\n---\n\n` 连接
 * （buildBatchPayload BATCH_SEP）。
 *
 * 剥除语义（三口径统一后的唯一口径，msg-pipeline-debloat D5-3 / P5）：**剥除标记、不动
 * 其他字符**——剥标记本体与其紧邻的单个前导换行（内核 `${text}\n<!--tag-->` 连接产物），
 * 用户原文自身的尾随换行与一切其他字符保留（不 trimEnd，回草稿尾换行不丢）。
 *
 * 标记体取宽松 `[^>]*` 形态（ADR-0077 形态二分：判定严格 / 剥除宽松——严格 uuid 形态会
 * 漏剥 m- 收养条目标记与残缺/历史形态标记留下脏文本，与 runtime transport 旧版宽松剥除
 * 语义一致，统一实现不收严）。身份判定（提取/回执对账/rebuild 分派）不受本函数影响，
 * 仍归 runtime DELIVERY_MARKER_ID_RE 严格判据。消费方：本文件撤回草稿还原 + runtime
 * transport（队列 preview / delivery.cancel / drain 回草稿，经 session-delivery-topic
 * 再导出）。
 */
import { MSG_ID_TAG_RE } from './message'

/** 内核合批拼接分隔符（session-delivery-registry.ts BATCH_SEP 同字面；shared 不 import runtime）。 */
const BATCH_JOINER = '\n\n---\n\n'

/** 多条原文合并回单草稿的连接符（D7 消费口径：空行连接，restoreDraft 单文本契约）。 */
const DRAFT_JOINER = '\n\n'

/**
 * 标记 + 紧邻单个前导换行的全局正则（每次调用新建：/g 形态有 lastIndex 状态，
 * 模块级单例跨消费方共享不安全）。标记体 = 宽松 `[^>]*`（剥除面授权形态，ADR-0077），
 * 本仓剥除正则的唯一手写体（PS-26 探针登记豁免面之外的身份判定正则均由
 * message.ts MSG_ID_UUID_SEGMENT 构造，与此处无关）。
 */
function markerWithLeadingNewlineRe(): RegExp {
  return new RegExp('\\n?<!--taiji:msg:[^>]*-->', 'gi')
}

/** 标记本体全局正则（MSG_ID_TAG_RE 同 source；matchAll 定位用，每次调用新建，理由同上）。 */
function markerRe(): RegExp {
  return new RegExp(MSG_ID_TAG_RE.source, 'gi')
}

/**
 * 剥除全部投递标记（草稿还原 / 队列 preview 共用唯一实现，见文件头）。
 *
 * 剥除单位 = 标记本体 + 紧邻的单个前导换行（内核 `${text}\n<!--tag-->` 的连接换行）。
 * 用户原文以换行结尾时自身的尾换行保留（P5 口径：剥除不动其他字符，不 trimEnd）。
 */
export function stripDeliveryMarkers(text: string): string {
  return text.replace(markerWithLeadingNewlineRe(), '')
}

/**
 * 撤回 reply 的草稿还原（D7 两层规则）。
 *
 * 层 1（纯用户合批，确定性切条）：≥2 个标记且布局校验一致——每个标记后恰为文本末尾或
 * `\n\n---\n\n`（且 joiner 后存在下一标记）——才切条：按标记定位段界，第 2..N 段各剥首个
 * 连接产物（校验保证其恒为内核 joiner），各段剥段尾含前导换行的标记；第 1 段段首无连接
 * 产物不剥（用户原文以分隔符开头时其字面保留）。切出的多条原文以空行连接合并回单草稿。
 *
 * 层 2（整批兜底，宁合不裂）：一切校验不过的形态（无标记 / 单标记不在末尾 / 标记后布局
 * 不一致 / 混入无标记段 / 内嵌标记使布局失真）整条原样返回，不剥任何标记——误剥用户字面
 * = 内容丢失，宁留可手删的标记字面（已知边界：残留标记字面直接重发会成为文本垃圾，内容
 * 不丢优先，不因此升级切条）。
 */
export function restoreRevokedDraft(content: string): string {
  const matches = Array.from(content.matchAll(markerRe())).map((m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }))
  // 无标记：无可剥物，原样（层 2 同形——撤回目标恒带标记，此形态为异常 reply，宁合不裂）
  if (matches.length === 0) return content
  // 单标记主导路径：标记必须是全文末尾（内核恒尾附）——非末尾 = 内嵌字面/异常形态，归层 2
  if (matches.length === 1) {
    return matches[0]!.end === content.length ? stripDeliveryMarkers(content) : content
  }
  // 层 1 布局校验：每标记后恰为末尾或 BATCH_JOINER（joiner 后须存在下一标记）
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!
    if (m.end === content.length) continue
    if (!content.startsWith(BATCH_JOINER, m.end)) return content
    const joinerEnd = m.end + BATCH_JOINER.length
    const next = matches[i + 1]
    // joiner 后无下一标记（末段无标记的混入形态）或下一标记落在 joiner 内 = 布局失真 → 层 2
    if (!next || next.start < joinerEnd) return content
  }
  // 校验过 → 切条：段 k = 上一 joiner 末（第 1 段为文本头）到标记 start；段尾剥单个前导换行
  const parts: string[] = []
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!
    const segStart = i === 0 ? 0 : matches[i - 1]!.end + BATCH_JOINER.length
    let seg = content.slice(segStart, m.start)
    if (seg.endsWith('\n')) seg = seg.slice(0, -1)
    parts.push(seg)
  }
  return parts.join(DRAFT_JOINER)
}
