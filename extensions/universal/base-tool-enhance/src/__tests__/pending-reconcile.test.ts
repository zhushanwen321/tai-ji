// src/__tests__/pending-reconcile.test.ts —— M3 session_start 对账单元（§3.5 接入细则 4）
// + 收殓终态通知补投（unified-delivery D3 裁决 1 / §5 波 3）：
//  - bt- 差集（protocol collectActivePendingIds 单点消费）/ 三类僵尸场景 appendEntry
//    权威路径（唯一写路径，无 emit）/ 活任务与缺条目保守跳过
//  - 收殓补投：候选 = 收殓终态（orphaned / exited+process-exit）∧ 送达痕迹未命中，
//    逐任务经 port.deliver（id=taskId、terminated 措辞、无 details）；真实终态
//    （natural/timeout）退役出补投——主路径入账后丢失由 port 的 outbox 差集重放覆盖
//    （对位说明：投递 throw → 内核 retain + 边沿重放；落盘后崩溃 → outbox 差集重放；
//    两形态由 delivery-port 包测试锁定，本文件锁定「对账不再覆盖它们」）
//  - 旧补投标记 / in-flight 单飞守卫随波 3 退役：防双投由 port 幂等接管（deliver
//    幂等预检 + 内核三级判重 + outbox/ack 终态列）——本文件锁定「marker 在场不再
//    阻断重投」（痕迹缺失即重投，旧 marker「标记在而消息丢」残余失败域随之修复）
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
	type ReconcileDeliver,
	type ReconcilePi,
} from "../background/pending-reconcile.ts";
import { BACKGROUND_BASH_CUSTOM_TYPE } from "../background/notify.ts";
import { getRegistryPath, writeRegistryEntry } from "../background/registry.ts";
import type { RegistryEntry } from "../background/types.ts";

const DATA_DIR = mkdtempSync(join(tmpdir(), "bte-reconcile-"));
const SESSION_ID = "sess-reconcile";

type DeliverEnvelope = Parameters<ReconcileDeliver>[0];

function createMockPi(overrides: Partial<Pick<ReconcilePi, "appendEntry">> = {}): ReconcilePi {
	return {
		appendEntry: vi.fn(),
		...overrides,
	};
}

/** port.deliver 替身（缺省恒 accepted；receiptKind 覆盖受理结果分型）。 */
function createMockDeliver(receiptKind: "accepted" | "swallowed" | "rejected" = "accepted"): ReconcileDeliver {
	return vi.fn((envelope: DeliverEnvelope): ReturnType<ReconcileDeliver> => {
		if (receiptKind === "accepted") return { kind: "accepted", id: envelope.id ?? "" };
		if (receiptKind === "swallowed") return { kind: "swallowed", reason: "already-seen" };
		return { kind: "rejected", reason: "persist-failed" };
	});
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

/** 送达消息 entry（custom_message 落盘形态，供痕迹判重的「痕迹在」用例）。 */
function deliveredEntry(taskId: string) {
	return {
		type: "custom_message",
		customType: BACKGROUND_BASH_CUSTOM_TYPE,
		content: `[background-bash] ${taskId} finished (exit 0, 5s): pnpm test`,
		details: { taskId },
		display: true,
	};
}

/** 旧版补投标记 entry（波 3 机制退役后判据不再消费——反向断言用）。 */
function legacyMarkerEntry(taskId: string) {
	return {
		type: "custom",
		customType: "background-bash:reconciled",
		data: { taskId, reconciledAt: 1 },
	};
}

afterEach(() => {
	rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)], undefined);

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
			await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)], undefined);
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

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)], undefined);

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

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)], undefined);

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

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)], undefined);

		expect(result.reconciled).toBe(0);
		expect(result.skipped).toEqual([entry.taskId]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("registry has no entry for the id → skip (terminal state unverifiable) + warn (decision-6 LRU observation)", async () => {
		const pi = createMockPi();
		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry("bt-unknown")], undefined);
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
		], undefined);
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
		], undefined);
		expect(result.reconciled).toBe(0);
		expect(pi.appendEntry).not.toHaveBeenCalledWith("pending:unregister", expect.anything());
	});
});

