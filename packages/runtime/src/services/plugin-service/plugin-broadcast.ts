/**
 * Plugin 广播出口族（plugin-header-action-modal-points u5a 附带拆分，max-lines 回落）。
 *
 * 从 plugin-service.ts 行为保持迁出的纯函数族（plugin-contributions.ts 同族先例：
 * 实现 = 纯函数 + deps 参数，实例状态经闭包/对象注入）。收敛的职责段 = PluginService
 * 的全部「插件面向前端」广播出口——同一优先级链（broadcastFn 优先 → broker.broadcast
 * 回退）+ messageBus 定向发布（wave:perf-w08/09 接口收敛语义）：
 *  - broadcastOrBrokerWith：通用广播原语（plugin:crashed / permissionRequest / statusChange
 *    / uiRequest 回退路径等全部经此）；
 *  - publishViewUpdateTo：views.update 定向发布（bus 装配 → publish；未装配 → 回退全局广播）；
 *  - createUiRequestBroadcastFn：UiRequestQueue 的广播回调装配（撤窗直发 global 通道 +
 *    payload 注入活跃 sessionId + uiRequest 的 bus 定向/回退双路径）。
 *
 * 动态状态（deps.broadcastFn / messageBus 晚期注入、activeSessionResolver 求值时点）一律
 * 经 getter 闭包注入——调用时求值，与原实例方法动态读 this.* 逐字等价。
 */
import type { IMessageBroker } from '../../interfaces.js'
import type { ServerMessageMap, ServerMessageType, ViewSnapshotItem } from '@taiji/shared'
// type-only：IMessageBus 不反向依赖 plugin-service，无运行时环（与 message-dispatcher 同款约束）
import type { IMessageBus } from '../message-bus/message-bus.js'
import type { UiBroadcastType } from './ui-request-queue.js'

/**
 * views.update 的广播 payload（provider-plugin-access U2 起 = shared ViewSnapshotItem
 * 单一来源：scope 二选一 + generation 全量替换代际，契约注释见该类型——广播帧与快照
 * 条目同构由类型引用构造性保证）。原手抄形状（sessionId 必填）已随分区键泛化退役。
 */
export type ViewUpdateBroadcastPayload = ViewSnapshotItem

/** 广播出口共享依赖（动态成员经 getter 注入，调用时求值——晚期注入语义保持）。 */
export interface PluginBroadcastDeps {
  /** renderer 上报的全局广播出口（组合根注入）；缺省回退 broker.broadcast。 */
  readonly broadcastFn?: (type: string, payload: unknown) => void
  readonly broker: IMessageBroker
  /** IMessageBus 晚期注入（setMessageBus），经 getter 每次调用动态读。 */
  readonly getMessageBus: () => IMessageBus | null
}

/**
 * 通用广播原语：broadcastFn 优先，否则回退 broker.broadcast（广播契约不变）。
 *
 * type/payload 经 ServerMessageMap 泛型关联（T 收窄到注册 type 集）：{ type, id,
 * payload } 构造即满足 ServerMessage<T>（窄→宽可赋），免 as 断言——payload 形状
 * 漂移在编译期被 shared 契约拦截，与下方 viewUpdate / uiRequest 两处免断言先例同款。
 */
export function broadcastOrBrokerWith<T extends ServerMessageType>(
  deps: PluginBroadcastDeps,
  type: T,
  id: string,
  payload: ServerMessageMap[T],
): void {
  if (deps.broadcastFn) {
    deps.broadcastFn(type, payload)
  } else {
    deps.broker.broadcast({ type, id, payload })
  }
}

/**
 * views.update 的广播出口（wave:perf-w08，02 文档 D1-1；U2 按 scope 形态分流通道）。
 *
 * 会话域（payload.sessionId）：bus 已装配 → publish 定向（plugin:viewUpdate 归
 * transient 类：高频 UI 流，不占 seq、不入 ring，直传订阅者——丢失可接受，
 * ExtensionHost 不靠 ring 回放重建状态），不再 broadcast；bus 未装配（测试构造）→
 * 回退全局广播，保持消息不丢。
 *
 * 全局域（payload.mountId，Provider 页等无会话挂载位）：无会话订阅通道可投——
 * 会话 bus.publish 落在无人订阅的键上等于静默丢帧，故恒走全局广播（broker/broadcastFn
 * 纯全局通道，payload 无 sessionId 不触发广播哨兵告警）；renderer 经 route-inbound
 * 全局通道 → bridge 归一 → ViewHostStore 全局域分区消费。
 */
