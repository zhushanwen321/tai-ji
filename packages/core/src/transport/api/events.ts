/**
 * Events 层 —— ServerMessage 订阅分发。
 *
 * 三条独立通道：
 * - session 通道（on/off/dispatchSession）：按 sessionId 路由。CLAUDE.md line 98
 *   要求 session 级消息必须含 sessionId。隔离规则不变。
 * - global 通道（onGlobal/onGlobalType/dispatchGlobal）：无 sessionId 的 server-push
 *   （config.providers / model.list / config.skills / config.agents / config.plugins /
 *   config.extensions / config.defaults）。sendInitialState 推 7 条 + 运行时广播。
 * - crossSession 通道（onCrossSession/dispatchCrossSession）：带 sessionId 但需同时分发到
 *   全局单例消费者的消息（ADR-0060）。合法消费者仅 ExtensionHost（+ 未来远程化协同态），
 *   per-session 消费用 on(sid, handler)，不要用本通道。
 *
 * 三通道互不串扰。route-inbound（coordination/route-inbound.ts）按 payload.sessionId 有无
 * + ROUTE_TABLE 条目声明决定走哪条（有 sid → session 通道；有 sid 且条目 crossSession 字段
 * 声明 → 额外 crossSession；无 sid → global 通道）。
 */
import type { ServerMessage, ServerMessageType } from '@xyz-agent/shared'

/** ServerMessage 订阅 handler 签名（on/off/onGlobal/onCrossSession 的公开参数类型）。 */
export type MessageHandler = (msg: ServerMessage) => void

/**
 * 安全遍历 handler 集合（M4：单 handler 抛错不中断同通道剩余订阅者）。
 *
 * sidebar 有 6+ 组件实例化 useSidebar，一个坏 handler 会让整条 session.list 广播中断。
 * 每个 handler 调用包 try-catch，抛错时 console.error 记录后继续遍历。
 */
function safeForEach(set: Set<MessageHandler>, msg: ServerMessage): void {
  for (const h of set) {
    try {
      h(msg)
    // eslint-disable-next-line taste/no-silent-catch -- 事件分发器隔离：单 handler 抛错不中断同通道其余订阅者（M4），console.error 记录后继续遍历
    } catch (e) {
      console.error('[events] handler threw, continuing dispatch:', e)
    }
  }
}

// ── session 通道（按 sessionId 路由）──
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：事件总线 session 通道 handler 注册表，非 GUI 数据
const sessionHandlers = new Map<string, Set<MessageHandler>>()

/** 按 sessionId 订阅 ServerMessage，返回取消函数 */
export function on(sessionId: string, handler: MessageHandler): () => void {
  let set = sessionHandlers.get(sessionId)
  if (!set) {
    set = new Set()
    sessionHandlers.set(sessionId, set)
  }
  set.add(handler)
  return () => off(sessionId, handler)
}

/** 取消订阅（按 sessionId + handler） */
export function off(sessionId: string, handler: MessageHandler): void {
  const set = sessionHandlers.get(sessionId)
  if (!set) return
  set.delete(handler)
  // [B2 / 2026-09-14 内存审计 §2.3] 删空 Set 时移除 Map 条目：off 是唯一删除点，此前每个
  // 订阅过的 session/虚拟 id 留一个空 Set（~100B）永久残留。dispatchSession 对无条目 get
  // 安全跳过、on 会重建——语义不变（全仓无 keys 遍历消费方，三审核实）。
  if (set.size === 0) {
    sessionHandlers.delete(sessionId)
    // [memory-probe] 实施期探针（memory-leak-remediation 验收门，A 系列验收后降级 debug 级）：
    // A3 场景删除 session 后读取本行断言 sessionHandlers 无该 sid 残留条目（含空 Set）。
    console.log(`[memory-probe] off removed empty sessionHandlers entry sid=${sessionId}, mapSize=${sessionHandlers.size}`)
  }
}

export function dispatchSession(sessionId: string, msg: ServerMessage): void {
  const set = sessionHandlers.get(sessionId)
  if (set) safeForEach(set, msg)
}

