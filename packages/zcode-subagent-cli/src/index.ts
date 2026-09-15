// src/index.ts
//
// @zhushanwen/zcode-subagent-cli 主 barrel。只导出引擎面公共符号（引擎子集）：
// 协议服务器 + ZcodeEngine 构造面 + 契约根常量。deep module（connection/
// session-channel 等）不经 barrel 暴露——消费方（W10 conformance / smoke-core-dist
// 改造）按需 import 子路径。

export { EngineProtocolServer, type EngineProtocolServerOptions } from "./server.ts";
export {
  ZCODE_ADAPTER_VERSION,
  ZCODE_ENGINE_ID,
  ZcodeEngine,
  createDefaultZcodeEngine,
  createZcodeEngine,
  defaultEngineDataDir,
  type ZcodeEngineDeps,
} from "./registration.ts";
export { zcodeSessionDbPath, zcodeDbPathAllowlist, hostZcodeDbPath } from "./db-path.ts";
export { readZcodeSessionView } from "./reader.ts";
// golden 帧序列内嵌副本（采集 SSOT = src/__golden__/zcode-golden-appserver.json，
// 双副本 diff 防漂移）——core conformance golden-replay 消费此导出面（W10）。
export { ZCODE_APPSERVER_GOLDEN } from "./golden-sample.ts";
