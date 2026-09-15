// worktree-reconcile-aging.test.ts —— 对账「歧义跳过」老化升级（PS-12 措施⑤）。
//
// 环境模式对齐 worktree-reconcile.integration.test.ts：真实 git repo + TMPDIR
// 重定向到测试私有目录（物理面扫描根 os.tmpdir()/pi-subagents 跟随 TMPDIR）；
// 本文件额外 mock core logger 以断言升级 warn（消息含磁盘路径与人工清理指引）。
//
// 语义锁定：
// - 阈值前（连续 N-1 周期内）：保持既有低信息聚合 warn，无升级、不清理（宁延迟勿误删）；
// - 第 N 周期：升级 warn——消息含 checkout 磁盘路径 + git worktree list 查看、
//   worktree remove --force / branch -D 手动清理、无主残留 rm -rf 指引；
//   结构化字段带 branch/checkout/repo/skippedCycles；升级是提醒不是动作（资源不动）；
// - 重置语义：路径「出现对应」（自愈补写）后计数清零，重现歧义需重新连续 N 周期。

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { encodeCwd } from "../assembly/path-encoding.ts";
import { WorktreeRegistry } from "../worktree/worktree-registry.ts";
import { RECONCILE_SKIP_ESCALATION_CYCLES, WorktreeManager } from "../worktree/worktree-manager.ts";

/** 原始 TMPDIR（beforeEach 重定向、afterEach 还原）。 */
const ORIG_TMPDIR = os.tmpdir();

/** git 辅助：repo 内执行（输出 trim）。 */
function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

/** 升级 warn 调用（按消息锚文本过滤）。 */
function escalationCalls(): Array<{ msg: string; data: Record<string, unknown> }> {
  return loggerMock.warn.mock.calls
    .filter((c) => typeof c[0] === "string" && c[0].includes("manual cleanup may be needed"))
    .map((c) => ({ msg: c[0] as string, data: (c[1] ?? {}) as Record<string, unknown> }));
}

describe("WorktreeManager 对账歧义跳过老化（PS-12 措施⑤）", { timeout: 30_000 }, () => {
  let outerDir: string;
  let agentDir: string;
  let repo: string;
  let enc: string;
  let registry: WorktreeRegistry;
  let mgr: WorktreeManager;

  beforeEach(() => {
    outerDir = fs.mkdtempSync(path.join(ORIG_TMPDIR, "wt-reconcile-aging-"));
    process.env.TMPDIR = outerDir;

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
    fs.rmSync(outerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 建一个物理 worktree（绕过 WorktreeManager.create 的脏树校验，路径布局同 create）。 */
  function makePhysicalWorktree(branch: string): string {
    const checkout = path.join(outerDir, "pi-subagents", enc, branch);
    git(repo, "worktree", "add", "-q", "-b", branch, checkout, "HEAD");
    return checkout;
  }

  /** 在 <agentDir>/subagents/<enc>/sessions/ 下写一个 .alive marker。 */
  function writeAliveMarker(sessionId: string, pid: number): void {
    const sessions = path.join(agentDir, "subagents", enc, "sessions");
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
});
