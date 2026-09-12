import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach,beforeEach, describe, expect, it } from "vitest";

import { ManifestStore } from "../execution/manifest-store";
import { RecordStore } from "../execution/record-store";

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
    manifestStore = new ManifestStore(recordsDir);
  });

  afterEach(() => {
    // maxRetries：fire-and-forget 的 sessions-index 写可能与删除并发（ENOTEMPTY 竞态）
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("should recover orphan records from manifest when session.jsonl is missing", async () => {
    const store = new RecordStore(sessionsDir, manifestStore);

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

    const store = new RecordStore(sessionsDir, manifestStore);
    const records = store.collectRecords(100, "all", "session-main");

    // Should have exactly 1 record (no duplication)
    const matching = records.filter((r) => r.id === "existing-1");
    expect(matching).toHaveLength(1);
  });

  it("should filter manifest records by rootSessionId", async () => {
    const store = new RecordStore(sessionsDir, manifestStore);

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
    const store = new RecordStore(sessionsDir, manifestStore);

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
    const store = new RecordStore(sessionsDir, manifestStore);

    // 合法 record（对照组）
    await manifestStore.writeManifest({
      id: "good",
      rootSessionId: "session-main",
      agentName: "worker",
      status: "closed",
      createdAt: 1000,
    });

    // 直接写磁盘注入非法 status（绕过 writeManifest 的 TS 类型守卫）。
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
    const store = new RecordStore(sessionsDir, manifestStore);

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
    const store = new RecordStore(sessionsDir); // No manifestStore

    // Should not throw
    const records = store.collectRecords(100, "all", "session-main");
    expect(records).toHaveLength(0);
  });

  it("should handle manifest with status=running as running", async () => {
    const store = new RecordStore(sessionsDir, manifestStore);

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
