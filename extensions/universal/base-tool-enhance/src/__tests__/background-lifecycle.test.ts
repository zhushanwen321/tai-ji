// src/__tests__/background-lifecycle.test.ts —— background 核心生命周期集成：
// 真实 spawn 边沿收尾 / 轮询器自动收尾 / killing intent 双侧 / timeout / 并发上限 /
// 收殓 / D15 abort / bash_output / bash_kill（黑盒：经工具 execute 断言使用者可见行为）
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20000 });

// getAgentDir → 测试临时数据目录（工具 execute 内部调用，不写真 ~/.pi/agent）。
// hoisted 回调里不能引用顶层 import（初始化顺序），用可变引用在 import 完成后注入
const { dataDirRef } = vi.hoisted(() => ({ dataDirRef: { dir: "" } }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => dataDirRef.dir,
}));

// 进程原语（ext-simplify-13 后单点在 protocol 子出口）转发真实杀 + 记录调用
//（timeout 分支断言 killProcessTree 被调）
const { killTreeCalls } = vi.hoisted(() => ({ killTreeCalls: [] as number[] }));
vi.mock("@xyz-agent/extension-protocol/background-task", async (importOriginal) => {
	const orig = await importOriginal<
		typeof import("@xyz-agent/extension-protocol/background-task")
	>();
	return {
		...orig,
		killProcessTree: (pid: number, onFallback?: (step: string, err: unknown) => void): void => {
			killTreeCalls.push(pid);
			orig.killProcessTree(pid, onFallback);
		},
	};
});

import { isPidAlive } from "@xyz-agent/extension-protocol/background-task";

import { createBashKillToolDefinition } from "../bash-kill-tool.ts";
import { createBashOutputToolDefinition } from "../bash-output-tool.ts";
import { handleTaskExit, refreshPiReference, resetNotifyForTest } from "../background/notify.ts";
import { pollTickForTest, setOnTaskExit, stopPoller } from "../background/poller.ts";
import { getRegistryPath, readRegistry, taskToRegistryEntry, writeRegistryEntry } from "../background/registry.ts";
import type { RegistryEntry } from "../background/types.ts";
import { DEFAULT_MAX_CONCURRENT_BACKGROUND, spawnBackgroundTask } from "../background/spawn-background.ts";
import { clearTaskStoreForTest, getActiveTasks, getTask, markKillingIntent } from "../background/task-store.ts";
import { reapBackgroundTasksNow, resetProcessExitGuardForTest } from "../background/process-exit-guard.ts";

const DATA_DIR = mkdtempSync(join(tmpdir(), "bte-data-"));
dataDirRef.dir = DATA_DIR;

const SESSION_ID = "sess-lifecycle";
const REGISTRY_PATH = getRegistryPath(DATA_DIR, SESSION_ID);

function makeCtx(sessionId: string = SESSION_ID): { cwd: string; sessionManager: { getSessionId: () => string } } {
	return { cwd: process.cwd(), sessionManager: { getSessionId: () => sessionId } };
}

const bashOutput = createBashOutputToolDefinition();
const bashKill = createBashKillToolDefinition();

async function outputTool(args: { task_id?: string }, sessionId: string = SESSION_ID): Promise<string> {
	const result = await bashOutput.execute("call-1", args, undefined, undefined, makeCtx(sessionId) as never);
	return result.content[0]?.type === "text" ? result.content[0].text : "";
}

async function killTool(taskId: string, sessionId: string = SESSION_ID): Promise<string> {
	const result = await bashKill.execute("call-1", { task_id: taskId }, undefined, undefined, makeCtx(sessionId) as never);
	return result.content[0]?.type === "text" ? result.content[0].text : "";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 真实子进程链（spawn+exec+sleep+exit）满载下延迟不可预估，deadline 放宽到 10s；
 * timeout 路径 / 真实 poller 定时器路径单独放宽到 8s（任务语义内最慢的等待对象）。
 */
const POLL_DEADLINE_MS = 10_000;
const POLL_DEADLINE_SLOW_MS = 8_000;

/**
 * 轮询直到期望状态出现或超时：每次迭代先 pollTickForTest()（手动 tick 推进状态机）
 * 再检查——固定 sleep 后单次 tick 单次断言是满载 flake 源，等状态而非猜时刻。
 */
async function pollUntilTicked(check: () => boolean, deadlineMs: number, what: string): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		pollTickForTest();
		if (check()) return;
		if (Date.now() > deadline) {
			throw new Error(`timed out after ${deadlineMs}ms waiting for ${what}`);
		}
		await sleep(25);
	}
}

