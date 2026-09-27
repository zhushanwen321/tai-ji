// src/execution/__tests__/record-store-round-manifest.test.ts
//
// [B2 / 簿记⑫] markRoundIdle 轮终派生 manifest 投影（ctx.writeDerivedManifest 注入
// 位，record-store.ts 构造点绑定 writeManifestPersisted(derivedManifestRecord(
// recordToSubagent(rec)))）的单元级断言——修复前 tool/chat origin 的轮终链零 manifest
// 落盘，records/ 目录对轮终 record 长期缺席，session-reader 的 manifest 直读主路径
// 永不命中（只能落 entry 慢兜底）：
//   1. zcode 腿（engine==='zcode' + engineHandle.sessionRef 双键齐）：manifest 落盘
//      且满足 session-reader zcode 判据（zcode-manifest.ts toZcodeManifestRecord 谓词
//      ——engine 判别 + sessionRef 双键非空 + id/rootSessionId 非空 string）；
//   2. pi 腿对照（sessionFile 在场）：manifest 被 isRecordManifest 守卫语义接受
//      （subagents.ts 三必填 id/rootSessionId/sessionFile），idle 派生投影形态 =
//      legacy "running" + executionStatus "idle" 双写（与 dev 实测 derived 投影一致）；
//   3. 回归对照：markFinalized 终态路径产物形态不变（closed + closedReason）；
//   4. 跨轮幂等：同一 record 多轮轮终重复写派生投影（缓存性质），manifest 恒为
//      最新合法 idle 形态。
//
// 测试纪律：真实 fs 落盘断言（写面形态本身是断言对象）；fixture 一律 mkdtempSync
// 自建自删（tmpdir），不触碰真实数据目录。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecord } from "../persistence/execution-record.ts";
import { RecordStore } from "../persistence/record-store.ts";
import type { ExecutionRecord } from "../assembly/types.ts";

/** 构造 ExecutionRecord（running 基线，over 覆盖）。 */
function makeRecord(id: string, over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const base = createRecord(id, {
    agent: "worker",
    model: "m",
    mode: "background",
    task: "t",
    slug: "round-manifest",
    startedAt: 1000,
    rootSessionId: "sess-current",
  });
  return { ...base, ...over };
}

function makeStore(sessionsDir: string, manifestDir: string): RecordStore {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(manifestDir, { recursive: true });
  return new RecordStore(sessionsDir, undefined, { appendEntry: vi.fn() }, manifestDir);
}

describe("markRoundIdle 轮终派生 manifest 投影（B2 簿记⑫）", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;
  let sessionFile: string;
  let store: RecordStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "round-manifest-"));
    sessionsDir = path.join(tmpDir, "sessions");
    manifestDir = path.join(tmpDir, "records");
    store = makeStore(sessionsDir, manifestDir);
    sessionFile = path.join(sessionsDir, "2026-01-01_uuid.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8"); // pi 锚文件在盘（writeSettledState 写 sidecar 同目录）
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const readManifest = (id: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(manifestDir, `${id}.json`), "utf-8")) as Record<string, unknown>;

  it("zcode 腿：manifest 落盘且满足 session-reader zcode 判据（engine + sessionRef 双键 + executionStatus idle）", () => {
    const dbPath = path.join(tmpDir, "session-db", "db.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true }); // ⑪ binding 快照写锚键同目录
    const record = makeRecord("bg-zcode", {
      engine: "zcode",
      engineHandle: { sessionRef: { sessionId: "z-sess-1", dbPath }, poolKey: "shared" },
    });
    store.register(record);

    expect(store.markRoundIdle("bg-zcode", { kind: "success", content: "zcode done" })).toBe(true);

    expect(fs.existsSync(path.join(manifestDir, "bg-zcode.json"))).toBe(true);
    const raw = readManifest("bg-zcode");
    // session-reader zcode 谓词（toZcodeManifestRecord）：engine 判别第一 +
    // engineHandle.sessionRef 双键非空 + id/rootSessionId 非空 string。
    expect(raw["engine"]).toBe("zcode");
    const handle = raw["engineHandle"] as { sessionRef: Record<string, unknown> };
    expect(handle.sessionRef["sessionId"]).toBe("z-sess-1");
    expect(handle.sessionRef["dbPath"]).toBe(dbPath);
    expect(raw["id"]).toBe("bg-zcode");
    expect(raw["rootSessionId"]).toBe("sess-current");
    // 两态词汇双写：权威词 idle + legacy 派生 running（轮终 idle 无 closedReason）。
    expect(raw["executionStatus"]).toBe("idle");
    expect(raw["status"]).toBe("running");
    // [F21] zcode record 无 sessionFile：键被 JSON.stringify 丢弃（zcode 直读路径
    // 存在的原因——pi isRecordManifest 对本 manifest 恒丢弃，不误入 pi 扫描链）。
    expect("sessionFile" in raw).toBe(false);
  });

  it("pi 腿对照：manifest 被 isRecordManifest 守卫语义接受（三必填 string）+ idle 派生投影双写形态", () => {
    const record = makeRecord("bg-pi", { sessionFile });
    store.register(record);

    expect(store.markRoundIdle("bg-pi", { kind: "success", content: "pi done" })).toBe(true);

    const raw = readManifest("bg-pi");
    // isRecordManifest 三必填（session-reader subagents.ts）：id/rootSessionId/sessionFile。
    expect(typeof raw["id"]).toBe("string");
    expect(typeof raw["rootSessionId"]).toBe("string");
    expect(raw["sessionFile"]).toBe(sessionFile);
    // 派生投影单点（legacyManifestStatusFields）：轮终 idle 无 closedReason →
    // legacy "running"（session-reader 视角活跃成员）+ executionStatus "idle"（权威词）。
    expect(raw["status"]).toBe("running");
    expect(raw["executionStatus"]).toBe("idle");
    expect(raw["closedReason"]).toBeUndefined();
  });

  it("回归对照：markFinalized 终态路径产物形态不变（closed + closedReason）", () => {
    const record = makeRecord("bg-final", { sessionFile });
    // 终态内存冻结留调用方（completeRecord/tryTransition 桥接——markFinalized 只吸收
    // 持久化面，不回写 record.closedReason，见 record-store 方法头）。
    record.closedReason = "gc";
    store.register(record);

    expect(store.markFinalized(record)).toBe(true);

    const raw = readManifest("bg-final");
    expect(raw["status"]).toBe("closed");
    expect(raw["closedReason"]).toBe("gc");
    expect(raw["executionStatus"]).toBe("idle");
  });

  it("跨轮幂等：多轮轮终重复写派生投影（缓存性质），manifest 恒为最新合法 idle 形态", () => {
    const record = makeRecord("bg-multi", { sessionFile });
    store.register(record);
    store.markRoundIdle("bg-multi", { kind: "success", content: "r1" });
    store.markRoundIdle("bg-multi", { kind: "success", content: "r2" });

    const raw = readManifest("bg-multi");
    expect(raw["id"]).toBe("bg-multi");
    expect(raw["status"]).toBe("running");
    expect(raw["executionStatus"]).toBe("idle");
  });
});
