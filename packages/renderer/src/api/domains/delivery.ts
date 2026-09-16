/**
 * delivery 域门面（投递所有权内核 u3c）——cancel/drain/resync 三 RPC 的 renderer 侧唯一入口。
 *
 * 为什么独立于 `@/api` 门面三元：
 * - 门面聚合的 `chat` 是 `isMock ? mockApi.chat : realChat`，其类型是两个对象类型的联合——
 *   访问仅一侧存在的成员即编译红（TS2339）。
 * - core mock（`@taiji/core/transport/mock`）当前只实现 `submitDelivery`（u3b 领地内补的
 *   「提交 → 快照帧 → 回执」三帧），cancel/drain/resync 三方法**未实现**。
 * - 直连 core real 域会绕过 `VITE_MOCK` 切换：mock 轨（dev `VITE_MOCK=true` / mock e2e）会
 *   对真实 WS 发 RPC，无 runtime 应答时挂 backstop 超时——比缺功能更糟。
 *
 * 故本模块显式分支：real 轨直连 core transport 真实 RPC；mock 轨给**协议合法的最小空响应**
 * （cancel → cancelled=false / drain → 空条目 / resync → 空去重集）——mock 轨无真实内核可
 * 操作（条目只由 submitDelivery 帧产生，无服务端收回语义），空响应不伪造投递事实：
 * - cancel 返回 cancelled=false → UI 提示「已投递不可撤」（§3.4 不可撤分支的合法文案），
 *   不谎报撤销成功、不产生「草稿凭空回填」的假象；
 * - drain 返回空条目 → forceQuit 回收提示 N=0 不显示（与「队列本就没有条目」同形）。
 *
 * 收编去向：core mock 补齐三方法（或 u5 协议退役阶段清扫）后，本分支退化为纯 re-export
 * （`export { cancelDelivery, drainDelivery, resyncDelivery } from ...`）。
 * 消费方：composer 队列区（composables/panel/useQueueRows.ts）、forceQuit 编排
 * （composables/features/sidebar/useSidebarSessionActions.ts）。
 */
import * as realChat from '@taiji/core/transport/api/domains/chat'

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

/** mock 轨最小实现（契约理由见文件头注；形态与 real 域同签名，编译期对齐）。 */
const mockDelivery: DeliverySurface = {
  async cancelDelivery(sessionId, clientUuid) {
    return { clientUuid, cancelled: false, reason: `mock: no kernel backing for ${sessionId}` }
  },
  async drainDelivery(sessionId) {
    return { sessionId, entries: [] }
  },
  async resyncDelivery(sessionId) {
    return { sessionId, deduped: [] }
  },
}

const isMock = import.meta.env.VITE_MOCK === 'true'

/** delivery 域 RPC（构建期切换；生产构建下 mock 分支随死分支 DCE）。 */
export const delivery: DeliverySurface = isMock ? mockDelivery : realChat
