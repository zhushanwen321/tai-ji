// src/execution/__tests__/record-origin.test.ts
//
// record 来源身份 origin/parentRunId（H2 W1，设计 subagent-workflow-record-unification
// §3.3 D1）持久化链 + 查询面 + 治理面负向规格。
//
// v2 单形态（W1 [D1]）：主 session 条目 = 注册（身份域）+ 终态（终局域）两条小条目，
// 身份域 origin/parentRunId/stepIndex 只落在注册条目；v1 全量快照写点与读面已随兼容层
// 删除（登记 §3.3），本文件同步到 v2 播种形态与断言面。
//
// 锁四件事：
//   1. 持久化链往返保真：register/archive 真实落盘（appendEntry 通路）→
//      scanLastRecordEntries 重建（collectV2EntryPairs → v2PairToRecord 真实路径）→
//      origin/parentRunId/stepIndex 不丢。禁手工构造对象绕过 schema——entry data
//      一律来自 store.register / store.archive 的真实落盘产物。
//   2. 缺省负向：无 origin 的存量 record 落 v2 注册条目 origin="tool"（必填域归一），
//      可选域 parentRunId/stepIndex 序列化自然缺省（零迁移）。
//   3. 查询面：collectRecords 缺省过滤 origin==="workflow"（includeWorkflow 缺省
//      false）、includeWorkflow:true 放行；collectRecordsByParentRunId 按 run id
//      精确列 record（内存 ∪ 磁盘重建口径，不过滤 origin）。
//   4. 治理面负向保证（D1⑥）：recoverEntryOnlyOrphans / 重建投影不因 origin 过滤——
//      workflow 来源的 entry-only 孤儿（注册条目已在主 session、无事件文件、无子文件锚）
//      照样被终态化收敛；身份域留在注册条目，纠偏只追加终态条目。

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
vi.mock("../persistence/sessions-index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../persistence/sessions-index.ts")>();
  return { ...actual, saveIndex: saveIndexMock };
});

import { createRecord } from "../persistence/execution-record.ts";
import { recordToSubagent } from "../persistence/record-store-rebuild.ts";
import { SUBAGENT_RECORD_CUSTOM_TYPE } from "../persistence/record-entry.ts";
import type { SubagentRecordEntryV2 } from "../persistence/record-entry.ts";
import { RecordStore } from "../persistence/record-store.ts";
import type { ExecutionRecord } from "../assembly/types.ts";
import { v2RegisteredEntry } from "./helpers/v2-record-entry.ts";

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
  });
  return { ...base, ...over };
}

/** 捕获 register/archive 落盘 entry 的 fake pi。 */
function makeCapturePi(captured: SubagentRecordEntryV2[]): { appendEntry: (customType: string, data: unknown) => void } {
  return {
    appendEntry: (customType: string, data: unknown) => {
      if (customType !== SUBAGENT_RECORD_CUSTOM_TYPE) return;
      captured.push(data as SubagentRecordEntryV2);
    },
  };
}

