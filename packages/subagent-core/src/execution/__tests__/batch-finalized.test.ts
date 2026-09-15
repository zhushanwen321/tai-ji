// src/execution/__tests__/batch-finalized.test.ts
//
// [U3 / D1] 批写归口后的 barrier 语义测试（设计 docs/design/subagent-record-
// persistence-consolidation.md §3.1 markBatchFinalized 行 + §3.3 D4②/D5）：
//
//   1. flush 调用面（SyncCollectDomain 直构 + 真 RecordStore；[modeless 波3] E1 恢复
//      调用面随 collectMode 记录态消亡退役，barrier 保证改由批闭合 flush 路径承接）：
//      notifyBatch（写账入口）被调用的时刻，全部成员 manifest 必已在磁盘——「manifest
//      落盘完成先于批通知写账」的构造性保证（违反即红；迁移前 fire-and-forget 形态该
//      时点只大概率成立）；
//   2. 原语（manifestDir 接线，构造点同步分支）：markBatchFinalized await 返回即
//      manifest 文件可见（无 fire-and-forget）+ 落标 entry 携带 batchFinalized 显式
//      覆写（[modeless 波3] collectMode 覆写随字段消亡删除）+ 落标写出的时点 manifest
//      已在（原语内部序）；
//   3. 原语（降级分支，manifestDir 缺省——双轨期形态）：allSettled 屏障后落标，
//      barrier 语义与同步分支等价。
//
// 与 record-store-intent-api.test.ts（U1，store 单体语义）的分工：本文件断言
// **调用面时序**——批通知写账（notifyBatch）/ 落标 entry 写出的时刻 manifest 必已
// 就位，即 D1 验收条款的字面断言面。
//
// 通路保真：RecordStore / SyncCollectDomain / ManifestStore 走真实实现（tmpdir
// 自建自删，红线），仅 pi.appendEntry / notifyHost 为 mock（写账与落标的观察点）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { ManifestStore } from "../persistence/manifest-store.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../assembly/path-encoding.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { SyncCollectDomain } from "../service/sync-collect-domain.ts";
import type { SubagentRecord } from "../assembly/types.ts";

const ROOT_SESSION = "root-batch-finalized";

/** 种子成员 record（对齐 sync-collect-recovery.test.ts memberRecord 形态——
 *  rebuildEntryRecord 解析门槛字段齐备）。 */
function memberRecord(overrides: Partial<SubagentRecord> & { id: string }): SubagentRecord {
  return {
    agent: "/agents/worker.md",
    task: "batch task",
    slug: "batch",
    status: "running",
    mode: "background",
    startedAt: 1000,
    rootSessionId: ROOT_SESSION,
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 0,
    totalTokens: 0,
    model: "prov/m1",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    result: undefined,
    error: undefined,
    sessionFile: undefined,
    ...overrides,
  };
}

