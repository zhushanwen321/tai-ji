/**
 * queue-projection —— session.delivery 投影的队列条目谓词（投递所有权内核 D7 / remote-use U20 下沉）。
 *
 * 投影数据源 = `getDeliveryProjectionRef()`（state topic last-value 全量快照，本目录
 * effects/user-delivery 持有）；本文件承载其**过滤谓词**的单一定义点：
 *
 * `deliveryQueueEntries`（lane 判定，U20 自 renderer useQueueRows.ts 原样下沉——行为等价，
 * 桌面消费点已改引本导出）：
 * - lane ≠ 'direct'：direct 车道乐观气泡原位保留待确认（送达回执抵消 inflight 占位），
 *   不进队列区；
 * - state ≠ 'delivered'：已入 transcript（reducer 权威）的条目队列区隐去；
 * - queued / in-flight / failed 三态可见（排队中/投递中/重试耗尽），保持帧序
 *   （= 内核 FIFO 发送序）。
 *
 * 消费方（防第二定义点）：桌面 useQueueRows（composer 队列区行派生）+ ActivityStrip
 * （待发 chip 计数）+ 移动壳队列条（U10，随本谓词同源）。
 * 显示层折叠（failed 置顶恒可见 / +N 计数）属桌面 QueueBubble 展示序，不在本谓词
 * （不改帧序语义；移动壳展示形态独立，同样只消费帧序）。
 */
import type { DeliveryFrameEntry } from './api-port'

/**
 * 队列区条目过滤谓词（**唯一定义点**）：非 direct 车道且未 delivered 的内核条目，
 * 保持帧序（= 内核 FIFO 发送序）。
 */
export function deliveryQueueEntries(entries: readonly DeliveryFrameEntry[]): DeliveryFrameEntry[] {
  return entries.filter((e) => e.lane !== 'direct' && e.state !== 'delivered')
}
