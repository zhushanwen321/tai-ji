// src/execution/__tests__/record-store-round-idle-settle.test.ts
//
// [A-lite / 区1-U1 + 区3-U1] markRoundIdle 正常轮终磁盘面增补（簿记⑩⑪）的
// 单元级断言——真实轮终路径（store.markRoundIdle 直驱，= finalizeRoundOutcome
// 编排薄壳的最终写点，非 markSettled("gc") 构造）：
//   1. 成功/失败轮后 `.state` 收条在场（{status:"idle", reason: completed|failed,
//      endedAt}——轮收口 idle 形态，重建单规则一律 idle）；
//   2. binding 快照 turns/totalTokens 在场（U7 统计口径）；
//   3. rec.stopReason 内存展示位（completed/failed）且 status 保持
//      running-resumable、endedAt 不写（A3 终态冻结判据不击穿——跨轮轮终不抛）；
//   4. 新 store 实例 markResurrected revive 水合不归零（turns/tokens/round 从
//      binding 快照恢复——正常轮终后宿主崩溃的最常见形态）；
//   5. zcode 腿锚分派：无 sessionFile 时快照写 transcriptRef 派生锚键、`.state`
//      不写（对齐 markSettled），revive 水合同样不归零；
//   6. 双锚皆缺（spawn 窗口期）：warn 留痕不抛，内存簿记照常。
//
// 测试纪律：真实 fs 落盘断言（不 mock state-marker——写面形态本身是断言对象）；
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecord } from "../execution-record.ts";
import { RecordStore } from "../record-store.ts";
import { readRecordBinding, zcodeAnchorBasePath } from "../state-marker.ts";
import type { ExecutionRecord } from "../types.ts";

/** 构造 ExecutionRecord（running 基线，over 覆盖）。 */
function makeRecord(id: string, over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const base = createRecord(id, {
    agent: "worker",
    model: "m",
    mode: "background",
    task: "t",
    slug: "round-settle",
    startedAt: 1000,
    rootSessionId: "sess-current",
    chatMode: true,
  });
  return { ...base, ...over };
}

function makeStore(sessionsDir: string, manifestDir: string): RecordStore {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(manifestDir, { recursive: true });
  return new RecordStore(sessionsDir, undefined, { appendEntry: vi.fn() }, manifestDir);
}

