export {
  type DeliveryIntent,
  type DeliveryPayload,
  type TextPayload,
  type CustomPayload,
  type DeliveryMessage,
  type DeliveryMeta,
  type DeliveryPort,
  type DeliveryConfig,
  type DeliveryHandle,
  type SendReceipt,
  // u-contracts（投递所有权内核契约根）：条目状态机/双视图
  type DeliveryLane,
  type DeliveryEntryState,
  type DeliveryEntry,
  // v3（统一消息投递内核，设计 §3.3/§3.5）：送达凭据三档 / 失败保留策略 /
  // DeliveryStore 持久化存储端口 / 终局记录（DeliveryTombstone 已退役）
  type DeliveryReceiptAnchor,
  type DeliveryFailurePolicy,
  type DeliveryProofCheck,
  type DeliveryStore,
  type DeliveryStoreRecord,
  type DeliveryTerminalRecord,
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

export {
  // v3 波 4（统一消息投递 §3.8 文本行）：磁盘 outbox——DeliveryStore 的 runtime 半区
  // 实现（fs 窄接口注入，本包零 node:fs import；目录/文件路径由 runtime 侧动态推导）
  createDiskDeliveryStore,
  type DiskDeliveryStore,
  type DiskDeliveryStoreDeps,
  type DiskStoreFs,
} from './disk-store.js'
