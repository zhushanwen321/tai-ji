/**
 * 队列编辑锚定（chat-flow-consistency D6 + design-queue-delivery Q4 补章块 B）——
 * composer 草稿记住来源条目 id 的「单锚定不变式」纯逻辑，下沉 core 双壳同源
 *（桌面 composer-shell / 移动壳 QueueStrip 共用判定，防第三份定义漂移）。
 *
 * 职责边界：本模块只承载**判定逻辑**与锚定分区的值形状——分区持有归壳侧
 *（桌面 useSessionScopedState per-session 分区、移动壳 Map 分区 + registerSessionCleanup，
 * 各自的平台惯例），发送侧 delivery.edit 分流与 ✎ 预填编排也归壳层（RPC 出口在
 * transport 门面）。零 Vue 依赖（core composer 域 headless 纪律，orphan-draft 先例）。
 *
 * 锚定生命周期（Q4 裁决）：✎ 点击登记 → 编辑态提示条在场 → 解除路径四条——
 * 显式「放弃编辑」（草稿文本保留）/ 清空草稿 / 条目离场（session.delivery 帧派生
 * 活性失效，静默解除不发 toast）/ 发送完成（edit 回执到达）。切会话锚定随草稿分区
 * 存活、切回一并恢复；会话删除随分区清理。
 */

/** 锚定分区的值形状（per-session 一份；壳侧分区容器持有） */
export interface QueueEditAnchorPartition { // oe-exempt:20261024:framework:双壳同源契约（桌面 composer-shell + 移动壳 app-runtime 两消费方共用，判定逻辑单源）
  /** 锚定的来源条目 id（内核条目 id = 乐观气泡 id `u-<uuid>`）；null = 无编辑态 */
  clientUuid: string | null
}

/** ✎ 点击的登记结果（Q4 单锚定不变式三裁决） */
export type QueueEditStartOutcome =
  /** 锚定已登记（进入/保持编辑态，等待 peek 预填） */
  | 'started'
  /** 同一行再点 ✎：幂等 no-op——不重新 peek、不覆盖草稿（防误触清掉已改内容） */
  | 'already-editing-same'
  /** 编辑 A 中点 B 行：拦截——锚定不切换（切换需处理 A 草稿归属，用户两步达成同效：放弃 → 点 B） */
  | 'conflict'

/**
 * ✎ 点击登记（Q4 单锚定不变式）：
 * - 无锚定 → 登记返回 'started'；
 * - 同一行再点 → 'already-editing-same'（幂等 no-op）；
 * - 另一行 → 'conflict'（壳层提示「正在编辑另一条消息，请先放弃编辑」）。
 */
export function startQueueEdit(partition: QueueEditAnchorPartition, clientUuid: string): QueueEditStartOutcome {
  if (partition.clientUuid === clientUuid) return 'already-editing-same'
  if (partition.clientUuid !== null) return 'conflict'
  partition.clientUuid = clientUuid
  return 'started'
}

/** 解除锚定（放弃编辑 / 发送完成 / 条目离场 / 清空草稿共用单点）。 */
export function clearQueueEdit(partition: QueueEditAnchorPartition): void {
  partition.clientUuid = null
}

/**
 * 锚定活性判定（Q3 帧驱动离场信号）：锚定条目在 session.delivery 帧派生队列行中
 * （state ∈ {queued, in-flight, failed}——delivered 被谓词滤除、cancelled 不进帧，
 * 两者都归「离场」）。false = 条目已离场，壳层静默解除锚定 + 提示条消失（草稿保留，
 * 下次发送自然降级为普通新消息，不发 toast——发送时 edit 回执分类兜底）。
 * rows 入参 = 壳层既有派生队列行（core `deliveryQueueEntries` 产物），本函数不重复谓词。
 */
export function isQueueEditAlive(
  rows: ReadonlyArray<{ clientUuid: string }>,
  anchorClientUuid: string | null,
): boolean {
  if (anchorClientUuid === null) return false
  return rows.some((r) => r.clientUuid === anchorClientUuid)
}
