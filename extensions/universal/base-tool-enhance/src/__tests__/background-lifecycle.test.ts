// src/__tests__/background-lifecycle.test.ts —— background 核心生命周期：
// 真实 spawn 边沿收尾 / exit 事件自动收尾 / killing intent 双侧 / timeout / 并发上限 /
// 收殓 / D15 abort / bash_output / bash_kill（黑盒：经工具 execute 断言使用者可见行为）
//
// 轨道拆分（单测层极端测试整治第二波）：
//   - 单测层（本文件主体）= 进程端点桩化：vi.mock 把 node:child_process 的 spawn 换成
//     桩 ChildProcess（EventEmitter + pid/exitCode/unref），protocol 判活 / start time
//     读取对桩 pid 截获，kill-tree 只记录不转发。被测逻辑——单例表、registry 锁内
//     RMW、killing intent 双侧标记、timeout 定时器杀链编排、exit 边沿收尾、通知入账
//     ——全部真跑；exit 事件由 emitFakeExit 显式派发（exitCode 先落再派发，对齐真
//     ChildProcess 语义），确定性同步、无等待窗口。
//   - 集成组（文件尾门控 describe，TAIJI_TEST_INTEGRATION=1 真跑）= 5 条真子进程核心：
//     spawn+自然退出全链 / bash_kill 真杀进程树 / timeout 真杀链 / 进程退出收殓真杀 /
//     真实时钟下自然完成不补杀。真子进程满载下延迟不可预估（无确定性完成信号），
//     属「代码 + OS 组合行为」，本地默认跳过（门控 SSOT = test-guard/integration-gate.ts）。
//   - 预算：单测用例走 vitest 默认；集成组用例单独挂 20s（原文件级预算随拆组下沉到
//     用例级，非抬升），轮询 deadline 常量（10s / 8s）仅集成组消费。
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from "../../../../../test-guard/integration-gate.ts";

// getAgentDir → 测试临时数据目录（工具 execute 内部调用，不写真 ~/.pi/agent）。
// [session-store-layout-inversion 域 5] 工具的 dataDir 来源已换为 resolveTaijiDataDir()
// （env 注入）——getAgentDir mock 随换根退役，改 beforeEach stubEnv + afterEach 还原。
//
// 进程端点桩（单测层）：vi.mock 两处——
//   1) node:child_process.spawn：spawnMode.real=false（默认）返回桩 ChildProcess，
//      集成组 describe 的 beforeEach 置 true 走真 spawn；
//   2) @zhushanwen/extension-protocol/background-task 的进程原语（kill-tree 发令 /
//      pid 判活 / start time 读取）：桩 pid 截获（fakePids 登记表），真 pid 原样转发
//      （timeout 分支断言 killProcessTree 被调；集成组真杀）。
const { killTreeCalls, fakePids, spawnMode, fakeChildSeq } = vi.hoisted(() => ({
	killTreeCalls: [] as number[],
	fakePids: new Map<number, { alive: boolean; startSec?: number }>(),
	spawnMode: { real: false },
	fakeChildSeq: { n: 0 },
}));

vi.mock("node:child_process", async (importOriginal) => {
	const orig = await importOriginal<typeof import("node:child_process")>();
	const realSpawn = orig.spawn;
	return {
		...orig,
		spawn: (...args: Parameters<typeof realSpawn>) =>
			spawnMode.real ? realSpawn(...args) : fakeSpawn(),
	};
});

vi.mock("@zhushanwen/extension-protocol/background-task", async (importOriginal) => {
	const orig = await importOriginal<
		typeof import("@zhushanwen/extension-protocol/background-task")
	>();
	return {
		...orig,
		killProcessTree: (pid: number, onFallback?: (step: string, err: unknown) => void): void => {
			killTreeCalls.push(pid);
			// 桩 pid 上无进程可杀，不转发真信号；真 pid（集成组真杀 / 误杀守卫断言对象）原样转发
			if (fakePids.has(pid)) return;
			orig.killProcessTree(pid, onFallback);
		},
		isPidAlive: (pid: number): boolean => {
			const fake = fakePids.get(pid);
			return fake === undefined ? orig.isPidAlive(pid) : fake.alive;
		},
		getProcessStartTimeSec: (pid: number): number | undefined => {
			const fake = fakePids.get(pid);
			return fake === undefined ? orig.getProcessStartTimeSec(pid) : fake.startSec;
		},
	};
});

import { isPidAlive } from "@zhushanwen/extension-protocol/background-task";

