// src/__tests__/pending-reconcile.test.ts —— M3 session_start 对账单元（§3.5 接入细则 4）
// + 完成通知补投执行器（bg-task-notify-durability 设计 §5 U2/U3）：
//  - bt- 差集（protocol collectActivePendingIds 单点消费）/ 三类僵尸场景 appendEntry
//    权威路径（唯一写路径，无 emit）/ 活任务与缺条目保守跳过
//  - 补投：严格终态（isTerminalState，killed reason 级排除）× 投递成败 × 单/多任务
//    文案矩阵、双锚判重、双派发幂等（in-flight 单飞守卫 + 同步补投标记）、失败路径
//    不写标记下次激活重试
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	BACKGROUND_TASK_ID_PREFIX,
	collectActivePendingIds,
	mapReasonToStatus,
} from "@zhushanwen/extension-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
}));

import {
	reconcilePendingEntries,
	resetRedeliveryInFlightForTest,
	type ReconcilePi,
} from "../background/pending-reconcile.ts";
import { BACKGROUND_BASH_CUSTOM_TYPE } from "../background/notify.ts";
import { RECONCILED_MARKER_CUSTOM_TYPE } from "../background/notify-reconcile-judgement.ts";
import { getRegistryPath, writeRegistryEntry } from "../background/registry.ts";
import type { RegistryEntry } from "../background/types.ts";

const DATA_DIR = mkdtempSync(join(tmpdir(), "bte-reconcile-"));
const SESSION_ID = "sess-reconcile";

type SendMessageMessage = { customType: string; content: string; display: boolean; details?: unknown };

function createMockPi(
	overrides: Partial<Pick<ReconcilePi, "appendEntry" | "sendMessage">> = {},
): ReconcilePi & {
	events: { emit: ReturnType<typeof vi.fn> };
} {
	return {
		appendEntry: vi.fn(),
		sendMessage: vi.fn<[], void | Promise<void>>(),
		// emit 路径已随 ext-simplify-13 删除（恒 no-op 死路径）：events spy 仅用于
		// 断言实现不再触达 bus emit
		events: { emit: vi.fn() },
		...overrides,
	};
}

function makeRegistryEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
	return {
		taskId: "bt-1700000000-zomb01",
		pid: 99999,
		command: "sleep 3600",
		outputFile: "/tmp/out.log",
		startedAt: 1_700_000_000_000,
		state: "orphaned",
		ownerPiPid: 1,
		sessionId: SESSION_ID,
		...overrides,
	};
}

/** 已死 pid：spawnSync 同步等待退出 + libuv reap，返回时 pid 必已终止。 */
function deadPid(): number {
	const result = spawnSync("true");
	if (result.pid === undefined) throw new Error("no pid acquired for dead-pid probe");
	return result.pid;
}

function registerEntry(id: string) {
	return { customType: "pending:register", data: { id, type: "bash", name: "sleep 3600" } };
}

/** 送达消息 entry（custom_message 落盘形态，供双锚判重的「痕迹在」用例）。 */
function deliveredEntry(taskId: string) {
	return {
		type: "custom_message",
		customType: BACKGROUND_BASH_CUSTOM_TYPE,
		content: `[background-bash] ${taskId} finished (exit 0, 5s): pnpm test`,
		details: { taskId },
		display: true,
	};
}

function reconciledMarkerEntry(taskId: string) {
	return { type: "custom", customType: RECONCILED_MARKER_CUSTOM_TYPE, data: { taskId, reconciledAt: 1 } };
}

afterEach(() => {
	rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	resetRedeliveryInFlightForTest();
	vi.clearAllMocks();
});

