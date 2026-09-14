// forwarding.test.ts — execute 转发 / cancelled 折叠 / observe void 不阻塞 / intercept 注入映射

import { describe, it, expect, vi } from "vitest";
import { BRIDGE_MARKER } from "@xyz-agent/extension-protocol";
import registerExtension from "../index.ts";

interface CapturedTool {
	name: string;
	parameters: unknown;
	execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
}

/**
 * 按 request.method 路由的 select mock：各 method 独立响应队列，队列空回 fallback。
 * session_start 触发时会同时发 bridge:sync 与 bridge:event，按调用顺序排队的 mock 会串台。
 */
function methodRouter(responses: Partial<Record<string, unknown[]>>, fallback: unknown = undefined) {
	const queues = new Map<string, unknown[]>(Object.entries(responses).map(([k, v]) => [k, [...(v ?? [])]]));
	return vi.fn((_title: string, options: [string]) => {
		const request = JSON.parse(options[0]) as { method: string };
		const queue = queues.get(request.method);
		if (queue && queue.length > 0) return Promise.resolve(queue.shift());
		return Promise.resolve(fallback);
	});
}

function createHarness(selectImpl: (...args: unknown[]) => unknown) {
	const registered: CapturedTool[] = [];
	const handlers = new Map<string, Array<(data: unknown, ctx: unknown) => unknown>>();
	const selectMock = vi.fn(selectImpl);
	const pi = {
		registerTool: (tool: CapturedTool) => registered.push(tool),
		on: (evt: string, handler: (data: unknown, ctx: unknown) => unknown) => {
			handlers.set(evt, [...(handlers.get(evt) ?? []), handler]);
		},
	};
	const ctx = {
		mode: "rpc" as const,
		hasUI: true,
		ui: { select: selectMock },
		sessionManager: { getSessionId: () => "sess-1" },
	};
	registerExtension(pi as never);
	return { registered, handlers, selectMock, ctx };
}

const SYNC_PAYLOAD = JSON.stringify({
	tools: [{ name: "sleep-tool", description: "Sleep", parameters: { type: "object" } }],
	success: true,
});

/** 完成一次成功 sync 并返回注册到的工具 */
async function syncedTool(harness: ReturnType<typeof createHarness>): Promise<CapturedTool> {
	harness.handlers.get("session_start")![0]({ type: "session_start", reason: "startup" }, harness.ctx);
	await vi.waitFor(() => expect(harness.registered).toHaveLength(1));
	return harness.registered[0];
}

/** 找第 n 笔（0 基）指定 method 的 select 调用；无该笔返回 undefined */
function bridgeCall(selectMock: ReturnType<typeof vi.fn>, method: string, nth = 0) {
	const calls = selectMock.mock.calls
		.map((call) => call as unknown as [string, [string], { signal?: AbortSignal; timeout?: number }])
		.filter(([, options]) => {
			try {
				return JSON.parse(options[0]).method === method;
			} catch {
				return false;
			}
		});
	const hit = calls[nth];
	if (!hit) return undefined;
	const [title, options, opts] = hit;
	return { title, options, opts, request: JSON.parse(options[0]) };
}

