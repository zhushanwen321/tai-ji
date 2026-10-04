// src/execution/__tests__/event-tail.test.ts
//
// [W1 / D6] journal tail 读取原语测试：完整行边界（纯函数）/ offset 续读 /
// 部分行 / 坏行宽容 / 截断重读 / 周期复查（fake timers）。
//
// 验收⑤锚：fixture（含中部坏行、不完整尾行）上「分多次续读拼接」与「一次全量
// 读 + fold」等价（run/record 两域共用的域无关原语——本套件用 record 域解析器
// 作真实注入面，另以裸行解析器覆盖域无关分支）。
//
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRecordEventStream,
  foldRecordEvents,
  parseRecordEventFileLine,
  type RecordEvent,
} from "../persistence/record-events.ts";
import {
  createEventDirectoryTailer,
  readEventTail,
  splitCompleteLines,
  type EventTailChunk,
} from "../persistence/event-tail.ts";

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "event-tail-unit-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function lineOf(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

/** 领域无关的裸行解析器（identity 解析——覆盖 tailer 的域无关分支）。 */
const rawLineParser = (line: string): string | undefined => {
  const trimmed = line.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

/** 领域无关的 JSON 校验解析器（坏行判定的域无关面——非 JSON 行拒绝）。 */
const jsonLineParser = (line: string): string | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    return undefined;
  }
};

describe("splitCompleteLines（纯函数：完整行边界）", () => {
  it("尾随换行 → 全部为完整行、remainder 空", () => {
    expect(splitCompleteLines("a\nb\n")).toEqual({ lines: ["a", "b"], remainder: "" });
  });

  it("无尾随换行 → 末段留 remainder（不完整尾行等待拼齐）", () => {
    expect(splitCompleteLines("a\nb")).toEqual({ lines: ["a"], remainder: "b" });
    expect(splitCompleteLines("partial-only")).toEqual({ lines: [], remainder: "partial-only" });
  });

  it("空串 → 0 行 + 空 remainder", () => {
    expect(splitCompleteLines("")).toEqual({ lines: [], remainder: "" });
  });
});

