/**
 * rfl-cli.test.ts —— C03 簇合并产物（round5-F）：rfl.mjs CLI 测试。
 * 两个来源同以 scripts/rfl.mjs 为被测业务模块：
 *   - rfl-cli.test.ts（A7: rfl.mjs CLI smoke——进程内 6 条 + 真进程冒烟 2 条）
 *   - rfl-cli-deep.test.ts（W2 移交 CRAP 13 条深度输出断言——全部进程内）
 *
 * 驱动方式（单测层拆分层，docs/TEST-STRATEGY.md「新写测试判据」节 第二波）：
 *   - 输出断言主通道 = 进程内加载 rfl.mjs（vi.resetModules + 动态 import，main 在
 *     import 时执行）——CLI 输出解析/渲染逻辑零子进程，高负载无 fork/exec 窗口；
 *   - 真 node 子进程（execFile）缩到 2 条冒烟（list 全链路 stdout + clean --yes
 *     真删），守护「rfl.mjs 作为 bin 被 node 执行」的进程级契约。
 * 两个来源的 rflInProcess 逐字同款，合一为簇内共享；fixtureState 签名不同
 * （smoke 版 calls 必填 / 深度版支持 usage null 与缺省），随各来源分节内私有
 * 保留（包裹 describe 隔离，零调用点改动）。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RFL_PATH = join(__dirname, "..", "..", "scripts", "rfl.mjs");
const run = promisify(execFile);

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rfl-cli-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 写一个 run 的 state.json（深度分节可传字符串形态——半写入损坏 fixture）。 */
function writeRun(repoSlug: string, runId: string, state: Record<string, unknown> | string): string {
  const dir = join(home, ".agents", "skill-data", "review-fix-loop", "rfl", repoSlug, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), typeof state === "string" ? state : JSON.stringify(state), "utf8");
  return dir;
}

/** 真 node 子进程执行 rfl.mjs（仅冒烟用例使用）。 */
async function rfl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  // SKILL_DATA_DIR 显式置空：防宿主环境残留值把 ROOT 重定向出 HOME 隔离树
  return run(process.execPath, [RFL_PATH, ...args], { env: { ...process.env, HOME: home, SKILL_DATA_DIR: "" } });
}

/**
 * 进程内驱动 rfl.mjs（输出断言主通道）：rfl.mjs 的 main 在 import 时执行（读
 * process.argv），SKILL_DATA_ROOT 在模块加载期求值——SKILL_DATA_DIR 须先指向
 * fixture。process.exit 拦截为 no-op 记录（switch 分支 break 后模块正常完成，不杀
 * worker），console.log/error 捕获为行数组 = execFile stdout 的进程内等价物；
 * exitCodes 即 execFile 版的 exit status（含非零分支，免 promisify reject 取
 * err.stdout 的形态）。
 */
async function rflInProcess(args: string[]): Promise<{ out: string; lines: string[]; exitCodes: number[] }> {
  const lines: string[] = [];
  const exitCodes: number[] = [];
  const realLog = console.log;
  const realErr = console.error;
  const realExit = process.exit;
  const realArgv = process.argv;
  const realSkillDataDir = process.env.SKILL_DATA_DIR;
  // 根隔离主通道 = SKILL_DATA_DIR 直指隔离树（rfl.mjs 的根替代 SSOT：非空时短路
  // homedir() 回退，经 process.env JS 读，forks/threads 双池一致）。置空回退 HOME
  // 通道在 threads 池失效——worker 的 env 拷贝 JS 写不传导 os.homedir() 读的
  // C environ，会落回真实 HOME。值取隔离树内 .agents/skill-data，与置空时
  // forks 形态的落盘路径逐字同构（writeRun 的 fixture 路径即按此树写）。
  process.env.SKILL_DATA_DIR = join(home, ".agents", "skill-data");
  process.argv = ["node", "rfl.mjs", ...args];
  console.log = ((...a: unknown[]) => { lines.push(a.map(String).join(" ")); }) as typeof console.log;
  console.error = ((...a: unknown[]) => { lines.push(a.map(String).join(" ")); }) as typeof console.error;
  // exit 拦截为 no-op 记录：switch 分支 break 后模块正常完成，不杀 vitest worker
  process.exit = ((code?: number) => { exitCodes.push(code ?? 0); }) as unknown as typeof process.exit;
  try {
    vi.resetModules();
    await import("../../scripts/rfl.mjs");
  } finally {
    console.log = realLog;
    console.error = realErr;
    process.exit = realExit;
    process.argv = realArgv;
    if (realSkillDataDir === undefined) delete process.env.SKILL_DATA_DIR;
    else process.env.SKILL_DATA_DIR = realSkillDataDir;
  }
  return { out: lines.join("\n"), lines, exitCodes };
}

