// src/execution/__tests__/batch-finalized.test.ts
//
// [collect 退役 / 登记 §3.3] 读侧守卫：sync 批写面（flushBatch / markBatchFinalized
// 原语）与 v1 全量快照兼容读面（toSubagentRecordEntry / rebuildEntryRecord）已整体
// 删除，本文件守的是**现行 v2 条目与存量 manifest 的读侧容忍面**——旧 session 文件
// 必须可读：
//
//   1. v2 条目对（registered + settled）经真实落盘 → 末条扫描（collectV2EntryPairs +
//      v2PairToRecord）投影读回终局域，不炸不丢；
//   2. 存量批成员 manifest（批时代产物词汇：legacy status + executionStatus 并存）→
//      无子文件锚时 manifest 源兜底投影可读；
//   3. v2 条目与 manifest 并存 → record-store 重建路径（collectRecords）完整投影。
//
// v2 条目契约不承载 batchFinalized / closedReason / worktree / round / patchFile——
// 只检查这些遗留字段的断言无 v2 来源，已随兼容层删除（见各用例内注释）。
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
import { SUBAGENT_RECORD_CUSTOM_TYPE } from "../persistence/record-entry.ts";
import { SubagentService } from "../subagent-service.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import { v2Entries } from "./helpers/v2-record-entry.ts";

// [teardown 竞态修复] 被测链传递性 logger 输出经 console 落 stderr——同步用例的刷写落在
// 文件结束的 teardown 窗口，与 worker rpc 关闭竞态 → vitest EnvironmentTeardownError
// （onUserConsoleLog pending）→ run 退出码 1。本文件对 logger 零断言依赖，mock 静默
// （rebuild-indexes.test.ts 同款先例）。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

const ROOT_SESSION = "root-batch-finalized";

/** 批成员 record 形态（v2 条目投影门槛字段齐备——共享 fixture 工厂）。 */
const memberRecord = createMemberRecord({ task: "batch task", slug: "batch", rootSessionId: ROOT_SESSION });

describe("[collect 退役] v2 条目 / 存量 manifest 读侧容忍——旧 session 文件必须可读", () => {
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

  it("v2 注册 + 终态条目经真实落盘→末条扫描投影读回终局域，不炸", () => {
    // 现行主 session 条目契约 = 注册 + 终态两条小条目（record-entry.ts v2）。旧
    // 「落标 entry」（batchFinalized=true）已无任何 v2 写入侧，兼容读面亦随 v1 快照
    // 层删除——本用例守 v2 条目对经真实落盘 → scanLastRecordEntries 投影的终局域
    // 保真（终态条目携带的字段读回不丢）。
    const seedPi = makeWritingPi();
    for (const entry of v2Entries(
      memberRecord({ id: "sa-bf-a", status: "idle", endedAt: 2000, result: "done-a", stopReason: "completed" }),
    )) {
      seedPi.appendEntry(SUBAGENT_RECORD_CUSTOM_TYPE, entry);
    }

    // 读侧：真实 readFileSync 扫描 + 投影（store 测试后门访问，零 mock 断言面）
    const fresh = new RecordStore(sessionsDir, undefined, { appendEntry: appendEntryMock }, manifestDir);
    const scanned = fresh.scanLastRecordEntries(mainFile);
    const a = scanned.find((r) => r.id === "sa-bf-a");

    expect(a).toBeDefined();
    expect(a!.status).toBe("idle");
    expect(a!.result).toBe("done-a");
    expect(a!.stopReason).toBe("completed");
    expect(a!.endedAt).toBe(2000);
    // [已删除断言] batchFinalized / closedReason：v2 条目契约无此二字段的承载位
    // （v2PairToRecord 明确不投影），原断言在 v2 无来源。

    // [collect 退役] pi entry-only record 不经 store 投影是设计内语义（H4 M1
    // 「不重物化」——mergeEntrySourceRecords 收窄到 zcode 锚）：读侧容忍面 =
    // entry 末条扫描链（session-reader 反查投影同源），上方断言已覆盖；此处补
    // 「initSession 恢复段对 v2 条目不炸」（真实组合路径全链跑通）。
    const svc = makeCompatService();
    svc.dispose();
    fresh.dispose();
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

  it("v2 条目与 manifest 并存 → collectRecords 重建投影完整（容忍既有 entry）", () => {
    // 并存形态：v2 条目对（注册 + 终态）+ 批时代 manifest
    const seedPi = makeWritingPi();
    for (const entry of v2Entries(
      memberRecord({ id: "sa-bf-both", status: "idle", endedAt: 4000, result: "both-sources" }),
    )) {
      seedPi.appendEntry(SUBAGENT_RECORD_CUSTOM_TYPE, entry);
    }
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
    // identity 不丢。
    const svc = makeCompatService();
    // queries 面无 rootFilter 参数——rootSessionId 由 initSession 供给的 sessionRootId
    // 内部承担（ROOT_SESSION 过滤语义一致）。
    const rec = svc.queries.collectRecords(10, "all").find((r) => r.id === "sa-bf-both");
    expect(rec).toBeDefined();
    expect(rec!.status).toBe("idle"); // manifest executionStatus=idle 两态权威词读回
    expect(rec!.agent).toBe("/agents/worker.md");
    expect(rec!.task).toBe("batch task");
    // v2 条目对经末条扫描链读取（session-reader 反查投影同源）——终局域保真；
    // batchFinalized 已无 v2 来源（原断言删除）。
    const fresh = new RecordStore(sessionsDir, new ManifestStore(manifestDir), { appendEntry: appendEntryMock }, manifestDir);
    const scanned = fresh.scanLastRecordEntries(mainFile);
    const seeded = scanned.find((r) => r.id === "sa-bf-both");
    expect(seeded).toBeDefined();
    expect(seeded!.status).toBe("idle");
    expect(seeded!.result).toBe("both-sources");
    fresh.dispose();
    svc.dispose();
  });
});
