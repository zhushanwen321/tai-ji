import type { Message, Segment, SegmentsMetadataFile } from '@taiji/shared'
import type { PiSessionEntry, PiHistoryToolResult, PiSessionCustomEntry } from './pi-protocol.js'
import { convertPiHistory } from './message-converter.js'
import { applyEntryEndTimes, mapSessionEntries } from './session-entry-mapper.js'

/**
 * entry-tree-builder —— 从 pi get_entries 返回的 entry 树重建 taiji Message[]。
 *
 * 背景：客户端 message 元数据映射框架（步骤 1-5）需要 runtime 从 pi get_entries RPC
 * 拿到完整 entry 树（含 message entry + custom entry），重建 Message[] 时按
 * userEntryId ↔ clientUuid 映射回填结构化 Segment[]（图片/文件/skill badge）。
 *
 * 与 convertPiHistory（消费 get_messages 扁平 message 列表）的关系：
 * - 复用 convertPiHistory 做 message→Message 翻译（含 toolResult 合并 / compactionSummary /
 *   custom / branchSummary 系统消息处理），保证与 RPC/文件路径行为一致（关键规则 9）。
 * - 额外能力：用 custom entry "taiji.client-msg-id" 的 clientUuid 映射 +
 *   segments.json sidecar 的结构化 Segment[]，精确还原 composer 提交时的 badge 结构
 *   （convertPiHistory 路径无 entry 树信息，只能用 textToSegments 兜底纯文本）。
 *
 * 🔒 归属（R1，三层架构）：infra/pi 层内部，消费 pi 协议类型（PiSessionEntry），
 * 产出 taiji 内部类型（Message）。services 层调本函数，不直接碰 pi entry 类型。
 */

/** msg-id-mapper extension 写入的 client-msg-id custom entry 的 data 结构。 */
interface ClientMsgIdData {
  clientUuid: string
  userEntryId: string
}

/**
 * segments.json sidecar 的结构（步骤 3 定义在 shared，这里先声明依赖）。
 *
 * 每个 user message 提交时落盘一份，clientUuid 关联到 custom entry 的 clientUuid，
 * segments 是 composer DOM 产出的完整结构化 Segment[]（含 image/file/skill/text）。
 */
// SegmentsMetadataFile 类型从 @taiji/shared 导入（SSOT，与 sidecar IPC 共用）。

/** entry 树重建结果。 */
export interface RebuiltHistory {
  messages: Message[]
  /** userEntryId → clientUuid 映射（来自 "taiji.client-msg-id" custom entry）。 */
  clientUuidMap: Map<string, string>
  /**
   * 窗口内无法配对的孤儿 toolResult（W20 review Fix-1）。全量窗口正常时序恒空；
   * 增量窗口以 toolResult 开头（缓存 leafId 切在 assistant(toolCalls) 与其 toolResults
   * 之间）时非空——调用方（session-service 增量合并）应把它回填到缓存消息的 toolCall。
   *
   * 类型收 unknown[]（与 entries 入参同模式）：pi 结构（PiHistoryToolResult）不越过
   * port 边界，消费方透传给 message-converter 的 applyOrphanToolResults。
   */
  orphanToolResults: unknown[]
}

/**
 * msg-id-mapper extension 写入的 customType 常量。
 *
 * 与 extension 实现的 customType 字符串严格一致（步骤 1 的 @zhushanwen/pi-msg-id-mapper extension）。
 * 改名需同步 extension 端 + 测试。taiji. 前缀是 taiji namespace 约定，避免与 pi/其他扩展冲突。
 */
const CLIENT_MSG_ID_TYPE = 'taiji.client-msg-id'

/**
 * [defer segments 化 / D-A1-2 ③] defer flush 提交确认标记的提取正则——裸 uuid 形态。
 *
 * [双侧同构字面量] 与 core apply-entry-convert 的 DEFER_FLUSH_MARKER_RE（SSOT）同构：
 * runtime 不依赖 @taiji/core（分层边界），同 msg-id-mapper / message-dispatcher 的
 * 标记正则双侧同构先例——两侧禁单侧修改（形态变更 = 回填链断裂，测试锁定互斥性）。
 * 字符集（uuid hex，不含 u-）与 msg-id-mapper TAG_MATCH 的 u- 前缀形态结构互斥——
 * u- 标记帧不被本正则捕获、裸标记不被 TAG_MATCH 捕获。
 */
const DEFER_MARKER_RE = /<!--taiji:msg:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-->/i

/**
 * 从 customDataEntries 构建 userEntryId → clientUuid 映射（扫 taiji.client-msg-id custom entry）。
 * data = { clientUuid, userEntryId } → map[userEntryId] = clientUuid。
 * data 形状不匹配（缺字段/类型错）→ 跳过该 entry（降级，不崩溃）。
 * 冲突 warn 防御保留（extension 重试/重发场景，同一 userEntryId 多条 custom entry，
 * 后写覆盖前写；概率低但冲突时 warn 让问题可见，不阻断——错配只会导致 badge 回填到错误
 * user message，非崩溃）。
 */