/** 同 pollUntilTicked 但不手动 tick：语义含「真实定时器/事件自行推进」的用例专用。 */
async function pollUntil(check: () => boolean, deadlineMs: number, what: string): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (!check()) {
		if (Date.now() > deadline) {
			throw new Error(`timed out after ${deadlineMs}ms waiting for ${what}`);
		}
		await sleep(25);
	}
}

function spawnBg(command: string, extra: { timeoutSec?: number; maxConcurrent?: number } = {}) {
	return spawnBackgroundTask({
		command,
		cwd: process.cwd(),
		dataDir: DATA_DIR,
		sessionId: SESSION_ID,
		...extra,
	});
}

/** 手写 registry 条目（模拟他进程/历史 session 写入的形状）。 */
function makeRegistryEntry(overrides: Partial<RegistryEntry> & { taskId: string }): RegistryEntry {
	return {
		pid: 424242,
		command: "echo foreign",
		outputFile: "/tmp/foreign.log",
		startedAt: 1,
		state: "running",
		ownerPiPid: 999999,
		sessionId: SESSION_ID,
		...overrides,
	};
}

beforeEach(() => {
	killTreeCalls.length = 0;
});

afterEach(() => {
	// 残留活跃任务先杀干净再清表（防句柄/进程泄漏影响后续测试）
	for (const task of getActiveTasks()) {
		try {
			process.kill(-task.pid, "SIGKILL");
		} catch {
			try {
				process.kill(task.pid, "SIGKILL");
			} catch {
				// already dead
			}
		}
	}
	clearTaskStoreForTest();
	stopPoller();
	setOnTaskExit(undefined);
	resetProcessExitGuardForTest();
	// pi 引用（currentPi）统一在 afterEach 复位——用例体内不清：断言先失败时泄漏的
	// currentPi 会被同文件后续用例的 emitPendingRegister 消费（发往死引用）
	resetNotifyForTest();
});

// 测试红线：临时目录自建自删（模块级 DATA_DIR 全文件共用，最后统一清）
// maxRetries 防 teardown 递归删除与在途异步写竞争的 ENOTEMPTY 满载 flake
afterAll(() => {
	rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("real spawn lifecycle (poll edge finalization)", () => {
	it("short task: running → exited with exitCode 0, output file readable, registry terminal", async () => {
		const spawned = spawnBg("sleep 0.3 && echo done");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		expect(task.state).toBe("running");
		expect(existsSync(task.outputFile)).toBe(true);
		// registry 登记即写 running 条目（含 ownerPiPid，M5 属主判定依据）
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.state).toBe("running");
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.ownerPiPid).toBe(process.pid);

		// 轮询等命令退出 + libuv reap（tick 收尾；满载下延迟不可预估）
		await pollUntilTicked(() => getTask(task.taskId)?.state === "exited", POLL_DEADLINE_MS, "task finalization");

		const finalized = getTask(task.taskId);
		expect(finalized?.state).toBe("exited");
		expect(finalized?.exitCode).toBe(0);
		expect(finalized?.reason).toBe("natural");
		expect(finalized?.durationMs).toBeGreaterThan(0);

		const registryEntry = readRegistry(REGISTRY_PATH).get(task.taskId);
		expect(registryEntry?.state).toBe("exited");
		expect(registryEntry?.reason).toBe("natural");

		const detail = JSON.parse(await outputTool({ task_id: task.taskId })) as { output: string; exitCode: number };
		expect(detail.output).toContain("done");
		expect(detail.exitCode).toBe(0);
	});

	it("poller interval auto-finalizes without manual tick (lazy start/stop)", async () => {
		const spawned = spawnBg("sleep 0.3 && echo auto");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		// 不手动 tick，等真实 2s 轮询边沿（命令 0.3s 已退出，首轮 tick 即收尾）：
		// 轮询等终态出现（真实定时器 + 满载下轮询边沿延迟不可预估）
		await pollUntil(() => getTask(task.taskId)?.state === "exited", POLL_DEADLINE_SLOW_MS, "poller auto-finalization");
		expect(getTask(task.taskId)?.state).toBe("exited");
		// 无活跃条目后轮询器自停（防空转）
		expect(getActiveTasks()).toHaveLength(0);
	});

	it("nonzero exit code is surfaced (exitCode 1)", async () => {
		const spawned = spawnBg("sleep 0.2; exit 3");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		await pollUntilTicked(() => getTask(task.taskId)?.exitCode === 3, POLL_DEADLINE_MS, "exitCode to surface");
		expect(getTask(task.taskId)?.exitCode).toBe(3);
		const registryEntry = readRegistry(REGISTRY_PATH).get(task.taskId);
		expect(registryEntry?.exitCode).toBe(3);
	});

	it("onTaskExit callback (M3 hook point) fires with the finalized task", async () => {
		const seen: string[] = [];
		setOnTaskExit((task) => seen.push(`${task.taskId}:${task.state}:${task.reason}`));
		const spawned = spawnBg("true");
		if (!spawned.ok) throw new Error(spawned.error);
		await pollUntilTicked(() => seen.length === 1, POLL_DEADLINE_MS, "onTaskExit callback to fire");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toBe(`${spawned.task.taskId}:exited:natural`);
	});

	it("spawned entry carries pidStartTime for kill-side precise comparison (M5→M3)", async () => {
		const spawned = spawnBg("sleep 30");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		// 单例表与 registry 两侧均含字段（epoch 秒；ps 可用平台读取成功）
		expect(typeof task.pidStartTime).toBe("number");
		const registryEntry = readRegistry(REGISTRY_PATH).get(task.taskId) as
			| { pidStartTime?: number }
			| undefined;
		expect(registryEntry?.pidStartTime).toBe(task.pidStartTime);
	});
});

