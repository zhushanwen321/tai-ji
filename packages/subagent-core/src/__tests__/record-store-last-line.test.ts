/**
 * [U3 / §3.2.4 迁移] 孤儿恢复与子文件末行内容解耦的回归锚。
 *
 * [HISTORICAL] 原文件验证 readLastJsonlLine 判定矩阵（超长末行扩窗 / 截断行识别）。
 * 永久会话模型 §3.2.4 重建单规则落地后：磁盘重建恒 idle、孤儿恢复只做 entry 面纠偏
 *（一律保留 idle，锚在等 revive），**子文件末行内容不再参与任何判定**——
 * readLastJsonlLine 的扩窗/截断判定机制随直断分支整体删除。
 *
 * 本文件保留的回归价值（原 V1 探针事故锚）：真实库存在 28 个末行 65KB-776KB 的
 * 完整 entry（subagent-identity 的 task 内嵌大 payload）。旧实现固定 64KB 尾窗把
 * 超长末行从中间切开 → JSON.parse 失败 → 误判「截断」→ 孤儿恢复错落 error。
 * 新实现下这类文件照常被扫描（identity 在头部）并完成 entry 纠偏——超长/截断/
 * 异构末行对孤儿恢复完全无感知（不抛错、不落 error、照常 idle）。
 */
//
// [round5-g 合并产物] 吸收 RecordStore 磁盘重建姊妹件：
// - fr8-orphan-recovery.test.ts（FR-8 manifest 孤儿恢复）
// - nested-visibility.test.ts（原 src/execution/__tests__/ 下；嵌套全树可见性）。
//   其 sessions-index mock（saveIndex 空操作）与本文件同款；迁移后相对路径已改写。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManifestStore } from "../execution/persistence/manifest-store";
import { RecordStore } from "../execution/persistence/record-store";
import { makePi } from "../execution/__tests__/helpers/pi-mock.ts";
import { createRecord } from "../execution/persistence/execution-record.ts";

// [Gate A teardown 稳定性] no-op 掉索引落盘。根因：recoverOrphanRecords 走的
// reconstructAll（record-store.ts）扫描尾 fire-and-forget saveIndex（tmp+fsync+rename
// 异步 fs），满载下该 promise 可能在本文件 teardown 之后才 settle，其失败分支经
// logger.warn → console.warn 上报 vitest（rpc onUserConsoleLog 在途）——worker 关闭
// rpc 时在途调用被 reject 为 EnvironmentTeardownError（0 断言失败，纯 teardown 时序）。
// 本文件用一次性 tmpdir、断言只观察 appendEntry 捕获的判定结果，落盘与否无观察者——
// no-op 消除在途 IO 链，任何负载下确定；loadIndex 等其余导出保留原实现。
vi.mock("../execution/persistence/sessions-index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../execution/persistence/sessions-index.ts")>()),
  saveIndex: async () => {},
}));

interface CapturedEntry {
  type: string;
  data: Record<string, unknown>;
}

