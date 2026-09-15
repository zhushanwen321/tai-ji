import { beforeEach, describe, expect, it, vi } from "vitest";

// mock pi SDK：接管路径的单测不触网（same-mode 输入链 + cross-mode 原生组装都替换）。
// importOriginal 保留真实模块（含 pure.js 依赖的 estimateTokens），其余覆盖项在后
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	buildSessionContext: (entries: unknown[]) => ({ messages: [{ role: "user", content: "history" }] }),
	convertToLlm: (messages: unknown[]) => messages,
	compact: vi.fn(),
}));
vi.mock("../llm.js", () => ({
	callSameModelCompaction: vi.fn(),
	projectTools: (tools: unknown[]) => tools.map((t) => ({ name: (t as { name: string }).name })),
}));

import { compact as nativeCompact } from "@earendil-works/pi-coding-agent";
import { callSameModelCompaction } from "../llm.js";
import {
	createBeforeCompactHandler,
	createTakeoverState,
} from "../compact-handler.js";
import { normalizeSmartContextConfig, type SmartContextConfig } from "../pure.js";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

// assistant 消息形态锁定为单 text 块（设计 §8.3）：必填标量字段补齐 + content 不得追加
// thinking/toolCall 块——追加会抬高 shadowedTokens，使「新旧口径数值等价」声明静默失效
function makeEvent(overrides?: Partial<SessionBeforeCompactEvent["preparation"]>): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "kept-1",
			messagesToSummarize: [
				{ role: "user", content: "x".repeat(4_000), timestamp: 0 },
				{
					role: "assistant",
					content: [{ type: "text", text: "y".repeat(4_000) }],
					api: "openai-completions",
					provider: "zai",
					model: "glm",
					usage: {
						input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				},
			],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 500_000,
			fileOps: { read: new Set(["/a.ts"]), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
			...overrides,
		},
		branchEntries: [],
		customInstructions: undefined,
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
	};
}

function makeCtx(crossModel?: { provider: string; id: string } | null): ExtensionContext {
	return {
		model: { provider: "zai", id: "glm" },
		getSystemPrompt: () => "sys",
		sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/tmp/s1.jsonl" },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
			// resolveRef 精确匹配：仅 (provider,id) 同时命中时返回模型（配合 hasConfiguredAuth 放行）
			find: (provider: string, id: string) =>
				crossModel && provider === crossModel.provider && id === crossModel.id ? crossModel : null,
			hasConfiguredAuth: () => crossModel != null,
		},
	} as unknown as ExtensionContext;
}

function makePi(): ExtensionAPI {
	return { getAllTools: () => [] } as unknown as ExtensionAPI;
}

const mockedCall = vi.mocked(callSameModelCompaction);
const mockedNative = vi.mocked(nativeCompact);

