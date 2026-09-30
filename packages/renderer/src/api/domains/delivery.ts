/**
 * delivery 域门面（投递所有权内核 u3c 建，u5a 收编）——cancel/drain/resync 三 RPC 的
 * renderer 侧唯一入口，形态对齐 `@/api` 门面：构建期按 VITE_MOCK 切换 real / mock。
 *
 * 为什么独立于 `@/api` 门面三元：门面聚合的 `chat` 是 `isMock ? mockApi.chat : realChat`
 * 的联合类型，直取 union 成员在读侧可行但会把整域 chat 面暴露给调用方；本模块把
 * delivery 三方法收窄为 `DeliverySurface`，签名从 core real 域类型派生（`Pick` 派生 alias），
 * 漂移在编译期红。
 *
 * [u5a 收编] 前身 mock 轨分支（u3c 自建的三方法空响应对象）已删除：core mock
 * （`@taiji/core/transport/mock` 的 `chat`）已补齐 cancel/drain/resync，本模块回归纯切换
 * （real = core transport 域 / mock = core mock 域），与 `@/api` 的 `isMock ? mock : real`
 * 同款 DCE 形态（生产构建下 mock 分支随死分支摇除）。
 *
 * 消费方：composer 队列区（composables/panel/useQueueRows.ts）、forceQuit 编排
 * （composables/features/sidebar/useSidebarSessionActions.ts）。
 */
import * as realChat from '@taiji/core/transport/api/domains/chat'
import * as mockChat from '@taiji/core/transport/mock'

/**
 * 三方法的签名契约：直接从 core real 域类型派生（`Pick`）——签名漂移在编译期红，不复制字面量。
 */
export type DeliveryCancel = typeof realChat.cancelDelivery
export type DeliveryDrain = typeof realChat.drainDelivery
export type DeliveryResync = typeof realChat.resyncDelivery

export interface DeliverySurface {
  cancelDelivery: DeliveryCancel
  drainDelivery: DeliveryDrain
  resyncDelivery: DeliveryResync
}

const isMock = import.meta.env.VITE_MOCK === 'true'

/** delivery 域 RPC（构建期切换；生产构建下 mock 分支随死分支 DCE）。 */
export const delivery: DeliverySurface = isMock ? mockChat.chat : realChat
