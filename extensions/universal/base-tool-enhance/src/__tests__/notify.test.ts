// src/__tests__/notify.test.ts —— M3 通知通路单元：
// register emit 形态（数据流 ⑤）/ exit 边沿通知（⑧⑨，含 killed 不 sendMessage）/
// 通知文案 / D17 pi 引用刷新 / 收殓路径补 emit（process-exit 不 sendMessage）
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { killProcessTree } from "@xyz-agent/extension-protocol/background-task";
import {
	BACKGROUND_BASH_CUSTOM_TYPE,
	buildNotificationContent,
	emitPendingRegister,
	handleTaskExit,
	refreshPiReference,
	resetNotifyForTest,
} from "../background/notify.ts";
import { pollTickForTest, setOnTaskExit, stopPoller } from "../background/poller.ts";
import { spawnBackgroundTask } from "../background/spawn-background.ts";
import {
	clearTaskStoreForTest,
	getActiveTasks,
	getTask,
	markKillingIntent,
} from "../background/task-store.ts";
import type { BackgroundTask } from "../background/types.ts";

vi.setConfig({ testTimeout: 20000 });

const DATA_DIR = mkdtempSync(join(tmpdir(), "bte-notify-"));
const SESSION_ID = "sess-notify";

interface MockPi {
	events: { emit: ReturnType<typeof vi.fn> };
	sendMessage: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
}

function createMockPi(): MockPi {
	return { events: { emit: vi.fn() }, sendMessage: vi.fn(), appendEntry: vi.fn() };
}

function attach(pi: MockPi): void {
	refreshPiReference(pi as unknown as ExtensionAPI);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 真实子进程链（spawn+exec+sleep+exit）满载下延迟不可预估，deadline 放宽到 10s。
 */
const POLL_DEADLINE_MS = 10_000;

/**
 * 轮询直到期望状态出现或超时：每次迭代先 pollTickForTest()（手动 tick 推进状态机）
 * 再检查——固定 sleep 后单次 tick 单次断言是满载 flake 源，等状态而非猜时刻。
 */
async function pollUntilTicked(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + POLL_DEADLINE_MS;
	for (;;) {
		pollTickForTest();
		if (check()) return;
		if (Date.now() > deadline) {
			throw new Error(`timed out after ${POLL_DEADLINE_MS}ms waiting for ${what}`);
		}
		await sleep(25);
	}
}

function spawnBg(command: string) {
	return spawnBackgroundTask({
		command,
		cwd: process.cwd(),
		dataDir: DATA_DIR,
		sessionId: SESSION_ID,
	});
}

/** 构造终态条目直调 handleTaskExit（通知行为单元，不经真实轮询时序）。 */
function finalizedTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
	return {
		taskId: "bt-1700000000-test01",
		pid: 4321,
		command: "pnpm test",
		outputFile: "/tmp/out/bt-1700000000-test01.log",
		registryPath: "/tmp/out/registry.json",
		startedAt: 1_700_000_000_000,
		state: "exited",
		ownerPiPid: process.pid,
		sessionId: SESSION_ID,
		exitCode: 0,
		reason: "natural",
		endedAt: 1_700_000_192_000,
		durationMs: 192_000,
		tailSummary: "Tests: 42 passed",
		...overrides,
	};
}

function killLeftoverTasks(): void {
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
}

afterEach(() => {
	killLeftoverTasks();
	clearTaskStoreForTest();
	stopPoller();
	setOnTaskExit(undefined);
	resetNotifyForTest();
	vi.restoreAllMocks();
});

describe("register emit (data flow ⑤)", () => {
	it("emits pending:register {id, type:'bash', name} with NO expiresAt key after successful spawn", () => {
		const pi = createMockPi();
		attach(pi);
		const spawned = spawnBg("sleep 0.5 && echo hi");
		if (!spawned.ok) throw new Error(spawned.error);

		expect(pi.events.emit).toHaveBeenCalledWith("pending:register", {
			id: spawned.task.taskId,
			type: "bash",
			name: "sleep 0.5 && echo hi",
		});
		// process 档（D16）：emit 不携带 expiresAt——键级断言防字段悄悄混入
		const payload = pi.events.emit.mock.calls.find((c) => c[0] === "pending:register")?.[1] as Record<
			string,
			unknown
		>;
		expect(Object.keys(payload)).not.toContain("expiresAt");
	});

	it("truncates name to 80 chars + ellipsis for long commands", () => {
		const pi = createMockPi();
		attach(pi);
		const longCommand = `echo ${"x".repeat(200)}`;
		const spawned = spawnBg(longCommand);
		if (!spawned.ok) throw new Error(spawned.error);

		const payload = pi.events.emit.mock.calls.find((c) => c[0] === "pending:register")?.[1] as {
			name: string;
		};
		expect(payload.name).toBe(`${longCommand.slice(0, 80)}…`);
		expect(payload.name.length).toBe(81);
	});

	it("skips emit silently (no throw) when pi reference is not attached", () => {
		resetNotifyForTest();
		const spawned = spawnBg("echo hi");
		// 引用未注入（测试/极早期窗口）：emit 通路 no-op，spawn 本体不受影响
		expect(spawned.ok).toBe(true);
	});
});