// ══════════════════════════════════════════════════════════════
// 来源：rfl-cli.test.ts —— A7: rfl.mjs CLI smoke（rfl 仪表 T4，tier-1 §7.4）。
// skill-data 根指向临时目录（SKILL_DATA_DIR 隔离）+ 预置 fixture state.json。
// ══════════════════════════════════════════════════════════════

describe("A7 rfl CLI smoke（list/stats/trends/clean，进程内 + 真进程冒烟）", () => {
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

  describe("A7 rfl CLI（list/stats/trends/clean，进程内）", () => {
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
      const { out } = await rflInProcess(["stats", "latest", "repo-b"]);
      expect(out).toContain("wf-stats-1");
      expect(out).toContain("repo-b");
      // 汇总：input 1700 → 2k 级；cacheRead 5000 / (1700+5000) = 75%
      expect(out).toContain("75%");
      expect(out).toContain("reviewer ×1");
      expect(out).toContain("aggregator ×1");
      expect(out).toContain("fixer ×1");
      // 轮次时间线（phaseTimings 派生：60s/30s/60s）
      expect(out).toContain("R1 (batch 1)");
      expect(out).toContain("review 1m0s");
      expect(out).toContain("aggregate 30s");
      expect(out).toContain("fix 1m0s");
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
      const { out } = await rflInProcess(["trends", "repo-c"]);
      expect(out).toContain("wf-t1");
      expect(out).toContain("wf-t2");
      // cache% 列：t1 = 300/400 = 75%；t2 = 100/200 = 50%
      expect(out).toContain("75%");
      expect(out).toContain("50%");
    });

    it("A7 stats：无字段容错（M1/M2 的 origin/dormant/scores 缺省显示不崩）", async () => {
      const dir = writeRun("repo-e", "wf-bare", {
        meta: { runId: "x", startedAt: "2026-08-15T10:00:00.000Z" },
        batches: [],
      });
      expect(existsSync(join(dir, "state.json"))).toBe(true);
      const { out } = await rflInProcess(["stats", "latest", "repo-e"]);
      expect(out).toContain("wf-bare");
      // B3：dormant 是批作用域（最终 state 只含末批），表述显式限定 last batch
      expect(out).toContain("dormant (last batch) 0");
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
      const { out, lines } = await rflInProcess(["trends", "repo-f"]);
      // G2：列名缩短为 reg/att（该列是末批作用域，长名会被读成 run 级指标）
      expect(lines[0]).toContain("reg/att");
      // started 列宽 = ISO 8601 恒长 24：表头须 padEnd(24) 才与数据行对齐（20 会左移 4 字符）
      expect(lines[0]).toContain("started".padEnd(24) + "  " + "rounds");
      expect(out).toMatch(/wf-b1a[^\n]*1\/5/);
      // 分母 0：行尾 regressed 列为 -（cache% 列有值 75%，行尾 - 只能是 regressed 列）
      expect(out).toMatch(/wf-b1b[^\n]*75%\s+-\s*$/m);
      // G2：表后 legend 标注 reg/att 的末批作用域与分母口径（与 rounds/tokens/cache%
      // 的 run 级口径区分），跨 run 对比不再误读
      expect(out).toContain("reg/att: last-batch scope (issues reset per batch); denominator = issues ever fix-attempted");
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
      const { out } = await rflInProcess(["stats", "latest", "repo-g"]);
      // null 维度显示 n/a（unverifiable），非 null 维度正常输出
      expect(out).toContain("regression n/a");
      expect(out).toContain("quality 8");
      expect(out).toContain("regression 6");
      expect(out).not.toContain("regression null");
      // C2：issues 行与 dormant 同为末批作用域（state.issues 批重置后只含末批），
      // 行首同样带 (last batch) 限定
      expect(out).toContain("issues (last batch): total 0");
      // B3：dormant 计数为末批作用域，非 0 时同样带限定
      expect(out).toContain("dormant (last batch) 1");
      // G1：fixture 的 scores entry 均无 batch 字段（旧数据），score 行回退 B1
      expect(out).toContain("score B1 R1");
      expect(out).toContain("score B1 R2");
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
      const { out } = await rflInProcess(["stats", "latest", "repo-h"]);
      expect(out).toContain("score B1 R1 diff/fixer-a");
      expect(out).toContain("score B2 R1 diff/fixer-b");
    });
  });

  describe("A7 rfl CLI 真进程冒烟（execFile 真 node）", () => {
    it("list：真 node 子进程执行 rfl.mjs，stdout 列出两 run 的 runId/terminated/rounds", async () => {
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

    it("clean：真 node 子进程默认干跑不删；--yes 删过期保留新 run", async () => {
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
  });
});

// ══════════════════════════════════════════════════════════════
// 来源：rfl-cli-deep.test.ts —— rfl.mjs 深度输出断言（W2 移交 CRAP 13 条：
// printStats* / listRuns / cmdList / cmdTrends / summarizeCalls / addUsageSums /
// validTimingPairs / arrow / expired / cmdClean）。stats 各段渲染 / trends、
// listRuns 时间窗 / clean 边界 / import-execute 静态依赖边。
// ══════════════════════════════════════════════════════════════

describe("rfl.mjs 深度输出断言（W2 移交 CRAP 13 条）", () => {
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
      const { out } = await rflInProcess(["stats", "wf-fmt", "repo-deep"]);
      // wall = 151_000 - 1_000 = 150_000ms = 2m30s（跨轮取全局 min/max，非单轮求和）
      expect(out).toContain("wall 2m30s");
      expect(out).toContain("input 1.7M");
      expect(out).toContain("output 950");
      expect(out).toContain("cost $0.0050");
      // cachePct = 300_000 / (1_700_000 + 300_000) = 15%
      expect(out).toContain("(cacheRead 15%)");
    });

    it("calls 全无 usage → cachePct null 显示 \"-\"；per-role 仍计 count（addUsageSums 跳过无 usage call）", async () => {
      writeRun("repo-deep", "wf-nousage", fixtureState({
        calls: [
          { batch: 1, round: 1, role: "reviewer", name: "r", usage: null },
          { batch: 1, round: 1, role: "fixer", name: "f", usage: null },
        ],
      }));
      const { out } = await rflInProcess(["stats", "wf-nousage", "repo-deep"]);
      expect(out).toContain("(cacheRead -)");
      expect(out).toContain("cost $0.00"); // 0 → "$0.0000"（<0.01 档）
      // byRole count 不依赖 usage：两角色各 ×1
      expect(out).toContain("reviewer ×1");
      expect(out).toContain("fixer ×1");
    });

    it("calls 空 → per-role \"(no calls)\" + wall \"-\"（无合法时序对）", async () => {
      writeRun("repo-deep", "wf-nocalls", fixtureState({ calls: [], rounds: [] }));
      const { out } = await rflInProcess(["stats", "wf-nocalls", "repo-deep"]);
      expect(out).toContain("per-role: (no calls)");
      expect(out).toContain("wall -");
      // printStatsScores 空态
      expect(out).toContain("scores: (none)");
    });

    it("per-role 汇总 = input+cacheRead 合计（summarizeCalls byRole 口径）", async () => {
      writeRun("repo-deep", "wf-roles", fixtureState({
        calls: [
          { batch: 1, round: 1, role: "reviewer", name: "r", usage: { input: 1000, output: 10, cacheRead: 1000, cacheWrite: 0, cost: 0 } },
          { batch: 1, round: 2, role: "reviewer", name: "r", usage: { input: 1000, output: 10, cacheRead: 1000, cacheWrite: 0, cost: 0 } },
          { batch: 1, round: 1, role: "aggregator", name: "agg", usage: { input: 250, output: 10, cacheRead: 250, cacheWrite: 0, cost: 0 } },
        ],
      }));
      const { out } = await rflInProcess(["stats", "wf-roles", "repo-deep"]);
      expect(out).toContain("reviewer ×2 4k");
      expect(out).toContain("aggregator ×1 500");
    });

    it("issues 段：origins 聚合（regression/new/缺省 -）+ regressed-ever 计数", async () => {
      writeRun("repo-deep", "wf-origins", fixtureState({
        issues: {
          "MF-1": { status: "fixed", origin: "regression", history: [{ round: 1, status: "open" }, { round: 1, status: "fix-attempted" }, { round: 2, status: "regressed" }, { round: 2, status: "fix-attempted" }, { round: 3, status: "fixed" }] },
          "MF-2": { status: "fixed", origin: "new", history: [{ round: 1, status: "open" }, { round: 1, status: "fix-attempted" }, { round: 2, status: "fixed" }] },
          "MF-3": { status: "open", history: [{ round: 1, status: "open" }] }, // 无 origin → "-"
        },
      }));
      const { out } = await rflInProcess(["stats", "wf-origins", "repo-deep"]);
      expect(out).toContain("issues (last batch): total 3 → fixed 2  regressed-ever 1");
      expect(out).toContain("origins regression 1/new 1/- 1");
      expect(out).toContain("dormant (last batch) 0");
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
      const { out } = await rflInProcess(["stats", "wf-timeline", "repo-deep"]);
      expect(out).toContain("R1 (batch 1): review - │ aggregate 1ms │ fix -  mustFix -");
      expect(out).toContain("R2 (batch 1): review 2s │ aggregate 1s │ fix 58s  mustFix 3");
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
      const { out, lines } = await rflInProcess(["list", "repo-win"]);
      const runLines = lines.filter((l) => l.startsWith("wf-"));
      expect(runLines.map((l) => /^wf-\S+/.exec(l)?.[0])).toEqual(["wf-z", "wf-m", "wf-a"]);
      expect(out).toMatch(/wf-a[^\n]*calls: 2/);
      expect(out).toMatch(/wf-m[^\n]*calls: 1/);
      // 无 calls 键的旧 state：不显示 calls 段（而非 calls: 0）
      expect(out).toMatch(/wf-z[^\n]*rounds: 1\s*$/m);
    });

    it("stats latest 取时间序末位（最新 run），非字母序", async () => {
      writeRun("repo-win", "wf-a", fixtureState({ startedAt: "2026-08-18T10:00:00.000Z" }));
      writeRun("repo-win", "wf-z", fixtureState({ startedAt: "2026-08-20T10:00:00.000Z", terminated: "converged" }));
      const { out } = await rflInProcess(["stats", "latest", "repo-win"]);
      expect(out).toContain("wf-z");
      expect(out).toContain("converged");
      expect(out).not.toContain("terminated: clean"); // wf-a（clean）不是 latest
    });

    it("损坏 state.json（半写入）被 listRuns 跳过不崩；startedAt 缺失显示 ?", async () => {
      writeRun("repo-win", "wf-corrupt", '{"meta": {"runId": "x", "startedAt": "2026-08'); // 半写入截断 JSON
      const bare = fixtureState({ terminated: "stuck" });
      delete (bare.meta as Record<string, unknown>).startedAt;
      writeRun("repo-win", "wf-bare", bare);
      const { out } = await rflInProcess(["list", "repo-win"]);
      expect(out).not.toContain("wf-corrupt");
      expect(out).toContain("wf-bare");
      expect(out).toMatch(/wf-bare\s+\?\s+stuck/);
      // trends 同样跳过损坏 run
      const trends = await rflInProcess(["trends", "repo-win"]);
      expect(trends.out).not.toContain("wf-corrupt");
      expect(trends.out).toContain("wf-bare");
    });

    it("trends tokens 列 = input+cacheRead+output 合计（run 级口径）", async () => {
      writeRun("repo-win", "wf-tok", fixtureState({
        calls: [{ batch: 1, round: 1, role: "reviewer", name: "r", usage: { input: 4_000, output: 1_000, cacheRead: 5_000, cacheWrite: 0, cost: 0 } }],
      }));
      const { out } = await rflInProcess(["trends", "repo-win"]);
      // 4_000 + 5_000 + 1_000 = 10_000 → "10k"；cachePct = 5000/9000 = 56%
      expect(out).toMatch(/wf-tok[^\n]*\s10k\s+56%/);
    });
  });

  describe("rfl clean 边界", () => {
    it("非法 --older-than 规格 → exit 1 + invalid 提示", async () => {
      const { out, exitCodes } = await rflInProcess(["clean", "--older-than", "30x"]);
      expect(exitCodes[0]).toBe(1);
      expect(out).toContain("invalid --older-than");
      expect(out).toContain("expect <N>d or <N>h");
    });

    it("h 规格：2h 前过期、30m 前保留（cmdClean expired 判定）", async () => {
      const now = Date.now();
      writeRun("repo-cl", "wf-2h-ago", fixtureState({ startedAt: new Date(now - 2 * 3_600_000).toISOString() }));
      writeRun("repo-cl", "wf-30m-ago", fixtureState({ startedAt: new Date(now - 30 * 60_000).toISOString() }));
      const { out } = await rflInProcess(["clean", "--older-than", "1h"]);
      expect(out).toContain("would delete");
      expect(out).toContain("wf-2h-ago");
      expect(out).not.toContain("wf-30m-ago");
    });

    it("startedAt 不可解析 → 回退 state.json mtime 判定（utimes 置旧）", async () => {
      const dir = writeRun("repo-cl", "wf-badtime", fixtureState({ startedAt: "not-a-date" }));
      // mtime 置为 40 天前（startedAt 无效 → basis 回退 mtime → 过期）
      const old = new Date(Date.now() - 40 * 86_400_000);
      utimesSync(join(dir, "state.json"), old, old);
      const { out } = await rflInProcess(["clean", "--older-than", "30d"]);
      expect(out).toContain("wf-badtime");
    });

    it("无过期 run → \"nothing older than\"", async () => {
      writeRun("repo-cl", "wf-fresh", fixtureState({ startedAt: new Date().toISOString() }));
      const { out } = await rflInProcess(["clean", "--older-than", "30d"]);
      expect(out).toContain("nothing older than 30d");
    });
  });

  describe("rfl import-execute（静态依赖边 + main 即时执行）", () => {
    it("rfl.mjs 可作为 ES module 加载：main 在 import 时执行 list（exit 拦截 + console 捕获）", async () => {
      writeRun("repo-imp", "wf-import-1", fixtureState({ startedAt: "2026-08-19T10:00:00.000Z" }));
      const { out, exitCodes } = await rflInProcess(["list", "repo-imp"]);
      expect(exitCodes[0]).toBe(0);
      expect(out).toContain("wf-import-1");
      expect(out).toContain("rounds: 1");
    });
  });
});
