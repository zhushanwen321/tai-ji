// src/journal-io.ts
//
// journal 文件读取单源（S4 簇 6 收编：core execution/engine/common/event-journal.ts
// 与 zcode-subagent-cli journal-io.ts 的 replayJournal/parseLine 逐字等价双副本收编
// ——引擎包不能 import core，单源只能落 SDK；core 改 re-export、zcode 改 import，
// 消费方路径零改动）。
//
// 实现以 core 版为准逐字迁移：私有 JournalLine 保留全字段形态（{v,ts,taskId,
// engineId,seq,event}——taskId/engineId 仅诊断字段，重放在 map event 前即丢弃，
// 故 zcode 旧副本的缩略行形态与本版无行为差异）。行格式权威：docs/architecture/
// subagent-engine-abstraction.md §3.3.6（JSONL 中立 v1）；格式漂移面由 W10 golden
// 往返测试 + core/zcode 各自 journal 直测覆盖。
//
// 分层：只承接读侧（replay）。JournalWriter（写入器）留 core——宿主侧职责；本模块
// 与 journal-replay.ts（纯投影，无 fs）分离，保持投影层零文件系统依赖。

import { readFileSync } from "node:fs";

import type { AgentEvent } from "./protocol/contract-types.ts";

/** journal 单行（JSONL，§3.3.6 v1）。私有形态：重放只消费 seq/event。 */
interface JournalLine {
  v: 1;
  /** host 落盘时刻（Date.now()，ms）。 */
  ts: number;
  /** = RunContext.taskId = record.id（journal 文件名与池引用计数 key）。 */
  taskId: string;
  engineId: string;
  seq: number;
  /** AgentEvent 原样（onEvent 回调对象的 JSON.stringify 直接产物，无二次变换）。 */
  event: AgentEvent;
}

/**
 * 重放 journal：读取路径下全部事件，重放即得 AgentEvent 流（read 第②级）。
 *
 * - 文件不存在 → []（降级链语义：②级不可达不算错误，调用方落 ③级）；
 * - 损坏行跳过（追加写产物末行可能截断；跳过优于整体失败——设计 C5「三级都不 throw」）；
 * - 按 seq 稳定排序后返回（重放顺序权威是 seq，不依赖文件行序的隐式保证，§3.3.6）。
 */
export function replayJournal(path: string): AgentEvent[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines: JournalLine[] = [];
  for (const row of raw.split("\n")) {
    const trimmed = row.trim();
    if (trimmed === "") continue;
    const parsed = parseLine(trimmed);
    if (parsed !== undefined) lines.push(parsed);
  }
  lines.sort((a, b) => a.seq - b.seq);
  return lines.map((l) => l.event);
}

/** 单行 parse + 结构 guard（v=1 + event 形状最小判别：object 且 type 为 string）。 */
function parseLine(trimmed: string): JournalLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rec = parsed as Record<string, unknown>;
  const event = rec.event;
  if (rec.v !== 1 || typeof rec.ts !== "number" || typeof rec.seq !== "number") return undefined;
  if (typeof event !== "object" || event === null || typeof (event as Record<string, unknown>).type !== "string") {
    return undefined;
  }
  return {
    v: 1,
    ts: rec.ts,
    taskId: typeof rec.taskId === "string" ? rec.taskId : "",
    engineId: typeof rec.engineId === "string" ? rec.engineId : "",
    seq: rec.seq,
    event: event as AgentEvent,
  };
}
