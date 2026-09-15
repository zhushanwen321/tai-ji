/**
 * 投影专用 bus 视图构建（自 session-service.ts getProjectionBusWithGenStatsTap 行为保持
 * 抽取）：wrapped 对象构建不依赖 Facade 状态，仅 bus 身份与 state_changed 后置 tap 两个
 * 参数——memoize（按 bus 身份缓存 wrapped）仍归 Facade（projectionBusView 字段）。
 *
 * 透传全部 IMessageBus 方法，仅在 publish session.state_changed 后同步触发写 2 tap
 * （重登记 + 推快照帧）。全 runtime 唯一 state_changed 生产点 = 投影的
 * publishStateChangedFromSnapshot（publish 前有同值 diff 抑制），故「bus 边界拦截该
 * type」≡「在 state_changed 广播处挂接」——不触碰 session-state-projection.ts 即可
 * 拿到真汇聚点（composer-gen-stats 设计 D4 写 2 挂接点的实装核实结论）。
 */
import type { IMessageBus } from '../message-bus/message-bus.js'

export function createProjectionBusView(
  bus: IMessageBus,
  onStateChanged: (sessionId: string, modelId: string) => void,
): IMessageBus {
  return {
    publish: (sessionId, message) => {
      // 固定帧序（MF9）：先原序发布（state_changed 同步送达订阅 ws），后置 tap
      bus.publish(sessionId, message)
      if (message.type === 'session.state_changed') {
        const modelId = (message.payload as { modelId?: unknown } | undefined)?.modelId
        if (typeof modelId === 'string' && modelId !== '') {
          onStateChanged(sessionId, modelId)
        }
      }
    },
    subscribe: (sid, ws) => bus.subscribe(sid, ws),
    unsubscribe: (sid, ws) => bus.unsubscribe(sid, ws),
    unsubscribeAll: (ws) => bus.unsubscribeAll(ws),
    clearSession: (sid) => bus.clearSession(sid),
  }
}