describe("best-effort emit removed (ext-simplify-13 D5: appendEntry is the sole authority)", () => {
	it("reconcile never touches pi.events (the emit path is deleted, not just disabled)", async () => {
		const entry = makeRegistryEntry({ state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi() as ReconcilePi & { events: { emit: ReturnType<typeof vi.fn> } };
		pi.events = { emit: vi.fn() };

		// 送达消息在（痕迹锚阻断补投）：appendEntry 恰 1 次 = 差集收尾的 unregister
		await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [
			registerEntry(entry.taskId),
			deliveredEntry(entry.taskId),
		], undefined);

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
		], undefined);

		expect(result.reconciled).toBe(1); // 仅 unregister 第二条成功计数
		expect(result.skipped).toEqual([]);
	});
});

// ============================================================================
// 收殓终态通知补投（unified-delivery D3 裁决 1 / §5 波 3：对账路径 = 收殓终态
// 通知的唯一生产者，载体 = port.deliver）
// ============================================================================

describe("reap-notify: candidates (reaped terminal × trace absent) via port.deliver", () => {
	it("single orphaned: one deliver per task with id=taskId, terminated wording, NO details", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-orph01", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();
		const deliver = createMockDeliver();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [], deliver);

		expect(deliver).toHaveBeenCalledTimes(1);
		const envelope = deliver.mock.calls[0][0] as DeliverEnvelope;
		expect(envelope.id).toBe(entry.taskId);
		expect(envelope.timing).toBe("steer");
		expect(envelope.payload.customType).toBe(BACKGROUND_BASH_CUSTOM_TYPE);
		expect(envelope.payload.display).toBe(true);
		expect(envelope.payload.content).toContain(
			`${entry.taskId} was terminated when the session went down (exit code unknown)`,
		);
		expect(envelope.payload.content).toContain(`Output file: ${entry.outputFile}`);
		expect(envelope.payload.content).toContain("use bash_output to check the output before rerunning");
		// 收殓终态无业务 details（old decision 3 保持：无时长、不谎报成败）
		expect(envelope.payload).not.toHaveProperty("details");
		expect(envelope.payload.content).not.toMatch(/\d+[smh]/);
		// collectKey 债权申报 = [taskId]（result-collect 设计 §3.4：对账补投条目带键，
		// 与主链 notify.ts 同款，collect 可收取收殓终态）
		const opts = deliver.mock.calls[0][1] as { collectKey?: string[] } | undefined;
		expect(opts?.collectKey).toEqual([entry.taskId]);
		expect(result.redelivered).toEqual([entry.taskId]);
	});

	it("single exited process-exit: same terminated wording (not failed/finished)", async () => {
		const entry = makeRegistryEntry({
			taskId: "bt-1700000000-pexit1",
			state: "exited",
			reason: "process-exit",
			exitCode: null,
		});
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [], deliver);

		const envelope = deliver.mock.calls[0][0] as DeliverEnvelope;
		expect(envelope.payload.content).toContain("was terminated when the session went down");
		// 不谎报：收殓终止不渲染成主路径的 failed/finished 形态
		expect(envelope.payload.content).not.toContain("failed (exit");
		expect(envelope.payload.content).not.toContain("finished (exit");
	});

	it("multiple reaped tasks: per-task deliver (merge branch retired — one id one envelope for port idempotency)", async () => {
		const first = makeRegistryEntry({ taskId: "bt-1700000000-orph02", state: "orphaned" });
		const second = makeRegistryEntry({ taskId: "bt-1700000000-pexit2", state: "exited", reason: "process-exit", exitCode: null });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), first);
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), second);
		const deliver = createMockDeliver();

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [], deliver);

		// 逐任务信封（旧合并单条形态退役）：port 幂等键/送达凭据/差集销账全链锚定
		// 「单 id 单消息」——合并形态需造合成 id 且部分销账必然双投
		expect(deliver).toHaveBeenCalledTimes(2);
		const envelopes = deliver.mock.calls.map(
			(c) => c[0] as DeliverEnvelope,
		);
		expect(envelopes.map((e) => e.id)).toEqual([first.taskId, second.taskId]);
		for (const envelope of envelopes) {
			expect(envelope.payload.content).toContain(`${envelope.id} was terminated`);
		}
		expect(result.redelivered).toEqual([first.taskId, second.taskId]);
	});
});

