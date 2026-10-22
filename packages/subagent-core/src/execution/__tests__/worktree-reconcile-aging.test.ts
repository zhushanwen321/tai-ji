// src/execution/__tests__/worktree-reconcile-aging.test.ts
//
// 对账「歧义跳过」老化升级（PS-12 措施⑤）。
//
// 两种形态道（判据三档：只测逻辑、高负载极快）：
//   1. 默认组道（本文件上半）：in-process fixture——git 经 execFile 桩脚本化响应、
//      pid 探活经 alive-store 桩注入，物理侧 checkout 目录 / .alive marker 走真实
//      tmpdir 小文件。老化计数 + 升级 warn 的判定逻辑全部同步可断言，无真进程、
//      无真 git、无 spawn sleep。
//   2. CI-only 轨道（本文件下半，TAIJI_TEST_INTEGRATION=1 才跑）：真实 git repo +
//      真实 sleep 子进程（真 pid 探活），端到端验证 fixture 化判定在真进程上成立。
//
// 语义锁定：
// - 阈值前（连续 N-1 周期内）：保持既有低信息聚合 warn，无升级、不清理（宁延迟勿误删）；
// - 第 N 周期：升级 warn——消息含 checkout 磁盘路径 + git worktree list 查看、
//   worktree remove --force / branch -D 手动清理、无主残留 rm -rf 指引；
//   结构化字段带 branch/checkout/repo/skippedCycles；升级是提醒不是动作（资源不动）；
// - 重置语义：路径「出现对应」（自愈补写）后计数清零，重现歧义需重新连续 N 周期。
//
// 环境模式（CI-only 轨道）：真实 git repo + TMPDIR 重定向到测试私有目录（磁盘侧扫描根
// os.tmpdir()/pi-subagents 跟随 TMPDIR）；本文件 mock core logger 以断言升级 warn
// （消息含磁盘路径与人工清理指引）。

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INTEGRATION_TESTS_ENABLED,
  INTEGRATION_TESTS_SKIP_REASON,
} from "../../../../../test-guard/integration-gate.ts";
import { encodeCwd, getSessionSubagentSessionsDir } from "@taiji/shared/paths";
import { WorktreeRegistry } from "../worktree/worktree-registry.ts";
import { RECONCILE_SKIP_ESCALATION_CYCLES, WorktreeManager } from "../worktree/worktree-manager.ts";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

/** 原始 TMPDIR（beforeEach 重定向、afterEach 还原）。 */
const ORIG_TMPDIR = os.tmpdir();

/**
 * in-process fixture 开关（默认组道的 git / pid 探活桩）。
 *
 * git = true 时 execFile 走 gitScript（脚本化 git，记录全部命令）；alive = true 时
 * isProcessAlive 按 alivePids 集合判定。CI-only 真实 git 轨道两个开关都置 false，
 * 交还真实实现（execFile 真起 git 子进程 / process.kill 真探活）。
 */
const fakeIo = vi.hoisted(() => ({
  git: false,
  gitScript: null as null | ((args: string[], cwd: string) => string | Error),
  alive: false,
  alivePids: new Set<number>(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFileStub = ((
    file: string,
    args: readonly string[],
    options: unknown,
    // execFile 的 err.code 运行时是数字（GitRunError 据此取 exitCode），NodeJS.ErrnoException
    // 的 code 类型是 string——本桩自定回调签名，外层一次性转成真实 execFile 重载签名。
    callback: (err: (Error & { code?: number }) | null, stdout: string, stderr: string) => void,
  ): void => {
    if (!fakeIo.git) {
      (actual.execFile as unknown as (...a: unknown[]) => void)(file, args, options, callback);
      return;
    }
    const script = fakeIo.gitScript;
    const result = script === null ? "" : script([...args], (options as { cwd: string }).cwd);
    if (result instanceof Error) {
      callback(Object.assign(result, { code: 128 }), "", result.message);
      return;
    }
    callback(null, result, "");
  }) as unknown as typeof actual.execFile;
  return { ...actual, execFile: execFileStub };
});

vi.mock("../persistence/alive-store.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../persistence/alive-store.ts")>();
  return {
    ...actual,
    isProcessAlive: (pid: number): boolean =>
      fakeIo.alive ? fakeIo.alivePids.has(pid) : actual.isProcessAlive(pid),
  };
});

