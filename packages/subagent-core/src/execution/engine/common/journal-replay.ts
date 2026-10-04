// src/execution/engine/common/journal-replay.ts
//
// 事件流 → SessionView 投影的 core 侧薄包装（read 第②级 journal 重放的共用投影体）。
// 设计决策（重放等价性）：journal 重放与 live 通路共用同一 reducer（updateFromEvent
// 范式），不引入第二套解析器；conformance C5（contract.read-degradation.test.ts）
// 经本包装断言重放 turns 与 live 一致。
//
// 为什么放 common：zcode/pi 的 read() ②级降级共用同一段投影逻辑（事件流 → live
// reducer 累积 turns → 投影 SessionView）——放引擎各自实现会漂移出两份形状。journal
// 文件 I/O 与②级降级编排在各引擎包内（zcode journal-io.ts / pi read-fallback.ts），
// core 侧只留本投影包装。

import type { AgentEvent } from "../../assembly/types.ts";
// 投影 + reducer 单源 SDK（core 引擎侧不再持第二份容器字面量）。core AgentEvent/
// SessionView 是 SDK 契约类型的 re-export（protocol contract-types SSOT）——签名
// 逐字兼容。
import { eventsToSessionView as sdkEventsToSessionView } from "@zhushanwen/subagent-engine-sdk";
import type { SessionView } from "../types.ts";

/** 事件流 → SessionView（live reducer 累积 turns——重放等价性的实现体）。
 *
 * 委托 SDK 单源（eventsToSessionView 两侧逐字同形，core 侧副本已删）：reducer
 * 与 Turn → ReplayedTurn / usage 聚合均在 SDK，core 不再持第二份容器字面量。
 * 输出投影 {engineId, sessionId?, turns, usage, source:"journal"} 不变。 */
export function eventsToSessionView(
  events: readonly AgentEvent[],
  engineId: string,
  sessionId?: string,
): SessionView {
  return sdkEventsToSessionView(events, engineId, sessionId);
}
