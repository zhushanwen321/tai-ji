import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callLLM, extractText, joinTextBlocks } from "../call.ts";

// mock completeSimple —— call.ts 顶层静态 import 会拿到此 mock（探针①已验证静态 import 机制可行，
// 此处验证 callLLM 逻辑：凭证 narrow / options 构造 / 文本提取 / 错误归一化）。
vi.mock("@earendil-works/pi-ai/compat", () => ({
	completeSimple: vi.fn(),
}));

const mockComplete = vi.mocked(completeSimple);

function makeModel(): Model<Api> {
	return { id: "m", provider: "p", name: "m", api: "anthropic" as Api, baseUrl: "", reasoning: false } as unknown as Model<Api>;
}

function makeCtx(authResult: unknown): ExtensionContext {
	return {
		modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => authResult) },
	} as unknown as ExtensionContext;
}

beforeEach(() => {
	mockComplete.mockReset();
});

describe("callLLM", () => {
	it("TC11 成功：提取 text（trim）+ tools 传 []", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "  hello  " }] });

		const result = await callLLM(ctx, {
			model: makeModel(),
			systemPrompt: "s",
			messages: [],
			sessionId: "sess-1",
		});

		expect(result).toEqual({ ok: true, content: "hello" });
		// 验证 completeSimple 被调用，第二参数 context 含 tools:[]，第三参数 options 含 apiKey + sessionId 透传
		expect(mockComplete).toHaveBeenCalledTimes(1);
		const [, contextArg, optionsArg] = mockComplete.mock.calls[0];
		expect(contextArg).toMatchObject({ systemPrompt: "s", messages: [], tools: [] });
		expect(optionsArg).toMatchObject({ apiKey: "k", sessionId: "sess-1" });
	});

	it("TC12 auth-fail → {ok:false, error}，不调 completeSimple（narrow 不取 apiKey）", async () => {
		const ctx = makeCtx({ ok: false, error: "no key" });

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result).toEqual({ ok: false, error: "no key" });
		expect(mockComplete).not.toHaveBeenCalled();
	});

	it("TC13 completeSimple throw → {ok:false, error 含错误信息}", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockRejectedValue(new Error("network timeout"));

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ error: expect.stringContaining("network") });
	});

	it("TC1 stopReason=error → {ok:false, error, stopReason:'error'}（不再 ok:true 返回错误文本）", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		// completeSimple 对错误也 resolve（带 stopReason），content 是错误文本
		mockComplete.mockResolvedValue({ stopReason: "error", content: [{ type: "text", text: "API error: 429 rate limited" }] });

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result).toEqual({ ok: false, error: "API error: 429 rate limited", stopReason: "error" });
	});

	it("TC2 stopReason=aborted → {ok:false, error, stopReason:'aborted'}", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ stopReason: "aborted", content: [{ type: "text", text: "user aborted" }] });

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result).toEqual({ ok: false, error: "user aborted", stopReason: "aborted" });
	});

	it("TC3 stopReason=stop（正常）→ 不受 stopReason 检查影响，ok:true 提取文本", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "  hello  " }] });

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result).toEqual({ ok: true, content: "hello" });
	});

	it("usage 透传：resp.usage 存在 → ok:true 结果透出该对象（additive，设计 §3.3 ②）", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		// 形态对齐 pi-ai 0.84.4 Usage（含 cost），贴近真实 provider 响应（P-usage-shape）
		const usage = {
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 18,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
		};
		mockComplete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "hello" }], usage });

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result.ok).toBe(true);
		if (result.ok) {
			// 透传语义：同一引用，非拷贝/重组
			expect(result.usage).toBe(usage);
			expect(result.content).toBe("hello");
		}
	});

	it("usage 缺失：resp.usage 不存在 → ok:true 结果无 usage 字段（跳过落账语义由调用方处理）", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "hello" }] });

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result.ok).toBe(true);
		expect(result).not.toHaveProperty("usage");
	});

	it("stopReason=error 且 content 无 text → error 回落 'unknown error'", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ stopReason: "error", content: [] });

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result).toEqual({ ok: false, error: "unknown error", stopReason: "error" });
	});

	it("TC13 catch 路径不设 stopReason（错误原因不可知）", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockRejectedValue(new Error("boom"));

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.stopReason).toBeUndefined();
		}
	});

	it("review TF1: sessionId 透传到 options 第三参数", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "x" }] });

		await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [], sessionId: "abc-123" });

		const optionsArg = mockComplete.mock.calls[0][2];
		expect(optionsArg).toMatchObject({ sessionId: "abc-123" });
	});

	it("review TF1: 无 sessionId 时 options 不含 sessionId 字段（条件 spread 不传）", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "x" }] });

		await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		const optionsArg = mockComplete.mock.calls[0][2] as Record<string, unknown>;
		expect("sessionId" in optionsArg).toBe(false);
	});

	it("reasoning 透传：传 reasoning=high → options 含 reasoning:high", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "x" }] });

		await callLLM(ctx, {
			model: makeModel(),
			systemPrompt: "s",
			messages: [],
			reasoning: "high",
		});

		const optionsArg = mockComplete.mock.calls[0][2];
		expect(optionsArg).toMatchObject({ reasoning: "high" });
	});

	it("reasoning 不传 → options 不含 reasoning 字段（条件 spread，provider 默认）", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "x" }] });

		await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		const optionsArg = mockComplete.mock.calls[0][2] as Record<string, unknown>;
		expect("reasoning" in optionsArg).toBe(false);
	});

	it("reasoning=off → options 不含 reasoning 字段（off 由本库映射为不传）", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "x" }] });

		await callLLM(ctx, {
			model: makeModel(),
			systemPrompt: "s",
			messages: [],
			reasoning: "off",
		});

		const optionsArg = mockComplete.mock.calls[0][2] as Record<string, unknown>;
		expect("reasoning" in optionsArg).toBe(false);
	});


	it("B5: getApiKeyAndHeaders reject（抛异常）→ {ok:false, error}（归一入 catch，不向上抛）", async () => {
		const getApiKeyAndHeaders = vi.fn().mockRejectedValueOnce(new Error("registry exploded"));
		const ctx = { modelRegistry: { getApiKeyAndHeaders } } as unknown as ExtensionContext;

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result).toEqual({ ok: false, error: "registry exploded" });
		// 凭证阶段就 reject，completeSimple 未被调用
		expect(mockComplete).not.toHaveBeenCalled();
	});

	it("review C2: signal 透传到 options 第三参数", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "x" }] });
		const ac = new AbortController();

		await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [], signal: ac.signal });

		const optionsArg = mockComplete.mock.calls[0][2];
		expect(optionsArg).toMatchObject({ signal: ac.signal });
	});

	it("review C2: maxTokens 透传到 options 第三参数", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "x" }] });

		await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [], maxTokens: 1024 });

		const optionsArg = mockComplete.mock.calls[0][2];
		expect(optionsArg).toMatchObject({ maxTokens: 1024 });
	});

	it("review C2: timeoutMs 透传到 options 第三参数", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "x" }] });

		await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [], timeoutMs: 5000 });

		const optionsArg = mockComplete.mock.calls[0][2];
		expect(optionsArg).toMatchObject({ timeoutMs: 5000 });
	});

	it("review C2: 不传 signal/maxTokens/timeoutMs 时 options 不含这些字段（条件 spread）", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "x" }] });

		await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		const optionsArg = mockComplete.mock.calls[0][2] as Record<string, unknown>;
		expect("signal" in optionsArg).toBe(false);
		expect("maxTokens" in optionsArg).toBe(false);
		expect("timeoutMs" in optionsArg).toBe(false);
	});
});

