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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyRecordEvent,
  createRecordEventJournal,
  foldRecordEvents,
  INITIAL_RECORD_EVENT_FOLD_STATE,
  isRecordJournalHeader,
  parseRecordEventFileLine,
  parseRecordEventLine,
  RECORD_EVENT_TYPES,
  recordEventsPath,
  RECORD_EVENTS_SUFFIX,
  RECORD_EVENTS_HEADER_TYPE,
  toRecordJournalHeader,
  type RecordCreatedEvent,
  type RecordJournalEvent,
  type RecordJournalEventInput,
  type RecordSettledEvent,
} from "../persistence/record-events.ts";

let recordsDir: string;

beforeEach(() => {
  recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-events-unit-"));
});

afterEach(() => {
  fs.rmSync(recordsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

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

describe("词表钉住（D3 映射表逐项对应——恰好 6 类）", () => {
  it("事件类型全集恰为 6 类且互异（增删须先改设计 D3 表）", () => {
    expect([...RECORD_EVENT_TYPES]).toEqual([
      "record-created",
      "record-bound",
      "record-round-started",
      "record-round-idle",
      "record-settled",
      "record-reopened",
    ]);
    expect(new Set(RECORD_EVENT_TYPES).size).toBe(RECORD_EVENT_TYPES.length);
  });

  it("头行 type 与事件词表命名空间不相交（头行不是事件——fold 不会误吞）", () => {
    expect(RECORD_EVENT_TYPES).not.toContain(RECORD_EVENTS_HEADER_TYPE);
  });
});

describe("首行头行形态（写侧契约：文件创建时恰一行）", () => {
  it("头行序列化形态 = {\"type\":\"record-events\",\"id\":...}", () => {
    expect(JSON.stringify(toRecordJournalHeader("sa-1"))).toBe('{"type":"record-events","id":"sa-1"}');
  });

  it("isRecordJournalHeader 判定（id 非空字符串）", () => {
    expect(isRecordJournalHeader({ type: "record-events", id: "sa-1" })).toBe(true);
    expect(isRecordJournalHeader({ type: "record-events" })).toBe(false);
    expect(isRecordJournalHeader({ type: "record-events", id: "" })).toBe(false);
    expect(isRecordJournalHeader({ type: "record-created", id: "sa-1" })).toBe(false);
    expect(isRecordJournalHeader(null)).toBe(false);
  });

  it("首写自动落头行 + 首事件（文件创建点）；续写不重复头行", async () => {
    const journal = createRecordEventJournal(recordsDir);
    await journal.append("sa-1", createdInput());
    await journal.append("sa-1", settledInput());
    const content = fs.readFileSync(recordEventsPath(recordsDir, "sa-1"), "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(3);
    expect(isRecordJournalHeader(JSON.parse(lines[0]!))).toBe(true);
    expect(JSON.parse(lines[1]!).type).toBe("record-created");
    expect(JSON.parse(lines[2]!).type).toBe("record-settled");
  });
});

describe("journal 读写原语（seq 单调分配 / scan 宽容解析）", () => {
  it("append 分配行级单调 seq（1 起严格递增）并返回完整事件", async () => {
    const journal = createRecordEventJournal(recordsDir);
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
    await createRecordEventJournal(recordsDir).append("sa-1", createdInput());
    const second = await createRecordEventJournal(recordsDir).append("sa-1", settledInput());
    expect(second.seq).toBe(2);
  });

  it("scan 返回写入序事件（头行不在其中）", async () => {
    const journal = createRecordEventJournal(recordsDir);
    await journal.append("sa-1", createdInput());
    await journal.append("sa-1", settledInput());
    const events = await journal.scan("sa-1");
    expect(events.map((e) => e.type)).toEqual(["record-created", "record-settled"]);
  });

  it("scan 对不存在文件返回空流（record 未落账 / 已清理）", async () => {
    expect(await createRecordEventJournal(recordsDir).scan("sa-none")).toEqual([]);
  });

  it("scan 中部坏行宽容跳过（不完整 JSON 行）——事件流不因坏行截断", async () => {
    const journal = createRecordEventJournal(recordsDir);
    await journal.append("sa-1", createdInput());
    await journal.append("sa-1", settledInput());
    // 手工注入坏行于两事件之间（模拟磁盘半写/外部编辑）
    const filePath = recordEventsPath(recordsDir, "sa-1");
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    fs.writeFileSync(filePath, [lines[0], lines[1], '{"type":"record-settled", "trunc', lines[2]].join("\n") + "\n");
    const events = await journal.scan("sa-1");
    expect(events.map((e) => e.type)).toEqual(["record-created", "record-settled"]);
  });

  it("record id 白名单：路径穿越形态拒绝（防 ../ 注入）", () => {
    expect(() => recordEventsPath(recordsDir, "../evil")).toThrow(/非法 record id/);
    expect(() => recordEventsPath(recordsDir, ".hidden")).toThrow(/非法 record id/);
    expect(recordEventsPath(recordsDir, "sa-1").endsWith(`sa-1${RECORD_EVENTS_SUFFIX}`)).toBe(true);
  });
});

describe("行解析（parseRecordEventLine / parseRecordEventFileLine）", () => {
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
  /** 全生命周期样例序列（含 round 往返与 reopen 回边）。 */
  function lifecycleEvents(): RecordJournalEvent[] {
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
    const regressed: RecordJournalEvent[] = [
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
  it("落盘事件经 scan 回读后 fold，与内存构造的事件 fold 等价", async () => {
    const journal = createRecordEventJournal(recordsDir);
    const appended: RecordJournalEvent[] = [];
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
    const filePath = recordEventsPath(recordsDir, "sa-2");
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ ...createdInput({ id: "sa-2" }), seq: 1 })}\n`,
      "utf8",
    );
    const events = await createRecordEventJournal(recordsDir).scan("sa-2");
    expect(events.map((e) => e.type)).toEqual(["record-created"]);
    expect(events[0]?.seq).toBe(1);
  });
});