describe("readEventTail（offset 续读原语）", () => {
  it("首次全量读：头行 + 事件行（域解析器注入）", async () => {
    const journal = createRecordEventStream(workDir);
    await journal.append("sa-1", {
      type: "record-created",
      ts: 1,
      id: "sa-1",
      agent: "a",
      task: "t",
      slug: "s",
      origin: "tool",
      rootSessionId: "root",
      depth: 0,
      mode: "background",
      startedAt: 1,
    });
    const filePath = path.join(workDir, "sa-1.events");
    const chunk = readEventTail(filePath, 0, parseRecordEventFileLine);
    expect(chunk.events).toHaveLength(1);
    expect(chunk.events[0]?.type).toBe("record-created");
    expect(chunk.skippedLines).toBe(1); // 头行 = 解析器拒绝的合法行（计数语义见 EventTailChunk 注释）
    expect(chunk.nextOffset).toBe(fs.statSync(filePath).size);
    expect(chunk.truncated).toBe(false);
  });

  it("offset 续读：只返回新增行（尾组一）", async () => {
    const filePath = path.join(workDir, "plain.jsonl");
    fs.writeFileSync(filePath, lineOf({ a: 1 }) + lineOf({ a: 2 }));
    const first = readEventTail(filePath, 0, rawLineParser);
    expect(first.events).toEqual(['{"a":1}', '{"a":2}']);
    fs.appendFileSync(filePath, lineOf({ a: 3 }));
    const second = readEventTail(filePath, first.nextOffset, rawLineParser);
    expect(second.events).toEqual(['{"a":3}']);
  });

  it("部分行：无尾随换行的末段不返回、offset 不推进；补齐换行后下次续读拼齐（尾组二）", () => {
    const filePath = path.join(workDir, "partial.jsonl");
    fs.writeFileSync(filePath, lineOf({ a: 1 }) + '{"a":2'); // 第二行不完整（无 \n）
    const first = readEventTail(filePath, 0, rawLineParser);
    expect(first.events).toEqual(['{"a":1}']);
    const offsetAfterFirst = fs.statSync(filePath).size - '{"a":2'.length;
    expect(first.nextOffset).toBe(offsetAfterFirst);
    // 写侧补齐行尾 → 同一 offset 续读拿到完整第二行
    fs.appendFileSync(filePath, "}\n");
    const second = readEventTail(filePath, first.nextOffset, rawLineParser);
    expect(second.events).toEqual(['{"a":2}']);
  });

  it("坏行宽容：中部坏行跳过计数、其余事件照常返回（尾组三）", () => {
    const filePath = path.join(workDir, "badline.jsonl");
    fs.writeFileSync(
      filePath,
      lineOf({ type: "x", seq: 1, ts: 1 }) + "{broken json\n" + lineOf({ type: "y", seq: 2, ts: 2 }),
    );
    const chunk = readEventTail(filePath, 0, jsonLineParser);
    expect(chunk.events).toHaveLength(2);
    expect(chunk.skippedLines).toBe(1);
  });

  it("截断/重建（offset > 文件大小）：从文件头全量重读并置 truncated（幂等全量重读原语）", () => {
    const filePath = path.join(workDir, "truncated.jsonl");
    fs.writeFileSync(filePath, lineOf({ a: 1 }) + lineOf({ a: 2 }) + lineOf({ a: 3 }));
    const first = readEventTail(filePath, 0, rawLineParser);
    // 文件被轮转重建为更短内容
    fs.writeFileSync(filePath, lineOf({ b: 1 }));
    const second = readEventTail(filePath, first.nextOffset, rawLineParser);
    expect(second.truncated).toBe(true);
    expect(second.events).toEqual(['{"b":1}']);
    expect(second.nextOffset).toBe(fs.statSync(filePath).size);
  });

  it("ENOENT → 空结果 + 偏移归零（文件未创建/已清理的缺省语义）", () => {
    const chunk = readEventTail(path.join(workDir, "absent.jsonl"), 100, rawLineParser);
    expect(chunk).toEqual({ events: [], nextOffset: 0, skippedLines: 0, truncated: false } satisfies EventTailChunk<string>);
  });

  it("size === offset → 零成本快路径（无新内容偏移不动）", () => {
    const filePath = path.join(workDir, "stable.jsonl");
    fs.writeFileSync(filePath, lineOf({ a: 1 }));
    const first = readEventTail(filePath, 0, rawLineParser);
    const second = readEventTail(filePath, first.nextOffset, rawLineParser);
    expect(second.events).toEqual([]);
    expect(second.nextOffset).toBe(first.nextOffset);
  });
});

describe("验收⑤：续读拼接 ≡ 全量 fold（fixture 含中部坏行 + 不完整尾行）", () => {
  it("分三段续读（中途注入坏行/部分行）的事件并集，与一次全量读 + fold 等价", async () => {
    const recordsDir = path.join(workDir, "records");
    fs.mkdirSync(recordsDir);
    const journal = createRecordEventStream(recordsDir);
    const appended: RecordEvent[] = [];
    appended.push(
      await journal.append("sa-1", {
        type: "record-created",
        ts: 1,
        id: "sa-1",
        agent: "a",
        task: "t",
        slug: "s",
        origin: "tool",
        rootSessionId: "root",
        depth: 0,
        mode: "background",
        startedAt: 1,
      }),
    );
    const filePath = path.join(recordsDir, "sa-1.events");

    // 段 1：读走头行 + created
    const seg1 = readEventTail(filePath, 0, parseRecordEventFileLine);
    expect(seg1.events).toHaveLength(1);

    // 段间注入①：不完整尾行（无换行结尾——模拟磁盘半写进行中）
    fs.appendFileSync(filePath, '{"type":"record-bound","seq":2');
    const seg2 = readEventTail(filePath, seg1.nextOffset, parseRecordEventFileLine);
    expect(seg2.events).toEqual([]); // 不完整行不返回
    expect(seg2.skippedLines).toBe(0); // 且不计坏行（完整行边界外的字节不属于任何行）
    expect(seg2.nextOffset).toBe(seg1.nextOffset); // 偏移停在完整行边界

    // 段间注入②：补齐 bound 行 + 一条完整坏行（中部坏行）
    fs.appendFileSync(
      filePath,
      ',"ts":2,"sessionFile":"/s","engine":"pi","engineHandle":{"sessionRef":{},"poolKey":"shared"},"epoch":0}\n{"broken\n',
    );

    // 段 3：坏行之后的 settled 事件照常续读
    appended.push(await journal.append("sa-1", { type: "record-settled", ts: 3, stopReason: "completed", endedAt: 3, turns: 1, totalTokens: 10 }));
    const seg3 = readEventTail(filePath, seg2.nextOffset, parseRecordEventFileLine);
    expect(seg3.events.map((e) => e.type)).toEqual(["record-bound", "record-settled"]);
    expect(seg3.skippedLines).toBe(1); // 中部坏行：跳过 + 计数

    // 续读拼接 ≡ 全量读（验收⑤等价性）：事件序列逐条相等 + fold 等价双锚
    const tailEvents = [...seg1.events, ...seg2.events, ...seg3.events];
    const fullChunk = readEventTail(filePath, 0, parseRecordEventFileLine);
    expect(tailEvents).toEqual(fullChunk.events);
    expect(foldRecordEvents(tailEvents)).toEqual(foldRecordEvents(fullChunk.events));
    // 全量读 skipped = 头行 1 + 坏行 1（tail 续读不重算头行）
    expect(fullChunk.skippedLines).toBe(2);
  });
});

