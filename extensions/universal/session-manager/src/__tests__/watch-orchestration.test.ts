// watch-orchestration.test.ts — notify-once U4 extension 编排单测（mock select 响应）。
// 覆盖：send/create arm（register 三键 + 开表不传 timeout + willNotify 透传）/
// reason 类别分支 / deathSeq·settleSeq 分组去重（两层攒批模型）/ 两例外（cancelled·orphaned
// 静默 + 死亡新闻槽）/ record 幂等键与 deliveryCustomType / session_compact 接线。
//
// watch select 全部走 deferred：开表时挂起，用例按调用序精确控制应答时机与内容
// （覆盖「晚 respond」「W1 悬置 W2 应答」等时序形态）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_MANAGER_MARKER } from "@zhushanwen/extension-protocol";

import registerExtension from "../index.ts";

const LEDGER_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.notifyLedger");

interface EmittedEvent {
	event: string;
	data: Record<string, unknown>;
}

interface WatchInvocation {
	notifyId: string;
	opts: { timeout?: number } | undefined;
	resolve: (value: unknown) => void;
}

interface Harness {
	registered: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
	emitted: EmittedEvent[];
	handlers: Record<string, (event: unknown, ctx: unknown) => unknown>;
	selectMock: ReturnType<typeof vi.fn>;
	ctx: Record<string, unknown>;
	entries: unknown[];
	/** 非 watch action 的回包（JSON 字符串），用例在跑工具前置位 */
	actionResults: Record<string, () => string>;
	/** 按开表顺序排列的 watch 调用（deferred 应答入口） */
	watches: WatchInvocation[];
	/** 按调用序 resolve 第 n 次 watch（value = select 回包原样值） */
	respondWatch(index: number, value: unknown): void;
}

function createHarness(entries: unknown[] = []): Harness {
	const registered: Harness["registered"] = [];
	const emitted: EmittedEvent[] = [];
	const handlers: Harness["handlers"] = {};
	const watches: WatchInvocation[] = [];
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
	const pi = {
		registerTool: (tool: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) =>
			registered.push(tool),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers[event] = handler;
		},
		events: {
			emit: (event: string, data: Record<string, unknown>) => {
				emitted.push({ event, data });
			},
		},
		getAllTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
	};
	const ctx = {
		mode: "rpc" as const,
		hasUI: true,
		ui: { select: selectMock },
		sessionManager: { getEntries: () => entries, getSessionId: () => "parent-1" },
	};
	registerExtension(pi as never);
	return {
		registered,
		emitted,
		handlers,
		selectMock,
		ctx,
		entries,
		actionResults,
		watches,
		respondWatch: (index, value) => {
			const inv = watches[index];
			if (!inv) throw new Error(`no watch invocation at index ${index}`);
			inv.resolve(value);
		},
	};
}

function tool(h: Harness, name: string) {
	const t = h.registered.find((x) => x.name === name);
	if (!t) throw new Error(`tool not registered: ${name}`);
	return t;
}

async function runTool(h: Harness, name: string, params: Record<string, unknown>) {
	return tool(h, name).execute("call-1", params, undefined, undefined, h.ctx);
}

/** 纯微任务排干（不推进假时钟——攒批窗计时不受污染） */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
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

/** 植入 ledger 槽（notify-ledger 镜像的读取目标）——record spy 由用例自持 */
function plantLedger(
	record: (id: string, content: string, details: object, options?: unknown) => boolean,
	compactionCheck: () => number = () => 0,
): void {
	Reflect.set(globalThis, LEDGER_SLOT_KEY, { current: { record, compactionCheck } });
}

function recordSpy(): ReturnType<typeof vi.fn> {
	const spy = vi.fn(() => true);
	plantLedger(spy as never);
	return spy;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	Reflect.deleteProperty(globalThis, LEDGER_SLOT_KEY);
});

// ── arm：send/create 成功 → register + 开表 + willNotify 透传 ──────────────────