describe("bt- diff via protocol collectActivePendingIds (single-source diff core)", () => {
	// 差集本体单点在 protocol pending-entries（ext-simplify-13 D3，与 pending 守卫
	// 判据同源）；此处锁定 bte 对账消费面的语义（idPrefix = BACKGROUND_TASK_ID_PREFIX）
	it("collects bt- registers without a matching unregister", () => {
		const ids = collectActivePendingIds(
			[
				registerEntry("bt-a"),
				registerEntry("bt-b"),
				{ customType: "pending:unregister", data: { id: "bt-b", reason: "completed" } },
			],
			{ idPrefix: BACKGROUND_TASK_ID_PREFIX },
		);
		expect([...ids]).toEqual(["bt-a"]);
	});

	it("ignores non-bt ids (subagent bg-/run- namespace not ours)", () => {
		const ids = collectActivePendingIds(
			[registerEntry("bg-1"), registerEntry("run-x-1"), registerEntry("bt-a")],
			{ idPrefix: BACKGROUND_TASK_ID_PREFIX },
		);
		expect([...ids]).toEqual(["bt-a"]);
	});

	it("dedupes repeated registers and tolerates malformed entries", () => {
		const ids = collectActivePendingIds(
			[
				null,
				undefined,
				{ customType: "pending:register" }, // data 缺失
				{ customType: "pending:register", data: { id: 42 } }, // id 非字符串
				registerEntry("bt-a"),
				registerEntry("bt-a"),
				{ customType: "other" },
			],
			{ idPrefix: BACKGROUND_TASK_ID_PREFIX },
		);
		expect([...ids]).toEqual(["bt-a"]);
	});

	it("register→unregister→register same id stays settled (global cancellation, §5.4①)", () => {
		const ids = collectActivePendingIds(
			[
				registerEntry("bt-a"),
				{ customType: "pending:unregister", data: { id: "bt-a", reason: "completed" } },
				registerEntry("bt-a"),
			],
			{ idPrefix: BACKGROUND_TASK_ID_PREFIX },
		);
		expect(ids.size).toBe(0);
	});
});

describe("reconcile scenario ①: graceful-exit leftover (registry exited, entry never written)", () => {
	it("appends pending:unregister {id, reason, status} matching pending-notifications entry shape", async () => {
		const entry = makeRegistryEntry({
			taskId: "bt-1700000000-zomb01",
			state: "exited",
			reason: "natural",
			exitCode: 0,
		});
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);

		expect(result.reconciled).toBe(1);
		// 落盘形态逐字段对齐 pending-notifications index.ts unregister listener：{id, reason, status}
		expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
			id: entry.taskId,
			reason: "completed",
			status: "completed",
		});
	});

	it("maps exited reason/exitCode through the same mapping as the exit edge", async () => {
		const cases: Array<[RegistryEntry, string]> = [
			[makeRegistryEntry({ state: "exited", reason: "natural", exitCode: 3 }), "failed"],
			[makeRegistryEntry({ state: "exited", reason: "timeout", exitCode: null }), "time_limited"],
			[makeRegistryEntry({ state: "exited", reason: "killed", exitCode: null }), "cancelled"],
			[makeRegistryEntry({ state: "exited", reason: "process-exit", exitCode: null }), "cancelled"],
		];
		for (const [entry, expectedReason] of cases) {
			writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
			const pi = createMockPi();
			await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);
			// status 断言按「权威映射(reason)」而非 reason 本身表述（D10：identity 假设消除）
			expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
				id: entry.taskId,
				reason: expectedReason,
				status: mapReasonToStatus(expectedReason),
			});
		}
	});
});

