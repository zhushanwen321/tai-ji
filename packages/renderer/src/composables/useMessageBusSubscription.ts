/**
 * useMessageBusSubscription —— re-export shim（wave:renderer-rebuild-v2 W2）。
 *
 * SSOT 已迁入 @taiji/core（core/coordination/subscription-state.ts，w1 落地）。
 * 本文件仅作转发面：消费方（useChat.ts / useConnection.ts / 测试）import 语句零改动，
 * 签名与行为等价由 core 单测（packages/core/src/coordination/subscription-state.test.ts）覆盖。
 *
 * 不转发 setSubscriptionPorts：该函数是 core 内部注入点（由 configureRouteInbound 触发
 * setSubscriptionPorts(ports)），renderer 业务代码不直接调用。useConnection.ensureDispatcher
 * 调 configureRouteInbound 时会顺带完成端口注入。
 *
 * 渐进迁移（T2）：gap 检测只对「已 subscribe（state 存在且 subscribed=true）」的 session 生效，
 * 未 subscribe 的 session 不做 gap 检测，正常 dispatch（兼容路径，remove-bandaids wave 统一）。
 */
export {
  subscribeSession,
  getSubscriptionState,
  clearSubscription,
  updateLastSeenSeq,
  resetSubscriptionStates,
} from '@taiji/core'

export type { SubscriptionState } from '@taiji/core'
