/**
 * message-converter —— 历史路径 entry → Message 转换的 wire 层（data-source-governance W20）。
 *
 * [W20 架构位] 派生规则（content parts 解析 / skill 剖离 / toolResult 配对 / compaction /
 * branchSummary / custom / bashExecution / fileChanges / usage）已全部迁入 core reducer：
 * packages/core/src/domain/chat/apply-entry.ts（applyEntry —— D5 单一 reducer，D7 投影一次）。
 * 本文件保留 wire 层职责：RPC reply / JSONL 读到的原始形态 → pi entry 列表（liftHistoryToEntries）
 * → 喂 core reducer → Message[]。
 *
 * core 依赖现状（r1-S12 更新）：runtime 已声明 @taiji/core（workspace:*，tsup
 * noExternal 已含该包；子路径 import 先例见 trace-sync.ts），本文件保留相对路径 import
 * 系历史形态——apply-entry.ts 是自包含纯函数模块（只依赖 @taiji/shared），相对引用
 * 使派生规则单点化；新增 core 引用建议走包名子路径。
 *
 * [W21] 迁移期参照实现（convertPiHistoryLegacy 家族）已删除——等价性防线升级为
 * live≡reload store 级同构（src/__tests__/equivalence/live-reload.test.ts，真实 pi fixture
 * + 同一 reducer）+ apply-entry 确定性断言（core __tests__/apply-entry*.test.ts）。
 *
 * 实时路径（event-adapter.ts）不在本文件历史路径管辖内（W21 已接：message_end / tool
 * 事件翻译时重构 entry，见 event-adapter.ts handleMessageEnd / handleToolExecution*）。
 */
import type {
  PiHistoryMessage,
  PiHistoryToolResult,
} from './pi-protocol.js'
import type { Message, ToolCall } from '@taiji/shared'
import { normalizePiToolResult } from './normalize-tool-result.js'
import {
  applyEntry,
  createInitialChatViewState,
  replayEntries,
} from '../../../../core/src/domain/chat/apply-entry.js'
import type { PiEntry, PiMessageEntry } from '../../../../core/src/domain/chat/apply-entry.js'

// ════════════════════════════════════════════════════════════════════
// 新路径：wire lift + core reducer（W20 起的历史路径唯一生产实现）
// ════════════════════════════════════════════════════════════════════

/**
 * 把历史读取链路拿到的伪消息列表 lift 为 pi message entry 形态（wire 层职责：RPC reply → entry 列表）。
 *
 * 输入形态（mapSessionEntries 产出的伪消息 / get_messages 扁平列表 / JSONL 提取）全部包成
 * message entry——pi AgentMessage 联合本身含 toolResult/bashExecution/compactionSummary/custom/
 * branchSummary role（与专用 entry 类型双形态存储），role 细分语义归 reducer 的 message case。
 *
 * entryId 解析优先级与迁移前一致：平行 entryIds[i] > 消息体 __entryId（文件路径旧注入）；
 * 都缺失时 entry 不带 id（reducer 不回填 piEntryId，piEntryId 缺失语义与迁移前一致）。
 *
 * 缺失 timestamp 的兜底（Date.now）在 lift 时落定——与迁移前同点位，保证 reducer 输入
 * 确定后输出确定（reducer 内部无 Date.now / randomUUID）。
 *
 * 导出供等价性测试（lift 保真断言）消费，生产调用方只有 convertPiHistory。
 */
export function liftHistoryToEntries(raw: unknown[], entryIds?: string[]): PiEntry[] {
  const entries: PiEntry[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (typeof item !== 'object' || item === null) {
      console.warn(`[message-converter] skipping non-object history item at index ${i}`)
      continue
    }
    const rec = item as Record<string, unknown>
    const inlineId = typeof rec.__entryId === 'string' ? rec.__entryId : undefined
    const entryId = entryIds?.[i] ?? inlineId
    const tsMs = typeof rec.timestamp === 'number' ? rec.timestamp : Date.now()
    const entry: PiMessageEntry = {
      type: 'message',
      ...(entryId !== undefined && { id: entryId }),
      parentId: null,
      timestamp: new Date(tsMs).toISOString(),
      message: rec,
    }
    entries.push(entry)
  }
  return entries
}

/**
 * 转换单条 pi message 为 taiji Message（W20 起经 core reducer；保留导出供
 * message-converter-order.test 的 contentBlocks 顺序回归与潜在外部消费者）。
 *
 * 仅处理 user/assistant message。未知 role 在 reducer 内 warn + 跳过（返回 null）。
 *
 * @param m pi history message
 * @param options 可选 entryId（填到 msg.piEntryId；缺省时回退读 m.__entryId）
 */
