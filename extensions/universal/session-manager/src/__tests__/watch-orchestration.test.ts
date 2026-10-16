// watch-orchestration.test.ts — notify-once U4 extension 编排单测（mock select 响应）。
// 覆盖：send/create arm（register 三键 + 开表不传 timeout + willNotify 透传）/
// reason 类别分支 / deathSeq·settleSeq 分组去重（两层攒批模型）/ 两例外（cancelled·orphaned
// 静默 + 死亡新闻槽）/ port.deliver 幂等键与通道（外部通道逐条）。
//
// watch select 全部走 deferred：开表时挂起，用例按调用序精确控制应答时机与内容
// （覆盖「晚 respond」「W1 悬置 W2 应答」等时序形态）。
// pi/ctx 装配、respondWatch、flushMicrotasks 走共享 harness（helpers/extension-harness.ts）；
// select 的 action 分发（actionResults / deferred watch）为本文件域行为，留在本地。

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { SESSION_MANAGER_MARKER } from "@zhushanwen/extension-protocol";
// logger mock helper 必须先于 extension-harness（其 import 链触发被 mock 模块加载）
import { createLoggerModuleMock, getLoggerMock } from "./helpers/logger-mock.ts";
import {
import { DELIVERY_PORT_SLOT_KEY } from "@zhushanwen/pi-delivery-port";
	flushMicrotasks,
	makeRespondWatch,
	mountExtension,
	runToolCall,
	runToolForText,
	type ExtensionHarness,
	type WatchInvocation,
} from "./helpers/extension-harness.ts";

vi.mock("@zhushanwen/pi-extension-logger", () => createLoggerModuleMock());

const loggerMock = getLoggerMock();

// pi-delivery-port 进程级槽（C-ext-06；recordManagedNotify 的消费入口——unified-
// delivery 波 2 切换后 watch 应答的投递观察面 = port.deliver）。
const PORT_SLOT_KEY = Symbol.for(DELIVERY_PORT_SLOT_KEY);

/** watch 开表调用（deferred）——opts 为开表时传入的 select 第三参原样值 */
interface DeferredWatch extends WatchInvocation {
	opts: { timeout?: number } | undefined;
}

interface Harness extends ExtensionHarness {
	selectMock: Mock;
	entries: unknown[];
	/** 非 watch action 的回包（JSON 字符串），用例在跑工具前置位 */
	actionResults: Record<string, () => string>;
	/** 按开表顺序排列的 watch 调用（deferred 应答入口） */
	watches: DeferredWatch[];
	/** 按调用序 resolve 第 n 次 watch（value = select 回包原样值） */
	respondWatch(index: number, value: unknown): void;
}

function createHarness(entries: unknown[] = []): Harness {
	const watches: DeferredWatch[] = [];
	const actionResults: Record<string, () => string> = {};
	const selectMock = vi.fn((marker: unknown, args: unknown[], opts?: unknown) => {
		expect(marker).toBe(SESSION_MANAGER_MARKER);
		const payload = JSON.parse((args as string[])[0]) as {
			action: string;
			params: Record<string, unknown>;
		};
		if (payload.action === "watch") {
			return new Promise((resolve) => {
				watches.push({
					notifyId: String(payload.params.notifyId),
					opts: opts as { timeout?: number } | undefined,
					resolve,
				});
			});
		}
		const produce = actionResults[payload.action];
		return Promise.resolve(produce ? produce() : '{"ok":true}');
	});
	return {
		...mountExtension(selectMock, entries),
		selectMock,
		entries,
		actionResults,
		watches,
		respondWatch: makeRespondWatch(watches),
	};
}

function emittedIds(h: Harness, event: string): string[] {
	return h.emitted.filter((e) => e.event === event).map((e) => e.data.id as string);
}

function registersOf(h: Harness): Array<{ id: string; type: unknown; name: unknown }> {
	return h.emitted
		.filter((e) => e.event === "pending:register")
		.map((e) => ({ id: String(e.data.id), type: e.data.type, name: e.data.name }));
}

const SEND_OK = '{"queued":true,"willNotify":true}';
const SEND_NO_NOTIFY = '{"queued":true,"willNotify":false}';

type DeliverCall = {
	id: string | undefined;
	customType: string;
	content: string;
	details: unknown;
};

