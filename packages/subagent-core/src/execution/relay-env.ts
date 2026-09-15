// src/execution/relay-env.ts
//
// relay 通道 env 名与协议常量的 **semver 子入口载体**——单源在
// @zhushanwen/subagent-engine-sdk（round1-reuse R9 跨进程契约副本收编；core → SDK
// 边界正向合法）。
//
// [L5 收窄] 本文件不再是 core 内部或引擎包的消费路径：core 内消费方（stream-sink /
// d8-compat）与 pi-subagent-cli 已直连 SDK，pi 包的 relay-env shim 已删除。保留本
// 文件的唯一理由 = package.json exports 的 ./relay-env 子入口（semver 面：runtime 与
// subagent-workflow 经它消费，两包当前不依赖 SDK——删本文件须同时给两包加 SDK 依赖
// 并改 import specifier，属独立的依赖面变更，未随 L5 执行）。
// 代理脚本 relay.mjs 仍为内嵌镜像（零依赖脚本不能 import workspace 包），
// 镜像一致性由 conformance relay 变体断言锁定。

export {
  RELAY_ENV_SOCKET,
  RELAY_ENV_NODE,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_RECORD_ID,
  RELAY_PROTOCOL_VERSION,
  RELAY_EXIT_CODES,
  isRelayActive,
  readRelayForwardEnv,
} from "@zhushanwen/subagent-engine-sdk";
