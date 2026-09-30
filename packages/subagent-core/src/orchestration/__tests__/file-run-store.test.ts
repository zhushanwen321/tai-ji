// file-run-store.test.ts —— run 状态保留期维护面（pruneTerminalRunFiles /
// 统一维护轮 runRetentionMaintenanceRound + record 首写触发接线）。
//
// 被测源 = execution/persistence/run-state-evidence.ts（终局证据判定核与保留期
// 维护自本目录旧 file-run-store.ts 拆解迁移，行为零变化——快照行 IO 测试随写
// 身份退役删除；判定核直测面在
// registry-reconcile/reconcile-sweep-settlement.test.ts）。
//
// 资格判据锚 = journal fold 终态（run-settled 帧驱动 fold 到 terminal，含收编产生
// 的 interrupted）；终态时间 = run-settled 帧 ts。时间注入 = 事件 ts 相对 Date.now
// 计算（天数偏移）；无 journal 创建帧的存量形态用 utimesSync 注入 mtime。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureCore, resetCoreForTests } from "../../core/host-services.ts";
import {
  createRecordEventJournal,
  type RecordJournalEventInput,
} from "../../execution/persistence/record-events.ts";
// [W1 / D5 触发点②] RecordStore.register 首写触发维护轮的行为断言面
import { RecordStore } from "../../execution/persistence/record-store.ts";
import { createRecord } from "../../execution/persistence/execution-record.ts";
// barrel 消费面回归锚：维护轮入口经 barrel 导出（三触发点接线面，U7 消费同路径）
import { runRetentionMaintenanceRound } from "../../index.ts";
import {
  PruneStateDeps,
  pruneTerminalRunFiles,
} from "../../execution/persistence/run-state-evidence.ts";
import { RUN_EVENTS_SUFFIX } from "../run-events.ts";

let dataRoot: string;

beforeEach(() => {
  resetCoreForTests();
  dataRoot = mkdtempSync(join(tmpdir(), "file-run-store-"));
  // RecordStore 构造/首写经 core logger facade 动态解析宿主实现——注入 no-op 宿主
  configureCore({ dataRoot: () => dataRoot, log: () => {} });
});