function buildClientUuidMap(customDataEntries: PiSessionCustomEntry[]): Map<string, string> {
  const clientUuidMap = new Map<string, string>()
  for (const entry of customDataEntries) {
    if (entry.customType !== CLIENT_MSG_ID_TYPE) continue
    const data = entry.data as Partial<ClientMsgIdData> | null | undefined
    if (data && typeof data.clientUuid === 'string' && typeof data.userEntryId === 'string') {
      const existing = clientUuidMap.get(data.userEntryId)
      if (existing !== undefined && existing !== data.clientUuid) {
        console.warn(
          `[entry-tree-builder] clientUuidMap conflict for userEntryId=${data.userEntryId}: ` +
          `existing=${existing}, new=${data.clientUuid} (later wins)`,
        )
      }
      clientUuidMap.set(data.userEntryId, data.clientUuid)
    }
  }
  return clientUuidMap
}

/**
 * [defer segments 化 / D-A1-2 ③] 从原始 user message entry 文本提取 defer 裸标记 id，
 * 建 entryId → deferEntryId 映射。
 *
 * 为什么在 rebuildHistoryFromEntries 编排层、convert 之前提取：reload 重放同经
 * convertPiHistory → convertMessageBody 的标记剥离（apply-entry-convert 同款 DEFER 正则），
 * backfillSegments 拿到的 converted 文本已无裸标记——在 backfill 内 match 不可行。以
 * entryId 为 key（而非与 messages 平行的数组）：converted 与伪消息非 1:1（toolResult
 * 合并 / 非 user-assistant 丢弃），Message.piEntryId 是稳定关联键。
 *
 * 误命中防御：非 defer 的裸 uuid 文本（用户消息正文里恰好出现 uuid 字符串）不构成
 * `<!--taiji:msg:...-->` 标记形态，正则不捕获；sidecar 直查还要求 deferEntryId 全等——
 * 两道判据叠加（检查点①）。
 */
function buildDeferEntryIdMap(entries: PiSessionEntry[]): Map<string, string> {
  const deferIdByEntryId = new Map<string, string>()
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    if (entry.message?.role !== 'user') continue
    // content 文本化（string 或 parts 数组拼 text）——与 pi 落盘 user message 两种形态
    // 对齐（wire 宽形态归一，运行时 guard 不依赖静态类型收窄）
    const content: unknown = entry.message.content
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (
          typeof part === 'object' && part !== null &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          text += (part as { text: string }).text
        }
      }
    }
    const deferId = text.match(DEFER_MARKER_RE)?.[1]
    if (deferId !== undefined) deferIdByEntryId.set(entry.id, deferId)
  }
  return deferIdByEntryId
}

/**
 * 回填 segments：对 user message 按判定顺序查 sidecar（先 clientUuid 链、deferEntryId
 * 直查兜底）。
 *
 * [defer segments 化 / D-A1-2 ③] 判定顺序契约：clientUuid 链（piEntryId → clientUuidMap
 * → segmentsByClientUuid）先、deferEntryId 链（piEntryId → deferIdByEntryId →
 * segmentsByDeferEntryId）兜底。defer 条目结构上无 clientUuid 映射（msg-id-mapper
 * TAG_MATCH 只认 u- 前缀，裸 uuid 不命中 → hook no-op 不写 custom entry），两链数据
 * 不相交，顺序仅为契约防御（先走直查分支会改变非 defer 条目路径）。
 *
 * segments 非空才覆盖（空 segments 不覆盖默认产出，避免把有效 textToSegments 结果清空）；
 * 映射缺失 / sidecar 缺失 → 保持 convertPiHistory 默认产出（纯文本降级，不阻断）。
 */
function backfillSegments(
  converted: Message[],
  clientUuidMap: Map<string, string>,
  segmentsMetadata: SegmentsMetadataFile | null,
  deferIdByEntryId: Map<string, string>,
): void {
  const segmentsByClientUuid = new Map<string, Segment[]>()
  const segmentsByDeferEntryId = new Map<string, Segment[]>()
  if (segmentsMetadata) {
    for (const e of segmentsMetadata.entries) {
      // 两条 key 空间互斥（写入方二选一）；分别建索引，缺失 key 不落对方索引
      if (e.clientUuid !== undefined) segmentsByClientUuid.set(e.clientUuid, e.segments)
      if (e.deferEntryId !== undefined) segmentsByDeferEntryId.set(e.deferEntryId, e.segments)
    }
  }
  for (const msg of converted) {
    if (msg.role !== 'user' || !msg.piEntryId) continue
    // 判定顺序：clientUuid 链先（直发主链），deferEntryId 直查兜底（defer flush 链）
    const clientUuid = clientUuidMap.get(msg.piEntryId)
    const segments = clientUuid !== undefined
      ? segmentsByClientUuid.get(clientUuid)
      : segmentsByDeferEntryId.get(deferIdByEntryId.get(msg.piEntryId) ?? '')
    if (segments && segments.length > 0) {
      msg.content = segments
    }
  }
}