import { createBashKillToolDefinition } from "../bash-kill-tool.ts";
import { createBashOutputToolDefinition } from "../bash-output-tool.ts";
import { handleTaskExit, refreshPiReference, resetNotifyForTest } from "../background/notify.ts";
import { setOnTaskExit } from "../background/exit-collector.ts";
import { getRegistryPath, readRegistry, taskToRegistryEntry, writeRegistryEntry } from "../background/registry.ts";
import type { BackgroundTask, RegistryEntry } from "../background/types.ts";
import { DEFAULT_MAX_CONCURRENT_BACKGROUND, spawnBackgroundTask } from "../background/spawn-background.ts";
import { clearTaskStoreForTest, getActiveTasks, getTask, markKillingIntent } from "../background/task-store.ts";
import { reapBackgroundTasksNow, resetProcessExitGuardForTest } from "../background/process-exit-guard.ts";

const DATA_DIR = mkdtempSync(join(tmpdir(), "bte-data-"));

const SESSION_ID = "sess-lifecycle";
const REGISTRY_PATH = getRegistryPath(DATA_DIR, SESSION_ID);

beforeEach(() => {
	// 工具 execute 的 dataDir 来源 = resolveTaijiDataDir()（env，域 5 换根）
	vi.stubEnv("TAIJI_AGENT_DATA_DIR", DATA_DIR);
});

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

// ──────────────────────── 进程端点桩（单测层专用） ────────────────────────

/** 桩 pid 基数：远离真实 pid 区间，fakePids 登记即截获判活/身份读取，与真 pid 互不串扰。 */
const FAKE_PID_BASE = 4_000_000;
/**
 * 桩进程 start time（epoch 秒，恒定过去时刻）：镜像 macOS ps 可读形态（spawn 即得
 * pidStartTime）；取过去值保证 ≤ 任何真实 startedAt 的秒级降级比较恒匹配
 * （pidStartMatchesRegistered 的降级分支用「actual ≤ floor(startedAt/1000)」）。
 */
const FAKE_START_SEC = 1_700_000_000;

/** 桩 ChildProcess 最小形状：BackgroundTask 只消费 pid / exitCode / unref / on('exit')。 */
type FakeChildProcess = EventEmitter & { pid: number; exitCode: number | null; unref: () => void };

/** 桩 spawn：登记 fake pid（默认存活 + 恒定 start time），返回可派发 exit 的假 ChildProcess。 */
function fakeSpawn(): FakeChildProcess {
	const pid = FAKE_PID_BASE + ++fakeChildSeq.n;
	fakePids.set(pid, { alive: true, startSec: FAKE_START_SEC });
	return Object.assign(new EventEmitter(), {
		pid,
		exitCode: null as number | null,
		unref: () => {},
	});
}

/**
 * 派发桩进程退出（单测层的 exit 事件边沿）：exitCode 先落再 emit——对齐真
 * ChildProcess 语义（finalizeExitedTask 从 child.exitCode 读码）。同步触发全部
 * 收尾链（tail 摘要 → reason 判定 → 两侧终态写 → onTaskExit 回调），确定性完成。
 */
function emitFakeExit(task: BackgroundTask, exitCode: number | null): void {
	const child = task.child as FakeChildProcess | undefined;
	if (child === undefined) throw new Error("fake child missing (already finalized)");
	child.exitCode = exitCode;
	child.emit("exit", exitCode, null);
}

// ──────────────────────── 集成组轮询原语（仅门控 describe 消费） ────────────────────────

/**
 * 真实子进程链（spawn+exec+sleep+exit）满载下延迟不可预估，deadline 放宽到 10s；
 * timeout 路径单独放宽到 8s（任务语义内最慢的等待对象）。
 */
const POLL_DEADLINE_MS = 10_000;
const POLL_DEADLINE_SLOW_MS = 8_000;

/**
 * 等待直到期望状态出现或超时：状态机由 exit 事件边沿（真实 ChildProcess exit 监听，
 * ADR-0122 改造后无轮询器）自行推进——固定 sleep 后单次断言是满载 flake 源，等状态
 * 而非猜时刻。
 */
async function pollUntilTicked(check: () => boolean, deadlineMs: number, what: string): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		if (check()) return;
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

