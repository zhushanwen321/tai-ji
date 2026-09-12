// src/execution/__tests__/record-origin.test.ts
//
// record 来源身份 origin/parentRunId（H2 W1，设计 subagent-workflow-record-unification
// §3.3 D1）持久化链 + 查询面 + 治理面负向规格。
//
// 锁四件事：
//   1. 持久化链往返保真：register 落盘（recordToSubagent → toSubagentRecordEntry →
//      真实 JSONL 序列化）→ scanLastRecordEntries 重建（collectLastRecordEntries →
//      rebuildEntryRecord 真实路径）→ 两字段不丢。禁手工构造对象绕过 schema——entry
//      data 一律来自 store.register 的真实落盘产物。
//   2. 缺省负向：无 origin 的存量 record 落盘产物不含 origin 键（零迁移），重建后
//      origin === undefined（= "tool" 语义）。
//   3. 查询面：collectRecords 缺省过滤 origin==="workflow"（includeWorkflow 缺省
//      false）、includeWorkflow:true 放行；collectRecordsByParentRunId 按 run id
//      精确列 record（内存 ∪ 磁盘重建口径，不过滤 origin）。
//   4. 治理面负向保证（D1⑥）：recoverEntryOnlyOrphans / 重建投影不因 origin 过滤——
//      workflow 来源的 entry-only 孤儿照样被终态化收敛，且终态 entry 保留 origin。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

const { saveIndexMock } = vi.hoisted(() => ({
  saveIndexMock: vi.fn(() => Promise.resolve()),
}));
vi.mock("../sessions-index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions-index.ts")>();
  return { ...actual, saveIndex: saveIndexMock };
});

import { createRecord } from "../execution-record.ts";
import { SUBAGENT_RECORD_CUSTOM_TYPE, toSubagentRecordEntry } from "../record-entry.ts";
import type { SubagentRecordEntryData } from "../record-entry.ts";
import { RecordStore } from "../record-store.ts";
import type { ExecutionRecord } from "../types.ts";

/** 构造 ExecutionRecord（base 默认 running one-shot，over 覆盖任意字段）。 */
function makeRecord(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const base = createRecord("bg-origin", {
    agent: "worker",
    model: "m",
    mode: "background",
    task: "t",
    slug: "origin-test",
    startedAt: 1000,
    rootSessionId: "sess-origin",
    // 对齐生产 register 路径（one-shot 显式 false）
    chatMode: false,
  });
  return { ...base, ...over };
}

/** 捕获 register/archive/reportRecordTransition 落盘 entry 的 fake pi。 */
function makeCapturePi(captured: SubagentRecordEntryData[]): { appendEntry: (customType: string, data: unknown) => void } {
  return {
    appendEntry: (customType: string, data: unknown) => {
      if (customType !== SUBAGENT_RECORD_CUSTOM_TYPE) return;
      captured.push(data as SubagentRecordEntryData);
    },
  };
}

