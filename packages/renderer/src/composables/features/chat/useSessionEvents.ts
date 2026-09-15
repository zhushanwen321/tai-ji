/**
 * useSessionEvents —— session 通道订阅编排（R2 features 层）。
 *
 * 归位动机：SideDrawer / CommandPopover / ContextCapacityPopover 原本各自 import
 * @/api（extension）/ @/api/events 做会话级订阅。订阅编排（订阅时机、sessionId 切换重订、
 * 卸载退订）是跨组件重复的样板，且按 ADR「api 调用只在 features 层」铁律，@/api/events
 * 不应被组件层直接引用。本 composable 收口订阅生命周期，组件只声明「关心哪些 type + handler」。
 *
 * 范式对称 useChat.ensureStreamSubscription（会话级订阅 + 模块 Map 去重）：
 * - 会话级订阅：每个 composable 实例对当前 sessionId 持有一条底层 events.on 订阅，
 *   所有 onMessage 注册的 handler 经 type 路由表分发（而非每 onMessage 各开一条订阅）。
 * - 多实例安全：不同组件实例（split panel）各自调 useSessionEvents → 各持独立订阅与
 *   路由表，互不串扰（events 层 Set<MessageHandler> 对不同函数引用天然共存）。
 *
 * 职责边界：
 * - composable 只管订阅编排（订阅 / 重订 / 退订 / type 分发）。
 * - handler 逻辑（widget 缓冲、commandStore 写入、stats 更新）留在调用方（组件或其 composable）。
 *
 * 依赖方向：useSessionEvents → api/events（session 通道 on/off）。不依赖任何 store，
 * 保持通用（任意需要 session-scoped 订阅的组件均可复用）。
 */
import { onBeforeUnmount, watch, getCurrentInstance, type Ref } from 'vue'
import type { ServerMessage, ServerMessageType } from '@taiji/shared'
import * as events from '@taiji/core/transport/api'

/** 单 type 的窄化 handler（msg.type 已收窄为 T，payload 按 ServerMessageMap[T] 解析）
 *  第二参数 sid 是消息所属 session（订阅时捕获，不随当前 sid 变化），供 handler 调
 *  useSessionScopedState.updateFor(sid, ...) 写入「消息所属 sid」的分区，消除切 sid 时序竞态 */
type TypedHandler<T extends ServerMessageType> = (msg: ServerMessage<T>, sid: string) => void

/** 多 type 的宽 handler（msg.type ∈ types，但 payload 仍为联合宽类型，调用方按需窄断言）
 *  第二参数 sid 同 TypedHandler：消息所属 session（订阅时捕获） */
type MultiTypeHandler = (msg: ServerMessage, sid: string) => void

/** onMessage 重载签名：单 type → 窄 handler；多 type → 宽 handler */
export interface OnMessage {
  <T extends ServerMessageType>(type: T, handler: TypedHandler<T>): void
  (types: ServerMessageType[], handler: MultiTypeHandler): void
}

/** 单条 onMessage 注册记录：type 白名单 + 原始 handler */
interface Registration {
  /** 命中白名单（单 type 或多 type 数组，用 Set 做 O(1) 查询） */
  types: Set<ServerMessageType>
  /** 调用方注册的 handler（分发时透传匹配的 ServerMessage + 订阅时 sid） */
  handler: (msg: ServerMessage, sid: string) => void
}

/**
 * session 通道订阅编排。
 *
 * @param sessionIdRef session id 的 ref（string | null | undefined）。变化时自动重订（先退订旧、
 *   再订新），null/undefined 时不订阅。ref 可来自 props（组件 setup 内 toRef(props,'sessionId')）。
 * @returns onMessage —— 注册 type 过滤的 handler（见重载签名）。
 *
 * 用法：
 * ```ts
 * const onMessage = useSessionEvents(toRef(props, 'sessionId'))
 * onMessage('session.commands', (msg) => { /* msg.payload.commands *\/ })
 * onMessage(['context.update', 'session.state_changed'], (msg) => { /* msg.type ∈ 二者 *\/ })
 * ```
 *
 * 生命周期：watch(sessionIdRef, { immediate }) 触发首订 + 重订；onBeforeUnmount 退订。
 * 需在组件 setup 同步调用（内部用 getCurrentInstance 守卫 + 注册 onBeforeUnmount）。
 */
