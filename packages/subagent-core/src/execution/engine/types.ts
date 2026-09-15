// src/execution/engine/types.ts
//
// 引擎中立类型层（P1）。设计权威源：docs/architecture/subagent-engine-abstraction.md
// §3.3.5（EnginePort 与中立类型完整契约）+ §3.3.6（EngineHandle/journal/SessionView 格式）。
//
// [S4 簇 3 收编] 契约类型单源化（type-only）：AgentOutcome / EngineHandleData /
// ReplayedTurn / SessionView / EngineCapabilities / ProbeReport 的本地定义已删除，
// 自 @zhushanwen/subagent-engine-sdk re-export（SDK protocol/contract-types.ts 是
// 类型闭包 SSOT，core 反向 re-export 保上层消费面——import 方路径零改动；结构等价
// 由 protocol-closure.test.ts 断言族守卫）。[H1 U5/U6] InteractAction / InteractResult
// 已随 chat 域 interact 面退役删除。
// EngineHandle 留守本地：SDK 无此类型（协议面用裸 data 载荷），宿主侧句柄包装接口
// 是 core 域概念。
//
// AgentResult 消歧（设计 §2.1/§3.3.5）：仓内有两个同名 AgentResult——
//   ① orchestration 层 workflow 消费的那份（orchestration/models/types.ts，主字段
//      content/parsedOutput/usage/error）——SDK AgentOutcome 锚定这份；
//   ② execution 层的同名类型（execution/types.ts，主字段 text/turns/sessionId/toolCalls）
//      ——record 内部投影，保持原名不动。
// 引擎层终态命名 AgentOutcome，与两者不同名，消除「同名不同义」。

import type { EngineHandleData } from "@zhushanwen/subagent-engine-sdk";

// AgentEvent 9 种事件：权威定义在 SDK contract-types，经 execution/types.ts re-export
// → shared/agent-event.ts 转发层 → 本文件（链条保持，维持「shared/ 是类型共享层」的
// 架构约定）。新增粗粒度约束（coarse 引擎至少合成一次 message_end + 一次 turn_end）
// 由 conformance 套件断言（P4），不在类型层编码。
export type { AgentEvent } from "../../shared/agent-event.ts";

// ============================================================
// SDK 契约类型 re-export（单源收编，S4 簇 3）
// ============================================================

export type {
  AgentOutcome,
  EngineCapabilities,
  EngineHandleData,
  ProbeReport,
  ReplayedTurn,
  SessionView,
} from "@zhushanwen/subagent-engine-sdk";

// ============================================================
// EngineHandle（run/read 两面的连接件，D1/§3.3.6）——core 域类型留宿主侧
// ============================================================

/**
 * 引擎会话句柄（run 返回、read 入参；[H1 U5/U6] interact 面退役后不再有 interact
 * 消费方）。
 *
 * 契约三条（D1）：不透明（上层不解构——唯一例外是 record 持久化层序列化 data 字段与
 * read 降级链）、可持久化（data 是纯 JSON，主会话 reload 后 read 仍可用）、自描述
 * （data 含 engineId + 引擎 session 定位符 + pool key + adapter 版本）。
 */
export interface EngineHandle {
  /** 持久化数据。上层不得解构其内部字段（见契约三条）。 */
  readonly data: EngineHandleData;
}
