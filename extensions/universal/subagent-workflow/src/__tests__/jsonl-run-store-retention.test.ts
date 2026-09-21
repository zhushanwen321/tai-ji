// src/__tests__/jsonl-run-store-retention.test.ts
//
// workflow-state 磁盘保留清理（OR-5 ⑥b 默认开 → [P1b-2] 终局资格感知）。
//
// 锁定的语义（D5 清理规则①②）：
// - 「已终局」单源锚定 = run 终局投影 manifest（<runId>.json）的 outcome 非空；
//   manifest 缺失 = 活跃或 interrupted（D9-1：interrupted 非终局）——一律不裁；
// - 已终局计入 cap（TAIJI_SUBAGENT_STATE_MAX_RUNS，mtime 升序裁最旧）与 TTL
//   （TAIJI_SUBAGENT_STATE_TTL_MS，缺省 30 天，测试期调低）双限；
// - opt-out：cap 或 TTL 的显式非法值 → 对应机制不生效（cap 非法 = 整轮不清理，
//   用户意图不明时不动磁盘）；
// - journal（<runId>.events.jsonl）与 run 终局投影 manifest（<runId>.json）永不
//   被本面裁剪（journal 清理归 Q2；manifest 是终局持久权威）；
// - glob 外文件（非 wf- 前缀 / 非 .jsonl）与父目录 session JSONL 永不误删；
// - 单个删除失败（unlink 目录 → EPERM，非 ENOENT）logger.warn 留证不抛，
//   save 主链路不受影响。
//
// mtime 确定性：每个文件落盘后立即 utimesSync 钉死 mtime（基线 + i 分钟，全部
// 过去时），消除同毫秒写入的排序抖动——被删集合 = mtime 最旧的 (N - cap) 个，
// 断言精确到文件名。

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
import { WorkflowRun } from "@zhushanwen/subagent-core";
import { writeRunTerminalManifest } from "@zhushanwen/subagent-core";
// DEFAULT_STATE_MAX_RUNS 仅测试消费符号（D3 标准不进 barrel），深路径直取
import { DEFAULT_STATE_MAX_RUNS } from "@zhushanwen/subagent-core/orchestration/file-run-store.ts";
import {
  JsonlRunStore,
  STATE_MAX_RUNS_ENV,
  STATE_TTL_MS_ENV,
} from "../jsonl-run-store.ts";

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

/** 把文件/目录 mtime 钉到过去（基线 + i 分钟）——排序判定不依赖真实写入时序。 */
function pinMtime(fullPath: string, i: number, base: number): void {
  const t = new Date(base + i * 60_000);
  fs.utimesSync(fullPath, t, t);
}

/** 写 run 终局投影 manifest（已终局资格的构造面——prune 资格单源锚定）。 */
async function markTerminal(stateDir: string, runId: string, outcome: "completed" | "failed" | "cancelled" = "completed"): Promise<void> {
  await writeRunTerminalManifest(stateDir, {
    id: runId,
    workflowName: "test-script",
    outcome,
    settledAt: 1719500001000,
  });
}

