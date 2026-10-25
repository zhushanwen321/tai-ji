/**
 * 重启中断尾部形态判定（design-session-lifecycle 缺陷 4 方向 A，用户已裁决）。
 *
 * 证据链（pi 落盘时序，dist 实锚见该设计文档）：pi 只在 message_end 时把整条消息同步落盘
 * （appendMessage → appendFileSync 整行追加），流式输出期间零落盘。因此：
 * - 正常完成的回合，尾部必为**无 toolCall 的 assistant entry**（模型输出终稿后 turn 才结束；
 *   abort 落盘 stopReason=aborted 的完整 assistant，同形态不触发）；
 * - 中断（内容损失）三形态可判定：尾部 message = user（assistant 未产出）/ 带 toolCall 的
 *   assistant（工具结果丢失）/ toolResult（下一轮 assistant 丢失）。
 * - 零损失窗口（最后 assistant 已落盘、turn 未收尾）不可判定也无需标记。
 *
 * 「从尾向前找最后一个 message entry」而非看文件最后一条：合法非回合 entry（custom/
 * client-msg-id 映射、label、usage、compaction）可落在回合内容之后，跳过它们才对齐
 * 「回合内容尾部」语义；一路扫不到 message entry（纯 header/纯 custom）= 无回合不标。
 *
 * 联合判定的「会话未附着」半边不在本函数——由调用方限定在 getHistory 离线路径构造性保证
 * （活跃会话走 RPC 路径不调本函数；RPC 失败降级文件读同样不得调用，防活会话生成中误标）。
 *
 * 性质 = 推断（两个确定性事实的推导，非中断事件直接记录），误标风险由未附着事实排除活会话。
 * 返回 true = 建议前端渲染中断提示条；保守原则：形态不可判一律 false（宁可漏标不误标）。
 */
export function isInterruptedTail(entries: PiSessionEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry?.type !== 'message') continue
    const msg = entry.message as { role?: unknown; content?: unknown } | undefined
    const role = msg?.role
    if (role === 'user') return true
    if (role === 'assistant') {
      // content parts 含 toolCall → 工具已发起未归（toolResult 丢失）；否则 = 终稿已落盘（含 abort 的完整落盘形态）
      const parts = Array.isArray(msg?.content) ? (msg.content as Array<{ type?: unknown }>) : []
      return parts.some((p) => p?.type === 'toolCall' || p?.type === 'tool_use')
    }
    if (role === 'toolResult') return true
    // system / bashExecution / 未知 role：非回合产出尾部，零内容损失形态，不标
    return false
  }
  return false
}

/**
 * mapSessionEntries — session entry → 伪消息映射的共享单点（converter M1）。
 *
 * 把 pi session JSONL entry 数组映射为三类产物，供 RPC/文件两条历史读取链路共用：
 * - messages：四类 entry（message 透传 / compaction / branch_summary / custom_message）转成的伪消息，
 *   role 集合与 RPC get_messages 返回对齐，供 convertPiHistory 单点消费（AGENTS.md 关键规则 9）。
 * - entryIds：与 messages 平行对齐的来源 entry id（替代旧 __entryId 注入，M1 不再塞消息体）。
 * - customDataEntries：纯数据 custom entry（type:'custom'，不进 LLM 上下文），按需读取。
 *
 * M1 只建 mapper + 类型 + SSOT，不接入 rebuildHistoryFromEntries / getHistoryFromFilePath（M2/M3 才接入）。
 *
 * 映射逻辑整体迁移自 session-history.ts mapEntriesToPiMessages（逻辑不重新发明），差异：
 * ① 不注入 __entryId（改平行 entryIds 数组）；
 * ② 完成通知 custom_message 的 display 覆写引用 shared COMPLETE_NOTIFY_CUSTOM_TYPES SSOT。
 *
 * 为什么必须是共享单点（教训）：曾因 RPC/文件两路各自维护 entry 筛选实现，覆盖倒挂——
 * RPC 路径只放行 message + client-msg-id，compaction/branch_summary/custom_message 三类
 * 被丢弃（活跃重开丢压缩记录），离线文件路径反而完整；修一处漏一处的循环正是本次收敛
 * 单点的动因（「判别前置到数据入口，下游不做二次猜测」）。新增 entry 类型只改此处。
 */
import type { Message } from '@taiji/shared'
import type { PiSessionEntry, PiSessionCustomEntry } from './pi-protocol.js'
import { COMPLETE_NOTIFY_CUSTOM_TYPES, SUBAGENT_DIRECTIVE_CUSTOM_TYPE, parseSubagentDirective } from '@taiji/shared'

