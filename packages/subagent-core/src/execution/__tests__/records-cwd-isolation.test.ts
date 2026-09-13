// src/__tests__/records-cwd-isolation.test.ts
//
// T5（F1 端到端补充）：验证 records 目录改 cwd-scoped 后，不同 cwd 的 manifest 物理
// 隔离——一个 cwd 的 ManifestStore 读不到另一个 cwd 的 manifest。
//
// F1 之前 recordsDir = path.join(agentDir, "records")（全局共享），所有 cwd 的 manifest
// 混在一个目录，靠 rootSessionFilter 软隔离。F1 改为 getSubagentRecordsDir(agentDir, cwd)
// 后，每个 cwd 物理独立目录，不再依赖软过滤。
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

let tmpAgentDir: string;

beforeEach(() => {
  tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "records-cwd-iso-"));
});

afterEach(() => {
  fs.rmSync(tmpAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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

describe("[F1/T5] records cwd physical isolation", () => {
  it("ManifestStore bound to cwd1 cannot read cwd2's manifest (physical isolation)", () => {
    const cwd1 = "/Users/x/proj-a";
    const cwd2 = "/Users/x/proj-b";
    const recordsDir1 = getSubagentRecordsDir(tmpAgentDir, cwd1);
    const recordsDir2 = getSubagentRecordsDir(tmpAgentDir, cwd2);

    // 两个 records 目录必须物理不同（已在 T1 路径层覆盖，这里再断言一次作为前提）
    expect(recordsDir1).not.toBe(recordsDir2);

    // 只在 cwd1 的 records 目录写一个 manifest
    writeManifest(recordsDir1, "rec-cwd1");

    const store1 = new ManifestStore(recordsDir1);
    const store2 = new ManifestStore(recordsDir2);

    const cwd1Ids = store1.listAllSync().map((m) => m.id);
    const cwd2Ids = store2.listAllSync().map((m) => m.id);

    // cwd1 能读到自己的 manifest
    expect(cwd1Ids).toContain("rec-cwd1");
    // cwd2 物理读不到 cwd1 的 manifest（不再依赖 rootSessionFilter 软过滤）
    expect(cwd2Ids).not.toContain("rec-cwd1");
    expect(cwd2Ids).toEqual([]);
  });

  it("two cwds with their own manifests are mutually invisible", () => {
    const cwdA = "/home/user/project-a";
    const cwdB = "/home/user/project-b";
    const recordsDirA = getSubagentRecordsDir(tmpAgentDir, cwdA);
    const recordsDirB = getSubagentRecordsDir(tmpAgentDir, cwdB);

    writeManifest(recordsDirA, "rec-a");
    writeManifest(recordsDirB, "rec-b");

    const storeA = new ManifestStore(recordsDirA);
    const storeB = new ManifestStore(recordsDirB);

    const aIds = storeA.listAllSync().map((m) => m.id);
    const bIds = storeB.listAllSync().map((m) => m.id);

    expect(aIds).toEqual(["rec-a"]);
    expect(bIds).toEqual(["rec-b"]);
  });
});
