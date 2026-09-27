// src/__tests__/jsonl-run-store-retention.test.ts
//
// workflow-state 磁盘保留维护（OR-5 ⑥b 默认开 → [Q2] core 单源收口 → [W1 / D5]
// fold 终态 + 保留窗口重写，cap 语义废除）。
//
// 锁定的语义（W1 D5 清理规则，判定/执行单源在 core runRetentionMaintenanceRound
// （维护轮入口，本触发点只传 run 域 stateDir）/ abandonElapsedInterruptedRuns，
// 本面锁触发点与宿主行为）：
// - 资格判据唯一 = fold 终态（journal 内 run-settled 帧）∧ 终态时间超保留窗口
//   （缺省 30 天，TAIJI_SUBAGENT_STATE_TTL_MS 测试期调低通道；显式非法值 =
//   opt-out 整轮不裁）；数量截断通道（cap）已废除——窗内终态数量再多也不裁；
// - 窗外终态 run 的 state + journal 成对删；终局投影 manifest（<runId>.json）
//   永不随裁（终局持久权威，drawer 投影不消失）；
// - 活跃 / interrupted（journal 无终态帧）的 state 与 journal 永不裁——事件流
//   静默 ≠ 死亡（判据②未启用，仅候选计数）；
// - 触发点 = 新 run state 文件首写（save 冷路径 rollbackFirstWrite——本实例
//   首次写该 runId ≈ 新文件落盘时刻，每个新 run 进场做一轮维护）；
// - glob 外文件（非 wf- 前缀 / 非 .jsonl）与父目录 session JSONL 永不误删。
//
// [W1 / D5 触发点③] 新 run 首写段触发维护轮以行为断言锁定（单域目录锚：预置
// record 域终态足迹 + 窗外终态对照组，断言维护轮只裁决 run 域）。
//
// mtime 确定性：事件帧 ts 相对 Date.now 构造（天数偏移注入），不依赖写入时序。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("@zhushanwen/subagent-core/core/logger.ts", () => ({ getLogger: () => loggerMock }));

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Budget } from "@zhushanwen/subagent-core";
import { Trace } from "@zhushanwen/subagent-core";
import type { RunSpec } from "@zhushanwen/subagent-core";
import type { ExecutionTraceNode } from "@zhushanwen/subagent-core";
import { getSubagentRecordsDir } from "@zhushanwen/subagent-core";
import { WorkflowRun } from "@zhushanwen/subagent-core";
// STATE_TTL_MS_ENV 仅测试消费符号，深路径直取（[W1 / D5] 保留窗口 env 通道单源
// core file-run-store；数量截断通道已整体退役，本件不再消费其任何符号）
import { STATE_TTL_MS_ENV } from "@zhushanwen/subagent-core/orchestration/file-run-store.ts";
import { setRunEventJournalDirForTest } from "@zhushanwen/subagent-core/orchestration/worker-message-pump.ts";
import { JsonlRunStore } from "../jsonl-run-store.ts";

function makeSpec(): RunSpec {
  return {
    scriptSource: "module.exports = async () => {};",
    args: {},
    scriptName: "test-script",
    scriptPath: "/tmp/test.js",
    description: "test",
  };
}

function makeTraceNode(stepIndex: number): ExecutionTraceNode {
  return { stepIndex, agent: "worker", task: "do thing", model: "default", status: "pending" };
}

function makeRunningRun(runId: string): WorkflowRun {
  const trace = new Trace();
  trace.append(makeTraceNode(0));
  return WorkflowRun.reconstruct(runId, makeSpec(), {
    status: "running",
    budget: new Budget(),
    calls: new Map(),
    trace,
    errorLogs: [],
  }, { startedAt: new Date().toISOString() });
}

/** runId 形如 lifecycle 生成器（wf-<ts>-<rand>），i 只进 ts 段保证唯一。 */
function runIdAt(i: number): string {
  return `wf-${1719500000000 + i * 1000}-retent`;
}

function stateFile(stateDir: string, runId: string): string {
  return path.join(stateDir, `${runId}.jsonl`);
}

function journalFile(stateDir: string, runId: string): string {
  return path.join(stateDir, `${runId}.events.jsonl`);
}

