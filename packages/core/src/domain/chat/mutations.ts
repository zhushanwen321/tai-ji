/**
 * messages ref 的写入 helper（W1 shallowRef 适配 → W10 D-1 容器范式升级）。
 *
 * 背景（D-1，07 文档 §3.3）：messages 是 `ShallowRef<Map<string, ShallowRef<Message[]>>>`
 * ——外层 Map 恒等稳定（只在增删 sid key 时替换），每个 sid 持有独立的内层 ShallowRef。
 * 同 sid commit 只替换该分区的内层 ref（`existing.value = next`），A session 更新不再让
 * 依赖 B session 分区的 watcher / computed 失效（Map 整体替换的连带重算被消除）。
 *
 * 不变式（07 文档 §3.3.2）：
 * 1. 外层 Map 引用只在「增删 sid key」时替换；sid 已存在时 commit 只替换 existing.value。
 * 2. 每 sid 的分区 ref 一旦创建（首次 commit），引用在 session 存活期间稳定。
 *
 * 浅代理边界对齐 ADR-0039：浅到「外层 Map + 每 sid 数组」两层，内层用 shallowRef
 * （Message 对象本身不代理；用 ref 会深代理整条数组，违反 ADR-0039）。
 */

import { shallowRef, type ShallowRef } from 'vue'
import type { Message } from '@taiji/shared'
import { readUsage } from './readers'

/** messages ref 的结构类型（兼容 Vue Ref 与裸 { value } 结构）。 */
export type MessagesRef = { value: Map<string, ShallowRef<Message[]>> }

/**
 * 写入：同 sid 替换该分区内层 ref（外层 Map 引用不变，恒等稳定）；
 * 首次建 key（含 subagent:* 与 agentcall:* 虚拟 session 动态 id）替换外层 Map
 * （增删 session 是外层 Map 替换的唯一触发点）。
 */
export function commitMessages(
  messages: MessagesRef,
  sessionId: string,
  next: Message[],
): void {
  const existing = messages.value.get(sessionId)
  if (existing) {
    existing.value = next
  } else {
    messages.value = new Map(messages.value).set(sessionId, shallowRef(next))
  }
}

/**
 * 不可变删除：构造新 Map，delete 后整体赋值 .value（减 key 的合法 Map 替换情形）。
 * LRU 驱逐（lru.deleteMessageKey）/ disposeSession 经此或等价的 Map 替换路径。
 *
 * 类型参数 V 默认 ShallowRef<Message[]>，但允许泛化（lru 的 deps 用 Map<string, unknown> 宽类型）。
 */
export function deleteMessages<V = ShallowRef<Message[]>>(messages: { value: Map<string, V> }, sessionId: string): void {
  const next = new Map(messages.value)
  next.delete(sessionId)
  messages.value = next
}

/**
 * 截断 session 消息到 messageId（模块级，从 chat.ts 移入控制行数）。
 * inclusive=true 含 messageId，false 仅其后。findIndex 定位，slice 不可变更新。
 */
export function truncateMessagesFrom(
  messages: MessagesRef,
  sessionId: string,
  messageId: string,
  inclusive: boolean,
): void {
  const prev = messages.value.get(sessionId)?.value ?? []
  const idx = prev.findIndex((m) => m.id === messageId)
  if (idx === -1) return
  const end = inclusive ? idx : idx + 1
  commitMessages(messages, sessionId, prev.slice(0, end))
}

/**
 * W4 H4：历史去重合并到列表头部（模块级，从 chat.ts 移入控制行数）。
 * 终态消息 patch（message.complete 双通道单源，S4-A6 收口）。
 *
 * 为什么在此导出：message.complete 的两条消费链——registry 的 streaming 收口分支与
 * complete-recovery 的 premature-timeout 恢复分支——对同一气泡应用同一组终态字段
 * （status / usage / error / content 条件展开），此前靠注释「finalizeMessages 双通道同语义」
 * 人肉同步。本函数把该不变量结构化：任一分支的终态字段演化只需改这一处。
 *
 * 只做字段 patch，不含通道各自的命中守卫（streaming 收口 vs timeoutIds 打标实体）与
 * prematureTimeout 清标（仅恢复分支需要，调用方 spread 后追加）。外层守卫留在调用方。
 */
export interface TerminalMessagePatchOptions {
  /** 末位 assistant 索引（usage 回填 / content 覆盖 / error 写入只作用于末位，turn 级聚合） */
  lastAssistantIdx: number
  /** stopReason === 'error'（终态取向 error vs complete） */
  isErrorStop: boolean
  /** pi turn 失败错误文案（追加形态：仅末位 assistant 写 Message.error） */
  errorMessage: string | undefined
  /** 权威最终 content（runtime 从 pi agent_end 提取；非空才覆盖客户端累积值） */
  finalContent: string | undefined
  /** complete 原始 payload（usage 回填读值） */
  payload: Record<string, unknown>
}

/** 单条消息的终态 patch（纯函数；status/usage/error/content 条件展开，语义见 {@link TerminalMessagePatchOptions}）。 */
export function terminalMessagePatch(m: Message, i: number, opts: TerminalMessagePatchOptions): Message {
  const { lastAssistantIdx, isErrorStop, errorMessage, finalContent, payload } = opts
  // 仅最后一条 assistant 回填 usage + content（turn 级聚合，回填到非末 assistant 语义错位）
  const usage = i === lastAssistantIdx ? readUsage(payload) : undefined
  const shouldOverrideContent = i === lastAssistantIdx && finalContent !== undefined && finalContent.length > 0
  return {
    ...m,
    status: isErrorStop ? 'error' : 'complete',
    ...(usage ? { usage } : {}),
    ...(i === lastAssistantIdx && isErrorStop && errorMessage ? { error: errorMessage } : {}),
    ...(shouldOverrideContent ? { content: finalContent } : {}),
  }
}

/**
 * W4 H4：全量历史去重合并到列表头部（模块级，从 chat.ts 移入控制行数）。
 *
 * [u6] 「加载更早」改走 session.history 游标翻页（crash-resilience §3.3 D4 中期）：
 * runtime 按游标返回「锚点之前的最近窗口」，页内容天然不在分区中（锚点之前的段），
 * 正常时序零重复。id 去重保留为最后安全网：命中重复即 console.warn（异常时序信号），
 * 行为仍去重（宁可少插不可重插）。
 */
export function prependHistory(
  messages: MessagesRef,
  sessionId: string,
  history: Message[],
): void {
  const prev = messages.value.get(sessionId)?.value ?? []
  const existingIds = new Set(prev.map((m) => m.id))
  const newMsgs = history.filter((m) => !existingIds.has(m.id))
  const dedupedCount = history.length - newMsgs.length
  if (dedupedCount > 0) {
    console.warn(
      `[mutations] prependHistory deduped ${dedupedCount} message(s) already present in session ${sessionId}` +
        ' — cursor page overlapped loaded history (unexpected: runtime cursor window should precede the anchor)',
    )
  }
  if (newMsgs.length === 0) return
  commitMessages(messages, sessionId, [...newMsgs, ...prev])
}

// ── [u6 退役] W5 D5 load-more 锚定切分（splitHistoryBeforeAnchor / messageFingerprint）──
// 「加载更早」改走 session.history 游标翻页后，切分点由 runtime 按游标精确返回，
// 锚定切分链（hydrateAnchors + 三级定位）整体退役。

