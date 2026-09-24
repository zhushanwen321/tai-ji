/**
 * 撤回草稿还原纯函数族（message revoke 设计 §3.3 D7——本文件是两层切条规则的 SSOT）。
 *
 * 输入形态（session.revokeMessage reply 的 content）= transcript user entry 原文，含投递
 * 裸标记：单条逐段投递形态 = `原文\n<!--taiji:msg:<uuid>-->`（内核 withDeliveryMarker 恒
 * 尾附，已核实 session-delivery-registry.ts:191）；splitComposed 拆分失败的降级整批形态 =
 * 各条已带标记的文本以 `\n\n---\n\n` 连接（buildBatchPayload BATCH_SEP，同文件:148）。
 *
 * 标记解析与 shared/message.ts 的 MSG_ID_TAG_RE 同源（source 派生，双形态 u-/裸 uuid）——
 * 标记形态漂移时两处同时红，不另造第二份正则。
 *
 * 与 runtime session-delivery-topic.ts 的同名函数（preview/cancel 草稿面：replace + trimEnd）
 * 语义差异是有意的：本文件目标是「撤回原文精确恢复」——只剥标记本体与其紧邻的单个前导
 * 换行（内核连接产物），用户原文自身的尾随换行保留；trimEnd 会误剥用户尾换行。
 */
import { MSG_ID_TAG_RE } from './message'

/** 内核合批拼接分隔符（session-delivery-registry.ts BATCH_SEP 同字面；shared 不 import runtime）。 */
const BATCH_JOINER = '\n\n---\n\n'

/** 多条原文合并回单草稿的连接符（D7 消费口径：空行连接，restoreDraft 单文本契约）。 */
const DRAFT_JOINER = '\n\n'

/**
 * 标记 + 紧邻单个前导换行的全局正则（每次调用新建：/g 形态有 lastIndex 状态，
 * 模块级单例跨消费方共享不安全——与 MSG_ID_TAG_RE 的「无 /g 可共享」注记对齐）。
 */
function markerWithLeadingNewlineRe(): RegExp {
  return new RegExp(`\\n?${MSG_ID_TAG_RE.source}`, 'gi')
}

/** 标记本体全局正则（MSG_ID_TAG_RE 同 source；matchAll 定位用，每次调用新建，理由同上）。 */
function markerRe(): RegExp {
  return new RegExp(MSG_ID_TAG_RE.source, 'gi')
}

/**
 * 剥除全部投递裸标记（单条形态主导路径：剥后即用户原文）。
 *
 * 剥除单位 = 标记本体 + 紧邻的单个前导换行（内核 `${text}\n<!--tag-->` 的连接换行）。
 * 用户原文以换行结尾时自身的尾换行保留（区别于 preview 面的 trimEnd 语义，见文件头）。
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