describe("孤儿恢复与子文件末行内容解耦（超长末行 / 截断行无感知）", () => {
  let rootDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "lastline-"));
    sessionsDir = path.join(rootDir, "sessions");
    fs.mkdirSync(sessionsDir);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 写子 session 文件（首行 identity + 自定义末行）+ 主 session 的 running 残留 entry。 */
  function writeOrphanSession(id: string, lastLine: string, opts: { trailingNewline?: boolean } = {}): string {
    const identity = JSON.stringify({
      type: "custom",
      customType: "subagent-identity",
      data: {
        id, agent: "worker", mode: "background", task: "t", slug: "s",
        startedAt: 1000, rootSessionId: "session-main", depth: 0,
      },
    });
    const file = path.join(sessionsDir, `2026-07-18T12-00-00-000Z_${id}.jsonl`);
    const middle = JSON.stringify({ type: "message", role: "assistant", content: "mid" });
    const body = [identity, middle, lastLine].join("\n") + (opts.trailingNewline === false ? "" : "\n");
    fs.writeFileSync(file, body, "utf8");
    // 主 session 末条 entry = v2 注册条（登记 §3.3：v1 快照形态已删）——收编定界的命中前提
    const mainFile = path.join(rootDir, "main-session.jsonl");
    const mainEntry = JSON.stringify({
      type: "custom", id: `e-${id}`, parentId: null, customType: "subagent-record",
      data: {
        v: 2, kind: "registered", id, agent: "worker", task: "t", slug: "s", origin: "tool",
        rootSessionId: "session-main", depth: 0, startedAt: 1000,
      },
    });
    fs.writeFileSync(mainFile, mainEntry + "\n", "utf8");
    // 子文件锚在场 → 收编走 journal 面（recoverOrphanRecords）：写首帧 record-created
    fs.mkdirSync(path.join(rootDir, "records"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "records", `${id}.events`),
      [
        JSON.stringify({ type: "record-events", id }),
        JSON.stringify({
          type: "record-created", seq: 1, ts: 1000, id, agent: "worker", task: "t", slug: "s",
          origin: "tool", rootSessionId: "session-main", depth: 0, mode: "background", startedAt: 1000,
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    return mainFile;
  }

  function recovered(id: string, mainFile: string) {
    const entries: CapturedEntry[] = [];
    const pi = makePi();
    pi.appendEntry.mockImplementation((type: string, entry: unknown) => {
      entries.push({ type, data: entry as Record<string, unknown> });
    });
    const store = new RecordStore(() => sessionsDir, new ManifestStore(() => path.join(rootDir, "records")), pi, () => path.join(rootDir, "records"));
    store.recoverOrphanRecords("session-main", mainFile);
    const hits = entries.filter((e) => e.data && (e.data as { id?: string }).id === id);
    if (hits.length === 0) throw new Error("orphan record not reported for " + id);
    return hits[hits.length - 1].data as Record<string, unknown>;
  }

  it("300KB 完整超长末行 → 照常 idle 纠偏、无 error（旧 64KB 尾窗实现会误判截断）", () => {
    // 300KB 单行 entry：> 64KB 初始窗 × 4 扩窗一档（64K→256K 仍不够 → 1M 覆盖到文件头）
    const bigPayload = "x".repeat(300 * 1024);
    const mainFile = writeOrphanSession("orphan-bigline", JSON.stringify({ type: "custom", customType: "subagent-record", data: { task: bigPayload, status: "done" } }));
    const rec = recovered("orphan-bigline", mainFile);
    // [U3 / §3.2.4] 一律保留 idle：无 closedReason、无任何 error 载体
    expect(rec.status).toBe("idle");
    expect(rec.closedReason).toBeUndefined();
    expect(rec.stopReason).toBe("interrupted-by-restart");
    expect(rec.error).toBeUndefined();
  });

  it("末行截断（无尾换行的半行 JSON）→ 照常 idle 纠偏、无截断 error（末行判读路径已删）", () => {
    // 半写入形态：最后一行 JSON 被切断且无尾换行
    const truncated = '{"type":"message","role":"assistant","content":"half-written line without clos';
    const mainFile = writeOrphanSession("orphan-truncated", truncated, { trailingNewline: false });
    const rec = recovered("orphan-truncated", mainFile);
    expect(rec.status).toBe("idle");
    expect(rec.closedReason).toBeUndefined();
    expect(rec.error).toBeUndefined();
  });

  it("超长且截断的末行 → 同款无感知（不因行长/截断形态改变纠偏行为）", () => {
    const bigTruncated = JSON.stringify({ type: "custom", customType: "subagent-record", data: { task: "y".repeat(300 * 1024) } }).slice(0, 300 * 1024);
    const mainFile = writeOrphanSession("orphan-bigcut", bigTruncated, { trailingNewline: false });
    const rec = recovered("orphan-bigcut", mainFile);
    expect(rec.status).toBe("idle");
    expect(rec.error).toBeUndefined();
  });

  it("常规末行（多行文件、完整 JSON）→ 照常 idle 纠偏", () => {
    const mainFile = writeOrphanSession("orphan-normal", JSON.stringify({ type: "message", role: "assistant", content: "final" }));
    const rec = recovered("orphan-normal", mainFile);
    expect(rec.status).toBe("idle");
    expect(rec.error).toBeUndefined();
  });

  it("仅 identity 单行文件（首行即末行，合法 JSON）→ 照常 idle 纠偏", () => {
    const identity = JSON.stringify({
      type: "custom",
      customType: "subagent-identity",
      data: {
        id: "orphan-empty", agent: "worker", mode: "background", task: "t", slug: "s",
        startedAt: 1000, rootSessionId: "session-main", depth: 0,
      },
    });
    // identity 首行 + 紧跟空行结尾：非空段只剩 identity
    const file = path.join(sessionsDir, "2026-07-18T12-00-00-000Z_orphan-empty.jsonl");
    fs.writeFileSync(file, identity + "\n", "utf8");
    const mainFile = path.join(rootDir, "main-session.jsonl");
    const mainEntry = JSON.stringify({
      type: "custom", id: "e-orphan-empty", parentId: null, customType: "subagent-record",
      data: {
        v: 2, kind: "registered", id: "orphan-empty", agent: "worker", task: "t", slug: "s",
        origin: "tool", rootSessionId: "session-main", depth: 0, startedAt: 1000,
      },
    });
    fs.writeFileSync(mainFile, mainEntry + "\n", "utf8");
    fs.mkdirSync(path.join(rootDir, "records"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "records", "orphan-empty.events"),
      [
        JSON.stringify({ type: "record-events", id: "orphan-empty" }),
        JSON.stringify({
          type: "record-created", seq: 1, ts: 1000, id: "orphan-empty", agent: "worker", task: "t",
          slug: "s", origin: "tool", rootSessionId: "session-main", depth: 0, mode: "background", startedAt: 1000,
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const rec = recovered("orphan-empty", mainFile);
    expect(rec.status).toBe("idle");
    expect(rec.error).toBeUndefined();
  });
});

// ══════ 来源: fr8-orphan-recovery.test.ts ══════

describe("FR-8: Orphan Recovery from Manifest", () => {
  let rootDir: string;
  let sessionsDir: string;
  let recordsDir: string;
  let manifestStore: ManifestStore;

  beforeEach(() => {
    // [DS3] 两层布局：sessions/records 平级落同一 rootDir（对齐生产 <enc> 段结构），
    // sessions-index.json 落 dirname(sessionsDir)=rootDir 内随 afterEach 清理，
    // 不写 os.tmpdir() 本身（并行 worker 共写会跨文件污染）。
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "fr8-"));
    sessionsDir = path.join(rootDir, "sessions");
    fs.mkdirSync(sessionsDir);
    recordsDir = path.join(rootDir, "records");
    manifestStore = new ManifestStore(() => recordsDir);
  });

  afterEach(() => {
    // maxRetries：fire-and-forget 的 sessions-index 写可能与删除并发（ENOTEMPTY 竞态）
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("should recover orphan records from manifest when session.jsonl is missing", async () => {
    const store = new RecordStore(() => sessionsDir, manifestStore);

    // Write a manifest record (simulating a subagent that crashed before writing session.jsonl)
    await manifestStore.writeManifest({
      id: "orphan-1",
      rootSessionId: "session-main",
      agentName: "worker",
      status: "closed",
      createdAt: 1000,
      completedAt: 2000,
      sessionFile: "/path/to/session.jsonl",
    });

    const records = store.collectRecords(100, "all", "session-main");
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("orphan-1");
    expect(records[0].agent).toBe("worker");
    expect(records[0].status).toBe("idle");
    expect(records[0].startedAt).toBe(1000);
    expect(records[0].endedAt).toBe(2000);
  });

  it("should not duplicate records already recovered from session.jsonl", async () => {
    // Create a session.jsonl with an identity entry (simulating successful reconstruction)
    const sessionId = "existing-session";
    const timestamp = "2026-07-18T12-00-00-000Z";
    const sessionFile = path.join(sessionsDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
    fs.writeFileSync(sessionFile, JSON.stringify({
      type: "custom",
      customType: "subagent-identity",
      data: {
        id: "existing-1",
        agent: "explorer",
        mode: "background",
        task: "explore codebase",
        slug: "explore",
        startedAt: 1000,
        rootSessionId: "session-main",
        depth: 0,
      },
    }) + "\n");

    // Also write a manifest for the same record
    await manifestStore.writeManifest({
      id: "existing-1",
      rootSessionId: "session-main",
      agentName: "explorer",
      status: "closed",
      createdAt: 1000,
      completedAt: 2000,
      sessionFile,
    });

    const store = new RecordStore(() => sessionsDir, manifestStore);
    const records = store.collectRecords(100, "all", "session-main");

    // Should have exactly 1 record (no duplication)
    const matching = records.filter((r) => r.id === "existing-1");
    expect(matching).toHaveLength(1);
  });

  it("should filter manifest records by rootSessionId", async () => {
    const store = new RecordStore(() => sessionsDir, manifestStore);

    await manifestStore.writeManifest({
      id: "orphan-session-a",
      rootSessionId: "session-a",
      agentName: "worker",
      status: "closed",
      createdAt: 1000,
    });

    await manifestStore.writeManifest({
      id: "orphan-session-b",
      rootSessionId: "session-b",
      agentName: "worker",
      status: "closed",
      createdAt: 2000,
    });

    const recordsA = store.collectRecords(100, "all", "session-a");
    expect(recordsA).toHaveLength(1);
    expect(recordsA[0].id).toBe("orphan-session-a");

    const recordsB = store.collectRecords(100, "all", "session-b");
    expect(recordsB).toHaveLength(1);
    expect(recordsB[0].id).toBe("orphan-session-b");
  });

  it("should map manifest status correctly (4-state)", async () => {
    const store = new RecordStore(() => sessionsDir, manifestStore);

    await manifestStore.writeManifest({
      id: "status-completed",
      rootSessionId: "session-main",
      agentName: "worker",
      status: "closed",
      createdAt: 1000,
    });

    await manifestStore.writeManifest({
      id: "status-failed",
      rootSessionId: "session-main",
      agentName: "worker",
      status: "closed",
      createdAt: 2000,
    });

    await manifestStore.writeManifest({
      id: "status-cancelled",
      rootSessionId: "session-main",
      agentName: "worker",
      status: "cancelled",
      createdAt: 3000,
    });

    // M3: ManifestRecord.status 4 态（running/completed/failed/cancelled）。
    // v4 B-1：cancelled 不再是独立 ExecutionStatus——mapManifestStatus 映射为 closed
    //（closedReason='cancelled' 由重建路径 sidecar 推断）。crashed 不进 manifest
    //（crashed 是重启重建时靠 sidecar 四分支推断的派生态,见 record-store.ts reconstructAll）。
    const records = store.collectRecords(100, "all", "session-main");
    expect(records).toHaveLength(3);

    expect(records.find((r) => r.id === "status-completed")?.status).toBe("idle");
    expect(records.find((r) => r.id === "status-failed")?.status).toBe("idle");
    expect(records.find((r) => r.id === "status-cancelled")?.status).toBe("idle");
  });

  it("mapManifestStatus 越界值返回 null：collectRecords 跳过损坏 record（不降级 failed）", async () => {
    const store = new RecordStore(() => sessionsDir, manifestStore);

    // 合法 record（对照组）
    await manifestStore.writeManifest({
      id: "good",
      rootSessionId: "session-main",
      agentName: "worker",
      status: "closed",
      createdAt: 1000,
    });

    // 直接写磁盘注入非法 status（绕过 writeManifest 的 TS 类型检查）。
    // crashed 不在 4 态枚举——它是重建派生态,意外出现在 manifest 应被跳过而非降级 failed。
    fs.writeFileSync(path.join(recordsDir, "bad-crashed.json"), JSON.stringify({
      id: "bad-crashed", rootSessionId: "session-main", agentName: "worker",
      status: "crashed", createdAt: 2000,
    }));
    // 未知值同样跳过
    fs.writeFileSync(path.join(recordsDir, "bad-unknown.json"), JSON.stringify({
      id: "bad-unknown", rootSessionId: "session-main", agentName: "worker",
      status: "totally-unknown", createdAt: 3000,
    }));

    const records = store.collectRecords(100, "all", "session-main");
    // 只剩 good——损坏 record 被跳过 + console.warn,不误显示为 failed
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("good");
    expect(records[0].status).toBe("idle");
  });

  it("in-memory records should take priority over manifest records", async () => {
    const store = new RecordStore(() => sessionsDir, manifestStore);

    // Register a running record in memory
    store.register({
      id: "memory-record",
      agent: "worker",
      model: "test/model",
      thinkingLevel: undefined,
      mode: "background",
      task: "test task",
      slug: "test",
      startedAt: 1000,
      rootSessionId: "session-main",
      parentRecordId: undefined,
      depth: 0,
      status: "running",
      turns: [],
      turnCount: 0,
      totalTokens: 0,
      lastError: undefined,
      endedAt: undefined,
      result: undefined,
      error: undefined,
      agentResult: undefined,
      sessionFile: undefined,
      controller: undefined,
    });

    // Also write a manifest with the same id but different status
    await manifestStore.writeManifest({
      id: "memory-record",
      rootSessionId: "session-main",
      agentName: "different-agent",
      status: "closed",
      createdAt: 500,
    });

    const records = store.collectRecords(100, "all", "session-main");
    expect(records).toHaveLength(1);
    // Memory record should win
    expect(records[0].status).toBe("running");
    expect(records[0].agent).toBe("worker");
  });

  it("should work without manifestStore (backward compatible)", () => {
    const store = new RecordStore(() => sessionsDir); // No manifestStore

    // Should not throw
    const records = store.collectRecords(100, "all", "session-main");
    expect(records).toHaveLength(0);
  });

  it("should handle manifest with status=running as running", async () => {
    const store = new RecordStore(() => sessionsDir, manifestStore);

    await manifestStore.writeManifest({
      id: "still-running",
      rootSessionId: "session-main",
      agentName: "worker",
      status: "running",
      createdAt: Date.now(),
    });

    const records = store.collectRecords(100, "all", "session-main");
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("running");
  });
});

// ══════ 来源: nested-visibility.test.ts ══════

// src/execution/__tests__/nested-visibility.test.ts
//
// SP-8 嵌套可见性修复验证（TC-1 + TC-2：RecordStore 磁盘重建）。
//
// 验证全树可见性深度 ≥2 的 subagent 在 /subagents list 中可见：
//   TC-1: 嵌套 A→B→C，B 和 C 的 rootSessionId 都指向 ROOT
//   TC-2: collectRecords 返回全树（含深层）
//
// 使用真实文件系统（tmpdir + 真实 .jsonl）测试 RecordStore.collectRecords 磁盘重建。
// TC-3（env 贯穿）见 nested-visibility-env-propagation.test.ts。




// [Gate A teardown 稳定性] no-op 掉索引落盘。根因：collectRecords 扫描尾的
// flushIndexAfterScan（record-store.ts）fire-and-forget saveIndex（tmp+fsync+rename
// 异步 fs），满载下该 promise 可能在本文件 teardown 之后才 settle，其失败分支经
// logger.warn → console.warn 上报 vitest（rpc onUserConsoleLog 在途）——worker 关闭
// rpc 时在途调用被 reject 为 EnvironmentTeardownError（0 断言失败，纯 teardown 时序）。
// 本文件用一次性 tmpdir、断言不观察索引文件，落盘与否无观察者——no-op 消除在途 IO
// 链，任何负载下确定；loadIndex 等其余导出保留原实现（磁盘重建语义不变）。
vi.mock("../execution/persistence/sessions-index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../execution/persistence/sessions-index.ts")>()),
  saveIndex: async () => {},
}));

// ── helpers ──

/**
 * 写一个最小合法的 session.jsonl（含 identity custom entry + 1 个 assistant message）。
 * 用于 collectRecords 磁盘源重建。
 */
function writeSessionJsonl(
  filePath: string,
  identity: {
    id: string;
    agent: string;
    mode: "background";
    task: string;
    startedAt: number;
    rootSessionId?: string;
    parentRecordId?: string;
    depth?: number;
    lastTs?: number;
  },
  assistantText = "result text",
): void {
  const lastTs = identity.lastTs ?? identity.startedAt + 1000;
  const header = JSON.stringify({
    type: "session", version: 3, id: "sess-uuid", timestamp: new Date(identity.startedAt).toISOString(), cwd: "/tmp",
  });
  const identityData: Record<string, unknown> = {
    id: identity.id,
    agent: identity.agent,
    mode: identity.mode,
    task: identity.task,
    startedAt: identity.startedAt,
  };
  if (identity.rootSessionId !== undefined) identityData.rootSessionId = identity.rootSessionId;
  if (identity.parentRecordId !== undefined) identityData.parentRecordId = identity.parentRecordId;
  if (identity.depth !== undefined) identityData.depth = identity.depth;
  const identityEntry = JSON.stringify({
    type: "custom",
    id: `id-${identity.id}`,
    parentId: null,
    timestamp: new Date(identity.startedAt).toISOString(),
    customType: "subagent-identity",
    data: identityData,
  });
  const assistantMsg = JSON.stringify({
    type: "message",
    id: `msg-${identity.id}`,
    parentId: `id-${identity.id}`,
    timestamp: new Date(lastTs).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: assistantText }],
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0 } },
      stopReason: "stop",
      timestamp: lastTs,
    },
  });
  fs.writeFileSync(filePath, `${header}\n${identityEntry}\n${assistantMsg}\n`, "utf-8");
}

