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
  type DeliveryProjectionOptions,
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
