// src/execution/__tests__/helpers/v2-record-entry.ts
//
// [登记 §3.3] 测试播种辅助：SubagentRecord → v2 条目的构造入口。
//
// 为什么需要：v1 全量快照写点（toSubagentRecordEntry）已随兼容层删除，测试不再有
// 「一条 entry 装下整个 record」的播种形态——主 session 条目的现行契约是
// 「注册 + 终态两条小条目」（record-entry.ts v2 契约）。本文件把 SubagentRecord
// 投影成该形态供测试播种，行为等价于生产写侧的 toRegisteredEntryData /
// toSettledEntryData 组合，但只依赖 record 值本身（不需要 ExecutionRecord）。

import type { SubagentRecord } from "../../assembly/types.ts";
import {
  SUBAGENT_RECORD_ENTRY_VERSION,
  type SubagentRecordRegisteredEntryData,
  type SubagentRecordSettledEntryData,
} from "../../persistence/record-entry.ts";

/** record → v2 注册条目（身份域：id/agent/task/slug/家族链/起点）。 */
export function v2RegisteredEntry(record: SubagentRecord): SubagentRecordRegisteredEntryData {
  return {
    v: SUBAGENT_RECORD_ENTRY_VERSION,
    kind: "registered",
    id: record.id,
    agent: record.agent,
    task: record.task,
    slug: record.slug,
    origin: record.origin ?? "tool",
    ...(record.parentRunId !== undefined ? { parentRunId: record.parentRunId } : {}),
    ...(record.stepIndex !== undefined ? { stepIndex: record.stepIndex } : {}),
    rootSessionId: record.rootSessionId ?? "",
    ...(record.parentRecordId !== undefined ? { parentRecordId: record.parentRecordId } : {}),
    depth: record.depth,
    startedAt: record.startedAt,
  };
}

/** record → v2 终态条目（终局域：停因/统计/引擎锚/结果全文）。 */
export function v2SettledEntry(record: SubagentRecord): SubagentRecordSettledEntryData {
  return {
    v: SUBAGENT_RECORD_ENTRY_VERSION,
    kind: "settled",
    id: record.id,
    status: "idle",
    stopReason: record.stopReason ?? "interrupted-by-restart",
    ...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    endedAt: record.endedAt ?? record.startedAt,
    turns: record.turns,
    totalTokens: record.totalTokens,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    ...(record.engine !== undefined ? { engine: record.engine } : {}),
    ...(record.engineHandle !== undefined ? { engineHandle: record.engineHandle } : {}),
    ...(record.sessionFile !== undefined ? { sessionFile: record.sessionFile } : {}),
    ...(record.result !== undefined ? { result: record.result } : {}),
  };
}

/**
 * record → 现行主 session 条目族：注册条目恒在场；非 running（= 已收口）再补终态条目。
 * 播种顺序与生产写点一致（注册先行）。
 */
export function v2Entries(record: SubagentRecord): Array<
  SubagentRecordRegisteredEntryData | SubagentRecordSettledEntryData
> {
  const registered = v2RegisteredEntry(record);
  if (record.status === "running") return [registered];
  return [registered, v2SettledEntry(record)];
}