function makeHandler(config: SmartContextConfig) {
	const state = createTakeoverState();
	const handler = createBeforeCompactHandler(makePi(), () => state, () => config);
	return { handler, state };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("session_before_compact 接管 handler", () => {
	it("门控未放行（disabled / 排除命中）→ 空返回（pi 原生生成）", async () => {
		const disabled = makeHandler(normalizeSmartContextConfig({ enabled: false }));
		await expect(disabled.handler(makeEvent(), makeCtx())).resolves.toEqual({});

		const excluded = makeHandler(
			normalizeSmartContextConfig({ excludedModels: ["zai/glm"] }),
		);
		await expect(excluded.handler(makeEvent(), makeCtx())).resolves.toEqual({});
		expect(mockedCall).not.toHaveBeenCalled();
	});

	it("same-model 成功 → compaction 带 engine/mode/model 标记 + preamble + fileOps 清单 + transcript 指针", async () => {
		mockedCall.mockResolvedValue({ ok: true, text: "summary body", usage: { input: 1, output: 2 } });
		const { handler } = makeHandler(normalizeSmartContextConfig({ compactModel: { type: "ref", ref: "" } }));
		const decision = await handler(makeEvent(), makeCtx());
		// details.model = `${ctx.model.provider}/${ctx.model.id}`（§3.3 ①，用量归属数据源）
		expect(decision.compaction?.details).toEqual({ engine: "smart-context", mode: "same-model", model: "zai/glm" });
		expect(decision.compaction?.summary).toContain("summary body");
		// D13-9 preamble 在最前；D11-2 fileOps；D13-4 transcript
		expect(decision.compaction?.summary.startsWith("This is an automatically generated checkpoint")).toBe(true);
		expect(decision.compaction?.summary).toContain("<read-files>");
		expect(decision.compaction?.summary).toContain("/tmp/s1.jsonl");
		// cache-key 一致性：调用参数含 systemPrompt + tools（mock 收到的 options）
		expect(mockedCall.mock.calls[0][1].systemPrompt).toBe("sys");
	});

	it("max-tokens 截断 fail-closed（D13-2）→ 空返回 + failStreak +1", async () => {
		mockedCall.mockResolvedValue({ ok: true, text: "half...", stopReason: "length" });
		const { handler, state } = makeHandler(normalizeSmartContextConfig({}));
		await expect(handler(makeEvent(), makeCtx())).resolves.toEqual({});
		expect(state.failStreak).toBe(1);
	});

	it("cross-model：resolveModel 不可用 → 空返回（D7 回退）", async () => {
		const { handler } = makeHandler(
			normalizeSmartContextConfig({ compactModel: { type: "ref", ref: "xiaomi/mimo" } }),
		);
		// modelRegistry.find 未命中 mimo → resolveModel 返回 null → generateCrossMode D7 静默回退
		const ctx = makeCtx();
		await expect(handler(makeEvent(), ctx)).resolves.toEqual({});
		expect(mockedNative).not.toHaveBeenCalled();
	});

	it("cross-model 成功 → details.model=compactModel 解析结果，native details 字段保留", async () => {
		mockedNative.mockResolvedValue({
			summary: "native checkpoint",
			firstKeptEntryId: "kept-1",
			tokensBefore: 500_000,
			usage: {
				input: 5, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			details: { nativeMarker: "keep" },
		});
		const { handler } = makeHandler(
			normalizeSmartContextConfig({ compactModel: { type: "ref", ref: "xiaomi/mimo" } }),
		);
		const decision = await handler(makeEvent(), makeCtx({ provider: "xiaomi", id: "mimo" }));
		// details.model = `${resolveModel(...).provider}/${id}`（§3.3 ①）；native details 字段原样保留（spread 增量，不改变其他字段）
		expect(decision.compaction?.details).toEqual({
			engine: "smart-context",
			mode: "cross-model",
			model: "xiaomi/mimo",
			nativeMarker: "keep",
		});
		// nativeCompact 收到的 model 就是解析结果（details.model 与实际执行模型同源）
		expect(mockedNative.mock.calls[0][1]).toEqual({ provider: "xiaomi", id: "mimo" });
	});

	it("收缩校验失败（摘要 ≥ 被压段）→ 拒绝 + 同段记录不重试（D13-1）", async () => {
		mockedCall.mockResolvedValue({ ok: true, text: "z".repeat(10_000) });
		const { handler, state } = makeHandler(normalizeSmartContextConfig({}));
		const event = makeEvent({ messagesToSummarize: [{ role: "user", content: "x".repeat(400), timestamp: 0 }] });
		await expect(handler(event, makeCtx())).resolves.toEqual({});
		expect(state.inflatedSegments.has("kept-1")).toBe(true);
		// 同段第二次直接跳过（不再调 LLM）
		mockedCall.mockClear();
		await expect(handler(event, makeCtx())).resolves.toEqual({});
		expect(mockedCall).not.toHaveBeenCalled();
	});

	it("连续失败 3 次熔断（D13-3）→ 第 4 次起直接空返回", async () => {
		mockedCall.mockResolvedValue({ ok: false, text: "", error: "boom" });
		const { handler, state } = makeHandler(normalizeSmartContextConfig({}));
		for (let i = 0; i < 3; i++) {
			await expect(handler(makeEvent(), makeCtx())).resolves.toEqual({});
		}
		expect(state.failStreak).toBe(3);
		mockedCall.mockClear();
		await expect(handler(makeEvent(), makeCtx())).resolves.toEqual({});
		expect(mockedCall).not.toHaveBeenCalled(); // 熔断后不再尝试
	});
});