/** 植入投递端口槽（pi-delivery-port 槽镜像的读取目标）——deliver spy 由用例自持；
 *  merge 判定在端口侧，本替身逐条受理即 accepted（无窗口语义，recorded 即投递）。 */
function plantPort(acceptAll = true): Array<DeliverCall> {
	const calls: Array<DeliverCall> = [];
	Reflect.set(globalThis, PORT_SLOT_KEY, {
		current: {
			deliver: (envelope: {
				id?: string;
				payload: { customType: string; content: string; details?: unknown };
			}) => {
				if (!acceptAll) return { kind: "rejected", reason: "persist-failed (fake)" };
				calls.push({
					id: envelope.id,
					customType: envelope.payload.customType,
					content: envelope.payload.content,
					details: envelope.payload.details,
				});
				return { kind: "accepted", id: envelope.id ?? "gen-id" };
			},
			flush: () => {},
		},
	});
	return calls;
}

function deliverSpy(): Array<DeliverCall> {
	return plantPort(true);
}

/** 「兼容与防御」组共用前置：植入投递端口（deliver spy）→ arm 单笔 send → 应答首个 watch →
 * 排干微任务 → 推进 50ms 攒批窗（三用例的时序骨架逐字同款） */
async function armSendAndRespondWatch(
	respondValue: unknown,
): Promise<{ delivered: Array<DeliverCall>; h: Harness }> {
	const delivered = deliverSpy();
	const h = createHarness();
	h.actionResults.send = () => SEND_OK;
	await runToolCall(h, "send_to_session", { sessionId: "child-1", prompt: "x" });
	await flushMicrotasks();
	h.respondWatch(0, respondValue);
	await flushMicrotasks();
	await vi.advanceTimersByTimeAsync(50);
	return { delivered, h };
}

beforeEach(() => {
	vi.useFakeTimers();
	loggerMock.warn.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	Reflect.deleteProperty(globalThis, PORT_SLOT_KEY);
});

// ── arm：send/create 成功 → register + 开表 + willNotify 透传 ──────────────────

