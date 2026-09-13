// 测试框架：vitest
// 运行命令：npx vitest run src/__tests__/pending-notifications.test.ts
//
// 覆盖 entries 单一权威源终态：countActiveFromEntries 差集原语 + 工厂写侧/读侧现算。
//
// 测试策略：
// - 用最小 mock 的 ExtensionAPI（mock events.on/emit、appendEntry、on、registerTool）
// - 用最小 mock 的 ExtensionContext（mock sessionManager.getEntries/getSessionId）
// - 共享 entries 数组 = session JSONL 的单测层镜像：appendEntry mock 同步 push 进该数组
//   （P1 单测层镜像：pi dist 实证 _appendEntry 同步入账），listener 落盘后的写侧前置
//   判断与工具查询立即可见——现算方案的物理前提
// - 调 pendingNotificationsExtension(pi) 触发工厂注册 handler
// - 手动触发 session_start / events / tool，断言 entries 差集与 appendEntry

/* eslint-disable taste/no-unsafe-cast */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import pendingNotificationsExtension from "../index";
import type { PendingEntry } from "../state";
import { countActiveFromEntries, normalizePendingType } from "../state";

// ── Mock 工具 ───────────────────────────────────────

interface HandlerRegistry {
	sessionStart: ((event: unknown, ctx: ExtensionContext) => void | Promise<void>) | undefined;
	pendingRegister: ((data: unknown) => void) | undefined;
	pendingUnregister: ((data: unknown) => void) | undefined;
}

interface MockSessionEntry {
	customType: string;
	data: Record<string, unknown>;
}

interface MockSetup {
	pi: ExtensionAPI;
	handlers: HandlerRegistry;
	/** 共享 entries 数组 = session JSONL 的单测层镜像（appendEntry mock 同步 push 进来） */
	entries: MockSessionEntry[];
	appendEntryMock: ReturnType<typeof vi.fn>;
	registerToolMock: ReturnType<typeof vi.fn>;
	sendMessageMock: ReturnType<typeof vi.fn>;
}

function createMockPi(): MockSetup {
	const handlers: HandlerRegistry = {
		sessionStart: undefined,
		pendingRegister: undefined,
		pendingUnregister: undefined,
	};
	// P1 单测层镜像：pi dist 实证 _appendEntry 同步 push（fileEntries）——appendEntry
	// mock 同步入账共享 entries，落盘后前置判断/工具查询立即可见。
	const entries: MockSessionEntry[] = [];
	const appendEntryMock = vi.fn((customType: string, data: Record<string, unknown>) => {
		entries.push({ customType, data });
	});
	const registerToolMock = vi.fn();
	const sendMessageMock = vi.fn();

	const pi = {
		appendEntry: appendEntryMock,
		registerTool: registerToolMock,
		sendMessage: sendMessageMock,
		on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) => {
			if (event === "session_start") handlers.sessionStart = handler;
		}),
		events: {
			emit: vi.fn(),
			on: vi.fn((channel: string, handler: (data: unknown) => void) => {
				if (channel === "pending:register") handlers.pendingRegister = handler;
				if (channel === "pending:unregister") handlers.pendingUnregister = handler;
			}),
		},
	} as unknown as ExtensionAPI;

	return { pi, handlers, entries, appendEntryMock, registerToolMock, sendMessageMock };
}

function createMockCtx(setup: MockSetup, sessionId = "sess-current"): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () => setup.entries as unknown[],
			getSessionId: () => sessionId,
		},
	} as unknown as ExtensionContext;
}

function fireSessionStart(setup: MockSetup, sessionId?: string): void {
	if (!setup.handlers.sessionStart) throw new Error("session_start handler not registered");
	void setup.handlers.sessionStart({ type: "session_start", reason: "resume" }, createMockCtx(setup, sessionId));
}

async function runTool(
	setup: MockSetup,
	params: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }> {
	const tool = setup.registerToolMock.mock.calls[0][0] as {
		execute: (
			toolCallId: string,
			p: unknown,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: ExtensionContext,
		) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
	};
	return tool.execute("test-call-id", params, undefined, undefined, createMockCtx(setup));
}

