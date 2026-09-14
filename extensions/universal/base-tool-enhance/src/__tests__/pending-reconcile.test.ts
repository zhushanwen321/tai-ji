// src/__tests__/pending-reconcile.test.ts —— M3 session_start 对账单元（§3.5 接入细则 4）：
// bt- 差集（protocol collectActivePendingIds 单点消费）/ 三类僵尸场景 appendEntry
// 权威路径（唯一写路径，无 emit）/ 活任务与缺条目保守跳过
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	BACKGROUND_TASK_ID_PREFIX,
	collectActivePendingIds,
	mapReasonToStatus,
} from "@xyz-agent/extension-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	reconcilePendingEntries,
	type ReconcilePi,
} from "../background/pending-reconcile.ts";
import { getRegistryPath, writeRegistryEntry } from "../background/registry.ts";
import type { RegistryEntry } from "../background/types.ts";

const DATA_DIR = mkdtempSync(join(tmpdir(), "bte-reconcile-"));
const SESSION_ID = "sess-reconcile";

function createMockPi(overrides: Partial<Pick<ReconcilePi, "appendEntry">> = {}): ReconcilePi & {
	events: { emit: ReturnType<typeof vi.fn> };
} {
	return {
		appendEntry: vi.fn(),
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

afterEach(() => {
	rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	vi.restoreAllMocks();
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
	it("appends pending:unregister {id, reason, status} matching pending-notifications entry shape", () => {
		const entry = makeRegistryEntry({
			taskId: "bt-1700000000-zomb01",
			state: "exited",
			reason: "natural",
			exitCode: 0,
		});
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);

		expect(result.reconciled).toBe(1);
		// 落盘形态逐字段对齐 pending-notifications index.ts unregister listener：{id, reason, status}
		expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
			id: entry.taskId,
			reason: "completed",
			status: "completed",
		});
	});

	it("maps exited reason/exitCode through the same mapping as the exit edge", () => {
		const cases: Array<[RegistryEntry, string]> = [
			[makeRegistryEntry({ state: "exited", reason: "natural", exitCode: 3 }), "failed"],
			[makeRegistryEntry({ state: "exited", reason: "timeout", exitCode: null }), "time_limited"],
			[makeRegistryEntry({ state: "exited", reason: "killed", exitCode: null }), "cancelled"],
			[makeRegistryEntry({ state: "exited", reason: "process-exit", exitCode: null }), "cancelled"],
		];
		for (const [entry, expectedReason] of cases) {
			writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
			const pi = createMockPi();
			reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);
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
	it("appends unregister with cancelled for orphaned entries", () => {
		const entry = makeRegistryEntry({ state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);

		expect(result.reconciled).toBe(1);
		expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
			id: entry.taskId,
			reason: "cancelled",
			status: "cancelled",
		});
	});
});

describe("reconcile scenario ③: running entry whose pid is already dead (fact-terminal)", () => {
	it("appends unregister with cancelled when kill(pid,0) says dead", () => {
		const entry = makeRegistryEntry({ state: "running", pid: deadPid() });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);

		expect(result.reconciled).toBe(1);
		expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
			id: entry.taskId,
			reason: "cancelled",
			status: "cancelled",
		});
	});
});

describe("conservative no-op paths", () => {
	it("running entry with LIVE pid is not settled (D12 task survives session replacement)", () => {
		const entry = makeRegistryEntry({ state: "running", pid: process.pid }); // 当前测试进程 = 活 pid
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);

		expect(result.reconciled).toBe(0);
		expect(result.skipped).toEqual([entry.taskId]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("registry has no entry for the id → skip (terminal state unverifiable)", () => {
		const pi = createMockPi();
		const result = reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry("bt-unknown")]);
		expect(result.reconciled).toBe(0);
		expect(result.skipped).toEqual(["bt-unknown"]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("entries with no bt- register → early no-op", () => {
		const pi = createMockPi();
		const result = reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [
			{ customType: "pending:register", data: { id: "bg-1", type: "subagent" } },
			{ customType: "user" },
		]);
		expect(result.reconciled).toBe(0);
		expect(result.skipped).toEqual([]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("unsettled set empty (unregister already present) → no-op", () => {
		const entry = makeRegistryEntry({ state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();
		const result = reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [
			registerEntry(entry.taskId),
			{ customType: "pending:unregister", data: { id: entry.taskId, reason: "cancelled" } },
		]);
		expect(result.reconciled).toBe(0);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});
});

describe("best-effort emit removed (ext-simplify-13 D5: appendEntry is the sole authority)", () => {
	it("reconcile never touches pi.events (the emit path is deleted, not just disabled)", () => {
		const entry = makeRegistryEntry({ state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);

		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(pi.events.emit).not.toHaveBeenCalled();
	});
});

describe("appendEntry failure tolerance", () => {
	it("one appendEntry throw does not block the remaining zombie (count only successful)", () => {
		const first = makeRegistryEntry({ taskId: "bt-1700000000-zomb01", state: "orphaned" });
		const second = makeRegistryEntry({ taskId: "bt-1700000000-zomb02", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), first);
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), second);
		const appendEntry = vi.fn((customType: string, data?: unknown) => {
			if ((data as { id: string }).id === first.taskId) throw new Error("append failed");
		});
		const pi = createMockPi({ appendEntry });

		const result = reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [
			registerEntry(first.taskId),
			registerEntry(second.taskId),
		]);

		expect(appendEntry).toHaveBeenCalledTimes(2);
		expect(result.reconciled).toBe(1); // 仅第二条成功计数
		expect(result.skipped).toEqual([]);
	});
});
