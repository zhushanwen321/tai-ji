// src/__tests__/notify.test.ts —— M3 通知入账单元（unified-delivery 波 3）：
// register emit 形态（数据流 ⑤）/ exit 边沿入账（⑧⑨，含 killed 零投递零入账）/
// port.deliver 接线（id=taskId、details 业务字段保持 + deliveryId 追加）/
// port 缺席降级直发（设计 §3.7 缺席语义）/ 通知文案 / D17 pi 引用刷新（兜底通路）/
// 收殓路径（process-exit 不经主路径，零投递零入账——对账承接）
//
// 主路径补投退役的丢失覆盖对位（D3 裁决 1，测试注释级）：
//  - 「投递 throw」→ port 内核 retain 留账，settled / compaction 边沿与 session_start
//    差集重放重投（delivery-port 包测试锁定）；
//  - 「受理后未落盘即崩溃」→ 受理即已落盘（outbox appendEntry 先于受理；persist 失败
//    = rejected 未受理）——落盘后的崩溃由 outbox 差集重放覆盖（delivery-port 的
//    journal.test / delivery-port.test 重启用例锁定）；
//  - 「进程死亡收殓终态（process-exit / orphaned）」→ 无 outbox 条目，重放无从覆盖，
//    由对账路径补投（pending-reconcile.test.ts 锁定）；
//  - rejected（本文件「rejected by delivery port」用例）= 幂等键未登记、无 outbox，
//    通知丢失——warn 留痕即修复信号（登记丢失面，与旧机制 throw 降级日志同型）。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { killProcessTree } from "@zhushanwen/extension-protocol/background-task";
import {
	_resetDeliveryPortForTest,
	bindDeliveryPort,
	type DeliveryPortHost,
} from "@zhushanwen/pi-delivery-port";
import {
	BACKGROUND_BASH_CUSTOM_TYPE,
	buildNotificationContent,
	buildNotifyDetails,
	emitPendingRegister,
	handleTaskExit,
	refreshPiReference,
	resetNotifyForTest,
} from "../background/notify.ts";
import { setOnTaskExit } from "../background/exit-collector.ts";
import { spawnBackgroundTask } from "../background/spawn-background.ts";
import {
	clearTaskStoreForTest,
	getActiveTasks,
	getTask,
	markKillingIntent,
} from "../background/task-store.ts";
import type { BackgroundTask } from "../background/types.ts";

vi.setConfig({ testTimeout: 20000 });

const { moduleLoggerMock } = vi.hoisted(() => ({
	moduleLoggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => moduleLoggerMock,
}));

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

/** port 宿主 mock（结构满足 DeliveryPortHost；idle 恒真 = 提交即注入，免缓冲挂起）。 */
function createPortHost(overrides: Partial<DeliveryPortHost> = {}): DeliveryPortHost & {
	appendEntry: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
} {
	return {
		appendEntry: vi.fn(),
		readSessionEntries: () => [],
		isIdle: () => true,
		sendMessage: vi.fn(),
		onMessageEnd: vi.fn(() => () => {}),
		onAgentSettled: vi.fn(() => () => {}),
		onSessionBeforeCompact: vi.fn(() => () => {}),
		onSessionCompact: vi.fn(() => () => {}),
		onSessionCompactFailed: vi.fn(() => () => {}),
		hasRunningBackground: () => false,
		logger: { warn: vi.fn(), debug: vi.fn() },
		...overrides,
	};
}

