/**
 * Chat 域 —— send/abort/streamSubscribe。
 *
 * 依赖方向：command（RPC，send/abort/steer/followUp/compact/getHistory）+ events（streamSubscribe 路由）。
 *
 * 注意：streamSubscribe 的 handler 参数类型是 ServerMessageUnion（shared 协议类型），
 * 不臆造 StreamChunk。调用方在 handler 内过滤 message.text_delta 等事件。
 * 注：mock 模式下不走本域（api/index 切到 mock 门面）。
 */
import type { Message, ServerMessageUnion } from '@taiji/shared'
import {
  BASH_RPC_TIMEOUT_MS,
  COMPACT_RPC_TIMEOUT_MS,
  RENDERER_RPC_MARGIN_MS,
} from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command as sendCommand } from '../request'
import * as events from '../events'

/**
 * getHistory 返回结构（[u4d] u4b 双预算窗口契约；[u6] legacy historyTruncated 已退役——
 * truncated 是唯一截断标志，偏差表 D7 双轨收口）。
 */
export interface HistoryResult {
  messages: Message[]
  /** [u4b] truncated=true 表示预算窗口外仍有历史（前端据此显隐「加载更早」顶部条） */
  truncated: boolean
  /** [u4b] 本次返回的完整 turn 数（顶部条「已加载最近 N 轮」的 N；游标翻页时 = 本页 turn 数） */
  loadedTurns: number
  /** [u4b] session 的 turn 总数估计（读到头为精确值，窗口截断时为下界） */
  totalTurnsEstimate: number
}

/**
 * session.history 可选查询参数（[u6] crash-resilience §3.3 D4 中期分页协议）。
 * cursor = turn 边界锚点 entryId（renderer 当前窗口最早消息的 piEntryId），带 cursor 返回
 * 锚点之前的最近窗口（活跃/离线两路径共用语义）；limitTurns/maxBytes 覆盖默认预算。
 */
export interface HistoryQuery {
  cursor?: string
  limitTurns?: number
  maxBytes?: number
}

/**
 * 拉取 session 历史（UC-2 切换 session 时回填 message-stream）。
 * runtime reply envelope 是 `{ sessionId, messages, truncated, loadedTurns, totalTurnsEstimate }`：
 * truncated=true 表示历史按双预算（u4b）截断，前端据此显隐「加载更早」顶部条并显示已加载 turn 数。
 * [u6] query 可选：带 cursor 时为「加载更早」游标翻页（runtime 返回锚点之前的最近窗口，
 * cursor 未命中返回空页 + truncated=false 翻页到头语义）；缺省 = 最近窗口（u4b 现状）。
 */
export async function getHistory(sessionId: string, query?: HistoryQuery): Promise<HistoryResult> {
  const reply = await sendCommand(
    'session.history',
    query
      ? { sessionId, ...(query.cursor !== undefined && { cursor: query.cursor }), ...(query.limitTurns !== undefined && { limitTurns: query.limitTurns }), ...(query.maxBytes !== undefined && { maxBytes: query.maxBytes }) }
      : { sessionId },
    RPC_BACKSTOP_TIMEOUT_MS,
  )
  return {
    messages: reply.messages,
    truncated: reply.truncated,
    loadedTurns: reply.loadedTurns,
    totalTurnsEstimate: reply.totalTurnsEstimate,
  }
}

/**
 * 发送消息（mock 不模拟失败，D7）。
 *
 * images 是 Cmd+V 富呈现通路的图片数据（base64，不含 data: 前缀），形状对齐
 * shared protocol message.send（protocol.ts:199 images?: Array<{data;mimeType}>）。
 * runtime rpc-client 已守卫空数组（rpc-client.ts:430 images.length>0 才组 piImages），
 * 故此处 images 为 undefined 时直接不传 images 键（保持既有 payload 形态不变）。
 *
 * options.clientUuid（session-occupancy-send-closure D2）：经 message.send RPC 参数透传，
 * runtime 拒绝时在 send.rejected 广播原样带回（renderer 兜底消歧）。undefined 时不带键，
 * payload 形态与既有流量完全一致（归一模式对称 images）。
 */
export function send(
  sessionId: string,
  text: string,
  images?: Array<{ data: string; mimeType: string }>,
  options?: { clientUuid?: string },
): Promise<void> {
  const clientUuid = options?.clientUuid
  return sendCommand(
    'message.send',
    images
      ? { sessionId, content: text, images, ...(clientUuid !== undefined && { clientUuid }) }
      : { sessionId, content: text, ...(clientUuid !== undefined && { clientUuid }) },
    RPC_BACKSTOP_TIMEOUT_MS,
  )
}