describe("arm（send/create → pending:register + watch 开表）", () => {
	it("send willNotify:true → register 三键 {id=notifyId, type:'session', name} + 开表（watch 不传 timeout）", async () => {
		const h = createHarness();
		h.actionResults.send = () => SEND_OK;
		await runTool(h, "send_to_session", { sessionId: "child-1", prompt: "go" });
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
		const result = (await runTool(h, "send_to_session", {
			sessionId: "child-1",
			prompt: "go",
		})) as { isError?: boolean; content: Array<{ text: string }> };
		expect(result.isError).toBeUndefined();
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
		await runTool(h, "create_managed_session", {
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
		await runTool(h, "send_to_session", { sessionId: "child-9", prompt: "again" });
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
		await runTool(h, "create_managed_session", { cwd: "/w", label: "L" });
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
		await runTool(h, "send_to_session", { sessionId: "child-1", prompt: "x" });
		await flushMicrotasks();
		expect(registersOf(h)).toHaveLength(0);
		expect(h.watches).toHaveLength(0);
	});

	it("list 结果回填 label 缓存（进程重启后 send name 的兜底源）", async () => {
		const h = createHarness();
		h.actionResults.list = () =>
			JSON.stringify({ sessions: [{ id: "c1", label: "restored-label" }], undeliveredResults: 0 });
		h.actionResults.send = () => SEND_OK;
		await runTool(h, "list_my_sessions", {});
		await runTool(h, "send_to_session", { sessionId: "c1", prompt: "x" });
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
		await runTool(h, "send_to_session", { sessionId: "child-1", prompt: "a" });
		await runTool(h, "send_to_session", { sessionId: "child-1", prompt: "b" });
		await flushMicrotasks();
		const ids = emittedIds(h, "pending:register");
		expect(ids).toHaveLength(2);
		expect(h.watches).toHaveLength(2);
		return { id1: ids[0], id2: ids[1] };
	}

	it("同 settleSeq 两笔 → 恰一条 record（fulfills 2）+ 逐笔 unregister；trailing 50ms 前不 flush（A6 合批）", async () => {
		const record = recordSpy();
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

		// trailing debounce：应答到达但 50ms 窗未到 → 零 record 零 unregister
		expect(record).not.toHaveBeenCalled();
		expect(emittedIds(h, "pending:unregister")).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(50);
		expect(record).toHaveBeenCalledTimes(1);
		const [notifyId, content, details, options] = record.mock.calls[0] as [
			string,
			string,
			Record<string, unknown>,
			{ deliveryCustomType: string },
		];
		expect(notifyId).toBe(id1); // 批幂等键 = 批内首个响应 notifyId
		expect(content).toBe(
			'Managed session "child-1" (child-1) finished with status "completed". (fulfills 2 requests)',
		);
		expect(details).toEqual({
			notifyId: id1,
			sessionId: "child-1",
			reason: "completed",
			fulfills: 2,
			label: "child-1",
		});
		expect(options.deliveryCustomType).toBe("managed-session-notify");
		expect(emittedIds(h, "pending:unregister").sort()).toEqual([id1, id2].sort());
		expect(
			h.emitted.filter((e) => e.event === "pending:unregister").map((e) => e.data.reason),
		).toEqual(["completed", "completed"]);
	});

	it("不同 settleSeq → 两条 record（A7：每轮一次，seq 边界排除跨轮合流）", async () => {
		const record = recordSpy();
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
		expect(record).toHaveBeenCalledTimes(2);
		expect(record.mock.calls.map((c) => c[0]).sort()).toEqual([id1, id2].sort());
		expect(emittedIds(h, "pending:unregister")).toHaveLength(2);
	});

	it("reason 分类：failed / stopped 应答 → 文案 status 对应（渲染侧 outcome 再映射）", async () => {
		const record = recordSpy();
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
		expect(record).toHaveBeenCalledTimes(2);
		const byId = new Map(record.mock.calls.map((c) => [c[0], c[1] as string]));
		expect(byId.get(id1)).toContain('status "failed"');
		expect(byId.get(id2)).toContain('status "stopped"');
	});

	it("跨 session 不合批（分拣键 sessionId 腿）：同 settleSeq 不同 session → 两条 record", async () => {
		const record = recordSpy();
		const h = createHarness();
		h.actionResults.send = () => SEND_OK;
		await runTool(h, "send_to_session", { sessionId: "child-a", prompt: "x" });
		await runTool(h, "send_to_session", { sessionId: "child-b", prompt: "y" });
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
		expect(record).toHaveBeenCalledTimes(2);
		const sessions = record.mock.calls.map((c) => (c[2] as { sessionId: string }).sessionId);
		expect(sessions.sort()).toEqual(["child-a", "child-b"]);
	});

	it("record 返回 false（幂等拒收/槽空降级）不改 unregister 语义", async () => {
		plantLedger(() => false);
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
	it("例外1：cancelled / orphaned → 逐笔即时 unregister（50ms 窗前即到），零 record", async () => {
		const record = recordSpy();
		const h = createHarness();
		const { id1, id2 } = await armTwo();
		h.respondWatch(0, JSON.stringify({ reason: "cancelled", sessionId: "child-1" }));
		h.respondWatch(1, JSON.stringify({ reason: "orphaned", sessionId: "child-1" }));
		await flushMicrotasks();

		// 逐笔即时（不被攒批窗延迟）
		expect(emittedIds(h, "pending:unregister").sort()).toEqual([id1, id2].sort());
		expect(record).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(50);
		expect(record).not.toHaveBeenCalled();

		async function armTwo() {
			h.actionResults.send = () => SEND_OK;
			await runTool(h, "send_to_session", { sessionId: "child-1", prompt: "a" });
			await runTool(h, "send_to_session", { sessionId: "child-1", prompt: "b" });
			await flushMicrotasks();
			return { id1: emittedIds(h, "pending:register")[0], id2: emittedIds(h, "pending:register")[1] };
		}
	});

	it("例外2：同 (sessionId, deathSeq) 首条死亡新闻 record + fulfills N，同键后续仅 unregister；新 deathSeq 自然发声", async () => {
		const record = recordSpy();
		const h = createHarness();
		const lifetime = "sm-11111111-2222-3333-4444-555555555555";
		h.actionResults.create = () =>
			JSON.stringify({
				sessionId: "child-d",
				status: "created",
				willNotify: true,
				lifetimeNotifyId: lifetime,
			});
		await runTool(h, "create_managed_session", { cwd: "/w", label: "doomed", prompt: "go" });
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

		expect(record).toHaveBeenCalledTimes(1);
		const [id, content, details] = record.mock.calls[0] as [string, string, Record<string, unknown>];
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
		await runTool(h, "send_to_session", { sessionId: "child-d", prompt: "x" });
		await flushMicrotasks();
		expect(h.watches).toHaveLength(3);
		h.respondWatch(
			2,
			JSON.stringify({ reason: "exited", sessionId: "child-d", deathSeq: 4, fulfillsN: 0, exitCode: 2 }),
		);
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(50);
		expect(record).toHaveBeenCalledTimes(2);
		expect(record.mock.calls[1][0]).toBe(emittedIds(h, "pending:register")[2]);
		expect(String(record.mock.calls[1][1])).toContain("(exit code: 2).");
		expect(String(record.mock.calls[1][1])).not.toContain("fulfills");
		expect(String(record.mock.calls[1][1])).not.toContain("Full transcript");
	});

	it("例外2 跨 reason 组同槽：claim 'exited' 与 lifetime 'deleted' 同 deathSeq → 仅首条发声（分拣组保序）", async () => {
		const record = recordSpy();
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

		expect(record).toHaveBeenCalledTimes(1);
		expect(record.mock.calls[0][0]).toBe(claimId); // 先到先占槽（claim 组先入队）
		expect(String(record.mock.calls[0][1])).toContain('status "exited"');
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
		const record = recordSpy();
		const h = createHarness();
		h.actionResults.send = () => SEND_OK;
		await runTool(h, "send_to_session", { sessionId: "child-1", prompt: "x" });
		await flushMicrotasks();
		h.respondWatch(0, "null");
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(50);
		expect(record).not.toHaveBeenCalled();
		expect(emittedIds(h, "pending:unregister")).toHaveLength(1);
	});

	it("畸形/词表外 payload → 折叠 cancelled 静默收口（不落 default 误标、不产通知）", async () => {
		const record = recordSpy();
		const h = createHarness();
		h.actionResults.send = () => SEND_OK;
		await runTool(h, "send_to_session", { sessionId: "child-1", prompt: "x" });
		await flushMicrotasks();
		h.respondWatch(0, JSON.stringify({ reason: "some-future-reason" }));
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(50);
		expect(record).not.toHaveBeenCalled();
		expect(emittedIds(h, "pending:unregister")).toHaveLength(1);
	});

	it("select 侧 cancelled（应答未达，resolve undefined）→ 不动 pending（残留交下次 session_start 收口腿）", async () => {
		const record = recordSpy();
		const h = createHarness();
		h.actionResults.send = () => SEND_OK;
		await runTool(h, "send_to_session", { sessionId: "child-1", prompt: "x" });
		await flushMicrotasks();
		h.respondWatch(0, undefined);
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(50);
		expect(emittedIds(h, "pending:unregister")).toHaveLength(0);
		expect(record).not.toHaveBeenCalled();
	});

	it("session_compact → compactionCheck 接线（D3 装配纪律④）", () => {
		const compactionCheck = vi.fn(() => 0);
		plantLedger(vi.fn(() => true) as never, compactionCheck);
		const h = createHarness();
		expect(h.handlers.session_compact).toBeTypeOf("function");
		h.handlers.session_compact({ type: "session_compact" }, h.ctx);
		expect(compactionCheck).toHaveBeenCalledTimes(1);
	});
});