/** git 辅助：repo 内执行（输出 trim）。CI-only 真实 git 轨道专用。 */
function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

/** 脚本化 git 的磁盘状态（分支全集 + branch↔checkout 反查 + 命令流水）。 */
interface FakeGitState {
  readonly branches: Map<string, Set<string>>;
  readonly checkoutByBranch: Map<string, string>;
  readonly calls: string[];
}

/** 建一个空 fake git 状态。 */
function createFakeGit(): FakeGitState {
  return { branches: new Map(), checkoutByBranch: new Map(), calls: [] };
}

/** 把 script 挂到当前 fake git 状态。 */
function useFakeGit(state: FakeGitState): void {
  fakeIo.git = true;
  fakeIo.gitScript = (args, cwd) => {
    state.calls.push(args.join(" "));
    if (args[0] === "branch" && args[1] === "--list") {
      return [...(state.branches.get(cwd) ?? [])].join("\n");
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      const target = args[3];
      for (const [branch, checkout] of state.checkoutByBranch) {
        if (checkout === target) {
          state.branches.get(cwd)?.delete(branch);
          state.checkoutByBranch.delete(branch);
        }
      }
      return "";
    }
    if (args[0] === "worktree" && args[1] === "prune") return "";
    if (args[0] === "branch" && args[1] === "-D") {
      state.branches.get(cwd)?.delete(args[2] ?? "");
      return "";
    }
    return "";
  };
}

/** 升级 warn 调用（按消息锚文本过滤）。 */
function escalationCalls(): Array<{ msg: string; data: Record<string, unknown> }> {
  return loggerMock.warn.mock.calls
    .filter((c) => typeof c[0] === "string" && c[0].includes("manual cleanup may be needed"))
    .map((c) => ({ msg: c[0] as string, data: (c[1] ?? {}) as Record<string, unknown> }));
}

// ============================================================
// 默认组道：in-process fixture（无真 git、无 spawn sleep）
// ============================================================