describe("reap-notify: exclusion criteria (real terminal retired, killed/active excluded, trace blocks)", () => {
	it("exited natural (real terminal) is NOT re-notified — outbox replay owns it now (wave-3 retirement)", async () => {
		const entry = makeRegistryEntry({
			taskId: "bt-1700000000-genu01",
			state: "exited",
			reason: "natural",
			exitCode: 0,
			durationMs: 192_000,
		});
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [], deliver);

		// 主路径丢失两形态（投递 throw / 落盘后崩溃）由 port outbox 差集重放覆盖
		// （delivery-port 包测试锁定）；对账补投不再兜它们（D3 裁决 1 波 3）
		expect(deliver).not.toHaveBeenCalled();
		expect(result.redelivered).toEqual([]);
	});

	it("exited timeout (real terminal) is NOT re-notified either", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-time01", state: "exited", reason: "timeout", exitCode: null });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [], deliver);

		expect(deliver).not.toHaveBeenCalled();
	});

	it("exited reason=killed is NOT re-notified (excluded via the process-exit-only branch — silent rule)", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-kill01", state: "exited", reason: "killed", exitCode: null });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [], deliver);

		expect(deliver).not.toHaveBeenCalled();
		expect(result.redelivered).toEqual([]);
	});

	it("killing leftover with dead pid is NOT re-notified (strict terminal filter; unregister settle covers)", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-killg01", state: "killing", pid: deadPid() });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		// 差集侧：宽判据把 killing+判死当事实终态收尾 unregister（既有语义保持）
		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)], deliver);
		expect(result.reconciled).toBe(1);
		// 补投侧：killing 遗留实为被杀任务，不补投
		expect(deliver).not.toHaveBeenCalled();
	});

	it("running leftover with dead pid is NOT re-notified (exit-edge write-failure domain, unregister covers)", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-rund01", state: "running", pid: deadPid() });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)], deliver);
		expect(result.reconciled).toBe(1);
		expect(deliver).not.toHaveBeenCalled();
	});

	it("delivered trace present (notify message in entries) → no re-notify", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-have01", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [deliveredEntry(entry.taskId)], deliver);

		expect(deliver).not.toHaveBeenCalled();
		expect(result.redelivered).toEqual([]);
	});

	it("legacy reconciled marker present WITHOUT trace → still re-notified (marker retired; lost message re-delivered)", async () => {
		// 波 3 反向锁：旧 marker 不再是判据——「marker 写了但消息实际丢失」的旧机制
		// 残余失败域（旧决策 6 登记边界）在痕迹判据下被顺带修复
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-mark01", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [legacyMarkerEntry(entry.taskId)], deliver);

		expect(deliver).toHaveBeenCalledTimes(1);
		expect(result.redelivered).toEqual([entry.taskId]);
	});

	it("non-reaped registry only: running with live pid and no pending diff → nothing at all", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-live01", state: "running", pid: process.pid });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver();

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [], deliver);

		expect(deliver).not.toHaveBeenCalled();
		expect(result.reconciled).toBe(0);
	});
});

describe("reap-notify: receipt handling & port absence (idempotence owned by port)", () => {
	it("swallowed receipt (port idempotency hit) → not counted, silent (normal convergence)", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-dbl001", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver("swallowed");

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [], deliver);

		expect(deliver).toHaveBeenCalledTimes(1);
		expect(result.redelivered).toEqual([]);
		expect(loggerMock.warn).not.toHaveBeenCalledWith(
			"pending reconcile reap-notify rejected by delivery port; retried next session_start",
			expect.anything(),
		);
	});

	it("rejected receipt (not journaled) → warn with taskId, retried next session_start", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-rej001", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const deliver = createMockDeliver("rejected");

		const result = await reconcilePendingEntries(createMockPi(), DATA_DIR, SESSION_ID, [], deliver);

		expect(result.redelivered).toEqual([]);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			"pending reconcile reap-notify rejected by delivery port; retried next session_start",
			{ detail: { taskId: entry.taskId, reason: "persist-failed" } },
		);
	});

	it("delivery port absent → warn once, zero submission; pending diff pass unaffected", async () => {
		const entry = makeRegistryEntry({ taskId: "bt-1700000000-abs001", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = await reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)], undefined);

		expect(loggerMock.warn).toHaveBeenCalledWith(
			"pending reconcile reap-notify skipped: delivery port absent (assembly anomaly?); retried next session_start",
		);
		expect(result.redelivered).toEqual([]);
		// 差集收尾无条件执行（缺席只影响补投，不拖垮对账）
		expect(result.reconciled).toBe(1);
		expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", expect.anything());
	});
});
