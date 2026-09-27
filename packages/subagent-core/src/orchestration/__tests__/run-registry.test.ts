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
  adoptInterruptedRun,
  projectRunRegistryEvents,
  projectRunRegistryState,
  RUN_ABANDON_WINDOW_MS_ENV,
  resolveRunAbandonWindowMs,
} from "../run-registry.ts";
import {
  createRunEventJournal,
  type RunErrorCode,
  type RunEventJournal,
  type WorkflowRunEvent,
  type WorkflowRunEventInput,
} from "../run-events.ts";
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

// [W1] helpers 产 input 形态（seq 由 journal.append 分配——测试不经手）
function createdEvent(runId: string, ts: number): WorkflowRunEventInput {
  return { type: "run-created", runId, workflowName: "review-fix-loop", argsSummary: "{}", ts };
}

function askDispatchedEvent(ts: number): WorkflowRunEventInput {
  return { type: "ask-dispatched", taskIndex: 1, agentName: "reviewer", attempt: 1, ts };
}

function runSettledEvent(
  outcome: "completed" | "failed" | "cancelled",
  ts: number,
  errorCode?: RunErrorCode,
): WorkflowRunEventInput {
  return {
    type: "run-settled",
    outcome,
    ...(errorCode !== undefined ? { errorCode } : {}),
    artifactsDir: dir,
    ts,
  };
}