describe("bash_output tool", () => {
	it("list merges store + registry terminal entries, store wins on same id", async () => {
		// 单例表：一个 running 真任务
		const spawned = spawnBg("sleep 5");
		if (!spawned.ok) throw new Error(spawned.error);
		// registry 手写：另一个终态历史条目（不在单例表——模拟已被 LRU 淘汰后回落）
		writeRegistryEntry(REGISTRY_PATH, {
			taskId: "bt-9000-hist",
			pid: 1,
			command: "x".repeat(100),
			outputFile: "/tmp/gone.log",
			startedAt: 1,
			state: "exited",
			ownerPiPid: 1,
			sessionId: SESSION_ID,
			exitCode: 0,
			reason: "natural",
			endedAt: 2,
			durationMs: 1,
		});
		// registry 手写：与单例表同 id 的过期 exited 版本（须被单例表 running 覆盖）
		writeRegistryEntry(
			REGISTRY_PATH,
			taskToRegistryEntry({ ...spawned.task, state: "exited" as const, ownerPiPid: 1 }),
		);

		const listed = JSON.parse(await outputTool({})) as {
			tasks: Array<{ task_id: string; state: string; command: string }>;
		};
		const byId = new Map(listed.tasks.map((t) => [t.task_id, t]));
		expect(byId.get(spawned.task.taskId)?.state).toBe("running"); // 单例表优先
		expect(byId.get("bt-9000-hist")?.state).toBe("exited");
		// 命令展示截断（前 80 字符）
		expect(byId.get("bt-9000-hist")?.command.length).toBeLessThanOrEqual(81);
	});

	it("unknown task_id throws with list hint", async () => {
		await expect(outputTool({ task_id: "bt-none" })).rejects.toThrow(/No such task/);
	});

	it("P0-1: list merges only TERMINAL registry entries — running entries stay invisible (§3.5)", async () => {
		// 独立 session 目录：单例表空 + registry 含 running 与 exited 两条他进程条目
		// （模拟 resume 被强杀 session：runtime 收殓转终态前的窗口里 registry 残留 running）
		const sid = "sess-p0-list";
		writeRegistryEntry(getRegistryPath(DATA_DIR, sid), makeRegistryEntry({ taskId: "bt-xrun", state: "running" }));
		writeRegistryEntry(
			getRegistryPath(DATA_DIR, sid),
			makeRegistryEntry({ taskId: "bt-xdone", state: "exited", exitCode: 0, reason: "natural", endedAt: 2, durationMs: 1 }),
		);

		const listed = JSON.parse(await outputTool({}, sid)) as { tasks: Array<{ task_id: string; state: string }> };
		const ids = listed.tasks.map((t) => t.task_id);
		expect(ids).toContain("bt-xdone"); // 终态条目并入（查历史）
		expect(ids).not.toContain("bt-xrun"); // running 条目不并入——无幻影 running 行
	});

	it("P0-1: detail registry fallback is terminal-only — cross-process running entry not queryable (§3.5)", async () => {
		const sid = "sess-p0-detail";
		const path = getRegistryPath(DATA_DIR, sid);
		writeRegistryEntry(path, makeRegistryEntry({ taskId: "bt-xrun2", state: "running" }));
		writeRegistryEntry(path, makeRegistryEntry({ taskId: "bt-xdone2", state: "exited", exitCode: 3 }));

		// running 条目不可查（等价于本进程不存在该任务）
		await expect(outputTool({ task_id: "bt-xrun2" }, sid)).rejects.toThrow(/No such task/);
		// 终态条目可查（历史回落）
		const detail = JSON.parse(await outputTool({ task_id: "bt-xdone2" }, sid)) as { state: string; exitCode: number };
		expect(detail.state).toBe("exited");
		expect(detail.exitCode).toBe(3);
	});

	it("deleted output file degrades to <lost> without crashing (§3.6)", async () => {
		const spawned = spawnBg("sleep 0.2 && echo gone");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		await pollUntilTicked(() => getTask(task.taskId)?.state === "exited", POLL_DEADLINE_MS, "task finalization");
		unlinkSync(task.outputFile);
		const detail = JSON.parse(await outputTool({ task_id: task.taskId })) as {
			output: string;
			state: string;
		};
		expect(detail.output).toBe("<lost>");
		expect(detail.state).toBe("exited");
	});

	it("output tail respects line cap", async () => {
		// 2100 行输出 → tail 只保留最后 2000 行
		const spawned = spawnBg("for i in $(seq 1 2100); do echo line$i; done");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		// 轮询等 2100 行输出跑完退出收尾（满载下 shell 循环耗时不可预估）
		await pollUntilTicked(() => getTask(task.taskId)?.state === "exited", POLL_DEADLINE_MS, "output loop to finish");
		const detail = JSON.parse(await outputTool({ task_id: task.taskId })) as {
			output: string;
			truncated: boolean;
		};
		const lines = detail.output.split("\n");
		expect(lines.length).toBeLessThanOrEqual(2000);
		expect(detail.truncated).toBe(true);
		expect(detail.output).toContain("line2100");
		expect(detail.output).not.toContain("line50\n");
	});
});