describe("markRoundIdle 正常轮终磁盘面（A-lite 簿记⑩⑪）", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;
  let sessionFile: string;
  let store: RecordStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "round-idle-settle-"));
    sessionsDir = path.join(tmpDir, "sessions");
    manifestDir = path.join(tmpDir, "records");
    store = makeStore(sessionsDir, manifestDir);
    sessionFile = path.join(sessionsDir, "2026-01-01_uuid.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8"); // 锚文件在盘（writeSettledState 写 sidecar 同目录）
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const readStateJson = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(`${sessionFile}.state`, "utf-8")) as Record<string, unknown>;

  it("成功轮（pi 锚）：收条 reason=completed + binding 快照在场 + 内存 stopReason/保持 running + revive 水合不归零", () => {
    const record = makeRecord("bg-ok", { sessionFile });
    record.turnCount = 3;
    record.totalTokens = 1200;
    store.register(record);

    expect(store.markRoundIdle("bg-ok", { kind: "success", content: "round output" })).toBe(true);

    // ⑩ 内存展示位：status 保持 running-resumable（A-lite 不动 U2 桥接形态）、
    // endedAt 不写（终态冻结信号——写了会击穿方法头 A3 断言的跨轮轮终）。
    expect(record.status).toBe("running");
    expect(record.stopReason).toBe("completed");
    expect(record.resumable).toBe(true);
    expect(record.round).toBe(1);
    expect(record.endedAt).toBeUndefined();
    expect(record.result).toBe("round output");
    // ⑪ `.state` 收条：轮收口 idle 形态（重建单规则一律 idle）。
    const state = readStateJson();
    expect(state["status"]).toBe("idle");
    expect(state["reason"]).toBe("completed");
    expect(typeof state["endedAt"]).toBe("number");
    // ⑪ binding 快照（U7 统计口径）：turns/totalTokens 在场。
    const binding = readRecordBinding(sessionFile);
    expect(binding?.turns).toBe(3);
    expect(binding?.totalTokens).toBe(1200);
    expect(binding?.round).toBe(1);

    // [U7] 正常轮终后宿主崩溃的最常见形态：新 store 实例（模拟重启）+ createRecord
    // 产物（统计归零）→ markResurrected revive 水合不归零。
    const revivedStore = makeStore(sessionsDir, manifestDir);
    const revived = makeRecord("bg-ok", { sessionFile, status: "idle" });
    expect(revived.turnCount).toBe(0);
    expect(revived.totalTokens).toBe(0);
    revivedStore.markResurrected(revived, false);
    expect(revived.turnCount).toBe(3);
    expect(revived.totalTokens).toBe(1200);
    expect(revived.round).toBe(1);
  });

  it("失败轮（pi 锚）：收条 reason=failed + lastError + 内存 stopReason=failed + binding 快照在场", () => {
    const record = makeRecord("bg-fail", { sessionFile });
    record.turnCount = 1;
    record.totalTokens = 300;
    store.register(record);

    expect(store.markRoundIdle("bg-fail", { kind: "failed", reason: "engine crashed" })).toBe(true);

    expect(record.stopReason).toBe("failed");
    expect(record.status).toBe("running");
    expect(record.lastError).toBe("engine crashed");
    expect(record.result).toContain("engine crashed");
    const state = readStateJson();
    expect(state["status"]).toBe("idle");
    expect(state["reason"]).toBe("failed");
    expect(typeof state["endedAt"]).toBe("number");
    expect(readRecordBinding(sessionFile)?.turns).toBe(1);
    expect(readRecordBinding(sessionFile)?.totalTokens).toBe(300);
  });

  it("跨轮轮终不击穿 A3 断言（endedAt 不写）+ `.state` 收条随最新轮覆写", () => {
    const record = makeRecord("bg-multi", { sessionFile });
    store.register(record);
    store.markRoundIdle("bg-multi", { kind: "success", content: "r1" });
    // 第二轮：先失败轮终，再断言收条 reason 跟随最新轮（单槽收口位覆写）。
    expect(() => store.markRoundIdle("bg-multi", { kind: "failed", reason: "r2 boom" })).not.toThrow();
    expect(record.round).toBe(2);
    expect(record.stopReason).toBe("failed");
    expect(readStateJson()["reason"]).toBe("failed");
    // 同 record 第二次成功轮终（round=2 收口后的第三轮）也不抛——A3 只拦终态冻结。
    expect(() => store.markRoundIdle("bg-multi", { kind: "success", content: "r3" })).not.toThrow();
    expect(readStateJson()["reason"]).toBe("completed");
  });

  it("zcode 腿锚分派：快照写 transcriptRef 派生锚键、`.state` 不写、revive 水合不归零", () => {
    const dbPath = path.join(tmpDir, "session-db", "db.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const transcriptRef = { engine: "zcode", sessionId: "z-sess-1", dbPath } as const;
    const record = makeRecord("bg-zcode", { transcriptRef });
    record.turnCount = 5;
    record.totalTokens = 900;
    store.register(record);

    expect(store.markRoundIdle("bg-zcode", { kind: "success", content: "zcode done" })).toBe(true);

    // zcode 无 pi 文件锚（sessionFile undefined）——`.state` 不写（对齐 markSettled）。
    expect(record.sessionFile).toBeUndefined();
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
    // binding 快照落锚键基底（`<dbPath>.<sessionId>.record-binding`）。
    const anchorBase = zcodeAnchorBasePath(transcriptRef);
    const binding = readRecordBinding(anchorBase);
    expect(binding?.turns).toBe(5);
    expect(binding?.totalTokens).toBe(900);
    expect(binding?.transcriptRef).toEqual(transcriptRef);
    expect(record.stopReason).toBe("completed");

    // revive 水合（zcode 锚）：createRecord 产物统计归零 → markResurrected 恢复。
    const revivedStore = makeStore(sessionsDir, manifestDir);
    const revived = makeRecord("bg-zcode", { status: "idle", transcriptRef });
    revivedStore.markResurrected(revived, false);
    expect(revived.turnCount).toBe(5);
    expect(revived.totalTokens).toBe(900);
  });

  it("双锚皆缺（spawn 窗口期）：warn 留痕不抛、内存簿记照常、无 sidecar 产出", () => {
    const record = makeRecord("bg-noanchor");
    store.register(record);

    expect(() => store.markRoundIdle("bg-noanchor", { kind: "success", content: "x" })).not.toThrow();
    expect(record.stopReason).toBe("completed");
    expect(record.status).toBe("running");
    // tmpdir 下无任何 `.state` / `.record-binding` 产出（无锚无写面）。
    const stray = fs
      .readdirSync(tmpDir, { recursive: true })
      .filter((f) => String(f).endsWith(".state") || String(f).endsWith(".record-binding"));
    expect(stray).toEqual([]);
  });

  it("id 不在内存：false 且零副作用（debug 留痕语义不回归）", () => {
    expect(store.markRoundIdle("bg-missing", { kind: "success", content: "x" })).toBe(false);
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
  });
});