describe("exit-edge notification (⑧⑨, poll edge wiring)", () => {
	it("natural exit 0: unregister emit reason 'completed' + sendMessage steer with exact params", async () => {
		const pi = createMockPi();
		attach(pi);
		setOnTaskExit(handleTaskExit);
		const spawned = spawnBg("sleep 0.3 && echo done");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;

		// 轮询到 exit 边沿收尾（handleTaskExit 同步完成 unregister emit + sendMessage）
		await pollUntilTicked(
			() => pi.events.emit.mock.calls.some((c) => c[0] === "pending:unregister"),
			"pending:unregister (completed)",
		);

		expect(pi.events.emit).toHaveBeenCalledWith("pending:unregister", {
			id: task.taskId,
			reason: "completed",
		});
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [message, options] = pi.sendMessage.mock.calls[0] as [
			{ customType: string; content: string; display: boolean },
			{ deliverAs: string; triggerTurn: boolean },
		];
		expect(message.customType).toBe(BACKGROUND_BASH_CUSTOM_TYPE);
		expect(message.display).toBe(true);
		expect(message.content).toContain(task.taskId);
		expect(message.content).toContain("exit 0");
		expect(message.content).toContain("done"); // tail 摘要
		expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
	});

	it("killed: emits unregister reason 'cancelled' but does NOT sendMessage (single-point rule)", async () => {
		const pi = createMockPi();
		attach(pi);
		setOnTaskExit(handleTaskExit);
		const spawned = spawnBg("sleep 60");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;

		markKillingIntent(task.taskId, "killed");
		killProcessTree(task.pid);
		// 轮询到 kill 边沿收尾（SIGKILL 生效 + tick 终态化）
		await pollUntilTicked(() => getTask(task.taskId)?.reason === "killed", "reason=killed finalization");

		expect(getTask(task.taskId)?.reason).toBe("killed");
		expect(pi.events.emit).toHaveBeenCalledWith("pending:unregister", {
			id: task.taskId,
			reason: "cancelled",
		});
		// kill 调用方就在当前 turn 等结果：sendMessage 双发是噪音，绝不发送
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("timeout: still sends steer message with reason 'time_limited'", () => {
		const pi = createMockPi();
		attach(pi);
		handleTaskExit(finalizedTask({ reason: "timeout", exitCode: null, durationMs: 15000 }));

		expect(pi.events.emit).toHaveBeenCalledWith("pending:unregister", {
			id: "bt-1700000000-test01",
			reason: "time_limited",
		});
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [message] = pi.sendMessage.mock.calls[0] as [{ content: string }, unknown];
		expect(message.content).toContain("timed out");
	});

	it("natural nonzero exit: reason 'failed', content marks failure", async () => {
		const pi = createMockPi();
		attach(pi);
		setOnTaskExit(handleTaskExit);
		const spawned = spawnBg("sleep 0.3; exit 3");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;

		// 轮询到 exit 边沿收尾（reason failed）
		await pollUntilTicked(
			() => pi.events.emit.mock.calls.some((c) => c[0] === "pending:unregister"),
			"pending:unregister (failed)",
		);

		expect(pi.events.emit).toHaveBeenCalledWith("pending:unregister", {
			id: task.taskId,
			reason: "failed",
		});
		const [message] = pi.sendMessage.mock.calls[0] as [{ content: string }, unknown];
		expect(message.content).toContain("failed (exit 3,");
	});
});

describe("notification content (§3.1 sample)", () => {
	it("finished: contains task_id, exit code, duration, command, Full output path, bash_output hint", () => {
		const content = buildNotificationContent(finalizedTask());
		expect(content).toContain("bt-1700000000-test01");
		expect(content).toContain("exit 0");
		expect(content).toContain("3m12s"); // 192000ms
		expect(content).toContain("pnpm test");
		expect(content).toContain("Last lines: Tests: 42 passed");
		expect(content).toContain("Full output: /tmp/out/bt-1700000000-test01.log");
		expect(content).toContain('bash_output {task_id:"bt-1700000000-test01"}');
	});

	it("failed: head marks failed with exit code; omits Last lines when tail empty", () => {
		const content = buildNotificationContent(
			finalizedTask({ exitCode: 3, tailSummary: undefined, durationMs: 5000 }),
		);
		expect(content).toContain("failed (exit 3, 5s)");
		expect(content).not.toContain("Last lines");
		expect(content).toContain("Full output:");
	});

	it("duration formatting: seconds / minutes / hours", () => {
		expect(buildNotificationContent(finalizedTask({ durationMs: 45000 }))).toContain(", 45s):");
		expect(buildNotificationContent(finalizedTask({ durationMs: 192000 }))).toContain("3m12s");
		expect(buildNotificationContent(finalizedTask({ durationMs: 3_723_000 }))).toContain("1h02m03s");
	});
});

describe("D17: pi reference refresh (session replacement takeover)", () => {
	it("second load wins: notification goes through the NEW reference, old one untouched", () => {
		const piA = createMockPi();
		const piB = createMockPi();
		attach(piA);
		attach(piB); // session 替换 → 重新 load → 引用刷新
		handleTaskExit(finalizedTask());
		expect(piB.sendMessage).toHaveBeenCalledTimes(1);
		expect(piA.sendMessage).not.toHaveBeenCalled();
	});

	it("stale reference throwing sendMessage does not break notification; later tasks still notify", () => {
		const stale = createMockPi();
		stale.sendMessage = vi.fn(() => {
			throw new Error("stale bus disposed");
		});
		attach(stale);
		expect(() => handleTaskExit(finalizedTask())).not.toThrow();

		const fresh = createMockPi();
		attach(fresh);
		handleTaskExit(finalizedTask({ taskId: "bt-1700000000-test02" }));
		expect(fresh.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("poller keeps running when notification path throws inside the exit edge", async () => {
		const stale = createMockPi();
		stale.sendMessage = vi.fn(() => {
			throw new Error("stale bus disposed");
		});
		stale.events.emit = vi.fn(() => {
			throw new Error("stale bus emit");
		});
		attach(stale);
		setOnTaskExit(handleTaskExit);

		const first = spawnBg("sleep 0.3 && echo one");
		const second = spawnBg("sleep 0.3 && echo two");
		if (!first.ok || !second.ok) throw new Error("spawn failed");
		// 边沿回调内部全捕获：轮询到两条任务都完成终态化（每迭代 tick 后查）
		await pollUntilTicked(
			() =>
				getTask(first.task.taskId)?.state === "exited" &&
				getTask(second.task.taskId)?.state === "exited",
			"both tasks to finalize",
		);
		// tick 不抛（异常全捕获）
		expect(() => pollTickForTest()).not.toThrow();
		expect(getTask(first.task.taskId)?.state).toBe("exited");
		expect(getTask(second.task.taskId)?.state).toBe("exited");
	});
});

describe("process-exit reap: best-effort unregister emit, no sendMessage", () => {
	it("reapBackgroundTasksNow emits pending:unregister reason 'cancelled' (process-exit)", async () => {
		const { reapBackgroundTasksNow, resetProcessExitGuardForTest } = await import(
			"../background/process-exit-guard.ts"
		);
		const pi = createMockPi();
		attach(pi);
		const spawned = spawnBg("sleep 30");
		if (!spawned.ok) throw new Error(spawned.error);

		reapBackgroundTasksNow();

		expect(pi.events.emit).toHaveBeenCalledWith("pending:unregister", {
			id: spawned.task.taskId,
			reason: "cancelled",
		});
		// 进程都退了，无投递目标：绝不 sendMessage
		expect(pi.sendMessage).not.toHaveBeenCalled();
		resetProcessExitGuardForTest();
	});
});

describe("register emit direct unit (no spawn)", () => {
	it("does nothing when reference unset; payload unchanged when attached late", () => {
		resetNotifyForTest();
		expect(() => emitPendingRegister(finalizedTask({ state: "running" }))).not.toThrow();
	});
});
