// src/execution/ui/ui-channels.ts
//
// UI channel 提取（marker 解析）+ channel 注册表的 re-export shim：实现体单源
// @zhushanwen/subagent-engine-sdk（自本文件逐字等价移入 SDK，round1-reuse R1；
// core → SDK 边界正向合法）。core 内消费方（channel-registry-access /
// ui-request-handler-factory）import 路径保持不变，barrel 导出面零变化。

export {
  type ChannelHandler,
  createUiChannelRegistry,
  type ExtensionUiRequestLike,
  parseChannel,
  type ParsedChannel,
  type UiChannelRegistry,
} from "@zhushanwen/subagent-engine-sdk";