describe("bash_kill tool (killing intent, single-point finalization)", () => {
	it("kill marks BOTH store and registry as killing before the poll edge lands", async () => {
		const spawned = spawnBg("sleep 60");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;

		const killResult = JSON.parse(await killTool(task.taskId)) as { killed: boolean; reason: string };
		expect(killResult.killed).toBe(true);

		// 轮询未收尾（sleep 60 才死、kill 后立即断言）：两侧 killing 即可见，无倒挂
		expect(getTask(task.taskId)?.state).toBe("killing");
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.state).toBe("killing");
		// kill-tree 确实对该 pid 发过令
		expect(killTreeCalls).toContain(task.pid);
	});

	it("kill edge: intent consumed → exited with reason killed", async () => {
		const spawned = spawnBg("sleep 60");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		await killTool(task.taskId);
		// 轮询到 kill 边沿收尾（SIGKILL 生效 + tick 终态化）
		await pollUntilTicked(() => getTask(task.taskId)?.reason === "killed", POLL_DEADLINE_MS, "killed finalization");
		const finalized = getTask(task.taskId);
		expect(finalized?.state).toBe("exited");
		expect(finalized?.reason).toBe("killed");
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.reason).toBe("killed");
	});

	it("no such task → killed:false with hint", async () => {
		const result = JSON.parse(await killTool("bt-ghost")) as {
			killed: boolean;
			reason: string;
			hint: string;
		};
		expect(result.killed).toBe(false);
		expect(result.reason).toBe("no such task");
		expect(result.hint).toContain("bash_output");
	});

	it("already exited task → killed:false with exit code", async () => {
		const spawned = spawnBg("sleep 0.2");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		await pollUntilTicked(() => getTask(task.taskId)?.state === "exited", POLL_DEADLINE_MS, "task finalization");
		const result = JSON.parse(await killTool(task.taskId)) as { killed: boolean; reason: string };
		expect(result.killed).toBe(false);
		expect(result.reason).toBe("already exited (code 0)");
	});

	it("P0-2.1: registry-only running entry (other pi process) → cross-process rejection, no kill signal", async () => {
		// 独立 session 目录：registry-only running 条目 = 他进程任务（本进程活跃任务必在单例表）
		const sid = "sess-p0-kill";
		const foreignPid = process.pid; // 活进程 pid——若误走 kill 会误杀测试进程自身，同时断言不发生
		writeRegistryEntry(
			getRegistryPath(DATA_DIR, sid),
			makeRegistryEntry({ taskId: "bt-foreign-run", state: "running", pid: foreignPid, sessionId: sid }),
		);

		const result = JSON.parse(await killTool("bt-foreign-run", sid)) as {
			killed: boolean;
			reason: string;
			hint?: string;
		};
		expect(result.killed).toBe(false);
		expect(result.reason).toBe("cross-process running task owned by another pi process");
		// 收殓已下沉 runtime（u-bte-remove）：hint 指向 runtime 收殓而非 reaper
		expect(result.hint).toContain("xyz-agent runtime");
		expect(killTreeCalls).not.toContain(foreignPid); // 未发 kill 信号
	});

	it("P0-2.1: registry terminal entry → already exited（回落限定终态，终态不可 kill）", async () => {
		const sid = "sess-p0-kill";
		writeRegistryEntry(
			getRegistryPath(DATA_DIR, sid),
			makeRegistryEntry({
				taskId: "bt-foreign-done",
				state: "orphaned",
				sessionId: sid,
				endedAt: 2,
				durationMs: 1,
			}),
		);
		const result = JSON.parse(await killTool("bt-foreign-done", sid)) as { killed: boolean; reason: string };
		expect(result.killed).toBe(false);
		expect(result.reason).toBe("already exited");
	});

	it("P0-2.2: store entry whose pid already died (poll edge not landed) → already exited style, no kill/intent", async () => {
		const spawned = spawnBg("sleep 0.2");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		// 轮询进程死透（不 tick——单例表仍 running 是本用例前提）
		await pollUntil(() => !isPidAlive(task.pid), 5000, "process to die without poll edge");
		expect(getTask(task.taskId)?.state).toBe("running");

		const result = JSON.parse(await killTool(task.taskId)) as { killed: boolean; reason: string };
		expect(result.killed).toBe(false);
		expect(result.reason).toContain("already exited");
		expect(killTreeCalls).not.toContain(task.pid); // 死 pid 不发 kill
		expect(getTask(task.taskId)?.state).toBe("running"); // 未标 killing intent（终态归轮询边沿）
	});

	it("P0-2.2: pidStartTime mismatch (pid reuse suspected) → refuse kill", async () => {
		const spawned = spawnBg("sleep 30");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		// 构造不匹配的登记值（真实进程 start time 之外的时间）——pid 活但身份不符
		task.pidStartTime = (task.pidStartTime ?? 0) + 500;

		const result = JSON.parse(await killTool(task.taskId)) as { killed: boolean; reason: string; hint?: string };
		expect(result.killed).toBe(false);
		expect(result.reason).toContain("pid reuse suspected");
		expect(result.hint).toContain("manually");
		expect(killTreeCalls).not.toContain(task.pid); // 宁不杀勿误杀
		expect(getTask(task.taskId)?.state).toBe("running"); // 未标 intent
	});

	it("P0-2.2: matching pidStartTime → kill proceeds（start time 校验不误拦正常 kill）", async () => {
		const spawned = spawnBg("sleep 30");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		// spawn 时读到的真实 start time 原样保留 → 校验通过，正常 kill 路径
		const result = JSON.parse(await killTool(task.taskId)) as { killed: boolean };
		expect(result.killed).toBe(true);
		expect(killTreeCalls).toContain(task.pid);
	});
});

