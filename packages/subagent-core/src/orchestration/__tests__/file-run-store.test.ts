// file-run-store.test.ts —— run 状态保留期维护面（pruneTerminalRunFiles /
// 统一维护轮 runRetentionMaintenanceRound + record 首写触发接线）。
//
// [round5-g 合并产物] 吸收同域姊妹件（run 状态存储双后端）：
// pi-host-run-store.test.ts（pi 宿主侧 run store）。
//
// 被测源 = execution/persistence/run-state-evidence.ts（终局证据判定核与保留期
// 维护自本目录旧 file-run-store.ts 拆解迁移，行为零变化——快照行 IO 测试随写
// 身份退役删除；判定核直测面在
// registry-reconcile/reconcile-sweep-settlement.test.ts）。
//
// 资格判据锚 = journal fold 终态（run-settled 帧驱动 fold 到 terminal，含收编产生
// 的 interrupted）；终态时间 = run-settled 帧 ts。时间注入 = 事件 ts 相对 Date.now
// 计算（天数偏移）；无 journal 创建帧的存量形态用 utimesSync 注入 mtime。

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureCore, resetCoreForTests } from "../../core/host-services.ts";
import {
  createRecordEventStream,
  type RecordEventInput,
} from "../../execution/persistence/record-events.ts";
// [W1 / D5 触发点②] RecordStore.register 首写触发维护轮的行为断言范围
import { RecordStore } from "../../execution/persistence/record-store.ts";
import { createRecord } from "../../execution/persistence/execution-record.ts";
// barrel 消费方回归锚：维护轮入口经 barrel 导出（三个触发点接线，U7 消费同路径）
import { runRetentionMaintenanceRound } from "../../index.ts";
import {
  PruneStateDeps,
  pruneTerminalRunFiles,
} from "../../execution/persistence/run-state-evidence.ts";
import { RUN_EVENTS_SUFFIX } from "../run-events.ts";
import * as fsPromises from "node:fs/promises";
import type { LogLevel } from "../../core/logger.ts";
import { createRunEventJournal, type WorkflowRunEventInput } from "../run-events.ts";
import { adoptInterruptedRun } from "../run-registry.ts";
import {
  setRunEventJournalDirForTest,
} from "../terminal-actions.ts";
import { readRunTerminalManifest } from "../../execution/persistence/manifest-store.ts";
import { createPiHostRunEnumeration } from "../../execution/assembly/pi-host-run-store.ts";
import type { HostServices } from "../../core/host-services.js";

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

/** run journal 帧构造（W1 前格式：无 seq——读取侧对缺失放行，D7 兼容读）。 */
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

/** prune/维护轮的 spy deps（日志断言范围）。 */
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
    // 收敛），行为范围 = 共享池内窗内终态数量再多也不触发「裁最旧」——另一 session
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
    frames: readonly RecordEventInput[],
  ): Promise<string> {
    const journal = createRecordEventStream(() => recordsDir);
    for (const frame of frames) await journal.append(id, frame);
    return join(recordsDir, `${id}.events`);
  }
  function recordCreatedInput(id: string, ts: number): RecordEventInput {
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
  function recordSettledInput(ts: number): RecordEventInput {
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

  it("barrel 导出范围可被触发点消费（typeof function，U7 接线路径）", () => {
    expect(typeof runRetentionMaintenanceRound).toBe("function");
  });
});

// ── cap 退役结构断言（W1 / D5：数量截断通道整体删除）──────────────────────
//
// cap 族符号（数量上限常量 / env 通道名 / 解析函数）与 cap 选项字段已从导出范围
// 与接口删除——保留窗口（fold 终态 ∧ 超窗）是唯一资格判据。行为范围（窗内终态
// 数量再多零裁剪）由上方「废 cap 回归（结构断言）」用例锁定（60 > 旧上限 50，
// 不截断）；本段锁运行时导出范围零复活。

