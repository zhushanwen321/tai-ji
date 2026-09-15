// event-journal.test.ts —— JournalWriter 写入-重放往返一致 + 中立格式字段断言。
//
// 三视角：①构建者——行格式 v/ts/taskId/engineId/seq/event 逐字段、seq 单调；②使用者
// ——replayJournal 重放即得事件流（read 第②级），文件不存在/坏行不 throw；③观察者
// ——写失败 warn 留痕且 close 不抛（journal 是尽力而为的②级数据源）。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JournalWriter, replayJournal } from "../../common/event-journal.ts";
import type { JournalFsDeps } from "../../common/event-journal.ts";
import type { AgentEvent } from "../../../assembly/types.ts";

let tmpRoot: string | undefined;

function tmpPath(name: string): string {
  tmpRoot ??= mkdtempSync(join(tmpdir(), "engine-journal-test-"));
  const path = join(tmpRoot, name);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

afterEach(() => {
  if (tmpRoot !== undefined) {
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    tmpRoot = undefined;
  }
});

const EVENTS: AgentEvent[] = [
  { type: "text_delta", delta: "hello " },
  { type: "text_delta", delta: "world" },
  { type: "tool_start", toolName: "bash", args: { cmd: "ls" } },
  { type: "tool_end", toolName: "bash", isError: false },
  { type: "turn_end" },
];

describe("JournalWriter 写入 + replayJournal 重放", () => {
  it("写入-重放往返一致：append N 事件 → close → replay 深等事件流", async () => {
    const path = tmpPath("roundtrip/journal-bg-1.jsonl");
    const writer = new JournalWriter({ path, taskId: "bg-1", engineId: "zcode" });
    for (const ev of EVENTS) writer.append(ev);
    await writer.close();

    expect(replayJournal(path)).toEqual(EVENTS);
  });

  it("中立格式字段断言：每行 {v:1, ts, taskId, engineId, seq, event}，seq 单调递增", async () => {
    const path = tmpPath("format/journal-bg-2.jsonl");
    const writer = new JournalWriter({ path, taskId: "bg-2", engineId: "pi" });
    const before = Date.now();
    for (const ev of EVENTS) writer.append(ev);
    await writer.close();

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBe(EVENTS.length);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    let prevSeq = -1;
    for (const [i, row] of parsed.entries()) {
      expect(row.v).toBe(1);
      expect(typeof row.ts).toBe("number");
      expect(row.ts).toBeGreaterThanOrEqual(before);
      expect(row.taskId).toBe("bg-2");
      expect(row.engineId).toBe("pi");
      expect(row.seq).toBe(i);
      expect((row.seq as number) > prevSeq).toBe(true);
      prevSeq = row.seq as number;
      expect(row.event).toEqual(EVENTS[i]);
    }
  });

  it("close 幂等（二次 close 不追加不抛错）；close 后 append 丢弃", async () => {
    const path = tmpPath("idempotent/journal-bg-3.jsonl");
    const writer = new JournalWriter({ path, taskId: "bg-3", engineId: "pi" });
    writer.append({ type: "turn_end" });
    await writer.close();
    writer.append({ type: "error", message: "late" });
    await writer.close();
    expect(replayJournal(path)).toEqual([{ type: "turn_end" }]);
  });

  it("无事件任务不产生空 journal 文件（惰性创建）", async () => {
    const path = tmpPath("empty/journal-bg-4.jsonl");
    const writer = new JournalWriter({ path, taskId: "bg-4", engineId: "pi" });
    await writer.close();
    expect(existsSync(path)).toBe(false);
    expect(replayJournal(path)).toEqual([]);
  });
});

describe("JournalWriter 写失败（尽力而为语义）", () => {
  function failingFs(): { fs: JournalFsDeps; warnings: string[] } {
    const warnings: string[] = [];
    const fs: JournalFsDeps = {
      mkdir: async () => undefined,
      appendFile: async () => {
        throw new Error("disk full");
      },
      open: async () => {
        throw new Error("unreachable in failed path");
      },
    };
    return { fs, warnings };
  }

  it("appendFile 失败 → warn 留痕 + failed，close 不抛，后续 append 丢弃", async () => {
    const path = tmpPath("failing/journal-bg-5.jsonl");
    const { fs } = failingFs();
    const warnings: string[] = [];
    const writer = new JournalWriter(
      { path, taskId: "bg-5", engineId: "zcode" },
      fs,
      (msg) => warnings.push(msg),
    );
    writer.append({ type: "turn_end" });
    await writer.flush();
    expect(writer.isFailed).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("bg-5");
    expect(warnings[0]).toContain("disk full");

    writer.append({ type: "error", message: "dropped" });
    await writer.close(); // 不抛
    expect(existsSync(path)).toBe(false);
  });
});

describe("replayJournal 容错", () => {
  it("文件不存在 → []（②级不可达不算错误，降级链语义）", () => {
    expect(replayJournal(tmpPath("missing/journal-none.jsonl"))).toEqual([]);
  });

  it("损坏行跳过（追加写末行可能截断），好行保留", () => {
    const path = tmpPath("corrupt/journal-bg-6.jsonl");
    const good = JSON.stringify({
      v: 1, ts: 1, taskId: "bg-6", engineId: "pi", seq: 0, event: { type: "turn_end" },
    });
    writeFileSync(path, `${good}\n{"v":1,"truncated...\n`, "utf8");
    expect(replayJournal(path)).toEqual([{ type: "turn_end" }]);
  });

  it("行序乱 → 按 seq 稳定排序返回（重放顺序权威是 seq）", () => {
    const path = tmpPath("unordered/journal-bg-7.jsonl");
    const line = (seq: number, delta: string): string =>
      JSON.stringify({ v: 1, ts: seq, taskId: "bg-7", engineId: "pi", seq, event: { type: "text_delta", delta } });
    writeFileSync(path, `${line(2, "c")}\n${line(0, "a")}\n${line(1, "b")}\n`, "utf8");
    expect(replayJournal(path)).toEqual([
      { type: "text_delta", delta: "a" },
      { type: "text_delta", delta: "b" },
      { type: "text_delta", delta: "c" },
    ]);
  });

  it("空文件 → []", () => {
    const path = tmpPath("blank/journal-bg-8.jsonl");
    writeFileSync(path, "\n\n", "utf8");
    expect(replayJournal(path)).toEqual([]);
  });

  it("结构不符的行（缺 event / v≠1）跳过", () => {
    const path = tmpPath("shape/journal-bg-9.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ v: 1, ts: 1, taskId: "t", engineId: "pi", seq: 0, event: { type: "compaction" } }),
        JSON.stringify({ v: 1, ts: 2, taskId: "t", engineId: "pi", seq: 1 }), // 无 event
        JSON.stringify({ v: 2, ts: 3, taskId: "t", engineId: "pi", seq: 2, event: { type: "turn_end" } }), // v≠1
        JSON.stringify({ v: 1, ts: 4, taskId: "t", engineId: "pi", seq: 3, event: "not-an-object" }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(replayJournal(path)).toEqual([{ type: "compaction" }]);
  });
});