describe("concurrency cap (D10, default 8)", () => {
	it("rejects the 9th task with the oldest task id in the error", async () => {
		const tasks: string[] = [];
		for (let i = 0; i < DEFAULT_MAX_CONCURRENT_BACKGROUND; i++) {
			const spawned = spawnBg("sleep 30");
			if (!spawned.ok) throw new Error(spawned.error);
			tasks.push(spawned.task.taskId);
			await sleep(20); // 错开 startedAt 保证「最老」判定稳定
		}
		const ninth = spawnBg("echo should-fail");
		expect(ninth.ok).toBe(false);
		if (!ninth.ok) {
			expect(ninth.error).toContain(`max ${DEFAULT_MAX_CONCURRENT_BACKGROUND} concurrent`);
			expect(ninth.error).toContain(tasks[0]); // 最老 task_id
			expect(ninth.error).toContain("bash_kill");
		}
	});

	it("P0-3: maxConcurrent=0 with zero active tasks is rejected (no silent pass, limit stays effective)", () => {
		// 0 活跃 >= 0 上限 → oldestActiveTask() undefined——原实现静默放行，上限失效
		const result = spawnBg("echo should-fail", { maxConcurrent: 0 });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("concurrency limit configuration invalid");
			expect(result.error).toContain("maxConcurrent=0");
			expect(result.error).toContain("maxConcurrentBackground");
		}
	});
});