async function getCount(setup: MockSetup): Promise<number> {
	const res = await runTool(setup, { action: "count" });
	return Number(res.content[0].text.replace(/[^0-9]/g, ""));
}

// ── 共享 fixtures ───────────────────────────────────

const NOW = 1_700_000_000_000;

/** 盘上 pending:register entry 的形状（终态写入侧无 expiresAt 键；extra 可注入历史
 *  遗留字段如 expiresAt，用于证明读取侧不校验该键） */
function makeRegisterEntry(id: string, extra: Record<string, unknown> = {}): MockSessionEntry {
	return {
		customType: "pending:register",
		data: {
			id,
			type: "workflow",
			name: `op-${id}`,
			registeredAt: NOW,
			sessionId: "sess-current",
			...extra,
		},
	};
}

function makeUnregisterEntry(id: string): MockSessionEntry {
	return { customType: "pending:unregister", data: { id } };
}

// ────────────────────────────────────────────────────
// state.ts 纯函数测试
// ────────────────────────────────────────────────────

describe("state pure functions", () => {
	describe("normalizePendingType", () => {
		it("subagent/bash 直通，其余（缺失/未知/大小写不符）归 workflow", () => {
			expect(normalizePendingType("subagent")).toBe("subagent");
			expect(normalizePendingType("bash")).toBe("bash");
			expect(normalizePendingType("workflow")).toBe("workflow");
			expect(normalizePendingType(undefined)).toBe("workflow");
			expect(normalizePendingType("scheduler")).toBe("workflow");
			expect(normalizePendingType("Bash")).toBe("workflow");
		});
	});
});

