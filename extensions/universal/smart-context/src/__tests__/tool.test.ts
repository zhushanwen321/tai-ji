import { beforeEach, describe, expect, it, vi } from "vitest";

// mock 配置加载（工具测试不落盘）
vi.mock("../pure.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../pure.js")>();
	return {
		...actual,
		loadSmartContextConfig: vi.fn(),
	};
});

import { DEFAULT_SMART_CONTEXT_CONFIG, loadSmartContextConfig } from "../pure.js";
import { registerCompactContextTool } from "../tool.js";
import { countCompactions } from "../pure.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface RegisteredTool {
	name: string;
	parameters: { type?: string };
	execute: (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

type CompactOpts = {
	customInstructions?: string;
	onComplete: (r: unknown) => void;
	onError: (e: Error) => void;
};

function makePi(): { pi: ExtensionAPI & { sendUserMessage: ReturnType<typeof vi.fn> }; tools: RegisteredTool[] } {
	const tools: RegisteredTool[] = [];
	const pi = {
		registerTool: (t: RegisteredTool) => tools.push(t),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI & { sendUserMessage: ReturnType<typeof vi.fn> };
	return { pi, tools };
}

function makeCtx(compactImpl?: (options: CompactOpts) => void): ExtensionContext {
	return {
		model: { provider: "zai", id: "glm" },
		getContextUsage: () => ({ tokens: 250_000, contextWindow: 1_000_000 }),
		sessionManager: { getEntries: () => [] },
		compact: compactImpl ?? ((options: CompactOpts) => {
			options.onComplete({
				tokensBefore: 500_000,
				estimatedTokensAfter: 24_000,
				usage: { input: 432_000, output: 1_800, cacheRead: 0 },
				details: { engine: "smart-context", mode: "same-model" },
			});
		}),
	} as unknown as ExtensionContext;
}

const mockedLoad = vi.mocked(loadSmartContextConfig);

beforeEach(() => {
	vi.clearAllMocks();
	mockedLoad.mockReturnValue(DEFAULT_SMART_CONTEXT_CONFIG);
});

describe("compact_context 工具（R2 降级态：fire-and-forget + 结果注入）", () => {
	it("parameters 顶层为 Type.Object（OpenAI 兼容红线）", () => {
		const { pi, tools } = makePi();
		registerCompactContextTool(pi);
		expect(tools[0].parameters.type).toBe("object");
		expect(tools[0].name).toBe("compact_context");
	});

	it("门控拒绝（排除命中）→ throw 带原因与恢复指引（D5）", async () => {
		mockedLoad.mockReturnValue({ ...DEFAULT_SMART_CONTEXT_CONFIG, excludedModels: ["zai/glm"] });
		const { pi, tools } = makePi();
		registerCompactContextTool(pi, { gatingProbe: () => ({ active: false, modelId: "zai/glm" }) });
		await expect(tools[0].execute("t1", {}, undefined, undefined, makeCtx())).rejects.toThrow(/已配置为排除/);
	});

	it("阈值保护：低于最低档 throw 带用量数据（D6）", async () => {
		const { pi, tools } = makePi();
		registerCompactContextTool(pi, { usageProbe: () => ({ tokens: 38_000, contextWindow: 1_000_000 }) });
		await expect(tools[0].execute("t1", {}, undefined, undefined, makeCtx())).rejects.toThrow(/38K/);
	});

	it("阈值保护：tokens null → 用量未知拒绝（D6 null 分支）", async () => {
		const { pi, tools } = makePi();
		registerCompactContextTool(pi, { usageProbe: () => ({ tokens: null, contextWindow: 1_000_000 }) });
		await expect(tools[0].execute("t1", {}, undefined, undefined, makeCtx())).rejects.toThrow(/用量未知/);
	});

	it("execute 立即返回「已启动」（不 await 压缩完成，R2 契约）+ details 结构化", async () => {
		const { pi, tools } = makePi();
		registerCompactContextTool(pi, { getEntries: () => [{ type: "message" }] });
		const result = await tools[0].execute("t1", {}, undefined, undefined, makeCtx());
		expect(result.content[0].text).toContain("压缩已启动");
		expect(result.content[0].text).toContain("same-model");
		expect(result.details).toMatchObject({ mode: "same-model", launched: true, fellBack: false, compactionCount: 1 });
	});

	it("onComplete 兑现后 sendUserMessage 注入结果（含模式/前后 tokens/成本；降智提示按次数）", async () => {
		const { pi, tools } = makePi();
		registerCompactContextTool(pi, { getEntries: () => [{ type: "compaction" }, { type: "compaction" }] });
		await tools[0].execute("t1", {}, undefined, undefined, makeCtx());
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const [message, options] = pi.sendUserMessage.mock.calls[0];
		expect(message).toContain("压缩完成");
		expect(message).toContain("same-model");
		expect(message).toContain("500K");
		expect(message).toContain("24K");
		expect(message).toContain("compacted multiple times");
		expect(options).toEqual({ deliverAs: "steer" });
	});

	it("onComplete 无 engine 标记 → 注入消息含回退说明与修复指引（D7）", async () => {
		const { pi, tools } = makePi();
		registerCompactContextTool(pi);
		const ctx = makeCtx((options) => options.onComplete({ tokensBefore: 1, estimatedTokensAfter: 1 }));
		await tools[0].execute("t1", {}, undefined, undefined, ctx);
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(pi.sendUserMessage.mock.calls[0][0]).toContain("回退");
	});

	it("onError → 注入失败消息带重试指引", async () => {
		const { pi, tools } = makePi();
		registerCompactContextTool(pi);
		const ctx = makeCtx((options) => options.onError(new Error("Nothing to compact")));
		await tools[0].execute("t1", {}, undefined, undefined, ctx);
		expect(pi.sendUserMessage.mock.calls[0][0]).toContain("压缩失败");
		expect(pi.sendUserMessage.mock.calls[0][0]).toContain("Nothing to compact");
	});

	it("custom_instructions 透传给 ctx.compact", async () => {
		let received: string | undefined;
		const { pi, tools } = makePi();
		registerCompactContextTool(pi);
		const ctx = makeCtx((options) => {
			received = options.customInstructions;
			options.onComplete({ details: { engine: "smart-context", mode: "cross-model" } });
		});
		await tools[0].execute("t1", { custom_instructions: "保留验证结果" }, undefined, undefined, ctx);
		expect(received).toBe("保留验证结果");
	});

	it("countCompactions 只数 compaction entries", () => {
		expect(countCompactions([{ type: "message" }, { type: "compaction" }, { type: "compaction" }])).toBe(2);
	});
});