describe("entry status maps via protocol mapReasonToStatus (D10 single-source, identity assumption removed)", () => {
	// bte 写侧 status 与 pending-notifications unregister listener 同引 protocol 单点
	// （ext-simplify-17 D10）——原 status: reason 的 identity 假设在非 identity reason
	// （budget_limited→failed 等）上会静默漂移，映射表演化时两写侧不再可能分叉。
	// settle 产域四值当前恰为 identity 映射，但断言面按「status === mapReasonToStatus
	// (reason)」表述：映射表日后改任何一行的口径，本组用例随实现同源自洽。
	it("appended status equals the authoritative mapping for every reason the settle path can produce", () => {
		// settledPendingReason 全产域：exited 三分支（natural/timeout/killed|process-exit
		// 经 toPendingReason）+ orphaned/判死兜底 cancelled + reason 缺失防御分支
		const settleReasons = ["completed", "failed", "time_limited", "cancelled"] as const;
		for (const reason of settleReasons) {
			expect(mapReasonToStatus(reason)).toBe(reason); // 当前口径下四值均为 identity 映射
		}
	});

	it("non-identity reasons exist in the authoritative mapping — identity assumption is provably gone", () => {
		// 这些 reason 上 status ≠ reason 本身：若写侧仍持 identity 假设（status: reason），
		// settle 产域将来扩展到这些值时落盘 entry 会静默漂移；现实现单点映射自动正确
		expect(mapReasonToStatus("budget_limited")).toBe("failed");
		expect(mapReasonToStatus("interrupted")).toBe("aborted");
		expect(mapReasonToStatus("interrupted-by-restart")).toBe("aborted");
		expect(mapReasonToStatus("interrupted-by-parent")).toBe("aborted");
		expect(mapReasonToStatus("reopened")).toBe("completed");
		expect(mapReasonToStatus("some-future-reason")).toBe("completed");
	});
});

describe("reconcile scenario ②: collector-only orphan (registry orphaned, session file untouched)", () => {
	it("appends unregister with cancelled for orphaned entries", async () => {
		const entry = makeRegistryEntry({ state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);

		expect(result.reconciled).toBe(1);
		expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
			id: entry.taskId,
			reason: "cancelled",
			status: "cancelled",
		});
	});
});

describe("reconcile scenario ③: running entry whose pid is already dead (fact-terminal)", () => {
	it("appends unregister with cancelled when kill(pid,0) says dead", async () => {
		const entry = makeRegistryEntry({ state: "running", pid: deadPid() });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);

		expect(result.reconciled).toBe(1);
		expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
			id: entry.taskId,
			reason: "cancelled",
			status: "cancelled",
		});
	});
});