describe("workflow-state 保留清理（[P1b-2] 终局资格感知）", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-retention-"));
    stateDir = path.join(tmpDir, "workflow-state");
    // 双保险：vitest.setup 全局净化 + 本文件显式 delete（防用例间经 stub 栈泄漏）
    delete process.env[STATE_MAX_RUNS_ENV];
    delete process.env[STATE_TTL_MS_ENV];
    loggerMock.warn.mockClear();
    loggerMock.debug.mockClear();
  });

  afterEach(() => {
    delete process.env[STATE_MAX_RUNS_ENV];
    delete process.env[STATE_TTL_MS_ENV];
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("已终局计入 cap：cap=2 写 3 个已终局 → 裁 mtime 最旧的 1 个，剩最新 2", async () => {
    process.env[STATE_MAX_RUNS_ENV] = "2";
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    const base = Date.now() - 10 * 60_000;

    for (let i = 0; i < 3; i++) {
      const runId = runIdAt(i);
      await markTerminal(stateDir, runId);
      await store.save(makeRunningRun(runId));
      // save 返回 = 首写 flush + 本轮 prune 已执行；此刻钉 mtime 供下一轮 prune 排序
      pinMtime(stateFile(stateDir, runId), i, base);
    }

    // 最后一轮 prune：已终局 3 个裁到 2——留 i=1,2，删 i=0（其 manifest 永不裁）
    expect(fs.readdirSync(stateDir).sort()).toEqual(
      [runIdAt(0), runIdAt(1), runIdAt(2)]
        .map((id) => `${id}.json`)
        .concat([runIdAt(1), runIdAt(2)].map((id) => `${id}.jsonl`))
        .sort(),
    );
    expect(loggerMock.warn).not.toHaveBeenCalled();
    await store.dispose();
  });

  it("活跃不裁：cap=1 写 3 个活跃 run（无 manifest）→ 全保留", async () => {
    process.env[STATE_MAX_RUNS_ENV] = "1";
    const store = new JsonlRunStore({ sessionDir: tmpDir });

    for (let i = 0; i < 3; i++) {
      await store.save(makeRunningRun(runIdAt(i)));
    }

    expect(fs.readdirSync(stateDir).sort()).toEqual(
      [runIdAt(0), runIdAt(1), runIdAt(2)].map((id) => `${id}.jsonl`).sort(),
    );
    expect(loggerMock.warn).not.toHaveBeenCalled();
    await store.dispose();
  });

  it("interrupted 不裁：无 manifest 但有 journal 的 stem，state 与 journal 双双保留", async () => {
    process.env[STATE_MAX_RUNS_ENV] = "1";
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    const base = Date.now() - 10 * 60_000;

    // interrupted 形态构造：journal 存在（事件流中断的待恢复态，无 run-settled 帧、
    // 无终局投影 manifest）——本批判定面 manifest 缺失 = 保护（Q2 abandon 终局化
    // 写 manifest 后才获资格）。mtime 钉成最旧：资格保护与新旧无关。
    fs.mkdirSync(stateDir, { recursive: true });
    const interruptedId = runIdAt(0);
    fs.writeFileSync(path.join(stateDir, `${interruptedId}.events.jsonl`), "{}\n", "utf-8");
    await store.save(makeRunningRun(interruptedId));
    pinMtime(stateFile(stateDir, interruptedId), 0, base);

    // 已终局 run 进场触发 prune
    const terminalId = runIdAt(1);
    await markTerminal(stateDir, terminalId);
    await store.save(makeRunningRun(terminalId));

    // interrupted 的 state + journal 全保留；已终局的 state 与 manifest 保留（cap 未超）
    expect(fs.existsSync(stateFile(stateDir, interruptedId))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, `${interruptedId}.events.jsonl`))).toBe(true);
    expect(fs.existsSync(stateFile(stateDir, terminalId))).toBe(true);
    expect(loggerMock.warn).not.toHaveBeenCalled();
    await store.dispose();
  });

  it("混合场景：cap=2 下 1 活跃（mtime 最旧）+ 2 已终局 → 加第 3 个已终局时裁最旧已终局，活跃永保留", async () => {
    process.env[STATE_MAX_RUNS_ENV] = "2";
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    const base = Date.now() - 10 * 60_000;

    // 活跃 run 钉成全局最旧（资格保护与 mtime 新旧无关的判定锚）
    const activeId = runIdAt(0);
    await store.save(makeRunningRun(activeId));
    pinMtime(stateFile(stateDir, activeId), 0, base);

    const terminalA = runIdAt(1);
    const terminalB = runIdAt(2);
    await markTerminal(stateDir, terminalA);
    await store.save(makeRunningRun(terminalA));
    pinMtime(stateFile(stateDir, terminalA), 1, base);
    await markTerminal(stateDir, terminalB);
    await store.save(makeRunningRun(terminalB));
    pinMtime(stateFile(stateDir, terminalB), 2, base);
    // 本轮 prune：已终局 {A,B} ≤ cap=2，无裁剪

    // 第 3 个已终局进场：已终局 3 个 > cap=2 → 裁最旧的 A；活跃保留
    const terminalC = runIdAt(3);
    await markTerminal(stateDir, terminalC);
    await store.save(makeRunningRun(terminalC));

    expect(fs.existsSync(stateFile(stateDir, activeId))).toBe(true);
    expect(fs.existsSync(stateFile(stateDir, terminalA))).toBe(false);
    expect(fs.existsSync(stateFile(stateDir, terminalB))).toBe(true);
    expect(fs.existsSync(stateFile(stateDir, terminalC))).toBe(true);
    // 被裁 run 的终局 manifest 永不随裁（终局持久权威）
    expect(fs.existsSync(path.join(stateDir, `${terminalA}.json`))).toBe(true);
    expect(loggerMock.warn).not.toHaveBeenCalled();
    await store.dispose();
  });

  it("journal 保护：已终局 run 的 journal 不随本面裁剪（清理执行归 Q2）", async () => {
    process.env[STATE_MAX_RUNS_ENV] = "1";
    const store = new JsonlRunStore({ sessionDir: tmpDir });

    const oldId = runIdAt(0);
    await markTerminal(stateDir, oldId, "failed");
    fs.writeFileSync(path.join(stateDir, `${oldId}.events.jsonl`), "{}\n", "utf-8");
    await store.save(makeRunningRun(oldId));

    // 新 run 进场触发 prune：已终局 1 个 > cap=1 → oldId 的 state 被裁
    const newId = runIdAt(1);
    await markTerminal(stateDir, newId);
    await store.save(makeRunningRun(newId));

    expect(fs.existsSync(stateFile(stateDir, oldId))).toBe(false);
    // journal 留给 Q2 的 journal-cleanup-eligible（本面不删）
    expect(fs.existsSync(path.join(stateDir, `${oldId}.events.jsonl`))).toBe(true);
    await store.dispose();
  });

  it("TTL：已终局且 mtime 超期 → 裁（无论 cap）；活跃超期不裁（TTL 同限已终局）", async () => {
    process.env[STATE_MAX_RUNS_ENV] = "100";
    process.env[STATE_TTL_MS_ENV] = "60000"; // 1 分钟（测试期调低）
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    const base = Date.now() - 10 * 60_000; // 全部 mtime 在 10 分钟前——远超 1 分钟 TTL

    const staleTerminal = runIdAt(0);
    await markTerminal(stateDir, staleTerminal);
    await store.save(makeRunningRun(staleTerminal));
    pinMtime(stateFile(stateDir, staleTerminal), 0, base);

    const staleActive = runIdAt(1);
    await store.save(makeRunningRun(staleActive));
    pinMtime(stateFile(stateDir, staleActive), 1, base);

    // 第 3 个 run（未超期）进场触发 prune
    const freshId = runIdAt(2);
    await markTerminal(stateDir, freshId);
    await store.save(makeRunningRun(freshId));

    // 超期已终局被 TTL 裁；超期活跃受资格保护（TTL 只同限已终局）
    expect(fs.existsSync(stateFile(stateDir, staleTerminal))).toBe(false);
    expect(fs.existsSync(stateFile(stateDir, staleActive))).toBe(true);
    expect(fs.existsSync(stateFile(stateDir, freshId))).toBe(true);
    await store.dispose();
  });

  it("TTL opt-out：显式非法值 → 超期已终局不按 TTL 裁（cap 未超时保留）", async () => {
    process.env[STATE_MAX_RUNS_ENV] = "100";
    process.env[STATE_TTL_MS_ENV] = "0"; // 非法值 = opt-out
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    const base = Date.now() - 10 * 60_000;

    const staleTerminal = runIdAt(0);
    await markTerminal(stateDir, staleTerminal);
    await store.save(makeRunningRun(staleTerminal));
    pinMtime(stateFile(stateDir, staleTerminal), 0, base);

    const freshId = runIdAt(1);
    await markTerminal(stateDir, freshId);
    await store.save(makeRunningRun(freshId));

    expect(fs.existsSync(stateFile(stateDir, staleTerminal))).toBe(true);
    expect(fs.existsSync(stateFile(stateDir, freshId))).toBe(true);
    await store.dispose();
  });

  it("cap opt-out：显式非法值 → 整轮不清理（既有语义保持，超 cap 也不裁）", async () => {
    const store = new JsonlRunStore({ sessionDir: tmpDir });

    for (let i = 0; i < 5; i++) {
      const runId = runIdAt(i);
      await markTerminal(stateDir, runId);
      await store.save(makeRunningRun(runId));
    }
    expect(fs.readdirSync(stateDir)).toHaveLength(10); // 5 state + 5 manifest

    // 显式非法值同样不启用（解析回落 undefined = opt-out）：继续写、文件只增不减
    for (const value of ["0", "-2", "abc", "NaN", "Infinity"]) {
      process.env[STATE_MAX_RUNS_ENV] = value;
      const runId = runIdAt(5);
      await markTerminal(stateDir, runId);
      await store.save(makeRunningRun(runId));
    }
    // 5 次均为新 runId 首写（冷路径）flush 落盘 + manifest——磁盘 12 个文件且全程无删除
    expect(fs.readdirSync(stateDir)).toHaveLength(12);
    expect(loggerMock.warn).not.toHaveBeenCalled();
    await store.dispose();
  });

  it("未设 cap env → 默认上限 DEFAULT_STATE_MAX_RUNS 生效（默认开，OR-5 修复保持）", async () => {
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    const total = DEFAULT_STATE_MAX_RUNS + 1;

    for (let i = 0; i < total; i++) {
      const runId = runIdAt(i);
      await markTerminal(stateDir, runId);
      await store.save(makeRunningRun(runId));
    }

    // 已终局 total 个裁到 50，最旧的 runIdAt(0) 被删（runId ts 段递增 → 文件名字典序
    // = 创建序 = mtime 升序，排序确定性不依赖 pin）
    const rest = fs.readdirSync(stateDir).filter((n) => n.endsWith(".jsonl")).sort();
    expect(rest).toHaveLength(DEFAULT_STATE_MAX_RUNS);
    expect(rest).not.toContain(`${runIdAt(0)}.jsonl`);
    expect(rest).toContain(`${runIdAt(total - 1)}.jsonl`);
    expect(loggerMock.warn).not.toHaveBeenCalled();
    await store.dispose();
  });

  it("glob 外文件与父目录 session JSONL 不误删；run 终局投影 manifest（.json）永不裁", async () => {
    fs.mkdirSync(stateDir, { recursive: true });
    const bystanders = [
      "notes.txt",
      "keep-me.jsonl",
      "wf-truncated-noext",
      "xwf-1719500000000-notwf.jsonl",
    ];
    for (const name of bystanders) {
      fs.writeFileSync(path.join(stateDir, name), "x");
    }
    // session JSONL 在父目录（sessionDir），结构性不在扫描范围，实测钉住
    const sessionFile = path.join(tmpDir, "main-session.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");

    process.env[STATE_MAX_RUNS_ENV] = "1";
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    const base = Date.now() - 10 * 60_000;

    const oldId = runIdAt(0);
    await markTerminal(stateDir, oldId);
    await store.save(makeRunningRun(oldId));
    pinMtime(stateFile(stateDir, oldId), 0, base); // 钉成最旧
    await markTerminal(stateDir, runIdAt(1));
    await store.save(makeRunningRun(runIdAt(1)));

    // 2 个已终局裁到 1：runIdAt(0) 被删（其 manifest 保留），4 个旁观文件原封不动
    expect(fs.readdirSync(stateDir).sort()).toEqual(
      [...bystanders, `${runIdAt(0)}.json`, `${runIdAt(1)}.json`, `${runIdAt(1)}.jsonl`].sort(),
    );
    expect(fs.existsSync(sessionFile)).toBe(true);
    expect(loggerMock.warn).not.toHaveBeenCalled();
    await store.dispose();
  });

  it("删除失败（unlink 目录 → EPERM）→ logger.warn 留证不抛，save 正常 resolve", async () => {
    fs.mkdirSync(stateDir, { recursive: true });
    // 用「名字命中 glob 的目录」制造确定性 unlink 失败（unlink 目录 → EPERM）；
    // 该 runId 需已终局才进裁剪候选（写 manifest）
    const blockerId = runIdAt(0);
    const blockerDir = stateFile(stateDir, blockerId);
    fs.mkdirSync(blockerDir);
    await markTerminal(stateDir, blockerId);
    pinMtime(blockerDir, 0, Date.now() - 10 * 60_000); // 钉成最旧 → 成为删除受害者

    process.env[STATE_MAX_RUNS_ENV] = "1";
    const store = new JsonlRunStore({ sessionDir: tmpDir });

    // save 1 的 prune：受害者 = blockerDir → EPERM → warn，但 save 正常 resolve
    const id1 = runIdAt(1);
    await markTerminal(stateDir, id1);
    await store.save(makeRunningRun(id1));
    expect(fs.existsSync(stateFile(stateDir, id1))).toBe(true);
    expect(fs.existsSync(blockerDir)).toBe(true);

    // save 2 的 prune：已终局 3 项裁到 1，受害者 = dir（最旧，重试仍 EPERM）+ file1（次旧，删成）
    const id2 = runIdAt(2);
    await markTerminal(stateDir, id2);
    await store.save(makeRunningRun(id2));
    expect(fs.existsSync(stateFile(stateDir, id1))).toBe(false);
    expect(fs.existsSync(stateFile(stateDir, id2))).toBe(true);
    expect(fs.existsSync(blockerDir)).toBe(true);

    // 每轮 prune 独立重试受害者：save1 与 save2 各 warn 一次（均指向 blockerDir），
    // 不抛错、不阻断其余文件删除
    expect(loggerMock.warn).toHaveBeenCalledTimes(2);
    for (const call of loggerMock.warn.mock.calls) {
      const msg = String(call[0] ?? "");
      expect(msg).toContain("state retention");
      expect(msg).toContain(blockerDir);
    }
    await store.dispose();
  });
});