// ── global 通道（无 sessionId 的 server-push）──
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：全局 all-handler 注册表，非 GUI 数据
const globalAllHandlers = new Set<MessageHandler>()
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：全局 type 通道 handler 注册表，非 GUI 数据
const globalTypeHandlers = new Map<string, Set<MessageHandler>>()

/** 订阅所有全局 ServerMessage（不区分 type），返回取消函数 */
export function onGlobal(handler: MessageHandler): () => void {
  globalAllHandlers.add(handler)
  return () => {
    globalAllHandlers.delete(handler)
  }
}

/**
 * 订阅指定 type 的全局 ServerMessage，返回取消函数。
 *
 * 泛型化：传入精确 type（如 'config.providers'）时，handler 内 msg 自动收窄为
 * ServerMessage<'config.providers'>，msg.payload 即 `{ providers: ProviderInfo[] }`，
 * 无需 `as` 断言。存储层仍是宽 MessageHandler（类型擦除），运行时按 type 路由。
 */
export function onGlobalType<T extends ServerMessageType>(
  type: T,
  handler: (msg: ServerMessage<T>) => void,
): () => void {
  // 存储层类型擦除：Set 只存「能处理任意 ServerMessage 的函数」，TS 不允许 (msg: Specific)→void
  // 直接赋给 (msg: Wide)→void，故用 as 做受控擦除。运行时 dispatchGlobal 只会喂同 type 的 msg。
  const erased = handler as MessageHandler
  let set = globalTypeHandlers.get(type)
  if (!set) {
    set = new Set()
    globalTypeHandlers.set(type, set)
  }
  set.add(erased)
  return () => {
    globalTypeHandlers.get(type)?.delete(erased)
  }
}

export function dispatchGlobal(msg: ServerMessage): void {
  safeForEach(globalAllHandlers, msg)
  const typeSet = globalTypeHandlers.get(msg.type)
  if (typeSet) safeForEach(typeSet, msg)
}

// ── crossSession 通道（带 sid 消息的全局消费者订阅，ADR-0060）──
// 语义：允许全局单例消费者（ExtensionHost）接收带 sessionId 的消息——routeInbound 用
// payload.sessionId 路由，有 sid 的下行（extension:widget/notify 等）走 dispatchSession 不
// 触发 onGlobal，全局消费者经本通道才能收到。**这不是广播**：合法消费者仅 ExtensionHost
// （+ 未来远程化协同态 busy/idle/presence），per-session 消费用 on(sid, handler)。
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：跨 session 通道 handler 注册表，非 GUI 数据
const crossSessionHandlers = new Set<MessageHandler>()

/** 订阅 crossSession 通道（全局消费者接收带 sid 消息），返回取消函数。ADR-0060。 */
export function onCrossSession(handler: MessageHandler): () => void {
  crossSessionHandlers.add(handler)
  return () => {
    crossSessionHandlers.delete(handler)
  }
}

/** 分发消息到 crossSession 通道（route-inbound dispatchRouted 有 sid 序言的 crossSession 声明分支调用）。ADR-0060。 */
export function dispatchCrossSession(msg: ServerMessage): void {
  if (crossSessionHandlers.size > 0) safeForEach(crossSessionHandlers, msg)
}

// ── 实施期内存探针（memory-leak-remediation 验收门；A 系列验收后降级/移除，非业务 API）──
// A3（sessionHandlers 无残留条目）/ A4（断连重连后 'app.info' handler 数恒 1）的机器可断言
// 信号源：dev 实例日志/控制台读取；单测经 before/after delta 断言 Map 无残留（B2）。

/** session 通道 Map 条目数（含空 Set 残留检测；B2/A3 探针） */
export function _probeSessionHandlerEntryCount(): number {
  return sessionHandlers.size
}

/** global type 通道指定 type 的 handler 数（A4 断言 'app.info' 恒 1） */
export function _probeGlobalTypeHandlerCount(type: string): number {
  return globalTypeHandlers.get(type)?.size ?? 0
}