/** 把捕获的 entry data 写成主 session JSONL 行（pi appendEntry 的落盘产物形态）。 */
function writeMainSessionFile(filePath: string, entries: SubagentRecordEntryV2[]): void {
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

  it("[W1/D1] v2 注册条目携带 origin/parentRunId；注册 + 终态成对落盘经真实重建路径读回不丢", () => {
    const store = new RecordStore(tmpDir);
    const captured: SubagentRecordEntryV2[] = [];
    store.setPi(makeCapturePi(captured));

    const rec = makeRecord({ id: "wf-step-1", origin: "workflow", parentRunId: "wf-run-1" });
    store.register(rec);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      v: 2,
      kind: "registered",
      id: "wf-step-1",
      origin: "workflow",
      parentRunId: "wf-run-1",
    });

    // 终态条目（真实 archive 写点）补齐条目对——身份域只在注册条目，重建链按对读回。
    store.archive({ ...rec, status: "idle", stopReason: "completed", endedAt: 2000, turnCount: 2, totalTokens: 30, result: "ok" });
    expect(captured).toHaveLength(2);
    expect(captured[1]).toMatchObject({
      v: 2,
      kind: "settled",
      id: "wf-step-1",
      status: "idle",
      stopReason: "completed",
    });

    const mainFile = path.join(rootDir, "main.jsonl");
    writeMainSessionFile(mainFile, captured);
    const rebuilt = store.scanLastRecordEntries(mainFile).find((r) => r.id === "wf-step-1");
    expect(rebuilt?.origin).toBe("workflow");
    expect(rebuilt?.parentRunId).toBe("wf-run-1");
    expect(rebuilt?.status).toBe("idle");
  });

  it("[W1/D1] 缺省归一：无 origin 的 record 落 v2 注册条目 origin=\"tool\"（必填域归一，parentRunId 缺省不含键）", () => {
    const store = new RecordStore(tmpDir);
    const captured: SubagentRecordEntryV2[] = [];
    store.setPi(makeCapturePi(captured));

    store.register(makeRecord({ id: "legacy-1" }));
    expect(captured).toHaveLength(1);
    // v2 契约 origin 必填：undefined 归一 "tool"（消费面负向判定零迁移）；可选域
    // parentRunId 经序列化自然缺省（断言序列化后形态——内存对象保留 undefined 键名）。
    const persisted = JSON.parse(JSON.stringify(captured[0])) as Record<string, unknown>;
    expect(persisted.kind).toBe("registered");
    expect(persisted.origin).toBe("tool");
    expect(Object.keys(persisted)).not.toContain("parentRunId");
  });

  it("重建投影不过滤（D1⑤）：workflow 来源 record 经内存源投影全量返回（includeWorkflow 通道）", () => {
    const store = new RecordStore(tmpDir);
    store.register(makeRecord({ id: "wf-step-2", origin: "workflow", parentRunId: "wf-run-2" }));
    const all = store.collectRecords(50, "all", "sess-origin", true);
    expect(all.map((r) => r.id)).toContain("wf-step-2");
    expect(all.find((r) => r.id === "wf-step-2")?.origin).toBe("workflow");
  });

  it("[W0 / D1] stepIndex 往返保真：register 落盘 entry 含字段，真实重建路径读回不丢", () => {
    const store = new RecordStore(tmpDir);
    const captured: SubagentRecordEntryV2[] = [];
    store.setPi(makeCapturePi(captured));

    const rec = makeRecord({ id: "wf-step-idx", origin: "workflow", parentRunId: "wf-run-idx", stepIndex: 7 });
    store.register(rec);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      v: 2,
      kind: "registered",
      stepIndex: 7,
      origin: "workflow",
      parentRunId: "wf-run-idx",
    });

    const mainFile = path.join(rootDir, "main-step-idx.jsonl");
    writeMainSessionFile(mainFile, captured);
    const rebuilt = store.scanLastRecordEntries(mainFile).find((r) => r.id === "wf-step-idx");
    expect(rebuilt?.stepIndex).toBe(7);
    expect(rebuilt?.origin).toBe("workflow");
    expect(rebuilt?.parentRunId).toBe("wf-run-idx");
  });

  it("[W0 / D1·W1 v2] stepIndex 缺省负向：无字段 record 落 v2 条目不含键（序列化自然缺省）", () => {
    const store = new RecordStore(tmpDir);
    const captured: SubagentRecordEntryV2[] = [];
    store.setPi(makeCapturePi(captured));

    store.register(makeRecord({ id: "legacy-step", origin: "workflow", parentRunId: "wf-run-legacy" }));
    expect(captured).toHaveLength(1);
    const persistedKeys = Object.keys(JSON.parse(JSON.stringify(captured[0])) as Record<string, unknown>);
    expect(persistedKeys).not.toContain("stepIndex");
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

  it("recoverEntryOnlyOrphans：workflow origin 的 entry-only 孤儿照样纠偏（v2 终态条目），身份域留在注册条目", () => {
    // v2 entry-only 孤儿形态：主 session 只有注册条目（running，未收口），无事件文件、
    // 无子 session 文件锚——正是 recoverEntryOnlyOrphans 的判定域。
    const orphan = makeRecord({ id: "wf-orphan", origin: "workflow", parentRunId: "run-G" });
    const registered = v2RegisteredEntry(recordToSubagent(orphan));
    expect(registered.origin).toBe("workflow");
    expect(registered.parentRunId).toBe("run-G");
    const mainFile = path.join(rootDir, "main.jsonl");
    writeMainSessionFile(mainFile, [registered]);

    // 新 store（模拟重启后内存恒空）执行恢复链
    const recovered: SubagentRecordEntryV2[] = [];
    const store2 = new RecordStore(tmpDir);
    store2.setPi(makeCapturePi(recovered));
    store2.recoverEntryOnlyOrphans(mainFile, "sess-origin");

    // 治理面不过滤：workflow origin 孤儿照样被终态化收敛（一律 idle + interrupted-by-restart，
    // 不直断 closed+gc）
    expect(recovered).toHaveLength(1);
    const finalized = recovered[0]?.kind === "settled" ? recovered[0] : undefined;
    expect(finalized).toMatchObject({
      v: 2,
      kind: "settled",
      id: "wf-orphan",
      status: "idle",
      stopReason: "interrupted-by-restart",
    });
    expect((finalized as { closedReason?: unknown } | undefined)?.closedReason).toBeUndefined();
    // 终态条目只装终局域——身份域（origin/parentRunId）不重复落
    expect(Object.keys(JSON.parse(JSON.stringify(finalized)) as Record<string, unknown>)).not.toContain("origin");

    // 纠偏是追加，不重写身份：主文件的注册条目原样保留 origin/parentRunId
    const seededLine = JSON.parse(fs.readFileSync(mainFile, "utf-8").split("\n")[0]) as {
      data: { origin?: string; parentRunId?: string };
    };
    expect(seededLine.data.origin).toBe("workflow");
    expect(seededLine.data.parentRunId).toBe("run-G");
  });

  it("[v2/D1] 条目 schema 面：注册条目透传 origin/parentRunId/stepIndex，终态条目收敛终局域（写入侧单点）", () => {
    // 直连写入侧单点的补充断言（往返用例已锁全链，此处锁两族条目的字段白名单本身）。
    // 入参 = 真实 register/archive 落盘产物（不手搓 entry data 绕过写侧 schema）。
    const store = new RecordStore(tmpDir);
    const captured: SubagentRecordEntryV2[] = [];
    store.setPi(makeCapturePi(captured));

    const rec = makeRecord({ id: "wf-schema", origin: "workflow", parentRunId: "run-H", stepIndex: 3 });
    store.register(rec);
    const registered = captured[0];
    expect(registered).toMatchObject({
      v: 2,
      kind: "registered",
      id: "wf-schema",
      agent: "worker",
      task: "t",
      slug: "origin-test",
      origin: "workflow",
      parentRunId: "run-H",
      stepIndex: 3,
      rootSessionId: "sess-origin",
      depth: 0,
      startedAt: 1000,
    });
    // 白名单负向：v1 全量快照字段族不得回流进注册条目（身份条目只装身份域）
    const registeredKeys = Object.keys(JSON.parse(JSON.stringify(registered)) as Record<string, unknown>);
    for (const v1Only of [
      "eventLog",
      "displayItems",
      "status",
      "mode",
      "endedAt",
      "turns",
      "totalTokens",
      "closedReason",
      "result",
      "error",
    ]) {
      expect(registeredKeys).not.toContain(v1Only);
    }

    store.archive({
      ...rec,
      status: "idle",
      stopReason: "completed",
      endedAt: 2000,
      turnCount: 2,
      totalTokens: 30,
      result: "done",
    });
    const settled = captured[1];
    expect(settled).toMatchObject({
      v: 2,
      kind: "settled",
      id: "wf-schema",
      status: "idle",
      stopReason: "completed",
      endedAt: 2000,
      turns: 2,
      totalTokens: 30,
      model: "m",
      result: "done",
    });
    // 终态条目只装终局/统计域——身份域不重复落（origin/parentRunId/stepIndex 归注册条目）
    const settledKeys = Object.keys(JSON.parse(JSON.stringify(settled)) as Record<string, unknown>);
    for (const identityOnly of [
      "origin",
      "parentRunId",
      "stepIndex",
      "agent",
      "slug",
      "startedAt",
      "rootSessionId",
      "depth",
      "eventLog",
      "displayItems",
    ]) {
      expect(settledKeys).not.toContain(identityOnly);
    }
  });
});
