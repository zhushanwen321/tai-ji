// src/protocol/reverse-channels.ts
//
// 6 反向通道（引擎 → core，帧④，必须应答）载荷与超时二分。设计权威源：
// 设计 §3.3 方法集表 host/* 行 + impl-plan §2.1「8 反向通道」与「反向请求超时二分」。
// [H1] chat 域 v1.x 增量曾新增的第 9 通道（轮次相位帧）已随 chat-run 统一退役
// （docs/architecture/subagent-chat-run-unification.md §3.3 D5，U5 删除）——轮次终态
// 改由 run 应答（agent_settled resolve）承载。
// [池抽象降级 2026-09-13] 原 host/poolResolved 通道（第 8 条）随 poolKey 协议面退役
// 一并删除（两引擎 poolKey 恒 'shared'、journal 落盘路径固定，回调零信息量）。
// [permission 通道退役 2026-09-13] host/permission 骨架删除（两引擎 permissionMode=
// native 零 emit、core 零注入——未接线死通道），通道集收敛为 6 个。
//
// 应答约定：数据面类回 {ok:true}（REVERSE_REQUEST_TIMEOUT_MS=10s 未答 = 引擎故障 →
// 杀进程 + 在途 run 失败）；人机交互类走 ack 两阶段——先回 {ack:true}，结果异步到达
// （R9-2：已 ack 的等待不计入任何 in-flight 超时；ADR-0047 静默 ≠ 卡死）；
// 未实现的交互能力回 {unsupported:true}（引擎自行降级，不重试）。

import type { ReverseRequestTimeoutClass } from "./engine-protocol.ts";
import type { UiRequest, UiResponse } from "../ui-types.ts";

/**
 * 反向通道名联合（恰好 6 个；REVERSE_CHANNELS 常量数组与之同源互证）。
 */
export type ReverseChannel =
  | "host/log"
  | "host/askUser"
  | "host/streamDelta"
  | "host/handleReady"
  | "host/childSpawned"
  | "host/childStateChanged";

/**
 * 通道名全集（运行时顺序化枚举；与 ReverseChannel 的同源关系由测试断言）。
 */
export const REVERSE_CHANNELS = [
  "host/log",
  "host/askUser",
  "host/streamDelta",
  "host/handleReady",
  "host/childSpawned",
  "host/childStateChanged",
] as const satisfies readonly ReverseChannel[];

/**
 * 超时二分归属（10s 数据面 / 不设统一超时的人机交互面）。实现归 W2 EngineClient；
 * 引擎侧自灭计时（W12）复用同表——已 ack 的 askUser 等待不计入 in-flight（R9-2）。
 */
export const REVERSE_CHANNEL_TIMEOUT_CLASS: Record<ReverseChannel, ReverseRequestTimeoutClass> = {
  "host/log": "data-plane",
  "host/streamDelta": "data-plane",
  "host/handleReady": "data-plane",
  "host/childSpawned": "data-plane",
  "host/childStateChanged": "data-plane",
  "host/askUser": "interaction",
};

// ============================================================
// 通道载荷（params）
// ============================================================

/** host/log：引擎日志落宿主日志（对齐 core HostServices.log 调用面）。 */
export interface HostLogParams {
  level: "debug" | "warn" | "error";
  component: string;
  message: string;
  data?: unknown;
}

/** host/askUser：UI 请求经反向通道送达宿主（core 壳侧 uiRequestHandler 应答）。 */
export interface HostAskUserParams {
  runId: string;
  /** Pi extension_ui_request 平铺形态（类型 SSOT = SDK ui-types.ts，core 反向 re-export）。 */
  request: UiRequest;
}

/** host/askUser 的最终结果（ack 两阶段第二阶段，异步应答帧②的 result）。 */
export type HostAskUserResult = UiResponse;

/**
 * host/streamDelta：UI 实时通道（双通道之一；与 event 通知并行的渲染加速面）。
 *
 * 关联键恒为 runId（runId 由 core 在 run 帧分配）；[H1] chat 续聊轮经 resume run
 * 复用 runId 关联（原 recordId 关联键随 interact 面退役删除）。
 */
export interface HostStreamDeltaParams {
  runId: string;
  delta: string;
}

/**
 * host/handleReady：运行中句柄回填（core onHandleReady 语义：session/create 应答后、
 * 早于 run resolve；AGENTS.md 关键规则 9「重开 session 仍可见」的前提）。
 * [池抽象降级 2026-09-13] 原 poolKey 字段已随协议面 poolKey 退役删除。
 */
export interface HostHandleReadyParams {
  runId: string;
  sessionRef: Record<string, string>;
}

/**
 * host/childSpawned：引擎内一次性子进程 pid 上报。
 * 用途 = isResumable 镜像谓词 + 诊断留痕；**不供杀链/收割**（v6 已删按 pid 补杀，
 * 收割只靠进程组）；常驻进程不报（归 dispose）。
 */
export interface HostChildSpawnedParams {
  pid: number;
  recordId: string;
}

/**
 * host/childStateChanged：childSpawned 的状态面（core 侧镜像数据源，
 * hasLiveProcessHandle/isResumable 同步读镜像，不跨进程查询）。
 * **killed 必含**（判据 `child !== undefined && !child.killed`）——类型层 required。
 */
export interface HostChildStateChangedParams {
  pid: number;
  recordId: string;
  state: "running" | "exited";
  /** 必含：true = 已被杀/已终止（镜像置死判据）。 */
  killed: boolean;
  exitCode?: number;
  signal?: string;
}