export function publishViewUpdateTo(
  deps: PluginBroadcastDeps,
  payload: ViewUpdateBroadcastPayload,
  nextPushId: () => string,
): void {
  if (payload.sessionId !== undefined) {
    const messageBus = deps.getMessageBus()
    if (messageBus) {
      // m2/m3：'plugin:viewUpdate' 已是 ServerMessageMap 精确条目（payload 形状一致），
      // 免 as ServerMessage 断言；push id 改单调计数（Date.now() 同毫秒多视图更新会碰撞，
      // 前端按 id 去重/追踪场景下碰撞导致更新被误判重复）。
      messageBus.publish(payload.sessionId, {
        type: 'plugin:viewUpdate',
        id: nextPushId(),
        payload,
      })
      return
    }
    broadcastOrBrokerWith(deps, 'plugin:viewUpdate', nextPushId(), payload)
    return
  }
  // 全局域：恒全局广播（含 bus 未装配的会话域回退同出口——payload 无 sessionId 形态）
  broadcastOrBrokerWith(deps, 'plugin:viewUpdate', nextPushId(), payload)
}

/** UiRequestQueue 广播回调的动态依赖（求值时点见各成员注释）。 */
export interface UiRequestBroadcastDeps {
  /** MF-2：广播 payload 注入当前活跃 sessionId——resolve 时点求值（同一会话串行队列内稳定）。 */
  readonly resolveActiveSessionId: () => string | undefined
  /** IMessageBus 晚期注入，经 getter 每次调用动态读（m2 路径）。 */
  readonly getMessageBus: () => IMessageBus | null
  /** 回退路径 = PluginService.broadcastOrBroker（经绑定闭包注入，动态读 broadcastFn/broker）。
   *  签名与 broadcastOrBrokerWith 同步泛型化（type/payload 经 ServerMessageMap 关联）。 */
  readonly broadcastOrBroker: <T extends ServerMessageType>(type: T, id: string, payload: ServerMessageMap[T]) => void
}

/**
 * 装配 UiRequestQueue 的广播回调（原 plugin-service 构造器内联回调，行为保持迁出）。
 *
 * MF-2：payload 注入当前活跃 sessionId（前端 DialogRequestQueue/useExtensionUI 按
 * sessionId 分区消费，无 sid 的 uiRequest 会被双消费方丢弃，C2 检查），plugin dialog
 * 永不弹出。wave:perf-w08（02 文档 D1-1）：sid 为 string 且 bus 已装配 → bus.publish(sid)
 * 定向发布（plugin:uiRequest 归 stream 类，分配 seq + 入 ring 可回放），不再 broadcast；
 * sid undefined（无活跃 session 的弹窗仍须必达全部连接）或 bus 未装配 → 保持全局广播。
 * 撤窗广播不走 session 级 bus（D2 收尾修正，与 D3 permissionRequestExpired 直发形态对称）：
 * bus.publish(sid) 落 session 级帧 onGlobal 永不可达 → 撤窗生产常态失效，直发 global 通道。
 */
export function createUiRequestBroadcastFn(deps: UiRequestBroadcastDeps): (
  type: UiBroadcastType,
  payload: { requestId: string; pluginId: string } & Record<string, unknown>,
) => void {
  return (type, payload) => {
    if (type === 'plugin:uiRequestExpired') {
      const sid = deps.resolveActiveSessionId()
      deps.broadcastOrBroker(type, `ui_${payload.requestId}`, { ...payload, sessionId: sid })
      return
    }
    const sid = deps.resolveActiveSessionId()
    const fullPayload = { ...payload, sessionId: sid }
    const messageBus = deps.getMessageBus()
    if (sid !== undefined && messageBus) {
      // m2：'plugin:uiRequest' 已收录 ServerMessageMap 具名条目（requestId 必带 + 索引签名
      // 透传 dialog 字段），UiBroadcastFn payload 同步收紧——免 as ServerMessage 断言，
      // payload 形状漂移在编译期被 shared 契约拦截。
      messageBus.publish(sid, {
        type,
        id: `ui_${payload.requestId}`,
        payload: fullPayload,
      })
      return
    }
    deps.broadcastOrBroker(type, `ui_${payload.requestId}`, fullPayload)
  }
}