describe("explicit background timeout (D6)", () => {
	it("fires kill-tree at the deadline and finalizes with reason timeout", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let taskId = "";
		let pid = -1;
		try {
			// fake 生效后 spawn：timeout 定时器进 fake 队列，由 advanceTimers 推进
			const spawned = spawnBg("sleep 30", { timeoutSec: 1 });
			if (!spawned.ok) throw new Error(spawned.error);
			taskId = spawned.task.taskId;
			pid = spawned.task.pid;

			vi.advanceTimersByTime(1000);
			// 到点：kill-tree 已发令 + 两侧 killing intent（reason 候选 timeout）
			expect(killTreeCalls).toContain(pid);
			expect(getTask(taskId)?.state).toBe("killing");
			expect(getTask(taskId)?.intent?.reason).toBe("timeout");
			expect(readRegistry(REGISTRY_PATH).get(taskId)?.state).toBe("killing");
		} finally {
			vi.useRealTimers();
		}

		// SIGKILL 已真实发出：轮询边沿收尾 → exited(reason:"timeout")，终态由边沿写
		//（timeout 路径满载下 SIGKILL 生效延迟不可预估，deadline 放宽到 8s）
		await pollUntilTicked(
			() => getTask(taskId)?.state === "exited" && getTask(taskId)?.reason === "timeout",
			POLL_DEADLINE_SLOW_MS,
			"timeout finalization",
		);
		const finalized = getTask(taskId);
		expect(finalized?.state).toBe("exited");
		expect(finalized?.reason).toBe("timeout");
	});

	it("P0-4/D6-en R2-S1: pid reuse suspected at the deadline → skip kill AND skip intent mark", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const spawned = spawnBg("sleep 30", { timeoutSec: 1 });
			if (!spawned.ok) throw new Error(spawned.error);
			const { task } = spawned;
			// 构造不匹配的登记值（真实进程 start time 之外的时间）——pid 活但身份不符，
			// 同 bash_kill P0-2.2 篡改范式
			task.pidStartTime = (task.pidStartTime ?? 0) + 500;

			vi.advanceTimersByTime(1000);
			// 宁不杀勿误杀：到点不对复用嫌疑 pid 发 kill（整进程组 SIGKILL 会误杀无辜进程）
			expect(killTreeCalls).not.toContain(task.pid);
			// D6-en/R2-S1 加固：身份校验不过 = 登记原进程已不在（死亡或被复用），intent
			// 标记一并跳过——无条件改写内存 intent 为 timeout 会冲掉 UI 代杀 / AI bash_kill
			// 预写的 killed（误报 timed out 唤醒 AI）；终态归轮询边沿按事实收尾
			expect(getTask(task.taskId)?.state).toBe("running");
			expect(getTask(task.taskId)?.intent).toBeUndefined();
			expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.state).toBe("running");
		} finally {
			vi.useRealTimers();
		}
	});

	it("P0-4/D6-en R2-S1: missing pidStartTime degrades to startedAt check (mismatch → skip kill and intent mark)", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const spawned = spawnBg("sleep 30", { timeoutSec: 1 });
			if (!spawned.ok) throw new Error(spawned.error);
			const { task } = spawned;
			// 模拟 ps 不可用平台的 spawn（无 pidStartTime 字段）→ 降级 startedAt 秒级
			// 比较；startedAt 篡改为 epoch 1（实际进程 start time 远大于 0）→ 不匹配
			task.pidStartTime = undefined;
			task.startedAt = 1;

			vi.advanceTimersByTime(1000);
			expect(killTreeCalls).not.toContain(task.pid);
			// D6-en/R2-S1 加固：身份校验不过同样跳过 intent 标记（防冲掉 killed 预写）
			expect(getTask(task.taskId)?.state).toBe("running");
			expect(getTask(task.taskId)?.intent).toBeUndefined();
			expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.state).toBe("running");
		} finally {
			vi.useRealTimers();
		}
	});

	it("P0-4: degradation match (recent startedAt) → kill proceeds（降级判据不误拦正常 timeout）", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const spawned = spawnBg("sleep 30", { timeoutSec: 1 });
			if (!spawned.ok) throw new Error(spawned.error);
			const { task } = spawned;
			// 无 pidStartTime + 真实 startedAt（登记晚于 spawn → 原进程 start time 必然
			// ≤ floor(startedAt/1000)，floor 单调性）→ 降级判据匹配，正常发 kill
			task.pidStartTime = undefined;

			vi.advanceTimersByTime(1000);
			expect(killTreeCalls).toContain(task.pid);
			expect(getTask(task.taskId)?.state).toBe("killing");
		} finally {
			vi.useRealTimers();
		}
	});

	it("natural completion before the deadline cancels the timer (no late kill)", async () => {
		// 全程真实 timers：命令 0.2s 完成 < 1s 超时
		const before = killTreeCalls.length;
		const spawned = spawnBg("sleep 0.2 && echo quick", { timeoutSec: 1 });
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;

		// 轮询命令退出收尾（未到 1s deadline）
		await pollUntilTicked(() => getTask(task.taskId)?.state === "exited", POLL_DEADLINE_SLOW_MS, "natural finalization");
		expect(getTask(task.taskId)?.state).toBe("exited");
		expect(getTask(task.taskId)?.reason).toBe("natural");

		// 越过 deadline 的时间窗内不得再补杀（终态化必须已清 timer）：轮询真实时钟
		// 越过 deadline+余量后断言——这里等待的是时钟流逝本身，非子进程事件
		await pollUntil(
			() => Date.now() >= task.startedAt + 1_000 + 500,
			POLL_DEADLINE_SLOW_MS,
			"real clock to pass the deadline window",
		);
		expect(killTreeCalls.length).toBe(before);
		expect(getTask(task.taskId)?.state).toBe("exited");
	});
});