/** spawn 后台命令并断言受理成功（拒绝即炸出用例——正向用例样板收敛点）。 */
function spawnOk(command: string, extra: { timeoutSec?: number; maxConcurrent?: number } = {}) {
	const spawned = spawnBg(command, extra);
	if (!spawned.ok) throw new Error(spawned.error);
	return spawned.task;
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
	// env stub 逐用例还原（防同 worker 跨文件残留）
	vi.unstubAllEnvs();
	// 进程端点桩复位：集成组的 real 开关关回、桩 pid 登记表清空（防截获串到下一用例）
	spawnMode.real = false;
	fakePids.clear();
	// 残留活跃任务先杀干净再清表（防句柄/进程泄漏影响后续测试）；桩 pid 无进程可杀
	// （kill ESRCH 落 catch），真 pid（集成组）正常回收
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

// ──────────────────────── 单测层：spawn + exit 边沿收尾（进程端点桩化） ────────────────────────

describe("spawn + exit edge finalization (stub process endpoint)", () => {
	it("short task: running → exited with exitCode 0, output file readable, registry terminal", async () => {
		const task = spawnOk("sleep 0.1 && echo done");
		// spawn 登记即写 running 条目（含 ownerPiPid，M5 属主判定依据）
		expect(task.state).toBe("running");
		expect(existsSync(task.outputFile)).toBe(true);
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.state).toBe("running");
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.ownerPiPid).toBe(process.pid);

		// 桩端点：命令「输出」由测试直写输出文件（真 spawn 下由子进程写，内容同源）
		writeFileSync(task.outputFile, "done\n", "utf8");
		emitFakeExit(task, 0);

		const finalized = getTask(task.taskId);
		expect(finalized?.state).toBe("exited");
		expect(finalized?.exitCode).toBe(0);
		expect(finalized?.reason).toBe("natural");
		expect(finalized?.durationMs).toBeGreaterThanOrEqual(0);

		const registryEntry = readRegistry(REGISTRY_PATH).get(task.taskId);
		expect(registryEntry?.state).toBe("exited");
		expect(registryEntry?.reason).toBe("natural");

		const detail = JSON.parse(await outputTool({ task_id: task.taskId })) as { output: string; exitCode: number };
		expect(detail.output).toContain("done");
		expect(detail.exitCode).toBe(0);
	});

	it("nonzero exit code is surfaced (exitCode 1)", () => {
		const task = spawnOk("sleep 0.1; exit 3");
		emitFakeExit(task, 3);
		expect(getTask(task.taskId)?.exitCode).toBe(3);
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.exitCode).toBe(3);
	});

	it("onTaskExit callback (M3 hook point) fires with the finalized task", () => {
		const seen: string[] = [];
		setOnTaskExit((task) => seen.push(`${task.taskId}:${task.state}:${task.reason}`));
		const task = spawnOk("true");
		emitFakeExit(task, 0);
		// 桩派发同步走完收尾链（无等待窗口），回调即时可见
		expect(seen).toHaveLength(1);
		expect(seen[0]).toBe(`${task.taskId}:exited:natural`);
	});

	it("spawned entry carries pidStartTime for kill-side precise comparison (M5→M3)", () => {
		const task = spawnOk("sleep 30");
		// 桩端点：spawn 即从身份原语读 start time 进条目（真 ps 读取形态由集成轨覆盖）
		expect(task.pidStartTime).toBe(FAKE_START_SEC);
		const registryEntry = readRegistry(REGISTRY_PATH).get(task.taskId) as
			| { pidStartTime?: number }
			| undefined;
		expect(registryEntry?.pidStartTime).toBe(task.pidStartTime);
	});
});

// ──────────────────────── 单测层：bash_output 工具 ────────────────────────

