// src/__tests__/jsonl-run-store-retention.test.ts
//
// [D1] record 单源存储收敛后 store 侧保留维护面的退役锚。
//
// 旧形态（[W1 / D5]）的「新 run state 文件首写触发维护轮 + abandon 收编接线」
// 随 state 快照删除而整体退役：save = 显式 no-op，store 不再触发任何维护轮；
// abandon 终局化接线（abandonElapsedInterruptedRuns 的 barrel 消费）同步拆除
// （D9 store 侧部分——interrupted 的进入方收敛为 core 崩溃收编与 terminate）。
//
// 保留维护的现行形态：
// - 判定/执行单源在 core runRetentionMaintenanceRound（维护轮入口）；
// - 触发点收敛为 session_start 兜底（session-lifecycle.ts，oncePerProcess 守卫）
//   ——其行为断言在 session-lifecycle.test.ts；
// - 旧格式两件套（旧 journal `.events.jsonl` + state 快照 `<runId>.jsonl`）不读、
//   不写、**不主动删**——维护轮对窗外终态旧双源足迹的成对裁剪是既有清理通道的
//   自然结果（D1 历史数据处置③：非新增删除动作，跟随裁决点 7 消亡）；
// - record 流（`.record.jsonl` 新后缀）被 prune 候选枚举结构性排除（filter 用
//   RUN_EVENTS_SUFFIX 单源）——唯一事实源不被旧快照面裁剪逻辑误删。
//
// mtime/时钟确定性：事件帧 ts 相对 Date.now 构造（天数偏移注入），不依赖写入时序。

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

import {
  Budget,
  RUN_EVENTS_SUFFIX,
  Trace,
  WorkflowRun,
  runRetentionMaintenanceRound,
  type RunSpec,
  type ExecutionTraceNode,
} from "@zhushanwen/subagent-core";
// STATE_TTL_MS_ENV 仅测试消费符号，深路径直取（[W1 / D5] 保留窗口 env 通道单源
// core run-state-evidence）。
import { STATE_TTL_MS_ENV } from "@zhushanwen/subagent-core/execution/persistence/run-state-evidence.ts";
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