describe("execute 转发（bridge:tool_execute）", () => {
	it("构造 BridgeRequest 全字段 + signal 透传，回包映射 AgentToolResult", async () => {
		const full = createHarness(methodRouter({
			"bridge:sync": [SYNC_PAYLOAD],
			"bridge:tool_execute": [JSON.stringify({ content: "slept 90s", isError: false })],
		}));
		const tool = await syncedTool(full);
		const signal = new AbortController().signal;

		const result = (await tool.execute("call-1", { ms: 90 }, signal, undefined, full.ctx)) as {
			content: Array<{ type: string; text: string }>;
			details: { kind: string };
			isError?: boolean;
		};

		const call = bridgeCall(full.selectMock, "bridge:tool_execute");
		expect(call.title).toBe(BRIDGE_MARKER);
		expect(call.request).toEqual({
			method: "bridge:tool_execute",
			toolName: "sleep-tool",
			toolCallId: "call-1",
			params: { ms: 90 },
			sessionId: "sess-1",
		});
		expect(call.opts?.signal).toBe(signal);
		// 工具 execute 的 select 不带 timeout（设计 §3.3-D5：超时权威在 runtime D1 取值链，
		// timeout 是启动 sync 专属例外，防误传扩散）
		expect(call.opts?.timeout).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "slept 90s" }]);
		// ok 变体无 result 全量回填（D5 去重：content[0].text 已完整携带同一信息）
		expect(result.details).toEqual({ kind: "ok" });
		expect(result.isError).toBeUndefined();
	});

	it("非对象 params 折叠为 {}（LLM 工具调用异常形态防御）", async () => {
		const full = createHarness(methodRouter({
			"bridge:sync": [SYNC_PAYLOAD],
			"bridge:tool_execute": [JSON.stringify({ content: "ok" })],
		}));
		const tool = await syncedTool(full);
		await tool.execute("call-2", "not-an-object", undefined, undefined, full.ctx);
		expect(bridgeCall(full.selectMock, "bridge:tool_execute").request.params).toEqual({});
	});

	it("select 返回 undefined（用户取消/abort 三态合一）→ isError cancelled 折叠", async () => {
		const full = createHarness(methodRouter({ "bridge:sync": [SYNC_PAYLOAD] }));
		const tool = await syncedTool(full);
		const result = (await tool.execute("call-3", {}, undefined, undefined, full.ctx)) as {
			content: Array<{ text: string }>; isError?: boolean; details: { kind: string };
		};
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("cancelled");
		expect(result.details.kind).toBe("cancelled");
	});

	it("select 抛异常 → isError（不向 pi 传播 throw）+ 留痕", async () => {
		const full = createHarness(vi.fn((_title: string, options: [string]) => {
			const request = JSON.parse(options[0]) as { method: string };
			if (request.method === "bridge:sync") return Promise.resolve(SYNC_PAYLOAD);
			return Promise.reject(new Error("channel closed"));
		}));
		const tool = await syncedTool(full);
		const result = (await tool.execute("call-4", {}, undefined, undefined, full.ctx)) as {
			content: Array<{ text: string }>; isError?: boolean; details: { kind: string };
		};
		expect(result.isError).toBe(true);
		expect(result.details.kind).toBe("cancelled");
	});

	it("runtime 错误闭环 {error, hint} → isError 含 error + hint（禁止错误成功模式）", async () => {
		const full = createHarness(methodRouter({
			"bridge:sync": [SYNC_PAYLOAD],
			"bridge:tool_execute": [JSON.stringify({ error: "Plugin tool 'sleep-tool' timed out after 10s", hint: "pass timeoutMs in registerTool()" })],
		}));
		const tool = await syncedTool(full);
		const result = (await tool.execute("call-5", {}, undefined, undefined, full.ctx)) as {
			content: Array<{ text: string }>; isError?: boolean; details: { kind: string; error: { hint?: string } };
		};
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("timed out after 10s");
		expect(result.content[0].text).toContain("hint");
		expect(result.details.error.hint).toBe("pass timeoutMs in registerTool()");
	});

	it("isError: true 的工具回包原样映射（不吞插件错误）", async () => {
		const full = createHarness(methodRouter({
			"bridge:sync": [SYNC_PAYLOAD],
			"bridge:tool_execute": [JSON.stringify({ content: "Plugin worker crashed", isError: true })],
		}));
		const tool = await syncedTool(full);
		const result = (await tool.execute("call-6", {}, undefined, undefined, full.ctx)) as {
			content: Array<{ text: string }>; isError?: boolean;
		};
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Plugin worker crashed");
	});

	it("回包形状不符（非 error 非 tool_execute 形状）→ isError + 版本不匹配指引", async () => {
		const full = createHarness(methodRouter({
			"bridge:sync": [SYNC_PAYLOAD],
			"bridge:tool_execute": [JSON.stringify({ something: "else" })],
		}));
		const tool = await syncedTool(full);
		const result = (await tool.execute("call-7", {}, undefined, undefined, full.ctx)) as {
			content: Array<{ text: string }>; isError?: boolean; details: { kind: string };
		};
		expect(result.isError).toBe(true);
		expect(result.details.kind).toBe("unexpected");
		expect(result.content[0].text).toContain("version-mismatched");
	});

	it("Tool not found → 触发一次重同步（bridge:sync 再发一次）后返回 isError", async () => {
		const full = createHarness(methodRouter({
			// 启动 sync + miss 重同步各一笔
			"bridge:sync": [SYNC_PAYLOAD, SYNC_PAYLOAD],
			"bridge:tool_execute": [JSON.stringify({ content: "Tool not found: sleep-tool", isError: true })],
		}));
		const tool = await syncedTool(full);
		const result = (await tool.execute("call-8", {}, undefined, undefined, full.ctx)) as {
			content: Array<{ text: string }>; isError?: boolean;
		};

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Tool not found");
		// 第 2 笔 bridge:sync = miss 重同步（第 1 笔是启动 sync），且只有两笔
		expect(bridgeCall(full.selectMock, "bridge:sync", 1)?.request).toEqual({ method: "bridge:sync" });
		expect(bridgeCall(full.selectMock, "bridge:sync", 2)).toBeUndefined();
	});

	it("普通 isError 工具错误不触发重同步（仅清单 miss 触发）", async () => {
		const full = createHarness(methodRouter({
			"bridge:sync": [SYNC_PAYLOAD],
			"bridge:tool_execute": [JSON.stringify({ content: "Plugin worker crashed", isError: true })],
		}));
		const tool = await syncedTool(full);
		await tool.execute("call-10", {}, undefined, undefined, full.ctx);
		expect(bridgeCall(full.selectMock, "bridge:sync", 1)).toBeUndefined();
	});
});

