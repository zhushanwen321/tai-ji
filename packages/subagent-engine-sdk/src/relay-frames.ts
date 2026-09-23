// src/relay-frames.ts
//
// subagent relay 通道帧词表 SSOT（kind / dir / reject reason）。与 relay-env.ts（env 名
// 与协议常量）同族——relay 通道跨进程契约的另一半：env 管激活与归属，帧管数据泵协议。
//
// 消费面：
// - runtime relay-registry（socket 服务端）import 本单源构造/比较帧——此前 16 处
//   字面量散布，协议演进时双侧改动的漂移只靠端到端行为测试兜底（失败信号离根因远）。
// - relay.mjs（零依赖代理脚本）不能 import workspace 包，内嵌字面量镜像——镜像
//   一致性由 conformance relay 变体断言锁定（同 env 常量先例，contract.relay.test.ts）。
//
// 词表成员语义（协议 v1，设计 §3.1）：
// - kind: handshake（代理→runtime 握手）→ accept / reject（runtime→代理协商应答）
//   → data（双向字节泵，b64 载荷）→ exit（child 终局，runtime→代理）。
// - dir（仅 data 帧）：down（runtime→代理→child stdin）/ up（child stdout→代理→
//   runtime）/ up-stderr（child stderr 同路）。
// - reject reason：version（协议不匹配）/ identity（归属键校验失败）/ duplicate
//   （同身份重复注册）/ malformed（非 JSON 或首帧非 handshake）。

/** 帧类型判别值（kind 字段词表）。as const 值即字面量类型——类型位置同样可用。 */
export const RELAY_FRAME_KINDS = {
  handshake: "handshake",
  accept: "accept",
  reject: "reject",
  data: "data",
  exit: "exit",
} as const;

/** 数据泵方向（data 帧 dir 字段词表）。 */
export const RELAY_FRAME_DIRS = {
  down: "down",
  up: "up",
  upStderr: "up-stderr",
} as const;

/** reject 帧 reason 词表（runtime→代理的拒绝理由；代理对 version 以退出码 10 应答）。 */
export const RELAY_REJECT_REASONS = {
  version: "version",
  identity: "identity",
  duplicate: "duplicate",
  malformed: "malformed",
} as const;

export type RelayFrameKind = (typeof RELAY_FRAME_KINDS)[keyof typeof RELAY_FRAME_KINDS];
export type RelayFrameDir = (typeof RELAY_FRAME_DIRS)[keyof typeof RELAY_FRAME_DIRS];
export type RelayRejectReason =
  (typeof RELAY_REJECT_REASONS)[keyof typeof RELAY_REJECT_REASONS];