describe("extractText", () => {
	it("TC11 单个 text block 提取 + trim", () => {
		expect(extractText({ content: [{ type: "text", text: "  hello  " }] })).toBe("hello");
	});

	it("review: 多个 text block 拼接 + trim", () => {
		expect(extractText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a b");
	});

	it("review: 无 text block（纯 ThinkingContent / ToolCall）→ ''", () => {
		expect(extractText({ content: [{ type: "thinking", text: "..." }, { type: "tool_call" }] })).toBe("");
	});

	it("review: 空 content → ''", () => {
		expect(extractText({ content: [] })).toBe("");
	});
});

describe("joinTextBlocks（unknown 安全内核，D7）", () => {
	it("text block 过滤拼接：只取 type==='text'，join(' ')，不 trim", () => {
		expect(
			joinTextBlocks([
				{ type: "text", text: "  a" },
				{ type: "thinking", text: "ignored" },
				{ type: "text", text: "b  " },
			]),
		).toBe("  a b  ");
	});

	it("非 text block（thinking / tool_call）忽略", () => {
		expect(joinTextBlocks([{ type: "thinking", text: "x" }, { type: "tool_call" }])).toBe("");
	});

	it("text 字段缺失的 text block 按 '' 拼接", () => {
		expect(joinTextBlocks([{ type: "text" }, { type: "text", text: "x" }])).toBe(" x");
	});

	it("空数组 → ''", () => {
		expect(joinTextBlocks([])).toBe("");
	});

	it.each([
		["undefined", undefined],
		["null", null],
		["字符串", "hello"],
		["数字", 42],
		["单个 block 对象（非数组）", { type: "text", text: "x" }],
	])("非数组输入 %s → 安全返回 ''（不 throw）", (_label, raw) => {
		expect(joinTextBlocks(raw)).toBe("");
	});

	it("数组内非法元素（null / 非 block 对象）被过滤，不 throw", () => {
		expect(joinTextBlocks([null, 42, { type: "text", text: "kept" }])).toBe("kept");
	});
});
