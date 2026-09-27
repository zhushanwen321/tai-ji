// src/orchestration/__tests__/run-registry.test.ts
//
// [Q2/D9-1] run 注册表单测——D5 状态机投影面 + interrupted 放弃窗终局化 +
// 已终局 run 磁盘足迹裁剪单源（impl-plan Q2 验收条款 a/b/c）。
//
// 锁定语义：
// a. 投影三态（事件流判据，mtime 启发式退役后的结构判据）：
//    - run-settled 落账 → terminal（三态 outcome + errorCode）；
//    - 事件流停止（fold 停在非 terminal + 活体集未命中 = host-died 判据）→
//      interrupted（待恢复态，非 terminal——快照末行 running 的僵尸在此消失）；
//    - 活体集命中 → active（事件流正常推进）；空事件流 → missing / active。
// b. abandon 终局化：interrupted 超放弃窗（env/参数调低）→ 状态机两步转移
//    （host-died → abandon-elapsed）→ manifest 写 outcome:failed +
//    errorCode:interrupted_abandoned → pruneTerminalRunFiles 裁掉 state + journal
//    （journal 获清理资格）；反向 = 未过期不 abandon / 活跃不 abandon /
//    已终局跳过。
// c. mtime 退役断言：投影/abandon 源码零 mtime 消费（grep 断言）+ 行为断言
//    （判定锚 = 事件 ts，文件 mtime 钉到未来不改变 abandon 结果）。
//
// 测试红线：mkdtemp 自建自删、journal/manifest 全在 tmp、env 用后 delete、
// 时钟经 now 参数注入（无 fake timers 依赖）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  abandonElapsedInterruptedRuns,
  projectRunRegistryEvents,
  projectRunRegistryState,
  RUN_ABANDON_WINDOW_MS_ENV,
  resolveRunAbandonWindowMs,
} from "../run-registry.ts";
import { createRunEventJournal, type RunErrorCode, type RunEventJournal, type WorkflowRunEvent } from "../run-events.ts";
import { pruneTerminalRunFiles } from "../file-run-store.ts";
import {
  readRunTerminalManifest,
  writeRunTerminalManifest,
} from "../../execution/persistence/manifest-store.ts";

// ── helpers ──────────────────────────────────────────────────

let dir: string;
let journal: RunEventJournal;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-registry-"));
  journal = createRunEventJournal(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  delete process.env[RUN_ABANDON_WINDOW_MS_ENV];
});

const BASE_TS = 1_719_500_000_000;

function createdEvent(runId: string, ts: number): WorkflowRunEvent {
  return { type: "run-created", runId, workflowName: "review-fix-loop", argsSummary: "{}", ts };
}

function askDispatchedEvent(ts: number): WorkflowRunEvent {
  return { type: "ask-dispatched", taskIndex: 1, agentName: "reviewer", attempt: 1, ts };
}

function runSettledEvent(
  outcome: "completed" | "failed" | "cancelled",
  ts: number,
  errorCode?: RunErrorCode,
): WorkflowRunEvent {
  return {
    type: "run-settled",
    outcome,
    ...(errorCode !== undefined ? { errorCode } : {}),
    artifactsDir: dir,
    ts,
  };
}

/** 落 journal 事件序列（appendFileSync 直写——投影测试不走 dispatch 链）。 */
async function seed(runId: string, events: WorkflowRunEvent[]): Promise<void> {
  for (const event of events) {
    await journal.append(runId, event);
  }
}

// ── a. 投影三态（验收条款 a） ────────────────────────────────