function makeRunningRun(runId: string): WorkflowRun {
  const trace = new Trace();
  trace.append({ stepIndex: 0, agent: "worker", task: "do thing", model: "default", status: "pending" });
  return WorkflowRun.reconstruct(runId, makeSpec(), {
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

function legacyJournalFile(stateDir: string, runId: string): string {
  return path.join(stateDir, `${runId}.events.jsonl`);
}

function recordFile(stateDir: string, runId: string): string {
  return path.join(stateDir, `${runId}${RUN_EVENTS_SUFFIX}`);
}

function manifestFile(stateDir: string, runId: string): string {
  return path.join(stateDir, `${runId}.json`);
}

/** 「N 天前」的 epoch ms（事件帧 ts 注入用——资格判据锚 = 事件 ts）。 */
function daysAgoMs(days: number): number {
  return Date.now() - days * 86_400_000;
}

/**
 * 预置旧格式终态 run 磁盘足迹（旧 journal + state 快照 + 终局 manifest——历史
 * 遗留两件套的在盘形态，D1 后不读不写不主动删）。
 */
function seedLegacyTerminalRun(stateDir: string, runId: string, createdDaysAgo: number, settledDaysAgo: number, outcome: "done" | "failed" | "cancelled" = "completed"): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(legacyJournalFile(stateDir, runId), [
    JSON.stringify({ type: "run-created", ts: daysAgoMs(createdDaysAgo), runId, workflowName: "t", argsSummary: "{}" }),
    JSON.stringify({ type: "run-settled", ts: daysAgoMs(settledDaysAgo), outcome, artifactsDir: "/tmp/artifacts" }),
  ].join("\n") + "\n", "utf8");
  fs.writeFileSync(stateFile(stateDir, runId), `{"runId":"${runId}","stub":true}\n`, "utf8");
  fs.writeFileSync(manifestFile(stateDir, runId), JSON.stringify({ runId, outcome }), "utf8");
}

describe("store 侧保留维护面退役（[D1] record 单源）", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-retention-"));
    stateDir = path.join(tmpDir, "workflow-state");
    delete process.env[STATE_TTL_MS_ENV];
    loggerMock.warn.mockClear();
    loggerMock.debug.mockClear();
  });

  afterEach(() => {
    delete process.env[STATE_TTL_MS_ENV];
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("save 零磁盘动作：旧触发点退役——窗外终态旧双源足迹不被 save 触发的维护轮裁剪", async () => {
    process.env[STATE_TTL_MS_ENV] = String(30 * 86_400_000);
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    seedLegacyTerminalRun(stateDir, runIdAt(0), 40, 35); // 窗外终态（旧触发点下会被裁——对照组）

    // 冷/热路径多次 save：no-op，不触发维护轮、不产生 state 快照
    await store.save(makeRunningRun(runIdAt(1)));
    await store.save(makeRunningRun(runIdAt(1)));

    // 窗外终态旧双源原样留置（删除通道收敛到维护轮入口 / 裁决点 7 对账清理）
    expect(fs.existsSync(stateFile(stateDir, runIdAt(0)))).toBe(true);
    expect(fs.existsSync(legacyJournalFile(stateDir, runIdAt(0)))).toBe(true);
    // save 不再产生 state 快照（旧 `<runId>.jsonl` 投影退役锚）
    expect(fs.existsSync(stateFile(stateDir, runIdAt(1)))).toBe(false);
    await store.dispose();
  });

  it("D9 store 侧接线拆除的机器锚：core barrel 不再导出 abandonElapsedInterruptedRuns（壳侧唯一消费面已拆）", async () => {
    const core = (await import("@zhushanwen/subagent-core")) as unknown as Record<string, unknown>;
    expect(core["abandonElapsedInterruptedRuns"]).toBeUndefined();
  });

  it("glob 外文件与父目录 session JSONL 不被 store 任何动作触碰（零写面推论）", async () => {
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    fs.mkdirSync(stateDir, { recursive: true });
    const bystanders = ["notes.txt", "keep-me.jsonl", "xwf-1719500000000-notwf.jsonl"];
    for (const name of bystanders) fs.writeFileSync(path.join(stateDir, name), "x");
    const sessionFile = path.join(tmpDir, "main-session.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf8");

    await store.save(makeRunningRun(runIdAt(0)));
    await store.flushPendingSaves();

    for (const name of bystanders) {
      expect(fs.existsSync(path.join(stateDir, name))).toBe(true);
    }
    expect(fs.existsSync(sessionFile)).toBe(true);
    await store.dispose();
  });
});

describe("维护轮入口（core 单源）对 run 域目录的行为——session_start 兜底触发点消费面", () => {
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

  it("旧双源窗外终态不获裁剪资格（journal 判据换源后 scan 只认 record 后缀）；record 流不被候选枚举捕获、不误删", async () => {
    process.env[STATE_TTL_MS_ENV] = String(30 * 86_400_000);
    // 旧格式窗外终态：prune 资格 = journal run-settled 帧 fold（D5 判据①）——
    // journal scan 经 RUN_EVENTS_SUFFIX 单源只认 record 后缀后，旧 journal
    // 不进判定路径（空流 = 非终态 = 不获资格）——旧两件套「不读不写不主动删」
    //（D1 历史数据处置）在保留通道的自然成立形态，留置原地。
    seedLegacyTerminalRun(stateDir, runIdAt(0), 40, 35);
    // 新形态 record 流（窗外终态帧）：快照候选锚（<runId>.jsonl）不存在 → 不进
    // 候选枚举；即使在盘也被 journal 后缀 filter 结构性排除——唯一事实源不被旧
    // 快照面裁剪逻辑误删（其清理资格归 u1a prune fold 判据换源后的新判据）
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(recordFile(stateDir, runIdAt(1)), [
      JSON.stringify({ type: "run-created", ts: daysAgoMs(40), runId: runIdAt(1), workflowName: "t", argsSummary: "{}" }),
      JSON.stringify({ type: "run-settled", ts: daysAgoMs(35), outcome: "done", artifactsDir: "/tmp/artifacts" }),
    ].join("\n") + "\n", "utf8");

    await runRetentionMaintenanceRound(
      { stateDir },
      {},
      {
        warn: (msg) => loggerMock.warn(msg),
        debug: (msg) => loggerMock.debug(msg),
        toMsg: (err: unknown) => String(err),
      },
    );

    // 旧双源：整轮零删除（不获资格），留置原地
    expect(fs.existsSync(stateFile(stateDir, runIdAt(0)))).toBe(true);
    expect(fs.existsSync(legacyJournalFile(stateDir, runIdAt(0)))).toBe(true);
    expect(fs.existsSync(manifestFile(stateDir, runIdAt(0)))).toBe(true);
    // record 流：零触碰
    expect(fs.existsSync(recordFile(stateDir, runIdAt(1)))).toBe(true);
  });
});