function manifestFile(stateDir: string, runId: string): string {
  return path.join(stateDir, `${runId}.json`);
}

/** 「N 天前」的 epoch ms（事件帧 ts 注入用——资格判据锚 = 事件 ts）。 */
function daysAgoMs(days: number): number {
  return Date.now() - days * 86_400_000;
}

/**
 * 预置终态 run 磁盘足迹（journal 含 run-settled 帧 + state 文件 + 终局 manifest）。
 * journal 直落磁盘形态（帧格式与 core file-run-store.test.ts 的 seedTerminalRun 同源
 * ——W1 前无 seq 形态读取面放行，D7 兼容读）；不经生产写链以保持 fixture 与被测
 * prune 判定的读写两侧独立。
 */
function seedTerminalRun(stateDir: string, runId: string, createdDaysAgo: number, settledDaysAgo: number, outcome: "completed" | "failed" | "cancelled" = "completed"): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(journalFile(stateDir, runId), [
    JSON.stringify({ type: "run-created", ts: daysAgoMs(createdDaysAgo), runId, workflowName: "t", argsSummary: "{}" }),
    JSON.stringify({ type: "run-settled", ts: daysAgoMs(settledDaysAgo), outcome, artifactsDir: "/tmp/artifacts" }),
  ].join("\n") + "\n", "utf8");
  fs.writeFileSync(stateFile(stateDir, runId), `{"runId":"${runId}","stub":true}\n`, "utf8");
  fs.writeFileSync(manifestFile(stateDir, runId), JSON.stringify({ runId, outcome }), "utf8");
}

/** 预置活跃 run（journal 无终态帧——事件流静默 ≠ 死亡的保护面）。 */
function seedActiveRun(stateDir: string, runId: string, createdDaysAgo: number): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(journalFile(stateDir, runId), [
    JSON.stringify({ type: "run-created", ts: daysAgoMs(createdDaysAgo), runId, workflowName: "t", argsSummary: "{}" }),
    JSON.stringify({ type: "ask-dispatched", ts: daysAgoMs(createdDaysAgo), taskIndex: 0, agentName: "coder", attempt: 1 }),
  ].join("\n") + "\n", "utf8");
  fs.writeFileSync(stateFile(stateDir, runId), `{"runId":"${runId}","stub":true}\n`, "utf8");
}

