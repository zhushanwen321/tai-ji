// notify-ledger-discipline.test.ts — ledger 装配纪律（notify-once D3 ①-⑤ / U4）。
// 包名 import @zhushanwen/subagent-core（D-10 领地补录后的 canonical 形态，相对路径 hack 已删）。
// 覆盖：
//   ① ensureLedgerBound 查槽有实例直接消费（不无谓 dispose / 不重复 recover）；
//   ② 槽空 → bind + recoverFromSession 成对（recover 吸收 session 文件既有条目——用未销账
//      ledger entry 种子断言 pendingCount，证明 recover 真跑过）；
//   ③ 双 bind 收敛——「先 bind 方在后 bind 之后 record 仍返回 true」（动态查槽恒取当前实例；
//      缓存前实例引用则 record 恒 false 零日志——D3⑤ 事故形态反证）；
//   ④ compactionCheck 直通当前实例、抛错不外抛（接入点降级，STANDARDS §11.1）；
//   ⑤ 消费点 record 动态查槽 + deliveryCustomType = managed-session-notify；
//      record 先 appendEntry 落盘后内存更新（时序钉：append 快照 = 该次 record 前计数）；
//   槽空降级（ensure 未跑/失败时 record → warn + false，用例登记）。

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	bindNotifyLedgerHost,
	getBoundNotifyLedger,
	type NotifyLedgerHost,
} from "@zhushanwen/subagent-core";

import {
	ensureLedgerBound,
	recordManagedNotify,
	runLedgerCompactionCheck,
} from "../notify-ledger.ts";

interface HostProbe {
	host: NotifyLedgerHost;
	appendLedgerEntries: Array<{ customType: string; data: Record<string, unknown> }>;
	/** 每次 append 发生时账本 pendingCount 快照——时序钉：恒等于该次 record 前的计数 */
	pendingCountsAtAppend: number[];
	attach(pendingCount: () => number): void;
}

function makeHost(): HostProbe {
	const appendLedgerEntries: HostProbe["appendLedgerEntries"] = [];
	const pendingCountsAtAppend: number[] = [];
	let pendingCount: (() => number) | undefined;
	const host: NotifyLedgerHost = {
		appendLedgerEntry(customType, data) {
			// 时序钉（D3 ③）：record 先 appendEntry 落盘、后内存更新——此刻本条尚未入账
			if (pendingCount) pendingCountsAtAppend.push(pendingCount());
			appendLedgerEntries.push({ customType, data: data as Record<string, unknown> });
		},
		readSessionEntries: () => [],
		isIdle: () => false,
		onAgentSettled: () => {},
		sendDelivery: () => {},
	};
	return {
		host,
		appendLedgerEntries,
		pendingCountsAtAppend,
		attach: (fn) => {
			pendingCount = fn;
		},
	};
}

/** ensureLedgerBound 的最小 pi/ctx 桩（appendEntry/on/sendMessage + getEntries/isIdle） */
function makePiCtx(entries: unknown[]) {
	const pi = {
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries.push({ type: "custom", customType, data });
		}),
		on: vi.fn(),
		sendMessage: vi.fn(),
	};
	const ctx = {
		sessionManager: { getEntries: vi.fn(() => entries) },
		isIdle: () => false,
	};
	return { pi, ctx };
}

afterEach(() => {
	// dispose 摘除模块级绑定（bind 路径实例 current===api → setBoundLedger(undefined)）
	getBoundNotifyLedger()?.dispose();
});