describe("arm（send/create → pending:register + watch 开表）", () => {
	it("send willNotify:true → register 三键 {id=notifyId, type:'session', name} + 开表（watch 不传 timeout）", async () => {
		const h = createHarness();
		h.actionResults.send = () => SEND_OK;
		await runToolCall(h, "send_to_session", { sessionId: "child-1", prompt: "go" });
		await flushMicrotasks();

		// 请求面：send params 携带 sm- 形态 notifyId
		const sendPayload = JSON.parse(h.selectMock.mock.calls[0][1][0]) as {
			action: string;
			params: Record<string, unknown>;
		};
		expect(sendPayload.action).toBe("send");
		expect(String(sendPayload.params.notifyId)).toMatch(/^sm-/);

		// register：P4 三键契约（label 缓存空 → name 退化 sessionId）
		const regs = registersOf(h);
		expect(regs).toHaveLength(1);
		expect(regs[0].id).toMatch(/^sm-/);
		expect(regs[0]).toEqual({ id: regs[0].id, type: "session", name: "child-1" });

		// 开表：同 notifyId、无 timeout（D2/P1 fire-and-forget）
		expect(h.watches).toHaveLength(1);
		expect(h.watches[0].notifyId).toBe(regs[0].id);
		expect(h.watches[0].opts?.timeout).toBeUndefined();
	});

	it("工具结果原样透传：send result 含 willNotify 字段（LLM 契约面显式化）", async () => {
		const h = createHarness();
		h.actionResults.send = () => SEND_OK;
		const result = await runToolForText(h, "send_to_session", {
			sessionId: "child-1",
			prompt: "go",
		});
		expect(Object.hasOwn(result, "isError")).toBe(false);
		expect(JSON.parse(result.content[0].text)).toEqual({ queued: true, willNotify: true });
	});

	it("create 带 prompt → claim + lifetime 双 register 双开表；label 入 name 与缓存（随后 send 复用）", async () => {
		const lifetime = "sm-11111111-2222-3333-4444-555555555555";
		const h = createHarness();
		h.actionResults.create = () =>
			JSON.stringify({
				sessionId: "child-9",
				status: "created",
				willNotify: true,
				lifetimeNotifyId: lifetime,
			});
		h.actionResults.send = () => SEND_OK;
		await runToolCall(h, "create_managed_session", {
			cwd: "/w",
			label: "auth-refactor",
			prompt: "do it",
		});
		await flushMicrotasks();

		const regs = registersOf(h);
		expect(regs).toHaveLength(2);
		expect(regs[0].id).toMatch(/^sm-/);
		expect(regs[0]).toEqual({ id: regs[0].id, type: "session", name: "auth-refactor" });
		expect(regs[1]).toEqual({ id: lifetime, type: "session", name: "auth-refactor" });
		expect(h.watches.map((w) => w.notifyId)).toEqual([regs[0].id, lifetime]);

		// label 缓存回填：随后 send 的 register name = 工具入参 label（D9 正常路径）
		await runToolCall(h, "send_to_session", { sessionId: "child-9", prompt: "again" });
		await flushMicrotasks();
		const afterSend = registersOf(h);
		expect(afterSend).toHaveLength(3);
		expect(afterSend[2].name).toBe("auth-refactor");
		expect(afterSend[2].id).toMatch(/^sm-/);
	});

	it("create 无 prompt → 请求不带 notifyId；willNotify:false → 零 claim register，仅 lifetime（D-12 核验：裁决1 只封 claim，lifetime watch 是裁决2 载体必须无条件开）", async () => {
		const lifetime = "sm-11111111-2222-3333-4444-555555555555";
		const h = createHarness();
		h.actionResults.create = () =>
			JSON.stringify({
				sessionId: "child-9",
				status: "created",
				willNotify: false,
				lifetimeNotifyId: lifetime,
			});
		await runToolCall(h, "create_managed_session", { cwd: "/w", label: "L" });
		await flushMicrotasks();

		const createPayload = JSON.parse(h.selectMock.mock.calls[0][1][0]) as {
			params: Record<string, unknown>;
		};
		expect(createPayload.params.notifyId).toBeUndefined();
		const regs = registersOf(h);
		expect(regs).toHaveLength(1);
		// lifetime register：type 'session' + name=label（label 缺省 → sessionId 回退前的入参）
		expect(regs[0]).toEqual({ id: lifetime, type: "session", name: "L" });
		// lifetime watch 无条件开（死亡通知载体）
		expect(h.watches.map((w) => w.notifyId)).toEqual([lifetime]);
		expect(h.watches[0].opts?.timeout).toBeUndefined();
	});

	it("willNotify:false 的 send（runtime 未 arm）→ 零 register 零开表", async () => {
		const h = createHarness();
		h.actionResults.send = () => SEND_NO_NOTIFY;
		await runToolCall(h, "send_to_session", { sessionId: "child-1", prompt: "x" });
		await flushMicrotasks();
		expect(registersOf(h)).toHaveLength(0);
		expect(h.watches).toHaveLength(0);
	});

	it("list 结果回填 label 缓存（进程重启后 send name 的兜底源）", async () => {
		const h = createHarness();
		h.actionResults.list = () =>
			JSON.stringify({ sessions: [{ id: "c1", label: "restored-label" }], undeliveredResults: 0 });
		h.actionResults.send = () => SEND_OK;
		await runToolCall(h, "list_my_sessions", {});
		await runToolCall(h, "send_to_session", { sessionId: "c1", prompt: "x" });
		await flushMicrotasks();
		const regs = registersOf(h);
		expect(regs).toHaveLength(1);
		expect(regs[0].name).toBe("restored-label");
	});
});

// ── 默认 record + trailing debounce 两层攒批（settle 腿） ──────────────────────