describe("bash_output tool", () => {
	it("description pins the auto-notify contract (on-demand checks only, DO NOT bash sleep)", () => {
		// 与 bash description / 启动回执同一契约话术（统一 "DO NOT bash sleep"）——删改必须红灯
		expect(bashOutput.description).toContain("completion is auto-notified");
		expect(bashOutput.description).toContain("DO NOT bash sleep");
	});

	it("list merges store + registry terminal entries, store wins on same id", async () => {
		// 单例表：一个 running 桩任务
		const task = spawnOk("sleep 5");
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
			taskToRegistryEntry({ ...task, state: "exited" as const, ownerPiPid: 1 }),
		);

		const listed = JSON.parse(await outputTool({})) as {
			tasks: Array<{ task_id: string; state: string; command: string }>;
		};
		const byId = new Map(listed.tasks.map((t) => [t.task_id, t]));
		expect(byId.get(task.taskId)?.state).toBe("running"); // 单例表优先
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
		const task = spawnOk("sleep 0.1 && echo gone");
		emitFakeExit(task, 0);
		unlinkSync(task.outputFile);
		const detail = JSON.parse(await outputTool({ task_id: task.taskId })) as {
			output: string;
			state: string;
		};
		expect(detail.output).toBe("<lost>");
		expect(detail.state).toBe("exited");
	});

	it("output tail respects line cap", async () => {
		// 2100 行输出 → tail 只保留最后 2000 行（输出内容由测试直写，截断逻辑真跑）
		const task = spawnOk("for i in $(seq 1 2100); do echo line$i; done");
		const lines = Array.from({ length: 2100 }, (_, i) => `line${i + 1}`);
		writeFileSync(task.outputFile, `${lines.join("\n")}\n`, "utf8");
		emitFakeExit(task, 0);
		const detail = JSON.parse(await outputTool({ task_id: task.taskId })) as {
			output: string;
			truncated: boolean;
		};
		const got = detail.output.split("\n");
		expect(got.length).toBeLessThanOrEqual(2000);
		expect(detail.truncated).toBe(true);
		expect(detail.output).toContain("line2100");
		expect(detail.output).not.toContain("line50\n");
	});
});

// ──────────────────────── 单测层：bash_kill 工具（killing intent 双侧） ────────────────────────

