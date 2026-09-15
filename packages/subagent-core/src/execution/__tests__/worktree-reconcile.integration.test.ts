// src/__tests__/worktree-reconcile.integration.test.ts
//
// D5b 对账双向 diff 集成测试：真实 git repo + 真实 tmpdir（不 mock fs/execFile）。
//
// 隔离手段：TMPDIR env 重定向到测试私有目录——WorktreeManager 的物理面扫描
// 根 = os.tmpdir()/pi-subagents（跟随 TMPDIR），避免扫到本机其他进程的真实残留。
//
// 覆盖四个收敛方向（判据见 worktree-manager.ts reconcileWithPhysical）：
//   1. 物理有 + 注册无 + 无活 pid + 超 grace → 清分支与目录
//   2. 物理有 + 注册无 + 恰好 1 活 pid + 1 残留 → 补写回注册表（自愈）
//   3. 注册有（pid 活）+ 物理无 → 移除幻影条目
//   4. 多活 pid / 多残留（对应歧义）→ 跳过不动（宁延迟勿误删）

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeCwd } from "../assembly/path-encoding.ts";
import { WorktreeRegistry } from "../worktree/worktree-registry.ts";
import { WorktreeManager } from "../worktree/worktree-manager.ts";

/** 原始 TMPDIR（beforeEach 重定向、afterEach 还原）。 */
const ORIG_TMPDIR = os.tmpdir();

/** git 辅助：repo 内执行（输出 trim）。 */
function git(repo: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

// [HISTORICAL] 2026-08-20 PR #185：真实 git 子进程 + 注册表文件锁集成用例显式超时——
// 每用例多次 git init/worktree add/branch -D 真实子进程调用，整包满并行 + 系统余载下
// 超 vitest 默认 5s testTimeout（对齐本包 worktree-registry D5a / process-shutdown-hook 口径）。
describe("WorktreeManager.scan 物理面对账（D5b）", { timeout: 30_000 }, () => {
	let baseDir: string;
	let agentDir: string;
	let repo: string;
	let enc: string;
	let registry: WorktreeRegistry;
	let mgr: WorktreeManager;
	/** 真实系统 tmp 下的测试根（TMPDIR 重定向目标）。 */
	let outerDir: string;

	beforeEach(() => {
		outerDir = fs.mkdtempSync(path.join(ORIG_TMPDIR, "wt-reconcile-it-"));
		// 物理面扫描根重定向：os.tmpdir() 跟随 TMPDIR env（darwin/linux 均如此）
		process.env.TMPDIR = outerDir;
		baseDir = outerDir;

		agentDir = path.join(baseDir, "agent");
		repo = path.join(baseDir, "repo");
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
	});

	afterEach(() => {
		process.env.TMPDIR = ORIG_TMPDIR;
		fs.rmSync(outerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	/** 建一个物理 worktree（按 create() 的真实路径布局，绕过 WorktreeManager.create 的脏树校验）。 */
	function makePhysicalWorktree(branch: string): string {
		const checkout = path.join(baseDir, "pi-subagents", enc, branch);
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

	/** 把目录 mtime 设到 grace 之前（对账判据的 createdAt 近似）。 */
function ageBeyondGrace(dir: string): void {
		const past = new Date(Date.now() - 120_000);
		fs.utimesSync(dir, past, past);
	}

	it("物理有 + 注册无 + 无活 pid + 超 grace → 清分支与目录", async () => {
		const checkout = makePhysicalWorktree("pi-sub-t1");
		ageBeyondGrace(checkout);

		await mgr.scan();

		expect(fs.existsSync(checkout)).toBe(false);
		expect(git(repo, "branch", "--list", "pi-sub-*")).toBe("");
		expect(registry.load()).toEqual([]);
	});

	it("物理有 + 注册无 + 未超 grace（create 窗口）→ 跳过不删", async () => {
		const checkout = makePhysicalWorktree("pi-sub-t2");
		// mtime 保持「现在」——另一进程 worktree add 完成到 registry.add 落盘之间的窗口

		await mgr.scan();

		expect(fs.existsSync(checkout)).toBe(true);
		expect(git(repo, "branch", "--list", "pi-sub-t2")).not.toBe("");
	});

	it("物理有 + 注册无 + 恰好 1 活 pid + 1 残留 → 补写回注册表（自愈）", async () => {
		const checkout = makePhysicalWorktree("pi-sub-t3");
		// 活 pid 用本测试进程（isProcessAlive 真实调用必活）
		writeAliveMarker("s-t3", process.pid);

		await mgr.scan();

		const entries = registry.load();
		expect(entries).toHaveLength(1);
		expect(entries[0].branch).toBe("pi-sub-t3");
		expect(entries[0].pid).toBe(process.pid);
		expect(entries[0].checkout).toBe(checkout);
		// 物理资源未被删（自愈而非只删）
		expect(fs.existsSync(checkout)).toBe(true);
	});

	it("注册有（pid 活）+ 物理无 → 移除幻影条目", async () => {
		// pid 活（本进程）使阶段一孤儿清理跳过，隔离方向一的独立语义
		await registry.add({
			repo,
			branch: "pi-sub-ghost",
			checkout: path.join(baseDir, "pi-subagents", enc, "pi-sub-ghost"),
			pid: process.pid,
			createdAt: Date.now(),
		});

		await mgr.scan();

		expect(registry.load()).toEqual([]);
	});

	it("多残留 + 多活 pid（对应歧义）→ 跳过不动", async () => {
		const c1 = makePhysicalWorktree("pi-sub-m1");
		const c2 = makePhysicalWorktree("pi-sub-m2");
		ageBeyondGrace(c1);
		ageBeyondGrace(c2);
		// 第二个「活 pid」用真实 sleep 子进程（与 process.pid 不同值）
		const sleeper = spawn("sleep", ["60"]);
		try {
			expect(sleeper.pid).toBeTruthy();
			writeAliveMarker("s-m1", process.pid);
			writeAliveMarker("s-m2", sleeper.pid as number);

			await mgr.scan();

			// 歧义 → 本周期全部跳过（宁延迟勿误删），下周期活 pid 消失后收敛
			expect(fs.existsSync(c1)).toBe(true);
			expect(fs.existsSync(c2)).toBe(true);
			expect(registry.load()).toEqual([]);
		} finally {
			sleeper.kill("SIGKILL");
		}
	});

	it("幂等：连续两次 scan 结果一致（无重复动作）", async () => {
		const checkout = makePhysicalWorktree("pi-sub-idem");
		ageBeyondGrace(checkout);

		await mgr.scan();
		await mgr.scan();

		expect(fs.existsSync(checkout)).toBe(false);
		expect(git(repo, "branch", "--list", "pi-sub-*")).toBe("");
	});
});