describe("cap 退役结构断言（W1 / D5）", () => {
  it("run-state-evidence 导出范围零 cap 族符号（键侧不含数量截断通道命名形态）", async () => {
    // 拦截形态而非全名清单：cap 族三符号均含「数量上限 / MaxRuns」命名段——
    // 键侧排除该段即零复活（词表级全名清扫由引擎 grep 验收承担，此处锁运行时侧）
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
// 同步写点无 await 通道），窗外终态 .events 被清、manifest 不触碰、新写入 journal 记录的
// record 事件文件（窗内、非终态）保留。

describe("record 首写触发维护轮（W1 / D5 触发点②：RecordStore.register 接线）", () => {
  it("record-only 会话：首写触发后窗外终态 .events 清、manifest 与新 record 保留", async () => {
    const recordsDir = join(dataRoot, "records");
    // 历史遗留：窗外终态 record（settled 31 天前 > 30 天窗口）+ 其 manifest
    const staleEvents = join(recordsDir, "sa-trig-stale.events");
    const staleManifest = join(recordsDir, "sa-trig-stale.json");
    {
      const j = createRecordEventStream(() => recordsDir);
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
    const store = new RecordStore(() => join(dataRoot, "sessions"), undefined, undefined, () => recordsDir);
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

// ══════ 来源: pi-host-run-store.test.ts ══════

// pi-host-run-store 回归锁：枚举读侧目录由调用方注入的数据根活源驱动，不从进程
// env/cwd/sessionFile 推测（三条推导路径均曾在 W2 D3 真机链实证错位致恒空转，见被
// 测模块头注）。
// [session-store-layout-inversion D2/D3] 枚举对象换根：session 存储树一级 sid 目录的
// `<root>/<rootSid>/workflow/runs/`（分区键 = rootSessionId）；旧形态的 agentDir 活源
// + sessions/<slug> 全目录 + agentDir 根回退随 cwd 分区布局退役。
// 覆盖面（ADR-0081 / §4.1 场景 3、5；workflow-run-store-convergence U2 枚举改接）：
// 1. 枚举目录形态（数据根活源 + 存储树全部 sid 目录 + 非 sid 形态目录跳过）；
// 2. 终态返回形态 { runId, stateDir, status }（stateDir = 收编链 journalDir 注入源；
//    status = 判定核三态映射——running/终态词/missing 跳过）；
// 3. 候选来源 = record 事件流文件族（journal 在即候选在——快照在或不在均无关，
//    走查必修缺口的回归锚）；
// 4. runtime 形态：journalDir 参数显式传入时收编链（adoptInterruptedRun）读写
//    正确落位——调用进程 cwd 与落盘目录不相交，显式参数优先于模块锚；
// 5. 读错分通道：候选目录层 EACCES 上抛（枚举自身扫描）、ENOENT 仍空集；单 run
//    判定层走判定核保守矩阵（枚举层不二次处置）；
// 6. v1 旧形态目录（[D16⑥]）：旧双源文件（.events.jsonl / .jsonl）不进候选
//    （构造性跳过）+ 聚合 warn 留痕（core logger 通道）。



/** 落 running 形态 record 流（run-created + agent-started 两帧——fold = running，
 *  无 run-settled 帧）。枚举候选 = 本写入方落出的 <runId>.record.jsonl 文件族。 */
async function seedRunningJournal(stateDir: string, runId: string): Promise<void> {
  const journal = createRunEventJournal(stateDir);
  const events: WorkflowRunEventInput[] = [
    { type: "run-created", runId, workflowName: "fixture-flow", argsSummary: "{}", ts: Date.now() },
    { type: "agent-started", taskIndex: 1, agentName: "worker", attempt: 1, ts: Date.now() },
  ];
  for (const event of events) await journal.append(runId, event);
}

/** 新布局 runs 目录（`<root>/<sid>/workflow/runs/`，root = 测试注入的数据根）。 */
function runsDirOf(dataDir: string, sid: string): string {
  return join(dataDir, "ext-sessions", sid, "workflow", "runs");
}

describe("createPiHostRunEnumeration", () => {
  let dataRoot: string;
  let wsA: string;
  let wsB: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "pi-host-run-store-"));
    // 新布局：<root>/<sid>/workflow/runs/（sid = 合法 sessionId 形态 fixture）
    wsA = runsDirOf(dataRoot, "sid-fixture-a");
    wsB = runsDirOf(dataRoot, "sid-fixture-b");
    for (const dir of [wsA, wsB]) mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("枚举存储树全部 sid 目录的 runs 目录（same/cross-session 两形态一次覆盖）", async () => {
    // same-session 目录 / cross-session 目录各一个 run（seed 直接落 record 流——
    // U2 改接后枚举候选与 status 判定都只认 journal）。
    await seedRunningJournal(wsA, "wf-a");
    await seedRunningJournal(wsB, "wf-b");
    const store = createPiHostRunEnumeration(() => dataRoot);
    const runs = await store.loadAll();
    expect(runs.map((r) => r.runId).sort()).toEqual(["wf-a", "wf-b"]);
    const byId = new Map(runs.map((r) => [r.runId, r]));
    for (const run of runs) {
      expect(run.status).toBe("running");
    }
    // 终态返回形态：stateDir = 该 run 的 runs 目录（收编链 journalDir 注入源）
    expect(byId.get("wf-a")?.stateDir).toBe(wsA);
    expect(byId.get("wf-b")?.stateDir).toBe(wsB);
  });

  it("非合法 sessionId 形态的一级目录一律跳过（D7 树内遍历规约）", async () => {
    await seedRunningJournal(wsA, "wf-a");
    // 手放进存储树根的非会话目录（未来可能出现的非 sid 形态）不得进枚举
    const stray = join(dataRoot, "ext-sessions", "not-a-session-id!");
    mkdirSync(stray, { recursive: true });
    await seedRunningJournal(stray, "wf-stray");
    const runs = await createPiHostRunEnumeration(() => dataRoot).loadAll();
    expect(runs.map((r) => r.runId)).toEqual(["wf-a"]);
  });

  it("快照行文件（.jsonl）与 terminal manifest（.json）不进 journal 枚举结果", async () => {
    await seedRunningJournal(wsA, "wf-a");
    // 同名快照 + manifest、与快照-only run（快照在而 journal 不在——U2 改接后
    // 不再是候选：反方向完备性，设计 §3.1 步骤 2）都不是枚举来源
    writeFileSync(join(wsA, "wf-a.jsonl"), '{"v":"wf-run-v2","fixture":true}\n');
    writeFileSync(join(wsA, "wf-a.json"), '{"outcome":"completed"}\n');
    writeFileSync(join(wsB, "wf-snap-only.jsonl"), '{"v":"wf-run-v2","fixture":true}\n');
    const runs = await createPiHostRunEnumeration(() => dataRoot).loadAll();
    expect(runs.map((r) => r.runId)).toEqual(["wf-a"]);
  });

  it("journal 在而快照不在 → 候选在（候选不依赖快照存在性——走查必修缺口回归锚）", async () => {
    await seedRunningJournal(wsA, "wf-no-snap");
    // 该 run 无 <runId>.jsonl 快照、无 <runId>.json manifest——纯 journal 形态
    const runs = await createPiHostRunEnumeration(() => dataRoot).loadAll();
    expect(runs.map((r) => r.runId)).toEqual(["wf-no-snap"]);
    expect(runs[0]?.status).toBe("running");
    expect(runs[0]?.stateDir).toBe(wsA);
  });

  it("进程 env 漂移不影响枚举目录（注入活源优先于 TAIJI_AGENT_DATA_DIR）", async () => {
    await seedRunningJournal(wsA, "wf-a");
    await seedRunningJournal(wsB, "wf-b");
    const prev = process.env.TAIJI_AGENT_DATA_DIR;
    process.env.TAIJI_AGENT_DATA_DIR = join(dataRoot, "not-the-real-data-dir");
    try {
      const store = createPiHostRunEnumeration(() => dataRoot);
      const runs = await store.loadAll();
      expect(runs.map((r) => r.runId).sort()).toEqual(["wf-a", "wf-b"]);
    } finally {
      if (prev === undefined) delete process.env.TAIJI_AGENT_DATA_DIR;
      else process.env.TAIJI_AGENT_DATA_DIR = prev;
    }
  });

  it("存储树根不存在时仍空集（从未落盘的空态降级不抛）", async () => {
    const bareRoot = mkdtempSync(join(tmpdir(), "pi-host-run-store-bare-"));
    try {
      const runs = await createPiHostRunEnumeration(() => bareRoot).loadAll();
      expect(runs).toEqual([]);
    } finally {
      rmSync(bareRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ── 判定核三态 → status 映射（U2 改接：status 从事实源推导）──────

describe("createPiHostRunEnumeration status 映射（判定核三态）", () => {
  let dataRoot: string;
  let wsA: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "pi-host-run-store-map-"));
    wsA = runsDirOf(dataRoot, "sid-fixture-map");
    mkdirSync(wsA, { recursive: true });
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("running（journal 无 run-settled 帧）→ \"running\"", async () => {
    await seedRunningJournal(wsA, "wf-live");
    const runs = await createPiHostRunEnumeration(() => dataRoot).loadAll();
    expect(runs).toEqual([{ runId: "wf-live", stateDir: wsA, status: "running" }]);
  });

  it("terminal（journal run-settled 帧在盘）→ 对应终态词", async () => {
    await seedRunningJournal(wsA, "wf-done");
    const journal = createRunEventJournal(wsA);
    await journal.append("wf-done", {
      type: "run-settled",
      outcome: "done",
      artifactsDir: wsA,
      ts: Date.now(),
    });
    const runs = await createPiHostRunEnumeration(() => dataRoot).loadAll();
    expect(runs).toEqual([{ runId: "wf-done", stateDir: wsA, status: "completed" }]);
  });

  it("terminal via manifest（journal 无终局帧 + 历史词表外 outcome=interrupted manifest 在盘）→ status 折叠 \"failed\" 恒 string（判定核单点防御——枚举 status 契约不漏 undefined）", async () => {
    await seedRunningJournal(wsA, "wf-legacy-manifest");
    // [D2] 前旧收编链物化的历史 manifest（文件名未随 [D1] 迁移故磁盘可达）：
    // 词表外 outcome 经 findRunSettlementEvidence 的 as 强转读入，派生函数
    // default 分支折叠 "failed"（W2 D5 诊断兜底容器先例）
    writeFileSync(
      join(wsA, "wf-legacy-manifest.json"),
      JSON.stringify({ outcome: "interrupted", errorCode: "idle-evicted" }),
      "utf8",
    );
    const runs = await createPiHostRunEnumeration(() => dataRoot).loadAll();
    expect(runs).toEqual([{ runId: "wf-legacy-manifest", stateDir: wsA, status: "failed" }]);
  });

  it("missing（竞态窗口：候选列举后 journal 被删）→ 候选跳过不入结果", async () => {
    const wsB = runsDirOf(dataRoot, "sid-fixture-race");
    mkdirSync(wsB, { recursive: true });
    await seedRunningJournal(wsA, "wf-race");
    await seedRunningJournal(wsB, "wf-keep");
    const target = join(wsA, `wf-race${RUN_EVENTS_SUFFIX}`);
    // 竞态窗口模拟：候选目录 readdir 返回之后、判定核读文件之前 journal 被删
    //（枚举路径 missing 的唯一可达形态——被测模块头注）。按 path 分流拦截
    // wsA 的候选列举，其余 readdir 调用透传真实现。
    const actualReaddir = fsPromises.readdir.bind(fsPromises);
    const spy = vi.spyOn(fsPromises, "readdir");
    spy.mockImplementation((async (path: string, options?: { withFileTypes: boolean }) => {
      // 类型修复（u1a 词表批附带）：readdir 重载收窄——mock 分流只覆盖字符串路径 +
      // 可选 withFileTypes 形态，真实现透传时按 BufferEncoding 重载解析（cast 收窄）。
      const entries: unknown = options?.withFileTypes
        ? await actualReaddir(path, { withFileTypes: true })
        : await actualReaddir(path);
      if (path === wsA) rmSync(target);
      return entries as Dirent[];
    }) as typeof fsPromises.readdir);
    try {
      const runs = await createPiHostRunEnumeration(() => dataRoot).loadAll();
      expect(runs.map((r) => r.runId)).toEqual(["wf-keep"]);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── runtime 形态（决策 2 目录参数化）────────────────────────
//
// 构造「调用进程 cwd 与落盘目录不相交」：落盘目录 = mkdtemp 显式路径，vitest
// 进程 cwd = 包目录——不注入模块锚时收编链的缺省解析在 vitest 下是 no-op
// 防线（零写），显式 journalDir 参数必须把 scan / 帧落账 / manifest 三面全部
// 路由到参数目录。

describe("runtime 形态：journalDir 参数显式传入时收编链读写正确落位", () => {
  let journalDir: string;

  beforeEach(() => {
    journalDir = mkdtempSync(join(tmpdir(), "pi-host-run-store-runtime-"));
  });

  afterEach(() => {
    // 复位模块锚 + 清活体态/终局记录注册表/keyed journal 缓存（pump teardown 纪律）
    setRunEventJournalDirForTest(undefined);
    rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 落 running 形态事件流（run-created + agent-started → fold = running）。 */
  async function seedRunning(runId: string): Promise<void> {
    await seedRunningJournal(journalDir, runId);
  }

  it("模块锚未注入时显式 journalDir 收编：run-interrupted 帧落参数目录 + manifest 不物化", async () => {
    const runId = "wf-rt-direct";
    await seedRunning(runId);

    const outcome = await adoptInterruptedRun(runId, { journalDir });
    expect(outcome).toBe("adopted");

    // journal 半边：run-interrupted 转移帧落参数目录（[D15] 中断编排入口——
    // interrupted 是暂停态非终局，收编产物 = 中断帧一件直落）
    const events = await createRunEventJournal(journalDir).scan(runId);
    const interrupted = events.find((e) => e.type === "run-interrupted");
    expect(interrupted?.type).toBe("run-interrupted");
    // manifest 半边：不物化（interrupted 非终局——manifest-write 仅 terminal 输出）
    expect(await readRunTerminalManifest(journalDir, runId)).toBeNull();
  });

  it("显式 journalDir 优先于模块锚（setRunEventJournalDirForTest 指向他目录时收编仍落参数目录）", async () => {
    const anchorDir = mkdtempSync(join(tmpdir(), "pi-host-run-store-anchor-"));
    try {
      setRunEventJournalDirForTest(anchorDir);
      const runId = "wf-rt-param-wins";
      await seedRunning(runId);

      const outcome = await adoptInterruptedRun(runId, { journalDir });
      expect(outcome).toBe("adopted");

      // 落点 = 参数目录（journal 中断帧）
      const events = await createRunEventJournal(journalDir).scan(runId);
      expect(events.some((e) => e.type === "run-interrupted")).toBe(true);
      // 模块锚目录零写入（per-call 参数不被模块锚劫持）
      expect(await createRunEventJournal(anchorDir).scan(runId)).toHaveLength(0);
    } finally {
      setRunEventJournalDirForTest(undefined);
      rmSync(anchorDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ── 读错分通道（§3.1 规格 2 末段；U2 改接后候选目录扫描归枚举自身）──

describe("枚举读错分通道：EACCES 上抛 / ENOENT 仍空集", () => {
  /** root 进程不受权限位约束，EACCES 场景构造不出来（环境限制非语义缺口）；
   *  跳过惯用法与 record-store-index.test.ts 的 chmodProbeIt 同款。 */
  const chmodProbeIt = process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;

  chmodProbeIt("存储树根 EACCES：枚举 loadAll 上抛而非空数组", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-host-run-store-eacces-"));
    try {
      const storeRoot = join(root, "ext-sessions");
      mkdirSync(join(storeRoot, "sid-x", "workflow", "runs"), { recursive: true });
      chmodSync(storeRoot, 0o000);
      const store = createPiHostRunEnumeration(() => root);
      await expect(store.loadAll()).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(join(root, "ext-sessions"), 0o755);
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  chmodProbeIt("state 目录 EACCES：枚举 loadAll 上抛而非空数组（候选目录扫描层分通道）", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-host-run-store-eacces-"));
    try {
      const stateDir = runsDirOf(root, "sid-eacces");
      mkdirSync(stateDir, { recursive: true });
      chmodSync(stateDir, 0o000);
      const store = createPiHostRunEnumeration(() => root);
      await expect(store.loadAll()).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(runsDirOf(root, "sid-eacces"), 0o755);
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("目录缺失（ENOENT）仍空集：存储树根与 state 目录均不抛", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-host-run-store-empty-"));
    try {
      // 空树：无 ext-sessions / 无 runs 目录
      const store = createPiHostRunEnumeration(() => root);
      expect(await store.loadAll()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ── v1 旧形态目录（[D16⑥] 检查点 8 三形态之一）────────────────────
//
// 旧双源文件（.events.jsonl 旧 journal + .jsonl 旧快照）形态：不进候选
//（候选 = .record.jsonl 文件族，构造性跳过——[D1] 历史数据不读不写不主动删）、
// 不抛错、每目录聚合一条 warn（core logger 通道——模块无注入日志面，与判定核
// 读错 warn 同通道）。历史 run 随裁决点 7 对账清理消亡，不在本枚举射程。

describe("v1 旧形态目录：构造性跳过 + warn 留痕（[D16⑥]）", () => {
  let logSpy: ReturnType<
    typeof vi.fn<(level: LogLevel, component: string, message: string, data?: unknown) => void>
  >;

  beforeEach(() => {
    resetCoreForTests();
    logSpy = vi.fn((_level: LogLevel, _component: string, _message: string, _data?: unknown) => {});
    configureCore({
      dataRoot: () => tmpdir(),
      log: logSpy,
    } satisfies HostServices);
  });

  afterEach(() => {
    resetCoreForTests();
  });

  it("只有旧双源文件（.events.jsonl + .jsonl）→ 枚举空集 + 每目录一条聚合 warn", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-host-run-store-v1-"));
    try {
      const wsA = runsDirOf(root, "sid-v1");
      mkdirSync(wsA, { recursive: true });
      writeFileSync(join(wsA, "wf-v1-a.events.jsonl"), '{"type":"run-created"}\n');
      writeFileSync(join(wsA, "wf-v1-a.jsonl"), '{"v":"wf-run-v1"}\n');
      // 旧快照 only（无任何 journal）形态同跳过——无事件流无从收编
      writeFileSync(join(wsA, "wf-v1-snap-only.jsonl"), '{"v":"wf-run-v1"}\n');

      const runs = await createPiHostRunEnumeration(() => root).loadAll();

      expect(runs).toEqual([]);
      const warns = logSpy.mock.calls.filter((c) => c[0] === "warn").map((c) => String(c[2]));
      expect(warns).toHaveLength(1); // 每目录聚合一条（两个旧 journal 文件并一条）
      expect(warns[0]).toContain("legacy v1 journal");
      expect(warns[0]).toContain("wf-v1-a.events.jsonl");
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("新 record 流与旧文件共存 → 候选只含 record 流 run，旧文件 warn 不影响枚举结果", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-host-run-store-mixed-"));
    try {
      const wsA = runsDirOf(root, "sid-mixed");
      mkdirSync(wsA, { recursive: true });
      writeFileSync(join(wsA, "wf-legacy.events.jsonl"), '{"type":"run-created"}\n');
      await seedRunningJournal(wsA, "wf-modern");

      const runs = await createPiHostRunEnumeration(() => root).loadAll();

      expect(runs.map((r) => r.runId)).toEqual(["wf-modern"]);
      const warns = logSpy.mock.calls.filter((c) => c[0] === "warn").map((c) => String(c[2]));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("wf-legacy.events.jsonl");
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