describe("bash_kill tool (killing intent, single-point finalization)", () => {
	it("kill marks BOTH store and registry as killing before the exit event edge lands", async () => {
		const task = spawnOk("sleep 60");

		const killResult = JSON.parse(await killTool(task.taskId)) as { killed: boolean; reason: string };
		expect(killResult.killed).toBe(true);

		// exit 边沿未派发（sleep 60 语义下任务仍在）：两侧 killing 即可见，无倒挂
		expect(getTask(task.taskId)?.state).toBe("killing");
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.state).toBe("killing");
		// kill-tree 确实对该 pid 发过令
		expect(killTreeCalls).toContain(task.pid);
	});

	it("kill edge: intent consumed → exited with reason killed", async () => {
		const task = spawnOk("sleep 60");
		await killTool(task.taskId);
		// 桩端点派发 kill 后的进程死亡（SIGKILL 终止 = exitCode null）
		emitFakeExit(task, null);
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
		const task = spawnOk("sleep 0.1");
		emitFakeExit(task, 0);
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
		expect(result.hint).toContain("taiji runtime");
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

	it("P0-2.2: pidStartTime mismatch (pid reuse suspected) → refuse kill", async () => {
		const task = spawnOk("sleep 30");
		// 构造不匹配的登记值（桩身份原语读到的 start time 之外的时间）——pid 活但身份不符
		task.pidStartTime = (task.pidStartTime ?? 0) + 500;

		const result = JSON.parse(await killTool(task.taskId)) as { killed: boolean; reason: string; hint?: string };
		expect(result.killed).toBe(false);
		expect(result.reason).toContain("pid reuse suspected");
		expect(result.hint).toContain("manually");
		expect(killTreeCalls).not.toContain(task.pid); // 宁不杀勿误杀
		expect(getTask(task.taskId)?.state).toBe("running"); // 未标 intent
	});

	it("P0-2.2: matching pidStartTime → kill proceeds（start time 校验不误拦正常 kill）", async () => {
		const task = spawnOk("sleep 30");
		// spawn 时身份原语读到的 start time 原样保留 → 校验通过，正常 kill 路径
		const result = JSON.parse(await killTool(task.taskId)) as { killed: boolean };
		expect(result.killed).toBe(true);
		expect(killTreeCalls).toContain(task.pid);
	});
});

// ──────────────────────── 单测层：并发上限（D10） ────────────────────────

describe("concurrency cap (D10, default 8)", () => {
	it("rejects the 9th task with the oldest task id in the error", () => {
		const tasks: string[] = [];
		for (let i = 0; i < DEFAULT_MAX_CONCURRENT_BACKGROUND; i++) {
			const task = spawnOk("sleep 30");
			// 桩端点同毫秒连发：直接改写条目 startedAt 保证「最老」判定确定有序
			//（单例表持同一对象引用；真 spawn 形态靠错峰 sleep，此处无需）
			task.startedAt = 1_000 + i;
			tasks.push(task.taskId);
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

// ──────────────────────── 单测层：显式后台 timeout（D6，fake timers 驱动） ────────────────────────

describe("explicit background timeout (D6)", () => {
	it("fires kill-tree at the deadline and finalizes with reason timeout", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let finalized: BackgroundTask | undefined;
		try {
			// fake 生效后 spawn：timeout 定时器进 fake 队列，由 advanceTimers 推进
			const task = spawnOk("sleep 30", { timeoutSec: 1 });

			vi.advanceTimersByTime(1000);
			// 到点：kill-tree 已发令 + 两侧 killing intent（reason 候选 timeout）
			expect(killTreeCalls).toContain(task.pid);
			expect(getTask(task.taskId)?.state).toBe("killing");
			expect(getTask(task.taskId)?.intent?.reason).toBe("timeout");
			expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.state).toBe("killing");

			// 桩端点派发 kill 后的进程死亡：exit 边沿按 intent 收尾 → exited(reason:"timeout")
			emitFakeExit(task, null);
			finalized = getTask(task.taskId);
		} finally {
			vi.useRealTimers();
		}
		expect(finalized?.state).toBe("exited");
		expect(finalized?.reason).toBe("timeout");
	});

	it("P0-4/D6-en R2-S1: pid reuse suspected at the deadline → skip kill AND skip intent mark", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const task = spawnOk("sleep 30", { timeoutSec: 1 });
			// 构造不匹配的登记值（身份原语读到的 start time 之外的时间）——pid 活但身份不符，
			// 同 bash_kill P0-2.2 篡改范式
			task.pidStartTime = (task.pidStartTime ?? 0) + 500;

			vi.advanceTimersByTime(1000);
			// 宁不杀勿误杀：到点不对复用嫌疑 pid 发 kill（整进程组 SIGKILL 会误杀无辜进程）
			expect(killTreeCalls).not.toContain(task.pid);
			// D6-en/R2-S1 加固：身份校验不过 = 登记原进程已不在（死亡或被复用），intent
			// 标记一并跳过——无条件改写内存 intent 为 timeout 会冲掉 UI 代杀 / AI bash_kill
			// 预写的 killed（误报 timed out 唤醒 AI）；终态归 exit 事件边沿按事实收尾
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
			const task = spawnOk("sleep 30", { timeoutSec: 1 });
			// 模拟 ps 不可用平台的 spawn（无 pidStartTime 字段）→ 降级 startedAt 秒级
			// 比较；startedAt 篡改为 epoch 1（桩 start time 远大于 0）→ 不匹配
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
			const task = spawnOk("sleep 30", { timeoutSec: 1 });
			// 无 pidStartTime + 真实 startedAt（登记晚于 spawn → 原进程 start time 必然
			// ≤ floor(startedAt/1000)，floor 单调性；桩 start time 取恒定过去值同判）→
			// 降级判据匹配，正常发 kill
			task.pidStartTime = undefined;

			vi.advanceTimersByTime(1000);
			expect(killTreeCalls).toContain(task.pid);
			expect(getTask(task.taskId)?.state).toBe("killing");
		} finally {
			vi.useRealTimers();
		}
	});

	it("natural completion before the deadline cancels the timer (no late kill)", () => {
		// fake timers + 桩端点：先自然退出（终态化清 timer）再推进时钟越过 deadline——
		// 「到点不补杀」不变量确定性验证（真进程 + 真实时钟形态由集成组覆盖）
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const before = killTreeCalls.length;
			const task = spawnOk("sleep 0.1 && echo quick", { timeoutSec: 1 });

			emitFakeExit(task, 0);
			expect(getTask(task.taskId)?.state).toBe("exited");
			expect(getTask(task.taskId)?.reason).toBe("natural");

			// 越过 deadline：终态化必须已清 timer（fake 队列中被 clearTimeout 的回调不再触发）
			vi.advanceTimersByTime(5000);
			expect(killTreeCalls.length).toBe(before);
			expect(getTask(task.taskId)?.state).toBe("exited");
		} finally {
			vi.useRealTimers();
		}
	});
});

// ──────────────────────── 单测层：D6-en intent 读回（exit 边沿 reason 判定） ────────────────────────

describe("D6-en: exit edge finalization reads back registry killing (cross-process UI kill)", () => {
	it("memory intent missing + registry killing → reason killed; AI not woken (no sendMessage)", () => {
		const pi = { events: { emit: vi.fn() }, sendMessage: vi.fn(), appendEntry: vi.fn() };
		refreshPiReference(pi as unknown as ExtensionAPI);
		setOnTaskExit(handleTaskExit);
		const task = spawnOk("sleep 30");
		// runtime UI 代杀形态：只写 registry 侧 killing（跨进程，pi 内存表不可见）+
		// 杀进程树，不经本进程 markKillingIntent
		writeRegistryEntry(REGISTRY_PATH, taskToRegistryEntry({ ...task, state: "killing" }));
		expect(getTask(task.taskId)?.intent).toBeUndefined(); // 前置：内存无 intent
		// 桩端点派发被杀死亡（exit 事件边沿自动收尾，读回 registry killing → killed）
		emitFakeExit(task, null);

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

	it("memory intent present wins — registry NOT read back (killed kept while registry stays running)", () => {
		const task = spawnOk("sleep 30");
		// 内存预写 killed intent（AI bash_kill 形态），registry 刻意停留 running
		//（模拟 intent 落盘失败）——若实现误读回，会按 running 判 natural
		expect(markKillingIntent(task.taskId, "killed")).toBeDefined();
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.state).toBe("running");
		emitFakeExit(task, null);
		expect(getTask(task.taskId)?.reason).toBe("killed"); // intent 优先，非 natural
	});

	it("registry read failure (corrupt file) degrades to no-intent natural; finalization not blocked", () => {
		const task = spawnOk("sleep 30");
		writeFileSync(REGISTRY_PATH, "{corrupted", "utf8"); // 读回路径解析失败
		emitFakeExit(task, 0);
		// exit 事件边沿自动收尾（读回失败按无 intent 处理）
		const finalized = getTask(task.taskId);
		expect(finalized?.state).toBe("exited"); // 终态化未被阻塞
		expect(finalized?.reason).toBe("natural"); // 读失败按无 intent 处理
	});
});

// ──────────────────────── 单测层：D6-en/R2-S1 加固（已终态任务到点不补杀不改写） ────────────────────────

describe("D6-en/R2-S1 hardening: armBackgroundTimeout skips kill+mark when recorded pid is gone", () => {
	it("UI kill × timeout overlap: no timeout mark; exit edge reads back registry killing → killed", () => {
		// 桩端点 + fake timers：deadline 前先被 UI 代杀收尾（终态化清 timer），再推进
		// 时钟越过 deadline——「不补杀、不改写 intent」确定性验证（真实时钟形态由集成组覆盖）
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const task = spawnOk("sleep 30", { timeoutSec: 1 });
			// UI 代杀（跨进程形态）：registry 预写 killing + 直接杀进程，不经内存
			writeRegistryEntry(REGISTRY_PATH, taskToRegistryEntry({ ...task, state: "killing" }));
			emitFakeExit(task, null);
			// exit 边沿在 deadline 前收尾（D6-en 读回 registry killing → killed）
			expect(getTask(task.taskId)?.reason).toBe("killed");

			vi.advanceTimersByTime(5000); // 越过 deadline
			// 加固生效：到点时任务已终态 → 不补杀、intent 不被改写为 timeout、reason 保持 killed
			expect(killTreeCalls).not.toContain(task.pid);
			expect(getTask(task.taskId)?.state).toBe("exited");
			expect(getTask(task.taskId)?.intent).toBeUndefined();
			expect(getTask(task.taskId)?.reason).toBe("killed"); // D6-en 读回（非 timeout）
		} finally {
			vi.useRealTimers();
		}
	});

	it("AI bash_kill × timeout overlap: killed intent survives (no 'timed out' misreport)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const task = spawnOk("sleep 30", { timeoutSec: 1 });
			const killed = JSON.parse(await killTool(task.taskId)) as { killed: boolean };
			expect(killed.killed).toBe(true);
			// exit 边沿在 deadline 前收尾（intent 优先 → killed）
			emitFakeExit(task, null);
			expect(getTask(task.taskId)?.reason).toBe("killed");

			vi.advanceTimersByTime(5000); // 越过 deadline
			expect(getTask(task.taskId)?.intent).toBeUndefined(); // 终态化消费 intent，不再存在
			expect(killTreeCalls.filter((pid) => pid === task.pid)).toHaveLength(1); // 无第二次 kill
			expect(getTask(task.taskId)?.state).toBe("exited");
			expect(getTask(task.taskId)?.reason).toBe("killed"); // 加固后保持 killed（无通知路径）
		} finally {
			vi.useRealTimers();
		}
	});

	it("natural death before the deadline: no timeout mark; exit edge finalizes natural (accepted shift)", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const before = killTreeCalls.length;
			const task = spawnOk("sleep 0.1", { timeoutSec: 1 });
			// exit 边沿在 deadline 前收尾（自然退出）
			emitFakeExit(task, 0);
			expect(getTask(task.taskId)?.state).toBe("exited");

			vi.advanceTimersByTime(5000); // 越过 deadline
			expect(killTreeCalls.length).toBe(before); // 死任务不补杀
			expect(getTask(task.taskId)?.state).toBe("exited");
			expect(getTask(task.taskId)?.intent).toBeUndefined();
			expect(getTask(task.taskId)?.reason).toBe("natural"); // 语义微移：natural 非 timeout
		} finally {
			vi.useRealTimers();
		}
	});
});

