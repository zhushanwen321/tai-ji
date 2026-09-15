/**
 * A7: rfl.mjs CLI smoke（rfl 仪表 T4，tier-1 §7.4）。
 *
 * node 子进程执行 scripts/rfl.mjs，HOME 指向临时目录 + 预置 fixture state.json：
 *   - list：列出两 run（runId/时间/terminated/轮数）
 *   - stats latest：token 汇总 + 缓存命中率 + per-role + 轮次时间线
 *   - trends：跨 run 行
 *   - clean --older-than：默认干跑不删；--yes 删过期保留新 run
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RFL_PATH = join(__dirname, "..", "..", "scripts", "rfl.mjs");
const run = promisify(execFile);

function fixtureState(opts: {
  startedAt: string;
  terminated: string;
  calls: Array<{ batch: number; round: number; role: string; name: string; usage?: Record<string, number> }>;
  rounds?: Array<{ round: number; phaseTimings: Record<string, [number, number] | null> }>;
  issues?: Record<string, unknown>;
  scores?: unknown[];
  dormant?: unknown[];
}): Record<string, unknown> {
  return {
    meta: { runId: "x", startedAt: opts.startedAt, terminated: opts.terminated, baseHash: "" },
    calls: opts.calls.map((c) => ({
      batch: c.batch, round: c.round, role: c.role, name: c.name,
      model: "m", durationMs: 100, usage: c.usage ?? { input: 100, output: 10, cacheRead: 300, cacheWrite: 0, cost: 0.01 },
      promptMode: "full", promptBytes: 500, sessionId: "s1",
    })),
    batches: [{ index: 1, name: "batch-1", rounds: opts.rounds ?? [{ round: 1, mustFix: 1, phaseTimings: { review: [1, 2], aggregate: [2, 3], fix: [3, 4] } }] }],
    issues: opts.issues ?? {},
    // M1/M2 字段按需注入：缺省不写字段（保留"旧 state 无该字段"的真实容错场景）
    ...(opts.scores ? { scores: opts.scores } : {}),
    ...(opts.dormant ? { dormant: opts.dormant } : {}),
    fixResults: [],
  };
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rfl-cli-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function writeRun(repoSlug: string, runId: string, state: Record<string, unknown>): string {
  const dir = join(home, ".review-fix-loop", repoSlug, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state), "utf8");
  return dir;
}

async function rfl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [RFL_PATH, ...args], { env: { ...process.env, HOME: home } });
}

describe("A7 rfl CLI（list/stats/trends/clean）", () => {
  it("A7 list：列出两 run 的 runId/terminated/rounds", async () => {
    writeRun("repo-a", "wf-old-1", fixtureState({
      startedAt: "2026-07-01T10:00:00.000Z", terminated: "clean",
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r1" }],
    }));
    writeRun("repo-a", "wf-new-2", fixtureState({
      startedAt: "2026-08-15T10:00:00.000Z", terminated: "stuck",
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r1" }, { batch: 1, round: 1, role: "aggregator", name: "aggregate" }],
      rounds: [
        { round: 1, phaseTimings: { review: [1, 2], aggregate: [2, 3], fix: [3, 4] } },
        { round: 2, phaseTimings: { review: [5, 6], aggregate: [6, 7], fix: null } },
      ],
    }));
    const { stdout } = await rfl(["list", "repo-a"]);
    expect(stdout).toContain("wf-old-1");
    expect(stdout).toContain("wf-new-2");
    expect(stdout).toContain("clean");
    expect(stdout).toContain("stuck");
    // rounds 计数来自 batches[].rounds
    expect(stdout).toMatch(/wf-new-2.*rounds: 2/);
  });

  it("A7 stats latest：token 汇总 + 缓存命中率 + per-role + 轮次时间线 + phaseTimings 派生", async () => {
    writeRun("repo-b", "wf-stats-1", fixtureState({
      startedAt: "2026-08-15T10:00:00.000Z", terminated: "clean",
      calls: [
        { batch: 1, round: 1, role: "reviewer", name: "reviewer-a", usage: { input: 1000, output: 100, cacheRead: 3000, cacheWrite: 0, cost: 0.05 } },
        { batch: 1, round: 1, role: "aggregator", name: "aggregate", usage: { input: 200, output: 50, cacheRead: 800, cacheWrite: 0, cost: 0.01 } },
        { batch: 1, round: 1, role: "fixer", name: "fix", usage: { input: 500, output: 200, cacheRead: 1200, cacheWrite: 0, cost: 0.02 } },
      ],
      rounds: [{ round: 1, phaseTimings: { review: [1000, 61000], aggregate: [61000, 91000], fix: [91000, 151000] } }],
    }));
    const { stdout } = await rfl(["stats", "latest", "repo-b"]);
    expect(stdout).toContain("wf-stats-1");
    expect(stdout).toContain("repo-b");
    // 汇总：input 1700 → 2k 级；cacheRead 5000 / (1700+5000) = 75%
    expect(stdout).toContain("75%");
    expect(stdout).toContain("reviewer ×1");
    expect(stdout).toContain("aggregator ×1");
    expect(stdout).toContain("fixer ×1");
    // 轮次时间线（phaseTimings 派生：60s/30s/60s）
    expect(stdout).toContain("R1 (batch 1)");
    expect(stdout).toContain("review 1m0s");
    expect(stdout).toContain("aggregate 30s");
    expect(stdout).toContain("fix 1m0s");
  });

  it("A7 trends：跨 run 行含轮数与缓存命中率", async () => {
    writeRun("repo-c", "wf-t1", fixtureState({
      startedAt: "2026-08-14T10:00:00.000Z", terminated: "clean",
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r", usage: { input: 100, output: 10, cacheRead: 300, cacheWrite: 0, cost: 0 } }],
    }));
    writeRun("repo-c", "wf-t2", fixtureState({
      startedAt: "2026-08-15T10:00:00.000Z", terminated: "converged",
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r", usage: { input: 100, output: 10, cacheRead: 100, cacheWrite: 0, cost: 0 } }],
      rounds: [
        { round: 1, phaseTimings: { review: [1, 2], aggregate: [2, 3], fix: [3, 4] } },
        { round: 2, phaseTimings: { review: [5, 6], aggregate: [6, 7], fix: [7, 8] } },
      ],
    }));
    const { stdout } = await rfl(["trends", "repo-c"]);
    expect(stdout).toContain("wf-t1");
    expect(stdout).toContain("wf-t2");
    // cache% 列：t1 = 300/400 = 75%；t2 = 100/200 = 50%
    expect(stdout).toContain("75%");
    expect(stdout).toContain("50%");
  });

  it("A7 clean：默认干跑不删；--yes 删过期保留新 run", async () => {
    const oldDir = writeRun("repo-d", "wf-old", fixtureState({
      startedAt: "2026-06-01T10:00:00.000Z", terminated: "clean",
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r" }],
    }));
    const newDir = writeRun("repo-d", "wf-new", fixtureState({
      startedAt: new Date().toISOString(), terminated: "clean",
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r" }],
    }));
    // 干跑：两个目录都在
    const dry = await rfl(["clean", "--older-than", "30d"]);
    expect(dry.stdout).toContain("would delete");
    expect(dry.stdout).toContain("wf-old");
    expect(existsSync(join(oldDir, "state.json"))).toBe(true);

    // --yes：old 删除、new 保留
    const del = await rfl(["clean", "--older-than", "30d", "--yes"]);
    expect(del.stdout).toContain("deleted");
    expect(existsSync(join(oldDir, "state.json"))).toBe(false);
    expect(existsSync(join(newDir, "state.json"))).toBe(true);
  });

  it("A7 stats：无字段容错（M1/M2 的 origin/dormant/scores 缺省显示不崩）", async () => {
    const dir = writeRun("repo-e", "wf-bare", {
      meta: { runId: "x", startedAt: "2026-08-15T10:00:00.000Z" },
      batches: [],
    });
    expect(existsSync(join(dir, "state.json"))).toBe(true);
    const { stdout } = await rfl(["stats", "latest", "repo-e"]);
    expect(stdout).toContain("wf-bare");
    // B3：dormant 是批作用域（最终 state 只含末批），表述显式限定 last batch
    expect(stdout).toContain("dormant (last batch) 0");
  });

  it("B1 trends：regressed 列输出 regressed/attempted（分母=曾进入 fix-attempted 的 issue 数，§6.7 issue 计数口径），分母 0 显示 -", async () => {
    // fixture 只用 history 表达场景、不写 fixAttempts：该字段生产语义是「修复失败
    // 次数」（初始 0，转 regressed 才 +1），与「是否尝试过修复」无关，编造数值会
    // 掩盖口径错误（旧实现按 ΣfixAttempts 算分母正是因此失真）。
    // run1：6 个 issue 中 5 个曾进入修复（history 含 fix-attempted）；MF-5 回归一次
    // 后再修成（同一 issue 多条 fix-attempted 仍只计 1）；MF-6 从未尝试不计入分母
    // → regressed 1 / attempted 5（按条目数算会是 1/6，按失败次数算会是 1/1）
    writeRun("repo-f", "wf-b1a", fixtureState({
      startedAt: "2026-08-16T10:00:00.000Z", terminated: "clean",
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r" }],
      issues: {
        "MF-1": { status: "fixed", history: [{ round: 1, status: "open" }, { round: 1, status: "fix-attempted" }, { round: 2, status: "fixed" }] },
        "MF-2": { status: "fixed", history: [{ round: 1, status: "open" }, { round: 1, status: "fix-attempted" }, { round: 2, status: "fixed" }] },
        "MF-3": { status: "fixed", history: [{ round: 1, status: "open" }, { round: 1, status: "fix-attempted" }, { round: 2, status: "fixed" }] },
        "MF-4": { status: "fixed", history: [{ round: 1, status: "open" }, { round: 1, status: "fix-attempted" }, { round: 2, status: "fixed" }] },
        "MF-5": { status: "fixed", history: [{ round: 1, status: "open" }, { round: 1, status: "fix-attempted" }, { round: 2, status: "regressed" }, { round: 2, status: "fix-attempted" }, { round: 3, status: "fixed" }] },
        "MF-6": { status: "open", history: [{ round: 1, status: "open" }] },
      },
    }));
    // run2：issue 存在但从未进入修复（无 fix-attempted history）→ 分母 0 显示 -
    writeRun("repo-f", "wf-b1b", fixtureState({
      startedAt: "2026-08-17T10:00:00.000Z", terminated: "clean",
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r" }],
      issues: {
        "MF-7": { status: "open", history: [{ round: 1, status: "open" }] },
      },
    }));
    const { stdout } = await rfl(["trends", "repo-f"]);
    // G2：列名缩短为 reg/att（该列是末批作用域，长名会被读成 run 级指标）
    expect(stdout.split("\n")[0]).toContain("reg/att");
    // started 列宽 = ISO 8601 恒长 24：表头须 padEnd(24) 才与数据行对齐（20 会左移 4 字符）
    expect(stdout.split("\n")[0]).toContain("started".padEnd(24) + "  " + "rounds");
    expect(stdout).toMatch(/wf-b1a[^\n]*1\/5/);
    // 分母 0：行尾 regressed 列为 -（cache% 列有值 75%，行尾 - 只能是 regressed 列）
    expect(stdout).toMatch(/wf-b1b[^\n]*75%\s+-\s*$/m);
    // G2：表后 legend 标注 reg/att 的末批作用域与分母口径（与 rounds/tokens/cache%
    // 的 run 级口径区分），跨 run 对比不再误读
    expect(stdout).toContain("reg/att: last-batch scope (issues reset per batch); denominator = issues ever fix-attempted");
  });

  it("B2 stats：scores 的 dimensions.regression=null 显示 n/a（不输出字面量 null）+ B3 dormant (last batch) 计数", async () => {
    writeRun("repo-g", "wf-b2", fixtureState({
      startedAt: "2026-08-19T10:00:00.000Z", terminated: "clean",
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r" }],
      scores: [
        { round: 1, targetKind: "diff", targetName: "fixer-a", total: 8, dimensions: { quality: 8, regression: null } },
        { round: 2, targetKind: "diff", targetName: "fixer-b", total: null, dimensions: { quality: 7, regression: 6 } },
      ],
      dormant: [{ id: "MF-9", reason: "unverified", detail: "d", round: 1, revived: false }],
    }));
    const { stdout } = await rfl(["stats", "latest", "repo-g"]);
    // null 维度显示 n/a（unverifiable），非 null 维度正常输出
    expect(stdout).toContain("regression n/a");
    expect(stdout).toContain("quality 8");
    expect(stdout).toContain("regression 6");
    expect(stdout).not.toContain("regression null");
    // C2：issues 行与 dormant 同为末批作用域（state.issues 批重置后只含末批），
    // 行首同样带 (last batch) 限定
    expect(stdout).toContain("issues (last batch): total 0");
    // B3：dormant 计数为末批作用域，非 0 时同样带限定
    expect(stdout).toContain("dormant (last batch) 1");
    // G1：fixture 的 scores entry 均无 batch 字段（旧数据），score 行回退 B1
    expect(stdout).toContain("score B1 R1");
    expect(stdout).toContain("score B1 R2");
  });

  it("G1 stats：score 行带批标识 B<n>，多批 run 中批局部 round 编号可归批", async () => {
    // round 是批局部编号（每批从 1 重新计数）：批 1 与批 2 各有一条 round 1 的
    // score，仅打 "R1" 时两行完全同形无法归批——带 B<batch> 后可区分
    writeRun("repo-h", "wf-g1", fixtureState({
      startedAt: "2026-08-19T12:00:00.000Z", terminated: "clean",
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r" }],
      scores: [
        { batch: 1, round: 1, targetKind: "diff", targetName: "fixer-a", total: 8 },
        { batch: 2, round: 1, targetKind: "diff", targetName: "fixer-b", total: 7 },
      ],
    }));
    const { stdout } = await rfl(["stats", "latest", "repo-h"]);
    expect(stdout).toContain("score B1 R1 diff/fixer-a");
    expect(stdout).toContain("score B2 R1 diff/fixer-b");
  });
});
