// src/execution/__tests__/record-store-round-idle-settle.test.ts
//
// [A-lite / 区1-U1 + 区3-U1] markRoundIdle 正常轮终磁盘侧增补（簿记⑩⑪）的
// 单元级断言——真实轮终路径（store.markRoundIdle 直驱，= finalizeRoundOutcome
// 编排薄壳的最终写点，非 markSettled("gc") 构造）：
//   1. 成功/失败轮后 `.state` 收条在场（{status:"idle", reason: completed|failed,
//      endedAt}——轮收尾 idle 形态，重建单规则一律 idle）；
//   2. binding 快照 turns/totalTokens 在场（U7 统计口径）；
//   3. rec.stopReason 内存展示位（completed/failed）且 status 翻 idle（
//      [two-state-convergence U4/D3] 写侧翻边）、endedAt 不写（A3 终态冻结判据不击穿
//      ——跨轮轮终不抛）；
//   4. 新 store 实例 markResurrected revive 水合不归零（turns/tokens/round 从
//      binding 快照恢复——正常轮终后宿主崩溃的最常见形态）；
//   5. zcode 路径锚分派：无 sessionFile 时快照写 transcriptRef 派生锚键、`.state`
//      不写（对齐 markSettled），revive 水合同样不归零；
//   6. 双锚皆缺（spawn 窗口期）：warn 留痕不抛，内存簿记照常。
//
// 测试纪律：真实 fs 落盘断言（不 mock state-marker——写侧形态本身是断言对象）；
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecord } from "../persistence/execution-record.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { readRecordBinding, zcodeAnchorBasePath } from "../persistence/state-marker.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";

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
  });
  return { ...base, ...over };
}

function makeStore(sessionsDir: string, manifestDir: string): RecordStore {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(manifestDir, { recursive: true });
  return new RecordStore(() => sessionsDir, undefined, { appendEntry: vi.fn() }, () => manifestDir);
}