/** 把捕获的 entry data 写成主 session JSONL 行（pi appendEntry 的落盘产物形态）。 */
function writeMainSessionFile(filePath: string, entries: SubagentRecordEntryData[]): void {
  const lines = entries.map((data) =>
    JSON.stringify({
      type: "custom",
      id: `entry-${data.id}-${entries.indexOf(data)}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: SUBAGENT_RECORD_CUSTOM_TYPE,
      data,
    }),
  );
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
}

describe("record origin/parentRunId 持久化链（H2 W1）", () => {
  let rootDir: string;
  let tmpDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-origin-test-"));
    tmpDir = path.join(rootDir, "sessions");
    fs.mkdirSync(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("entry 往返保真：origin=workflow + parentRunId 经真实落盘/重建后两字段不丢", () => {
    const store = new RecordStore(tmpDir);
    const captured: SubagentRecordEntryData[] = [];
    store.setPi(makeCapturePi(captured));

    const rec = makeRecord({ id: "wf-step-1", origin: "workflow", parentRunId: "wf-run-1" });
    store.register(rec);
    expect(captured).toHaveLength(1);
    expect(captured[0].origin).toBe("workflow");
    expect(captured[0].parentRunId).toBe("wf-run-1");

    // 真实重建路径：落盘产物 → 主 session JSONL → scanLastRecordEntries
    const mainFile = path.join(rootDir, "main.jsonl");
    writeMainSessionFile(mainFile, captured);
    const rebuilt = store.scanLastRecordEntries(mainFile);
    const hit = rebuilt.find((r) => r.id === "wf-step-1");
    expect(hit).toBeDefined();
    expect(hit?.origin).toBe("workflow");
    expect(hit?.parentRunId).toBe("wf-run-1");
  });

  it("缺省负向：存量 record（无 origin）落盘产物不含新键（零迁移），重建后 origin undefined（=tool 语义）", () => {
    const store = new RecordStore(tmpDir);
    const captured: SubagentRecordEntryData[] = [];
    store.setPi(makeCapturePi(captured));

    store.register(makeRecord({ id: "legacy-1" }));
    expect(captured).toHaveLength(1);
    // 零迁移：JSON 序列化产物不含 origin/parentRunId 键（undefined 自然缺省）。
    // 必须断言序列化后形态——内存对象保留 undefined 键名（record-store.test.ts 同坑：
    // 真实 JSONL 丢 undefined 值），键级/子串断言都会误判。
    const persistedKeys = Object.keys(JSON.parse(JSON.stringify(captured[0])) as Record<string, unknown>);
    expect(persistedKeys).not.toContain("origin");
    expect(persistedKeys).not.toContain("parentRunId");

    const mainFile = path.join(rootDir, "main.jsonl");
    writeMainSessionFile(mainFile, captured);
    const rebuilt = store.scanLastRecordEntries(mainFile);
    const hit = rebuilt.find((r) => r.id === "legacy-1");
    expect(hit).toBeDefined();
    expect(hit?.origin).toBeUndefined();
    expect(hit?.parentRunId).toBeUndefined();
  });

  it("重建投影不过滤（D1⑤）：workflow 来源 record 经重建通路全量返回", () => {
    const store = new RecordStore(tmpDir);
    const captured: SubagentRecordEntryData[] = [];
    store.setPi(makeCapturePi(captured));

    store.register(makeRecord({ id: "wf-step-2", origin: "workflow", parentRunId: "wf-run-2" }));
    const mainFile = path.join(rootDir, "main.jsonl");
    writeMainSessionFile(mainFile, captured);
    // scanLastRecordEntries 是恢复链（recoverOrphanRecords）与查询共享的重建投影——
    // 此处必须返回 workflow record 全量（过滤只在查询消费面，不在重建投影）。
    const rebuilt = store.scanLastRecordEntries(mainFile);
    expect(rebuilt.map((r) => r.id)).toContain("wf-step-2");
  });
});

describe("collectRecords includeWorkflow 查询面（H2 W1）", () => {
  let rootDir: string;
  let tmpDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-origin-query-"));
    tmpDir = path.join(rootDir, "sessions");
    fs.mkdirSync(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeStore(): RecordStore {
    return new RecordStore(tmpDir);
  }

  it("缺省过滤 origin=workflow（tool record 可见），includeWorkflow:true 放行", () => {
    const store = makeStore();
    store.register(makeRecord({ id: "tool-1" }));
    store.register(makeRecord({ id: "wf-1", origin: "workflow", parentRunId: "run-A" }));

    // 缺省（includeWorkflow=false）：workflow record 不可见
    const def = store.collectRecords(50, "all", "sess-origin");
    expect(def.map((r) => r.id)).toContain("tool-1");
    expect(def.map((r) => r.id)).not.toContain("wf-1");

    // includeWorkflow:true：全量可见
    const all = store.collectRecords(50, "all", "sess-origin", true);
    expect(all.map((r) => r.id)).toEqual(expect.arrayContaining(["tool-1", "wf-1"]));
  });

  it("origin 缺省（存量内存 record）与显式 tool 均保留（负向判定语义）", () => {
    const store = makeStore();
    store.register(makeRecord({ id: "legacy-no-origin" }));
    store.register(makeRecord({ id: "explicit-tool", origin: "tool" }));
    store.register(makeRecord({ id: "wf-hidden", origin: "workflow", parentRunId: "run-B" }));

    const def = store.collectRecords(50, "all", "sess-origin");
    expect(def.map((r) => r.id)).toEqual(expect.arrayContaining(["legacy-no-origin", "explicit-tool"]));
    expect(def.map((r) => r.id)).not.toContain("wf-hidden");
  });

  it("statusFilter=running 与 includeWorkflow 组合：workflow running 同样被缺省滤除", () => {
    const store = makeStore();
    store.register(makeRecord({ id: "tool-run", status: "running" }));
    store.register(
      makeRecord({ id: "wf-run", status: "running", origin: "workflow", parentRunId: "run-C" }),
    );

    const running = store.collectRecords(50, "running", "sess-origin");
    expect(running.map((r) => r.id)).toEqual(["tool-run"]);

    const runningAll = store.collectRecords(50, "running", "sess-origin", true);
    expect(runningAll.map((r) => r.id)).toEqual(expect.arrayContaining(["tool-run", "wf-run"]));
  });

  it("collectRecordsByParentRunId：按 run id 精确列 record，不过滤 origin（W2/W3 消费口径）", () => {
    const store = makeStore();
    store.register(makeRecord({ id: "tool-orphan" }));
    store.register(makeRecord({ id: "wf-a1", origin: "workflow", parentRunId: "run-X", startedAt: 1000 }));
    store.register(makeRecord({ id: "wf-a2", origin: "workflow", parentRunId: "run-X", startedAt: 2000 }));
    store.register(makeRecord({ id: "wf-other", origin: "workflow", parentRunId: "run-Y" }));

    const runX = store.collectRecordsByParentRunId("run-X", 50, "sess-origin");
    expect(runX.map((r) => r.id).sort()).toEqual(["wf-a1", "wf-a2"]);

    // 空结果：无归属 record / 不存在的 run id
    expect(store.collectRecordsByParentRunId("run-NONE", 50, "sess-origin")).toEqual([]);
  });

  it("collectRecordsByParentRunId 遵循 rootSessionFilter（session 隔离口径同 collectRecords）", () => {
    const store = makeStore();
    store.register(makeRecord({ id: "wf-sessA", origin: "workflow", parentRunId: "run-S", rootSessionId: "sess-A" }));
    store.register(makeRecord({ id: "wf-sessB", origin: "workflow", parentRunId: "run-S", rootSessionId: "sess-B" }));

    expect(store.collectRecordsByParentRunId("run-S", 50, "sess-A").map((r) => r.id)).toEqual(["wf-sessA"]);
    expect(store.collectRecordsByParentRunId("run-S", 50, "sess-B").map((r) => r.id)).toEqual(["wf-sessB"]);
    // 不过滤 session 时两源全回
    expect(store.collectRecordsByParentRunId("run-S", 50).map((r) => r.id).sort()).toEqual([
      "wf-sessA",
      "wf-sessB",
    ]);
  });
});

describe("治理面负向规格（D1⑥：恢复链对 workflow origin 全量可见，禁止过滤）", () => {
  let rootDir: string;
  let tmpDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-origin-govern-"));
    tmpDir = path.join(rootDir, "sessions");
    fs.mkdirSync(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("recoverEntryOnlyOrphans：workflow origin 的 entry-only 孤儿照样终态化（closed+gc），终态 entry 保留 origin", () => {
    const store = new RecordStore(tmpDir);
    const captured: SubagentRecordEntryData[] = [];
    store.setPi(makeCapturePi(captured));

    // 末条 running + origin=workflow 的 entry 落主 session；无子文件锚（entry-only 孤儿）
    const orphan = makeRecord({ id: "wf-orphan", origin: "workflow", parentRunId: "run-G" });
    store.register(orphan);
    const mainFile = path.join(rootDir, "main.jsonl");
    writeMainSessionFile(mainFile, captured);

    // 新 store（模拟重启后内存恒空）执行恢复链
    const recovered: SubagentRecordEntryData[] = [];
    const store2 = new RecordStore(tmpDir);
    store2.setPi(makeCapturePi(recovered));
    store2.recoverEntryOnlyOrphans(mainFile, "sess-origin");

    // 治理面不过滤：workflow origin 孤儿照样被收敛终态（无文件判据 closed+gc+error）
    const finalized = recovered.find((e) => e.id === "wf-orphan");
    expect(finalized).toBeDefined();
    expect(finalized?.status).toBe("closed");
    expect(finalized?.closedReason).toBe("gc");
    // 终态 entry 保留来源身份（origin/parentRunId 不因恢复链丢失）
    expect(finalized?.origin).toBe("workflow");
    expect(finalized?.parentRunId).toBe("run-G");
  });

  it("toSubagentRecordEntry schema 面：origin/parentRunId 白名单透传（写入侧单点）", () => {
    // 直连 schema 投影的补充断言（往返用例已锁全链，此处锁字段白名单本身）。
    // 入参形态 = recordToSubagent 投影产物（SubagentRecord），对齐 record-entry-collect.test.ts。
    const subagentRecord = {
      id: "wf-schema",
      agent: "worker",
      task: "t",
      slug: "origin-test",
      status: "running" as const,
      mode: "background" as const,
      startedAt: 1000,
      rootSessionId: "sess-origin",
      parentRecordId: undefined,
      depth: 0,
      endedAt: undefined,
      turns: 1,
      totalTokens: 0,
      model: "m",
      thinkingLevel: undefined,
      eventLog: [],
      displayItems: [],
      origin: "workflow" as const,
      parentRunId: "run-H",
    };
    const entry = toSubagentRecordEntry(subagentRecord);
    expect(entry.origin).toBe("workflow");
    expect(entry.parentRunId).toBe("run-H");

    const { origin: _o, parentRunId: _p, ...legacyShape } = subagentRecord;
    const legacy = toSubagentRecordEntry(legacyShape);
    expect(legacy.origin).toBeUndefined();
    expect(legacy.parentRunId).toBeUndefined();
  });
});
