/**
 * MessageBus 观测面（pull-push-architecture W0 / D7「发布/订阅侧结构化日志」）。
 *
 * 背景（R11/6c3）：个别 session 的 planState 广播消息全程零发布（真机多日观测），
 * 发布/订阅侧零日志——「消息没到」无法与「消息没发 / 没人订 / 连接不在线」区分，
 * 排障无入口。本模块补两类结构化观测：
 * - 订阅生命周期（subscribe / unsubscribe / unsubscribeAll / clearSession）逐事件
 *   info：6c3 类故障排障第一问「订阅建立时 stateSnapshot 里有没有 plan 帧」从此可检索；
 * - 投递失败（publish 完成写快照但无可送达的 live 连接）对 state 类落观测：
 *   GUI 投影五族（R11 域——state 类中投影链直接承载 GUI 状态的低频族，判据同
 *   PROJECTION_STATE_TYPES 头注；非「有快照 key 的全部类型」——occupancy/context/
 *   widget 等同样有快照 key 但属高频族，走限频）逐条 info；其余 state 类
 *   （occupancy / context / widget 等高频族）按 (sessionId, type) 滑窗限频——逐条会
 *   刷屏（后台 session 的 state 帧持续空投是设计内常态）。stream / transient 不观测：
 *   stream 空投由 ring 回放兜底（订阅时补）、transient 设计内可丢，观测它们只有噪声价值。
 *
 * 正常路径（有 live 订阅者且送达成功）零日志——pull-push S5「无日志噪声」锚。
 * 日志经显式 logger 只落 runtime 主日志文件、不刷终端（排障入口 =
 * `<dataDir>/logs/runtime-*.log`，grep '[bus-observe]'）。
 */
import { logger } from '../../infra/logger.js'

/**
 * GUI 状态投影五族白名单：state 类中「投影链直接承载 GUI 状态」的低频族（R11 域）。
 * 这些类型的投递失败逐条落观测（状态迁移级频率，不构成噪声）；其余 state 类型走限频。
 */
const PROJECTION_STATE_TYPES: ReadonlySet<string> = new Set([
  'session.planState',
  'session.subagents',
  'session.workflowUpdate',
  'btw.list',
  'session.commands',
])

/** 非投影族 state 空投的限频窗口（同一 (sessionId, type) 窗口内只落首条 + 聚合行）。 */
const DELIVER_DROP_WINDOW_MS = 60_000

/** 限频窗口态：上次落日志时刻 + 窗口内被抑制的空投数。 */
interface DeliverDropWindow {
  lastLoggedAt: number
  suppressed: number
}

/** per (sessionId, type) 限频窗口（session 销毁时随 clearBusObserveState 清理，键集有界）。 */
const deliverDropWindows = new Map<string, DeliverDropWindow>()

/**
 * 投递失败观测（publish 写完快照/ring 后发现无可送达 live 连接）。
 *
 * @param sessionId 目标 session
 * @param messageType 消息类型（域键）
 * @param subscribers 订阅者集合大小（区分「没人订」与「订了但不在线/发送失败」）
 * @param elapsedMs publish 入口到广播完成的耗时（S5 观测口径的耗时字段）
 */
export function observeDeliverDropped(sessionId: string, messageType: string, subscribers: number, elapsedMs: number): void {
  if (PROJECTION_STATE_TYPES.has(messageType)) {
    logger.info('[bus-observe] deliver-dropped', {
      sessionId,
      type: messageType,
      reason: subscribers === 0 ? 'no-subscriber' : 'undelivered',
      subscribers,
      elapsedMs,
    })
    return
  }
  const key = `${sessionId}\u0000${messageType}`
  const now = Date.now()
  const window = deliverDropWindows.get(key)
  if (!window || now - window.lastLoggedAt >= DELIVER_DROP_WINDOW_MS) {
    const suppressed = window?.suppressed ?? 0
    deliverDropWindows.set(key, { lastLoggedAt: now, suppressed: 0 })
    logger.info('[bus-observe] deliver-dropped', {
      sessionId,
      type: messageType,
      reason: subscribers === 0 ? 'no-subscriber' : 'undelivered',
      subscribers,
      elapsedMs,
      ...(suppressed > 0 ? { suppressedInLastWindow: suppressed } : {}),
    })
    return
  }
  window.suppressed += 1
}

/** 订阅建立观测：stateSnapshot 键集是「重连恢复面」的直接证据（6c3 排障第一问）。 */
export function observeSubscribe(sessionId: string, info: { stateKeys: string[]; ringSize: number; lastSeq: number; subscribers: number }): void {
  logger.info('[bus-observe] subscribe', { sessionId, ...info })
}

/** 单 session 退订观测（幂等 no-op 不落——只有真实移除才产生事件）。 */
export function observeUnsubscribe(sessionId: string, subscribersLeft: number): void {
  logger.info('[bus-observe] unsubscribe', { sessionId, subscribersLeft })
}

/** 连接断开批量退订观测（sids = 该连接此前订阅的全部 session）。 */
export function observeUnsubscribeAll(sessionIds: string[]): void {
  logger.info('[bus-observe] unsubscribe-all', { sessionCount: sessionIds.length, sessionIds })
}

/** session 状态整体清除观测（session 销毁时 bus 侧的落点事件）。 */
export function observeClearSession(sessionId: string, subscribersRemoved: number): void {
  logger.info('[bus-observe] clear-session', { sessionId, subscribersRemoved })
}

/** session 销毁时限频窗口清理（键集随 session 生命周期有界）。 */
export function clearBusObserveState(sessionId: string): void {
  const prefix = `${sessionId}\u0000`
  for (const key of deliverDropWindows.keys()) {
    if (key.startsWith(prefix)) deliverDropWindows.delete(key)
  }
}

/** 测试钩子：清空限频窗口（用例隔离；生产代码零消费）。 */
export function _resetBusObserveStateForTest(): void {
  deliverDropWindows.clear()
}