describe("conservative no-op paths", () => {
	it("running entry with LIVE pid is not settled (D12 task survives session replacement)", async () => {
		const entry = makeRegistryEntry({ state: "running", pid: process.pid }); // 当前测试进程 = 活 pid
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);

		expect(result.reconciled).toBe(0);
		expect(result.skipped).toEqual([entry.taskId]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("registry has no entry for the id → skip (terminal state unverifiable) + warn (decision-6 LRU observation)", async () => {
		const pi = createMockPi();
		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry("bt-unknown")]);
		expect(result.reconciled).toBe(0);
		expect(result.skipped).toEqual(["bt-unknown"]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		// 决策 6：LRU 淘汰重审触发的观测落点——warn 含 taskId（此前该形态零日志）
		expect(loggerMock.warn).toHaveBeenCalledWith(
			"pending reconcile: registry has no entry for a pending bt- id (LRU-evicted or spawn-write failure); unregister stays pending",
			{ detail: { taskId: "bt-unknown" } },
		);
	});

	it("entries with no bt- register → early no-op", async () => {
		const pi = createMockPi();
		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [
			{ customType: "pending:register", data: { id: "bg-1", type: "subagent" } },
			{ customType: "user" },
		]);
		expect(result.reconciled).toBe(0);
		expect(result.skipped).toEqual([]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("unsettled set empty (unregister already present) → no unregister write", async () => {
		const entry = makeRegistryEntry({ state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();
		// 送达消息随 entries 在（正常投递形态：unregister 由 exit 边沿写、消息已送达）——
		// 补投被痕迹锚阻断；本用例锁定「差集空 → 无 unregister 写点」的既有语义
		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [
			registerEntry(entry.taskId),
			{ customType: "pending:unregister", data: { id: entry.taskId, reason: "cancelled" } },
			deliveredEntry(entry.taskId),
		]);
		expect(result.reconciled).toBe(0);
		expect(pi.appendEntry).not.toHaveBeenCalledWith("pending:unregister", expect.anything());
	});
});

describe("best-effort emit removed (ext-simplify-13 D5: appendEntry is the sole authority)", () => {
	it("reconcile never touches pi.events (the emit path is deleted, not just disabled)", async () => {
		const entry = makeRegistryEntry({ state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		// 送达消息在（痕迹锚阻断补投）：appendEntry 恰 1 次 = 差集收尾的 unregister
		await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [
			registerEntry(entry.taskId),
			deliveredEntry(entry.taskId),
		]);

		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(pi.events.emit).not.toHaveBeenCalled();
	});
});

describe("appendEntry failure tolerance", () => {
	it("one appendEntry throw does not block the remaining zombie (count only successful)", async () => {
		const first = makeRegistryEntry({ taskId: "bt-1700000000-zomb01", state: "orphaned" });
		const second = makeRegistryEntry({ taskId: "bt-1700000000-zomb02", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), first);
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), second);
		const appendEntry = vi.fn((customType: string, data?: unknown) => {
			if (customType === "pending:unregister" && (data as { id: string }).id === first.taskId) {
				throw new Error("append failed");
			}
		});
		const pi = createMockPi({ appendEntry });

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [
			registerEntry(first.taskId),
			registerEntry(second.taskId),
		]);

		expect(result.reconciled).toBe(1); // 仅 unregister 第二条成功计数
		expect(result.skipped).toEqual([]);
	});
});

// ============================================================================
// 补投执行器（bg-task-notify-durability 设计 §5 U2，决策 1-4）
// ============================================================================

/** 终态真终态条目（exit 0 natural——补投矩阵的「真实完成」代表）。 */
function genuineExitEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
	return makeRegistryEntry({
		taskId: "bt-1700000000-genu01",
		state: "exited",
		reason: "natural",
		exitCode: 0,
		durationMs: 192_000,
		tailSummary: "Tests: 42 passed",
		...overrides,
	});
}

function lastSendMessageCall(pi: ReturnType<typeof createMockPi>): SendMessageMessage {
	expect(pi.sendMessage).toHaveBeenCalled();
	return (pi.sendMessage as ReturnType<typeof vi.fn>).mock.lastCall[0] as SendMessageMessage;
}

describe("redelivery: single-task message matrix (decision 4 three branches)", () => {
	it("single genuine exit (natural): structured message identical to main path, details carried", async () => {
		const entry = genuineExitEntry();
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, []);

		expect(result.redelivered).toEqual([entry.taskId]);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const message = lastSendMessageCall(pi);
		expect(message.customType).toBe(BACKGROUND_BASH_CUSTOM_TYPE);
		expect(message.content).toContain(`${entry.taskId} finished (exit 0, 3m12s)`);
		expect(message.content).toContain("Last lines: Tests: 42 passed");
		expect(message.content).toContain(`use bash_output {task_id:"${entry.taskId}"}`);
		// 结构化载荷与主路径 buildNotifyDetails 同源（SystemNotice 渲染正常）
		expect(message.details).toEqual({
			taskId: entry.taskId,
			command: entry.command,
			durationMs: 192_000,
			endReason: "natural",
			exitCode: 0,
		});
	});

	it("single genuine exit (timeout): details.endReason = timeout", async () => {
		const entry = genuineExitEntry({ taskId: "bt-1700000000-time01", reason: "timeout", exitCode: null, tailSummary: undefined });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, []);

		const message = lastSendMessageCall(pi);
		expect(message.content).toContain("timed out");
		expect(message.details).toMatchObject({ taskId: entry.taskId, endReason: "timeout", exitCode: null });
	});

	it("single orphaned: terminated wording, no details, no duration (decision 3)", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-orph01", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, []);

		const message = lastSendMessageCall(pi);
		expect(message.content).toContain(`${entry.taskId} was terminated when the session went down (exit code unknown)`);
		expect(message.content).toContain(`Output file: ${entry.outputFile}`);
		expect(message.content).toContain("use bash_output to check the output before rerunning");
		expect(message.details).toBeUndefined();
		// 省略时长：orphaned 的 durationMs 含属主死后滞留时长，展示误导
		expect(message.content).not.toMatch(/\d+[smh]/);
	});

	it("single exited process-exit: same terminated wording (not failed/exit unknown)", async () => {
		const entry = genuineExitEntry({ taskId: "bt-1700000000-pexit1", reason: "process-exit", exitCode: null, tailSummary: undefined });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, []);

		const message = lastSendMessageCall(pi);
		expect(message.content).toContain("was terminated when the session went down");
		expect(message.details).toBeUndefined();
		// 不谎报：收殓终止不渲染成主路径的 failed/finished 形态
		expect(message.content).not.toContain("failed (exit");
		expect(message.content).not.toContain("finished (exit");
	});
});