/** mapSessionEntries 返回类型。 */
export interface MappedSessionEntries {
  /** 四类 entry 转成的伪消息数组（供 convertPiHistory 消费）。 */
  messages: unknown[]
  /** 与 messages 平行对齐的来源 entry id（entryIds[i] = messages[i] 来源 entry 的 id）。 */
  entryIds: string[]
  /** 纯数据 custom entry（type:'custom'，不进 messages / LLM 上下文）。 */
  customDataEntries: PiSessionCustomEntry[]
}

/**
 * ISO timestamp → ms；畸形处理（RT-3#6，M7）：
 * - 非字符串（缺失/类型错）→ undefined；
 * - `new Date(str).getTime()` 非有限值（无法解析的畸形串）→ undefined；
 * - 两种情况各记一次 warn（按本次映射聚合，见 mapSessionEntries / applyEntryEndTimes）。
 *
 * 为什么禁用旧兜底 `Date.now()`：用当前时刻伪装原始时刻会让畸形数据不可追溯
 * （排序/时长计算拿到的是「读取时刻」而非「发生时刻」），NaN 更会穿透到
 * endedAt/时长计算并广播（且 NaN 进 liftHistoryToEntries 的 `new Date(NaN).toISOString()`
 * 直接抛 RangeError）。undefined 语义 = 「该 entry 无可用时刻」——mapSessionEntries 侧
 * 省略 timestamp 字段（消费侧 lift 的缺失兜底单点落定），applyEntryEndTimes 侧不回填
 * （消费侧回退消息体 timestamp，与「缺席 entry」既有降级一致）。
 */