describe("createEventDirectoryTailer（周期复查 / offset 续读状态）", () => {
  it("rescan 冷启动全量读 + 后续 rescan 增量续读（onEvents 按文件回调）", async () => {
    const recordsDir = path.join(workDir, "records");
    fs.mkdirSync(recordsDir);
    const journal = createRecordEventStream(recordsDir);
    await journal.append("sa-1", {
      type: "record-created",
      ts: 1,
      id: "sa-1",
      agent: "a",
      task: "t",
      slug: "s",
      origin: "tool",
      rootSessionId: "root",
      depth: 0,
      mode: "background",
      startedAt: 1,
    });
    const seen: Array<{ file: string; count: number }> = [];
    const tailer = createEventDirectoryTailer({
      dir: recordsDir,
      filter: (name) => name.endsWith(".events"),
      parseLine: parseRecordEventFileLine,
      onEvents: (filename, events) => seen.push({ file: filename, count: events.length }),
      onSkippedLines: () => undefined,
    });
    try {
      tailer.rescan();
      expect(seen).toEqual([{ file: "sa-1.events", count: 1 }]);
      expect(tailer.offsetOf("sa-1.events")).toBe(fs.statSync(path.join(recordsDir, "sa-1.events")).size);

      seen.length = 0;
      await journal.append("sa-1", { type: "record-settled", ts: 2, stopReason: "completed", endedAt: 2, turns: 1, totalTokens: 1 });
      tailer.rescan();
      expect(seen).toEqual([{ file: "sa-1.events", count: 1 }]); // 只增量（头行已消费）
    } finally {
      tailer.dispose();
    }
  });

  it("非目标文件被 filter 排除（records 目录的 manifest .json 不读）", () => {
    const recordsDir = path.join(workDir, "records");
    fs.mkdirSync(recordsDir);
    fs.writeFileSync(path.join(recordsDir, "sa-1.json"), "{}");
    const tailer = createEventDirectoryTailer({
      dir: recordsDir,
      filter: (name) => name.endsWith(".events"),
      parseLine: parseRecordEventFileLine,
      onEvents: () => {
        throw new Error("manifest .json 不应触发 onEvents");
      },
    });
    try {
      tailer.rescan();
      expect(tailer.offsetOf("sa-1.json")).toBeUndefined();
    } finally {
      tailer.dispose();
    }
  });

  it("文件消失后偏移回收：同名新文件从 0 全量读（不误判 truncated）", () => {
    const recordsDir = path.join(workDir, "records");
    fs.mkdirSync(recordsDir);
    const filePath = path.join(recordsDir, "sa-1.events");
    fs.writeFileSync(filePath, lineOf({ type: "record-created", seq: 1, ts: 1 }));
    const resets: string[] = [];
    const tailer = createEventDirectoryTailer({
      dir: recordsDir,
      filter: (name) => name.endsWith(".events"),
      parseLine: parseRecordEventFileLine,
      onEvents: () => undefined,
      onReset: (filename) => resets.push(filename),
    });
    try {
      tailer.rescan();
      expect(tailer.offsetOf("sa-1.events")).toBeGreaterThan(0);
      fs.rmSync(filePath);
      tailer.rescan(); // 目录枚举回收偏移
      expect(tailer.offsetOf("sa-1.events")).toBeUndefined();
      fs.writeFileSync(filePath, lineOf({ type: "record-settled", seq: 1, ts: 2, stopReason: "completed", endedAt: 2, turns: 0, totalTokens: 0 }));
      tailer.rescan(); // 新文件从 0 读，无 truncated
      expect(resets).toEqual([]);
      expect(tailer.offsetOf("sa-1.events")).toBe(fs.statSync(filePath).size);
    } finally {
      tailer.dispose();
    }
  });

  it("周期复查（fake timers，尾组四）：不依赖 watch 事件，周期到点自动捕获新文件与新事件", async () => {
    vi.useFakeTimers();
    try {
      const recordsDir = path.join(workDir, "records");
      fs.mkdirSync(recordsDir);
      const seen: Array<{ file: string; count: number }> = [];
      const tailer = createEventDirectoryTailer({
        dir: recordsDir,
        filter: (name) => name.endsWith(".events"),
        parseLine: parseRecordEventFileLine,
        onEvents: (filename, events) => seen.push({ file: filename, count: events.length }),
        onSkippedLines: () => undefined,
        recheckIntervalMs: 1000,
        debounceMs: 10,
      });
      // 构造后（未 rescan）目录为空——首个周期复查是冷启动
      vi.advanceTimersByTime(1000);
      expect(seen).toEqual([]);

      // watch 静默丢事件形态：直接写文件（不依赖 fs.watch 通知），周期复查兜底
      const journal = createRecordEventStream(recordsDir);
      await journal.append("sa-9", {
        type: "record-created",
        ts: 1,
        id: "sa-9",
        agent: "a",
        task: "t",
        slug: "s",
        origin: "tool",
        rootSessionId: "root",
        depth: 0,
        mode: "background",
        startedAt: 1,
      });
      seen.length = 0;
      vi.advanceTimersByTime(1000);
      expect(seen).toEqual([{ file: "sa-9.events", count: 1 }]);

      tailer.dispose();
      // dispose 后周期复查停摆（定时器清理）
      seen.length = 0;
      await journal.append("sa-9", { type: "record-settled", ts: 2, stopReason: "completed", endedAt: 2, turns: 0, totalTokens: 0 });
      vi.advanceTimersByTime(5000);
      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("watch 事件路径（真实 fs.watch + 短 debounce）：文件追加经 watch 触发续读", async () => {
    const recordsDir = path.join(workDir, "records");
    fs.mkdirSync(recordsDir);
    const journal = createRecordEventStream(recordsDir);
    await journal.append("sa-1", {
      type: "record-created",
      ts: 1,
      id: "sa-1",
      agent: "a",
      task: "t",
      slug: "s",
      origin: "tool",
      rootSessionId: "root",
      depth: 0,
      mode: "background",
      startedAt: 1,
    });
    const seen: number[] = [];
    const tailer = createEventDirectoryTailer({
      dir: recordsDir,
      filter: (name) => name.endsWith(".events"),
      parseLine: parseRecordEventFileLine,
      onEvents: (_filename, events) => seen.push(events.length),
      debounceMs: 20,
      // 周期复查兜底必须在断言窗口内真实可用（默认 30s 落不进 2s 窗口——「双保险」
      // 名不副实）：注入短间隔后，fs.watch 事件在负载下迟到/丢失时由复查轮兜住，
      // 断言与窗口均不变
      recheckIntervalMs: 200,
    });
    try {
      tailer.rescan(); // 冷启动消费首事件
      seen.length = 0;
      await journal.append("sa-1", { type: "record-settled", ts: 2, stopReason: "completed", endedAt: 2, turns: 1, totalTokens: 1 });
      // 真实 fs.watch + debounce：事件到达后 2s 内应触发（含周期复查兜底，双保险）
      const deadline = Date.now() + 2000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(seen).toEqual([1]);
    } finally {
      tailer.dispose();
    }
  });
});
