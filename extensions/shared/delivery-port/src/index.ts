// src/index.ts
//
// @zhushanwen/pi-delivery-port 公共出口：统一消息投递服务的 pi 半区投递端口
// （custom 投递路径唯一执行者；设计 .tmp/tech-design/unified-delivery.md §3.7）。
//
// 装配形态（§3.7）：共享库（非 pi extension）+ 装配点 = @zhushanwen/pi-base-tool-
// enhance 的 session_start（infrastructure 档必载）。消费方（notifier / session-
// manager / bash）经 getDeliveryPort() 进程级槽获取实例（C-ext-06 惯例）。包依赖
// 分层：extensions 层消费方与本包同层直依（package.json dependencies 声明 +
// extension-dependencies.json 登记）；packages 层 subagent-core 受 D9 闭包红线
// 禁 import，经宿主壳注入槽访问器（notify-ports 转写类型）。

export {
  ACK_CUSTOM_TYPE,
  DEFAULT_NOTIFY_CUSTOM_TYPE,
  OUTBOX_CUSTOM_TYPE,
  V1_ACK_CUSTOM_TYPE,
  V1_OUTBOX_CUSTOM_TYPE,
  collectDeliveredIds,
  extractDeliveryIds,
  isPlainObject,
  mapV1OutboxData,
  readAckId,
  readOutboxDataV2,
  scanJournal,
  type AckEntryDataV1,
  type AckEntryDataV2,
  type JournalRecord,
  type JournalScan,
  type OutboxEntryDataV1,
  type OutboxEntryDataV2,
} from "./journal.ts";

export type {
  CollectSnapshot,
  CollectSnapshotEntry,
  CollectedEntry,
  DeliveryDeliverOptions,
  DeliveryDeliverResult,
  DeliveryEnvelope,
  DeliveryPortHandle,
  DeliveryPortLogger,
  DeliveryPortMetrics,
  DeliveryPortHost,
  DeliveryTiming,
} from "./types.ts";

export {
  _resetDeliveryPortForTest,
  bindDeliveryPort,
  DELIVERY_PORT_SLOT_KEY,
  createDeliveryPort,
  getDeliveryPort,
} from "./delivery-port.ts";

export { createPiDeliveryPortHost, type CreatePiDeliveryPortHostOptions } from "./pi-host.ts";
