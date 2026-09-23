// src/execution/engine/common/journal-replay.ts
//
// read 第②级（宿主 event journal 重放）的公共实现（P4，对齐点①接线）。设计决策
// （重放等价性）：journal 重放与 live 通路共用同一 reducer（updateFromEvent 范式），不引入第二套
// 解析器；conformance C5 断言重放 turns 与 live 一致。
//
// 为什么放 common：zcode/pi 的 read() ②级降级是同一段逻辑（replayJournal 拿事件流 →
// live reducer 累积 turns → 投影 SessionView）——放引擎各自实现会漂移出两份形状。

import type { AgentEvent } from "../../assembly/types.ts";
// 投影 + reducer 单源 SDK（本 PR 删除逐字同形的本地副本；core 引擎侧只留
// replayJournal I/O 与②级降级编排）。core AgentEvent/SessionView 是 SDK 契约
// 类型的 re-export（protocol contract-types SSOT）——签名逐字兼容。
import { eventsToSessionView as sdkEventsToSessionView } from "@zhushanwen/subagent-engine-sdk";
import type { EngineHandle, SessionView } from "../types.ts";
import { replayJournal } from "./event-journal.ts";

/**
 * journal → SessionView（read 第②级）。
 * 返回 undefined = ②级不可达（journal 路径缺省 / 文件不存在 / 无事件），调用方落 ③级。
 * coarse 引擎（zcode）journal 只含合成事件，重放退化为摘要级——D6 已声明的保真度
 * 下限，非缺陷。
 */
export function replayJournalToSessionView(
  handle: EngineHandle,
  engineId: string,
): SessionView | undefined {
  const journalPath = handle.data.journalPath;
  if (journalPath === undefined) return undefined;
  const events = replayJournal(journalPath);
  if (events.length === 0) return undefined;
  return eventsToSessionView(events, engineId, sessionIdFromHandle(handle));
}

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

/** handle.sessionRef 的 sessionId 提取（引擎自定义键，运行时 guard）。 */
function sessionIdFromHandle(handle: EngineHandle): string | undefined {
  const v = handle.data.sessionRef["sessionId"];
  return typeof v === "string" ? v : undefined;
}