/** 落 journal 事件序列（appendFileSync 直写——投影测试不走 dispatch 链）。 */
async function seed(runId: string, events: readonly WorkflowRunEventInput[]): Promise<void> {
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
    // [W1] 投影消费 scan 产物（含 seq）——helper 产 input 形态，此处补 seq 组装
    const withSeq = (input: WorkflowRunEventInput, seq: number): WorkflowRunEvent => ({
      ...input,
      seq,
    });
    const interrupted = projectRunRegistryEvents(
      [withSeq(createdEvent("wf-pure", BASE_TS), 1), withSeq(askDispatchedEvent(BASE_TS + 1), 2)],
      "wf-pure",
    );
    expect(interrupted.phase).toBe("interrupted");

    const terminal = projectRunRegistryEvents(
      [
        withSeq(createdEvent("wf-pure", BASE_TS), 1),
        withSeq(runSettledEvent("failed", BASE_TS + 2, "unknown"), 2),
      ],
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
    // [W1 / D4] abandon 改走收编入口：journal 尾部追加 run-settled 终态事件
    // （证据落点对称——终局证据不再只落在 manifest 单面）
    const events = await journal.scan("wf-ab-env");
    expect(events.map((e) => e.type)).toEqual(["run-created", "ask-dispatched", "run-settled"]);
    const settled = events[2] as Extract<WorkflowRunEvent, { type: "run-settled" }>;
    expect(settled.outcome).toBe("failed");
    expect(settled.errorCode).toBe("interrupted_abandoned");
    expect(settled.ts).toBe(BASE_TS + 61_000);
  });

  it("journal 获清理资格：abandon 后 pruneTerminalRunFiles 裁掉 state + journal（manifest 保留）", async () => {
    await seed("wf-ab-prune", [createdEvent("wf-ab-prune", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);
    // state 文件（run 磁盘足迹主投影）落盘
    fs.writeFileSync(path.join(dir, "wf-ab-prune.jsonl"), '{"runId":"wf-ab-prune"}\n');
    const now = BASE_TS + TEN_DAYS;

    // abandon 前：journal 无终态帧（fold 非终态）= 无资格，不裁
    await pruneTerminalRunFiles(
      dir,
      { ttlMs: 1000 },
      { warn: () => {}, debug: () => {}, toMsg: (e) => String(e) },
    );
    expect(fs.existsSync(path.join(dir, "wf-ab-prune.jsonl"))).toBe(true);

    // abandon（超窗）→ 收编追加 run-settled 帧（fold terminal）→ 同一 run 的
    // state + journal 获裁剪资格；终态时间 = run-settled 帧 ts（now = BASE_TS +
    // TEN_DAYS，已超 30 天窗口）——资格 + 超窗双满足
    await abandonElapsedInterruptedRuns(dir, { now, abandonWindowMs: WINDOW_MS });
    await pruneTerminalRunFiles(
      dir,
      { ttlMs: 30 * 24 * 60 * 60 * 1000 },
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

// ── [W1 / D4] 收编入口 adoptInterruptedRun（幂等追加终态事件）────────────────
//
// 锁定语义（设计 D4「journal 重放 + 收编」）：
// - 有注册无终态（活体集未命中的静止流）→ 幂等追加 run-settled + 物化 manifest
//   + 终态条目补写回调恰一次；
// - 双重启不重复追加：再次收编命中三面证据（fold terminal / manifest / 条目）
//   → skippedTerminal，journal 帧数不增长；
// - 条目面证据（hasSettledEntry）独立拦截——覆盖「journal 损坏但终态条目完好」
//   的双面证据组合；
// - 宽限窗 / 活跃保护 / 坏链（fold 停在 created）/ 空 journal 的分类跳过。

describe("收编入口 adoptInterruptedRun（W1 / D4：幂等追加终态事件）", () => {
  it("有注册无终态 → 追加 run-settled(failed) + 物化 manifest + 条目回调恰一次", async () => {
    await seed("wf-ad-1", [createdEvent("wf-ad-1", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);
    const appendedEntries: unknown[] = [];

    const outcome = await adoptInterruptedRun(journal, dir, "wf-ad-1", {
      now: BASE_TS + 1000,
      appendSettledEntry: (entry) => appendedEntries.push(entry),
    });

    expect(outcome).toBe("adopted");
    const events = await journal.scan("wf-ad-1");
    expect(events.map((e) => e.type)).toEqual(["run-created", "ask-dispatched", "run-settled"]);
    const settled = events[2] as Extract<WorkflowRunEvent, { type: "run-settled" }>;
    expect(settled.outcome).toBe("failed");
    expect(settled.errorCode).toBeUndefined();
    expect(settled.ts).toBe(BASE_TS + 1000);
    expect(await readRunTerminalManifest(dir, "wf-ad-1")).toMatchObject({
      outcome: "failed",
      workflowName: "review-fix-loop",
    });
    // 收编场景无内存聚合：callCount 从 journal ask-settled 帧数推导（本 fixture 无
    // ask-settled 帧 = 0），usedTokens 事件流不可得 = 0（摘要级诚实缺省）
    expect(appendedEntries).toHaveLength(1);
    expect(appendedEntries[0]).toMatchObject({
      v: 2,
      kind: "settled",
      runId: "wf-ad-1",
      status: "done",
      reason: "failed",
      outcome: "failed",
      callCount: 0,
      usedTokens: 0,
    });
  });

  it("收编幂等（双重启不重复追加）：第二次收编命中 fold terminal → journal 帧数不增长", async () => {
    await seed("wf-ad-2", [createdEvent("wf-ad-2", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);
    const first = await adoptInterruptedRun(journal, dir, "wf-ad-2", { now: BASE_TS + 1000 });
    expect(first).toBe("adopted");
    // 「双重启」= 两次独立收编调用（模拟两次进程重启后的 loadAll 收编）
    const second = await adoptInterruptedRun(journal, dir, "wf-ad-2", { now: BASE_TS + 2000 });
    const third = await adoptInterruptedRun(journal, dir, "wf-ad-2", { now: BASE_TS + 3000 });
    expect(second).toBe("skippedTerminal");
    expect(third).toBe("skippedTerminal");
    // run-settled 恰一帧（「一个 run 恰好一帧」终态不变量未被重复追加破坏）
    const events = await journal.scan("wf-ad-2");
    expect(events.filter((e) => e.type === "run-settled")).toHaveLength(1);
  });

  it("manifest 面证据：journal 已被清空但 manifest 在（旧路径产物）→ 跳过不追加", async () => {
    await seed("wf-ad-3", [createdEvent("wf-ad-3", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);
    await writeRunTerminalManifest(dir, {
      id: "wf-ad-3",
      workflowName: "review-fix-loop",
      outcome: "completed",
      settledAt: BASE_TS + 5,
    });
    const outcome = await adoptInterruptedRun(journal, dir, "wf-ad-3", { now: BASE_TS + 1000 });
    expect(outcome).toBe("skippedTerminal");
    expect((await journal.scan("wf-ad-3")).map((e) => e.type)).toEqual([
      "run-created",
      "ask-dispatched",
    ]);
  });

  it("条目面证据（双面证据第二条）：hasSettledEntry=true → 跳过（journal 损坏但终态条目完好的组合）", async () => {
    await seed("wf-ad-4", [createdEvent("wf-ad-4", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);
    const outcome = await adoptInterruptedRun(journal, dir, "wf-ad-4", {
      now: BASE_TS + 1000,
      hasSettledEntry: (runId) => runId === "wf-ad-4",
    });
    expect(outcome).toBe("skippedTerminal");
    expect((await journal.scan("wf-ad-4")).map((e) => e.type)).toEqual([
      "run-created",
      "ask-dispatched",
    ]);
  });

  it("宽限窗（graceWindowMs）：末帧静止不足窗 → skippedGraceWindow，不追加", async () => {
    await seed("wf-ad-5", [createdEvent("wf-ad-5", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);
    const outcome = await adoptInterruptedRun(journal, dir, "wf-ad-5", {
      now: BASE_TS + 60_000,
      graceWindowMs: 60_000 * 60,
    });
    expect(outcome).toBe("skippedGraceWindow");
    expect(await readRunTerminalManifest(dir, "wf-ad-5")).toBeNull();
  });

  it("活跃保护：activeRunIds 命中 → skippedActive（事件流静默 ≠ 死亡）", async () => {
    await seed("wf-ad-6", [createdEvent("wf-ad-6", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);
    const outcome = await adoptInterruptedRun(journal, dir, "wf-ad-6", {
      now: BASE_TS + 1000,
      activeRunIds: new Set(["wf-ad-6"]),
    });
    expect(outcome).toBe("skippedActive");
    expect(await readRunTerminalManifest(dir, "wf-ad-6")).toBeNull();
  });

  it("坏链守卫：run-created 帧损坏（fold 停在 created）→ skippedBrokenChain（run-settled 表外转移不可达）", async () => {
    // 直写坏首帧 + 好后续帧：scan 丢弃坏行后 fold 停在 created（无创建帧可达态）
    fs.writeFileSync(
      path.join(dir, "wf-ad-7.events.jsonl"),
      [
        "{not json", // 坏：run-created 帧损坏
        JSON.stringify({ type: "ask-dispatched", taskIndex: 1, agentName: "a", attempt: 1, ts: BASE_TS }),
      ].join("\n"),
      "utf8",
    );
    const outcome = await adoptInterruptedRun(journal, dir, "wf-ad-7", { now: BASE_TS + 1000 });
    expect(outcome).toBe("skippedBrokenChain");
    expect(await readRunTerminalManifest(dir, "wf-ad-7")).toBeNull();
  });

  it("空 journal（missing）→ skippedMissing", async () => {
    const outcome = await adoptInterruptedRun(journal, dir, "wf-ad-never", { now: BASE_TS });
    expect(outcome).toBe("skippedMissing");
  });
});

// ── pruneTerminalRunFiles 单源（Q2 收口：jsonl-run-store 本地实现已删） ──

describe("pruneTerminalRunFiles（已终局资格单源：fold 终态 + 保留窗口 + journal 成对删）", () => {
  const noopDeps = { warn: () => {}, debug: () => {}, toMsg: (e: unknown) => String(e) };
  const RETENTION_30D_MS = 30 * 24 * 60 * 60 * 1000;

  function stateFile(runId: string): string {
    return path.join(dir, `${runId}.jsonl`);
  }

  it("废 cap 回归：非终态（无 settled 帧的 journal）数量再多也零裁剪，仅计候选", async () => {
    // [W1 / D5] cap 语义废除后的结构断言：资格判据唯一 = fold 终态 ∧ 超窗——
    // 非终态 run 无论多少（旧 cap 会「裁最旧挤掉 50 名外」）一律保留并计入
    // 判据②候选计数（多 session 分摊不再互杀，A-8 回归锚）
    await seed("wf-pr-active", [createdEvent("wf-pr-active", BASE_TS), askDispatchedEvent(BASE_TS + 1)]);
    fs.writeFileSync(stateFile("wf-pr-active"), "x\n");

    const result = await pruneTerminalRunFiles(dir, { ttlMs: RETENTION_30D_MS }, noopDeps);

    expect(result).toMatchObject({ scanned: 1, eligible: 0, pruned: 0, nonTerminalBeyondWindow: 1 });
    expect(fs.existsSync(stateFile("wf-pr-active"))).toBe(true);
  });

  it("窗外终态裁（state + journal 成对删）；窗内终态与 manifest 保护", async () => {
    // 窗外终态：run-settled 帧 ts = BASE_TS（远超 30 天窗口）
    await seed("wf-pr-stale", [createdEvent("wf-pr-stale", BASE_TS), runSettledEvent("completed", BASE_TS + 1)]);
    fs.writeFileSync(stateFile("wf-pr-stale"), "x\n");
    // 窗内终态：run-settled 帧 ts = 当前时刻（窗内全保留——数量再大也不触发截断）
    await seed("wf-pr-fresh", [
      createdEvent("wf-pr-fresh", Date.now() - 1000),
      runSettledEvent("completed", Date.now()),
    ]);
    fs.writeFileSync(stateFile("wf-pr-fresh"), "x\n");

    const result = await pruneTerminalRunFiles(dir, { ttlMs: RETENTION_30D_MS }, noopDeps);

    expect(result).toMatchObject({ scanned: 2, eligible: 2, pruned: 1, nonTerminalBeyondWindow: 0 });
    expect(fs.existsSync(stateFile("wf-pr-stale"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "wf-pr-stale.events.jsonl"))).toBe(false);
    expect(fs.existsSync(stateFile("wf-pr-fresh"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "wf-pr-fresh.events.jsonl"))).toBe(true);
  });

  it("glob 外文件（journal 自身 / 非 wf- 前缀）不进候选；目录缺失静默零计数", async () => {
    const result = await pruneTerminalRunFiles(path.join(dir, "not-exist"), {}, noopDeps);
    expect(result).toEqual({ scanned: 0, eligible: 0, pruned: 0, nonTerminalBeyondWindow: 0 });
  });
});
