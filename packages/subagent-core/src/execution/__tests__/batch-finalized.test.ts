// src/execution/__tests__/batch-finalized.test.ts
//
// [U3 / D1] 批写归口后的 barrier 语义测试（设计 docs/design/subagent-record-
// persistence-consolidation.md §3.1 markBatchFinalized 行 + §3.3 D4②/D5）：
//
//   1. E1 调用面（SyncCollectDomain 直构 + 真 RecordStore）：notifyBatch（写账入口）
//      被调用的时刻，全部成员 manifest 必已在磁盘——「manifest 落盘完成先于批通知
//      写账」的构造性保证（违反即红；迁移前 fire-and-forget 形态该时点只大概率成立）；
//   2. 原语（manifestDir 接线，构造点同步分支）：markBatchFinalized await 返回即
//      manifest 文件可见（无 fire-and-forget）+ 落标 entry 携带 collectMode/batchFinalized
//      显式覆写 + 落标写出的时点 manifest 已在（原语内部序）；
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

import { ManifestStore } from "../manifest-store.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../path-encoding.ts";
import { RecordStore } from "../record-store.ts";
import { SyncCollectDomain } from "../service/sync-collect-domain.ts";
import type { SubagentRecord } from "../types.ts";

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
    chatMode: false,
    collectMode: "sync",
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

  it("E1 调用面：notifyBatch 写账时点全成员 manifest 已落盘（构造性 barrier，违反即红）", async () => {
    // 种子：两成员（register running+sync → 终态 closed）经真实 reportSubagentRecord
    // 序列化落主文件——崩溃残留（全员终态 + 无标记）形态。
    const seedStore = new RecordStore(sessionsDir, undefined, makeWritingPi());
    for (const id of ["sa-bf-a", "sa-bf-b"]) {
      seedStore.reportSubagentRecord(memberRecord({ id }));
      seedStore.reportSubagentRecord(
        memberRecord({ id, status: "closed", closedReason: "gc", endedAt: 2000, result: `done-${id}` }),
      );
    }

    // 被测面：真 RecordStore（manifestDir 接线——构造点形态）+ 直构 SyncCollectDomain。
    const store = new RecordStore(sessionsDir, undefined, { appendEntry: appendEntryMock }, manifestDir);
    const notifyBatch = vi.fn(() => true);
    const domain = new SyncCollectDomain({
      getStore: () => store,
      getNotifyHost: () => ({
        toNotifyRecord: () => undefined,
        notify: () => {},
        notifyBatch,
      }),
      getPi: () => null,
      getSessionRootId: () => ROOT_SESSION,
      getMainSessionFile: () => mainFile,
      getCollectSyncSection: () => undefined,
    });

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

    await domain.recoverSyncCollectBatch();

    expect(notifyBatch).toHaveBeenCalledTimes(1);
    expect(manifestsAtLedgerWrite).toEqual([true, true]);
    // 落标随 markBatchFinalized 前置完成（U3 归口）：两成员各一笔带标记 entry。
    const marks = appendEntryMock.mock.calls
      .filter((c) => c[0] === "subagent-record")
      .map((c) => c[1] as Record<string, unknown>)
      .filter((d) => d["batchFinalized"] === true);
    expect(marks.map((m) => m["id"]).sort()).toEqual(["sa-bf-a", "sa-bf-b"]);
    for (const mark of marks) expect(mark["collectMode"]).toBe("sync");
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
    // 落标 entry：collectMode/batchFinalized 显式覆写（防非 entry 源重建丢标记）。
    expect(appendEntryMock).toHaveBeenCalledTimes(2);
    expect(appendEntryMock).toHaveBeenCalledWith(
      "subagent-record",
      expect.objectContaining({ id: "sa-sync-1", collectMode: "sync", batchFinalized: true }),
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
      expect.objectContaining({ id: "sa-degraded", collectMode: "sync", batchFinalized: true }),
    );
  });
});
