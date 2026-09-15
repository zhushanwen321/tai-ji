/**
 * rfl.mjs 深度输出断言（W2 移交 CRAP 13 条：printStats* / listRuns / cmdList /
 * cmdTrends / summarizeCalls / addUsageSums / validTimingPairs / arrow / expired / cmdClean）。
 *
 * rfl-cli.test.ts（8 用例）覆盖 smoke 面；本文件补输出内容级断言：
 *   - stats 各段渲染（tokens 格式化 / cachePct null / per-role 汇总 / wall 派生 / origins 聚合 / scores 空态 / mustFix null / 畸形 phaseTimings）
 *   - trends/listRuns 时间窗（startedAt 排序、latest 语义、损坏 state 跳过、startedAt 缺失 ?）
 *   - clean 边界（非法 spec、h 规格、startedAt 不可解析回退 mtime）
 *   - import-execute：rfl.mjs 作为 ES module 加载（main 在 import 时执行）——
 *     该 import 语句同时是静态依赖边，使依赖分析把 scripts/rfl.mjs 纳入测试可达域。
 *
 * 驱动方式与 rfl-cli.test.ts 一致：node 子进程 + HOME 隔离 + fixture state.json。
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RFL_PATH = join(__dirname, "..", "..", "scripts", "rfl.mjs");
const run = promisify(execFile);

function fixtureState(opts: {
  startedAt?: string;
  terminated?: string;
  calls?: Array<{ batch: number; round: number; role: string; name: string; usage?: Record<string, number> | null }>;
  rounds?: Array<{ round: number; mustFix?: number | null; phaseTimings: Record<string, [number, number] | null | unknown[]> }>;
  issues?: Record<string, unknown>;
  scores?: unknown[];
}): Record<string, unknown> {
  return {
    meta: { runId: "x", startedAt: opts.startedAt ?? "2026-08-15T10:00:00.000Z", terminated: opts.terminated ?? "clean", baseHash: "" },
    calls: (opts.calls ?? []).map((c) => ({
      batch: c.batch, round: c.round, role: c.role, name: c.name,
      model: "m", durationMs: 100,
      ...(c.usage === null ? {} : { usage: c.usage ?? { input: 100, output: 10, cacheRead: 300, cacheWrite: 0, cost: 0.01 } }),
      promptMode: "full", promptBytes: 500, sessionId: "s1",
    })),
    batches: [{ index: 1, name: "batch-1", rounds: opts.rounds ?? [{ round: 1, mustFix: 1, phaseTimings: { review: [1, 2], aggregate: [2, 3], fix: [3, 4] } }] }],
    issues: opts.issues ?? {},
    ...(opts.scores ? { scores: opts.scores } : {}),
    fixResults: [],
  };
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rfl-deep-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function writeRun(repoSlug: string, runId: string, state: Record<string, unknown> | string): string {
  const dir = join(home, ".review-fix-loop", repoSlug, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), typeof state === "string" ? state : JSON.stringify(state), "utf8");
  return dir;
}

async function rfl(args: string[]): Promise<{ stdout: string }> {
  return run(process.execPath, [RFL_PATH, ...args], { env: { ...process.env, HOME: home } });
}

describe("rfl stats 深度渲染", () => {
  it("tokens 格式化分档（M/k/原值）+ cost 两档 + wall 跨 batch 派生（min start → max end）", async () => {
    writeRun("repo-deep", "wf-fmt", fixtureState({
      calls: [
        // input 合计 1_700_000 → "1.7M"；output 950 → "950"；cost 0.005 → "$0.0050"（<0.01 四位小数）
        { batch: 1, round: 1, role: "reviewer", name: "r", usage: { input: 1_700_000, output: 950, cacheRead: 300_000, cacheWrite: 0, cost: 0.005 } },
      ],
      rounds: [
        // batch 内两轮：合法时序对 min=1_000（b1 r1 review start），max=151_000（b1 r2 fix end）
        { round: 1, phaseTimings: { review: [1000, 61000], aggregate: [61000, 91000], fix: [91000, 121000] } },
        { round: 2, phaseTimings: { review: [121000, 141000], aggregate: [141000, 151000], fix: null } },
      ],
    }));
    const { stdout } = await rfl(["stats", "wf-fmt", "repo-deep"]);
    // wall = 151_000 - 1_000 = 150_000ms = 2m30s（跨轮取全局 min/max，非单轮求和）
    expect(stdout).toContain("wall 2m30s");
    expect(stdout).toContain("input 1.7M");
    expect(stdout).toContain("output 950");
    expect(stdout).toContain("cost $0.0050");
    // cachePct = 300_000 / (1_700_000 + 300_000) = 15%
    expect(stdout).toContain("(cacheRead 15%)");
  });

  it("calls 全无 usage → cachePct null 显示 \"-\"；per-role 仍计 count（addUsageSums 跳过无 usage call）", async () => {
    writeRun("repo-deep", "wf-nousage", fixtureState({
      calls: [
        { batch: 1, round: 1, role: "reviewer", name: "r", usage: null },
        { batch: 1, round: 1, role: "fixer", name: "f", usage: null },
      ],
    }));
    const { stdout } = await rfl(["stats", "wf-nousage", "repo-deep"]);
    expect(stdout).toContain("(cacheRead -)");
    expect(stdout).toContain("cost $0.00"); // 0 → "$0.0000"（<0.01 档）
    // byRole count 不依赖 usage：两角色各 ×1
    expect(stdout).toContain("reviewer ×1");
    expect(stdout).toContain("fixer ×1");
  });

  it("calls 空 → per-role \"(no calls)\" + wall \"-\"（无合法时序对）", async () => {
    writeRun("repo-deep", "wf-nocalls", fixtureState({ calls: [], rounds: [] }));
    const { stdout } = await rfl(["stats", "wf-nocalls", "repo-deep"]);
    expect(stdout).toContain("per-role: (no calls)");
    expect(stdout).toContain("wall -");
    // printStatsScores 空态
    expect(stdout).toContain("scores: (none)");
  });

  it("per-role 汇总 = input+cacheRead 合计（summarizeCalls byRole 口径）", async () => {
    writeRun("repo-deep", "wf-roles", fixtureState({
      calls: [
        { batch: 1, round: 1, role: "reviewer", name: "r", usage: { input: 1000, output: 10, cacheRead: 1000, cacheWrite: 0, cost: 0 } },
        { batch: 1, round: 2, role: "reviewer", name: "r", usage: { input: 1000, output: 10, cacheRead: 1000, cacheWrite: 0, cost: 0 } },
        { batch: 1, round: 1, role: "aggregator", name: "agg", usage: { input: 250, output: 10, cacheRead: 250, cacheWrite: 0, cost: 0 } },
      ],
    }));
    const { stdout } = await rfl(["stats", "wf-roles", "repo-deep"]);
    expect(stdout).toContain("reviewer ×2 4k");
    expect(stdout).toContain("aggregator ×1 500");
  });

  it("issues 段：origins 聚合（regression/new/缺省 -）+ regressed-ever 计数", async () => {
    writeRun("repo-deep", "wf-origins", fixtureState({
      issues: {
        "MF-1": { status: "fixed", origin: "regression", history: [{ round: 1, status: "open" }, { round: 1, status: "fix-attempted" }, { round: 2, status: "regressed" }, { round: 2, status: "fix-attempted" }, { round: 3, status: "fixed" }] },
        "MF-2": { status: "fixed", origin: "new", history: [{ round: 1, status: "open" }, { round: 1, status: "fix-attempted" }, { round: 2, status: "fixed" }] },
        "MF-3": { status: "open", history: [{ round: 1, status: "open" }] }, // 无 origin → "-"
      },
    }));
    const { stdout } = await rfl(["stats", "wf-origins", "repo-deep"]);
    expect(stdout).toContain("issues (last batch): total 3 → fixed 2  regressed-ever 1");
    expect(stdout).toContain("origins regression 1/new 1/- 1");
    expect(stdout).toContain("dormant (last batch) 0");
  });

  it("时间线：mustFix null → \"-\"（F3 消费侧兜底）+ 畸形 phaseTimings 段显示 \"-\"", async () => {
    writeRun("repo-deep", "wf-timeline", fixtureState({
      rounds: [
        // r1：mustFix null（review-failure 轮如实采集）+ review 相位畸形（非数组值）
        // 注：字符串对（["a","b"]）当前渲染 "review NaNms"——printStatsTimeline 的
        // seg() 只查 Array.isArray、不做数字对校验（与 validTimingPairs 口径不一致）。
        // 该不一致属潜在清理项，此处不锁定 NaN 渲染，只锁定非数组值的 "-" 分支。
        { round: 1, mustFix: null, phaseTimings: { review: "garbage", aggregate: [1, 2], fix: null } },
        { round: 2, mustFix: 3, phaseTimings: { review: [10, 2010], aggregate: [2010, 3010], fix: [3010, 61010] } },
      ],
    }));
    const { stdout } = await rfl(["stats", "wf-timeline", "repo-deep"]);
    expect(stdout).toContain("R1 (batch 1): review - │ aggregate 1ms │ fix -  mustFix -");
    expect(stdout).toContain("R2 (batch 1): review 2s │ aggregate 1s │ fix 58s  mustFix 3");
  });
});

describe("rfl list/trends 时间窗", () => {
  it("listRuns 按 startedAt 时间序排列（与 runId 字母序无关）+ calls 计数", async () => {
    // 写入顺序与时间序相反：wf-z 最早、wf-m 居中、wf-a 最新 → 输出必须 z → m → a
    writeRun("repo-win", "wf-a", fixtureState({ startedAt: "2026-08-18T10:00:00.000Z", calls: [{ batch: 1, round: 1, role: "reviewer", name: "r" }, { batch: 1, round: 1, role: "fixer", name: "f" }] }));
    writeRun("repo-win", "wf-m", fixtureState({ startedAt: "2026-08-16T10:00:00.000Z", calls: [{ batch: 1, round: 1, role: "reviewer", name: "r" }] }));
    // wf-z 用旧形态 state：无 calls 键（fixtureState 删除，模拟旧 state.json）
    const noCalls = fixtureState({ startedAt: "2026-08-14T10:00:00.000Z" });
    delete noCalls.calls;
    writeRun("repo-win", "wf-z", noCalls);
    const { stdout } = await rfl(["list", "repo-win"]);
    const lines = stdout.split("\n").filter((l) => l.startsWith("wf-"));
    expect(lines.map((l) => /^wf-\S+/.exec(l)?.[0])).toEqual(["wf-z", "wf-m", "wf-a"]);
    expect(stdout).toMatch(/wf-a[^\n]*calls: 2/);
    expect(stdout).toMatch(/wf-m[^\n]*calls: 1/);
    // 无 calls 键的旧 state：不显示 calls 段（而非 calls: 0）
    expect(stdout).toMatch(/wf-z[^\n]*rounds: 1\s*$/m);
  });

  it("stats latest 取时间序末位（最新 run），非字母序", async () => {
    writeRun("repo-win", "wf-a", fixtureState({ startedAt: "2026-08-18T10:00:00.000Z" }));
    writeRun("repo-win", "wf-z", fixtureState({ startedAt: "2026-08-20T10:00:00.000Z", terminated: "converged" }));
    const { stdout } = await rfl(["stats", "latest", "repo-win"]);
    expect(stdout).toContain("wf-z");
    expect(stdout).toContain("converged");
    expect(stdout).not.toContain("terminated: clean"); // wf-a（clean）不是 latest
  });

  it("损坏 state.json（半写入）被 listRuns 跳过不崩；startedAt 缺失显示 ?", async () => {
    writeRun("repo-win", "wf-corrupt", '{"meta": {"runId": "x", "startedAt": "2026-08'); // 半写入截断 JSON
    const bare = fixtureState({ terminated: "stuck" });
    delete (bare.meta as Record<string, unknown>).startedAt;
    writeRun("repo-win", "wf-bare", bare);
    const { stdout } = await rfl(["list", "repo-win"]);
    expect(stdout).not.toContain("wf-corrupt");
    expect(stdout).toContain("wf-bare");
    expect(stdout).toMatch(/wf-bare\s+\?\s+stuck/);
    // trends 同样跳过损坏 run
    const trends = await rfl(["trends", "repo-win"]);
    expect(trends.stdout).not.toContain("wf-corrupt");
    expect(trends.stdout).toContain("wf-bare");
  });

  it("trends tokens 列 = input+cacheRead+output 合计（run 级口径）", async () => {
    writeRun("repo-win", "wf-tok", fixtureState({
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r", usage: { input: 4_000, output: 1_000, cacheRead: 5_000, cacheWrite: 0, cost: 0 } }],
    }));
    const { stdout } = await rfl(["trends", "repo-win"]);
    // 4_000 + 5_000 + 1_000 = 10_000 → "10k"；cachePct = 5000/9000 = 56%
    expect(stdout).toMatch(/wf-tok[^\n]*\s10k\s+56%/);
  });
});

describe("rfl clean 边界", () => {
  it("非法 --older-than 规格 → exit 1 + invalid 提示", async () => {
    // exit 1 → promisify(execFile) reject，错误对象携带 stdout
    const err = await rfl(["clean", "--older-than", "30x"]).then(
      (r) => { throw new Error("expected non-zero exit, got: " + r.stdout); },
      (e: Error & { stdout?: string }) => e,
    );
    expect(err.stdout ?? "").toContain("invalid --older-than");
    expect(err.stdout ?? "").toContain("expect <N>d or <N>h");
  });

  it("h 规格：2h 前过期、30m 前保留（cmdClean expired 判定）", async () => {
    const now = Date.now();
    writeRun("repo-cl", "wf-2h-ago", fixtureState({ startedAt: new Date(now - 2 * 3_600_000).toISOString() }));
    writeRun("repo-cl", "wf-30m-ago", fixtureState({ startedAt: new Date(now - 30 * 60_000).toISOString() }));
    const dry = await rfl(["clean", "--older-than", "1h"]);
    expect(dry.stdout).toContain("would delete");
    expect(dry.stdout).toContain("wf-2h-ago");
    expect(dry.stdout).not.toContain("wf-30m-ago");
  });

  it("startedAt 不可解析 → 回退 state.json mtime 判定（utimes 置旧）", async () => {
    const dir = writeRun("repo-cl", "wf-badtime", fixtureState({ startedAt: "not-a-date" }));
    // mtime 置为 40 天前（startedAt 无效 → basis 回退 mtime → 过期）
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(join(dir, "state.json"), old, old);
    const dry = await rfl(["clean", "--older-than", "30d"]);
    expect(dry.stdout).toContain("wf-badtime");
  });

  it("无过期 run → \"nothing older than\"", async () => {
    writeRun("repo-cl", "wf-fresh", fixtureState({ startedAt: new Date().toISOString() }));
    const { stdout } = await rfl(["clean", "--older-than", "30d"]);
    expect(stdout).toContain("nothing older than 30d");
  });
});

describe("rfl import-execute（静态依赖边 + main 即时执行）", () => {
  it("rfl.mjs 可作为 ES module 加载：main 在 import 时执行 list（exit 拦截 + console 捕获）", async () => {
    writeRun("repo-imp", "wf-import-1", fixtureState({ startedAt: "2026-08-19T10:00:00.000Z" }));
    const lines: string[] = [];
    const exitCodes: number[] = [];
    const realLog = console.log;
    const realExit = process.exit;
    const realArgv = process.argv;
    const realHome = process.env.HOME;
    process.env.HOME = home;
    process.argv = ["node", "rfl.mjs", "list", "repo-imp"];
    console.log = ((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }) as typeof console.log;
    // exit 拦截为 no-op 记录：switch 分支 break 后模块正常完成，不杀 vitest worker
    process.exit = ((code?: number) => { exitCodes.push(code ?? 0); }) as unknown as typeof process.exit;
    try {
      vi.resetModules();
      await import("../../scripts/rfl.mjs");
    } finally {
      console.log = realLog;
      process.exit = realExit;
      process.argv = realArgv;
      process.env.HOME = realHome;
    }
    expect(exitCodes[0]).toBe(0);
    expect(lines.join("\n")).toContain("wf-import-1");
    expect(lines.join("\n")).toContain("rounds: 1");
  });
});