afterEach(() => {
  resetCoreForTests();
  rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 30 天窗口（ms）——测试统一注入，不依赖 env。 */
const RETENTION_30D_MS = 30 * 86_400_000;

/** 「N 天前」的 epoch ms（事件 ts / mtime 注入用）。 */
function daysAgoMs(days: number): number {
  return Date.now() - days * 86_400_000;
}

/** run journal 帧构造（W1 前格式：无 seq——读取面对缺失放行，D7 兼容读）。 */
function runCreatedFrame(runId: string, ts: number): Record<string, unknown> {
  return { type: "run-created", ts, runId, workflowName: "w", argsSummary: "args" };
}
function runSettledFrame(ts: number, outcome: "done" | "failed" | "cancelled"): Record<string, unknown> {
  return { type: "run-settled", ts, outcome, artifactsDir: "/tmp/artifacts" };
}

/** 直接写 run journal（<runId>.events.jsonl，每帧一行 JSONL）。 */
function writeRunJournal(stateDir: string, runId: string, frames: readonly unknown[]): string {
  mkdirSync(stateDir, { recursive: true });
  const full = join(stateDir, `${runId}${RUN_EVENTS_SUFFIX}`);
  writeFileSync(full, frames.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8");
  return full;
}

/** 预置终态 run 磁盘足迹（state + journal + manifest）并返回三路径。 */
function seedTerminalRun(stateDir: string, runId: string, createdDaysAgo: number, settledDaysAgo: number, outcome: "done" | "failed" | "cancelled" = "done"): { stateFull: string; journalFull: string; manifestFull: string } {
  mkdirSync(stateDir, { recursive: true });
  const stateFull = join(stateDir, `${runId}.jsonl`);
  writeFileSync(stateFull, '{"runId":"' + runId + '","stub":true}\n', "utf8");
  const journalFull = writeRunJournal(stateDir, runId, [
    runCreatedFrame(runId, daysAgoMs(createdDaysAgo)),
    runSettledFrame(daysAgoMs(settledDaysAgo), outcome),
  ]);
  const manifestFull = join(stateDir, `${runId}.json`);
  writeFileSync(manifestFull, JSON.stringify({ runId, outcome }), "utf8");
  return { stateFull, journalFull, manifestFull };
}

/** 预置运行中 run（journal 无终态帧）。 */
function seedRunningRun(stateDir: string, runId: string, createdDaysAgo: number): { stateFull: string; journalFull: string } {
  mkdirSync(stateDir, { recursive: true });
  const stateFull = join(stateDir, `${runId}.jsonl`);
  writeFileSync(stateFull, '{"runId":"' + runId + '","stub":true}\n', "utf8");
  const journalFull = writeRunJournal(stateDir, runId, [
    runCreatedFrame(runId, daysAgoMs(createdDaysAgo)),
    { type: "agent-started", ts: daysAgoMs(createdDaysAgo), taskIndex: 0, agentName: "coder", attempt: 1 },
  ]);
  return { stateFull, journalFull };
}

/** prune/维护轮的 spy deps（日志断言面）。 */
function makeRetentionDeps(): { deps: PruneStateDeps; debugCalls: string[]; warnCalls: string[] } {
  const debugCalls: string[] = [];
  const warnCalls: string[] = [];
  return {
    deps: {
      debug: (m) => debugCalls.push(m),
      warn: (m) => warnCalls.push(m),
      toMsg: (e) => (e instanceof Error ? e.message : String(e)),
    },
    debugCalls,
    warnCalls,
  };
}

describe("pruneTerminalRunFiles — fold 终态 + 保留窗口（W1 D5）", () => {
  it("窗外终态可清：state + journal 成对删，manifest 永不随裁", async () => {
    const stateDir = join(dataRoot, "workflow-state");
    const { stateFull, journalFull, manifestFull } = seedTerminalRun(stateDir, "wf-prune-1", 35, 31);

    const { deps } = makeRetentionDeps();
    const result = await pruneTerminalRunFiles(stateDir, { ttlMs: RETENTION_30D_MS }, deps);

    expect(result).toEqual({ scanned: 1, eligible: 1, pruned: 1, nonTerminalBeyondWindow: 0 });
    expect(existsSync(stateFull)).toBe(false);
    expect(existsSync(journalFull)).toBe(false);
    expect(existsSync(manifestFull)).toBe(true); // manifest 永不随裁（孤儿判定依赖）
  });

  it("含收编产生的 interrupted：run-settled(failed) 窗外同样可清", async () => {
    const stateDir = join(dataRoot, "workflow-state");
    // 收编（D4）幂等追加的终态事件 outcome=failed——fold 到 terminal 即获资格
    const { stateFull, journalFull } = seedTerminalRun(stateDir, "wf-prune-2", 40, 35, "failed");

    const { deps } = makeRetentionDeps();
    const result = await pruneTerminalRunFiles(stateDir, { ttlMs: RETENTION_30D_MS }, deps);

    expect(result.pruned).toBe(1);
    expect(existsSync(stateFull)).toBe(false);
    expect(existsSync(journalFull)).toBe(false);
  });

  it("窗内终态永不清（29 天前 settle，资格计数但不裁）", async () => {
    const stateDir = join(dataRoot, "workflow-state");
    const { stateFull, journalFull } = seedTerminalRun(stateDir, "wf-prune-3", 29, 29);

    const { deps } = makeRetentionDeps();
    const result = await pruneTerminalRunFiles(stateDir, { ttlMs: RETENTION_30D_MS }, deps);

    expect(result).toEqual({ scanned: 1, eligible: 1, pruned: 0, nonTerminalBeyondWindow: 0 });
    expect(existsSync(stateFull)).toBe(true);
    expect(existsSync(journalFull)).toBe(true);
  });

  it("运行中永不清：无终态帧的 journal 无论多旧都不裁（判据②未启用），计入候选", async () => {
    const stateDir = join(dataRoot, "workflow-state");
    const { stateFull, journalFull } = seedRunningRun(stateDir, "wf-prune-4", 40);

    const { deps } = makeRetentionDeps();
    const result = await pruneTerminalRunFiles(stateDir, { ttlMs: RETENTION_30D_MS }, deps);

    expect(result).toEqual({ scanned: 1, eligible: 0, pruned: 0, nonTerminalBeyondWindow: 1 });
    expect(existsSync(stateFull)).toBe(true);
    expect(existsSync(journalFull)).toBe(true);
  });

  it("无 journal 的存量 state 文件不裁（fold 非终态）+ mtime 兜底计入候选", async () => {
    const stateDir = join(dataRoot, "workflow-state");
    mkdirSync(stateDir, { recursive: true });
    const stateFull = join(stateDir, "wf-legacy-nojournal.jsonl");
    writeFileSync(stateFull, '{"runId":"wf-legacy-nojournal"}\n', "utf8");
    const old = daysAgoMs(40) / 1000;
    utimesSync(stateFull, old, old); // mtime 注入：注册时间兜底锚

    const { deps } = makeRetentionDeps();
    const result = await pruneTerminalRunFiles(stateDir, { ttlMs: RETENTION_30D_MS }, deps);

    expect(result).toEqual({ scanned: 1, eligible: 0, pruned: 0, nonTerminalBeyondWindow: 1 });
    expect(existsSync(stateFull)).toBe(true);
  });

  it("废 cap 回归（结构断言）：60 个窗内终态 run 零裁剪（多 session 分摊不再互杀）", async () => {
    // [W1 / D5] cap 语义废除：PruneTerminalRunFilesOptions 已无 cap 字段（类型层
    // 收敛），行为面 = 共享池内窗内终态数量再多也不触发「裁最旧」——另一 session
    // 保留窗口内的终态 run 不再被本 session 的清理轮挤出（A-8 回归锚）；60 > 旧
    // 上限 50，兼锁「数量截断通道退役后不再截断」
    const stateDir = join(dataRoot, "workflow-state");
    for (let i = 0; i < 60; i++) {
      seedTerminalRun(stateDir, `wf-uncapped-${i}`, 5, 1);
    }

    const { deps } = makeRetentionDeps();
    const result = await pruneTerminalRunFiles(stateDir, { ttlMs: RETENTION_30D_MS }, deps);

    expect(result).toEqual({ scanned: 60, eligible: 60, pruned: 0, nonTerminalBeyondWindow: 0 });
  });

  it("窗口 opt-out（ttlMs 缺省解析 undefined）：整轮不裁，仅候选监控不失明", async () => {
    const stateDir = join(dataRoot, "workflow-state");
    seedTerminalRun(stateDir, "wf-optout-1", 35, 31);
    seedRunningRun(stateDir, "wf-optout-2", 40);

    vi.stubEnv("TAIJI_SUBAGENT_STATE_TTL_MS", "0"); // 非法值 → undefined = opt-out
    try {
      const { deps } = makeRetentionDeps();
      const result = await pruneTerminalRunFiles(stateDir, {}, deps);
      expect(result).toEqual({ scanned: 2, eligible: 1, pruned: 0, nonTerminalBeyondWindow: 1 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("runRetentionMaintenanceRound — run + record 两域同轮（W1 D5）", () => {
  /** record 事件 fixture：经 u0 journal API 写入（seq 单调分配 + 头行契约）。 */
  async function seedRecord(
    recordsDir: string,
    id: string,
    frames: readonly RecordJournalEventInput[],
  ): Promise<string> {
    const journal = createRecordEventJournal(recordsDir);
    for (const frame of frames) await journal.append(id, frame);
    return join(recordsDir, `${id}.events`);
  }
  function recordCreatedInput(id: string, ts: number): RecordJournalEventInput {
    return {
      type: "record-created",
      ts,
      id,
      agent: "coder",
      task: "do work",
      slug: "coder-do-work",
      origin: "tool",
      rootSessionId: "root-1",
      depth: 0,
      mode: "background",
      startedAt: ts,
    };
  }
  function recordSettledInput(ts: number): RecordJournalEventInput {
    return { type: "record-settled", ts, stopReason: "completed", endedAt: ts, turns: 1, totalTokens: 10 };
  }

  it("两域同轮：窗外终态（run + record）同轮清理，manifest 均保留，候选数日志输出", async () => {
    const stateDir = join(dataRoot, "workflow-state");
    const recordsDir = join(dataRoot, "records");
    const runSeed = seedTerminalRun(stateDir, "wf-round-1", 35, 31);
    seedRunningRun(stateDir, "wf-round-2", 40); // 判据②候选（run 侧）
    const eventsFull = await seedRecord(recordsDir, "sa-round-1", [
      recordCreatedInput("sa-round-1", daysAgoMs(35)),
      recordSettledInput(daysAgoMs(31)),
    ]);
    writeFileSync(join(recordsDir, "sa-round-1.json"), '{"id":"sa-round-1"}', "utf8"); // record manifest
    await seedRecord(recordsDir, "sa-round-2", [
      recordCreatedInput("sa-round-2", daysAgoMs(40)),
      { type: "record-bound", ts: daysAgoMs(40), sessionFile: "/tmp/s.jsonl", engine: "pi", engineHandle: { sessionRef: { sid: "s1" }, poolKey: "shared" }, epoch: 0 },
    ]); // 运行中 record：判据②候选（record 侧）

    const { deps, debugCalls, warnCalls } = makeRetentionDeps();
    const result = await runRetentionMaintenanceRound(
      { stateDir, recordsDir },
      { retentionMs: RETENTION_30D_MS },
      deps,
    );

    expect(result.run).toEqual({ scanned: 2, eligible: 1, pruned: 1, nonTerminalBeyondWindow: 1 });
    expect(result.record).toEqual({ scanned: 2, eligible: 1, pruned: 1, nonTerminalBeyondWindow: 1 });
    // run 域成对删 + manifest 保留；record 域只删 .events、manifest 不触碰
    expect(existsSync(runSeed.stateFull)).toBe(false);
    expect(existsSync(runSeed.journalFull)).toBe(false);
    expect(existsSync(runSeed.manifestFull)).toBe(true);
    expect(existsSync(eventsFull)).toBe(false);
    expect(existsSync(join(recordsDir, "sa-round-1.json"))).toBe(true);
    // 候选数日志（判据②反向锚点）：整轮汇总 + 增长告警
    expect(debugCalls.some((m) => m.includes("maintenance round done"))).toBe(true);
    expect(warnCalls.some((m) => m.includes("criterion-② candidates") && m.includes("run=1") && m.includes("record=1"))).toBe(true);
  });

  it("record 域窗内终态永不清；reopened 回边清除终态后同样永不清（运行保护）", async () => {
    const stateDir = join(dataRoot, "workflow-state"); // 空目录：run 域零候选
    const recordsDir = join(dataRoot, "records");
    const inWindow = await seedRecord(recordsDir, "sa-in-window", [
      recordCreatedInput("sa-in-window", daysAgoMs(5)),
      recordSettledInput(daysAgoMs(1)),
    ]);
    // settled 后 reopened（epoch 递增 + round 归零）——fold 清除终态 = 回边续跑保护
    const reopened = await seedRecord(recordsDir, "sa-reopened", [
      recordCreatedInput("sa-reopened", daysAgoMs(40)),
      recordSettledInput(daysAgoMs(35)),
      { type: "record-reopened", ts: daysAgoMs(1), epoch: 1, round: 0 },
    ]);

    const { deps } = makeRetentionDeps();
    const result = await runRetentionMaintenanceRound(
      { stateDir, recordsDir },
      { retentionMs: RETENTION_30D_MS },
      deps,
    );

    expect(result.record).toEqual({ scanned: 2, eligible: 1, pruned: 0, nonTerminalBeyondWindow: 1 });
    expect(existsSync(inWindow)).toBe(true);
    expect(existsSync(reopened)).toBe(true); // 35 天前的 settled 被 reopened 回边清除 → 永不清
  });

  it("barrel 导出面可被触发点消费（typeof function，U7 接线路径）", () => {
    expect(typeof runRetentionMaintenanceRound).toBe("function");
  });
});

// ── cap 退役结构断言（W1 / D5：数量截断通道整体删除）──────────────────────
//
// cap 族符号（数量上限常量 / env 通道名 / 解析函数）与 cap 选项字段已从导出面
// 与接口删除——保留窗口（fold 终态 ∧ 超窗）是唯一资格判据。行为面（窗内终态
// 数量再多零裁剪）由上方「废 cap 回归（结构断言）」用例锁定（60 > 旧上限 50，
// 不截断）；本段锁运行时导出面零复活。

describe("cap 退役结构断言（W1 / D5）", () => {
  it("run-state-evidence 导出面零 cap 族符号（键面不含数量截断通道命名形态）", async () => {
    // 拦截形态而非全名清单：cap 族三符号均含「数量上限 / MaxRuns」命名段——
    // 键面排除该段即零复活（词表级全名清扫由引擎 grep 验收承担，此处锁运行时面）
    const mod = await import("../../execution/persistence/run-state-evidence.ts");
    const exported = Object.keys(mod);
    expect(exported.filter((k) => k.includes("MAX_RUNS") || k.includes("MaxRuns"))).toEqual([]);
    expect(exported).not.toContain("DEFAULT_SAVE_MIN_INTERVAL_MS");
  });
});

// [W1 / D5] cap 选项字段已从 PruneTerminalRunFilesOptions 删除：类型层锚——
// 仅传 ttlMs 的对象字面量可赋值（cap 若回归为 required 字段，本行编译破）。
const CAP_RETIREMENT_TYPE_ANCHOR: import("../../execution/persistence/run-state-evidence.ts").PruneTerminalRunFilesOptions = { ttlMs: 1000 };
void CAP_RETIREMENT_TYPE_ANCHOR;

// ── record 首写触发维护轮（W1 / D5 触发点②，U7 接线·验收①）────────────────
//
// record-only 会话（只跑 subagents()、无任何 workflow run）的 record 域清理入口：
// RecordStore.register 的 record 事件文件首写触发统一维护轮（fire-and-forget——
// 同步写点无 await 通道），窗外终态 .events 被清、manifest 不触碰、新落账的
// record 事件文件（窗内、非终态）保留。

describe("record 首写触发维护轮（W1 / D5 触发点②：RecordStore.register 接线）", () => {
  it("record-only 会话：首写触发后窗外终态 .events 清、manifest 与新 record 保留", async () => {
    const recordsDir = join(dataRoot, "records");
    // 历史遗留：窗外终态 record（settled 31 天前 > 30 天窗口）+ 其 manifest
    const staleEvents = join(recordsDir, "sa-trig-stale.events");
    const staleManifest = join(recordsDir, "sa-trig-stale.json");
    {
      const j = createRecordEventJournal(recordsDir);
      await j.append("sa-trig-stale", {
        type: "record-created",
        ts: daysAgoMs(35),
        id: "sa-trig-stale",
        agent: "coder",
        task: "old work",
        slug: "coder-old-work",
        origin: "tool",
        rootSessionId: "root-1",
        depth: 0,
        mode: "background",
        startedAt: daysAgoMs(35),
      });
      await j.append("sa-trig-stale", {
        type: "record-settled",
        ts: daysAgoMs(31),
        stopReason: "completed",
        endedAt: daysAgoMs(31),
        turns: 1,
        totalTokens: 10,
      });
    }
    writeFileSync(staleManifest, '{"id":"sa-trig-stale"}', "utf8");

    // 触发：register 新 record（事件文件首写）→ 维护轮 fire-and-forget 启动
    const store = new RecordStore(join(dataRoot, "sessions"), undefined, undefined, recordsDir);
    const record = createRecord("sa-trig-new", {
      agent: "coder",
      model: "m",
      mode: "background",
      task: "new work",
      slug: "coder-new-work",
      startedAt: daysAgoMs(0),
      rootSessionId: "root-1",
    });
    store.register(record);
    // 触发前历史遗留原封不动（fire-and-forget 未完成前不产生清理）
    expect(existsSync(staleEvents)).toBe(true);

    // 等待 fire-and-forget 维护轮落定（真实 IO 轮询，有界 2s）
    const deadline = Date.now() + 2000;
    while (existsSync(staleEvents) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(existsSync(staleEvents)).toBe(false); // 窗外终态事件文件被清
    expect(existsSync(staleManifest)).toBe(true); // manifest 不触碰（独立 TTL）
    expect(existsSync(join(recordsDir, "sa-trig-new.events"))).toBe(true); // 新 record 保留
  });
});
