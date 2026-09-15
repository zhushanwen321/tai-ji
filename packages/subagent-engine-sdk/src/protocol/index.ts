// src/protocol/index.ts
//
// 协议面 barrel（契约根公共出口）。W2 协议客户端（EngineClient/RemoteEngine）与
// 各引擎 CLI 包（W5/W7）从本入口消费帧型/方法/通道/错误码/契约类型/JSON Schema。

export * from "./engine-protocol.ts";
export * from "./frames.ts";
export * from "./methods.ts";
export * from "./reverse-channels.ts";
export * from "./error-codes.ts";
export * from "./contract-types.ts";
export * from "./schema.ts";