describe("observe 事件转发（bridge:event，fire-and-forget 硬约束）", () => {
	it("handler 同步返回（不 await select 回包）——select 永不 resolve 也不阻塞", () => {
		const full = createHarness(() => new Promise<string>(() => {}));
		const handler = full.handlers.get("agent_start")![0];
		const ret = handler({ type: "agent_start" }, full.ctx);
		expect(ret).toBeUndefined();
	});

	it("载荷形状：method/eventName/data/sessionId", async () => {
		const full = createHarness(vi.fn().mockResolvedValue(undefined));
		const event = { type: "turn_end", turnIndex: 3 };
		full.handlers.get("turn_end")![0](event, full.ctx);
		// void 发起也要让 microtask 跑完才能看到 select 被调
		await Promise.resolve();
		const call = bridgeCall(full.selectMock, "bridge:event");
		expect(call.title).toBe(BRIDGE_MARKER);
		expect(call.request).toEqual({
			method: "bridge:event",
			eventName: "turn_end",
			data: event,
			sessionId: "sess-1",
		});
	});

	it("回包（恒 cancelled）被丢弃，无异常", async () => {
		const full = createHarness(vi.fn().mockResolvedValue(undefined));
		full.handlers.get("message_end")![0]({ type: "message_end" }, full.ctx);
		await new Promise((r) => setTimeout(r, 0));
		expect(full.selectMock).toHaveBeenCalledTimes(1);
	});
});