describe("watch 应答 → 两层攒批 record（settle 腿）", () => {
	async function armTwoSends(h: Harness): Promise<{ id1: string; id2: string }> {
		h.actionResults.send = () => SEND_OK;
		await runToolCall(h, "send_to_session", { sessionId: "child-1", prompt: "a" });
		await runToolCall(h, "send_to_session", { sessionId: "child-1", prompt: "b" });
		await flushMicrotasks();
		const ids = emittedIds(h, "pending:register");
		expect(ids).toHaveLength(2);
		expect(h.watches).toHaveLength(2);
		return { id1: ids[0], id2: ids[1] };
	}

	it("同 settleSeq 两笔 → 恰一条 record（fulfills 2）+ 逐笔 unregister；trailing 50ms 前不 flush（A6 合批）", async () => {
		const delivered = deliverSpy();
		const h = createHarness();
		const { id1, id2 } = await armTwoSends(h);

		const respond = {
			reason: "completed",
			sessionId: "child-1",
			settleSeq: 7,
			fulfillsN: 2,
		};
		h.respondWatch(0, JSON.stringify(respond));
		h.respondWatch(1, JSON.stringify(respond));
		await flushMicrotasks();

		// trailing debounce：应答到达但 50ms 窗未到 → 零投递零 unregister
		expect(delivered).toHaveLength(0);
		expect(emittedIds(h, "pending:unregister")).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(50);
		expect(delivered).toHaveLength(1);
		const call = delivered[0]!;
		expect(call.id).toBe(id1); // 批幂等键 = 批内首个响应 notifyId（port.deliver 的 id）
		expect(call.content).toBe(
			'Managed session "child-1" (child-1) finished with status "completed". (fulfills 2 requests)',
		);
		expect(call.details).toEqual({
			notifyId: id1,
			sessionId: "child-1",
			reason: "completed",
			fulfills: 2,
			label: "child-1",
		});
		expect(call.customType).toBe("managed-session-notify"); // 外部通道（port 批组隔离恒逐条）
		expect(emittedIds(h, "pending:unregister").sort()).toEqual([id1, id2].sort());
		expect(
			h.emitted.filter((e) => e.event === "pending:unregister").map((e) => e.data.reason),
		).toEqual(["completed", "completed"]);
	});

	it("不同 settleSeq → 两条 record（A7：每轮一次，seq 边界排除跨轮合流）", async () => {
		const delivered = deliverSpy();
		const h = createHarness();
		const { id1, id2 } = await armTwoSends(h);
		h.respondWatch(
			0,
			JSON.stringify({ reason: "completed", sessionId: "child-1", settleSeq: 7, fulfillsN: 1 }),
		);
		h.respondWatch(
			1,
			JSON.stringify({ reason: "completed", sessionId: "child-1", settleSeq: 8, fulfillsN: 1 }),
		);
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(50);
		expect(delivered).toHaveLength(2);
		expect(delivered.map((c) => c.id).sort()).toEqual([id1, id2].sort());
		expect(emittedIds(h, "pending:unregister")).toHaveLength(2);
	});

	it("reason 分类：failed / stopped 应答 → 文案 status 对应（渲染侧 outcome 再映射）", async () => {
		const delivered = deliverSpy();
		const h = createHarness();
		const { id1, id2 } = await armTwoSends(h);
		h.respondWatch(
			0,
			JSON.stringify({ reason: "failed", sessionId: "child-1", settleSeq: 1, fulfillsN: 1 }),
		);
		h.respondWatch(
			1,
			JSON.stringify({ reason: "stopped", sessionId: "child-1", settleSeq: 2, fulfillsN: 1 }),
		);
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(50);
		expect(delivered).toHaveLength(2);
		const byId = new Map(delivered.map((c) => [c.id, c.content] as const));
		expect(byId.get(id1)).toContain('status "failed"');
		expect(byId.get(id2)).toContain('status "stopped"');
	});

	it("跨 session 不合批（分拣键 sessionId 腿）：同 settleSeq 不同 session → 两条 record", async () => {
		const delivered = deliverSpy();
		const h = createHarness();
		h.actionResults.send = () => SEND_OK;
		await runToolCall(h, "send_to_session", { sessionId: "child-a", prompt: "x" });
		await runToolCall(h, "send_to_session", { sessionId: "child-b", prompt: "y" });
		await flushMicrotasks();
		expect(h.watches).toHaveLength(2);
		h.respondWatch(
			0,
			JSON.stringify({ reason: "completed", sessionId: "child-a", settleSeq: 3, fulfillsN: 1 }),
		);
		h.respondWatch(
			1,
			JSON.stringify({ reason: "completed", sessionId: "child-b", settleSeq: 3, fulfillsN: 1 }),
		);
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(50);
		expect(delivered).toHaveLength(2);
		const sessions = delivered.map((c) => (c.details as { sessionId: string }).sessionId);
		expect(sessions.sort()).toEqual(["child-a", "child-b"]);
	});

	it("port rejected（persist-failed）/槽空降级 → false 不改 unregister 语义", async () => {
		Reflect.set(globalThis, PORT_SLOT_KEY, {
			current: {
				deliver: () => ({ kind: "rejected", reason: "persist-failed (fake)" }),
				flush: () => {},
			},
		});
		const h = createHarness();
		await armTwoSends(h);
		const respond = {
			reason: "completed",
			sessionId: "child-1",
			settleSeq: 1,
			fulfillsN: 1,
		};
		h.respondWatch(0, JSON.stringify(respond));
		h.respondWatch(1, JSON.stringify(respond));
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(50);
		expect(emittedIds(h, "pending:unregister")).toHaveLength(2);
	});
});

