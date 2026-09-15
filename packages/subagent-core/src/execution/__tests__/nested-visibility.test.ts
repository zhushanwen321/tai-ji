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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecord } from "../persistence/execution-record.ts";
import { RecordStore } from "../persistence/record-store.ts";

// [Gate A teardown 稳定性] no-op 掉索引落盘。根因：collectRecords 扫描尾的
// flushIndexAfterScan（record-store.ts）fire-and-forget saveIndex（tmp+fsync+rename
// 异步 fs），满载下该 promise 可能在本文件 teardown 之后才 settle，其失败分支经
// logger.warn → console.warn 上报 vitest（rpc onUserConsoleLog 在途）——worker 关闭
// rpc 时在途调用被 reject 为 EnvironmentTeardownError（0 断言失败，纯 teardown 时序）。
// 本文件用一次性 tmpdir、断言不观察索引文件，落盘与否无观察者——no-op 消除在途 IO
// 链，任何负载下确定；loadIndex 等其余导出保留原实现（磁盘重建语义不变）。
vi.mock("../persistence/sessions-index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../persistence/sessions-index.ts")>()),
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
    const store = new RecordStore(tmpDir);

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
    const store = new RecordStore(tmpDir);

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
    const store = new RecordStore(tmpDir);

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
    const store = new RecordStore(tmpDir);

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
    const store = new RecordStore(tmpDir);

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
    const store = new RecordStore(tmpDir);

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

    // [U3 / §3.2.4] 重建单规则：磁盘 A/B 恒 idle（running 只在轮次在飞时有意义），
    // filter=running 只剩内存 C
    expect(ids).toEqual(["sa-c"]);
  });

  it("无 rootSessionFilter 时不过滤（向后兼容）", () => {
    const store = new RecordStore(tmpDir);

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
