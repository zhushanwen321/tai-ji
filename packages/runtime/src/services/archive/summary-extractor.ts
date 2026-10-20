import type { ArchiveConversationSummary, ArchiveSummaryTurn } from '@taiji/shared'

/**
 * 归档摘要提取器（session-archive 设计 §7 D4）——entry[] → summary turns 纯函数。
 *
 * 消费方 = u-archive-service 后台压缩任务（读归档目录内明文 JSONL → parseJsonl 产物
 * 喂入本函数 → 摘要随簿记终态落盘）。算法确定性 = 归档可重放（同输入恒同摘要，D4）：
 *
 * - turn 边界 = user message entry 开新 turn，判定口径逐字对齐 session-history.ts
 *   isTurnBoundary（type === 'message' && message.role === 'user'）；compaction entry
 *   不作边界——与 session-reader segmentTurns 的 compaction 断点语义刻意不同，摘要
 *   只按 user 分段，不受上下文压缩点影响（D4 采用理由）。
 * - 用户文本 = message.content 的 string 形态或 blocks 中 type === 'text' 块拼接
 *   （'\n' join，组合语义对齐 session-reader extract.ts 对 textBlockParts 的用法）；
 *   纯图片/附件消息为空串（渲染层显示占位，D11）。
 * - agent 文本 = turn 内最后一个非空 assistant text 块（前向迭代保持「最后一个非空」
 *   等价于 D4 的「从后向前第一个非空」；多 assistant entry 形态下取最终结论段）；
 *   「非空」按 trim 判定——空白串不是结论段。整 turn 无文本（以工具调用结束）为
 *   null（渲染层「摘要跳过该段」占位）。
 * - 非 message entry（compaction/usage/model_change/custom/custom_message/label 等）
 *   不参与摘要；role 为 toolResult/system 的 message entry 同样不贡献文本（工具
 *   结果与系统消息不是对话方发言）。
 * - 输入收窄全部在运行时逐条判定（输入类型 unknown[]：调用方喂 parseJsonl 产物，
 *   可能含 PiSessionEntry 联合外的未建模 entry（model_change/session_info/header）
 *   与非 object 畸形行，天然跳过——防御姿势对齐 session-history.ts
 *   filterObjectEntries）。首个 user 边界之前的孤儿段不属于任何 turn（D4 turn =
 *   user 开启），跳过。
 */
export function extractArchiveSummary(entries: readonly unknown[]): ArchiveConversationSummary {
  const turns: ArchiveSummaryTurn[] = []
  let openTurn: { user: string; agentText: string | null } | null = null

  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const role = messageRoleOf(entry)

    if (role === 'user') {
      if (openTurn !== null) turns.push({ user: openTurn.user, agent: openTurn.agentText })
      openTurn = { user: contentTextParts(contentOf(entry)).join('\n'), agentText: null }
      continue
    }
    if (role !== 'assistant' || openTurn === null) continue
    for (const text of contentTextParts(contentOf(entry))) {
      if (text.trim() !== '') openTurn.agentText = text
    }
  }
  if (openTurn !== null) turns.push({ user: openTurn.user, agent: openTurn.agentText })
  return { turns }
}

/** unknown → Record 收窄谓词（数组也会通过——后续 type 字段判 undefined 即跳过，无害）。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * message entry 的 role 收窄（非 message entry / 畸形形态返回 null）。
 * `messageRoleOf(entry) === 'user'` 与 session-history.ts isTurnBoundary 语义逐字
 * 等价（该函数为 session-history 包内私有、且本处还需 assistant 分派，收窄形状
 * 不同故本地持有；对齐由单测锚定用例双保险）。
 */
function messageRoleOf(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'message') return null
  const msg = entry.message
  if (!isRecord(msg)) return null
  return typeof msg.role === 'string' ? msg.role : null
}

function contentOf(entry: Record<string, unknown>): unknown {
  const msg = entry.message
  return isRecord(msg) ? msg.content : undefined
}

/**
 * message.content 的 text 块清单：string 形态直取单元素；block 数组白名单提取
 * type === 'text' 块（其余 image/thinking/toolCall 等形态不取）。范式锚 =
 * session-reader core/render.ts textBlockParts（extension 包，跨包不可 import，
 * 同语义镜像；join 语义留在调用点组合）。
 */
function contentTextParts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts
}