describe("intercept（bridge:intercept，唯一允许 await 的转发）", () => {
	it("injectedMessages 收窄映射：单条 plugin-inject CustomMessage，content 数组保多条", async () => {
		const full = createHarness(methodRouter({
			"bridge:intercept": [JSON.stringify({
				injectedMessages: [
					{ role: "user", content: "first instruction" },
					{ role: "user", content: { nested: true } },
				],
			})],
		}));
		const handler = full.handlers.get("before_agent_start")![0] as (data: unknown, ctx: unknown) => Promise<unknown>;
		const result = (await handler({ type: "before_agent_start", prompt: "hi" }, full.ctx)) as {
			message: { customType: string; content: Array<{ type: string; text: string }>; display: boolean; details: { count: number } };
		};

		expect(result.message.customType).toBe("plugin-inject");
		// string content → text 段；未知对象 fallback JSON.stringify 为 text 段
		expect(result.message.content).toEqual([
			{ type: "text", text: "first instruction" },
			{ type: "text", text: '{"nested":true}' },
		]);
		expect(result.message.display).toBe(false);
		expect(result.message.details.count).toBe(2);

		const call = bridgeCall(full.selectMock, "bridge:intercept");
		expect(call.request).toEqual({
			method: "bridge:intercept",
			eventName: "before_agent_start",
			data: { type: "before_agent_start", prompt: "hi" },
			sessionId: "sess-1",
		});
	});

	it("string 注入直用为 text 段（D1 string-only：管线层恒产出 string，零转换）", async () => {
		const full = createHarness(methodRouter({
			"bridge:intercept": [JSON.stringify({
				injectedMessages: [
					{ role: "user", content: "TOKEN_INJECT:1" },
					{ role: "assistant", content: "second instruction" },
				],
			})],
		}));
		const handler = full.handlers.get("before_agent_start")![0] as (data: unknown, ctx: unknown) => Promise<unknown>;
		const result = (await handler({ type: "before_agent_start", prompt: "hi" }, full.ctx)) as {
			message: { content: Array<{ type: string; text: string }>; details: { count: number } };
		};

		expect(result.message.content).toEqual([
			{ type: "text", text: "TOKEN_INJECT:1" },
			{ type: "text", text: "second instruction" },
		]);
		expect(result.message.details.count).toBe(2);
	});

	it("N2 失配序列化：非 string content JSON.stringify 进 text 段保信息（无结构化透传）", async () => {
		const full = createHarness(methodRouter({
			"bridge:intercept": [JSON.stringify({
				injectedMessages: [
					{ role: "user", content: { type: "text", text: "native text", textSignature: "sig-1" } },
					{ role: "user", content: { type: "image", data: "aW1hZ2U=", mimeType: "image/png" } },
				],
			})],
		}));
		const handler = full.handlers.get("before_agent_start")![0] as (data: unknown, ctx: unknown) => Promise<unknown>;
		const result = (await handler({ type: "before_agent_start", prompt: "hi" }, full.ctx)) as {
			message: { content: Array<{ type: string; text: string }>; details: { count: number } };
		};

		// 失配形态生产不可达（管线层非 string 丢弃 + warn），序列化保信息而非透传——
		// 若透传分支被恢复，本断言即红
		expect(result.message.content).toEqual([
			{ type: "text", text: '{"type":"text","text":"native text","textSignature":"sig-1"}' },
			{ type: "text", text: '{"type":"image","data":"aW1hZ2U=","mimeType":"image/png"}' },
		]);
		expect(result.message.details.count).toBe(2);
	});

	it("无 injectedMessages → 不注入（undefined）", async () => {
		const full = createHarness(methodRouter({
			"bridge:intercept": [JSON.stringify({ injectedMessages: [] })],
		}));
		const handler = full.handlers.get("before_agent_start")![0] as (data: unknown, ctx: unknown) => Promise<unknown>;
		expect(await handler({ type: "before_agent_start", prompt: "hi" }, full.ctx)).toBeUndefined();
	});

	it("通道失败（cancelled）→ 不注入不拦截，返回 undefined", async () => {
		const full = createHarness(methodRouter({}));
		const handler = full.handlers.get("before_agent_start")![0] as (data: unknown, ctx: unknown) => Promise<unknown>;
		expect(await handler({ type: "before_agent_start", prompt: "hi" }, full.ctx)).toBeUndefined();
	});

	it("畸形注入条目被过滤（仅 content 字段存在者）", async () => {
		const full = createHarness(methodRouter({
			"bridge:intercept": [JSON.stringify({
				injectedMessages: [{ content: "keep me" }, "not-an-object", null],
			})],
		}));
		const handler = full.handlers.get("before_agent_start")![0] as (data: unknown, ctx: unknown) => Promise<unknown>;
		const result = (await handler({ type: "before_agent_start", prompt: "hi" }, full.ctx)) as {
			message: { content: Array<{ text: string }>; details: { count: number } };
		};
		expect(result.message.content).toEqual([{ type: "text", text: "keep me" }]);
		expect(result.message.details.count).toBe(1);
	});
});
