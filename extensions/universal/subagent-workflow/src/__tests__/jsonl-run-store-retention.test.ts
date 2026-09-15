// src/__tests__/jsonl-run-store-retention.test.ts
//
// workflow-state 磁盘保留清理（OR-5 ⑥b 默认开；原 B1 opt-in 形态已由修复取代）。
//
// 锁定的语义：
// - 默认开：TAIJI_SUBAGENT_STATE_MAX_RUNS 未设/空串 → 按 DEFAULT_STATE_MAX_RUNS
//   （core 单源常量，保守值 50）裁剪（OR-5 修复前「默认关」即跨 run 无界累积
//   缺陷本身）；
// - opt-out：显式非法值（0/负数/非数值）→ 不清理（用户意图不明时不动磁盘）；
// - 显式覆盖：有效正数 → 上限 = env 值，每次新 run state 文件首写成功后，
//   目录内 wf-*.jsonl 按 mtime 升序裁剪到上限（删最旧）；上限 3 写 5 个 → 剩最新 3；
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
// DEFAULT_STATE_MAX_RUNS 仅测试消费符号（D3 标准不进 barrel），深路径直取
import { DEFAULT_STATE_MAX_RUNS } from "@zhushanwen/subagent-core/orchestration/file-run-store.ts";
import { JsonlRunStore, STATE_MAX_RUNS_ENV } from "../jsonl-run-store.ts";

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

describe("workflow-state 保留清理（OR-5 ⑥b 默认开 TAIJI_SUBAGENT_STATE_MAX_RUNS）", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-retention-"));
    stateDir = path.join(tmpDir, "workflow-state");
    // 双保险：vitest.setup 全局净化 + 本文件显式 delete（防用例间经 stub 栈泄漏）
    delete process.env[STATE_MAX_RUNS_ENV];
    loggerMock.warn.mockClear();
    loggerMock.debug.mockClear();
  });

  afterEach(() => {
    delete process.env[STATE_MAX_RUNS_ENV];
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("上限 3 写 5 个 → 剩最新 3（mtime 最旧的 2 个被删）", async () => {
    process.env[STATE_MAX_RUNS_ENV] = "3";
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    const base = Date.now() - 10 * 60_000;

    for (let i = 0; i < 5; i++) {
      const runId = runIdAt(i);
      await store.save(makeRunningRun(runId));
      // save 返回 = 首写 flush + 本轮 prune 已执行；此刻钉 mtime 供下一轮 prune 排序
      pinMtime(stateFile(stateDir, runId), i, base);
    }

    // 最后一轮 prune 按钉死的 mtime（0<1<2<3<4 分钟）裁到 3：留 i=2,3,4，删 i=0,1
    expect(fs.readdirSync(stateDir).sort()).toEqual(
      [runIdAt(2), runIdAt(3), runIdAt(4)].map((id) => `${id}.jsonl`).sort(),
    );
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("未设 / 空 → 默认上限 DEFAULT_STATE_MAX_RUNS 生效（默认开，OR-5 修复）", async () => {
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    const total = DEFAULT_STATE_MAX_RUNS + 1;

    // 写默认上限 + 1 个 run：每轮首写成功都触发 prune
    for (let i = 0; i < total; i++) {
      await store.save(makeRunningRun(runIdAt(i)));
    }

    // 修复前（默认关）51 个全保留；现在裁到 50，最旧的 runIdAt(0) 被删
    // （runId ts 段递增 → 文件名字典序 = 创建序 = mtime 升序，排序确定性不依赖 pin）
    const rest = fs.readdirSync(stateDir).sort();
    expect(rest).toHaveLength(DEFAULT_STATE_MAX_RUNS);
    expect(rest).not.toContain(`${runIdAt(0)}.jsonl`);
    expect(rest).toContain(`${runIdAt(total - 1)}.jsonl`);
    expect(loggerMock.warn).not.toHaveBeenCalled();
    await store.dispose();
  });

  it("显式非法值（0 / 负数 / 非数值）→ 不清理（opt-out 通道）", async () => {
    const store = new JsonlRunStore({ sessionDir: tmpDir });

    for (let i = 0; i < 5; i++) {
      await store.save(makeRunningRun(runIdAt(i)));
    }
    expect(fs.readdirSync(stateDir)).toHaveLength(5);

    // 显式非法值同样不启用（解析回落 undefined = opt-out）：继续写、文件只增不减
    for (const value of ["0", "-2", "abc", "NaN", "Infinity"]) {
      process.env[STATE_MAX_RUNS_ENV] = value;
      await store.save(makeRunningRun(runIdAt(5)));
    }
    // runIdAt(5) 首写（冷路径）flush 落盘第 6 个文件；后续 4 次为 running 热路径
    // 去抖批（未 flush）——磁盘 6 个文件且全程无删除
    expect(fs.readdirSync(stateDir)).toHaveLength(6);
    expect(loggerMock.warn).not.toHaveBeenCalled();
    await store.dispose();
  });

  it("glob 外文件与父目录 session JSONL 不误删（只删本目录 wf-*.jsonl）", async () => {
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
    fs.writeFileSync(sessionFile, "{}\n");

    process.env[STATE_MAX_RUNS_ENV] = "1";
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    const base = Date.now() - 10 * 60_000;

    await store.save(makeRunningRun(runIdAt(0)));
    pinMtime(stateFile(stateDir, runIdAt(0)), 0, base); // 钉成最旧
    await store.save(makeRunningRun(runIdAt(1)));

    // 2 个 state 文件裁到 1：runIdAt(0) 被删，4 个旁观文件原封不动
    expect(fs.readdirSync(stateDir).sort()).toEqual(
      [...bystanders, `${runIdAt(1)}.jsonl`].sort(),
    );
    expect(fs.existsSync(sessionFile)).toBe(true);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("删除失败（unlink 目录 → EPERM）→ logger.warn 留证不抛，save 正常 resolve", async () => {
    fs.mkdirSync(stateDir, { recursive: true });
    // 用「名字命中 glob 的目录」制造确定性 unlink 失败（unlink 目录 → EPERM）
    const blockerDir = stateFile(stateDir, runIdAt(0));
    fs.mkdirSync(blockerDir);
    pinMtime(blockerDir, 0, Date.now() - 10 * 60_000); // 钉成最旧 → 成为删除受害者

    process.env[STATE_MAX_RUNS_ENV] = "1";
    const store = new JsonlRunStore({ sessionDir: tmpDir });

    // save 1 的 prune：受害者 = blockerDir → EPERM → warn，但 save 正常 resolve
    await store.save(makeRunningRun(runIdAt(1)));
    expect(fs.existsSync(stateFile(stateDir, runIdAt(1)))).toBe(true);
    expect(fs.existsSync(blockerDir)).toBe(true);

    // save 2 的 prune：3 项裁到 1，受害者 = dir（最旧，重试仍 EPERM）+ file1（次旧，删成）
    await store.save(makeRunningRun(runIdAt(2)));
    expect(fs.existsSync(stateFile(stateDir, runIdAt(1)))).toBe(false);
    expect(fs.existsSync(stateFile(stateDir, runIdAt(2)))).toBe(true);
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