// ── 两例外（D3）─────────────────────────────────────────────────────────────────

describe("两例外（cancelled·orphaned 静默 / 死亡新闻槽）", () => {
	it("例外1：cancelled / orphaned → 逐笔即时 unregister（50ms 窗前即到），零投递", async () => {
		const delivered = deliverSpy();
		const h = createHarness();
		const { id1, id2 } = await armTwo();
		h.respondWatch(0, JSON.stringify({ reason: "cancelled", sessionId: "child-1" }));
		h.respondWatch(1, JSON.stringify({ reason: "orphaned", sessionId: "child-1" }));
		await flushMicrotasks();

		// 逐笔即时（不被攒批窗延迟）
		expect(emittedIds(h, "pending:unregister").sort()).toEqual([id1, id2].sort());
		expect(delivered).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(50);
		expect(delivered).toHaveLength(0);

		async function armTwo() {
			h.actionResults.send = () => SEND_OK;
			await runToolCall(h, "send_to_session", { sessionId: "child-1", prompt: "a" });
			await runToolCall(h, "send_to_session", { sessionId: "child-1", prompt: "b" });
			await flushMicrotasks();
			return { id1: emittedIds(h, "pending:register")[0], id2: emittedIds(h, "pending:register")[1] };
		}
	});

	it("例外2：同 (sessionId, deathSeq) 首条死亡新闻 record + fulfills N，同键后续仅 unregister；新 deathSeq 自然发声", async () => {
		const delivered = deliverSpy();
		const h = createHarness();
		const lifetime = "sm-11111111-2222-3333-4444-555555555555";
		h.actionResults.create = () =>
			JSON.stringify({
				sessionId: "child-d",
				status: "created",
				willNotify: true,
				lifetimeNotifyId: lifetime,
			});
		await runToolCall(h, "create_managed_session", { cwd: "/w", label: "doomed", prompt: "go" });
		await flushMicrotasks();
		const claimId = emittedIds(h, "pending:register").find((id) => id !== lifetime);
		expect(claimId).toBeDefined();
		expect(h.watches).toHaveLength(2);

		// 同 deathSeq 的 claim + lifetime 两笔应答（claim 携 exit 诊断 + transcript 指针）
		const death = {
			reason: "exited",
			sessionId: "child-d",
			deathSeq: 3,
			fulfillsN: 1,
			exitCode: 1,
			stderrTail: "boom",
			sessionFilePath: "/data/agent/sessions/child-d.jsonl",
		};
		h.respondWatch(0, JSON.stringify(death));
		h.respondWatch(1, JSON.stringify(death));
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(50);

		expect(delivered).toHaveLength(1);
		const id = delivered[0]!.id;
		const content = delivered[0]!.content;
		const details = delivered[0]!.details as Record<string, unknown>;
		expect(id).toBe(claimId); // 首条 = 批内首个响应（claim 先应答）
		expect(content).toContain(
			'Managed session "doomed" (child-d) finished with status "exited" (exit code: 1).',
		);
		expect(content).toContain("(fulfills 1 request)");
		expect(content).toContain("\nStderr: boom");
		// D-transcript：payload.sessionFilePath 透传 → Full transcript 指针行恢复
		expect(content).toContain("\nFull transcript: /data/agent/sessions/child-d.jsonl");
		expect(details.reason).toBe("exited");
		expect(emittedIds(h, "pending:unregister").sort()).toEqual([claimId, lifetime].sort());

		// 新死亡（新 deathSeq，respawn 后再死）→ 新闻自然发声；未携 sessionFilePath → 整行省略
		h.actionResults.send = () => SEND_OK;
		await runToolCall(h, "send_to_session", { sessionId: "child-d", prompt: "x" });
		await flushMicrotasks();
		expect(h.watches).toHaveLength(3);
		h.respondWatch(
			2,
			JSON.stringify({ reason: "exited", sessionId: "child-d", deathSeq: 4, fulfillsN: 0, exitCode: 2 }),
		);
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(50);
		expect(delivered).toHaveLength(2);
		expect(delivered[1]!.id).toBe(emittedIds(h, "pending:register")[2]);
		expect(delivered[1]!.content).toContain("(exit code: 2).");
		expect(delivered[1]!.content).not.toContain("fulfills");
		expect(delivered[1]!.content).not.toContain("Full transcript");
	});

	it("例外2 跨 reason 组同槽：claim 'exited' 与 lifetime 'deleted' 同 deathSeq → 仅首条发声（分拣组保序）", async () => {
		const delivered = deliverSpy();
		const lifetime = "sm-11111111-2222-3333-4444-555555555555";
		const claimId = "sm-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		const h = createHarness([
			{ customType: "pending:register", data: { id: claimId, type: "session", name: "D" } },
			{ customType: "pending:register", data: { id: lifetime, type: "session", name: "D" } },
		]);
		// 经收口腿开两条 watch（开表序 = entries 序，claim 先到）
		h.handlers.session_start({ type: "session_start" }, h.ctx);
		await flushMicrotasks();
		expect(h.watches).toHaveLength(2);

		h.respondWatch(
			0,
			JSON.stringify({ reason: "exited", sessionId: "child-d", deathSeq: 9, fulfillsN: 1 }),
		);
		h.respondWatch(
			1,
			JSON.stringify({ reason: "deleted", sessionId: "child-d", deathSeq: 9, fulfillsN: 0 }),
		);
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(50);

		expect(delivered).toHaveLength(1);
		expect(delivered[0]!.id).toBe(claimId); // 先到先占槽（claim 组先入队）
		expect(delivered[0]!.content).toContain('status "exited"');
		expect(emittedIds(h, "pending:unregister").sort()).toEqual([claimId, lifetime].sort());
		const unregisterPairs = h.emitted
			.filter((e) => e.event === "pending:unregister")
			.map((e) => [String(e.data.id), String(e.data.reason)])
			.sort();
		expect(unregisterPairs).toEqual(
			[
				[claimId, "exited"],
				[lifetime, "deleted"],
			].sort(),
		);
	});
});