describe("WorktreeManager 对账歧义跳过老化（PS-12 措施⑤，in-process fixture）", () => {
  let outerDir: string;
  let agentDir: string;
  let repo: string;
  let enc: string;
  let registry: WorktreeRegistry;
  let mgr: WorktreeManager;
  let fakeGit: FakeGitState;

  beforeEach(() => {
    outerDir = fs.mkdtempSync(path.join(ORIG_TMPDIR, "wt-reconcile-aging-"));
    process.env.TMPDIR = outerDir;
    // [session-store-layout-inversion] 对账活信号根 = session 存储树
    // getSessionStoreDir()（env dataDir）——重定向进 outerDir 内（rmSync 外层一并清），
    // 构造 WorktreeManager 前置（reconciler 构造期解析 storeRoot）
    process.env.TAIJI_AGENT_DATA_DIR = path.join(outerDir, "engine-data");

    agentDir = path.join(outerDir, "agent");
    repo = path.join(outerDir, "repo");
    enc = encodeCwd(repo);

    fakeGit = createFakeGit();
    useFakeGit(fakeGit);
    fakeIo.alive = true;
    fakeIo.alivePids.clear();

    registry = new WorktreeRegistry(agentDir);
    mgr = new WorktreeManager(agentDir);
    loggerMock.warn.mockClear();
  });

  afterEach(() => {
    fakeIo.git = false;
    fakeIo.gitScript = null;
    fakeIo.alive = false;
    process.env.TMPDIR = ORIG_TMPDIR;
    delete process.env.TAIJI_AGENT_DATA_DIR;
    fs.rmSync(outerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 建一个物理 worktree：checkout 目录 + .git 指针文件（repo 推导源）+ fake git 分支登记。 */
  function makePhysicalWorktree(branch: string): string {
    const checkout = path.join(outerDir, "pi-subagents", enc, branch);
    fs.mkdirSync(checkout, { recursive: true });
    fs.writeFileSync(
      path.join(checkout, ".git"),
      `gitdir: ${path.join(repo, ".git", "worktrees", branch)}\n`,
      "utf-8",
    );
    fakeGit.branches.set(repo, (fakeGit.branches.get(repo) ?? new Set()).add(branch));
    fakeGit.checkoutByBranch.set(branch, checkout);
    return checkout;
  }

  /** 在 <storeRoot>/<sid>/subagents/sessions/ 下写一个 .alive marker
   *  （[session-store-layout-inversion] 活信号随 subagent 文族落 session 存储树），
   *  并把 pid 注册进探活桩的活集合。 */
  function writeAliveMarker(sessionId: string, pid: number): void {
    const sessions = getSessionSubagentSessionsDir(sessionId);
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, `${sessionId}.jsonl.alive`),
      JSON.stringify({ pid, id: sessionId, startedAt: Date.now() }),
      "utf-8",
    );
    fakeIo.alivePids.add(pid);
  }

  it("阈值前保持普通 warn，第 N 周期升级含磁盘路径与清理指引（资源不动）", async () => {
    const c1 = makePhysicalWorktree("pi-sub-a1");
    const c2 = makePhysicalWorktree("pi-sub-a2");
    writeAliveMarker("s-a1", 1001);
    writeAliveMarker("s-a2", 1002);

    // 阈值前（N-1 周期）：无升级消息，资源原样（宁延迟勿误删语义不变）
    for (let i = 0; i < RECONCILE_SKIP_ESCALATION_CYCLES - 1; i++) {
      await mgr.scan();
    }
    expect(escalationCalls()).toEqual([]);
    expect(fs.existsSync(c1)).toBe(true);
    expect(fs.existsSync(c2)).toBe(true);

    // 第 N 周期：升级 warn——每个残留路径一条，含路径与人工清理指引
    await mgr.scan();
    const calls = escalationCalls();
    expect(calls.length).toBe(2); // c1 / c2 各一条
    for (const checkout of [c1, c2]) {
      const hit = calls.find((c) => c.msg.includes(checkout));
      expect(hit).toBeDefined();
      expect(hit?.msg).toContain("worktree list");
      expect(hit?.msg).toContain("worktree remove --force");
      expect(hit?.msg).toContain("branch -D");
      expect(hit?.msg).toContain("rm -rf");
      expect(hit?.msg).toContain(`skipped for ${RECONCILE_SKIP_ESCALATION_CYCLES} consecutive cycles`);
    }
    // 结构化字段：branch/checkout/skippedCycles 可机读。
    // （in-process 轨道的 repo 来自 .git 指针文件内容——本用例自己写的字面路径；
    //  真实 git 轨道下它是 git 解析产物，macOS 上为 realpath 形态 /private/var/...）
    const data1 = calls.find((c) => c.data.checkout === c1)?.data;
    expect(data1?.branch).toBe("pi-sub-a1");
    expect(data1?.repo).toBe(repo);
    expect(data1?.skippedCycles).toBe(RECONCILE_SKIP_ESCALATION_CYCLES);

    // 升级 warn 是提醒不是清理动作：物理资源与注册表未动
    expect(fs.existsSync(c1)).toBe(true);
    expect(fs.existsSync(c2)).toBe(true);
    expect(registry.load()).toEqual([]);
  });

  it("重置语义：自愈补写（出现对应）后计数清零，重现歧义需重新连续 N 周期", async () => {
    const c1 = makePhysicalWorktree("pi-sub-r1");
    const c2 = makePhysicalWorktree("pi-sub-r2");
    writeAliveMarker("s-r1", 1001);
    writeAliveMarker("s-r2", 1002);

    // 累计 N-1 周期歧义（未达阈值）
    for (let i = 0; i < RECONCILE_SKIP_ESCALATION_CYCLES - 1; i++) {
      await mgr.scan();
    }
    expect(escalationCalls()).toEqual([]);

    // 出现对应：s-r2 pid 死 + c2 删除 → 1 活 pid ↔ 1 残留 → 自愈补写 c1
    fakeIo.alivePids.delete(1002);
    fs.rmSync(c2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    await mgr.scan();
    expect(registry.load().map((e) => e.branch)).toEqual(["pi-sub-r1"]);
    expect(escalationCalls()).toEqual([]);

    // 重现歧义：c1 退出注册表 + 新残留 c3 + 新活 pid。
    // c1 的历史歧义计数已被自愈轮清零——若未清零（陈账 N-1），下面第 1 轮就达
    // 阈值升级；断言 N-1 轮内无升级即证明重置生效。
    await registry.remove("pi-sub-r1");
    const c3 = makePhysicalWorktree("pi-sub-r3");
    writeAliveMarker("s-r3", 1003);
    for (let i = 0; i < RECONCILE_SKIP_ESCALATION_CYCLES - 1; i++) {
      await mgr.scan();
    }
    expect(escalationCalls()).toEqual([]);

    // 第 N 轮：升级（新计数从 1 起步走满阈值）
    await mgr.scan();
    const msgs = escalationCalls().map((c) => c.msg);
    expect(msgs.some((m) => m.includes(c1))).toBe(true);
    expect(msgs.some((m) => m.includes(c3))).toBe(true);
  });
});

// ============================================================
// CI-only 轨道：真实 git repo + 真实 sleep 子进程（真 pid 探活）
// ============================================================

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `WorktreeManager 对账歧义跳过老化（PS-12 措施⑤，真实 git + 真进程）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
  () => {
    let outerDir: string;
    let agentDir: string;
    let repo: string;
    let enc: string;
    let registry: WorktreeRegistry;
    let mgr: WorktreeManager;

    beforeEach(() => {
      outerDir = fs.mkdtempSync(path.join(ORIG_TMPDIR, "wt-reconcile-aging-"));
      process.env.TMPDIR = outerDir;
      // [session-store-layout-inversion] 对账活信号根 = session 存储树
      // getSessionStoreDir()（env dataDir）——重定向进 outerDir 内（rmSync 外层一并清），
      // 构造 WorktreeManager 前置（reconciler 构造期解析 storeRoot）
      process.env.TAIJI_AGENT_DATA_DIR = path.join(outerDir, "engine-data");

      agentDir = path.join(outerDir, "agent");
      repo = path.join(outerDir, "repo");
      fs.mkdirSync(repo, { recursive: true });
      git(repo, "init", "-q");
      git(repo, "config", "user.email", "test@test.local");
      git(repo, "config", "user.name", "test");
      fs.writeFileSync(path.join(repo, "a.txt"), "init\n", "utf-8");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "init");

      enc = encodeCwd(repo);
      registry = new WorktreeRegistry(agentDir);
      mgr = new WorktreeManager(agentDir);
      loggerMock.warn.mockClear();
    });

    afterEach(() => {
      process.env.TMPDIR = ORIG_TMPDIR;
      delete process.env.TAIJI_AGENT_DATA_DIR;
      fs.rmSync(outerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    /** 建一个物理 worktree（绕过 WorktreeManager.create 的脏树校验，路径布局同 create）。 */
    function makePhysicalWorktree(branch: string): string {
      const checkout = path.join(outerDir, "pi-subagents", enc, branch);
      git(repo, "worktree", "add", "-q", "-b", branch, checkout, "HEAD");
      return checkout;
    }

    /** 在 <storeRoot>/<sid>/subagents/sessions/ 下写一个 .alive marker
     *  （[session-store-layout-inversion] 活信号随 subagent 文族落 session 存储树）。 */
    function writeAliveMarker(sessionId: string, pid: number): void {
      const sessions = getSessionSubagentSessionsDir(sessionId);
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(
        path.join(sessions, `${sessionId}.jsonl.alive`),
        JSON.stringify({ pid, id: sessionId, startedAt: Date.now() }),
        "utf-8",
      );
    }

    /** 真实子进程等待：等 pid 死透（isProcessAlive 翻 false，SIGKILL 后的短暂窗口）。 */
    async function waitPidDead(pid: number): Promise<void> {
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          return; // ESRCH = 已死
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    it("阈值前保持普通 warn，第 N 周期升级含磁盘路径与清理指引（资源不动）", async () => {
      const c1 = makePhysicalWorktree("pi-sub-a1");
      const c2 = makePhysicalWorktree("pi-sub-a2");
      const sleeper = spawn("sleep", ["60"]);
      try {
        expect(sleeper.pid).toBeTruthy();
        writeAliveMarker("s-a1", process.pid);
        writeAliveMarker("s-a2", sleeper.pid as number);

        // 阈值前（N-1 周期）：无升级消息，资源原样（宁延迟勿误删语义不变）
        for (let i = 0; i < RECONCILE_SKIP_ESCALATION_CYCLES - 1; i++) {
          await mgr.scan();
        }
        expect(escalationCalls()).toEqual([]);
        expect(fs.existsSync(c1)).toBe(true);
        expect(fs.existsSync(c2)).toBe(true);

        // 第 N 周期：升级 warn——每个残留路径一条，含路径与人工清理指引
        await mgr.scan();
        const calls = escalationCalls();
        expect(calls.length).toBe(2); // c1 / c2 各一条
        for (const checkout of [c1, c2]) {
          const hit = calls.find((c) => c.msg.includes(checkout));
          expect(hit).toBeDefined();
          expect(hit?.msg).toContain("worktree list");
          expect(hit?.msg).toContain("worktree remove --force");
          expect(hit?.msg).toContain("branch -D");
          expect(hit?.msg).toContain("rm -rf");
          expect(hit?.msg).toContain(`skipped for ${RECONCILE_SKIP_ESCALATION_CYCLES} consecutive cycles`);
        }
        // 结构化字段：branch/checkout/skippedCycles 可机读
        // （repo 是 git .git 指针解析产物，macOS 上为 realpath 形态 /private/var/...）
        const data1 = calls.find((c) => c.data.checkout === c1)?.data;
        expect(data1?.branch).toBe("pi-sub-a1");
        expect(data1?.repo).toBe(fs.realpathSync(repo));
        expect(data1?.skippedCycles).toBe(RECONCILE_SKIP_ESCALATION_CYCLES);

        // 升级 warn 是提醒不是清理动作：物理资源与注册表未动
        expect(fs.existsSync(c1)).toBe(true);
        expect(fs.existsSync(c2)).toBe(true);
        expect(registry.load()).toEqual([]);
      } finally {
        sleeper.kill("SIGKILL");
      }
    });

    it("重置语义：自愈补写（出现对应）后计数清零，重现歧义需重新连续 N 周期", async () => {
      const c1 = makePhysicalWorktree("pi-sub-r1");
      const c2 = makePhysicalWorktree("pi-sub-r2");
      const sleeper = spawn("sleep", ["60"]);
      try {
        writeAliveMarker("s-r1", process.pid);
        writeAliveMarker("s-r2", sleeper.pid as number);

        // 累计 N-1 周期歧义（未达阈值）
        for (let i = 0; i < RECONCILE_SKIP_ESCALATION_CYCLES - 1; i++) {
          await mgr.scan();
        }
        expect(escalationCalls()).toEqual([]);
      } finally {
        sleeper.kill("SIGKILL");
      }

      // 出现对应：s-r2 pid 死 + c2 删除 → 1 活 pid ↔ 1 残留 → 自愈补写 c1
      await waitPidDead(sleeper.pid as number);
      fs.rmSync(c2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      await mgr.scan();
      expect(registry.load().map((e) => e.branch)).toEqual(["pi-sub-r1"]);
      expect(escalationCalls()).toEqual([]);

      // 重现歧义：c1 退出注册表 + 新残留 c3 + 新活 pid。
      // c1 的历史歧义计数已被自愈轮清零——若未清零（陈账 N-1），下面第 1 轮就达
      // 阈值升级；断言 N-1 轮内无升级即证明重置生效。
      await registry.remove("pi-sub-r1");
      const c3 = makePhysicalWorktree("pi-sub-r3");
      const sleeper2 = spawn("sleep", ["60"]);
      try {
        writeAliveMarker("s-r3", sleeper2.pid as number);
        for (let i = 0; i < RECONCILE_SKIP_ESCALATION_CYCLES - 1; i++) {
          await mgr.scan();
        }
        expect(escalationCalls()).toEqual([]);

        // 第 N 轮：升级（新计数从 1 起步走满阈值）
        await mgr.scan();
        const msgs = escalationCalls().map((c) => c.msg);
        expect(msgs.some((m) => m.includes(c1))).toBe(true);
        expect(msgs.some((m) => m.includes(c3))).toBe(true);
      } finally {
        sleeper2.kill("SIGKILL");
      }
    });
  },
);