describe("workflow-state 保留清理（[W1 / D5] fold 终态 + 保留窗口，cap 废除）", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-retention-"));
    stateDir = path.join(tmpDir, "workflow-state");
    // 双保险：vitest.setup 全局净化 + 本文件显式 delete（防用例间经 stub 栈泄漏）
    delete process.env[STATE_TTL_MS_ENV];
    loggerMock.warn.mockClear();
    loggerMock.debug.mockClear();
  });

  afterEach(() => {
    delete process.env[STATE_TTL_MS_ENV];
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("窗外终态可清：新 run 首写触发 → 最旧终态 state+journal 成对删，manifest 永不随裁", async () => {
    process.env[STATE_TTL_MS_ENV] = String(30 * 86_400_000); // 30 天窗口（显式钉住，不依赖缺省）
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    seedTerminalRun(stateDir, runIdAt(0), 40, 35); // 窗外终态（settled 35 天前 > 30 天）
    seedTerminalRun(stateDir, runIdAt(1), 10, 5); // 窗内终态（对照保护）

    // 新 run 首写（save 冷路径 rollbackFirstWrite）触发维护轮——save 返回即维护已定
    await store.save(makeRunningRun(runIdAt(2)));

    expect(fs.existsSync(stateFile(stateDir, runIdAt(0)))).toBe(false);
    expect(fs.existsSync(journalFile(stateDir, runIdAt(0)))).toBe(false);
    expect(fs.existsSync(manifestFile(stateDir, runIdAt(0)))).toBe(true); // 终局持久权威
    expect(fs.existsSync(stateFile(stateDir, runIdAt(1)))).toBe(true); // 窗内全保留
    expect(fs.existsSync(stateFile(stateDir, runIdAt(2)))).toBe(true); // 新 run 自身
    await store.dispose();
  });

  it("interrupted 先收编终局化再等窗口：静默超窗 run 不被直接裁（终态时间 = 收编时刻 → 窗内保留）", async () => {
    // [W1 / D4+D5 联动] runRetentionSweep 先跑 abandon 收编（放弃窗 7 天）再进维护轮
    // （保留窗 30 天）：静默 40 天的 interrupted 被收编追加 run-settled（ts = 收编
    // 时刻）→ fold 终态但终态时间在窗内 → 本轮不裁。清理资格要等收编时刻本身
    // 超窗（下一保留期）——「interrupted 非 terminal，收编后才获资格」的壳侧锚。
    process.env[STATE_TTL_MS_ENV] = String(30 * 86_400_000);
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    seedActiveRun(stateDir, runIdAt(0), 40); // 静默 40 天（> 7 天放弃窗，触发收编）
    // [W2/V1] 收编链（scan/帧落账/manifest）走模块 journal 单写者域——注入本目录
    setRunEventJournalDirForTest(stateDir);

    await store.save(makeRunningRun(runIdAt(1)));

    expect(fs.existsSync(stateFile(stateDir, runIdAt(0)))).toBe(true);
    expect(fs.existsSync(journalFile(stateDir, runIdAt(0)))).toBe(true);
    // 收编留证（warn 面）：run-settled appended + manifest written
    const warns = loggerMock.warn.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(warns).toContain("interrupted run adopted");
    expect(warns).not.toContain("failed to delete");
    await store.dispose();
    setRunEventJournalDirForTest(undefined);
  });

  it("废 cap 回归：51 个窗内终态 run（数量超旧上限 50）全部保留，无截断", async () => {
    // [W1 / D5] 数量截断通道废除后的行为锚：另一 session 保留窗口内的终态 run
    // 不再被本 session 的清理轮挤出（A-8 多 session 分摊互杀回归）。
    // 51 = 旧 cap（50）+1：恰好构成超限的最小数量。
    process.env[STATE_TTL_MS_ENV] = String(30 * 86_400_000);
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    for (let i = 0; i < 51; i++) {
      seedTerminalRun(stateDir, runIdAt(i), 10, 5); // 全部窗内终态
    }

    await store.save(makeRunningRun(runIdAt(51)));

    const rest = fs.readdirSync(stateDir).filter((n) => n.endsWith(".jsonl") && !n.endsWith(".events.jsonl"));
    expect(rest).toHaveLength(52); // 51 窗内终态 + 新 run，零裁剪
    expect(loggerMock.warn).not.toHaveBeenCalled();
    await store.dispose();
  });

  it("窗口 opt-out（显式非法值）→ 整轮不裁（意图不明不动磁盘）", async () => {
    process.env[STATE_TTL_MS_ENV] = "0"; // 非法值 = opt-out
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    seedTerminalRun(stateDir, runIdAt(0), 40, 35); // 窗外终态——opt-out 下保留

    await store.save(makeRunningRun(runIdAt(1)));

    expect(fs.existsSync(stateFile(stateDir, runIdAt(0)))).toBe(true);
    expect(fs.existsSync(journalFile(stateDir, runIdAt(0)))).toBe(true);
    await store.dispose();
  });

  it("热路径（running 且已写过）不重复触发维护轮；glob 外文件与父目录 session JSONL 不误删", async () => {
    process.env[STATE_TTL_MS_ENV] = String(30 * 86_400_000);
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    fs.mkdirSync(stateDir, { recursive: true });
    const bystanders = ["notes.txt", "keep-me.jsonl", "xwf-1719500000000-notwf.jsonl"];
    for (const name of bystanders) fs.writeFileSync(path.join(stateDir, name), "x");
    const sessionFile = path.join(tmpDir, "main-session.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf8");

    const id = runIdAt(0);
    await store.save(makeRunningRun(id)); // 冷路径首写：触发一轮
    // 同 runId 再 save（running 热路径）：并入去抖批不触发新维护轮（每 runId 一轮）
    await store.save(makeRunningRun(id));

    for (const name of bystanders) {
      expect(fs.existsSync(path.join(stateDir, name))).toBe(true);
    }
    expect(fs.existsSync(sessionFile)).toBe(true);
    await store.dispose();
  });

  it("删除失败（unlink 目录 → EPERM）→ warn 留证不抛，save 正常 resolve", async () => {
    fs.mkdirSync(stateDir, { recursive: true });
    // 用「名字命中候选枚举的目录」制造确定性 unlink 失败（unlink 目录 → EPERM）；
    // 该 run 需 fold 终态且超窗才进裁剪候选
    const blockerDir = stateFile(stateDir, runIdAt(0));
    fs.mkdirSync(blockerDir);
    fs.writeFileSync(journalFile(stateDir, runIdAt(0)), [
      JSON.stringify({ type: "run-created", ts: daysAgoMs(40), runId: runIdAt(0), workflowName: "t", argsSummary: "{}" }),
      JSON.stringify({ type: "run-settled", ts: daysAgoMs(35), outcome: "completed", artifactsDir: "/tmp/artifacts" }),
    ].join("\n") + "\n", "utf8");

    process.env[STATE_TTL_MS_ENV] = String(30 * 86_400_000);
    const store = new JsonlRunStore({ sessionDir: tmpDir });

    await store.save(makeRunningRun(runIdAt(1)));

    expect(fs.existsSync(blockerDir)).toBe(true); // EPERM 受害者仍在
    expect(fs.existsSync(stateFile(stateDir, runIdAt(1)))).toBe(true); // save 正常 resolve
    // unlink 失败经维护轮 deps.warn 留证（tag 前缀 [subagent-workflow]）
    const warned = loggerMock.warn.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(warned).toContain("state retention");
    await store.dispose();
  });
});

