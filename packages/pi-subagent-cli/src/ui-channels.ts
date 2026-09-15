// src/ui-channels.ts
//
// UI channel 提取（marker 解析）的 re-export shim——实现体单源
// @zhushanwen/subagent-engine-sdk（pi → SDK 边界正向合法）。原自持副本（core
// src/execution/ui-channels.ts 逐字等价，W7 随 ui-request-queue 迁入时的过渡形态，
// W11 收口核对项）已随 round1-reuse R1 收编删除。导出面与原副本逐符号一致：
// parseChannel（ui-request-queue + 包 barrel）/ ParsedChannel（包 barrel）为既有
// 消费面，createUiChannelRegistry / ExtensionUiRequestLike 为本包测试消费面。

export {
  type ChannelHandler,
  createUiChannelRegistry,
  type ExtensionUiRequestLike,
  parseChannel,
  type ParsedChannel,
  type UiChannelRegistry,
} from "@zhushanwen/subagent-engine-sdk";