describe("redelivery: multi-task merge (decision 4 merge branch)", () => {
	it("multiple tasks merge into ONE message, no details, genuine-exit rows keep main-path wording", async () => {
		const natural = genuineExitEntry();
		const timeout = genuineExitEntry({
			taskId: "bt-1700000000-time02",
			reason: "timeout",
			exitCode: null,
			tailSummary: undefined,
		});
		const orphaned = makeRegistryEntry({ taskId: "bt-1700000000-orph02", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), natural);
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), timeout);
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), orphaned);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, []);

		// 合并单条：不是 N 个任务 N 条消息 N 个 turn
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(result.redelivered).toEqual([natural.taskId, timeout.taskId, orphaned.taskId]);
		const message = lastSendMessageCall(pi);
		expect(message.details).toBeUndefined();
		// 真终态行复用 buildNotificationContent 的 content 文本（禁止套 terminated 措辞谎报）
		expect(message.content).toContain(`${natural.taskId} finished (exit 0, 3m12s)`);
		expect(message.content).toContain(`${timeout.taskId} timed out`);
		expect(message.content).not.toContain(`${natural.taskId} was terminated`);
		expect(message.content).not.toContain(`${timeout.taskId} was terminated`);
		// 收殓终态行用 terminated 措辞
		expect(message.content).toContain(`${orphaned.taskId} was terminated when the session went down`);
	});
});

describe("redelivery: success settles the reconciled marker (decision 1 anchor ③)", () => {
	it("sendMessage resolve → one marker entry appended per task, synchronously", async () => {
		const first = genuineExitEntry();
		const second = makeRegistryEntry({ taskId: "bt-1700000000-orph03", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), first);
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), second);
		const pi = createMockPi();

		await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, []);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).toHaveBeenCalledWith(RECONCILED_MARKER_CUSTOM_TYPE, {
			taskId: first.taskId,
			reconciledAt: expect.any(Number),
		});
		expect(pi.appendEntry).toHaveBeenCalledWith(RECONCILED_MARKER_CUSTOM_TYPE, {
			taskId: second.taskId,
			reconciledAt: expect.any(Number),
		});
		// 补投绝不代写 pending:unregister（决策 2：收尾归差集循环唯一写点）
		expect(pi.appendEntry).not.toHaveBeenCalledWith("pending:unregister", expect.anything());
	});

	it("one marker appendEntry throw does not block the other tasks' markers", async () => {
		const first = genuineExitEntry();
		const second = makeRegistryEntry({ taskId: "bt-1700000000-orph04", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), first);
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), second);
		const appendEntry = vi.fn((customType: string, data?: unknown) => {
			if (customType === RECONCILED_MARKER_CUSTOM_TYPE && (data as { taskId: string }).taskId === first.taskId) {
				throw new Error("marker append failed");
			}
		});
		const pi = createMockPi({ appendEntry });

		await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, []);

		expect(appendEntry).toHaveBeenCalledWith(RECONCILED_MARKER_CUSTOM_TYPE, {
			taskId: second.taskId,
			reconciledAt: expect.any(Number),
		});
		// 失败可观察（含 taskId 与类别）
		expect(loggerMock.warn).toHaveBeenCalledWith(
			"background task notify reconciled marker appendEntry failed; redelivery may repeat on next session_start",
			{ detail: { taskId: first.taskId, err: "marker append failed" } },
		);
	});
});

