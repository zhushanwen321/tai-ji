// src/execution/__tests__/record-events.test.ts
//
// [W1 / D3] record 事件文件契约测试：词表 / 首行头行 / seq 信封 / journal 读写
// 原语 / fold 纯函数族。
//
// 设计 D3 映射表逐项对应锚（code review 核对面——验收③）：
//   | 词表成员              | 载荷要点                                    | 对应现状写点 |
//   | record-created        | 身份域全量(id/agent/task/slug/origin/       | register + 注册条目 |
//   |                       | parentRunId?/stepIndex?/rootSessionId/     |              |
//   |                       | parentRecordId?/depth/mode/startedAt)      |              |
//   | record-bound          | sessionFile/engine/engineHandle/epoch      | spawn 回填（.record-binding 写点）|
//   | record-round-started  | round 序号/epoch                           | resumeRound / reopen 后续轮 |
//   | record-round-idle     | stopReason/轮统计(turns/tokens 快照)/      | 轮终 markRoundIdle（.state 写点）|
//   |                       | result 摘要锚?                            |              |
//   | record-settled        | stopReason/outcome/error?/endedAt/         | archive / markSettled / legacy 终态 |
//   |                       | 统计终值/result 摘要锚                     |              |
//   | record-reopened       | epoch 递增/round 归零                      | markReopened |
// 恰好 6 类（下方词表钉住）；每事件行携带行级单调 seq（W2 通知去重键载体）+ ts。
//
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。
//
// 整合来源（round 5-g 测试提速，主被测对象 = record 事件journal 持久层）：
//   event-tail.test.ts（journal tail 续读原语）/ record-identity-fold.test.ts
//   （RecordStore 身份换源折叠）/ record-store-rebuild-v-gate.test.ts（v2 条目版本门）。
//   四件共享 record-events 的格式 SSOT，全簇零 mock。文件级 tmpdir hook 已下沉本段各 describe。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyRecordEvent,
  createRecordEventStream,
  foldRecordEvents,
  INITIAL_RECORD_EVENT_FOLD_STATE,
  isRecordEventHeader,
  parseRecordEventFileLine,
  parseRecordEventLine,
  RECORD_EVENT_TYPES,
  recordEventsPath,
  RECORD_EVENTS_SUFFIX,
  RECORD_EVENTS_HEADER_TYPE,
  toRecordEventHeader,
  type RecordBoundEvent,
  type RecordCreatedEvent,
  type RecordEvent,
  type RecordEventInput,
  type RecordSettledEvent,
} from "../persistence/record-events.ts";
import {
  readEventTail,
  splitCompleteLines,
  type EventTailChunk,
} from "../persistence/event-tail.ts";
import {
  buildRecord,
  collectV2EntryPairs,
  lastRoundFromFold,
  v2PairToRecord,
} from "../persistence/record-store-rebuild.ts";
import type {
  SubagentRecordRegisteredEntryData,
  SubagentRecordSettledEntryData,
} from "../persistence/record-entry.ts";
import type { IdentityHeaderRecon, ReconstructedRecord } from "../persistence/session-reconstructor.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../assembly/path-encoding.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { RECORD_BINDING_SIDECAR_EXT } from "../persistence/state-marker.ts";

let journalDir: string;

/** record-created 写侧入参形态（seq 由 journal 分配——写侧入参无 seq）。 */
type CreatedInput = Omit<RecordCreatedEvent, "seq">;

/** record-settled 写侧入参形态。 */
type SettledInput = Omit<RecordSettledEvent, "seq">;

/** 最小合法 record-created 输参。 */
function createdInput(over: Partial<CreatedInput> = {}): CreatedInput {
  return {
    type: "record-created",
    ts: 1780000000000,
    id: "sa-test-1",
    agent: "/home/u/agents/worker.md",
    task: "fix the flaky test",
    slug: "worker",
    origin: "workflow",
    parentRunId: "wf-1",
    stepIndex: 2,
    rootSessionId: "root-A",
    depth: 1,
    mode: "background",
    startedAt: 1780000000000,
    ...over,
  };
}

function settledInput(over: Partial<SettledInput> = {}): SettledInput {
  return {
    type: "record-settled",
    ts: 1780000123000,
    stopReason: "completed",
    outcome: "completed",
    endedAt: 1780000123000,
    turns: 3,
    totalTokens: 4500,
    resultSummary: "done: 3 tests fixed",
    ...over,
  };
}

describe("词表钉住（D3 映射表逐项对应 6 类 + [subagent-model-switch] 第 7 类）", () => {

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-events-unit-"));
  });

  afterEach(() => {
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("事件类型全集恰为 7 类且互异（前 6 类增删须先改设计 D3 表；第 7 类 = subagent-model-switch §6.2 覆盖记账帧）", () => {
    expect([...RECORD_EVENT_TYPES]).toEqual([
      "record-created",
      "record-bound",
      "record-round-started",
      "record-round-idle",
      "record-settled",
      "record-reopened",
      "record-model-override",
    ]);
    expect(new Set(RECORD_EVENT_TYPES).size).toBe(RECORD_EVENT_TYPES.length);
  });

  it("头行 type 与事件词表命名空间不相交（头行不是事件——fold 不会误吞）", () => {
    expect(RECORD_EVENT_TYPES).not.toContain(RECORD_EVENTS_HEADER_TYPE);
  });
});