// ── 兼容与防御（D6 象限 / 形状守卫）─────────────────────────────────────────────

describe("兼容与防御", () => {
	it("旧 runtime 象限：respond 'null' → 折叠 cancelled 静默 unregister，零 record", async () => {
		const { delivered, h } = await armSendAndRespondWatch("null");
		expect(delivered).toHaveLength(0);
		expect(emittedIds(h, "pending:unregister")).toHaveLength(1);
		// D6 显式静默豁免：null 不是漂移信号，零 warn 留痕
		expect(loggerMock.warn).not.toHaveBeenCalled();
	});

	it("畸形/词表外 payload → 折叠 cancelled 收口（不落 default 误标、不产通知）+ 漂移 warn 留痕", async () => {
		const { delivered, h } = await armSendAndRespondWatch(JSON.stringify({ reason: "some-future-reason" }));
		expect(delivered).toHaveLength(0);
		expect(emittedIds(h, "pending:unregister")).toHaveLength(1);
		// 协议漂移信号必须留痕：warn 带 notifyId + 漂移形态摘要（词表外 reason 原词）
		expect(loggerMock.warn).toHaveBeenCalledTimes(1);
		const [warnMsg, warnData] = loggerMock.warn.mock.calls.at(-1)!;
		expect(warnMsg).toContain("folding cancelled");
		expect(warnData).toMatchObject({
			notifyId: expect.stringMatching(/^sm-/),
			drift: expect.stringContaining("some-future-reason"),
		});
	});

	it("select 侧 cancelled（应答未达，resolve undefined）→ 不动 pending（残留交下次 session_start 收口腿）", async () => {
		const { delivered, h } = await armSendAndRespondWatch(undefined);
		expect(emittedIds(h, "pending:unregister")).toHaveLength(0);
		expect(delivered).toHaveLength(0);
	});

	// [session_compact → compactionCheck 接线随波 2 账本退役删除]：pi session
	// append-only 契约排除 entry 被清事件（unified-delivery §3.7②），无补写接线可锁。
});
