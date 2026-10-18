// src/__tests__/records-cwd-isolation.test.ts
//
// T5（F1 端到端补充）：验证 records 目录分区物理隔离——不同归属会话（rootSessionId）
// 的 manifest 互相不可见：一个会话树的 ManifestStore 读不到另一棵树的 manifest。
//
// [session-store-layout-inversion] 分区键演化：旧布局 getSubagentRecordsDir(agentDir, cwd)
// 按 cwd 编码段分区（F1 时代语义）；新布局分区键 = rootSessionId（session 存储树
// `<root>/<rootSid>/subagents/records/`），随会话整树回收。本文件从「cwd 物理隔离」
// 改写为「rootSessionId 树物理隔离」——隔离性仍要被测（测试意图保留，分区键换源）。
//
// T1（path-encoding.test.ts）已覆盖路径层契约；本测试补一个真实 fs + ManifestStore 的
// 端到端隔离烟雾测试，避免 SubagentService 构造成本（需 mock ModelConfigService/PiLike 等）。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ManifestRecord } from "../persistence/manifest-store.ts";
import { ManifestStore } from "../persistence/manifest-store.ts";
import { getSubagentRecordsDir } from "../assembly/path-encoding.ts";

let tmpDataDir: string;

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "records-cwd-iso-"));
});

afterEach(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 写一个最小合法的 manifest 到指定 records 目录。 */
function writeManifest(recordsDir: string, id: string): string {
  fs.mkdirSync(recordsDir, { recursive: true });
  const rec: ManifestRecord = {
    id,
    rootSessionId: "sess-1",
    agentName: "worker",
    status: "closed",
    createdAt: Date.now(),
  };
  const filePath = path.join(recordsDir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(rec), "utf-8");
  return filePath;
}

describe("[F1/T5] records rootSessionId tree physical isolation", () => {
  it("ManifestStore bound to session tree A cannot read tree B's manifest (physical isolation)", () => {
    const sidA = "sid-iso-tree-a";
    const sidB = "sid-iso-tree-b";
    const recordsDirA = getSubagentRecordsDir(sidA, tmpDataDir);
    const recordsDirB = getSubagentRecordsDir(sidB, tmpDataDir);

    // 两棵会话树的 records 目录必须物理不同（已在 T1 路径层覆盖，这里再断言一次作为前提）
    expect(recordsDirA).not.toBe(recordsDirB);

    // 只在 A 树的 records 目录写一个 manifest
    writeManifest(recordsDirA, "rec-tree-a");

    const storeA = new ManifestStore(() => recordsDirA);
    const storeB = new ManifestStore(() => recordsDirB);

    const aIds = storeA.listAllSync().map((m) => m.id);
    const bIds = storeB.listAllSync().map((m) => m.id);

    // A 树能读到自己的 manifest
    expect(aIds).toContain("rec-tree-a");
    // B 树物理读不到 A 树的 manifest（不再依赖 rootSessionFilter 软过滤）
    expect(bIds).not.toContain("rec-tree-a");
    expect(bIds).toEqual([]);
  });

  it("two session trees with their own manifests are mutually invisible", () => {
    const sidA = "sid-iso-tree-a2";
    const sidB = "sid-iso-tree-b2";
    const recordsDirA = getSubagentRecordsDir(sidA, tmpDataDir);
    const recordsDirB = getSubagentRecordsDir(sidB, tmpDataDir);

    writeManifest(recordsDirA, "rec-a");
    writeManifest(recordsDirB, "rec-b");

    const storeA = new ManifestStore(() => recordsDirA);
    const storeB = new ManifestStore(() => recordsDirB);

    const aIds = storeA.listAllSync().map((m) => m.id);
    const bIds = storeB.listAllSync().map((m) => m.id);

    expect(aIds).toEqual(["rec-a"]);
    expect(bIds).toEqual(["rec-b"]);
  });
});