describe("countActiveFromEntries（纯差集，供 goal / subagent-workflow / 工具投影复用）", () => {
	const mkRegister = (id: string, type: "subagent" | "workflow" = "subagent", overrides: Record<string, unknown> = {}) => ({
		type: "custom",
		customType: "pending:register",
		data: { id, type, name: id, registeredAt: 1000, sessionId: "s-1", ...overrides },
	});
	const mkUnregister = (id: string, reason = "completed") => ({
		type: "custom",
		customType: "pending:unregister",
		data: { id, reason },
	});

	it("空 entries → 0 活跃", () => {
		expect(countActiveFromEntries([])).toEqual({ count: 0, ids: [], entries: [] });
	});

	it("纯 register → count = register 数，返回完整 entry", () => {
		const res = countActiveFromEntries([mkRegister("bg-1"), mkRegister("bg-2", "workflow")]);
		expect(res.count).toBe(2);
		expect(res.ids).toEqual(["bg-1", "bg-2"]);
		expect(res.entries[0]).toMatchObject({ id: "bg-1", type: "subagent" });
	});

	it("register + unregister 同 id → 差集抵消", () => {
		expect(countActiveFromEntries([mkRegister("bg-1"), mkUnregister("bg-1")]).count).toBe(0);
	});

	it("混合：部分注销 → 只统计仍活跃的", () => {
		const res = countActiveFromEntries([
			mkRegister("bg-1"),
			mkRegister("bg-2"),
			mkUnregister("bg-1"),
		]);
		expect(res.count).toBe(1);
		expect(res.ids).toEqual(["bg-2"]);
	});

	it("types 过滤：只统计指定类型的活跃 pending", () => {
		const entries = [mkRegister("bg-1", "subagent"), mkRegister("wf-1", "workflow")];
		expect(countActiveFromEntries(entries, { types: ["subagent"] }).ids).toEqual(["bg-1"]);
		expect(countActiveFromEntries(entries, { types: ["workflow"] }).ids).toEqual(["wf-1"]);
		expect(countActiveFromEntries(entries, { types: ["subagent", "workflow"] }).count).toBe(2);
	});

	it("TTL 过期仍判活跃（刻意不校验 expiresAt，对齐 goal continuation 守卫语义）", () => {
		const expired = mkRegister("bg-1", "subagent", { registeredAt: 0, expiresAt: 1 });
		expect(countActiveFromEntries([expired]).count).toBe(1);
	});

	it("同 id 重复 register → 只算一次", () => {
		expect(countActiveFromEntries([mkRegister("bg-1"), mkRegister("bg-1")]).count).toBe(1);
	});

	it("entries 含 null/undefined 元素 → 跳过不抛 TypeError（S-10）", () => {
		// S-10 回归：外部调用方可能传入含 null/undefined 的 entries（session 文件坏行/脏数据），
		// 遍历时访问 raw.customType 前必须守卫，否则 TypeError 炸掉整个差集判定。
		const withNulls = [null, undefined, mkRegister("bg-1"), mkUnregister("bg-1"), null];
		expect(countActiveFromEntries(withNulls).count).toBe(0);
		const mixed = [undefined, null, mkRegister("bg-2")];
		expect(countActiveFromEntries(mixed).ids).toEqual(["bg-2"]);
		// register 循环同样守卫：unregister 遍历前的 null 不污染差集
		expect(countActiveFromEntries([null, undefined]).count).toBe(0);
	});

	it("malformed register（id 非 string）→ 跳过", () => {
		const bad = { type: "custom", customType: "pending:register", data: { id: 42 } };
		const good = mkRegister("bg-1");
		expect(countActiveFromEntries([bad, good]).ids).toEqual(["bg-1"]);
	});

	it("跨 session 残留（fork 继承的 register）缺省不校验 sessionId——对账补注销后的历史 entry 不干扰差集", () => {
		// 差集口向后兼容：不传 currentSessionId = 不过滤（既有调用方零改动）。
		// 模拟 fork 继承：继承来主 session 的 register（sessionId=s-0），bte 对账已
		// 补 unregister 平掉差集，只剩本 session 的注册计入。
		const inherited = mkRegister("parent-bg", "subagent", { sessionId: "s-0" });
		const flushed = mkUnregister("parent-bg", "expired");
		const own = mkRegister("my-bg");
		expect(countActiveFromEntries([inherited, flushed, own]).ids).toEqual(["my-bg"]);
	});

	it("[跨 session 残留过滤] currentSessionId 过滤：跨 session entry 跳过、本 session 计入", () => {
		const inherited = mkRegister("parent-bg", "subagent", { sessionId: "s-0" });
		const own = mkRegister("my-bg", "subagent", { sessionId: "s-1" });
		const bashOwn = mkRegister("bt-1", "bash", { sessionId: "s-1" });
		expect(
			countActiveFromEntries([inherited, own, bashOwn], { currentSessionId: "s-1" }).ids,
		).toEqual(["my-bg", "bt-1"]);
		// 同一输入不传基准 → 全量计入（向后兼容面不变）
		expect(countActiveFromEntries([inherited, own, bashOwn]).count).toBe(3);
	});

	it("[跨 session 残留过滤] entry 缺 sessionId 的旧形态条目视为本 session（不过滤，宁放行不误杀）", () => {
		const legacy = { type: "custom", customType: "pending:register", data: { id: "old-1", type: "subagent", name: "o" } };
		expect(
			countActiveFromEntries([legacy], { currentSessionId: "s-1" }).ids,
		).toEqual(["old-1"]);
	});

	it("差集路径识别 bash entry：register 计入且 type 保留，unregister 抵消", () => {
		const bashReg = {
			customType: "pending:register",
			data: { id: "bt-1", type: "bash", name: "task-bt-1", registeredAt: NOW, sessionId: "sess-current" },
		};
		const res = countActiveFromEntries([bashReg] as unknown[]);
		expect(res.count).toBe(1);
		expect(res.entries[0].type).toBe("bash");

		expect(
			countActiveFromEntries([bashReg, makeUnregisterEntry("bt-1")] as unknown[]).count,
		).toBe(0);
	});

	it("types 过滤：bash 可作为过滤类型", () => {
		const bashReg = {
			customType: "pending:register",
			data: { id: "bt-1", type: "bash", name: "task-bt-1", registeredAt: NOW, sessionId: "sess-current" },
		};
		const entries = [bashReg, makeRegisterEntry("w-1")] as unknown[];
		expect(countActiveFromEntries(entries, { types: ["bash"] }).ids).toEqual(["bt-1"]);
		expect(countActiveFromEntries(entries, { types: ["workflow"] }).ids).toEqual(["w-1"]);
	});

	it("entry with only {id} → 归一化 type=workflow、name=id、status=active（缺字段容错）", () => {
		const res = countActiveFromEntries([{ customType: "pending:register", data: { id: "w-min" } }]);
		expect(res.ids).toEqual(["w-min"]);
		expect(res.entries[0]).toMatchObject({ id: "w-min", type: "workflow", name: "w-min", status: "active" });
	});
});

