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
  // u-contracts（投递所有权内核契约根，实施计划残留风险 #8 收编）：条目状态机/双视图/对账处置
  type DeliveryLane,
  type DeliveryEntryState,
  type DeliveryEntry,
  type DeliveryTombstone,
  type DeliveryEntriesFull,
  type DeliveryProjectionOptions,
  type DeliveryEntriesProjection,
  type ReconcileDisposition,
} from './types.js'

export {
  createDelivery,
  // u1 内核 v2 扩展类型（DeliveryHandleV2 为 DeliveryHandle 超集，既有消费者零改动）
  type DeliverySubmitOptions,
  type DeliveryHandleV2,
  type DeliveryCancelResult,
  type DrainResult,
  type DeliveryWarnSink,
  type DeliveryConfigWithWarn,
} from './delivery.js'