describe("markRoundIdle 正常轮终磁盘侧（A-lite 簿记⑩⑪）", () => {
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
    fs.writeFileSync(sessionFile, "{}\n", "utf-8"); // 锚文件在盘（binding 快照写 sidecar 同目录）
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 轮终收条改由事件流承载（③：`.state` 退场）：读最后一条 record-round-idle 帧。 */
  const lastRoundIdle = (id: string): { stopReason?: string; ts?: number } | undefined => {
    const file = path.join(manifestDir, `${id}.events`);
    if (!fs.existsSync(file)) return undefined;
    const idles = fs
      .readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type?: string; stopReason?: string; ts?: number })
      .filter((e) => e.type === "record-round-idle");
    return idles.at(-1);
  };

  it("成功轮（pi 锚）：收条 reason=completed + binding 快照在场 + 内存翻 idle/stopReason + revive 水合不归零", () => {
    const record = makeRecord("bg-ok", { sessionFile });
    record.turnCount = 3;
    record.totalTokens = 1200;
    store.register(record);

    expect(store.markRoundIdle("bg-ok", { kind: "success", content: "round output" })).toBe(true);

    // ⑩ 内存展示位：status 翻 idle（[two-state-convergence U4/D3] 写侧翻边——idle 即
    // resumable，resumable 不再写）、endedAt 不写（终态冻结信号——写了会击穿方法头
    // A3 断言的跨轮轮终）。
    expect(record.status).toBe("idle");
    expect(record.stopReason).toBe("completed");
    expect(record.round).toBe(1);
    expect(record.endedAt).toBeUndefined();
    expect(record.result).toBe("round output");
    // ⑥ idleSince 已退役（30 天空闲回收判据锚，ADR-0081）——轮终不再写 idle 锚。
    // ⑪ `.state` 收条：轮收尾 idle 形态（重建单规则一律 idle）。
    const idle = lastRoundIdle("bg-ok");
    expect(idle?.stopReason).toBe("completed");
    expect(typeof idle?.ts).toBe("number");
    // ⑪ binding 快照（U7 统计口径）：turns/totalTokens 在场。
    const binding = readRecordBinding(sessionFile);
    expect(binding?.turns).toBe(3);
    expect(binding?.totalTokens).toBe(1200);
    expect(binding?.round).toBe(1);

    // [U7] 正常轮终后宿主崩溃的最常见形态：新 store 实例（模拟重启）+ createRecord
    // 产物（统计归零）→ markResurrected revive 水合不归零。wasClosed=true 对齐生产
    // 形态（round-terminal 崩溃后 cold-lookup 重建恒 idle 以 wasClosed=true 进入，
    // 顺带覆盖 .state 终态位删除分支）。
    const revivedStore = makeStore(sessionsDir, manifestDir);
    const revived = makeRecord("bg-ok", { sessionFile, status: "idle" });
    expect(revived.turnCount).toBe(0);
    expect(revived.totalTokens).toBe(0);
    revivedStore.markResurrected(revived, true);
    expect(revived.turnCount).toBe(3);
    expect(revived.totalTokens).toBe(1200);
    expect(revived.round).toBe(1);
  });

  it("[W1 / D3 表行 4] 轮终帧携带 result 摘要锚（record-settled 同款截断——承接 v1 轮终 result 显示信号）", () => {
    const record = makeRecord("bg-round-result", { sessionFile });
    store.register(record);

    const longResult = "x".repeat(260);
    expect(store.markRoundIdle("bg-round-result", { kind: "success", content: longResult })).toBe(true);

    // record-round-idle 帧的 resultSummary = 截断摘要（200 字 + 省略号，全文不进事件行）
    const lines = fs
      .readFileSync(path.join(manifestDir, "bg-round-result.events"), "utf-8")
      .trim()
      .split("\n");
    const idle = lines
      .map((l) => JSON.parse(l) as { type?: string; resultSummary?: string; error?: string })
      .find((e) => e.type === "record-round-idle");
    expect(idle?.resultSummary).toBe(`${"x".repeat(200)}…`);
    // 成功轮失败原因原文缺席（W1 终态同步 F2-2——error 仅失败轮承载）
    expect(idle?.error).toBeUndefined();
  });

  it("失败轮（pi 锚）：收条 reason=failed + lastError + 内存 stopReason=failed + binding 快照在场", () => {
    const record = makeRecord("bg-fail", { sessionFile });
    record.turnCount = 1;
    record.totalTokens = 300;
    store.register(record);

    expect(store.markRoundIdle("bg-fail", { kind: "failed", reason: "engine crashed" })).toBe(true);

    expect(record.stopReason).toBe("failed");
    expect(record.status).toBe("idle");
    expect(record.lastError).toBe("engine crashed");
    expect(record.result).toContain("engine crashed");
    const idle = lastRoundIdle("bg-fail");
    expect(idle?.stopReason).toBe("failed");
    expect(typeof idle?.ts).toBe("number");
    expect(readRecordBinding(sessionFile)?.turns).toBe(1);
    expect(readRecordBinding(sessionFile)?.totalTokens).toBe(300);
    // 帧面：record-round-idle 携带失败原因原文（W1 终态同步 F2-2——v1 rec.error
    // 显示信号的 journal 承接，派生视图 error 供源）
    const failLines = fs
      .readFileSync(path.join(manifestDir, "bg-fail.events"), "utf-8")
      .trim()
      .split("\n");
    const failIdle = failLines
      .map((l) => JSON.parse(l) as { type?: string; error?: string })
      .find((e) => e.type === "record-round-idle");
    expect(failIdle?.error).toBe("engine crashed");
  });

  it("跨轮轮终不击穿 A3 断言（endedAt 不写）+ `.state` 轮终收条随最新轮覆写（每轮先过轮始门）", () => {
    const record = makeRecord("bg-multi", { sessionFile });
    store.register(record);
    expect(store.markRoundIdle("bg-multi", { kind: "success", content: "r1" })).toBe(true);
    // 第二轮：先过轮始门（[§4] 轮终原语的同状态在途门——连续两次轮终会被拒绝），
    // 再失败轮终——断言收条 reason 跟随最新轮（单槽收尾位覆写）。
    expect(store.markRoundStarted("bg-multi")).toBe(true);
    expect(() => store.markRoundIdle("bg-multi", { kind: "failed", reason: "r2 boom" })).not.toThrow();
    expect(record.round).toBe(2);
    expect(record.stopReason).toBe("failed");
    expect(lastRoundIdle("bg-multi")?.stopReason).toBe("failed");
    // 第三轮同款：轮始门 → 成功轮终；A3 断言（endedAt）始终不被击穿。
    expect(store.markRoundStarted("bg-multi")).toBe(true);
    expect(() => store.markRoundIdle("bg-multi", { kind: "success", content: "r3" })).not.toThrow();
    expect(record.round).toBe(3);
    expect(lastRoundIdle("bg-multi")?.stopReason).toBe("completed");
  });

  it("zcode 路径锚分派：快照写 transcriptRef 派生锚键、`.state` 不写、revive 水合不归零", () => {
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
    expect(record.status).toBe("idle");
    // tmpdir 下无任何 `.state` / `.record-binding` 产出（无锚无写侧）。
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

// ============================================================
// [subagent-observability §3.3.3/§3.3.6] markRoundIdle 轮收条事实化：
//   - 停因事实优先（引擎原值 engineStopReason 在场 → 旧展示位走派生展示词）；
//   - 失败分类/接管三态/usage 事实快照（帧 + rec.lastRound 内存读侧双承载）；
//   - 被接管轮（promptDisposition=handled）：无停因、无失败分类、空正文、结清 no_result；
//   - pending 结清枚举新写入方（completed/failed/no_result 按轮终事实，旧 "running" 退役）；
//   - 失败事实入账走 SDK appendErrorFact 单点（errors 只追加 + lastError 派生——u2 移交收编）。
// ============================================================
describe("markRoundIdle 轮收条事实化（subagent-observability u3）", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;
  let sessionFile: string;
  let store: RecordStore;
  let settlements: Array<{ id: string; reason: string }>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "round-facts-"));
    sessionsDir = path.join(tmpDir, "sessions");
    manifestDir = path.join(tmpDir, "records");
    store = makeStore(sessionsDir, manifestDir);
    settlements = [];
    store.setPendingUnregister((id, reason) => settlements.push({ id, reason }));
    sessionFile = path.join(sessionsDir, "2026-01-01_uuid.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const readIdleFrame = (id: string): Record<string, unknown> | undefined => {
    const file = path.join(manifestDir, `${id}.events`);
    if (!fs.existsSync(file)) return undefined;
    const idles = fs
      .readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === "record-round-idle");
    return idles.at(-1);
  };

  it("引擎停因事实在场：帧事实字段 + rec.lastRound 快照 + 旧展示位派生（error → failed）+ 结清 failed", () => {
    const record = makeRecord("bg-fact-error", { sessionFile });
    record.turnCount = 6;
    store.register(record);

    expect(
      store.markRoundIdle("bg-fact-error", {
        kind: "failed",
        reason: "429: tier_limit_exceeded, resets 2026-10-24T06:58:00Z",
        engineStopReason: "error",
        failure: {
          class: "provider",
          kind: "rate_limited",
          retryable: "conditional",
          retryAfterMs: 1_320_000,
          raw: "429: tier_limit_exceeded, resets 2026-10-24T06:58:00Z",
        },
      }),
    ).toBe(true);

    // 事实字段：帧并行产出（§3.4 迁移期双写）。
    const frame = readIdleFrame("bg-fact-error");
    expect(frame?.engineStopReason).toBe("error");
    expect(frame?.failure).toMatchObject({ class: "provider", kind: "rate_limited", retryable: "conditional" });
    // 旧展示位 = 事实派生（引擎停因 error → failed——非旧写入判据「没报错=completed」）。
    expect(record.stopReason).toBe("failed");
    expect(frame?.stopReason).toBe("failed");
    // 事实快照（内存读侧权威源——recordToSubagent/list 消费）。
    expect(record.lastRound).toMatchObject({
      engineStopReason: "error",
      failure: { class: "provider", kind: "rate_limited" },
    });
    // 结清枚举：轮失败结清 = failed。
    expect(settlements).toEqual([{ id: "bg-fact-error", reason: "failed" }]);
    // 失败事实入账（appendErrorFact 单点——errors 只追加 + lastError 派生）。
    expect(record.lastError).toContain("tier_limit_exceeded");
    expect(record.errors?.at(-1)?.message).toContain("tier_limit_exceeded");
  });

  it("被接管轮（promptDisposition=handled）：无停因、无失败分类、空正文、结清 no_result（§3.3.1 P6 第三形态）", () => {
    const record = makeRecord("bg-handled", { sessionFile });
    store.register(record);

    expect(
      store.markRoundIdle("bg-handled", {
        kind: "success",
        content: "",
        promptDisposition: "handled",
      }),
    ).toBe(true);

    // 轮终层记事实：engineStopReason 无值（引擎未执行）+ promptDisposition=handled +
    // 空正文 + 不写 FailureCause；「正常收尾」派生判据要求停因 stop——本形态无停因
    // 构造性不满足，stopReason 不写。
    expect(record.stopReason).toBeUndefined();
    expect(record.result).toBe("");
    expect(record.lastRound).toEqual({ promptDisposition: "handled" });
    const frame = readIdleFrame("bg-handled");
    expect(frame?.stopReason).toBeUndefined();
    expect(frame?.engineStopReason).toBeUndefined();
    expect(frame?.failure).toBeUndefined();
    expect(frame?.promptDisposition).toBe("handled");
    // 结清：被接管 = 无果（细因经轮收条 promptDisposition 披露，§3.3.6）。
    expect(settlements).toEqual([{ id: "bg-handled", reason: "no_result" }]);
  });

  it("正常收尾事实：engineStopReason=stop 且无失败分类 → 展示词 completed + 结清 completed（旧展示位=事实派生）", () => {
    const record = makeRecord("bg-fact-stop", { sessionFile });
    store.register(record);

    expect(
      store.markRoundIdle("bg-fact-stop", {
        kind: "success",
        content: "done",
        engineStopReason: "stop",
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, cost: 0 },
        retryAttempts: 0,
      }),
    ).toBe(true);

    expect(record.stopReason).toBe("completed");
    expect(record.lastRound).toMatchObject({
      engineStopReason: "stop",
      retryAttempts: 0,
    });
    expect(record.lastRound?.usage?.output).toBe(2);
    const frame = readIdleFrame("bg-fact-stop");
    expect(frame?.engineStopReason).toBe("stop");
    expect(frame?.stopReason).toBe("completed");
    expect(frame?.usage).toMatchObject({ output: 2 });
    expect(settlements).toEqual([{ id: "bg-fact-stop", reason: "completed" }]);
  });
});