describe("ledger 装配纪律（D3 ①-⑤，canonical import）", () => {
	it("槽空 → recordManagedNotify 降级 false（ensure 未跑/失败时的登记降级，warn 留痕）", () => {
		expect(getBoundNotifyLedger()).toBeUndefined();
		expect(recordManagedNotify("sm-x", "content", { notifyId: "sm-x" })).toBe(false);
	});

	it("⑤ bind 后 record 经动态查槽入账、deliveryCustomType = managed-session-notify；时序钉：append 先于内存更新", () => {
		const probe = makeHost();
		const ledger = bindNotifyLedgerHost(probe.host);
		probe.attach(() => ledger.pendingCount());
		expect(getBoundNotifyLedger()).toBe(ledger);
		expect(recordManagedNotify("sm-a", "hello", { notifyId: "sm-a" })).toBe(true);
		expect(probe.appendLedgerEntries).toHaveLength(1);
		expect(probe.appendLedgerEntries[0].customType).toBe("subagent-bg-notify-ledger");
		expect(probe.appendLedgerEntries[0].data.deliveryCustomType).toBe("managed-session-notify");
		expect(probe.appendLedgerEntries[0].data.content).toBe("hello");
		expect(probe.pendingCountsAtAppend).toEqual([0]);
		expect(ledger.pendingCount()).toBe(1);
	});

	it("③ 先 bind 方在后 bind 之后 record 仍返回 true（后 bind 者收敛单实例；缓存前实例引用则恒 false——D3⑤ 反证）", () => {
		const probeA = makeHost();
		const ledgerA = bindNotifyLedgerHost(probeA.host);
		probeA.attach(() => ledgerA.pendingCount());
		expect(recordManagedNotify("sm-1", "n1", {})).toBe(true);
		expect(probeA.appendLedgerEntries).toHaveLength(1);

		// 后 bind 方（模拟 subagent-workflow session_start 的 re-bind + recover 成对——
		// bindNotifyLedgerHost 内部先 dispose 旧实例再 set，收敛为单实例全量态）
		const probeB = makeHost();
		const ledgerB = bindNotifyLedgerHost(probeB.host);
		probeB.attach(() => ledgerB.pendingCount());

		// 消费点动态查槽恒取当前实例：先 bind 方的后续 record 落后 bind 实例且返回 true
		expect(getBoundNotifyLedger()).toBe(ledgerB);
		expect(recordManagedNotify("sm-2", "n2", {})).toBe(true);
		expect(probeB.appendLedgerEntries.map((e) => e.data.notifyId)).toEqual(["sm-2"]);
		expect(probeA.appendLedgerEntries).toHaveLength(1); // 前实例不再收账
		// 时序钉跨 bind 仍成立：sm-2 时 B 账面 0（append 快照 = 该次 record 前计数）
		expect(probeB.pendingCountsAtAppend).toEqual([0]);

		// 反证：若消费点缓存了前实例引用，record 恒 false 且零日志（对半概率丢全部通知的事故形态）
		expect(ledgerA.record("sm-3", "n3", {})).toBe(false);
		// 而动态查槽（本包消费面）依旧 true
		expect(recordManagedNotify("sm-4", "n4", {})).toBe(true);
		expect(probeB.appendLedgerEntries).toHaveLength(2);
		expect(probeB.pendingCountsAtAppend).toEqual([0, 1]);
	});

	it("② 槽空 + ensureLedgerBound → bind + recoverFromSession 成对（既有未销账 ledger entry 被 recover 吸收）", () => {
		const entries: unknown[] = [
			{
				type: "custom",
				customType: "subagent-bg-notify-ledger",
				data: {
					v: 1,
					notifyId: "sm-recovered",
					content: "prior notification",
					record: { notifyId: "sm-recovered" },
				},
			},
		];
		const { pi, ctx } = makePiCtx(entries);
		expect(getBoundNotifyLedger()).toBeUndefined();

		ensureLedgerBound(pi as never, ctx as never);
		const ledger = getBoundNotifyLedger();
		expect(ledger).toBeDefined();
		// recover 真跑过：session 文件的未销账条目被吸收进内存态
		expect(ctx.sessionManager.getEntries).toHaveBeenCalled();
		expect(ledger!.pendingCount()).toBe(1);
		// 装配后消费面就绪
		expect(recordManagedNotify("sm-new", "n", {})).toBe(true);
		expect(pi.appendEntry).toHaveBeenCalledWith(
			"subagent-bg-notify-ledger",
			expect.objectContaining({ notifyId: "sm-new", deliveryCustomType: "managed-session-notify" }),
		);
	});

	it("① 槽已有实例 + ensureLedgerBound → 直接消费不重 bind（不无谓 dispose、不重复 recover）；重复调用幂等", () => {
		const probe = makeHost();
		const ledger = bindNotifyLedgerHost(probe.host);
		probe.attach(() => ledger.pendingCount());

		const { pi, ctx } = makePiCtx([]);
		ensureLedgerBound(pi as never, ctx as never);
		// 实例未被替换（无 dispose → 无新 bind），recover 未被再次触发（getEntries 零调用）
		expect(getBoundNotifyLedger()).toBe(ledger);
		expect(ctx.sessionManager.getEntries).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();

		ensureLedgerBound(pi as never, ctx as never);
		expect(getBoundNotifyLedger()).toBe(ledger);
		expect(ctx.sessionManager.getEntries).not.toHaveBeenCalled();
	});

	it("④ compactionCheck 经动态查槽直通当前实例", () => {
		const probe = makeHost();
		const ledger = bindNotifyLedgerHost(probe.host);
		probe.attach(() => ledger.pendingCount());
		const spy = vi.spyOn(getBoundNotifyLedger()!, "compactionCheck").mockReturnValue(0);
		runLedgerCompactionCheck();
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("④ compactionCheck 抛错 → warn 吞掉不外抛（辅助面接入点降级，STANDARDS §11.1）", () => {
		bindNotifyLedgerHost(makeHost().host);
		vi.spyOn(getBoundNotifyLedger()!, "compactionCheck").mockImplementation(() => {
			throw new Error("boom");
		});
		expect(() => runLedgerCompactionCheck()).not.toThrow();
	});
});
