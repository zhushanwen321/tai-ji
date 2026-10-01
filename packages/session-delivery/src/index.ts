export {
  type DeliveryIntent,
  type DeliveryPayload,
  type TextPayload,
  type CustomPayload,
  type DeliveryMessage,
  type DeliveryPort,
  type DeliveryConfig,
  type DeliveryHandle,
  type SendReceipt,
  // u-contracts（投递所有权内核契约根）：条目状态机/双视图
  type DeliveryLane,
  type DeliveryEntryState,
  type DeliveryEntry,
  type DeliveryTombstone,
  type DeliveryEntriesFull,
  type DeliveryEntriesProjection,
} from './types.js'

export {
  createDelivery,
  // v2 内核扩展类型（DeliveryHandleV2 为 DeliveryHandle 超集，既有消费者零改动）
  type DeliverySubmitOptions,
  type DeliverySendResult,
  type DeliveryHandleV2,
  type DeliveryCancelResult,
  type DrainResult,
  type DeliveryWarnSink,
  type DeliveryConfigWithWarn,
} from './delivery.js'

export {
  // 用户回收错误类（D4-1）：cancel/drain 对挂起 waiter 的 reject，消费方 instanceof 判别
  DeliveryReclaimError,
} from './errors.js'