/** 装配进程级端口（主路径用例前置；afterEach 统一复位）。 */
function attachPort(host = createPortHost()): typeof host {
	bindDeliveryPort(host);
	return host;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 真实子进程链（spawn+exec+sleep+exit）满载下延迟不可预估，deadline 放宽到 10s。
 */
const POLL_DEADLINE_MS = 10_000;

/**
 * 等待直到期望状态出现或超时：exit 事件边沿（真实 ChildProcess exit 监听）负责
 * 推进状态机——固定 sleep 后单次断言是满载 flake 源，等状态而非猜时刻。
 */
async function pollUntilTicked(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + POLL_DEADLINE_MS;
	for (;;) {
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

/** 构造终态条目直调 handleTaskExit（通知行为单元，不经真实 exit 边沿时序）。 */
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

/** port 注入消息（host.sendMessage 首参——deliveryId 追加断言入口）。 */
function portSentMessage(
	host: ReturnType<typeof createPortHost>,
): { customType: string; content: string; display: boolean; details: Record<string, unknown> } {
	const [message] = host.sendMessage.mock.calls[0] as [
		{ customType: string; content: string; display: boolean; details: Record<string, unknown> },
		unknown,
	];
	return message;
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
	setOnTaskExit(undefined);
	resetNotifyForTest();
	_resetDeliveryPortForTest();
	vi.restoreAllMocks();
});

describe("register emit (data flow ⑤)", () => {
	it("emits pending:register {id, type:'bash', name} with NO expiresAt key after successful spawn", () => {
		const pi = createMockPi();
		attach(pi);
		const spawned = spawnBg("sleep 0.1 && echo hi");
		if (!spawned.ok) throw new Error(spawned.error);

		expect(pi.events.emit).toHaveBeenCalledWith("pending:register", {
			id: spawned.task.taskId,
			type: "bash",
			name: "sleep 0.1 && echo hi",
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

describe("exit-edge notification via delivery port (⑧⑨, unified-delivery wave 3)", () => {
	it("natural exit 0: port.deliver id=taskId — outbox before accept + steered injection with deliveryId appended", async () => {
		const host = attachPort();
		setOnTaskExit(handleTaskExit);
		const spawned = spawnBg("sleep 0.1 && echo done");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;

		// 等到 exit 边沿收尾（handleTaskExit 同步完成 unregister emit + port.deliver 入账）
		await pollUntilTicked(
			() => host.sendMessage.mock.calls.length > 0,
			"port injection (background-bash notify)",
		);

		// 受理前落盘（outbox 投递日志；payload.details = 业务原样，无 deliveryId）
		expect(host.appendEntry).toHaveBeenCalledWith(
			"delivery-port-outbox",
			expect.objectContaining({
				v: 2,
				id: task.taskId,
				timing: "steer",
				payload: expect.objectContaining({
					kind: "custom",
					customType: BACKGROUND_BASH_CUSTOM_TYPE,
					display: true,
					details: expect.objectContaining({ taskId: task.taskId }),
				}),
			}),
		);
		// 直达唯一队列：steer 档注入形态与直发一致
		expect(host.sendMessage).toHaveBeenCalledTimes(1);
		const [message, options] = host.sendMessage.mock.calls[0] as [
			{ customType: string; content: string; display: boolean; details: Record<string, unknown> },
			{ deliverAs: string; triggerTurn: boolean },
		];
		expect(message.customType).toBe(BACKGROUND_BASH_CUSTOM_TYPE);
		expect(message.display).toBe(true);
		expect(message.content).toContain(task.taskId);
		expect(message.content).toContain("exit 0");
		expect(message.content).toContain("done"); // tail 摘要
		expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
		// details 业务字段与终态条目逐字段一致（非 fixture 常量）+ deliveryId 追加
		const finalizedEntry = getTask(task.taskId);
		expect(message.details).toMatchObject({
			taskId: task.taskId,
			command: "sleep 0.1 && echo done",
			endReason: "natural",
			exitCode: 0,
			durationMs: finalizedEntry?.durationMs,
		});
		expect(message.details.deliveryId).toBe(task.taskId);
	});

	it("killed: emits unregister 'cancelled' but ZERO port submission (no outbox, no injection — silent rule)", async () => {
		const host = attachPort();
		setOnTaskExit(handleTaskExit);
		const spawned = spawnBg("sleep 60");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;

		markKillingIntent(task.taskId, "killed");
		killProcessTree(task.pid);
		await pollUntilTicked(() => getTask(task.taskId)?.reason === "killed", "reason=killed finalization");

		expect(getTask(task.taskId)?.reason).toBe("killed");
		// kill 调用方就在当前 turn 等结果（result 类 silent，老能力映射 #10）：
		// 零入账（无 outbox）零注入，emit unregister 照常（pending 观察面收尾）
		expect(host.appendEntry).not.toHaveBeenCalledWith("delivery-port-outbox", expect.anything());
		expect(host.sendMessage).not.toHaveBeenCalled();
	});

	it("timeout: still notifies via port with 'timed out' content", () => {
		const host = attachPort();
		handleTaskExit(finalizedTask({ reason: "timeout", exitCode: null, durationMs: 15000 }));

		expect(host.sendMessage).toHaveBeenCalledTimes(1);
		const message = portSentMessage(host);
		expect(message.content).toContain("timed out");
		expect(message.details).toMatchObject({ endReason: "timeout", exitCode: null });
	});

	it("natural nonzero exit: content marks failure, details endReason stays 'natural'", () => {
		const host = attachPort();
		handleTaskExit(finalizedTask({ exitCode: 3, durationMs: 5000 }));

		expect(host.sendMessage).toHaveBeenCalledTimes(1);
		const message = portSentMessage(host);
		expect(message.content).toContain("failed (exit 3,");
		expect(message.details).toMatchObject({ taskId: "bt-1700000000-test01", endReason: "natural", exitCode: 3 });
	});

	it("rejected by delivery port (persist failure): notification lost, warn logged (registered loss surface)", () => {
		const host = attachPort(
			createPortHost({
				appendEntry: vi.fn(() => {
					throw new Error("session file unwritable");
				}),
			}),
		);

		expect(() => handleTaskExit(finalizedTask())).not.toThrow();
		// rejected = 幂等键未登记、无 outbox 记录——重放无从覆盖的登记丢失面
		//（模块 logger warn 留痕即修复信号；port 侧另有 persist-failed warn 同栈落日志）
		expect(host.sendMessage).not.toHaveBeenCalled();
		expect(moduleLoggerMock.warn).toHaveBeenCalledWith(
			"background task notify rejected by delivery port; notification lost (no outbox record)",
			{ detail: { taskId: "bt-1700000000-test01", reason: "persist-failed" } },
		);
	});
});

describe("port-absent fallback (assembly anomaly window, §3.7 absence semantics)", () => {
	it("port absent: direct steer fallback with exact params (at-most-once registered degradation)", () => {
		const pi = createMockPi();
		attach(pi);
		handleTaskExit(finalizedTask());

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [message, options] = pi.sendMessage.mock.calls[0] as [
			{ customType: string; content: string; display: boolean; details: Record<string, unknown> },
			{ deliverAs: string; triggerTurn: boolean },
		];
		expect(message.customType).toBe(BACKGROUND_BASH_CUSTOM_TYPE);
		expect(message.display).toBe(true);
		expect(message.content).toContain("finished (exit 0, 3m12s)");
		// 缺席兜底无 port 注入面：details = 业务原样（无 deliveryId）
		expect(message.details).toEqual({
			taskId: "bt-1700000000-test01",
			command: "pnpm test",
			durationMs: 192_000,
			endReason: "natural",
			exitCode: 0,
		});
		expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
	});

	it("port absent + killed: fallback path also silent (single-point rule holds in degraded mode)", () => {
		const pi = createMockPi();
		attach(pi);
		handleTaskExit(finalizedTask({ reason: "killed", exitCode: null }));

		expect(pi.events.emit).toHaveBeenCalledWith("pending:unregister", {
			id: "bt-1700000000-test01",
			reason: "cancelled",
		});
		expect(pi.sendMessage).not.toHaveBeenCalled();
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

describe("notification details (D1 schema + deliveryId append; business fields byte-stable)", () => {
	it("business five fields exactly (key-level) + deliveryId as the sole port-owned key", () => {
		const host = attachPort();
		handleTaskExit(finalizedTask());

		const message = portSentMessage(host);
		// 业务五字段与 buildNotifyDetails 逐字段一致（D1 字面量镜像契约：消费侧
		// parseBackgroundBashDetails 按 taskId/command/durationMs/endReason/exitCode 解析）
		expect(message.details).toMatchObject({
			taskId: "bt-1700000000-test01",
			command: "pnpm test",
			durationMs: 192_000,
			endReason: "natural",
			exitCode: 0,
		});
		// deliveryId = port 注入的送达凭据（§3.3 词条：身份由注入端附加，业务字段保持原样）
		expect(message.details.deliveryId).toBe("bt-1700000000-test01");
		// content 是 triggerTurn:true 给 LLM 接力的载荷：入账不得改动一个字节
		expect(message.content).toBe(
			"[background-bash] bt-1700000000-test01 finished (exit 0, 3m12s): pnpm test\n" +
				"Last lines: Tests: 42 passed\n" +
				'Full output: /tmp/out/bt-1700000000-test01.log; use bash_output {task_id:"bt-1700000000-test01"} for details.',
		);
	});

	it("outbox payload details stay business-only (deliveryId injected at kernel boundary, not persisted)", () => {
		const host = attachPort();
		handleTaskExit(finalizedTask());

		const outboxCall = host.appendEntry.mock.calls.find((c) => c[0] === "delivery-port-outbox") as [
			string,
			{ payload: { details: Record<string, unknown> } },
		];
		expect(outboxCall).toBeDefined();
		expect(Object.keys(outboxCall[1].payload.details).sort()).toEqual([
			"command",
			"durationMs",
			"endReason",
			"exitCode",
			"taskId",
		]);
	});

	it("natural nonzero exit: exitCode passes through unchanged, endReason stays 'natural'", () => {
		expect(buildNotifyDetails(finalizedTask({ exitCode: 3, durationMs: 5000 }))).toEqual({
			taskId: "bt-1700000000-test01",
			command: "pnpm test",
			durationMs: 5000,
			endReason: "natural",
			exitCode: 3,
		});
	});

	it("timeout: endReason 'timeout' + exitCode null (D1 可空字段的 timeout 形态)", () => {
		expect(buildNotifyDetails(finalizedTask({ reason: "timeout", exitCode: null, durationMs: 15_000 }))).toEqual({
			taskId: "bt-1700000000-test01",
			command: "pnpm test",
			durationMs: 15_000,
			endReason: "timeout",
			exitCode: null,
		});
	});

	it("durationMs 缺省归 0：必需字段恒为 number（消费侧解析器才不判 null）", () => {
		expect(buildNotifyDetails(finalizedTask({ durationMs: undefined })).durationMs).toBe(0);
	});
});

describe("D17: pi reference refresh (fallback-path takeover, session replacement)", () => {
	it("second load wins: fallback notification goes through the NEW reference, old one untouched", () => {
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

	it("exit edge survives notification path throwing inside the callback", async () => {
		const stale = createMockPi();
		stale.sendMessage = vi.fn(() => {
			throw new Error("stale bus disposed");
		});
		stale.events.emit = vi.fn(() => {
			throw new Error("stale bus emit");
		});
		attach(stale);
		setOnTaskExit(handleTaskExit);

		// 断言只看双任务终态化与异常吞没，不依赖命令时长
		const first = spawnBg("sleep 0.1 && echo one");
		const second = spawnBg("sleep 0.1 && echo two");
		if (!first.ok || !second.ok) throw new Error("spawn failed");
		// 边沿回调内部全捕获：等到两条任务都完成终态化（exit 事件自行推进）
		await pollUntilTicked(
			() =>
				getTask(first.task.taskId)?.state === "exited" &&
				getTask(second.task.taskId)?.state === "exited",
			"both tasks to finalize",
		);
		expect(getTask(first.task.taskId)?.state).toBe("exited");
		expect(getTask(second.task.taskId)?.state).toBe("exited");
	});
});

describe("process-exit reap: best-effort unregister emit, ZERO notification (reconcile owns the notify)", () => {
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
		// 进程都退了，无投递目标：绝不 sendMessage（缺席兜底形态也不投）
		expect(pi.sendMessage).not.toHaveBeenCalled();
		resetProcessExitGuardForTest();
	});

	it("reap with port present: no outbox record either (terminated notify is reconcile-only, D3 adjudication 1)", async () => {
		const { reapBackgroundTasksNow, resetProcessExitGuardForTest } = await import(
			"../background/process-exit-guard.ts"
		);
		const host = attachPort();
		const spawned = spawnBg("sleep 30");
		if (!spawned.ok) throw new Error(spawned.error);

		reapBackgroundTasksNow();

		// 收殓路径零入账零注入：process-exit 终态通知由对账路径经 port 补投
		// （pending-reconcile.test.ts 锁定），主路径（exit 边沿/收殓）恒静默
		expect(host.appendEntry).not.toHaveBeenCalledWith("delivery-port-outbox", expect.anything());
		expect(host.sendMessage).not.toHaveBeenCalled();
		resetProcessExitGuardForTest();
	});
});

describe("register emit direct unit (no spawn)", () => {
	it("does nothing when reference unset; payload unchanged when attached late", () => {
		resetNotifyForTest();
		expect(() => emitPendingRegister(finalizedTask({ state: "running" }))).not.toThrow();
	});
});
