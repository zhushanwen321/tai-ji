// 测试框架：vitest
// 运行命令：pnpm -C extensions/universal/pending-notifications test
//
// collect_results 工具单测（result-collect 设计 §3.1③ 工具面；设计 §5 拆分依据：
// 工具面独立可测——mock port 句柄）。
//
// 测试策略：
// - vi.mock("@zhushanwen/pi-delivery-port") 全模块 mock：工具经进程级槽消费投递端口，
//   测试注入 mock handle（collectArm/consume/collectRelease/onCollectArrival 四方法 +
//   存量面），与 u-p-port 实装解耦（不加载 delivery-port.ts 真实模块）
// - mock 手法与 pending-notifications.test.ts 同款：最小 mock ExtensionAPI /
//   ExtensionContext，共享 entries 数组 = session JSONL 的单测层镜像（appendEntry
//   mock 同步入账）
// - 覆盖（任务书目标 6）：lifetime 排除生效 / 跨 session 残留反向断言 / 未知 id
//   errors / 第四态返回形态；另覆盖 sequential 声明、abort 正常返回、timeout、
//   in-push-pipeline note、快照重收、port 缺席降级、kind 落盘透传、等待中同步到达
//   的 outcome 回填（一致性修复 U1：managed 合批「deliver 先于注销」同步段时序）

/* eslint-disable taste/no-unsafe-cast -- 测试 mock 构造（pending-notifications.test.ts:15 同款）：最小 mock ExtensionAPI/ExtensionContext 无法逐字段满足真实接口，cast 真值由测试断言兜底（mock 被被测代码真实调用，行为不符即红） */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import pendingNotificationsExtension from "../index";
import { computeCollectWaitKeys, countActiveFromEntries } from "../state";

// ── delivery-port 全模块 mock（vi.mock 工厂提升，经 vi.hoisted 共享引用） ──

const portMocks = vi.hoisted(() => ({
	getDeliveryPort: vi.fn<() => unknown>(),
}));

vi.mock("@zhushanwen/pi-delivery-port", () => portMocks);

// ── Mock 工具（与 pending-notifications.test.ts 同款手法） ──────────────

interface HandlerRegistry { // oe-exempt:20261016:test:测试 mock 类型单实现为测试基建常态（pending-notifications.test.ts 存量同款类型未登记为历史遗留）
	sessionStart: ((event: unknown, ctx: ExtensionContext) => void | Promise<void>) | undefined;
	pendingRegister: ((data: unknown) => void) | undefined;
	pendingUnregister: ((data: unknown) => void) | undefined;
}

interface MockSessionEntry { // oe-exempt:20261016:test:测试 mock 类型单实现为测试基建常态（pending-notifications.test.ts 存量同款类型未登记为历史遗留）
	customType: string;
	data: Record<string, unknown>;
}

interface MockPort { // oe-exempt:20261016:test:测试 mock 类型单实现为测试基建常态（pending-notifications.test.ts 存量同款类型未登记为历史遗留）
	collectArm: ReturnType<typeof vi.fn>;
	consume: ReturnType<typeof vi.fn>;
	collectRelease: ReturnType<typeof vi.fn>;
	onCollectArrival: ReturnType<typeof vi.fn>;
	deliver: ReturnType<typeof vi.fn>;
	recover: ReturnType<typeof vi.fn>;
	metrics: ReturnType<typeof vi.fn>;
	flush: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
}

interface MockSetup { // oe-exempt:20261016:test:测试 mock 类型单实现为测试基建常态（pending-notifications.test.ts 存量同款类型未登记为历史遗留）
	pi: ExtensionAPI;
	handlers: HandlerRegistry;
	entries: MockSessionEntry[];
	appendEntryMock: ReturnType<typeof vi.fn>;
	registerToolMock: ReturnType<typeof vi.fn>;
	port: MockPort;
}

function createMockPort(): MockPort {
	return {
		collectArm: vi.fn(() => []),
		consume: vi.fn(() => []),
		collectRelease: vi.fn(),
		onCollectArrival: vi.fn(() => vi.fn()),
		deliver: vi.fn(),
		recover: vi.fn(() => 0),
		metrics: vi.fn(() => ({ settleRejected: 0, recoveryReplays: 0 })),
		flush: vi.fn(),
		dispose: vi.fn(),
	};
}