export function useSessionEvents(sessionIdRef: Ref<string | null | undefined>): OnMessage {
  // 守卫：必须在组件 setup 内调用（onBeforeUnmount / watch 需要 active instance）
  if (!getCurrentInstance()) {
    throw new Error('useSessionEvents 必须在组件 setup 同步阶段调用（依赖 onBeforeUnmount）')
  }

  /** 本实例的 type 分发路由表（onMessage 每次调用 push 一条；重订/卸载时整体复用，不丢注册） */
  const registrations: Registration[] = []

  /** 当前 sessionId 对应的底层退订函数（null=未订阅） */
  let unsub: (() => void) | null = null

  /**
   * 订阅指定 sid：开一条底层 events.on 订阅，msg 经路由表按 type 分发到所有命中 handler。
   * 单订阅 + 路由表分发（非每 onMessage 各开一条）：与 useChat.ensureStreamSubscription 同范式，
   * 一个 session 一条订阅，多 type 在路由表内分发，降低 events 层 Set 膨胀。
   */
  function subscribe(sid: string): void {
    // 幂等：已订阅同 sid 不重开（watch immediate + 同步多次触发时的保护）
    if (unsub) return
    // handler 闭包捕获订阅时 sid 参数，分发时透传给每个命中 handler。
    // 关键：即使 watch(sessionId) 的 flush:pre 异步退订窗口内有旧 sid 的迟到消息进入此 handler，
    // handler 传入的仍是「订阅时 sid」（本闭包的 sid 形参），调用方用此 sid 调 updateFor(sid)
    // 写入「消息所属 sid」分区，不污染新 sid 分区——从结构上消除 M1 竞态（ADR-0049）。
    unsub = events.on(sid, (msg) => {
      for (const reg of registrations) {
        if (reg.types.has(msg.type)) reg.handler(msg, sid)
      }
    })
  }

  /** 退订当前底层订阅（不动路由表：路由表跨 sid 重订复用，只在卸载时丢弃） */
  function unsubscribe(): void {
    unsub?.()
    unsub = null
  }

  /**
   * 注册 type 过滤的 handler。
   *
   * 单 type：handler 收到窄化后的 ServerMessage<T>（payload 按 ServerMessageMap[T] 精确收窄）。
   * 多 type：handler 收到宽 ServerMessage（type ∈ types，但 payload 仍为联合，调用方按需断言——
   *   因不同 type 的 payload 结构不同，无法静态收窄为单一类型）。
   *
   * 注册后若已订阅当前 sid，新 handler 立即对后续消息生效（路由表是引用，分发时实时遍历）。
   */
  const onMessage: OnMessage = (
    typeOrTypes: ServerMessageType | ServerMessageType[],
    handler: TypedHandler<ServerMessageType> | MultiTypeHandler,
  ): void => {
    const types = new Set(Array.isArray(typeOrTypes) ? typeOrTypes : [typeOrTypes])
    // 类型擦除说明：单 type 的 TypedHandler<T> 接收窄 ServerMessage<T>，但路由表统一存宽 handler。
    // 运行时分发只喂命中 type 的 msg（types.has(msg.type) 守卫）+ 订阅时 sid，调用方拿到的 msg.type
    // 必然 ∈ 白名单，故窄断言安全（与 events.onGlobalType 的 erased 模式同构）。
    registrations.push({ types, handler: handler as (msg: ServerMessage, sid: string) => void })
  }

  // 订阅生命周期：sessionId 变化先退订旧、再订新；null/undefined 仅退订不重订。
  watch(
    sessionIdRef,
    (sid) => {
      unsubscribe()
      if (sid) subscribe(sid)
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    unsubscribe()
    // 清空路由表，释放 handler 闭包引用（防组件卸载后仍被残留注册引用）
    registrations.length = 0
  })

  return onMessage
}