describe("redelivery: failure paths write NO marker (retry on next session_start)", () => {
	it("synchronous sendMessage throw → warn with category, no marker", async () => {
		const entry = genuineExitEntry();
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const sendMessage = vi.fn<[], void | Promise<void>>(() => {
			throw new Error("stale bus");
		});
		const pi = createMockPi({ sendMessage });

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, []);

		expect(result.redelivered).toEqual([]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(loggerMock.warn).toHaveBeenCalledWith(
			"background task notify redelivery sendMessage threw synchronously; no marker written, retry on next session_start",
			{ detail: { taskIds: [entry.taskId], err: "stale bus" } },
		);
	});

	it("await sendMessage rejection → warn with category, no marker", async () => {
		const entry = genuineExitEntry({ taskId: "bt-1700000000-rej001" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const sendMessage = vi.fn<[], void | Promise<void>>(() => Promise.reject(new Error("agent loop failed")));
		const pi = createMockPi({ sendMessage });

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, []);

		expect(result.redelivered).toEqual([]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(loggerMock.warn).toHaveBeenCalledWith(
			"background task notify redelivery sendMessage rejected; no marker written, retry on next session_start",
			{ detail: { taskIds: [entry.taskId], err: "agent loop failed" } },
		);
	});

	it("redelivery failure does not block the pending diff pass (unconditional diff settle)", async () => {
		const entry = genuineExitEntry();
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const sendMessage = vi.fn<[], void | Promise<void>>(() => {
			throw new Error("stale bus");
		});
		const pi = createMockPi({ sendMessage });

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);

		// 差集收尾无条件执行（幂等语义不依赖补投成败）
		expect(result.reconciled).toBe(1);
		expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", expect.anything());
	});
});

describe("redelivery: exclusion criteria (decision 2 strict terminal + killed reason-level)", () => {
	it("exited reason=killed is NOT redelivered (state-level filter cannot exclude it)", async () => {
		const entry = genuineExitEntry({ taskId: "bt-1700000000-kill01", reason: "killed", exitCode: null, tailSummary: undefined });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, []);

		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(result.redelivered).toEqual([]);
	});

	it("killing leftover with dead pid is NOT redelivered (wide isTerminalByRegistry would; strict state filter refuses)", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-killg01", state: "killing", pid: deadPid() });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		// 差集侧：宽判据把 killing+判死当事实终态收尾 unregister（既有语义保持）
		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);
		expect(result.reconciled).toBe(1);
		// 补投侧：killing 遗留实为被杀任务，不补投
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("running leftover with dead pid is NOT redelivered (poller write-failure domain, unregister covers)", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-rund01", state: "running", pid: deadPid() });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		// 差集侧：宽判据把 running+判死当事实终态收尾 unregister（既有语义保持）
		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);
		expect(result.reconciled).toBe(1);
		// 补投侧：严格终态过滤排除（退化现状行为，由 unregister 收尾兜底）
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("delivered trace present (normal delivery message in entries) → no redelivery", async () => {
		const entry = genuineExitEntry();
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [deliveredEntry(entry.taskId)]);

		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(result.redelivered).toEqual([]);
	});

	it("reconciled marker present → no redelivery (cross-activation convergence)", async () => {
		const entry = genuineExitEntry({ taskId: "bt-1700000000-mark01" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [reconciledMarkerEntry(entry.taskId)]);

		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(result.redelivered).toEqual([]);
	});

	it("non-terminal-looking registry only: running with live pid and no pending diff → nothing at all", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-live01", state: "running", pid: process.pid });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, []);

		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(result.reconciled).toBe(0);
	});
});