function createMockSetup(): MockSetup {
	const handlers: HandlerRegistry = {
		sessionStart: undefined,
		pendingRegister: undefined,
		pendingUnregister: undefined,
	};
	// P1 单测层镜像：appendEntry mock 同步入账共享 entries
	const entries: MockSessionEntry[] = [];
	const appendEntryMock = vi.fn((customType: string, data: Record<string, unknown>) => {
		entries.push({ customType, data });
	});
	const registerToolMock = vi.fn();
	const port = createMockPort();
	portMocks.getDeliveryPort.mockReturnValue(port);

	const pi = {
		appendEntry: appendEntryMock,
		registerTool: registerToolMock,
		sendMessage: vi.fn(),
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

	return { pi, handlers, entries, appendEntryMock, registerToolMock, port };
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

interface CollectToolDef { // oe-exempt:20261016:test:测试 mock 类型单实现为测试基建常态（pending-notifications.test.ts 存量同款类型未登记为历史遗留）
	executionMode?: string;
	description?: string;
	execute: (
		toolCallId: string,
		p: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: {
			collected: Array<Record<string, unknown>>;
			stillOpen: Array<{ id: string; note?: string }>;
			errors?: Array<{ id: string; reason: string }>;
		};
	}>;
}

function getCollectTool(setup: MockSetup): CollectToolDef {
	const call = setup.registerToolMock.mock.calls.find(
		(c) => (c[0] as { name: string }).name === "collect_results",
	);
	if (!call) throw new Error("collect_results tool not registered");
	return call[0] as CollectToolDef;
}

async function runCollect(
	setup: MockSetup,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): ReturnType<CollectToolDef["execute"]> {
	return getCollectTool(setup).execute("collect-call-id", params, signal, undefined, createMockCtx(setup));
}

// ── 共享 fixtures ───────────────────────────────────

const NOW = 1_700_000_000_000;

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

// ────────────────────────────────────────────────────
// state.ts：缺省等待键集 + 曾注册集（collect 工具侧纯函数）
// ────────────────────────────────────────────────────

describe("computeCollectWaitKeys（collect_results 缺省等待集，工具侧减法）", () => {
	it("lifetime 债权排除生效：kind=lifetime 的 session register 不入缺省集，其余照常", () => {
		const entries = [
			makeRegisterEntry("sm-life", { type: "session", kind: "lifetime" }),
			makeRegisterEntry("sm-send", { type: "session" }),
			makeRegisterEntry("bt-1", { type: "bash" }),
		];
		expect(computeCollectWaitKeys(entries, "sess-current")).toEqual(["sm-send", "bt-1"]);
	});

	it("升级边沿：无 kind 的旧 session register（send 债权缺省语义）不排除", () => {
		const entries = [makeRegisterEntry("sm-legacy", { type: "session" })];
		expect(computeCollectWaitKeys(entries, "sess-current")).toEqual(["sm-legacy"]);
	});

	it("[跨 session 残留反向断言] sessionId ≠ 当前的继承注册不入缺省集；本 session 计入", () => {
		// fork 继承的父级注册残留：不滤则子 session 缺省 collect 恒挂继承残留（设计 §3.1③）
		const entries = [
			makeRegisterEntry("parent-bg", { sessionId: "sess-old" }),
			makeRegisterEntry("own-bg"),
		];
		expect(computeCollectWaitKeys(entries, "sess-current")).toEqual(["own-bg"]);
	});

	it("entry 缺 sessionId 的旧形态条目视为本 session（不过滤，宁放行不误逐）", () => {
		const legacy: MockSessionEntry = {
			customType: "pending:register",
			data: { id: "old-1", type: "subagent", name: "o", registeredAt: NOW },
		};
		expect(computeCollectWaitKeys([legacy], "sess-current")).toEqual(["old-1"]);
	});

	it("currentSessionId 空串回退（session_start 未到）：不过滤", () => {
		const entries = [makeRegisterEntry("a", { sessionId: "s-other" }), makeRegisterEntry("b")];
		expect(computeCollectWaitKeys(entries, "")).toEqual(["a", "b"]);
	});

	it("[共享函数缺省语义不动] countActiveFromEntries 仍计 lifetime 为活跃（goal/subagent-workflow 零变化）", () => {
		// 排除只发生在 computeCollectWaitKeys（工具侧减法）——countActiveFromEntries
		// 缺省语义不变是任务书机械判据③与设计 §3.4 排除归属显式约定的锁定面。
		const entries = [makeRegisterEntry("sm-life", { type: "session", kind: "lifetime" })];
		expect(countActiveFromEntries(entries).ids).toEqual(["sm-life"]);
	});
});

// scanPendingFields（终局回填字段视图）的用例已随 MF-2-1 单点收敛移至 protocol：
// packages/extension-protocol/src/pending-entries.test.ts「字段映射视图」describe
// （register 首见 type + 注销 status 词表成员判定，同一规则供本包回填与
// delivery-port 快照基线消费）。

// ────────────────────────────────────────────────────
// collect_results 工具（mock port 注入）
// ────────────────────────────────────────────────────

describe("collect_results tool", () => {
	let setup: MockSetup;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		setup = createMockSetup();
		pendingNotificationsExtension(setup.pi);
		fireSessionStart(setup);
	});

	afterEach(() => {
		portMocks.getDeliveryPort.mockReset();
		vi.useRealTimers();
	});

	it("工具注册形态：name=collect_results、executionMode=sequential", () => {
		const tool = getCollectTool(setup);
		expect(tool.executionMode).toBe("sequential");
		expect(tool.description).toBeTruthy();
	});

	it("无 ids 且无活跃 pending → 立即空返回，端口零触达（等待集为空不进入等待）", async () => {
		const res = await runCollect(setup, {});

		expect(res.details.collected).toEqual([]);
		expect(res.details.stillOpen).toEqual([]);
		expect(res.details.errors).toBeUndefined();
		expect(portMocks.getDeliveryPort).not.toHaveBeenCalled();
	});

	it("缺省集 = 活跃 − lifetime 债权 − 跨 session 残留：collectArm 只收到本 session 非 lifetime 键", async () => {
		setup.entries.push(
			makeRegisterEntry("sm-life", { type: "session", kind: "lifetime" }),
			makeRegisterEntry("parent-bg", { sessionId: "sess-old" }),
			makeRegisterEntry("own-1"),
		);

		await runCollect(setup, {});

		expect(setup.port.collectArm).toHaveBeenCalledWith(["own-1"]);
	});

	it("只有 lifetime 债权时缺省 collect 立即空返回（排除后等待集为空，不挂满超时）", async () => {
		setup.entries.push(makeRegisterEntry("sm-life", { type: "session", kind: "lifetime" }));

		const res = await runCollect(setup, {});

		expect(res.details).toEqual({ collected: [], stillOpen: [] });
		expect(setup.port.collectArm).not.toHaveBeenCalled();
	});

	it("快照 ready 合并进 collected（已完成收取，读侧快照；无等待则不订阅到达回调）", async () => {
		setup.entries.push(makeRegisterEntry("w-1"));
		setup.port.collectArm.mockReturnValue([
			{ id: "w-1", state: "ready", entry: { type: "workflow", outcome: "completed", content: "done!" } },
		]);

		const res = await runCollect(setup, {});

		expect(res.details.collected).toEqual([
			{ id: "w-1", type: "workflow", outcome: "completed", content: "done!" },
		]);
		expect(res.details.stillOpen).toEqual([]);
		expect(setup.port.onCollectArrival).not.toHaveBeenCalled();
		// 快照收取不写新终局（读侧快照），但等待集登记须解散
		expect(setup.port.consume).toHaveBeenCalled();
		expect(setup.port.collectRelease).toHaveBeenCalled();
	});

	it("in-push-pipeline → stillOpen 附 note（不收取不等待）", async () => {
		setup.entries.push(makeRegisterEntry("w-2"));
		setup.port.collectArm.mockReturnValue([{ id: "w-2", state: "in-push-pipeline" }]);

		const res = await runCollect(setup, {});

		expect(res.details.collected).toEqual([]);
		expect(res.details.stillOpen).toEqual([
			{ id: "w-2", note: expect.stringContaining("push pipeline") },
		]);
		expect(setup.port.collectRelease).toHaveBeenCalled();
	});

	it("第四态 unregistered-no-entry 返回形态：outcome=注销 status + note、无 content、不虚构载荷", async () => {
		setup.entries.push(makeRegisterEntry("sm-1"));
		setup.port.collectArm.mockReturnValue([
			{
				id: "sm-1",
				state: "unregistered-no-entry",
				entry: { type: "session", outcome: "cancelled", note: "settled via unregister entry, no payload" },
			},
		]);

		const res = await runCollect(setup, {});

		expect(res.details.collected).toEqual([
			{ id: "sm-1", type: "session", outcome: "cancelled", note: "settled via unregister entry, no payload" },
		]);
		expect("content" in res.details.collected[0]).toBe(false);
	});

	it("到达等待路径：collectArm 等待 → 到达回调 consume → 全键到齐返回 collected 并解散等待集", async () => {
		setup.entries.push(makeRegisterEntry("w-1"));
		setup.port.collectArm.mockReturnValue([{ id: "w-1", state: "waiting" }]);

		const promise = runCollect(setup, {});
		// execute 同步段已跑到 await（collectArm + onCollectArrival 订阅完成）
		const arrivalCb = setup.port.onCollectArrival.mock.calls[0][0] as () => void;
		const unsubscribe = setup.port.onCollectArrival.mock.results[0].value as ReturnType<typeof vi.fn>;
		// 端口 consume 的真实返回形态（MF-1-6）：只含 {id, content, details}——type/outcome
		// 由工具侧终局回填（register entry 在册 → type；注销不在册 → outcome 缺省）
		setup.port.consume.mockReturnValueOnce([
			{ id: "w-1", content: "payload" },
		]);

		arrivalCb();
		const res = await promise;

		expect(res.details.collected).toEqual([
			{ id: "w-1", type: "workflow", content: "payload" },
		]);
		expect(res.details.stillOpen).toEqual([]);
		expect(setup.port.collectRelease).toHaveBeenCalledTimes(1);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("[同步到达 outcome 回填] 等待中到达的条目：consume 时点注销未落盘 outcome 取空，返回组装前从注销 entry 回填（U1）", async () => {
		// 时序镜像（managed flushBatch，watch-coordinator.ts:323-329）：deliver（到达
		// 回调在 deliver 栈内同步触发 pullArrived→consume，此刻注销 entry 未落盘）→
		// 同步段后半 unregisterPending 落盘 → await 恢复后回填生效。
		setup.entries.push(makeRegisterEntry("sm-1", { type: "session" }));
		setup.port.collectArm.mockReturnValue([{ id: "sm-1", state: "waiting" }]);

		const promise = runCollect(setup, {});
		const arrivalCb = setup.port.onCollectArrival.mock.calls[0][0] as () => void;
		// 端口 consume 的真实返回形态：载荷在、type/outcome 取不到（注销尚未落盘——
		// register 已落盘但本用例镜像 deliver 栈内时点，mock 按最简形态不给 type）
		setup.port.consume.mockReturnValueOnce([
			{ id: "sm-1", content: "2 queued messages done", details: { fulfills: 2 } },
		]);

		arrivalCb(); // deliver 同步栈前半：consume 取走载荷，outcome 缺失
		setup.handlers.pendingUnregister!({ id: "sm-1", reason: "completed" }); // 同步栈后半：注销落盘（listener 走 mapReasonToStatus）

		const res = await promise;

		expect(res.details.collected).toEqual([
			{ id: "sm-1", type: "session", outcome: "completed", content: "2 queued messages done", details: { fulfills: 2 } },
		]);
		// 注销 entry 已由真实 listener 落盘（回填源在本 session entries 现算）
		expect(
			setup.entries.some((e) => e.customType === "pending:unregister" && e.data.id === "sm-1"),
		).toBe(true);
	});

	it("[outcome 回填反向断言] 注销 entry 不在册的收取条目 outcome 保持 undefined（不虚构终态）", async () => {
		setup.entries.push(makeRegisterEntry("w-1"));
		setup.port.collectArm.mockReturnValue([{ id: "w-1", state: "waiting" }]);

		const promise = runCollect(setup, {});
		const arrivalCb = setup.port.onCollectArrival.mock.calls[0][0] as () => void;
		setup.port.consume.mockReturnValueOnce([
			{ id: "w-1", content: "payload without unregister" },
		]);

		arrivalCb();
		const res = await promise;

		expect(res.details.collected).toEqual([
			{ id: "w-1", type: "workflow", outcome: undefined, content: "payload without unregister" },
		]);
	});

	it("[结清五值回填 §3.3.6] 注销 reason 事实经结清解析回填 outcome：completed/failed/cancelled/lost/no_result 分别可达", async () => {
		// 回填权威 = 结清视图（reason 事实 → resolveSettlementReason），不经
		// mapReasonToStatus 旧映射——lost/no_result 在旧 status 副档恒落 unknown，
		// 本用例五值逐一可达即锁定断层修复（真 listener 落盘 → 全链路回填）。
		const cases: Array<[string, string]> = [
			["ok-1", "completed"],
			["ok-2", "failed"],
			["ok-3", "cancelled"],
			["ok-4", "lost"],
			["ok-5", "no_result"],
		];
		for (const [id] of cases) setup.entries.push(makeRegisterEntry(id));
		setup.port.collectArm.mockReturnValue(cases.map(([id]) => ({ id, state: "waiting" })));

		const promise = runCollect(setup, { ids: cases.map(([id]) => id) });
		const arrivalCb = setup.port.onCollectArrival.mock.calls[0][0] as () => void;
		// 真实 listener 落盘注销 entry：reason 事实 + mapReasonToStatus 的 status 副档
		// （lost/no_result 的 status 落 unknown——旧映射通道下 outcome 恒 unknown 的缺陷形态）
		for (const [id, reason] of cases) setup.handlers.pendingUnregister!({ id, reason });
		// 端口 consume 真实返回形态（MF-1-6）：只含载荷，type/outcome 归回填
		setup.port.consume.mockReturnValueOnce(cases.map(([id]) => ({ id, content: `payload-${id}` })));

		arrivalCb();
		const res = await promise;

		expect(res.details.collected).toEqual(
			cases.map(([id, outcome]) => ({
				id,
				type: "workflow",
				outcome,
				content: `payload-${id}`,
			})),
		);
	});

	it("超时路径：已收部分进 collected、未完成进 stillOpen（诚实返回，不抛错）", async () => {
		setup.entries.push(makeRegisterEntry("fast"), makeRegisterEntry("slow"));
		setup.port.collectArm.mockReturnValue([
			{ id: "fast", state: "waiting" },
			{ id: "slow", state: "waiting" },
		]);

		const promise = runCollect(setup, { timeout_ms: 5_000 });
		const arrivalCb = setup.port.onCollectArrival.mock.calls[0][0] as () => void;
		setup.port.consume
			.mockReturnValueOnce([{ id: "fast", content: "fast done" }])
			.mockReturnValue([]);

		arrivalCb(); // fast 到达，slow 仍等
		await vi.advanceTimersByTimeAsync(5_000);
		const res = await promise;

		expect(res.details.collected).toEqual([{ id: "fast", type: "workflow", content: "fast done" }]);
		expect(res.details.stillOpen).toEqual([{ id: "slow" }]);
		expect(setup.port.collectRelease).toHaveBeenCalledTimes(1);
	});

	it("timeout_ms 缺省 = 3_600_000（量级决策 §3.3：缺省 1h 前不判超时）", async () => {
		setup.entries.push(makeRegisterEntry("w-1"));
		setup.port.collectArm.mockReturnValue([{ id: "w-1", state: "waiting" }]);

		const promise = runCollect(setup, {});
		await vi.advanceTimersByTimeAsync(3_599_999);
		// 最后一毫秒之前：缺省超时 timer 仍在（未判超时）
		expect(vi.getTimerCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(1);
		const res = await promise;
		expect(res.details.stillOpen).toEqual([{ id: "w-1" }]);
	});

	it("abort 捕获后正常 return（禁抛错路径）：已收部分返回、未收进 stillOpen", async () => {
		setup.entries.push(makeRegisterEntry("w-1"), makeRegisterEntry("w-2"));
		setup.port.collectArm.mockReturnValue([
			{ id: "w-1", state: "waiting" },
			{ id: "w-2", state: "waiting" },
		]);
		const controller = new AbortController();

		const promise = runCollect(setup, {}, controller.signal);
		const arrivalCb = setup.port.onCollectArrival.mock.calls[0][0] as () => void;
		setup.port.consume
			.mockReturnValueOnce([{ id: "w-1", content: "partial" }])
			.mockReturnValue([]);

		arrivalCb(); // w-1 到达
		controller.abort(); // 用户打断
		const res = await promise; // 不抛错即通过

		expect(res.details.collected).toEqual([{ id: "w-1", type: "workflow", content: "partial" }]);
		expect(res.details.stillOpen).toEqual([{ id: "w-2" }]);
		expect(setup.port.collectRelease).toHaveBeenCalledTimes(1);
	});

	it("调用前已 aborted 的 signal：直接返回、不订阅到达回调", async () => {
		setup.entries.push(makeRegisterEntry("w-1"));
		setup.port.collectArm.mockReturnValue([{ id: "w-1", state: "waiting" }]);
		const controller = new AbortController();
		controller.abort();

		const res = await runCollect(setup, {}, controller.signal);

		expect(res.details.stillOpen).toEqual([{ id: "w-1" }]);
		expect(setup.port.onCollectArrival).not.toHaveBeenCalled();
		expect(setup.port.collectRelease).toHaveBeenCalledTimes(1);
	});

	it("未知 id → errors 逐条列出、不阻断已知子集（collectArm 收全量键，unknown 态由端口定态回流）", async () => {
		setup.entries.push(makeRegisterEntry("w-1"));
		setup.port.collectArm.mockReturnValue([
			{ id: "w-1", state: "waiting" },
			{ id: "ghost", state: "unknown" },
		]);

		const promise = runCollect(setup, { ids: ["w-1", "ghost", "ghost"] });
		const arrivalCb = setup.port.onCollectArrival.mock.calls[0][0] as () => void;
		setup.port.consume.mockReturnValueOnce([{ id: "w-1", content: "ok" }]);

		arrivalCb();
		const res = await promise;

		// 已知子集照常等待并收取；显式 ids 全量（去重）交端口定态（MF-1-5：未知判定单点在端口）
		expect(setup.port.collectArm).toHaveBeenCalledWith(["w-1", "ghost"]);
		expect(res.details.collected).toEqual([{ id: "w-1", type: "workflow", content: "ok" }]);
		// 未知 id 去重后逐条列出
		expect(res.details.errors).toEqual([
			{ id: "ghost", reason: expect.stringContaining("unknown id") },
		]);
		expect(res.content[0].text).toContain("ghost");
	});

	it("全部 ids 未知 → 立即返回 errors（collectArm 定态全 unknown，不进入等待）", async () => {
		setup.port.collectArm.mockReturnValue([
			{ id: "ghost-a", state: "unknown" },
			{ id: "ghost-b", state: "unknown" },
		]);

		const res = await runCollect(setup, { ids: ["ghost-a", "ghost-b"] });

		expect(res.details.collected).toEqual([]);
		expect(res.details.stillOpen).toEqual([]);
		expect(res.details.errors).toHaveLength(2);
		// 未知键不登记等待集：不订阅到达回调、不挂满超时
		expect(setup.port.onCollectArrival).not.toHaveBeenCalled();
		expect(setup.port.collectArm).toHaveBeenCalledWith(["ghost-a", "ghost-b"]);
	});

	it("已完结 id（register+unregister 在册）不算未知 → collectArm 收键（第四态/快照收取入口）", async () => {
		setup.entries.push(
			makeRegisterEntry("done-1"),
			{ customType: "pending:unregister", data: { id: "done-1", reason: "completed", status: "completed" } },
		);
		setup.port.collectArm.mockReturnValue([
			{
				id: "done-1",
				state: "unregistered-no-entry",
				entry: { type: "workflow", outcome: "completed", note: "no payload" },
			},
		]);

		const res = await runCollect(setup, { ids: ["done-1"] });

		expect(setup.port.collectArm).toHaveBeenCalledWith(["done-1"]);
		expect(res.details.errors).toBeUndefined();
		expect(res.details.collected).toEqual([
			{ id: "done-1", type: "workflow", outcome: "completed", note: "no payload" },
		]);
	});

	it("重复收取 = 快照重收：同 id 二次 collect 再次返回原载荷（工具侧无拒绝分支）", async () => {
		setup.entries.push(makeRegisterEntry("w-1"));
		setup.port.collectArm.mockReturnValue([
			{ id: "w-1", state: "ready", entry: { type: "workflow", outcome: "completed", content: "payload" } },
		]);

		const first = await runCollect(setup, { ids: ["w-1"] });
		const second = await runCollect(setup, { ids: ["w-1"] });

		expect(first.details.collected).toEqual(second.details.collected);
	});

	it("port 缺席（槽未装配）→ 正常返回不可用文案 + 不抛错", async () => {
		portMocks.getDeliveryPort.mockReturnValue(undefined);
		setup.entries.push(makeRegisterEntry("w-1"));

		const res = await runCollect(setup, {});

		expect(res.details.collected).toEqual([]);
		expect(res.details.stillOpen).toEqual([]);
		expect(res.content[0].text).toContain("unavailable");
	});

	it("content 文本承载收取载荷（collected content 随文本到达 agent）", async () => {
		setup.entries.push(makeRegisterEntry("w-1"));
		setup.port.collectArm.mockReturnValue([
			{ id: "w-1", state: "ready", entry: { type: "workflow", outcome: "completed", content: "result body" } },
		]);

		const res = await runCollect(setup, {});

		expect(res.content[0].text).toContain("w-1");
		expect(res.content[0].text).toContain("result body");
	});
});

// ────────────────────────────────────────────────────
// kind 读取链写侧落点（pending:register listener 落盘透传）
// ────────────────────────────────────────────────────

describe("pending:register kind 透传（lifetime 标记落盘）", () => {
	let setup: MockSetup;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		setup = createMockSetup();
		pendingNotificationsExtension(setup.pi);
		fireSessionStart(setup);
	});

	afterEach(() => {
		portMocks.getDeliveryPort.mockReset();
		vi.useRealTimers();
	});

	it("register event 带 kind=lifetime → 落盘 entry data 透传 kind；读取侧归一化回读", () => {
		setup.handlers.pendingRegister!({ id: "sm-life", type: "session", name: "ms", kind: "lifetime" });

		const regCall = setup.appendEntryMock.mock.calls.find((c) => c[0] === "pending:register");
		expect(regCall).toBeDefined();
		expect(regCall![1]).toMatchObject({ id: "sm-life", kind: "lifetime" });

		// 读取链闭环：normalizeRegisterEntry 白名单透传后工具侧可读到 kind
		const res = countActiveFromEntries(setup.entries as unknown[]);
		expect(res.entries[0].kind).toBe("lifetime");
	});

	it("register event 不带 kind → 落盘 entry 无 kind 键（非 managed 注册零字段增量）", () => {
		setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "op" });

		const regCall = setup.appendEntryMock.mock.calls.find((c) => c[0] === "pending:register");
		expect("kind" in regCall![1]).toBe(false);
	});

	it("register event kind 值不在白名单（如未来新值）→ 不透传（缺省 send 债权语义）", () => {
		setup.handlers.pendingRegister!({ id: "w-x", type: "session", name: "ms", kind: "future-kind" });

		const regCall = setup.appendEntryMock.mock.calls.find((c) => c[0] === "pending:register");
		expect("kind" in regCall![1]).toBe(false);
	});
});