describe("batch-finalized 归口（U3/D1）——barrier：manifest 落盘完成先于批通知写账", () => {
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

  it("flush 调用面：notifyBatch 写账时点全成员 manifest 已落盘（构造性 barrier，违反即红）", async () => {
    // [modeless 波3] 驱动面改批闭合 flush（E1 恢复调用面退役）：成员派发登记 →
    // 终态 route 入批 → 去抖窗口到期闭合 flush。种子成员经 getFullRecord 冷路径
    // 不可达（无子文件锚/manifest）→ S11 缓冲快照兜底落标（覆盖同款）。
    const store = new RecordStore(sessionsDir, undefined, { appendEntry: appendEntryMock }, manifestDir);
    const notifyBatch = vi.fn(() => true);
    const closeMembers = vi.fn(async (_ids: readonly string[]) => {});
    const domain = new SyncCollectDomain({
      getStore: () => store,
      getNotifyHost: () => ({
        // route 快照投影 stub：透传 id/终态字段（真实 toNotifyRecord 的最小同构——
        // 本文件断言面在 manifest 屏障时序，载荷投影形态由 notify-host 测试承保）。
        toNotifyRecord: (record: { id: string }) => ({
          id: record.id,
          status: "closed" as const,
          agent: "/agents/worker.md",
          model: "prov/m1",
          result: undefined,
          error: undefined,
          startedAt: 1000,
          endedAt: 2000,
        }),
        notify: () => {},
        notifyBatch,
      }),
      closeMembers,
      getSessionRootId: () => ROOT_SESSION,
      getCollectSyncSection: () => undefined,
    });
    const coordinator = domain.collectCoordinator;

    // 写账时点钩子（严格时序门）：notifyBatch 被调用的时刻，两成员 manifest 必已
    // 在磁盘——这是 D1 barrier 的字面断言面（「通知可达 ⇒ 索引就位」）。
    const manifestsAtLedgerWrite: boolean[] = [];
    notifyBatch.mockImplementation(() => {
      manifestsAtLedgerWrite.push(
        fs.existsSync(path.join(manifestDir, "sa-bf-a.json")),
        fs.existsSync(path.join(manifestDir, "sa-bf-b.json")),
      );
      return true;
    });

    // 派发登记 + 背靠背终态 route（同宏任务合批窗口——U8 语义）
    coordinator.registerMember("sa-bf-a");
    coordinator.registerMember("sa-bf-b");
    const recA = { id: "sa-bf-a", agent: "/agents/worker.md", model: "prov/m1", startedAt: 1000, endedAt: 2000, result: "done-a" };
    const recB = { id: "sa-bf-b", agent: "/agents/worker.md", model: "prov/m1", startedAt: 1000, endedAt: 2000, result: "done-b" };
    expect(coordinator.route(recA as never)).toBe("sync-flushed");
    expect(coordinator.route(recB as never)).toBe("sync-flushed");
    // 去抖窗口到期 → flushBatch 闭包 await 完整屏障序列（manifest → 写账 → 落标 → close）。
    // 手写短轮询（本包 vitest 4.1.8 环境 vi.waitFor 对 falsy callback 不轮询——collect-
    // coordinator-service.test.ts sanity 实证，同款绕开）。
    const deadline = Date.now() + 3000;
    while (closeMembers.mock.calls.length === 0) {
      if (Date.now() > deadline) throw new Error("batch-finalized: flush closeMembers not reached within 3000ms");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(notifyBatch).toHaveBeenCalledTimes(1);
    expect(manifestsAtLedgerWrite).toEqual([true, true]);
    expect(closeMembers).toHaveBeenCalledWith(["sa-bf-a", "sa-bf-b"]);
    // 落标随 markBatchFinalized 前置完成（U3 归口）：两成员各一笔带标记 entry
    //（S11 兜底形态——getFullRecord miss 成员以缓冲快照落标）。
    const marks = appendEntryMock.mock.calls
      .filter((c) => c[0] === "subagent-record")
      .map((c) => c[1] as Record<string, unknown>)
      .filter((d) => d["batchFinalized"] === true);
    expect(marks.map((m) => m["id"]).sort()).toEqual(["sa-bf-a", "sa-bf-b"]);
  });

  it("原语（manifestDir 接线 / 同步分支）：await 返回即 manifest 可见；落标 entry 写出时点 manifest 已在", async () => {
    const store = new RecordStore(sessionsDir, undefined, { appendEntry: appendEntryMock }, manifestDir);
    const members = [memberRecord({ id: "sa-sync-1" }), memberRecord({ id: "sa-sync-2" })];

    // 落标时点钩子：appendEntry（落标写面）触发的时刻，该成员 manifest 必已存在
    // （原语内部序 = manifest 落盘完成先于批通知写账/落标 entry）。
    appendEntryMock.mockImplementation((_type: string, data: unknown) => {
      const d = data as { id?: string };
      if (typeof d?.id === "string") {
        expect(fs.existsSync(path.join(manifestDir, `${d.id}.json`)), `manifest of ${d.id} at entry time`).toBe(true);
      }
    });

    await store.markBatchFinalized(members);

    // 写后即刻可见（无 fire-and-forget——D8 writeSync 语义）。
    expect(fs.existsSync(path.join(manifestDir, "sa-sync-1.json"))).toBe(true);
    expect(fs.existsSync(path.join(manifestDir, "sa-sync-2.json"))).toBe(true);
    // 落标 entry：batchFinalized 显式覆写（防非 entry 源重建丢标记；[modeless 波3]
    // collectMode 覆写随字段消亡删除）。
    expect(appendEntryMock).toHaveBeenCalledTimes(2);
    expect(appendEntryMock).toHaveBeenCalledWith(
      "subagent-record",
      expect.objectContaining({ id: "sa-sync-1", batchFinalized: true }),
    );
  });

  it("原语（降级分支 / manifestDir 缺省——双轨期形态）：allSettled 屏障后落标，barrier 语义等价", async () => {
    // 缺省 manifestDir：store 降级走 manifestStore.writeManifest 异步屏障（双轨期
    // 现行语义，D7）——await 完成后 manifest 照常落盘 + 落标在其后（顺序不变）。
    const store = new RecordStore(
      sessionsDir,
      new ManifestStore(manifestDir),
      { appendEntry: appendEntryMock },
    );
    appendEntryMock.mockImplementation((_type: string, data: unknown) => {
      const d = data as { id?: string };
      if (typeof d?.id === "string") {
        expect(fs.existsSync(path.join(manifestDir, `${d.id}.json`)), `manifest of ${d.id} at entry time`).toBe(true);
      }
    });

    await store.markBatchFinalized([memberRecord({ id: "sa-degraded" })]);

    expect(fs.existsSync(path.join(manifestDir, "sa-degraded.json"))).toBe(true);
    expect(appendEntryMock).toHaveBeenCalledWith(
      "subagent-record",
      expect.objectContaining({ id: "sa-degraded", batchFinalized: true }),
    );
  });
});