describe("D6-en: poller finalization reads back registry killing (cross-process UI kill)", () => {
	it("memory intent missing + registry killing → reason killed; AI not woken (no sendMessage)", async () => {
		const pi = { events: { emit: vi.fn() }, sendMessage: vi.fn(), appendEntry: vi.fn() };
		refreshPiReference(pi as unknown as ExtensionAPI);
		setOnTaskExit(handleTaskExit);
		const spawned = spawnBg("sleep 30");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		// runtime UI 代杀形态：只写 registry 侧 killing（跨进程，pi 内存表不可见）+
		// 杀进程树，不经本进程 markKillingIntent
		writeRegistryEntry(REGISTRY_PATH, taskToRegistryEntry({ ...task, state: "killing" }));
		expect(getTask(task.taskId)?.intent).toBeUndefined(); // 前置：内存无 intent
		process.kill(task.pid, "SIGKILL");
		await sleep(500);
		expect(isPidAlive(task.pid)).toBe(false);
		pollTickForTest();

		const finalized = getTask(task.taskId);
		expect(finalized?.state).toBe("exited");
		expect(finalized?.reason).toBe("killed"); // 读回命中（无 intent 时旧实现得 natural）
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.reason).toBe("killed");
		// 下游效果（P7 主路径口径）：killed → 只 emit unregister(cancelled)，不 sendMessage
		expect(pi.events.emit).toHaveBeenCalledWith("pending:unregister", {
			id: task.taskId,
			reason: "cancelled",
		});
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("memory intent present wins — registry NOT read back (killed kept while registry stays running)", async () => {
		const spawned = spawnBg("sleep 30");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		// 内存预写 killed intent（AI bash_kill 形态），registry 刻意停留 running
		//（模拟 intent 落盘失败）——若实现误读回，会按 running 判 natural
		expect(markKillingIntent(task.taskId, "killed")).toBeDefined();
		process.kill(task.pid, "SIGKILL");
		await sleep(500);
		expect(isPidAlive(task.pid)).toBe(false);
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.state).toBe("running"); // 前置成立
		pollTickForTest();
		expect(getTask(task.taskId)?.reason).toBe("killed"); // intent 优先，非 natural
	});

	it("registry read failure (corrupt file) degrades to no-intent natural; finalization not blocked", async () => {
		const spawned = spawnBg("sleep 30");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		writeFileSync(REGISTRY_PATH, "{corrupted", "utf8"); // 读回路径解析失败
		process.kill(task.pid, "SIGKILL");
		await sleep(500);
		pollTickForTest();
		const finalized = getTask(task.taskId);
		expect(finalized?.state).toBe("exited"); // 终态化未被阻塞
		expect(finalized?.reason).toBe("natural"); // 读失败按无 intent 处理
	});
});

