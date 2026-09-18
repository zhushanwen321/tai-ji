// src/execution/__tests__/batch-finalized.test.ts
//
// [collect 退役] 读侧守卫（D6「存量数据兼容」行）：sync 批写面（flushBatch /
// markBatchFinalized 原语——manifest 屏障 + 落标 entry 显式覆写）已整体删除，本文件
// 守的是**存量 entry / manifest 的读侧容忍面**——旧 session 文件必须可读：
//
//   1. 存量落标 entry（batchFinalized=true）经真实落盘 → 末条扫描 + rebuildEntryRecord
//      投影读回带标记，不炸不丢；
//   2. 存量批成员 manifest（批时代产物词汇：legacy status + executionStatus 并存）→
//      无子文件锚时 manifest 源兜底投影可读；
//   3. 存量批成员 record 经 record-store 重建路径（collectRecords）完整投影。
//
// 通路保真：RecordStore / ManifestStore 走真实实现（tmpdir 自建自删，红线），仅
// pi.appendEntry 为 mock（种子的观察点）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { ManifestStore } from "../persistence/manifest-store.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../assembly/path-encoding.ts";
import { createMemberRecord } from "./helpers/subagent-record-fixture.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";

const ROOT_SESSION = "root-batch-finalized";

/** 存量批成员 record 形态（rebuildEntryRecord 解析门槛字段齐备——共享 fixture 工厂）。 */
const memberRecord = createMemberRecord({ task: "batch task", slug: "batch", rootSessionId: ROOT_SESSION });