// ──────────────────────── 单测层：进程退出收殓（D12，编排逻辑） ────────────────────────

describe("process-exit reap (D12)", () => {
	it("reaps all active tasks with reason process-exit, kills pids, writes registry terminal", () => {
		const first = spawnBg("sleep 30");
		const second = spawnBg("sleep 30");
		if (!first.ok || !second.ok) throw new Error("spawn failed");
		const pids = [first.task.pid, second.task.pid];
		expect(pids.every((pid) => isPidAlive(pid))).toBe(true);

		reapBackgroundTasksNow();
		// 桩端点：kill 发令断言 + 终态两侧断言（真 pid 判死由集成组覆盖）
		for (const pid of pids) {
			expect(killTreeCalls).toContain(pid);
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

// ──────────────────────── 单测层：D15 abort 不传播 ────────────────────────

describe("D15: abort signal does not propagate to background tasks", () => {
	it("aborted execute-signal leaves the task running", () => {
		const controller = new AbortController();
		const task = spawnOk("sleep 1");
		// 模拟用户中断当前 turn：signal abort（后台分支不接触 signal，此处模拟上游已 abort）
		controller.abort();
		expect(controller.signal.aborted).toBe(true);

		// 不变量「spawn 链路不读 signal」同步即成立（无需观察窗）；任务不受中断影响：
		// 进程活、状态 running
		expect(isPidAlive(task.pid)).toBe(true);
		expect(getTask(task.taskId)?.state).toBe("running");
	});
});

// ──────────────────────── 单测层：spawn 失败路径（§3.6） ────────────────────────

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
		// 通过临时 SHELL 指向不存在路径模拟 shell 缺失（POSIX 分支）。走真 spawn 调用
		// （不存在路径不产生真进程：ENOENT → 无 pid → 失败返回），验证的是 spawn 侧
		// 失败分支而非桩工厂
		const original = process.env.SHELL;
		process.env.SHELL = "/no/such/shell-binary";
		spawnMode.real = true;
		try {
			const result = spawnBg("echo hi");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("Failed to start background command");
			}
		} finally {
			spawnMode.real = false;
			if (original === undefined) delete process.env.SHELL;
			else process.env.SHELL = original;
		}
	});
});