describe("D6-en/R2-S1 hardening: armBackgroundTimeout skips kill+mark when recorded pid is gone", () => {
	it("UI kill × timeout overlap: no timeout mark; poll edge reads back registry killing → killed", async () => {
		const spawned = spawnBg("sleep 30", { timeoutSec: 1 });
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		// UI 代杀（跨进程形态）：registry 预写 killing + 直接杀进程，不经内存
		writeRegistryEntry(REGISTRY_PATH, taskToRegistryEntry({ ...task, state: "killing" }));
		process.kill(task.pid, "SIGKILL");
		await sleep(500); // 进程死亡 + libuv reap（deadline 1s 之前）
		expect(isPidAlive(task.pid)).toBe(false);
		await sleep(700); // 越过 deadline（累计 ~1.2s，仍在 2s 轮询 tick 之前）
		// 加固生效：不补杀、不改写内存（无 intent）、不冲掉 registry 侧 killing 预写
		expect(killTreeCalls).not.toContain(task.pid);
		expect(getTask(task.taskId)?.state).toBe("running");
		expect(getTask(task.taskId)?.intent).toBeUndefined();
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.state).toBe("killing");
		pollTickForTest();
		expect(getTask(task.taskId)?.state).toBe("exited");
		expect(getTask(task.taskId)?.reason).toBe("killed"); // D6-en 读回（非 timeout）
	});

	it("AI bash_kill × timeout overlap: killed intent survives (no 'timed out' misreport)", async () => {
		const spawned = spawnBg("sleep 30", { timeoutSec: 1 });
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		const killed = JSON.parse(await killTool(task.taskId)) as { killed: boolean };
		expect(killed.killed).toBe(true);
		await sleep(500); // 进程死亡 + reap（deadline 之前）
		expect(isPidAlive(task.pid)).toBe(false);
		await sleep(700); // 越过 deadline：pid 已死 → 跳过 timeout mark
		expect(getTask(task.taskId)?.intent?.reason).toBe("killed"); // 未被覆盖为 timeout
		expect(killTreeCalls.filter((pid) => pid === task.pid)).toHaveLength(1); // 无第二次 kill
		pollTickForTest();
		expect(getTask(task.taskId)?.state).toBe("exited");
		expect(getTask(task.taskId)?.reason).toBe("killed"); // 加固后保持 killed（无通知路径）
	});

	it("natural death before the deadline: no timeout mark; poll edge finalizes natural (accepted shift)", async () => {
		const before = killTreeCalls.length;
		const spawned = spawnBg("sleep 0.3", { timeoutSec: 1 });
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		await sleep(600); // 自然死亡 + reap，deadline(1s) 未到
		expect(getTask(task.taskId)?.state).toBe("running"); // 轮询未收尾（不手动 tick）
		await sleep(600); // 越过 deadline（累计 ~1.2s，仍在 2s 轮询 tick 之前）
		expect(killTreeCalls.length).toBe(before); // 死任务不补杀
		expect(getTask(task.taskId)?.state).toBe("running"); // 未被标 killing
		expect(getTask(task.taskId)?.intent).toBeUndefined();
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.state).toBe("running");
		pollTickForTest();
		expect(getTask(task.taskId)?.reason).toBe("natural"); // 语义微移：natural 非 timeout
	});
});

describe("process-exit reap (D12)", () => {
	it("reaps all active tasks with reason process-exit, kills pids, writes registry terminal", async () => {
		const first = spawnBg("sleep 30");
		const second = spawnBg("sleep 30");
		if (!first.ok || !second.ok) throw new Error("spawn failed");
		const pids = [first.task.pid, second.task.pid];
		expect(pids.every((pid) => isPidAlive(pid))).toBe(true);

		reapBackgroundTasksNow();
		// SIGKILL 发出到进程表移除是异步的：轮询等 pid 判死（满载下延迟不可预估）
		await pollUntil(() => pids.every((pid) => !isPidAlive(pid)), 5000, "reaped pids to die");

		for (const pid of pids) {
			expect(isPidAlive(pid)).toBe(false);
		}
		for (const t of [first.task, second.task]) {
			const finalized = getTask(t.taskId);
			expect(finalized?.state).toBe("exited");
			expect(finalized?.reason).toBe("process-exit");
			expect(readRegistry(REGISTRY_PATH).get(t.taskId)?.reason).toBe("process-exit");
		}
		expect(getActiveTasks()).toHaveLength(0);
	});
});

describe("D15: abort signal does not propagate to background tasks", () => {
	it("aborted execute-signal leaves the task running", async () => {
		const controller = new AbortController();
		const spawned = spawnBg("sleep 5");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		// 模拟用户中断当前 turn：signal abort（后台分支不接触 signal，此处模拟上游已 abort）
		controller.abort();
		expect(controller.signal.aborted).toBe(true);

		// 非断言性观察窗口（留事件传播时间）：断言的是「任务不受 abort 影响」的
		// 负向不变量，期望状态恒真，轮询语义不适用
		await sleep(300);
		// 任务不受中断影响：进程活、状态 running
		expect(isPidAlive(task.pid)).toBe(true);
		expect(getTask(task.taskId)?.state).toBe("running");
	});
});

describe("spawn failure paths (§3.6)", () => {
	it("nonexistent cwd reports the builtin-style error", () => {
		const result = spawnBackgroundTask({
			command: "echo hi",
			cwd: "/definitely/not/exist/dir",
			dataDir: DATA_DIR,
			sessionId: SESSION_ID,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("Working directory does not exist");
		}
	});

	it("missing shell reports a spawn failure error", () => {
		// 通过临时 SHELL 指向不存在路径模拟 shell 缺失（POSIX 分支）
		const original = process.env.SHELL;
		process.env.SHELL = "/no/such/shell-binary";
		try {
			const result = spawnBg("echo hi");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("Failed to start background command");
			}
		} finally {
			if (original === undefined) delete process.env.SHELL;
			else process.env.SHELL = original;
		}
	});
});
