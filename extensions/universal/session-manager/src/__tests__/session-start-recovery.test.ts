// session-start-recovery.test.ts — 重启收口腿（notify-once D7③ / U4）。
// 断言面：活跃 type 'session' register 重开 watch（入参 = entry id 即 notifyId）/
// 类型过滤（workflow 与已注销条目不触碰）/ 覆盖序（W1 悬置被 W2 覆盖后该 entry 恰一次
// unregister、后续 entry 不受阻塞——每 entry 独立 handler 禁串行 await）/
// 收口腿 label 降级源 = register 三键 name。
// pi/ctx 装配、respondWatch、flushMicrotasks 走共享 harness（helpers/extension-harness.ts）；
// watch-only select（非 watch action 即抛）为本文件域行为，留在本地。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	flushMicrotasks,
	makeRespondWatch,
	mountExtension,
	type ExtensionHarness,
	type WatchInvocation,
} from "./helpers/extension-harness.ts";

const LEDGER_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.notifyLedger");

interface Harness extends ExtensionHarness {
	watches: WatchInvocation[];
	respondWatch(index: number, value: unknown): void;
}

const E1 = "sm-aaaaaaaa-0000-4000-8000-000000000001";
const E2 = "sm-bbbbbbbb-0000-4000-8000-000000000002";
const E3 = "sm-cccccccc-0000-4000-8000-000000000003";
const WF = "wf-run-1";

function staleEntries(): unknown[] {
	return [
		{ customType: "pending:register", data: { id: E1, type: "session", name: "Alpha", registeredAt: 1, sessionId: "parent-1" } },
		{ customType: "pending:register", data: { id: E2, type: "session", name: "Beta", registeredAt: 2, sessionId: "parent-1" } },
		// workflow 类型归 core 对账 sweep，收口腿不得触碰
		{ customType: "pending:register", data: { id: WF, type: "workflow", name: "run-1" } },
		// 已注销（差集净空）→ 不重开
		{ customType: "pending:register", data: { id: E3, type: "session", name: "Gamma", registeredAt: 3, sessionId: "parent-1" } },
		{ customType: "pending:unregister", data: { id: E3, reason: "completed", status: "completed" } },
	];
}

function createHarness(entries: unknown[]): Harness {
	const watches: WatchInvocation[] = [];
	const selectMock = vi.fn((_marker: unknown, args: unknown[], _opts?: unknown) => {
		const payload = JSON.parse((args as string[])[0]) as {
			action: string;
			params: Record<string, unknown>;
		};
		if (payload.action !== "watch") throw new Error(`unexpected action ${payload.action}`);
		return new Promise((resolve) => {
			watches.push({ notifyId: String(payload.params.notifyId), resolve });
		});
	});
	return {
		...mountExtension(selectMock, entries),
		watches,
		respondWatch: makeRespondWatch(watches),
	};
}

function unregistersOf(h: Harness): Array<[string, unknown]> {
	return h.emitted
		.filter((e) => e.event === "pending:unregister")
		.map((e) => [String(e.data.id), e.data.reason]);
}

/** 单条 session register 的收口腿驱动（fail-closed / label 降级两用例共用前置）：
 * 开表（session_start）→ 排干微任务 → 应答首个 watch → 再排干 */
async function startSingleEntrySession(respondValue: unknown): Promise<Harness> {
	const h = createHarness([
		{ customType: "pending:register", data: { id: E1, type: "session", name: "Alpha", registeredAt: 1, sessionId: "parent-1" } },
	]);
	h.handlers.session_start({ type: "session_start" }, h.ctx);
	await flushMicrotasks();
	h.respondWatch(0, respondValue);
	await flushMicrotasks();
	return h;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	Reflect.deleteProperty(globalThis, LEDGER_SLOT_KEY);
});

describe("session_start 重启收口腿（D7③）", () => {
	it("重开 watch 覆盖序：W1 悬置被 W2 覆盖后该 entry 恰一次 unregister，且后续 entry 不受阻塞", async () => {
		const h = createHarness(staleEntries());
		expect(h.handlers.session_start).toBeTypeOf("function");

		// 第一次 session_start：E1 的 watch 永挂（模拟被后续 W2 覆盖 / runtime 只应答最新槽），
		// E2 仍须立刻开表——串行 await 链（先等 E1 再开 E2）在此必挂死
		h.handlers.session_start({ type: "session_start" }, h.ctx);
		await flushMicrotasks();
		expect(h.watches.map((w) => w.notifyId)).toEqual([E1, E2]);

		// E2 先应答 orphaned（杀父腿，触发器②批量转移先行）→ 即时静默 unregister
		h.respondWatch(1, JSON.stringify({ reason: "orphaned", sessionId: "child-b" }));
		await flushMicrotasks();
		expect(unregistersOf(h)).toEqual([[E2, "orphaned"]]);

		// 第二次 session_start（如 /resume 再触发）：E1 的 W2 到达并获应答——
		// W1 悬置全程未 resolve，恰一次 unregister 由「单槽只应答最新 + 写侧差集幂等」保证
		h.handlers.session_start({ type: "session_start" }, h.ctx);
		await flushMicrotasks();
		expect(h.watches).toHaveLength(4);
		expect(h.watches[2].notifyId).toBe(E1);
		h.respondWatch(2, JSON.stringify({ reason: "cancelled" }));
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(50);

		// E1 恰一次、E2 恰一次（第二次的 watch 不再应答 → 不重复注销）
		expect(unregistersOf(h).sort()).toEqual(
			[
				[E1, "cancelled"],
				[E2, "orphaned"],
			].sort(),
		);
		// workflow / 已注销条目全程未触碰
		const watchedIds = h.watches.map((w) => w.notifyId);
		expect(watchedIds).not.toContain(WF);
		expect(watchedIds).not.toContain(E3);
	});

	it("runtime 已重启查无 claim → fail-closed 'cancelled' 腿：静默注销（活跃集回归基线）", async () => {
		const h = await startSingleEntrySession(JSON.stringify({ reason: "cancelled" }));
		expect(unregistersOf(h)).toEqual([[E1, "cancelled"]]);
	});

	it("收口腿 label 降级源 = register 三键 name（D9 label 两路径的恢复路径）", async () => {
		Reflect.set(globalThis, LEDGER_SLOT_KEY, {
			current: { record: vi.fn(() => true), compactionCheck: () => 0 },
		});
		const record = Reflect.get(globalThis, LEDGER_SLOT_KEY).current.record;
		const h = await startSingleEntrySession(
			JSON.stringify({ reason: "completed", sessionId: "child-x", settleSeq: 1, fulfillsN: 1 }),
		);
		await vi.advanceTimersByTimeAsync(50);
		expect(record).toHaveBeenCalledTimes(1);
		expect(String(record.mock.calls[0][1])).toContain('Managed session "Alpha" (child-x)');
	});
});