describe("首行头行形态（写侧契约：文件创建时恰一行）", () => {

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-events-unit-"));
  });

  afterEach(() => {
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("头行序列化形态 = {\"type\":\"record-events\",\"id\":...}", () => {
    expect(JSON.stringify(toRecordEventHeader("sa-1"))).toBe('{"type":"record-events","id":"sa-1"}');
  });

  it("isRecordEventHeader 判定（id 非空字符串）", () => {
    expect(isRecordEventHeader({ type: "record-events", id: "sa-1" })).toBe(true);
    expect(isRecordEventHeader({ type: "record-events" })).toBe(false);
    expect(isRecordEventHeader({ type: "record-events", id: "" })).toBe(false);
    expect(isRecordEventHeader({ type: "record-created", id: "sa-1" })).toBe(false);
    expect(isRecordEventHeader(null)).toBe(false);
  });

  it("首写自动落头行 + 首事件（文件创建点）；续写不重复头行", async () => {
    const journal = createRecordEventStream(() => journalDir);
    await journal.append("sa-1", createdInput());
    await journal.append("sa-1", settledInput());
    const content = fs.readFileSync(recordEventsPath(journalDir, "sa-1"), "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(3);
    expect(isRecordEventHeader(JSON.parse(lines[0]!))).toBe(true);
    expect(JSON.parse(lines[1]!).type).toBe("record-created");
    expect(JSON.parse(lines[2]!).type).toBe("record-settled");
  });
});

describe("journal 读写原语（seq 单调分配 / scan 宽容解析）", () => {

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-events-unit-"));
  });

  afterEach(() => {
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("append 分配行级单调 seq（1 起严格递增）并返回完整事件", async () => {
    const journal = createRecordEventStream(() => journalDir);
    const first = await journal.append("sa-1", createdInput());
    const second = await journal.append("sa-1", {
      type: "record-round-started",
      ts: 1780000001000,
      round: 1,
      epoch: 0,
    });
    const third = await journal.append("sa-1", settledInput());
    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
    expect(first.type).toBe("record-created");
  });

  it("跨 journal 实例续写：seq 从文件末水位 +1（重启后续写不回退）", async () => {
    await createRecordEventStream(() => journalDir).append("sa-1", createdInput());
    const second = await createRecordEventStream(() => journalDir).append("sa-1", settledInput());
    expect(second.seq).toBe(2);
  });

  it("scan 返回写入序事件（头行不在其中）", async () => {
    const journal = createRecordEventStream(() => journalDir);
    await journal.append("sa-1", createdInput());
    await journal.append("sa-1", settledInput());
    const events = await journal.scan("sa-1");
    expect(events.map((e) => e.type)).toEqual(["record-created", "record-settled"]);
  });

  it("scan 对不存在文件返回空流（record 未落账 / 已清理）", async () => {
    expect(await createRecordEventStream(() => journalDir).scan("sa-none")).toEqual([]);
  });

  it("scan 中部坏行宽容跳过（不完整 JSON 行）——事件流不因坏行截断", async () => {
    const journal = createRecordEventStream(() => journalDir);
    await journal.append("sa-1", createdInput());
    await journal.append("sa-1", settledInput());
    // 手工注入坏行于两事件之间（模拟磁盘半写/外部编辑）
    const filePath = recordEventsPath(journalDir, "sa-1");
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    fs.writeFileSync(filePath, [lines[0], lines[1], '{"type":"record-settled", "trunc', lines[2]].join("\n") + "\n");
    const events = await journal.scan("sa-1");
    expect(events.map((e) => e.type)).toEqual(["record-created", "record-settled"]);
  });

  it("record id 白名单：路径穿越形态拒绝（防 ../ 注入）", () => {
    expect(() => recordEventsPath(journalDir, "../evil")).toThrow(/非法 record id/);
    expect(() => recordEventsPath(journalDir, ".hidden")).toThrow(/非法 record id/);
    expect(recordEventsPath(journalDir, "sa-1").endsWith(`sa-1${RECORD_EVENTS_SUFFIX}`)).toBe(true);
  });
});

describe("行解析（parseRecordEventLine / parseRecordEventFileLine）", () => {

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-events-unit-"));
  });

  afterEach(() => {
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("信封校验：seq 正整数 + ts 有限数值 + type 落词表", () => {
    expect(parseRecordEventLine({ type: "record-created", seq: 1, ts: 1 })).not.toBeNull();
    expect(parseRecordEventLine({ type: "unknown-event", seq: 1, ts: 1 })).toBeNull();
    expect(parseRecordEventLine({ type: "record-created", seq: 0, ts: 1 })).toBeNull();
    expect(parseRecordEventLine({ type: "record-created", seq: 1.5, ts: 1 })).toBeNull();
    expect(parseRecordEventLine({ type: "record-created", seq: 1, ts: Number.NaN })).toBeNull();
    expect(parseRecordEventLine("not-an-object")).toBeNull();
  });

  it("文件行解析：空行与头行静默跳过（undefined 且非坏 JSON 形态）", () => {
    expect(parseRecordEventFileLine("")).toBeUndefined();
    expect(parseRecordEventFileLine('{"type":"record-events","id":"sa-1"}')).toBeUndefined();
    expect(parseRecordEventFileLine('{"type":"record-created","seq":1,"ts":1}')).toMatchObject({
      type: "record-created",
      seq: 1,
    });
    expect(parseRecordEventFileLine("}{ broken")).toBeUndefined();
  });
});

describe("fold 纯函数族（全量 / 增量 / 幂等）", () => {

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-events-unit-"));
  });

  afterEach(() => {
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  /** 全生命周期样例序列（含 round 往返与 reopen 回边）。 */
  function lifecycleEvents(): RecordEvent[] {
    return [
      { ...createdInput(), seq: 1 },
      {
        type: "record-bound",
        seq: 2,
        ts: 1780000001000,
        sessionFile: "/tmp/sessions/sa-1.jsonl",
        engine: "pi",
        engineHandle: { sessionRef: {}, poolKey: "shared" },
        epoch: 0,
      },
      { type: "record-round-started", seq: 3, ts: 1780000002000, round: 1, epoch: 0 },
      { type: "record-round-idle", seq: 4, ts: 1780000050000, round: 1, stopReason: "completed", turns: 1, totalTokens: 1000 },
      { ...settledInput(), seq: 5 },
      { type: "record-reopened", seq: 6, ts: 1780000200000, epoch: 1, round: 0 },
      { type: "record-round-started", seq: 7, ts: 1780000201000, round: 1, epoch: 1 },
    ];
  }

  it("全量 fold：身份/绑定/轮/epoch/水位逐字段落位", () => {
    const state = foldRecordEvents(lifecycleEvents());
    expect(state.identity?.id).toBe("sa-test-1");
    expect(state.bound?.engine).toBe("pi");
    expect(state.epoch).toBe(1);
    expect(state.round).toBe(1);
    expect(state.roundIdle?.stopReason).toBe("completed");
    expect(state.lastSeq).toBe(7);
    expect(state.lastEvent?.type).toBe("record-round-started");
  });

  it("settled 非吸收：record-settled 落终态，reopened/round-started 清除（可续实体回边）", () => {
    const throughSettle = foldRecordEvents(lifecycleEvents().slice(0, 5));
    expect(throughSettle.settled?.stopReason).toBe("completed");
    const afterReopen = foldRecordEvents(lifecycleEvents().slice(0, 6));
    expect(afterReopen.settled).toBeUndefined();
    expect(afterReopen.epoch).toBe(1);
    expect(afterReopen.round).toBe(0);
  });

  it("fold 幂等：同一序列重放产出逐字段相等 state（验收①）", () => {
    const first = foldRecordEvents(lifecycleEvents());
    const second = foldRecordEvents(lifecycleEvents());
    expect(second).toEqual(first);
  });

  it("增量 fold = 全量 fold：分两段以中间 state 续 fold，结果等价", () => {
    const events = lifecycleEvents();
    const midState = foldRecordEvents(events.slice(0, 4));
    const incremental = foldRecordEvents(events.slice(4), midState);
    expect(incremental).toEqual(foldRecordEvents(events));
  });

  it("seq 重放去重：同一序列两遍拼接（截断重读形态）不重复应用（onSkipped 出声）", () => {
    const events = lifecycleEvents();
    const skipped: Array<{ seq: number; why: string }> = [];
    const state = foldRecordEvents(
      [...events, ...events],
      INITIAL_RECORD_EVENT_FOLD_STATE,
      (event, why) => skipped.push({ seq: event.seq, why }),
    );
    // 重放段全部被 seq 守卫拦下，状态与单遍 fold 等价
    expect(state).toEqual(foldRecordEvents(events));
    expect(skipped).toHaveLength(events.length);
    expect(skipped.every((s) => s.why === "seq-regression")).toBe(true);
  });

  it("seq 回退边界：乱序行（seq ≤ 水位）跳过、不炸、不回滚状态", () => {
    const events = lifecycleEvents();
    const regressed: RecordEvent[] = [
      events[0]!,
      events[4]!,
      events[1]!, // 回退：seq 2 ≤ 水位 5 → 跳过
    ];
    const state = foldRecordEvents(regressed);
    expect(state.lastSeq).toBe(5);
    expect(state.settled?.seq).toBe(5);
    expect(state.bound).toBeUndefined(); // 被跳过的回退行未应用
  });

  it("applyRecordEvent 单步纯函数：不可变更新（原 state 不被 mutate）", () => {
    const base = INITIAL_RECORD_EVENT_FOLD_STATE;
    const after = applyRecordEvent(base, { ...createdInput(), seq: 1 });
    expect(after.identity?.id).toBe("sa-test-1");
    expect(base.identity).toBeUndefined();
    expect(base.lastSeq).toBe(0);
  });

  it("空序列 / 残文件（无 created 帧）宽容：identity 缺席不炸", () => {
    expect(foldRecordEvents([])).toEqual(INITIAL_RECORD_EVENT_FOLD_STATE);
    const orphan = foldRecordEvents([{ type: "record-round-idle", seq: 1, ts: 1, round: 1, stopReason: "completed", turns: 1, totalTokens: 1 }]);
    expect(orphan.identity).toBeUndefined();
    expect(orphan.roundIdle?.turns).toBe(1);
  });
});

describe("journal 写读闭环（append → scan → fold）", () => {

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-events-unit-"));
  });

  afterEach(() => {
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("落盘事件经 scan 回读后 fold，与内存构造的事件 fold 等价", async () => {
    const journal = createRecordEventStream(() => journalDir);
    const appended: RecordEvent[] = [];
    appended.push(await journal.append("sa-1", createdInput()));
    appended.push(
      await journal.append("sa-1", {
        type: "record-round-started",
        ts: 1780000001000,
        round: 1,
        epoch: 0,
      }),
    );
    appended.push(await journal.append("sa-1", settledInput()));
    const scanned = await journal.scan("sa-1");
    expect(foldRecordEvents(scanned)).toEqual(foldRecordEvents(appended));
  });

  it("scan 非头行起始的文件：头行缺席时事件照常解析（头行是写侧契约，读侧宽容）", async () => {
    // 手工构造无头行文件（外部工具产物/历史残骸形态）——读侧不得依赖头行存在
    const filePath = recordEventsPath(journalDir, "sa-2");
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ ...createdInput({ id: "sa-2" }), seq: 1 })}\n`,
      "utf8",
    );
    const events = await createRecordEventStream(() => journalDir).scan("sa-2");
    expect(events.map((e) => e.type)).toEqual(["record-created"]);
    expect(events[0]?.seq).toBe(1);
  });
});
// 来源段：event-tail.test.ts
//
// [W1 / D6 → event-push-channel W-P3] journal tail 读取原语测试：完整行边界
// （纯函数）/ offset 续读 / 部分行 / 坏行宽容 / 截断重读。目录 watch 族测试随
// watch 三原语退役删除（实时性归推送通道，见 event-tail.ts 头注）。
//
// 验收⑤锚：fixture（含中部坏行、不完整尾行）上「分多次续读拼接」与「一次全量
// 读 + fold」等价（run/record 两域共用的域无关原语——本套件用 record 域解析器
// 作真实注入点，另以裸行解析器覆盖域无关分支）。
//
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。

let workDir: string;

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

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "event-tail-unit-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
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

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "event-tail-unit-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("首次全量读：头行 + 事件行（域解析器注入）", async () => {
    const journal = createRecordEventStream(() => workDir);
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

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "event-tail-unit-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("分三段续读（中途注入坏行/部分行）的事件并集，与一次全量读 + fold 等价", async () => {
    const recordsDir = path.join(workDir, "records");
    fs.mkdirSync(recordsDir);
    const journal = createRecordEventStream(() => recordsDir);
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
// 来源段：record-identity-fold.test.ts
//
// [身份换源] 子文件无 identity entry 时，身份域从事件流折叠取得
// （record-store.scanFile：identity entry → **事件流折叠**；[身份换源第二步] 后
// binding 兜底路径已退场，折叠是 identity entry 之外的唯一身份源，统计域同源）。
//
// 背景（event-sourcing 收敛）：`.state` 收条与 `.record-binding` 读侧均已退场，
// 事件流是身份域与统计域的唯一事实源（身份域 + model/thinkingLevel/worktree 在
// record-created；sessionFile/engine/engineHandle 在 record-bound；收条与统计在
// record-settled / record-round-idle）。
//
// 本套件锁定的关键难点 = **折叠的 id 入口**：折叠要 record id，而子文件没有 identity
// entry 时 id 无从由身份来。结构性入口 = 事件目录本身（文件名主名即 id，文件内
// record-bound 帧携带 sessionFile）——本套件用「无 binding sidecar」的 fixture 证明
// 身份确实来自折叠路径而非绑定路径（fixture 里没有 .record-binding 文件，断言其不存在）。
//
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。

const STARTED_AT = 1_700_000_000_000;
const RECORD_ID = "sa-fold-1";
/** 目录分区键 fixture（新布局 `<root>/<rootSid>/subagents/`；store 经 getter 注入
 *  显式目录，sid 只须过 shared assertPiSessionId 合法性）。 */
const PARTITION_SID = "sid-identity-fold";

/** engine-CLI 化子 session 文件 fixture：{session, message} 条目族，**无身份 entry**。 */
function writeIdentityLessChildSession(sessionsDir: string): string {
  const file = path.join(sessionsDir, "20260910T000000-000_sa-fold-1.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "sess-child",
      timestamp: new Date(STARTED_AT).toISOString(),
      cwd: "/tmp",
    }),
    JSON.stringify({
      type: "message",
      id: "msg-1",
      parentId: null,
      timestamp: new Date(STARTED_AT + 1000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first round done" }],
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: STARTED_AT + 1000,
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
  return file;
}

/** 事件流身份 fixture：record-created（全身份域 + model/thinkingLevel/worktree）。
 *  经生产 journal 写入（非手写帧——seq 分配与头行契约单源）。 */
async function seedCreatedFrame(recordsDir: string): Promise<void> {
  const journal = createRecordEventStream(() => recordsDir);
  await journal.append(RECORD_ID, {
    type: "record-created",
    ts: STARTED_AT,
    id: RECORD_ID,
    agent: "general-purpose",
    task: "fold identity task",
    slug: "fold-slug",
    origin: "workflow",
    parentRunId: "wf-run-fold",
    stepIndex: 3,
    rootSessionId: "root-session",
    parentRecordId: "sa-parent",
    depth: 1,
    mode: "background",
    startedAt: STARTED_AT,
    model: "prov/model-fold",
    thinkingLevel: "high",
    worktree: true,
  });
}

/** 损坏身份 fixture：record-created 载荷 task 为 number（类型漂移）。
 *  手写帧——损坏形态无法经生产 journal（类型层已拒绝），只能直接落盘构造。 */
function seedCorruptCreatedFrame(recordsDir: string, sessionFile: string): void {
  const created = {
    type: "record-created",
    seq: 1,
    ts: STARTED_AT,
    id: RECORD_ID,
    agent: "general-purpose",
    task: 42,
    slug: "fold-slug",
    origin: "tool",
    rootSessionId: "root-session",
    depth: 0,
    mode: "background",
    startedAt: STARTED_AT,
  };
  const bound = {
    type: "record-bound",
    seq: 2,
    ts: STARTED_AT + 500,
    sessionFile,
    engine: "pi",
    engineHandle: { sessionRef: { recordId: RECORD_ID }, poolKey: "shared" },
    epoch: 1,
  };
  fs.writeFileSync(
    recordEventsPath(recordsDir, RECORD_ID),
    `${JSON.stringify(toRecordEventHeader(RECORD_ID))}\n${JSON.stringify(created)}\n${JSON.stringify(bound)}\n`,
    "utf-8",
  );
}

/** record-bound 帧（折叠路径与子文件的唯一结构链接：sessionFile）。 */
async function seedBoundFrame(recordsDir: string, sessionFile: string): Promise<void> {
  const journal = createRecordEventStream(() => recordsDir);
  await journal.append(RECORD_ID, {
    type: "record-bound",
    ts: STARTED_AT + 500,
    sessionFile,
    engine: "pi",
    engineHandle: { sessionRef: { recordId: RECORD_ID }, poolKey: "shared" },
    epoch: 1,
  });
}

/** 终局帧（收条换源面：终态收条 = 折叠结果，非 .state sidecar）。 */
async function seedSettledFrame(recordsDir: string): Promise<void> {
  const journal = createRecordEventStream(() => recordsDir);
  await journal.append(RECORD_ID, {
    type: "record-settled",
    ts: STARTED_AT + 2000,
    stopReason: "completed",
    outcome: "completed",
    endedAt: STARTED_AT + 2000,
    turns: 1,
    totalTokens: 30,
  });
}

describe("[身份换源] 无 identity entry 子文件的身份域 = 事件流折叠", () => {
  let agentDir: string;
  let sessionsDir: string;
  let recordsDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-identity-fold-"));
    sessionsDir = getSubagentSessionDir(PARTITION_SID, agentDir);
    recordsDir = getSubagentRecordsDir(PARTITION_SID, agentDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(recordsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("created + bound + settled 事件在（无 .record-binding）→ collectRecords 重建，身份字段与收条全部来自折叠", async () => {
    const file = writeIdentityLessChildSession(sessionsDir);
    await seedCreatedFrame(recordsDir);
    await seedBoundFrame(recordsDir, file);
    await seedSettledFrame(recordsDir);
    // 负前提（本用例的全部意义）：「绑定路径不存在」——identity 只可能来自折叠。
    expect(fs.existsSync(`${file}${RECORD_BINDING_SIDECAR_EXT}`)).toBe(false);

    const store = new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir);
    const records = store.collectRecords(10, "all", undefined, true);

    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.id).toBe(RECORD_ID);
    // 身份域（record-created 载荷）
    expect(rec.agent).toBe("general-purpose");
    expect(rec.task).toBe("fold identity task");
    expect(rec.slug).toBe("fold-slug");
    expect(rec.startedAt).toBe(STARTED_AT);
    expect(rec.rootSessionId).toBe("root-session");
    expect(rec.parentRecordId).toBe("sa-parent");
    expect(rec.depth).toBe(1);
    expect(rec.origin).toBe("workflow");
    expect(rec.parentRunId).toBe("wf-run-fold");
    expect(rec.stepIndex).toBe(3);
    // 绑定侧独有字段（随「事件流承载」进 record-created）：model/thinkingLevel/worktree
    expect(rec.model).toBe("prov/model-fold");
    expect(rec.thinkingLevel).toBe("high");
    expect(rec.worktree).toBe(true);
    // 子文件锚（折叠路径必须把扫描到的文件路径带回 base）
    expect(rec.sessionFile).toBe(file);
    // 终态收条（折叠的 record-settled 帧，非 .state sidecar）
    expect(rec.status).toBe("idle");
    expect(rec.stopReason).toBe("completed");
    // [② 读侧换源] 统计域已换源折叠收条：endedAt/turns/totalTokens 取 settled 帧
    //（原 binding 快照派生视图随读侧换源退场——登记项的落地翻转）。
    expect(rec.endedAt).toBe(STARTED_AT + 2000);
    expect(rec.turns).toBe(1);
    expect(rec.totalTokens).toBe(30);
  });

  it("对照组：无事件文件也无绑定 → 不重建（证明重建确由折叠路径承载，不是别的兜底）", () => {
    writeIdentityLessChildSession(sessionsDir);

    const store = new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir);
    expect(store.collectRecords(10, "all", undefined, true)).toEqual([]);
  });

  it("边界：有事件文件但缺 record-bound 帧（无 sessionFile 链接）→ 不重建（id 入口是结构性链接，不猜测）", async () => {
    writeIdentityLessChildSession(sessionsDir);
    await seedCreatedFrame(recordsDir);

    const store = new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir);
    expect(store.collectRecords(10, "all", undefined, true)).toEqual([]);
  });

  it("fold 身份路径不认损坏载荷：record-created 身份域类型漂移 → 不重建（零幻影——损坏残留不误判成身份）", async () => {
    const file = writeIdentityLessChildSession(sessionsDir);
    seedCorruptCreatedFrame(recordsDir, file);

    const store = new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir);
    expect(store.collectRecords(10, "all", undefined, true)).toEqual([]);
  });

  it("折叠路径命中后 findLightById 可直查（id→file 索引随扫描建立）", async () => {
    const file = writeIdentityLessChildSession(sessionsDir);
    await seedCreatedFrame(recordsDir);
    await seedBoundFrame(recordsDir, file);

    const store = new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir);
    expect(store.collectRecords(10, "all", undefined, true)).toHaveLength(1);
    expect(store.findLightById(RECORD_ID)?.id).toBe(RECORD_ID);
  });
});
// 来源段：record-store-rebuild-v-gate.test.ts
//
// record 读侧：主 session entry 通道的版本门（当前只剩 v2）。
//
// 两面：
//   1. 版本门零幻影（登记 §3.3）：v1 全量快照兼容层已随兼容层删除，entry 通道
//      只剩当前版本——非当前版本（v1 快照 / future-v / missing-v）与未知 kind
//      的行在 collectV2EntryPairs 结构性跳过（不猜测、不产半构造派生视图）；
//   2. v2 条目对 → record 派生视图：身份域取注册条目（缺注册条目不成实体 → null），
//      终局域取终态条目；无终态条目 = running（引擎域回落 journal 的 bound 事件，
//      终态条目在场时优先）；条目契约不承载的字段（详情域 / patchFile / worktree
//      / round / batchFinalized）一律缺席。
//
// [身份换源第二步] 原第三面（resolveRecordIdentity 三级优先级参考实现）随 binding
// 兜底路径退场删除；fold 身份路径的检查锚定在 record-identity-fold.test.ts。
//
// fixture 自持：本文件局部构造 v2 条目 JSONL 行与最小 record（record-entry-collect
// .test.ts 的 makeRecord 同款先例；helpers/ 下资产归各邻近测试的领地）。

// ── fixture ───────────────────────────────────────────────────

/** 主 session 的 custom entry 行（appendEntry 落盘即此产物形态）。 */
function entryLine(data: unknown): string {
  return JSON.stringify({
    type: "custom",
    id: `e-${Math.random().toString(36).slice(2)}`,
    parentId: null,
    customType: "subagent-record",
    data,
  });
}

const V2_REGISTERED: SubagentRecordRegisteredEntryData = {
  v: 2,
  kind: "registered",
  id: "sa-v2",
  agent: "/home/u/agents/worker.md",
  task: "fix the flaky test",
  slug: "worker",
  origin: "workflow",
  parentRunId: "wf-1",
  stepIndex: 0,
  rootSessionId: "root-A",
  parentRecordId: undefined,
  depth: 1,
  startedAt: 1780000000000,
};

const V2_SETTLED: SubagentRecordSettledEntryData = {
  v: 2,
  kind: "settled",
  id: "sa-v2",
  status: "idle",
  stopReason: "completed",
  outcome: "completed",
  endedAt: 1780000123000,
  turns: 3,
  totalTokens: 4500,
  model: "prov/m1",
  thinkingLevel: undefined,
  engine: "zcode",
  engineHandle: { sessionRef: { sessionId: "s-1", dbPath: "/tmp/db.sqlite" }, poolKey: "shared" },
  sessionFile: "/tmp/sessions/sa-v2.jsonl",
  result: "done: 3 tests fixed",
};

/** 已删除的 v1 全量快照形态（旧写点产物）——现行读侧必须整体跳过。 */
function v1SnapshotLine(over: Record<string, unknown> = {}): string {
  return entryLine({
    v: 1,
    id: "sa-v1",
    agent: "/home/u/agents/worker.md",
    task: "t",
    slug: "worker",
    status: "idle",
    stopReason: "completed",
    mode: "background",
    startedAt: 1000,
    rootSessionId: "root-A",
    parentRecordId: undefined,
    depth: 0,
    endedAt: 2000,
    turns: 1,
    totalTokens: 42,
    model: "prov/m1",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    ...over,
  });
}

const BOUND_EVENT: RecordBoundEvent = {
  type: "record-bound",
  seq: 2,
  ts: 1780000001000,
  sessionFile: "/tmp/sessions/sa-bound.jsonl",
  engine: "pi",
  engineHandle: { sessionRef: { sessionId: "s-bound" }, poolKey: "shared" },
  epoch: 0,
};

// ── 1. 版本门：非当前版本 / 未知 kind 跳过（零幻影）──────────────

describe("collectV2EntryPairs：entry 通道版本门（非当前版本跳过，零幻影）", () => {
  it("registered + settled 同 id 两行 → 成对收集", () => {
    const pairs = collectV2EntryPairs([entryLine(V2_REGISTERED), entryLine(V2_SETTLED)].join("\n") + "\n");
    expect(pairs.size).toBe(1);
    const pair = pairs.get("sa-v2");
    expect(pair?.registered?.kind).toBe("registered");
    expect(pair?.settled?.kind).toBe("settled");
    expect(pair?.settled?.result).toBe("done: 3 tests fixed");
  });

  it("同 kind 后写覆盖前行（末次注册 / 末次终态为权威）", () => {
    const content = [
      entryLine(V2_REGISTERED),
      entryLine({ ...V2_REGISTERED, task: "second task" }),
      entryLine({ ...V2_SETTLED, endedAt: 1780009999000 }),
      entryLine(V2_SETTLED),
    ].join("\n") + "\n";
    const pair = collectV2EntryPairs(content).get("sa-v2");
    expect(pair?.registered?.task).toBe("second task");
    expect(pair?.settled?.endedAt).toBe(1780000123000);
  });

  it("v1 全量快照形态（v:1）跳过——旧写点形态不进任何解析路径", () => {
    const pairs = collectV2EntryPairs(v1SnapshotLine() + "\n");
    expect(pairs.size).toBe(0);
  });

  it("future-v / unknown-kind / missing-v → 跳过（不认识的版本跳过而非猜测）", () => {
    const content = [
      entryLine({ ...V2_REGISTERED, v: 3 }),
      entryLine({ ...V2_REGISTERED, kind: "snapshot" }),
      // missing-v：无版本标记的形态（写点恒写 v，缺失即形态损坏）
      entryLine({ id: "sa-nov", kind: "registered", agent: "a", task: "t", startedAt: 1 }),
    ].join("\n") + "\n";
    expect(collectV2EntryPairs(content).size).toBe(0);
  });

  it("非本类型 / 截断行 / 非对象 data / 缺 id 行忽略（行级 best-effort 不抛）", () => {
    const content = [
      JSON.stringify({ type: "custom", customType: "other", data: V2_REGISTERED }),
      '{"type":"custom","customType":"subagent-record","data":',
      entryLine(null),
      entryLine({ ...V2_REGISTERED, id: 42 }),
      entryLine(V2_REGISTERED),
    ].join("\n") + "\n";
    const pairs = collectV2EntryPairs(content);
    expect(pairs.size).toBe(1);
    expect(pairs.get("sa-v2")?.registered).toBeDefined();
  });
});

// ── 2. v2 条目对 → record 派生视图（身份域注册条目 / 终局域终态条目）──

describe("v2PairToRecord：v2 条目对 → record 派生视图", () => {
  it("registered + settled → 身份域取注册条目，终局域取终态条目", () => {
    const rec = v2PairToRecord("sa-v2", { registered: V2_REGISTERED, settled: V2_SETTLED });
    expect(rec).not.toBeNull();
    expect(rec).toMatchObject({
      id: "sa-v2",
      agent: "/home/u/agents/worker.md",
      task: "fix the flaky test",
      slug: "worker",
      origin: "workflow",
      parentRunId: "wf-1",
      stepIndex: 0,
      rootSessionId: "root-A",
      parentRecordId: undefined,
      depth: 1,
      startedAt: 1780000000000,
      status: "idle",
      stopReason: "completed",
      outcome: "completed",
      endedAt: 1780000123000,
      turns: 3,
      totalTokens: 4500,
      model: "prov/m1",
      engine: "zcode",
      sessionFile: "/tmp/sessions/sa-v2.jsonl",
      result: "done: 3 tests fixed",
      mode: "background",
    });
    expect(rec?.engineHandle).toEqual(V2_SETTLED.engineHandle);
  });

  it("条目契约不承载的字段一律缺席（详情域 / patchFile / worktree / round / batchFinalized）", () => {
    const rec = v2PairToRecord("sa-v2", { registered: V2_REGISTERED, settled: V2_SETTLED });
    expect(rec?.eventLog).toEqual([]);
    expect(rec?.displayItems).toEqual([]);
    expect(rec?.patchFile).toBeUndefined();
    expect(rec?.worktree).toBeUndefined();
    expect(rec?.round).toBeUndefined();
    expect(rec?.batchFinalized).toBeUndefined();
    expect(rec?.closedReason).toBeUndefined();
  });

  it("只有注册条目 → running（终局域零值/缺席）", () => {
    const rec = v2PairToRecord("sa-v2", { registered: V2_REGISTERED });
    expect(rec).toMatchObject({
      id: "sa-v2",
      status: "running",
      turns: 0,
      totalTokens: 0,
      endedAt: undefined,
      result: undefined,
      error: undefined,
    });
    // 终局域缺席（键不落）而非 undefined 占位——与写侧派生视图同口径
    expect(rec?.stopReason).toBeUndefined();
    expect(rec?.outcome).toBeUndefined();
  });

  it("缺注册条目 → null（身份无所出不成实体：仅终态行 / 空对都不成行）", () => {
    expect(v2PairToRecord("sa-v2", { settled: V2_SETTLED })).toBeNull();
    expect(v2PairToRecord("sa-v2", {})).toBeNull();
  });

  it("无终态条目时引擎域回落 bound 事件（引擎/sessionFile/engineHandle）", () => {
    const rec = v2PairToRecord("sa-v2", { registered: V2_REGISTERED }, BOUND_EVENT);
    expect(rec?.status).toBe("running");
    expect(rec?.engine).toBe("pi");
    expect(rec?.sessionFile).toBe("/tmp/sessions/sa-bound.jsonl");
    expect(rec?.engineHandle).toEqual(BOUND_EVENT.engineHandle);
  });

  it("无终态条目且无 bound → 引擎域缺席（不产半构造引擎锚）", () => {
    const rec = v2PairToRecord("sa-v2", { registered: V2_REGISTERED });
    expect(rec?.engine).toBeUndefined();
    expect(rec?.sessionFile).toBeUndefined();
    expect(rec?.engineHandle).toBeUndefined();
  });

  it("终态条目与 bound 事件同时在场 → 终态条目胜出", () => {
    const rec = v2PairToRecord("sa-v2", { registered: V2_REGISTERED, settled: V2_SETTLED }, BOUND_EVENT);
    expect(rec?.engine).toBe("zcode");
    expect(rec?.sessionFile).toBe("/tmp/sessions/sa-v2.jsonl");
    expect(rec?.engineHandle).toEqual(V2_SETTLED.engineHandle);
  });

  it("端到端：混合 v1 快照行的主 session 全文 → 每 id 一条 record（v1 行像不存在）", () => {
    const content = [
      v1SnapshotLine(),
      entryLine(V2_REGISTERED),
      entryLine(V2_SETTLED),
      entryLine({ ...V2_REGISTERED, id: "sa-run", task: "still running" }),
    ].join("\n") + "\n";
    const records = [...collectV2EntryPairs(content)]
      .map(([id, pair]) => v2PairToRecord(id, pair, BOUND_EVENT))
      .filter((r) => r !== null);
    expect(records.map((r) => r.id).sort()).toEqual(["sa-run", "sa-v2"]);
    const settled = records.find((r) => r.id === "sa-v2");
    const running = records.find((r) => r.id === "sa-run");
    expect(settled).toMatchObject({ status: "idle", stopReason: "completed", turns: 3, engine: "zcode" });
    expect(running).toMatchObject({ status: "running", task: "still running", engine: "pi" });
  });
});

// ── [身份换源第二步] 原第三面（resolveRecordIdentity 三级优先级）已随 binding
// 兜底路径退场删除——fold 身份路径检查锚定在 record-identity-fold.test.ts。

// ── 3. buildRecord：重建单规则的 lastError 透传（subagent-observability §3.3.5）──
//
// 全量重建分支（ReconstructedRecord）携带 session jsonl 扫描的错误事实
// lastError——透传缺位则 list 条目（r.lastError）在全量重建读侧恒缺席；light
// 分支详情字段缺省口径不变。

describe("buildRecord：lastError 透传（subagent-observability §3.3.5）", () => {
  const identityFields = {
    id: "sa-recon",
    agent: "worker",
    mode: "background" as const,
    task: "t",
    slug: "s",
    startedAt: 1000,
    rootSessionId: "root-A",
    parentRecordId: undefined,
    depth: 0,
    forkDepth: undefined,
    origin: undefined,
    parentRunId: undefined,
    stepIndex: undefined,
  };

  it("全量重建分支透传 base.lastError", () => {
    const base: ReconstructedRecord = {
      ...identityFields,
      sessionFile: "/tmp/sessions/sa-recon.jsonl",
      status: "idle",
      turns: [],
      turnCount: 2,
      totalTokens: 30,
      lastError: "boom: engine died",
      model: undefined,
      thinkingLevel: undefined,
      endedAt: 2000,
      result: "partial output",
      error: "boom: engine died",
      eventLog: [],
    };
    const rec = buildRecord(base, { state: undefined, jsonlMtimeMs: 1 });
    expect(rec.lastError).toBe("boom: engine died");
  });

  it("light 分支 lastError 缺省（详情字段懒补口径不变）", () => {
    const base: IdentityHeaderRecon = {
      ...identityFields,
      model: undefined,
      thinkingLevel: undefined,
      sessionFile: "/tmp/sessions/sa-recon.jsonl",
    };
    const rec = buildRecord(base, { state: undefined, jsonlMtimeMs: 1 });
    expect(rec.lastError).toBeUndefined();
  });
});

// ── 4. lastRoundFromFold：result 摘要锚的空串保真（subagent-observability
//    §3.3.3 空正文语义）——读侧可区分「空串 = 无文本输出」与「缺席 = 未记录」；
//    旧帧（无 resultSummary 键）行为不变（存量零迁移锁定）。

describe("lastRoundFromFold：resultSummary 空串保真与旧帧缺席", () => {
  const idleBase = {
    type: "record-round-idle",
    ts: 900,
    round: 1,
    turns: 1,
    totalTokens: 10,
  } as const;

  it("收条帧 resultSummary 空串 → lastRound.result 空串（键在场，非异常不告警语义）", () => {
    const fold = foldRecordEvents([{ ...idleBase, seq: 1, resultSummary: "" }]);
    const lastRound = lastRoundFromFold(fold);
    expect(lastRound).toBeDefined();
    expect(lastRound).toHaveProperty("result", "");
  });

  it("收条帧无 resultSummary（旧帧形态）→ lastRound 无 result 键（缺席 = 未记录，不伪造空串）", () => {
    const fold = foldRecordEvents([{ ...idleBase, seq: 1 }]);
    const lastRound = lastRoundFromFold(fold);
    expect(lastRound).toBeDefined();
    expect(lastRound).not.toHaveProperty("result");
  });
});
