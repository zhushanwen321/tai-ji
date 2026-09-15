// src/execution/engine/common/journal-replay.ts
//
// read 第②级（宿主 event journal 重放）的公共实现（P4，对齐点①接线）。设计权威源：
// docs/architecture/subagent-engine-abstraction.md D6 + §3.3.6「重放等价性」——
// journal 重放与 live 通路共用同一 reducer（updateFromEvent 范式），不引入第二套
// 解析器；conformance C5 断言重放 turns 与 live 一致。
//
// 为什么放 common：zcode/pi 的 read() ②级降级是同一段逻辑（replayJournal 拿事件流 →
// live reducer 累积 turns → 投影 SessionView）——放引擎各自实现会漂移出两份形状。

import { createRecord, updateFromEvent } from "../../persistence/execution-record.ts";
import type { AgentEvent } from "../../assembly/types.ts";
// aggregateUsage / toReplayedTurn 单源 SDK（自 session-view-projection.ts 逐字等价
// 迁入后收口——双活副本删除，live ≡ replay 的投影语义不再靠双份手工同步）。
import { aggregateUsage, toReplayedTurn } from "@zhushanwen/subagent-engine-sdk";
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

/** 事件流 → SessionView（live reducer 累积 turns——重放等价性的实现体）。 */
export function eventsToSessionView(
  events: readonly AgentEvent[],
  engineId: string,
  sessionId?: string,
): SessionView {
  const record = createRecord("journal-replay", {
    agent: "journal-replay",
    model: "",
    mode: "background",
    task: "",
    slug: "",
    startedAt: 0,
  });
  for (const ev of events) updateFromEvent(record, ev);
  return {
    engineId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    turns: record.turns.map(toReplayedTurn),
    usage: aggregateUsage(record.turns),
    source: "journal",
  };
}

/** handle.sessionRef 的 sessionId 提取（引擎自定义键，运行时 guard）。 */
function sessionIdFromHandle(handle: EngineHandle): string | undefined {
  const v = handle.data.sessionRef["sessionId"];
  return typeof v === "string" ? v : undefined;
}