export function convertSinglePiMessage(
  m: PiHistoryMessage,
  options?: { entryId?: string },
): Message | null {
  const inlineId = '__entryId' in m && typeof (m as { __entryId?: unknown }).__entryId === 'string'
    ? (m as { __entryId: string }).__entryId
    : undefined
  const entryId = options?.entryId ?? inlineId
  const entry: PiMessageEntry = {
    type: 'message',
    ...(entryId !== undefined && { id: entryId }),
    parentId: null,
    timestamp: new Date(m.timestamp ?? Date.now()).toISOString(),
    message: m,
  }
  const state = applyEntry(createInitialChatViewState(), entry)
  return state.messages.length > 0 ? state.messages[0] : null
}

/**
 * Convert pi message list into frontend Message[], merging toolResult
 * entries into their parent assistant message's matching toolCall.
 *
 * [W20] 实现 = liftHistoryToEntries（wire lift）+ replayEntries（core reducer fold）。
 * 签名与行为契约不变（等价性由 apply-entry-equivalence.test 对 legacy 断言锁定）：
 *
 * 签名收 unknown[]：pi 的历史结构（PiHistoryMessage/PiHistoryToolResult）是 pi 协议类型，
 * 只在此 infra 文件内部断言，不暴露给 service。service 传 RPC/文件读到的原始 JSON 即可。
 *
 * @param raw pi history message 列表（get_messages 返回 / JSONL 读取 / entry 树提取）
 * @param entryIds 可选，与 raw 一一对应的 entry id 列表（entry 树重建路径用）。
 *   传时 user/assistant message 会带上 piEntryId（按 index 取 entryIds[i]）。
 * @param orphanToolResults 可选 out 数组：窗口内无法配对的 toolResult（无 preceding
 *   assistant 或其 toolCalls 无匹配 toolCallId）push 进来供增量合并阶段回填
 *   （W20 review Fix-1）。不传时保持原行为（warn 丢弃）——全量窗口正常时序无孤儿。
 */
export function convertPiHistory(raw: unknown[], entryIds?: string[], orphanToolResults?: PiHistoryToolResult[]): Message[] {
  const state = replayEntries(liftHistoryToEntries(raw, entryIds))
  if (orphanToolResults !== undefined) {
    for (const orphan of state.orphanToolResults) {
      // orphan 已由 reducer 按 role==='toolResult' 收窄构造（apply-entry.ts toolResult 分支），
      // 此处断言只还原「宽形态 body → pi 协议类型」的静态差异，字段集运行时一致。
      orphanToolResults.push(orphan as PiHistoryToolResult)
    }
  }
  return state.messages
}

/**
 * 把增量窗口的孤儿 toolResult 按 toolCallId 回填到已合并消息列表的 assistant toolCall
 * （W20 review Fix-1）。reducer fold 后的增量合并阶段调用；匹配不到 warn 丢弃。
 *
 * 签名收 unknown[]（与 convertPiHistory 同模式）：pi 结构只在此 infra 文件内部断言。
 */
export function applyOrphanToolResults(messages: Message[], orphanToolResults: unknown[]): void {
  for (const raw of orphanToolResults) {
    const toolResult = raw as PiHistoryToolResult
    let matched: ToolCall | undefined
    for (const m of messages) {
      matched = m.toolCalls?.find(t => t.id === toolResult.toolCallId)
      if (matched) break
    }
    if (matched) {
      fillToolCallOutput(matched, toolResult)
    } else {
      console.warn('[message-converter] orphan toolResult has no matching toolCall in merged messages:', toolResult.toolCallId)
    }
  }
}

/**
 * 把 toolResult 归一回填到单个 toolCall（applyOrphanToolResults 生产路径消费；
 * [W21] legacy 家族删除后为唯一实现，语义与迁移前逐字一致——reducer 的
 * computeToolCallFill（copy-on-write 版）为重放/实时路径对应实现）。
 */
function fillToolCallOutput(tc: ToolCall, toolResult: PiHistoryToolResult): void {
  // 对称恢复 outputRaw（关键规则 9：对话流状态必须可重开恢复）。
  // 实时路径（event-adapter handleToolExecutionEnd）已统一委托 normalizePiToolResult（W1），
  // 此处历史路径对称：output 存 stripAnsi 版本，outputRaw 存原始 ANSI 文本（仅当含 ANSI 时）。
  const { output, outputRaw } = normalizePiToolResult(toolResult)
  tc.output = output
  if (outputRaw) tc.outputRaw = outputRaw
  if (toolResult.isError) tc.status = 'error'
  // F1 修复：透传 details（含 __gui__），与实时路径（event-interpreter tool_call_end）对齐。
  // 关键规则 9：对话流状态必须可重开恢复——重开 session 后 __gui__ 不丢。
  if (toolResult.details && typeof toolResult.details === 'object' && !Array.isArray(toolResult.details)) {
    tc.details = toolResult.details
  }

}