describe("redelivery: double-dispatch idempotence (design P5, decision 1 guards)", () => {
	it("second pass after settled first pass sees the marker and skips (cross-pass convergence)", async () => {
		const entry = genuineExitEntry({ taskId: "bt-1700000000-dbl001" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);

		const firstPi = createMockPi();
		await reconcilePendingEntries(firstPi, DATA_DIR, SESSION_ID, []);
		expect(firstPi.sendMessage).toHaveBeenCalledTimes(1);

		// 双派发第二路（同激活毫秒级到达）——appendEntry 同步入账（pi dist 实证），第二路
		// 读到的 entries 已含第一路落的标记，三判据不再全命中
		const secondPi = createMockPi();
		await reconcilePendingEntries(secondPi, DATA_DIR, SESSION_ID, [reconciledMarkerEntry(entry.taskId)]);
		expect(secondPi.sendMessage).not.toHaveBeenCalled();
		expect(secondPi.appendEntry).not.toHaveBeenCalled();
	});

	it("second pass during first pass's await window sees in-flight and skips; diff pass unaffected", async () => {
		const entry = genuineExitEntry({ taskId: "bt-1700000000-infl01" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);

		// 未 resolve 的 sendMessage mock 驱动 in-flight 分支：第一路停在 await 窗口内
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sendMessage = vi.fn<[], void | Promise<void>>(() => gate);
		const firstPi = createMockPi({ sendMessage });

		const first = reconcilePendingEntries(firstPi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);
		expect(sendMessage).toHaveBeenCalledTimes(1); // 同步段已到投递点并挂起

		// 双派发第二路：in-flight 键控命中 → 补投跳过；差集循环照常收尾（跳过粒度仅补投扫描）
		const secondPi = createMockPi();
		await reconcilePendingEntries(secondPi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(secondPi.appendEntry).toHaveBeenCalledWith("pending:unregister", expect.anything());
		// 第二路未写任何补投标记
		expect(secondPi.appendEntry).not.toHaveBeenCalledWith(RECONCILED_MARKER_CUSTOM_TYPE, expect.anything());
		// 跳过记 debug（决策 6 in-flight 残留边界观测落点）
		expect(loggerMock.debug).toHaveBeenCalledWith(
			"background task notify redelivery in-flight; skipping duplicate reconcile pass",
			{ detail: { taskId: entry.taskId } },
		);

		// 第一路 settle：resolve 后同步写标记 + finally 摘除
		release();
		await first;
		expect(firstPi.appendEntry).toHaveBeenCalledWith(RECONCILED_MARKER_CUSTOM_TYPE, {
			taskId: entry.taskId,
			reconciledAt: expect.any(Number),
		});
		expect(loggerMock.debug).toHaveBeenCalledWith(
			"background task notify redelivery settled; in-flight guard released",
			{ detail: { taskId: entry.taskId } },
		);
	});

	it("in-flight guard is released after failure too (settle via finally, retry possible next pass)", async () => {
		const entry = genuineExitEntry({ taskId: "bt-1700000000-fl001" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);

		let rejectSent!: (err: Error) => void;
		const gate = new Promise<void>((_resolve, reject) => {
			rejectSent = reject;
		});
		const sendMessage = vi.fn<[], void | Promise<void>>(() => gate);
		const firstPi = createMockPi({ sendMessage });

		const first = reconcilePendingEntries(firstPi, DATA_DIR, SESSION_ID, []);
		rejectSent(new Error("agent loop failed"));
		await first;
		expect(firstPi.appendEntry).not.toHaveBeenCalled();

		// 守卫已摘除：下一次激活（失败路径未写标记，判据仍命中）可重试
		const retryPi = createMockPi();
		const retry = await reconcilePendingEntries(retryPi, DATA_DIR, SESSION_ID, []);
		expect(retryPi.sendMessage).toHaveBeenCalledTimes(1);
		expect(retry.redelivered).toEqual([entry.taskId]);
	});

	it("delivery marker dedupe is keyed by taskId: other pending tasks still redeliver in the same pass", async () => {
		const delivered = genuineExitEntry({ taskId: "bt-1700000000-have01" });
		const fresh = genuineExitEntry({ taskId: "bt-1700000000-fresh1" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), delivered);
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), fresh);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [deliveredEntry(delivered.taskId)]);

		expect(result.redelivered).toEqual([fresh.taskId]);
		const message = lastSendMessageCall(pi);
		expect(message.content).toContain(fresh.taskId);
		expect(message.content).not.toContain(`${delivered.taskId} finished`);
	});
});