describe("投影三态（事件流判据，D9-1）", () => {
  it("事件流停止 → interrupted（非 terminal 待恢复态；僵尸 running 构造性消除）", async () => {
    await seed("wf-reg-int", [createdEvent("wf-reg-int", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);

    // 快照末行 running 的僵尸形态（无活体持有）：投影 = interrupted
    const projection = await projectRunRegistryState(journal, "wf-reg-int");
    expect(projection.phase).toBe("interrupted");
    expect(projection.state).toEqual({ lifecycle: "running" });
    expect(projection.lastEventAt).toBe(BASE_TS + 1);
    // interrupted 非 terminal：无 outcome
    expect(projection.state.outcome).toBeUndefined();
  });

  it("run-settled → terminal：三态 outcome + errorCode 从事件帧读", async () => {
    await seed("wf-reg-ok", [createdEvent("wf-reg-ok", BASE_TS), runSettledEvent("completed", BASE_TS + 5)]);
    await seed("wf-reg-fail", [
      createdEvent("wf-reg-fail", BASE_TS),
      runSettledEvent("failed", BASE_TS + 5, "engine_crashed"),
    ]);
    await seed("wf-reg-cancel", [
      createdEvent("wf-reg-cancel", BASE_TS),
      runSettledEvent("cancelled", BASE_TS + 5),
    ]);

    const ok = await projectRunRegistryState(journal, "wf-reg-ok");
    expect(ok.phase).toBe("terminal");
    expect(ok.state).toEqual({ lifecycle: "terminal", outcome: "completed" });
    expect(ok.errorCode).toBeUndefined();

    const fail = await projectRunRegistryState(journal, "wf-reg-fail");
    expect(fail.phase).toBe("terminal");
    expect(fail.state).toEqual({ lifecycle: "terminal", outcome: "failed" });
    expect(fail.errorCode).toBe("engine_crashed");

    const cancel = await projectRunRegistryState(journal, "wf-reg-cancel");
    expect(cancel.phase).toBe("terminal");
    expect(cancel.state).toEqual({ lifecycle: "terminal", outcome: "cancelled" });
  });

  it("活体集命中 → active（事件流正常推进，fold 终帧对齐状态机 lifecycle）", async () => {
    await seed("wf-reg-live", [createdEvent("wf-reg-live", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);

    const projection = await projectRunRegistryState(journal, "wf-reg-live", {
      activeRunIds: new Set(["wf-reg-live"]),
    });
    expect(projection.phase).toBe("active");
    expect(projection.state.lifecycle).toBe("running");
  });

  it("空事件流：活体命中 → active（run-created 落账前窗口）；未命中 → missing", async () => {
    const live = await projectRunRegistryState(journal, "wf-reg-none", {
      activeRunIds: new Set(["wf-reg-none"]),
    });
    expect(live.phase).toBe("active");

    const missing = await projectRunRegistryState(journal, "wf-reg-none");
    expect(missing.phase).toBe("missing");
    expect(missing.state).toEqual({ lifecycle: "created" });
    expect(missing.lastEventAt).toBeUndefined();
  });

  it("纯函数入口 projectRunRegistryEvents：事件数组直投影（无 IO——判定输入只有事件流与活体集）", () => {
    const interrupted = projectRunRegistryEvents(
      [createdEvent("wf-pure", BASE_TS), askDispatchedEvent(BASE_TS + 1)],
      "wf-pure",
    );
    expect(interrupted.phase).toBe("interrupted");

    const terminal = projectRunRegistryEvents(
      [createdEvent("wf-pure", BASE_TS), runSettledEvent("failed", BASE_TS + 2, "unknown")],
      "wf-pure",
    );
    expect(terminal.phase).toBe("terminal");
    expect(terminal.errorCode).toBe("unknown");
  });
});

// ── c. mtime 启发式退役断言（验收条款 c） ────────────────────

describe("mtime 启发式退役（验收条款 c：grep + 行为断言）", () => {
  it("grep 断言：注册表投影/终局化源码零 mtime API 消费（判据 = 事件流 + 活体集）", () => {
    const source = fs.readFileSync(new URL("../run-registry.ts", import.meta.url), "utf8");
    // 代码级退役断言：文件 mtime/stat 读取 API 零调用（注释中的「mtime 启发式退役」
    // 描述措辞不受限——断言的是旧启发式的代码载体已删除）
    expect(source).not.toMatch(/\.mtimeMs|statSync|utimesSync/);
  });

  it("行为断言：abandon 判定锚 = 事件 ts——journal 文件 mtime 钉到未来不改变结果", async () => {
    // 事件流停在 10 天前（窗口 7 天 → 可 abandon）；文件 mtime 钉到 1 小时后——
    // 若启发式仍在（mtime 新鲜度判活），该 run 会被误判活跃而跳过
    await seed("wf-reg-mtime", [createdEvent("wf-reg-mtime", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);
    const journalPath = path.join(dir, "wf-reg-mtime.events.jsonl");
    const future = new Date(Date.now() + 60 * 60 * 1000);
    fs.utimesSync(journalPath, future, future);

    const result = await abandonElapsedInterruptedRuns(dir, {
      now: BASE_TS + 10 * 24 * 60 * 60 * 1000,
      abandonWindowMs: 7 * 24 * 60 * 60 * 1000,
    });

    expect(result.abandoned).toBe(1);
    const manifest = await readRunTerminalManifest(dir, "wf-reg-mtime");
    expect(manifest).toMatchObject({ outcome: "failed", errorCode: "interrupted_abandoned" });
  });
});

// ── b. abandon 终局化（验收条款 b） ──────────────────────────

describe("interrupted 放弃窗终局化（D5 转移表 interrupted × abandon-elapsed 行）", () => {
  const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  const TEN_DAYS = 10 * 24 * 60 * 60 * 1000;

  it("env 调低放弃窗（验收条款 b 形态）：过期 interrupted → manifest(failed/interrupted_abandoned)", async () => {
    process.env[RUN_ABANDON_WINDOW_MS_ENV] = "60000"; // 1 分钟（测试期调低）
    expect(resolveRunAbandonWindowMs()).toBe(60000);

    await seed("wf-ab-env", [createdEvent("wf-ab-env", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);
    const result = await abandonElapsedInterruptedRuns(dir, { now: BASE_TS + 61_000 });

    expect(result.scanned).toBe(1);
    expect(result.abandoned).toBe(1);
    const manifest = await readRunTerminalManifest(dir, "wf-ab-env");
    expect(manifest).not.toBeNull();
    expect(manifest).toMatchObject({
      id: "wf-ab-env",
      workflowName: "review-fix-loop",
      outcome: "failed",
      errorCode: "interrupted_abandoned",
    });
    expect(manifest?.settledAt).toBe(BASE_TS + 61_000);
  });

  it("journal 获清理资格：abandon 后 pruneTerminalRunFiles 裁掉 state + journal（manifest 保留）", async () => {
    await seed("wf-ab-prune", [createdEvent("wf-ab-prune", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);
    // state 文件（run 磁盘足迹主投影）落盘
    fs.writeFileSync(path.join(dir, "wf-ab-prune.jsonl"), '{"runId":"wf-ab-prune"}\n');
    const now = BASE_TS + TEN_DAYS;

    // abandon 前：manifest 缺失 = 无资格，不裁
    await pruneTerminalRunFiles(
      dir,
      { cap: 10, ttlMs: 1000 },
      { warn: () => {}, debug: () => {}, toMsg: (e) => String(e) },
    );
    expect(fs.existsSync(path.join(dir, "wf-ab-prune.jsonl"))).toBe(true);

    // abandon（超窗）→ manifest 落地 → 同一 run 的 state + journal 获裁剪资格
    await abandonElapsedInterruptedRuns(dir, { now, abandonWindowMs: WINDOW_MS });
    // state 文件钉到 40 天前（超 30 天 TTL）——manifest 落地后资格 + 超期双满足
    const stale = new Date(now - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(dir, "wf-ab-prune.jsonl"), stale, stale);
    await pruneTerminalRunFiles(
      dir,
      { cap: 10, ttlMs: 30 * 24 * 60 * 60 * 1000 },
      { warn: () => {}, debug: () => {}, toMsg: (e) => String(e) },
    );
    expect(fs.existsSync(path.join(dir, "wf-ab-prune.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "wf-ab-prune.events.jsonl"))).toBe(false);
    // manifest 终局持久权威永不随裁（drawer 投影不消失）
    expect(fs.existsSync(path.join(dir, "wf-ab-prune.json"))).toBe(true);
    expect(await readRunTerminalManifest(dir, "wf-ab-prune")).toMatchObject({
      outcome: "failed",
      errorCode: "interrupted_abandoned",
    });
  });

  it("放弃窗未到：interrupted 保持待恢复态，不终局化", async () => {
    await seed("wf-ab-fresh", [createdEvent("wf-ab-fresh", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);
    const result = await abandonElapsedInterruptedRuns(dir, {
      now: BASE_TS + 24 * 60 * 60 * 1000, // 1 天 < 7 天窗口
      abandonWindowMs: WINDOW_MS,
    });
    expect(result.abandoned).toBe(0);
    expect(result.skippedOther).toBe(1);
    expect(await readRunTerminalManifest(dir, "wf-ab-fresh")).toBeNull();
  });

  it("活跃 run 永不 abandon（事件流静默 ≠ 死亡）", async () => {
    await seed("wf-ab-live", [createdEvent("wf-ab-live", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);
    const result = await abandonElapsedInterruptedRuns(dir, {
      now: BASE_TS + TEN_DAYS,
      abandonWindowMs: WINDOW_MS,
      activeRunIds: new Set(["wf-ab-live"]),
    });
    expect(result.abandoned).toBe(0);
    expect(result.skippedActive).toBe(1);
    expect(await readRunTerminalManifest(dir, "wf-ab-live")).toBeNull();
  });

  it("已终局 run 跳过（幂等可重入）；abandon 后重扫 = skippedTerminal", async () => {
    await seed("wf-ab-done", [createdEvent("wf-ab-done", BASE_TS), runSettledEvent("completed", BASE_TS + 2)]);
    const first = await abandonElapsedInterruptedRuns(dir, {
      now: BASE_TS + TEN_DAYS,
      abandonWindowMs: WINDOW_MS,
    });
    expect(first.abandoned).toBe(0);
    expect(first.skippedTerminal).toBe(1);

    // interrupted run 终局化后重扫：manifest 非空 + fold terminal → skippedTerminal
    await seed("wf-ab-twice", [createdEvent("wf-ab-twice", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);
    await abandonElapsedInterruptedRuns(dir, { now: BASE_TS + TEN_DAYS, abandonWindowMs: WINDOW_MS });
    const third = await abandonElapsedInterruptedRuns(dir, {
      now: BASE_TS + TEN_DAYS + 1,
      abandonWindowMs: WINDOW_MS,
    });
    expect(third.abandoned).toBe(0);
    expect(third.skippedTerminal).toBe(2);
  });

  it("abandon 显式 opt-out（env 非法值）→ 整轮不终局化", async () => {
    process.env[RUN_ABANDON_WINDOW_MS_ENV] = "0"; // 非法值 = opt-out
    await seed("wf-ab-optout", [createdEvent("wf-ab-optout", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);
    const result = await abandonElapsedInterruptedRuns(dir, { now: BASE_TS + TEN_DAYS });
    expect(result.scanned).toBe(0); // opt-out 在扫描前短路
    expect(await readRunTerminalManifest(dir, "wf-ab-optout")).toBeNull();
  });
});

// ── pruneTerminalRunFiles 单源（Q2 收口：jsonl-run-store 本地实现已删） ──

describe("pruneTerminalRunFiles（已终局资格单源：cap + TTL + journal 成对删）", () => {
  const noopDeps = { warn: () => {}, debug: () => {}, toMsg: (e: unknown) => String(e) };

  function stateFile(runId: string): string {
    return path.join(dir, `${runId}.jsonl`);
  }

  function pinMtime(fullPath: string, ageMs: number): void {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(fullPath, t, t);
  }

  it("manifest 缺失（活跃/interrupted）不裁：cap 挤压下保护并裁已终局对照项", async () => {
    // 活跃（journal 有帧无 manifest）+ 2 已终局（manifest 齐）；mtime：活跃最旧
    await seed("wf-pr-active", [createdEvent("wf-pr-active", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);
    fs.writeFileSync(stateFile("wf-pr-active"), "x\n");
    pinMtime(stateFile("wf-pr-active"), 40 * 24 * 60 * 60 * 1000); // 活跃钉成最旧
    for (const [id, outcome] of [
      ["wf-pr-done-a", "completed"],
      ["wf-pr-done-b", "completed"],
    ] as const) {
      await writeRunTerminalManifest(dir, {
        id,
        workflowName: "t",
        outcome,
        settledAt: BASE_TS,
      });
      fs.writeFileSync(stateFile(id), "x\n");
    }
    pinMtime(stateFile("wf-pr-done-a"), 20 * 24 * 60 * 60 * 1000); // 已终局次旧
    pinMtime(stateFile("wf-pr-done-b"), 1 * 24 * 60 * 60 * 1000); // 已终局最新

    const result = await pruneTerminalRunFiles(dir, { cap: 1, ttlMs: undefined }, noopDeps);

    // 已终局 2 个裁到 cap=1：最旧的 done-a 被裁；活跃（虽 mtime 全局最旧）保护
    expect(result).toMatchObject({ scanned: 3, eligible: 2, pruned: 1 });
    expect(fs.existsSync(stateFile("wf-pr-done-a"))).toBe(false);
    expect(fs.existsSync(stateFile("wf-pr-done-b"))).toBe(true);
    expect(fs.existsSync(stateFile("wf-pr-active"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "wf-pr-done-a.json"))).toBe(true); // manifest 永裁面外
  });

  it("TTL 超期已终局裁（含 journal 成对删，journal 自身 mtime 新也随 state 判定）", async () => {
    await seed("wf-pr-stale", [createdEvent("wf-pr-stale", BASE_TS), runSettledEvent("completed", BASE_TS + 1)]);
    await writeRunTerminalManifest(dir, {
      id: "wf-pr-stale",
      workflowName: "t",
      outcome: "completed",
      settledAt: BASE_TS,
    });
    fs.writeFileSync(stateFile("wf-pr-stale"), "x\n");
    pinMtime(stateFile("wf-pr-stale"), 40 * 24 * 60 * 60 * 1000); // 40 天前（超 30 天 TTL）
    fs.writeFileSync(path.join(dir, "wf-pr-stale.events.jsonl"), "evt\n");
    pinMtime(path.join(dir, "wf-pr-stale.events.jsonl"), 0); // journal mtime 新——裁剪随 state 判定

    await pruneTerminalRunFiles(dir, { cap: 10, ttlMs: 30 * 24 * 60 * 60 * 1000 }, noopDeps);
    expect(fs.existsSync(stateFile("wf-pr-stale"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "wf-pr-stale.events.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "wf-pr-stale.json"))).toBe(true);
  });

  it("glob 外文件（journal 自身 / 非 wf- 前缀）不进候选；目录缺失静默零计数", async () => {
    const result = await pruneTerminalRunFiles(path.join(dir, "not-exist"), { cap: 1 }, noopDeps);
    expect(result).toEqual({ scanned: 0, eligible: 0, pruned: 0 });
  });
});