// ============================================================
// TC-1: 嵌套 A→B→C，B 和 C 的 rootSessionId 都指向 ROOT
// ============================================================

describe("TC-1: 嵌套 A→B→C 的 rootSessionId 全部指向 ROOT", () => {
  let rootDir: string;
  let tmpDir: string;

  beforeEach(() => {
    // [DS3] 两层布局：tmpDir 深一层（对齐生产 <enc> 段结构），sessions-index.json 落
    // dirname(tmpDir)=rootDir 内随 afterEach 清理，不写 os.tmpdir() 本身。
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "nested-vis-tc1-"));
    tmpDir = path.join(rootDir, "sessions");
    fs.mkdirSync(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("三层嵌套 record 的 rootSessionId 全部指向同一 ROOT（磁盘重建 + collectRecords 过滤）", () => {
    const ROOT_SESSION = "root-session-001";
    const store = new RecordStore(() => tmpDir);

    // A: depth=0, parent=undefined（顶层）
    writeSessionJsonl(path.join(tmpDir, "a.jsonl"), {
      id: "sa-a", agent: "worker", mode: "background", task: "task A", startedAt: 1000,
      rootSessionId: ROOT_SESSION, depth: 0,
    });
    // B: depth=1, parent=A（A 的子）
    writeSessionJsonl(path.join(tmpDir, "b.jsonl"), {
      id: "sa-b", agent: "worker", mode: "background", task: "task B", startedAt: 2000,
      rootSessionId: ROOT_SESSION, parentRecordId: "sa-a", depth: 1,
    });
    // C: depth=2, parent=B（B 的子，最深层）
    writeSessionJsonl(path.join(tmpDir, "c.jsonl"), {
      id: "sa-c", agent: "worker", mode: "background", task: "task C", startedAt: 3000,
      rootSessionId: ROOT_SESSION, parentRecordId: "sa-b", depth: 2,
    });

    const records = store.collectRecords(100, "all", ROOT_SESSION);
    const ids = records.map((r) => r.id);

    // 全部 3 条 record 可见
    expect(ids).toContain("sa-a");
    expect(ids).toContain("sa-b");
    expect(ids).toContain("sa-c");
    expect(records).toHaveLength(3);

    // rootSessionId 全指向 ROOT
    for (const r of records) {
      expect(r.rootSessionId).toBe(ROOT_SESSION);
    }
  });

  it("rootSessionId 不匹配时深层 record 被过滤（隔离防护）", () => {
    const ROOT_SESSION = "root-session-001";
    const OTHER_SESSION = "other-session-999";
    const store = new RecordStore(() => tmpDir);

    // A 归 ROOT
    writeSessionJsonl(path.join(tmpDir, "a.jsonl"), {
      id: "sa-a", agent: "worker", mode: "background", task: "task A", startedAt: 1000,
      rootSessionId: ROOT_SESSION, depth: 0,
    });
    // B 归 OTHER（不同 session 的 subagent）
    writeSessionJsonl(path.join(tmpDir, "b.jsonl"), {
      id: "sa-b", agent: "worker", mode: "background", task: "task B", startedAt: 2000,
      rootSessionId: OTHER_SESSION, depth: 1,
    });

    const records = store.collectRecords(100, "all", ROOT_SESSION);
    const ids = records.map((r) => r.id);

    // 只有 A 可见，B 被过滤
    expect(ids).toContain("sa-a");
    expect(ids).not.toContain("sa-b");
  });
});

// ============================================================
// TC-2: collectRecords 返回全树（含深层）
// ============================================================

describe("TC-2: collectRecords 返回全树（含深层）", () => {
  let rootDir: string;
  let tmpDir: string;

  beforeEach(() => {
    // [DS3] 两层布局：同 TC-1（sessions-index.json 落 rootDir 内随清理）。
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "nested-vis-tc2-"));
    tmpDir = path.join(rootDir, "sessions");
    fs.mkdirSync(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("磁盘重建 + 内存 running 合并：全树 A→B→C 全部可见（深度 ≥2）", () => {
    const ROOT_SESSION = "root-merge-001";
    const store = new RecordStore(() => tmpDir);

    // A: 磁盘终态（idle，无 sidecar → SP-2 兜底 idle）
    writeSessionJsonl(path.join(tmpDir, "a.jsonl"), {
      id: "sa-a", agent: "worker", mode: "background", task: "task A", startedAt: 1000,
      rootSessionId: ROOT_SESSION, depth: 0,
    });
    // B: 磁盘终态（idle，无 sidecar）
    writeSessionJsonl(path.join(tmpDir, "b.jsonl"), {
      id: "sa-b", agent: "worker", mode: "background", task: "task B", startedAt: 2000,
      rootSessionId: ROOT_SESSION, parentRecordId: "sa-a", depth: 1,
    });
    // C: 内存 running（当前正在执行）
    const recordC = createRecord("sa-c", {
      agent: "worker",
      model: "test/model",
      mode: "background",
      slug: "t",
      task: "task C",
      startedAt: 3000,
      rootSessionId: ROOT_SESSION,
      parentRecordId: "sa-b",
      depth: 2,
    });
    store.register(recordC);

    const records = store.collectRecords(100, "all", ROOT_SESSION);
    const ids = records.map((r) => r.id);

    // 全部 3 条可见（磁盘 A/B + 内存 C）
    expect(ids).toContain("sa-a");
    expect(ids).toContain("sa-b");
    expect(ids).toContain("sa-c");
    expect(records.length).toBeGreaterThanOrEqual(3);
  });

  it("depth 标签正确：A=0, B=1, C=2", () => {
    const ROOT_SESSION = "root-depth-001";
    const store = new RecordStore(() => tmpDir);

    writeSessionJsonl(path.join(tmpDir, "a.jsonl"), {
      id: "sa-a", agent: "worker", mode: "background", task: "task A", startedAt: 1000,
      rootSessionId: ROOT_SESSION, depth: 0,
    });
    writeSessionJsonl(path.join(tmpDir, "b.jsonl"), {
      id: "sa-b", agent: "worker", mode: "background", task: "task B", startedAt: 2000,
      rootSessionId: ROOT_SESSION, parentRecordId: "sa-a", depth: 1,
    });
    writeSessionJsonl(path.join(tmpDir, "c.jsonl"), {
      id: "sa-c", agent: "worker", mode: "background", task: "task C", startedAt: 3000,
      rootSessionId: ROOT_SESSION, parentRecordId: "sa-b", depth: 2,
    });

    const records = store.collectRecords(100, "all", ROOT_SESSION);
    const byId = new Map(records.map((r) => [r.id, r]));

    expect(byId.get("sa-a")!.depth).toBe(0);
    expect(byId.get("sa-b")!.depth).toBe(1);
    expect(byId.get("sa-c")!.depth).toBe(2);
  });

  it("parentRecordId 链完整：A→(root), B→A, C→B", () => {
    const ROOT_SESSION = "root-parent-001";
    const store = new RecordStore(() => tmpDir);

    writeSessionJsonl(path.join(tmpDir, "a.jsonl"), {
      id: "sa-a", agent: "worker", mode: "background", task: "task A", startedAt: 1000,
      rootSessionId: ROOT_SESSION, depth: 0,
    });
    writeSessionJsonl(path.join(tmpDir, "b.jsonl"), {
      id: "sa-b", agent: "worker", mode: "background", task: "task B", startedAt: 2000,
      rootSessionId: ROOT_SESSION, parentRecordId: "sa-a", depth: 1,
    });
    writeSessionJsonl(path.join(tmpDir, "c.jsonl"), {
      id: "sa-c", agent: "worker", mode: "background", task: "task C", startedAt: 3000,
      rootSessionId: ROOT_SESSION, parentRecordId: "sa-b", depth: 2,
    });

    const records = store.collectRecords(100, "all", ROOT_SESSION);
    const byId = new Map(records.map((r) => [r.id, r]));

    expect(byId.get("sa-a")!.parentRecordId).toBeUndefined(); // 顶层无父
    expect(byId.get("sa-b")!.parentRecordId).toBe("sa-a");
    expect(byId.get("sa-c")!.parentRecordId).toBe("sa-b");
  });

  it("statusFilter='running' 返回全树（v4 B-1：深层磁盘 idle 重建为 running）", () => {
    const ROOT_SESSION = "root-filter-001";
    const store = new RecordStore(() => tmpDir);

    // 3 条磁盘 idle record（SP-2: 无 sidecar → 旧 idle，v4 B-1 重建为 running）
    writeSessionJsonl(path.join(tmpDir, "a.jsonl"), {
      id: "sa-a", agent: "worker", mode: "background", task: "task A", startedAt: 1000,
      rootSessionId: ROOT_SESSION, depth: 0,
    });
    writeSessionJsonl(path.join(tmpDir, "b.jsonl"), {
      id: "sa-b", agent: "worker", mode: "background", task: "task B", startedAt: 2000,
      rootSessionId: ROOT_SESSION, parentRecordId: "sa-a", depth: 1,
    });
    writeSessionJsonl(path.join(tmpDir, "c.jsonl"), {
      id: "sa-c", agent: "worker", mode: "background", task: "task C", startedAt: 3000,
      rootSessionId: ROOT_SESSION, parentRecordId: "sa-b", depth: 2,
    });

    // C 是内存 running
    const recordC = createRecord("sa-c", {
      agent: "worker",
      model: "test/model",
      mode: "background",
      slug: "t",
      task: "task C",
      startedAt: 3000,
      rootSessionId: ROOT_SESSION,
      parentRecordId: "sa-b",
      depth: 2,
    });
    store.register(recordC);

    const runningRecords = store.collectRecords(100, "running", ROOT_SESSION);
    const ids = runningRecords.map((r) => r.id);

    // [U3 / §3.2.4] 重建单规则：磁盘 A/B 恒 idle（running 只在轮次在途时有意义），
    // filter=running 只剩内存 C
    expect(ids).toEqual(["sa-c"]);
  });

  it("无 rootSessionFilter 时不过滤（向后兼容）", () => {
    const store = new RecordStore(() => tmpDir);

    writeSessionJsonl(path.join(tmpDir, "a.jsonl"), {
      id: "sa-a", agent: "worker", mode: "background", task: "task A", startedAt: 1000,
      rootSessionId: "root-1", depth: 0,
    });
    writeSessionJsonl(path.join(tmpDir, "b.jsonl"), {
      id: "sa-b", agent: "worker", mode: "background", task: "task B", startedAt: 2000,
      rootSessionId: "root-2", depth: 0,
    });

    // 无 filter → 全部返回
    const records = store.collectRecords(100, "all", undefined);
    const ids = records.map((r) => r.id);
    expect(ids).toContain("sa-a");
    expect(ids).toContain("sa-b");
  });
});