// ────────────────────────────────────────────────────
// index.ts 工厂集成测试（写侧现算 + 读侧现算）
// ────────────────────────────────────────────────────

describe("pendingNotificationsExtension factory", () => {
	let setup: MockSetup;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		setup = createMockPi();
		pendingNotificationsExtension(setup.pi);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("session_start 后查询（entries 现算，无状态重建）", () => {
		it("盘上 register 无 unregister → count=1、不补写任何 entry", async () => {
			setup.entries.push(makeRegisterEntry("w-1"));
			fireSessionStart(setup);

			expect(await getCount(setup)).toBe(1);
			const stateChangeCalls = setup.appendEntryMock.mock.calls.filter(
				(c) => c[0] === "pending:register" || c[0] === "pending:unregister",
			);
			expect(stateChangeCalls).toHaveLength(0);
		});

		it("盘上 register + unregister → count=0", async () => {
			setup.entries.push(makeRegisterEntry("w-1"), makeUnregisterEntry("w-1"));
			fireSessionStart(setup);

			expect(await getCount(setup)).toBe(0);
		});

		it("[跨 session 残留] other session 的 register → 不进投影、不补 unregister entry", async () => {
			// fork 继承的父级注册残留不进差集（currentSessionId 过滤），且落盘收口归
			// 对账通道——本包不做任何补写。
			setup.entries.push(makeRegisterEntry("w-1", { sessionId: "sess-old" }));
			fireSessionStart(setup, "sess-current");

			expect(await getCount(setup)).toBe(0);
			expect(setup.appendEntryMock).not.toHaveBeenCalledWith(
				"pending:unregister",
				expect.objectContaining({ id: "w-1" }),
			);
		});
	});

	describe("events.on pending:register (U5-U6)", () => {
		it("U5: register event → active + appendEntry", async () => {
			fireSessionStart(setup);

			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "test" });

			expect(await getCount(setup)).toBe(1);
			expect(setup.appendEntryMock).toHaveBeenCalledWith(
				"pending:register",
				expect.objectContaining({ id: "w-1", type: "workflow", name: "test" }),
			);
		});

		it("U6: duplicate register event → ignored（只落盘一条）", async () => {
			fireSessionStart(setup);

			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "first" });
			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "second" });

			expect(await getCount(setup)).toBe(1);
			const registerCalls = setup.appendEntryMock.mock.calls.filter((c) => c[0] === "pending:register");
			expect(registerCalls).toHaveLength(1);
		});
	});

	describe("events.on pending:unregister (U7-U8)", () => {
		it("U7: unregister event → 差集归零 + appendEntry", async () => {
			fireSessionStart(setup);

			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "test" });
			setup.appendEntryMock.mockClear();
			setup.handlers.pendingUnregister!({ id: "w-1", reason: "completed" });

			expect(await getCount(setup)).toBe(0);
			expect(setup.appendEntryMock).toHaveBeenCalledWith(
				"pending:unregister",
				expect.objectContaining({ id: "w-1", reason: "completed" }),
			);
		});

		it("U8: unregister unknown id → ignored, no appendEntry, no throw", () => {
			fireSessionStart(setup);
			setup.appendEntryMock.mockClear();

			expect(() => setup.handlers.pendingUnregister!({ id: "nope", reason: "completed" })).not.toThrow();
			const stateChangeCalls = setup.appendEntryMock.mock.calls.filter(
				(c) => c[0] === "pending:register" || c[0] === "pending:unregister",
			);
			expect(stateChangeCalls).toHaveLength(0);
		});

		it("U7b: reason → status 词表映射（表驱动——防新枚举值漏映射静默落兜底，cancelled 同族事故先例）", () => {
			fireSessionStart(setup);
			const cases: Array<[string, string]> = [
				["completed", "completed"],
				["failed", "failed"],
				["cancelled", "cancelled"],
				["expired", "expired"],
				["time_limited", "time_limited"],
				["budget_limited", "failed"],
				["aborted", "aborted"],
				// U5 新词表：subagent-core stopReason 展示值经注销 reason 通道到达
				["interrupted", "aborted"],
				["interrupted-by-restart", "aborted"],
				["interrupted-by-parent", "aborted"],
				["reopened", "completed"],
			];
			for (const [i] of cases.entries()) {
				setup.handlers.pendingRegister!({ id: `w-map-${i}`, type: "workflow", name: `op-${i}` });
			}
			setup.appendEntryMock.mockClear();
			for (const [i, [reason]] of cases.entries()) {
				setup.handlers.pendingUnregister!({ id: `w-map-${i}`, reason });
			}

			const unregisterCalls = setup.appendEntryMock.mock.calls.filter((c) => c[0] === "pending:unregister");
			expect(unregisterCalls).toHaveLength(cases.length);
			for (const [i, [reason, expected]] of cases.entries()) {
				expect(unregisterCalls).toContainEqual([
					"pending:unregister",
					expect.objectContaining({ id: `w-map-${i}`, reason, status: expected }),
				]);
			}
		});

		it("U7c: 未知 reason 落 default 兜底 completed（兜底语义的显式登记——未来若改兜底口径，此用例同步更新）", () => {
			fireSessionStart(setup);
			setup.handlers.pendingRegister!({ id: "w-unknown", type: "workflow", name: "op" });
			setup.appendEntryMock.mockClear();

			setup.handlers.pendingUnregister!({ id: "w-unknown", reason: "some-future-reason" });

			expect(setup.appendEntryMock).toHaveBeenCalledWith(
				"pending:unregister",
				expect.objectContaining({ id: "w-unknown", reason: "some-future-reason", status: "completed" }),
			);
		});
	});

	describe("tool count/list (U9-U10)", () => {
		it("U9: count returns active count", async () => {
			fireSessionStart(setup);
			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "a" });

			const res = await runTool(setup, { action: "count" });
			expect(res.content[0].text).toContain("1");
		});

		it("U10: list returns active list", async () => {
			fireSessionStart(setup);
			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "a" });
			setup.handlers.pendingRegister!({ id: "s-1", type: "subagent", name: "b" });

			const res = await runTool(setup, { action: "list" });
			const ids = (res.details as { items: PendingEntry[] }).items.map((i) => i.id);
			expect(ids.sort()).toEqual(["s-1", "w-1"]);
		});
	});

	describe("写侧幂等（P2）", () => {
		it("bte 对账已直接落盘 unregister 后，收尾尽力补 emit 不重复落盘", async () => {
			// bte 对账权威路径 = 直接 appendEntry（不经本包 listener）；对账平掉差集后，
			// 任务收尾的尽力补 emit 到达 listener——前置判断对同一份 entries 现算发现
			// 已注销 → 跳过（历史内存态形态下此路径会产生第二条重复 unregister entry）。
			fireSessionStart(setup);
			setup.handlers.pendingRegister!({ id: "bt-1", type: "bash", name: "run" });

			// 对账直接落盘（模拟 bte：不经 listener 的 pi.appendEntry）
			setup.appendEntryMock("pending:unregister", { id: "bt-1", reason: "completed", status: "completed" });
			// 收尾尽力补 emit 到达 listener
			setup.handlers.pendingUnregister!({ id: "bt-1", reason: "completed" });

			const unregisterCalls = setup.appendEntryMock.mock.calls.filter((c) => c[0] === "pending:unregister");
			expect(unregisterCalls).toHaveLength(1);
			expect(await getCount(setup)).toBe(0);
		});
	});

	describe("safeAppendEntry error handling", () => {
		it("appendEntry throwing (stale context) does not break listener; entries and query stay consistent", async () => {
			// 单一权威源语义：落盘失败 → entries 没有该注册 → 工具同样查不到（不再出现
			// 「内存已收、盘上没有」的工具/守卫分裂）；listener 不被异常打断，后续注册正常。
			fireSessionStart(setup);
			setup.appendEntryMock.mockImplementationOnce(() => {
				throw new Error("stale context");
			});

			expect(() => setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "test" })).not.toThrow();
			expect(await getCount(setup)).toBe(0);

			setup.handlers.pendingRegister!({ id: "w-2", type: "workflow", name: "other" });
			expect(await getCount(setup)).toBe(1);
		});
	});

	describe("parse null/malformed events", () => {
		it("parseRegisterEvent: null and missing-id data → no throw, no register entry", () => {
			fireSessionStart(setup);
			setup.appendEntryMock.mockClear();

			expect(() => setup.handlers.pendingRegister!(null)).not.toThrow();
			expect(() => setup.handlers.pendingRegister!({ type: "workflow" })).not.toThrow();

			const registerCalls = setup.appendEntryMock.mock.calls.filter((c) => c[0] === "pending:register");
			expect(registerCalls).toHaveLength(0);
		});

		it("parseUnregisterEvent: null and missing-id data → no throw, no unregister entry", () => {
			fireSessionStart(setup);
			setup.appendEntryMock.mockClear();

			expect(() => setup.handlers.pendingUnregister!(null)).not.toThrow();
			expect(() => setup.handlers.pendingUnregister!({ reason: "completed" })).not.toThrow();

			const unregisterCalls = setup.appendEntryMock.mock.calls.filter((c) => c[0] === "pending:unregister");
			expect(unregisterCalls).toHaveLength(0);
		});
	});

	describe("写入侧落盘契约与跨 session 投影", () => {
		it("register 落盘契约：data 含 id/type/name/registeredAt/sessionId，无条件无 expiresAt 键（bash）", async () => {
			fireSessionStart(setup);

			setup.handlers.pendingRegister!({ id: "bt-1", type: "bash", name: "run tests" });

			expect(await getCount(setup)).toBe(1);
			const regCall = setup.appendEntryMock.mock.calls.find((c) => c[0] === "pending:register");
			expect(regCall).toBeDefined();
			const data = regCall![1] as Record<string, unknown>;
			expect(data.type).toBe("bash");
			expect(data).toHaveProperty("registeredAt");
			expect(data).toHaveProperty("sessionId");
			expect("expiresAt" in data).toBe(false);
		});

		it("register 落盘契约：workflow 同样无 expiresAt 键（三类型统一 process 档写入形态）", async () => {
			fireSessionStart(setup);

			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "run" });

			const regCall = setup.appendEntryMock.mock.calls.find((c) => c[0] === "pending:register");
			const data = regCall![1] as Record<string, unknown>;
			expect("expiresAt" in data).toBe(false);
		});

		it("[fork 过滤] 子 session 工具投影不见父 session 注册，父残留不被补注销", async () => {
			// fork 子 session（继承父 entries）：父级注册（sessionId=sess-parent）不进
			// 子 session 投影（currentSessionId 过滤），且本包不为残留补写任何 entry
			//（落盘收口归 core 对账 sweep / bte 对账通道）。
			setup.entries.push({
				customType: "pending:register",
				data: { id: "bg-parent", type: "subagent", name: "p", registeredAt: NOW, sessionId: "sess-parent" },
			});
			fireSessionStart(setup, "sess-child");
			// 子 session 自己的新注册（listener 写入，sessionId=sess-child）
			setup.handlers.pendingRegister!({ id: "bg-own", type: "subagent", name: "own" });

			expect(await getCount(setup)).toBe(1);
			const res = await runTool(setup, { action: "list" });
			const ids = (res.details as { items: PendingEntry[] }).items.map((i) => i.id);
			expect(ids).toEqual(["bg-own"]);

			const parentUnregister = setup.appendEntryMock.mock.calls.filter(
				(c) => c[0] === "pending:unregister" && (c[1] as { id: string }).id === "bg-parent",
			);
			expect(parentUnregister).toHaveLength(0);
		});
	});
});
