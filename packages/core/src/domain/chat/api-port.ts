/**
 * ChatApiPort —— domain/chat 访问后端的唯一通道（IF6 契约）。
 *
 * 端口注入模式（对齐 domain/session/api-port.ts）：core 定义接口，壳层（renderer）
 * 把现 api/domains/chat 适配注入。core 不 import @/api。P1 完成后 api domains 迁
 * core/transport 时只需换注入实现，domain 侧零改动。
 *
 * 契约边界：方法签名严格对齐 core/transport/api/domains/chat.ts 导出函数
 * （send/steer/followUp/abort/compact/bash/abortBash/getHistory/streamSubscribe）。
 * [u6] getFullHistory 已随全量通路退役（「加载更早」改走 getHistory 游标翻页）。
 * getHistory 返回类型用内联结构（{ messages; truncated; loadedTurns; totalTurnsEstimate }），
 * 不依赖 chat 域的 HistoryResult（保持 core 平台无关）。
 */
import type { Message, SegmentsMetadataEntry, ServerMessageMap, ServerMessageUnion } from '@taiji/shared'

/**
 * delivery DTO 的结构派生别名（投递所有权内核 D5，u-contracts 契约）。
 *
 * 为什么派生而非命名 import：u-contracts 新类型暂不可经 shared 根入口命名 import
 * （根入口为显式白名单 re-export——实施计划残留风险 #8，收编动作归属 u3a 领地）；
 * deep import 被 shared exports map 挡。ServerMessageMap 已导出且含全部 delivery 键，
 * 索引派生与源类型零漂移（u3a 收编白名单后可换回直接命名 import）。
 */
export type DeliverySubmitReply = ServerMessageMap['delivery.submit']
/** session.delivery 帧条目（D5）：{clientUuid, preview, state, lane}。 */
export type DeliveryFrameEntry = ServerMessageMap['session.delivery']['entries'][number]

/**
 * chat 域后端操作端口。
 * 壳侧实现：renderer 现 api/domains/chat（函数集组装成对象注入）。
 */
export interface ChatApiPort {
  /**
   * 发送消息（message.send RPC）。
   *
   * options.clientUuid（session-occupancy-send-closure D2）：调用方乐观插入的 user message
   * id（`u-<uuid>`），经 RPC 参数透传，runtime 拒绝时在 send.rejected 广播原样带回——
   * renderer 兜底 handler 据此消歧发送来源（flush 重放的拒绝不重入队）。可选参数，
   * 不传时 RPC payload 不带 clientUuid 键（向后兼容）。
   */
  send(sessionId: string, promptText: string, options?: { clientUuid?: string }): Promise<void>
  /**
   * 统一提交入口（delivery.submit，投递所有权内核 D1/D5）：乐观气泡后一律走本 RPC，
   * lane（direct/steer/queued）由 runtime 内核判定——renderer 只提交不判定。clientUuid =
   * 乐观气泡 id（appendUser 产物 `u-<uuid>`），内核条目 id + 出站裸标记身份源（D2）+
   * resync 判重锚（D5②）。reply 携带初始 lane/条目态（受理确认）；权威状态演进经
   * session.delivery 状态帧，不经过本返回值驱动 UI。旧 send 保留至 u5 协议退役。
   */
  submitDelivery(
    sessionId: string,
    content: string,
    clientUuid: string,
    images?: Array<{ data: string; mimeType: string }>,
  ): Promise<DeliverySubmitReply>
  /**
   * subagent 定向消息 / 生命周期操作（session.subagentAction RPC，composer 四符号 `@` 发送分流）。
   * 契约对齐 renderer api/domains/session.subagentAction（U5 扩签名）：action='message' 带
   * subagentId+text（已开 subagent 追问），'start' 带 slug+task（新建占位 chip），'cancel' 本域
   * 不消费（stores/subagent.ts 直调，此处不省略联合成员以保持 wire 协议单点）。
   * 实现在 session 域（语义归属 session.subagentAction），经本端口暴露给 chat 域发送链路
   * （useChat 分流点），与 writeSegments 的跨域注入同理。
   */
  subagentAction(
    sessionId: string,
    action: 'cancel' | 'message' | 'start',
    params: { subagentId?: string; text?: string; slug?: string; task?: string },
  ): Promise<void>
  /** 追加 steer（message.steer，AI 执行中追加上下文）*/
  steer(sessionId: string, promptText: string): Promise<void>
  /** 追加 follow-up（message.follow_up，当前回合结束后另起一轮）*/
  followUp(sessionId: string, promptText: string): Promise<void>
  /** 中断当前回合（message.abort）*/
  abort(sessionId: string): Promise<void>
  /** 压缩上下文（session.compact）*/
  compact(sessionId: string, customInstructions?: string): Promise<void>
  /** 直接执行 bash 命令（message.bash，不经 LLM turn）*/
  bash(sessionId: string, command: string, excludeFromContext: boolean): Promise<void>
  /** 取消进行中的 bash（message.abortBash）*/
  abortBash(sessionId: string): Promise<void>
  /**
   * 拉取 session 历史（session.history，u4b 双预算窗口可能截断）。
   * [u6] query 可选（crash-resilience §3.3 D4 中期分页协议）：带 cursor 时为「加载更早」
   * 游标翻页（返回锚点之前的最近窗口；cursor 未命中返回空页 + truncated=false）；
   * 缺省 = 最近窗口。窗口契约字段 truncated/loadedTurns/totalTurnsEstimate 必填
   * （[u6] legacy historyTruncated 已退役，偏差表 D7 双轨收口——mock 门面同契约）。
   */
  getHistory(sessionId: string, query?: { cursor?: string; limitTurns?: number; maxBytes?: number }): Promise<{
    messages: Message[]
    truncated: boolean
    loadedTurns: number
    totalTurnsEstimate: number
  }>
  /** 订阅指定 session 的流式消息事件，返回取消函数。
   *  handler 收分发联合形态的 ServerMessageUnion——switch on msg.type 自动收窄 payload，
   *  ServerMessageMap 登记缺口变编译错误（R1 type-safety S4/S5，消费侧不再 as）。*/
  streamSubscribe(sessionId: string, handler: (msg: ServerMessageUnion) => void): () => void
}

/**
 * 写 segments.json sidecar（session.writeSegments RPC）。
 *
 * 独立于 ChatApiPort：writeSegments 语义属 session 域（session.writeSegments RPC），
 * useChat 只是消费者。独立类型避免塞进 ChatApiPort 造成域语义混淆。壳侧实现：
 * renderer api/domains/session.writeSegments。
 * [defer segments 化] entry 类型改用 shared SegmentsMetadataEntry（原内联结构）——
 * defer flush 链条目写 deferEntryId（无 clientUuid），直发链仍写 clientUuid。
 */
export type WriteSegmentsFn = (payload: {
  sessionId: string
  entry: SegmentsMetadataEntry
}) => Promise<void>