describe("[collect 退役] 存量 batchFinalized entry / manifest 读侧容忍——旧 session 文件必须可读", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;
  let mainFile: string;
  let appendEntryMock: Mock<(customType: string, data: unknown) => void>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-batch-finalized-"));
    sessionsDir = getSubagentSessionDir(tmpDir, tmpDir);
    manifestDir = getSubagentRecordsDir(tmpDir, tmpDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(manifestDir, { recursive: true });
    mainFile = path.join(tmpDir, "main-session.jsonl");
    appendEntryMock = vi.fn();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 真实组合路径 service（initSession 供给 mainSessionFile 主 entry 源——生产读旧
   *  session 文件的唯一入口；assert pi 不落盘，恢复段对自洽种子零写入）。 */
  function makeCompatService(): SubagentService {
    const modelService = new ModelConfigService({ agentDir: tmpDir, cwd: tmpDir });
    modelService.initModel({
      sessionId: ROOT_SESSION,
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
      modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
    });
    const service = new SubagentService({ cwd: tmpDir, modelService });
    service.initSession({ pi: { appendEntry: appendEntryMock, events: { emit: vi.fn() }, sendMessage: vi.fn(), on: vi.fn() }, sessionId: ROOT_SESSION, mainSessionFile: mainFile });
    return service;
  }

  /** 写文件 pi（种子用）：appendEntry 真写主 session JSONL（pi 落盘形态）。 */
  function makeWritingPi() {
    return {
      appendEntry: (customType: string, data: unknown) => {
        fs.appendFileSync(
          mainFile,
          `${JSON.stringify({
            type: "custom",
            id: `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            parentId: null,
            timestamp: new Date().toISOString(),
            customType,
            data,
          })}\n`,
          "utf-8",
        );
      },
    };
  }

  it("存量落标 entry（batchFinalized=true）经真实落盘→末条扫描投影读回带标记，不炸", () => {
    const store = new RecordStore(sessionsDir, undefined, makeWritingPi(), manifestDir);
    // 成员 A：register（running）→ 终态（idle + gc + result）两笔真实 entry
    store.reportSubagentRecord(memberRecord({ id: "sa-bf-a" }));
    store.reportSubagentRecord(
      memberRecord({ id: "sa-bf-a", status: "idle", closedReason: "gc", endedAt: 2000, result: "done-a" }),
    );
    // 成员 B：存量落标形态（batchFinalized=true——批时代落标/归档透传 entry 的
    // 磁盘遗留词汇；写侧已删，读侧必须容忍解析）
    store.reportSubagentRecord(
      memberRecord({ id: "sa-bf-b", status: "idle", closedReason: "gc", endedAt: 3000, batchFinalized: true }),
    );

    // 读侧：真实 readFileSync 扫描 + 投影（store 测试后门访问，零 mock 断言面）
    const fresh = new RecordStore(sessionsDir, undefined, { appendEntry: appendEntryMock }, manifestDir);
    const scanned = fresh.scanLastRecordEntries(mainFile);
    const byId = new Map(scanned.map((r) => [r.id, r]));

    const a = byId.get("sa-bf-a");
    expect(a).toBeDefined();
    expect(a!.status).toBe("idle");
    expect(a!.result).toBe("done-a");
    expect(a!.batchFinalized).toBeUndefined();
    const b = byId.get("sa-bf-b");
    expect(b).toBeDefined();
    expect(b!.batchFinalized).toBe(true);
    expect(b!.closedReason).toBe("gc");

    // [collect 退役] pi entry-only record 不经 store 投影是设计内语义（H4 M1
    // 「不重物化」——mergeEntrySourceRecords 收窄到 zcode 锚）：读侧容忍面 =
    // entry 末条扫描链（session-reader 反查投影同源），上方断言已覆盖；此处补
    // 「initSession 恢复段对存量标记 entry 不炸」（真实组合路径全链跑通）。
    const svc = makeCompatService();
    svc.dispose();
    fresh.dispose();
    store.dispose();
  });

  it("存量批成员 manifest（批时代产物词汇）无子文件锚时 manifest 源兜底投影可读", () => {
    // 磁盘遗留形态：批写面 batchManifestRecord 产物词汇（legacy status 三态与
    // executionStatus 并存）+ 无子 session 文件（manifest 源兜底路径）。
    fs.writeFileSync(
      path.join(manifestDir, "sa-bf-manifest.json"),
      JSON.stringify({
        id: "sa-bf-manifest",
        rootSessionId: ROOT_SESSION,
        agentName: "/agents/worker.md",
        status: "running",
        executionStatus: "running",
        createdAt: 1000,
        completedAt: 2000,
        task: "batch task",
        slug: "batch",
      }),
      "utf-8",
    );

    const store = new RecordStore(sessionsDir, new ManifestStore(manifestDir));
    const rec = store.collectRecords(10, "all").find((r) => r.id === "sa-bf-manifest");
    expect(rec).toBeDefined();
    // manifest 源投影按 executionStatus 两态权威词读回：legacy running = §3.2.8
    // 活跃成员词汇 → running 投影（活跃可见），不炸、不丢 identity。
    expect(rec?.status).toBe("running");
    expect(rec?.agent).toBe("/agents/worker.md");
    expect(rec?.task).toBe("batch task");
    store.dispose();
  });

  it("存量批成员 entry 与 manifest 并存 → collectRecords 重建投影完整（容忍既有 entry）", () => {
    const store = new RecordStore(sessionsDir, new ManifestStore(manifestDir), makeWritingPi(), manifestDir);
    // 存量形态：落标 entry（batchFinalized=true + 终态五字段）+ 批时代 manifest 并存
    store.reportSubagentRecord(
      memberRecord({
        id: "sa-bf-both",
        status: "idle",
        closedReason: "gc",
        endedAt: 4000,
        result: "both-sources",
        batchFinalized: true,
      }),
    );
    fs.writeFileSync(
      path.join(manifestDir, "sa-bf-both.json"),
      JSON.stringify({
        id: "sa-bf-both",
        rootSessionId: ROOT_SESSION,
        agentName: "/agents/worker.md",
        status: "running",
        executionStatus: "idle",
        closedReason: "gc",
        createdAt: 1000,
        completedAt: 4000,
        task: "batch task",
        slug: "batch",
      }),
      "utf-8",
    );

    // 模拟重启重建：走真实 SubagentService.initSession 组合路径。manifest 存在 →
    // manifest 源兜底投影（无子文件锚时的可见面），容忍既有 entry 并存不炸、
    // identity 不丢；落标标记不在 manifest 词汇——entry 扫描链读取（同上）。
    const svc = makeCompatService();
    // queries 面无 rootFilter 参数——rootSessionId 由 initSession 供给的 sessionRootId
    // 内部承担（ROOT_SESSION 过滤语义一致）。
    const rec = svc.queries.collectRecords(10, "all").find((r) => r.id === "sa-bf-both");
    expect(rec).toBeDefined();
    expect(rec!.status).toBe("idle"); // manifest executionStatus=idle 两态权威词读回
    expect(rec!.agent).toBe("/agents/worker.md");
    expect(rec!.task).toBe("batch task");
    // 标记经 entry 末条扫描链可见（session-reader 反查投影同源）
    const fresh = new RecordStore(sessionsDir, new ManifestStore(manifestDir), makeWritingPi(), manifestDir);
    const scanned = fresh.scanLastRecordEntries(mainFile);
    expect(scanned.find((r) => r.id === "sa-bf-both")!.batchFinalized).toBe(true);
    fresh.dispose();
    svc.dispose();
    store.dispose();
  });
});
