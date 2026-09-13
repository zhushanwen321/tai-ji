// journal-io.test.ts —— read 第②级（journal 重放）文件 IO 直测（review round1 MF-3：
// journal-io.ts 曾覆盖 7.7%，文件头注声称「W10 golden 往返覆盖」与实际测试面不符）。
//
// 覆盖：
//   ① replayJournal：合法行序列往返（seq 乱序写入 → 事件按 seq 升序返回）；
//   ② parseLine 形状 guard 逐分支（经公开 API 驱动——parseLine 未导出）：坏 JSON /
//      缺 v / v≠1 / ts 非 number / seq 非 number / event 非 object / event 缺 type /
//      空白行，逐项跳过不中断后续行；
//   ③ ②级不可达语义：缺文件 / 空文件 / 零有效事件 → 空事件序列（replayJournal）
//      或 undefined（replayJournalToSessionView，调用方落③级降级）；
//   ④ replayJournalToSessionView：journalPath 缺省 → undefined；有事件 → SDK
//      eventsToSessionView 投影（source: "journal" + sessionRef.sessionId 提取）。
//
// 纪律：临时文件 mkdtemp 自建自删，零真实数据目录触碰。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineHandleData } from "@zhushanwen/subagent-engine-sdk";

import { replayJournal, replayJournalToSessionView } from "../journal-io.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zcode-journal-io-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function journalPath(name: string): string {
  return join(dir, name);
}

/** 合法 journal 行（JournalLine v1：{v,ts,taskId,engineId,seq,event}）。 */
function line(seq: number, event: unknown): string {
  return JSON.stringify({ v: 1, ts: 1_700_000_000_000 + seq, taskId: "task-journal-test", engineId: "zcode", seq, event });
}

/** handle.data.journalPath 指向给定文件的最小 handle。 */
function handleWithJournal(path: string | undefined): { data: EngineHandleData } {
  return {
    data: {
      v: 1,
      engineId: "zcode",
      sessionRef: { sessionId: "sess-journal-test" },
      adapterVersion: "1.0.0",
      ...(path !== undefined ? { journalPath: path } : {}),
    },
  };
}

describe("replayJournal：合法行序列", () => {
  it("seq 乱序写入 → 事件按 seq 升序返回（往返一致）", () => {
    const p = journalPath("journal.jsonl");
    const ev0 = { type: "text_delta", delta: "第一" };
    const ev1 = { type: "text_delta", delta: "第二" };
    const ev2 = { type: "turn_end" };
    writeFileSync(p, [line(2, ev2), line(0, ev0), line(1, ev1)].join("\n") + "\n", "utf8");
    expect(replayJournal(p)).toEqual([ev0, ev1, ev2]);
  });

  it("空行与首尾空白行容忍（split+trim 语义）", () => {
    const p = journalPath("journal-blank.jsonl");
    const ev = { type: "turn_end" };
    writeFileSync(p, `\n${line(0, ev)}\n\n   \n`, "utf8");
    expect(replayJournal(p)).toEqual([ev]);
  });

  it("缺文件 → []（②级不可达，不抛）", () => {
    expect(replayJournal(journalPath("no-such-file.jsonl"))).toEqual([]);
  });

  it("空文件 / 纯坏行 → []（零有效事件）", () => {
    const empty = journalPath("journal-empty.jsonl");
    writeFileSync(empty, "", "utf8");
    expect(replayJournal(empty)).toEqual([]);

    const allBad = journalPath("journal-all-bad.jsonl");
    writeFileSync(allBad, "not-json\n{\"v\":2}\n", "utf8");
    expect(replayJournal(allBad)).toEqual([]);
  });
});

describe("replayJournal：parseLine 形状 guard 逐分支（坏行跳过不中断）", () => {
  it("坏 JSON / 缺 v / v≠1 / ts 非 number / seq 非 number / event 非 object / event 缺 type 逐项跳过", () => {
    const p = journalPath("journal-guards.jsonl");
    const good1 = { type: "text_delta", delta: "ok-1" };
    const good2 = { type: "turn_end" };
    const badLines: Array<[string, string]> = [
      ["坏 JSON", '{"v":1,"ts":1,"seq":'],
      ["非 object 的 JSON 标量", "42"],
      ["缺 v", JSON.stringify({ ts: 1, seq: 10, event: good1 })],
      ["v 非 1", JSON.stringify({ v: 2, ts: 1, seq: 11, event: good1 })],
      ["ts 非 number", JSON.stringify({ v: 1, ts: "t", seq: 12, event: good1 })],
      ["seq 非 number", JSON.stringify({ v: 1, ts: 1, seq: "13", event: good1 })],
      ["event 为字符串", JSON.stringify({ v: 1, ts: 1, seq: 14, event: "text_delta" })],
      ["event 为 null", JSON.stringify({ v: 1, ts: 1, seq: 15, event: null })],
      ["event 缺 type", JSON.stringify({ v: 1, ts: 1, seq: 16, event: { delta: "x" } })],
    ];
    const body = [
      line(0, good1),
      ...badLines.map(([, row]) => row),
      line(1, good2),
    ].join("\n");
    writeFileSync(p, body + "\n", "utf8");
    expect(replayJournal(p)).toEqual([good1, good2]);
  });
});

describe("replayJournalToSessionView：②级编排与③级降级语义", () => {
  it("journalPath 缺省 → undefined（调用方落③级）", () => {
    expect(replayJournalToSessionView(handleWithJournal(undefined), "zcode")).toBeUndefined();
  });

  it("journalPath 指向缺文件 → undefined；零有效事件 → undefined（均落③级）", () => {
    expect(replayJournalToSessionView(handleWithJournal(journalPath("missing.jsonl")), "zcode")).toBeUndefined();

    const empty = journalPath("journal-empty-2.jsonl");
    writeFileSync(empty, "not-json\n", "utf8");
    expect(replayJournalToSessionView(handleWithJournal(empty), "zcode")).toBeUndefined();
  });

  it("有事件 → SDK reducer 投影 SessionView（source journal + sessionId 提取 + turn 内容）", () => {
    const p = journalPath("journal-view.jsonl");
    // 故意乱序写入，验证 seq 排序后 reducer 投影正确
    writeFileSync(p, [line(1, { type: "turn_end" }), line(0, { type: "text_delta", delta: "Hello" })].join("\n") + "\n", "utf8");
    const view = replayJournalToSessionView(handleWithJournal(p), "zcode");
    expect(view).toBeDefined();
    expect(view!.engineId).toBe("zcode");
    expect(view!.sessionId).toBe("sess-journal-test");
    expect(view!.source).toBe("journal");
    expect(view!.turns).toHaveLength(1);
    expect(view!.turns[0]).toEqual({ text: "Hello", thinking: "", toolCalls: [], closed: true });
  });
});