// ── [W1 / D5 触发点③] 新 run 首写段触发维护轮（行为断言：单域目录锚）─────────

describe("新 run 首写段触发维护轮只锚 run 域目录（W1 / D5 触发点③·行为断言）", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-retention-anchor-"));
    stateDir = path.join(tmpDir, "workflow-state");
    delete process.env[STATE_TTL_MS_ENV];
  });

  afterEach(() => {
    delete process.env[STATE_TTL_MS_ENV];
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("维护轮裁决窗外终态（run 域），但不触碰 record 域终态足迹（单域目录锚契约）", async () => {
    process.env[STATE_TTL_MS_ENV] = String(30 * 86_400_000);
    // record 域目录（与 SubagentService 构造 / session_start 兜底触发点同源同式推导，
    // getSubagentRecordsDir）预置终态 run manifest——维护轮入口只收 run 域 stateDir
    // 锚，record 域由 record 首写 / session_start 兜底触发点覆盖；越域裁剪即本断言红
    const agentDir = path.join(tmpDir, "agent");
    const recordsDir = getSubagentRecordsDir(agentDir, tmpDir);
    fs.mkdirSync(recordsDir, { recursive: true });
    const recordFile = path.join(recordsDir, "wf-record-001.json");
    fs.writeFileSync(recordFile, JSON.stringify({ runId: "wf-record-001", outcome: "completed" }), "utf8");

    const store = new JsonlRunStore({ sessionDir: tmpDir });
    seedTerminalRun(stateDir, runIdAt(0), 40, 35); // 窗外终态（对照组：证明维护轮确实执行）
    seedTerminalRun(stateDir, runIdAt(1), 10, 5); // 窗内终态（对照保护）

    // 新 run 首写（save 冷路径）触发维护轮——save 返回即维护已定
    await store.save(makeRunningRun(runIdAt(2)));
    await store.dispose();

    // run 域：窗外终态被裁、窗内保留（维护轮真实执行的证明面）
    expect(fs.existsSync(stateFile(stateDir, runIdAt(0)))).toBe(false);
    expect(fs.existsSync(journalFile(stateDir, runIdAt(0)))).toBe(false);
    expect(fs.existsSync(stateFile(stateDir, runIdAt(1)))).toBe(true);
    // record 域：本轮维护轮不触碰（终局持久权威留在原地）
    expect(fs.existsSync(recordFile)).toBe(true);
    expect(fs.readFileSync(recordFile, "utf8")).toContain("wf-record-001");
  });
});