/**
 * 从 pi get_entries 返回的 entry 树重建 taiji Message[]。
 *
 * 三步（两遍扫 entry + 一遍回填），主函数只留编排：
 *
 * 1. mapSessionEntries 统一映射 entry 树（共享单点，与文件路径共用）：
 *    message/compaction/custom_message/branch_summary → messages 伪消息（供 convertPiHistory 消费），
 *    custom → customDataEntries（下方建 clientUuidMap 用），label/session_info 跳过。
 *    同时产出与 messages 平行对齐的 entryIds（替代旧 __entryId 注入）。
 *    替代旧手写两遍扫（旧实现只提取 message entry，丢弃 compaction/branch/custom_message，
 *    导致活跃 session 重开时这三类记录消失——违反 AGENTS.md 关键规则 9「可重开恢复」）。
 *
 * 2. buildClientUuidMap 从 customDataEntries 建 userEntryId → clientUuid 映射。
 *
 * 3. 整个 message 列表走 convertPiHistory（复用 toolResult 合并 + compactionSummary /
 *    custom / branchSummary 系统消息处理），产出 Message[]。entryIds 平行传入，使产出的
 *    user/assistant Message 带 piEntryId（从 entryIds[i] 取）。
 *    ⚠️ M2 前 RPC 路径手写两遍扫只提取 message entry，丢弃 compaction/branch/custom_message，
 *    导致活跃 session 重开时这三类记录消失（违反 AGENTS.md 关键规则 9「可重开恢复」）；
 *    改用共享 mapper 后两路径覆盖 by construction 一致。
 *    孤儿 toolResult 收集（W20 review Fix-1）：增量窗口以 toolResult 开头时窗口局部
 *    配对失败，收集后由增量合并阶段回填到缓存中的 assistant toolCall。
 *
 * 4. backfillSegments：对 user message 按 piEntryId 查 clientUuidMap → 查 segmentsMetadata
 *    → 命中且非空：msg.content = segments（完整结构化 Segment[]，含 image badge）
 *    → 未命中：保持 convertPiHistory 默认产出（textToSegments / parseSkillBlock）
 *
 * 降级原则：映射缺失 / segmentsMetadata 缺失 / segments 为空 → 不阻断，保持默认产出。
 * 这保证即使 extension 未写入 custom entry 或 sidecar 丢失，历史仍可读（纯文本降级）。
 *
 * @param entries pi get_entries 返回的 entries 数组（全量或 since 增量）
 * @param segmentsMetadata segments.json sidecar（null 表示无 sidecar，全降级）
 */
export function rebuildHistoryFromEntries(
  entries: PiSessionEntry[],
  segmentsMetadata: SegmentsMetadataFile | null,
): RebuiltHistory {
  // 1. mapSessionEntries 统一映射（共享单点，M2 接入）：四类 entry → messages 伪消息，
  //    custom → customDataEntries；entryIds 与 messages 平行对齐（AGENTS.md 关键规则 9）。
  const { messages, entryIds, customDataEntries } = mapSessionEntries(entries)

  // 2. clientUuidMap 从 customDataEntries 建（扫 taiji.client-msg-id custom entry）。
  const clientUuidMap = buildClientUuidMap(customDataEntries)

  // [defer segments 化 / D-A1-2 ③] defer 裸标记 id 提取在 convert 之前（原始 entries 的
  // user message 文本含裸标记；converted 文本已被 convertMessageBody 剥标记，backfill 内
  // match 不可行——第 3 轮复审修正）。
  const deferIdByEntryId = buildDeferEntryIdMap(entries)

  // 3. 整个数组走 convertPiHistory（复用 toolResult 合并 + 系统消息完整处理，C1 修复核心）。
  //    entryIds 平行传入使产出 Message 带 piEntryId，供第 4 步回填 badge。
  const orphanToolResults: PiHistoryToolResult[] = []
  const converted = convertPiHistory(messages, entryIds, orphanToolResults)

  // 4. 回填 segments：对 user message 按判定顺序查 sidecar（clientUuid 链先、deferEntryId
  //    直查兜底）
  backfillSegments(converted, clientUuidMap, segmentsMetadata, deferIdByEntryId)

  // 5. 回填 assistant 消息产出结束时刻（Message.endedAt = entry 时间戳）：turn 聚合口径
  //    （「已工作」时长/时刻区间）的时间轴右端。展示字段回填，不进 reducer（理由见
  //    applyEntryEndTimes 头注释——保 apply-entry 两条喂入路径逐字节同构）。
  applyEntryEndTimes(converted, entries)

  return { messages: converted, clientUuidMap, orphanToolResults }
}
