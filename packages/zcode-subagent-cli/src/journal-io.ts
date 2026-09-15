// src/journal-io.ts
//
// read 第②级（journal 重放）的引擎包承接：journal 文件读取（replayJournal，SDK
// 单源）+ replayJournalToSessionView 编排。reducer 本体（eventsToSessionView /
// updateFromEvent / toReplayedTurn / aggregateUsage）用 SDK journal-replay——
// 与 core live reducer 同源（W1 已把纯投影部分下沉 SDK，见 SDK 该文件头注）。
//
// replayJournal/parseLine 原自持副本已收编 SDK journal-io（S4 簇 6：引擎包不能
// import core，core 与本包的逐字等价副本单源落 SDK——原头注「引擎包进程内无
// core 故自持解析」的自持理由随 SDK 落点消解，改为登记 SDK 单源）。JournalLine
// v1 行格式（{v,ts,taskId,engineId,seq,event}）、seq 排序、坏行跳过语义不变，
// 格式漂移面由 W10 golden 往返测试覆盖。

export { replayJournal } from "@zhushanwen/subagent-engine-sdk";

import {
  eventsToSessionView,
  replayJournal,
  sessionIdFromHandle,
  type EngineHandleData,
} from "@zhushanwen/subagent-engine-sdk";

/**
 * journal → SessionView（read 第②级）。
 * 返回 undefined = ②级不可达（journal 路径缺省 / 文件不存在 / 无事件），调用方落 ③级。
 */
export function replayJournalToSessionView(handle: { data: EngineHandleData }, engineId: string) {
  const journalPath = handle.data.journalPath;
  if (journalPath === undefined) return undefined;
  const events = replayJournal(journalPath);
  if (events.length === 0) return undefined;
  return eventsToSessionView(events, engineId, sessionIdFromHandle(handle.data));
}
