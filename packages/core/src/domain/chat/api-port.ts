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
import type { DeliveryFrameEntry, DeliverySubmitReply, DeliveryCancelReply, Message, Segment, SegmentsMetadataEntry, ServerMessageUnion, SessionRevokeMessageReply, BashDispatchReceipt } from '@taiji/shared'

// delivery DTO 具名类型（投递所有权内核 D5，u-contracts 契约）：shared 根入口已收编
// （u3a 落地），本文件 re-export 供域内消费方沿用既有 import 路径（./api-port）。
export type { DeliverySubmitReply, DeliveryFrameEntry, DeliveryCancelReply }

/**
 * chat 域后端操作端口。
 * 壳侧实现：renderer 现 api/domains/chat（函数集组装成对象注入）。
 */
export interface ChatApiPort {
  /**
   * 发送消息（message.send RPC）。
   *
   * [u5a 保留裁决] 成员**保留**，不随本单元删除：协议条目 `message.send` 是设计显式保留项
   * （runtime 侧适配器承接 plugin-service 等存量调用方，A6 测试锁），本成员是它在 chat 端口
   * 的镜像面。core 编排侧当前零调用（grep `deps.chatApi.send` 仅注释命中——send/steer/
   * followUp/editAndResend 四通路均已收敛 submitDelivery），壳侧 wiring 保留以维持端口与
   * 协议条目同构；协议条目删除时本成员同批删。
   *
   * options.clientUuid（session-occupancy-send-closure D2）：调用方乐观插入的 user message
   * id（`u-<uuid>`），经 RPC 参数透传（内核条目 id / 出站裸标记身份源）。可选参数，
   * 不传时 RPC payload 不带 clientUuid 键（向后兼容）。
   */
  send(sessionId: string, promptText: string, options?: { clientUuid?: string }): Promise<void>
  /**
   * 统一提交入口（delivery.submit，投递所有权内核 D1/D5）：乐观气泡后一律走本 RPC，
   * lane（direct/steer/queued）由 runtime 内核判定——renderer 只提交不判定。clientUuid =
   * 乐观气泡 id（appendUser 产物 `u-<uuid>`），内核条目 id + 出站裸标记身份源（D2）+
   * resync 判重锚（D5②）。reply 携带初始 lane/条目态（受理确认）；权威状态演进经
   * session.delivery 状态帧，不经过本返回值驱动 UI。
   * segments（MF-1-2 / ADR-0043）：富消息的原始段快照，随 payload 上网由 runtime 按
   * clientUuid 持有——cancel/drain 回草稿时随全文返回（chips 完整恢复的数据源）。
   */
  submitDelivery(
    sessionId: string,
    content: string,
    clientUuid: string,
    images?: Array<{ data: string; mimeType: string }>,
    segments?: Segment[],
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
  /**
   * 撤回已送达消息（session.revokeMessage RPC，消息撤回设计 D2/D8）。实现同样在 session 域，
   * 经本端口暴露给 chat 域撤回链路（useChat.revokeMessage 的已送达分支），与 subagentAction
   * 的跨域暴露同理。reply 判别字段 revoked；成功臂 content 含投递裸标记（剥标记/切条在
   * useChat 消费侧经 shared revoke-restore 处理）。
   */
  revokeMessage(sessionId: string, targetId: string): Promise<SessionRevokeMessageReply>
  /**
   * 撤回在途条目（delivery.cancel RPC，D6 统一入口的在途路由腿）。撤回入口（UserBubble）对
   * 内核投影 state 未 delivered 的消息路由到本 RPC（两段式收回：内核删除 + clear_queue 分拣），
   * 与队列气泡 × 撤销（useQueueRows.onCancelEntry）共用同一 runtime 管道、不同 UI 消费面。
   */
  cancelDelivery(sessionId: string, clientUuid: string): Promise<DeliveryCancelReply>
  // [u5a 退役] `steer` / `followUp` 端口成员已删除：u3b 统一 submit 化后 core 编排侧对
  // `deps.chatApi.steer` / `followUp` 零调用（grep 实测），chat 域客户端封装同批删除。
  /** 中断当前回合（message.abort）*/
  abort(sessionId: string): Promise<void>
  /** 压缩上下文（session.compact）*/
  compact(sessionId: string, customInstructions?: string): Promise<void>
  /**
   * 直接执行 bash 命令（message.bash，不经 LLM turn）。
   *
   * 返回 BashDispatchReceipt（RPC 回执携带执行状态，bash 投递可靠性契约）：
   * status 是「命令是否已执行」的权威判定——'started'/'settled' = 已执行（消费方不得
   * 恢复 `!command` 草稿，恢复后用户重发即命令双执行）；'rejected' = 未执行（恢复草稿
   * 安全）。回执不可达（断连 rejectAll / backstop 超时收不到 reply）时本方法 reject——
   * 此时命令可能已执行，消费方必须保守按已执行处置。
   */
  bash(sessionId: string, command: string, excludeFromContext: boolean): Promise<BashDispatchReceipt>
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