function toMs(timestamp: unknown): number | undefined {
  if (typeof timestamp !== 'string') return undefined
  const ms = new Date(timestamp).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

/** toMs 的畸形计数 + 聚合 warn（每次映射一条，畸形数据需人工修文件）。 */
class MalformedTimestampTracker {
  private count = 0

  note(): void {
    this.count++
  }

  warnIfAny(context: string): void {
    if (this.count > 0) {
      console.warn(`[session-entry-mapper] ${context}: ${this.count} entry/entries with missing or malformed timestamp — treated as absent (no fabricated time)`)
    }
  }
}

/**
 * 用 entry 时间戳回填 assistant 消息的 `Message.endedAt`（消息产出结束时刻）。
 *
 * 为什么需要独立回填步（而不在 reducer 里派生）：entry 时间戳是**持久化链路专有**数据——
 * pi 在 `appendMessage`（message_end 之后）才写 entry，故 entry.timestamp ≈ 该 assistant
 * 消息产出结束；live 链路的合成 entry.timestamp 同义（= 运行时到达时刻 ≈ pi appendMessage
 * 落盘时刻，见 event-adapter handleMessageEnd 的 [chat-flow-consistency D3 修正]）。若把
 * 已回填字段进 reducer，live 侧 `Date.now()` 与 reload 侧 entry 时间戳的毫秒差会直接打穿
 * store 级 live≡reload 等价性断言（apply-entry 两路喂入必须逐字节同构）。故保持 reducer
 * 纯净，本函数只在历史转换产物上做一层展示字段回填，与 `backfillSegments` 同一层级
 * （同为 reload 专属增强）。
 *
 * 语义与降级：
 * - 只处理 assistant 消息（user/system 无「产出结束」语义，不再让「已工作」时长被 system
 *   消息时间戳污染）。
 * - 关联键 = `Message.piEntryId` ↔ `entry.id`（转换时经平行 entryIds 回填，见 MF5）。
 * - `entry.timestamp < message.timestamp`（时钟回拨/畸形数据）→ 不回填，消费侧回退 timestamp。
 * - 缺席 entry（截断窗口）→ 不写，消费侧回退 timestamp（与修复前行为等价）。
 *
 * 回溯性：entry 时间戳一直在 session JSONL / get_entries 里，历史 session 无需迁移即修好
 * 「单条 assistant 的 turn 恒显 1s」问题。
 */
export function applyEntryEndTimes(messages: Message[], entries: PiSessionEntry[]): void {
  const endTimeByEntryId = new Map<string, number>()
  const malformed = new MalformedTimestampTracker()
  for (const entry of entries) {
    if (entry.type !== 'message' || typeof entry.id !== 'string') continue
    const ms = toMs(entry.timestamp)
    if (ms === undefined) {
      // 畸形/缺失 timestamp：不回填（消费侧回退消息体 timestamp），计数显形（RT-3#6）
      malformed.note()
      continue
    }
    endTimeByEntryId.set(entry.id, ms)
  }
  malformed.warnIfAny('applyEntryEndTimes')
  if (endTimeByEntryId.size === 0) return
  for (const msg of messages) {
    if (msg.role !== 'assistant' || msg.piEntryId === undefined) continue
    const endTime = endTimeByEntryId.get(msg.piEntryId)
    if (endTime !== undefined && endTime >= msg.timestamp) msg.endedAt = endTime
  }
}

/**
 * 活跃路径裁剪纯函数（message-revoke U6a；导出 SSOT——runtime 派生读者按 census §4.1
 * 复用本函数，不自含重复实现）。
 *
 * 语义：pi session 文件是 append-only 树（每个 entry 带 parentId，根为 null；pi 全部
 * append* 统一 `parentId = this.leafId` 追加）；模型/对话流视角的「活跃上下文」= 从叶子
 * 沿 parentId 回溯到根的链（pi 树重放规则：重启后叶子 = 文件最后一条 entry——PS-60
 * 实锚 dist/core/session-manager.js:673 `_buildIndex` 文件序循环置 leafId=entry.id、
 * :616 `_setSessionFile` 加载路径）。撤回
 * （navigateTree 回退）后被撤子树仍在文件里（审计保留）但不在活跃路径上——本函数把
 * entries 映射为活跃路径子集，供历史重建链喂入既有映射（被撤分支不渲染，G2 二分的
 * 「未来状态随树」路径）。
 *
 * 契约：
 * - leafId === undefined → 原数组原样返回（同一引用）：缺省 = 现行为（全文件），
 *   既有无分支 session 行为构造性不变；
 * - leafId 不在 entries 的 id 集合中 → warn 后原样返回（fail-safe：leafId 与 entries
 *   不匹配属上游异常，宁可多显示也不清空历史）；
 * - 病态树降级：无父链接（parentId null / 非 string）的 entry 多于一个 → warn 后原样
 *   返回。合法 pi 文件恰一个根（首条 entry）；多根 = 文件损坏/非 pi 产出，活跃路径
 *   语义未定义，退回裁剪前行为（顺带覆盖截断链路的中间损坏形态——断链残根同判）；
 * - 输出保持输入顺序（文件序 = 根→叶正序），只做成员过滤不做重排；
 * - 回溯链在 parentId === null（到达根）、parentId 指向集合外节点（增量/截断窗口的
 *   正常边界，如尾读窗口首条的父亲在窗口外）时终止；环状 parentId（文件损坏）由
 *   已访问集防御，不死循环。
 *
 * 泛型结构约束宽松（id/parentId 运行时校验）：调用方可能持 port 收窄类型（如
 * get_entries 响应的域内收窄）而非完整 PiSessionEntry——按原类型透传；id 非 string 的
 * entry 不可被索引/命中，不在活跃路径上（派生视图语义，非垃圾容忍契约）。
 */
export function computeActivePathEntries<T extends { id?: unknown; parentId?: unknown }>(
  entries: T[],
  leafId: string | undefined,
): T[] {
  if (leafId === undefined) return entries
  const entryById = new Map<string, T>()
  let rootLikeCount = 0
  for (const e of entries) {
    if (typeof e.id !== 'string') continue
    entryById.set(e.id, e)
    if (typeof e.parentId !== 'string') rootLikeCount++
  }
  if (!entryById.has(leafId)) {
    console.warn(
      `[session-entry-mapper] computeActivePathEntries: leafId ${leafId} not found among ${entries.length} entries — skipping active-path trim (unexpected response shape; showing full set)`,
    )
    return entries
  }
  if (rootLikeCount > 1) {
    console.warn(
      `[session-entry-mapper] computeActivePathEntries: ${rootLikeCount} entries without parent link (valid pi tree has exactly one root) — skipping active-path trim (malformed tree; showing full set)`,
    )
    return entries
  }
  const active = new Set<string>()
  let cursor: string | undefined = leafId
  while (cursor !== undefined && !active.has(cursor)) {
    const e = entryById.get(cursor)
    if (e === undefined) break // 父节点在集合外（窗口边界/文件损坏）→ 链终止
    active.add(cursor)
    cursor = typeof e.parentId === 'string' ? e.parentId : undefined
  }
  return entries.filter((e) => typeof e.id === 'string' && active.has(e.id))
}

/**
 * 把 pi session JSONL entry 数组映射为 { messages, entryIds, customDataEntries }。
 *
 * [message-revoke U6a] leafId 可选参数：提供时先经 computeActivePathEntries 裁剪为活跃
 * 路径再映射（RPC 全量重建与文件直读两链在此共用同一裁剪语义——mapper 是两路 reload
 * 链的共享单点，裁剪收在同一单点保证 by construction 一致）；缺省 = 现行为（全文件）。
 * 增量窗口调用方不传 leafId（delta 是活跃路径后缀切片，裁剪是全树语义——见
 * history-rebuild-cache getIncrementalHistory 的契约注释）。
 *
 * 映射规则（迁移自 mapEntriesToPiMessages）：
 * - message → 透传 message 体（不注入 __entryId，改用平行 entryIds）
 * - compaction → { role:'compactionSummary', summary, tokensBefore, timestamp }
 * - custom_message → { role:'custom', customType, content, details, display, timestamp }；
 *   完成通知 customType（COMPLETE_NOTIFY_CUSTOM_TYPES）display 覆写为 false
 *   （pi 可能持久化 display:true，taiji 统一隐藏——agent 收到后 triggerTurn 唤醒处理，
 *   结果由后续 turn 体现，通知本身对用户是噪声）；
 *   subagent-directive customType display 覆写为 true（extension 落 false 是 pi TUI 语义，
 *   taiji 聊天流定向气泡统一显示，见 case 内注释）
 * - branch_summary → { role:'branchSummary', summary, fromId, timestamp }
 * - custom → 进 customDataEntries（不进 messages）
 * - 其余（label/session_info 等未建模类型）→ 跳过
 *
 * 畸形降级：custom_message 无 content → 默认空串，不抛错（session JSONL 可能被截断/损坏）。
 */
export function mapSessionEntries(entries: PiSessionEntry[], leafId?: string): MappedSessionEntries {
  // [message-revoke U6a] 活跃路径裁剪：leafId 缺省时 computeActivePathEntries 原样返回
  //（同一引用），既有调用零开销零行为变化
  const scoped = computeActivePathEntries(entries, leafId)
  const messages: unknown[] = []
  const entryIds: string[] = []
  const customDataEntries: PiSessionCustomEntry[] = []
  const malformed = new MalformedTimestampTracker()

  // RT-3#6：entry timestamp 畸形（非字符串/不可解析）→ 省略 timestamp 字段而非注入
  // NaN/Date.now()（NaN 会打穿消费链，Date.now() 伪装原始时刻不可追溯）；缺失兜底由
  // liftHistoryToEntries 的单点（typeof number ? : Date.now()）落定，语义同迁移前。
  const entryTs = (timestamp: unknown): number | undefined => {
    const ms = toMs(timestamp)
    if (ms === undefined) malformed.note()
    return ms
  }

  for (const entry of scoped) {
    switch (entry.type) {
      case 'message': {
        // 透传 message 体（不注入 __entryId，改用平行 entryIds）
        messages.push(entry.message)
        entryIds.push(entry.id)
        break
      }
      case 'compaction': {
        const ts = entryTs(entry.timestamp)
        messages.push({
          role: 'compactionSummary',
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          ...(ts !== undefined && { timestamp: ts }),
        })
        entryIds.push(entry.id)
        break
      }
      case 'custom_message': {
        // 完成通知类 customType：display 覆写为 false（pi 可能持久化 true，taiji 统一隐藏）
        const isCompleteNotify = COMPLETE_NOTIFY_CUSTOM_TYPES.has(entry.customType)
        // subagent-directive：display 覆写为 true（composer-symbol-system §3.3.3a reload 链路）。
        // 为什么覆写：extension 落 display:false 是 pi TUI 渲染语义；taiji 聊天流的定向
        // 气泡必须「重开后仍在」（关键规则 9），display:false 会被前端 display 过滤隐藏。
        // 仅 details 可解析时覆写（parse 与 live 广播同一解析器）——畸形时保持透传
        //（false → 隐藏），与 live 侧 parse 失败不广播的降级行为对称。
        // 本 mapper 是 RPC（entry-tree-builder）与文件（session-history）两条 reload 路径的
        // 共享单点，覆写在此做即覆盖全部 reload 链路。
        const isDirectiveVisible = entry.customType === SUBAGENT_DIRECTIVE_CUSTOM_TYPE
          && parseSubagentDirective(entry.content, entry.details) !== null
        // display 覆写优先级：完成通知 → 隐藏（false）；subagent-directive → 显示（true）；
        // 其余透传持久化值
        let display = entry.display
        if (isCompleteNotify) display = false
        else if (isDirectiveVisible) display = true
        const ts = entryTs(entry.timestamp)
        messages.push({
          role: 'custom',
          customType: entry.customType,
          // 畸形降级：content 非字符串时默认空串（session JSONL 截断/损坏不抛错）
          content: typeof entry.content === 'string' ? entry.content : '',
          details: entry.details,
          display,
          ...(ts !== undefined && { timestamp: ts }),
        })
        entryIds.push(entry.id)
        break
      }
      case 'branch_summary': {
        const ts = entryTs(entry.timestamp)
        messages.push({
          role: 'branchSummary',
          summary: entry.summary,
          fromId: entry.fromId,
          ...(ts !== undefined && { timestamp: ts }),
        })
        entryIds.push(entry.id)
        break
      }
      case 'custom': {
        // 纯数据 entry，不进 messages / LLM 上下文，由消费侧按需读取（如 client-msg-id 映射）
        customDataEntries.push(entry)
        break
      }
      default: {
        // label / session_info / 未建模类型 → 跳过
        break
      }
    }
  }

  malformed.warnIfAny('mapSessionEntries')

  return { messages, entryIds, customDataEntries }
}