// ──────────────────────── 集成组：真子进程核心 5 条（TAIJI_TEST_INTEGRATION 门控） ────────────────────────

// 真子进程链（spawn+exec+sleep+exit）满载下延迟不可预估，无确定性完成信号可等——
// 属「代码 + OS 组合行为」，移出默认单测层：本地默认跳过，CI / 按改动范围触发时
// 设 TAIJI_TEST_INTEGRATION=1 真跑（门控 SSOT = test-guard/integration-gate.ts）。
// 保留的 5 条核心 = 真进程端点语义（真 spawn 产物 / 真 SIGKILL 生效 / 真 pid 判死 /
// 真实时钟不补杀），编排与判定逻辑已由上方单测层全覆盖。
describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
	`real process core (spawn / kill tree / timeout chain / reap)${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
	() => {
		beforeEach(() => {
			// 真 spawn 模式：node:child_process.spawn 走原实现，进程原语对真 pid 直通
			spawnMode.real = true;
		});

		it(
			"short task: running → exited with exitCode 0, output file readable, registry terminal, pidStartTime carried",
			{ timeout: 20_000 },
			async () => {
				// 断言只要求「exit 事件边沿前 state=running」与退出产物，不依赖命令时长（终态化只在 finalizeTask）
				const task = spawnOk("sleep 0.1 && echo done");
				expect(task.state).toBe("running");
				expect(existsSync(task.outputFile)).toBe(true);
				// registry 登记即写 running 条目（含 ownerPiPid，M5 属主判定依据）
				expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.state).toBe("running");
				expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.ownerPiPid).toBe(process.pid);
				// 真实 ps 读取的 start time 进条目与 registry（M5→M3 kill 侧精确比较依据）
				expect(typeof task.pidStartTime).toBe("number");
				expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.pidStartTime).toBe(task.pidStartTime);

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
			},
		);

		it(
			"kill edge: intent consumed → exited with reason killed",
			{ timeout: 20_000 },
			async () => {
				const task = spawnOk("sleep 60");
				await killTool(task.taskId);
				// 轮询到 kill 边沿收尾（SIGKILL 生效 + tick 终态化）
				await pollUntilTicked(() => getTask(task.taskId)?.reason === "killed", POLL_DEADLINE_MS, "killed finalization");
				const finalized = getTask(task.taskId);
				expect(finalized?.state).toBe("exited");
				expect(finalized?.reason).toBe("killed");
				expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.reason).toBe("killed");
			},
		);

		it(
			"fires kill-tree at the deadline and finalizes with reason timeout",
			{ timeout: 20_000 },
			async () => {
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				let taskId = "";
				let pid = -1;
				try {
					// fake 生效后 spawn：timeout 定时器进 fake 队列，由 advanceTimers 推进
					const task = spawnOk("sleep 30", { timeoutSec: 1 });
					taskId = task.taskId;
					pid = task.pid;

					vi.advanceTimersByTime(1000);
					// 到点：kill-tree 已发令 + 两侧 killing intent（reason 候选 timeout）
					expect(killTreeCalls).toContain(pid);
					expect(getTask(taskId)?.state).toBe("killing");
					expect(getTask(taskId)?.intent?.reason).toBe("timeout");
					expect(readRegistry(REGISTRY_PATH).get(taskId)?.state).toBe("killing");
				} finally {
					vi.useRealTimers();
				}

				// SIGKILL 已真实发出：exit 事件边沿收尾 → exited(reason:"timeout")，终态由边沿写
				//（timeout 路径满载下 SIGKILL 生效延迟不可预估，deadline 放宽到 8s）
				await pollUntilTicked(
					() => getTask(taskId)?.state === "exited" && getTask(taskId)?.reason === "timeout",
					POLL_DEADLINE_SLOW_MS,
					"timeout finalization",
				);
				const finalized = getTask(taskId);
				expect(finalized?.state).toBe("exited");
				expect(finalized?.reason).toBe("timeout");
			},
		);

		it(
			"reaps all active tasks with reason process-exit, real pids die, writes registry terminal",
			{ timeout: 20_000 },
			async () => {
				const first = spawnBg("sleep 30");
				const second = spawnBg("sleep 30");
				if (!first.ok || !second.ok) throw new Error("spawn failed");
				const pids = [first.task.pid, second.task.pid];
				expect(pids.every((pid) => isPidAlive(pid))).toBe(true);

				reapBackgroundTasksNow();
				// SIGKILL 发出到进程表移除是异步的：轮询等 pid 判死（满载下延迟不可预估）
				await pollUntilTicked(() => pids.every((pid) => !isPidAlive(pid)), POLL_DEADLINE_MS, "reaped pids to die");

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
			},
		);

		it(
			"natural completion before the deadline cancels the timer (no late kill, real clock)",
			{ timeout: 20_000 },
			async () => {
				// 全程真实 timers：命令 0.1s 完成 < 0.5s 超时（真实时间必须真实流过——
				// 本用例证明「到点不补杀」，fake 时钟会让回调先于进程死亡触发）
				const before = killTreeCalls.length;
				const task = spawnOk("sleep 0.1 && echo quick", { timeoutSec: 0.5 });

				// 轮询命令退出收尾（未到 0.5s deadline）
				await pollUntilTicked(() => getTask(task.taskId)?.state === "exited", POLL_DEADLINE_SLOW_MS, "natural finalization");
				expect(getTask(task.taskId)?.state).toBe("exited");
				expect(getTask(task.taskId)?.reason).toBe("natural");

				// 越过 deadline 的时间窗内不得再补杀（终态化必须已清 timer）：轮询真实时钟
				// 越过 deadline+200ms 余量后断言——这里等待的是时钟流逝本身，非子进程事件
				await pollUntilTicked(
					() => Date.now() >= task.startedAt + 500 + 200,
					POLL_DEADLINE_SLOW_MS,
					"real clock to pass the deadline window",
				);
				expect(killTreeCalls.length).toBe(before);
				expect(getTask(task.taskId)?.state).toBe("exited");
			},
		);
	},
);
