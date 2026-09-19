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

/** ISO timestamp → ms；非字符串（缺失/畸形）兜底 Date.now()（与 mapEntriesToPiMessages 一致）。 */
function toMs(timestamp: unknown): number {
  return typeof timestamp === 'string' ? new Date(timestamp).getTime() : Date.now()
}

/**
 * 用 entry 时间戳回填 assistant 消息的 `Message.endedAt`（消息产出结束时刻）。
 *
 * 为什么需要独立回填步（而不在 reducer 里派生）：entry 时间戳是**持久化链路专有**数据——
 * pi 在 `appendMessage`（message_end 之后）才写 entry，故 entry.timestamp ≈ 该 assistant
 * 消息产出结束；而 live 链路的 message_end 帧不带 append 时刻（taiji 用消息体 timestamp
 * 合成 entry，见 event-adapter handleMessageEnd）。若把已回填字段进 reducer，live 侧
 * `Date.now()` 与 reload 侧 entry 时间戳的毫秒差会直接打穿 store 级 live≡reload 等价性断言
 * （apply-entry 两路喂入必须逐字节同构）。故保持 reducer 纯净，本函数只在历史转换产物上
 * 做一层展示字段回填，与 `backfillSegments` 同一层级（同为 reload 专属增强）。
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
  for (const entry of entries) {
    if (entry.type !== 'message' || typeof entry.id !== 'string') continue
    endTimeByEntryId.set(entry.id, toMs(entry.timestamp))
  }
  if (endTimeByEntryId.size === 0) return
  for (const msg of messages) {
    if (msg.role !== 'assistant' || msg.piEntryId === undefined) continue
    const endTime = endTimeByEntryId.get(msg.piEntryId)
    if (endTime !== undefined && endTime >= msg.timestamp) msg.endedAt = endTime
  }
}

/**
 * 把 pi session JSONL entry 数组映射为 { messages, entryIds, customDataEntries }。
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
export function mapSessionEntries(entries: PiSessionEntry[]): MappedSessionEntries {
  const messages: unknown[] = []
  const entryIds: string[] = []
  const customDataEntries: PiSessionCustomEntry[] = []

  for (const entry of entries) {
    switch (entry.type) {
      case 'message': {
        // 透传 message 体（不注入 __entryId，改用平行 entryIds）
        messages.push(entry.message)
        entryIds.push(entry.id)
        break
      }
      case 'compaction': {
        messages.push({
          role: 'compactionSummary',
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          timestamp: toMs(entry.timestamp),
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
        // （false → 隐藏），与 live 侧 parse 失败不广播的降级行为对称。
        // 本 mapper 是 RPC（entry-tree-builder）与文件（session-history）两条 reload 路径的
        // 共享单点，覆写在此做即覆盖全部 reload 链路。
        const isDirectiveVisible = entry.customType === SUBAGENT_DIRECTIVE_CUSTOM_TYPE
          && parseSubagentDirective(entry.content, entry.details) !== null
        // display 覆写优先级：完成通知 → 隐藏（false）；subagent-directive → 显示（true）；
        // 其余透传持久化值
        let display = entry.display
        if (isCompleteNotify) display = false
        else if (isDirectiveVisible) display = true
        messages.push({
          role: 'custom',
          customType: entry.customType,
          // 畸形降级：content 非字符串时默认空串（session JSONL 截断/损坏不抛错）
          content: typeof entry.content === 'string' ? entry.content : '',
          details: entry.details,
          display,
          timestamp: toMs(entry.timestamp),
        })
        entryIds.push(entry.id)
        break
      }
      case 'branch_summary': {
        messages.push({
          role: 'branchSummary',
          summary: entry.summary,
          fromId: entry.fromId,
          timestamp: toMs(entry.timestamp),
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

  return { messages, entryIds, customDataEntries }
}