/** 追加 steer（当前回合工具调用结束后、下次 LLM 调用前投递） */
export function steer(sessionId: string, text: string): Promise<void> {
  return sendCommand('message.steer', { sessionId, content: text }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 追加 follow-up（当前回合结束后开新轮） */
export function followUp(sessionId: string, text: string): Promise<void> {
  return sendCommand('message.follow_up', { sessionId, content: text }, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 压缩上下文（#6：触发 runtime session.compact）。
 * runtime 生命周期推送：session.compacting（开始）→ session.compacted（完成/失败）。
 * 这些广播走 session 通道，由 useChat 的会话级订阅消费，驱动 store 的 isCompacting 状态。
 *
 * 超时 = COMPACT_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS（30min + 60s = 1860s，backstop）：
 * 校准链「renderer = runtime 第一刀 + 余量」（timeout-slow-flow-wallclock D3），双端引用
 * 同一 shared 常量编译期对齐——结构保证 renderer 恒不先于 runtime 判死（现状双端同值
 * 300s 零余量、renderer 因传输延迟恒先报错的竞态由此外科切除；65s 误杀大 session 前科同根）。
 */
export function compact(sessionId: string, customInstructions?: string): Promise<void> {
  return sendCommand('session.compact', { sessionId, customInstructions }, COMPACT_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS)
}

/** 中断当前回合（DEFERRED 流转，§9 G-025） */
export function abort(sessionId: string): Promise<void> {
  return sendCommand('message.abort', { sessionId }, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 直接执行 bash 命令（composer-bash-execute，不经 LLM turn）。
 *
 * `!`/`!!` 前缀输入的 shell 文本原样透传 pi bash RPC，结果经 message.bashStart/
 * message.bashResult 广播回对话流（不走 segment 提取 / segmentsToPrompt）。
 *
 * 超时 = BASH_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS（1h + 60s = 3660s，语义化取值，
 * timeout-slow-flow-wallclock D5）：校准链「renderer = runtime 第一刀（rpc-client
 * BASH_RPC_TIMEOUT_MS）+ 余量」，双端引用同一 shared 常量编译期对齐——结构保证默认
 * 配置下 renderer 恒不先于 runtime 判死，`!` 长命令（65s 存量误报 / 300s 前科）
 * 不再被 renderer backstop 误杀。不变量仅默认配置成立：env 逃生门
 * TAIJI_RUNTIME_BASH_RPC_TIMEOUT_MS 把 runtime 调成 >3660s 或 0（不限时）时，本 3660s
 * backstop 先到为失败 toast——已知接受（D5 不变量收窄）。
 *
 * excludeFromContext 为 undefined 时只传 {sessionId, command}（与 send 的 images 空数组
 * 归一模式对称，避免 runtime 收到无意义的 excludeFromContext:false 键）。
 */
export function bash(
  sessionId: string,
  command: string,
  excludeFromContext?: boolean,
): Promise<void> {
  return sendCommand(
    'message.bash',
    excludeFromContext !== undefined ? { sessionId, command, excludeFromContext } : { sessionId, command },
    BASH_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS,
  )
}

/** 取消进行中的 bash 执行（调 pi abort_bash） */
export function abortBash(sessionId: string): Promise<void> {
  return sendCommand('message.abortBash', { sessionId }, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 订阅指定 session 的流式消息事件，返回取消函数。
 * handler 收到分发联合形态的 ServerMessageUnion（type↔payload 配对由 ServerMessageMap 契约保证），
 * 调用方 switch on msg.type 即自动收窄 payload，无需 `as`。
 */
export function streamSubscribe(
  sessionId: string,
  handler: (msg: ServerMessageUnion) => void,
): () => void {
  // 类型边界转换（R1 type-safety S5）：events 层存储统一宽 ServerMessage（wire 入口
  // isServerMessage 守卫的下游），本域出口收窄为分发联合。二者是同一 wire 形状的两种 TS
  // 表达（值域相同），type↔payload 配对由 runtime 构造侧按 ServerMessageMap 契约构造 +
  // shared 登记静态校验保证——消费端从此不再散点 as payload。
  return events.on(sessionId, (msg) => handler(msg as ServerMessageUnion))
}
