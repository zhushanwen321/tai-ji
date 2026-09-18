/* eslint-disable taste/no-unsafe-cast */

// Mock 共享 logger，让 logger.warn/error 可被 spy（源码已从 console 改为 logger）
const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 只 override resolveModel + callLLM（callRenameLLM 的依赖）；保留 loadConfig/saveConfig 等
// 真实实现，pure.ts 顶层 import 不受影响。vi.mock 被提升到文件顶部执行。
vi.mock("@zhushanwen/pi-llm-shared", async (importActual) => {
	const actual = await importActual<typeof import("@zhushanwen/pi-llm-shared")>();
	return { ...actual, resolveModel: vi.fn(), callLLM: vi.fn() };
});

// mock pure.js：只把 cleanTitle 包一层 vi.fn（委托真实实现，行为零变化）——
// 「回调在 cleanTitle 之前」的时序断言需要 cleanTitle 可观测（invocationCallOrder 比较）。
vi.mock("../pure.js", async (importActual) => {
	const actual = await importActual<typeof import("../pure.js")>();
	return { ...actual, cleanTitle: vi.fn(actual.cleanTitle) };
});

// 被测模块须在 vi.mock 之后 import
import { callLLM, resolveModel } from "@zhushanwen/pi-llm-shared";

import {
	RENAME_INSTRUCTION,
	RENAME_SYSTEM_PROMPT,
	buildTitleMessages,
	callRenameLLM,
	extractFinalText,
	extractUserPromptText,
	isSubagentSession,
	truncateForTitle,
} from "../llm.js";
import { cleanTitle, type RenameSessionConfig } from "../pure.js";

// 每用例收尾统一还原：logger mock 恢复 + stub 的 TAIJI_AGENT_DEBUG 还原，
// 防泄漏到后续用例（debug 开关 live 读 process.env，依赖 stubEnv/unstubAllEnvs 成对）
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// ────────────────────────────────────────────────────
// extractUserPromptText（标题输入信号之一——首条 user prompt 提取）
// ────────────────────────────────────────────────────

describe("extractUserPromptText", () => {
	it("LTC6: content 为 string → 直接返回", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "帮我修复登录超时" } },
		];
		expect(extractUserPromptText(entries)).toBe("帮我修复登录超时");
	});

	it("LTC7: blocks 混合（text+image+text）→ image 跳过，多 text block join(' ')", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "帮我修复登录超时" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
						{ type: "text", text: "最好加单测" },
					],
				},
			},
		];
		expect(extractUserPromptText(entries)).toBe("帮我修复登录超时 最好加单测");
	});

	it("LTC7b: 纯 image blocks（无 text）→ ''（找到首条 user 但无文本，按空文本处理不返回 null）", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
				},
			},
		];
		expect(extractUserPromptText(entries)).toBe("");
	});

	it("LTC7c: content 形态未知（非 string 非 array）→ ''（异常数据按无文本处理，不继续扫后续 user）", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: 42 } },
			{ type: "message", message: { role: "user", content: "第二条不该被取到" } },
		];
		expect(extractUserPromptText(entries)).toBe("");
	});

	it("LTC8: 无 user message（compaction + assistant only）→ null", () => {
		const entries = [
			{ type: "compaction", data: {} },
			{ type: "message", message: { role: "assistant", content: [] } },
		];
		expect(extractUserPromptText(entries)).toBeNull();
	});

	it("LTC9: 首条 user 前有 compaction entry → 仍取首条 user（跳过非 message/非 user entry）", () => {
		const entries = [
			{ type: "compaction", data: {} },
			{ type: "message", message: { role: "user", content: "继续刚才的" } },
			{ type: "message", message: { role: "user", content: "第二条 user 不取" } },
		];
		expect(extractUserPromptText(entries)).toBe("继续刚才的");
	});
});

// ────────────────────────────────────────────────────
// extractFinalText（final text = 触发 turn 的 assistant text blocks）
// ────────────────────────────────────────────────────

describe("extractFinalText", () => {
	it("LTC10: text/thinking/toolCall 三类 block 混合 → 只拼接 text block（join(' ')）", () => {
		const message = {
			content: [
				{ type: "thinking", thinking: "让我看看代码" },
				{ type: "text", text: "已修复" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
				{ type: "text", text: "并补了回归测试" },
			],
		};
		expect(extractFinalText(message)).toBe("已修复 并补了回归测试");
	});

	it("LTC11: 全空 content（空数组）→ ''", () => {
		expect(extractFinalText({ content: [] })).toBe("");
	});

	it("LTC11b: content 缺失或无 text block → ''", () => {
		expect(extractFinalText({})).toBe("");
		expect(extractFinalText({ content: [{ type: "thinking", thinking: "..." }] })).toBe("");
	});
});

// ────────────────────────────────────────────────────
// truncateForTitle（输入段按码点截断保护，超长才加 '…'）
// ────────────────────────────────────────────────────

describe("truncateForTitle", () => {
	it("LTC12: 中文超长 → 截断到 4000 码点 + '…' 后缀，星面字符完整（无半个代理对）", () => {
		// 3999 个 BMP 字符 + 2 个星面字符（😀 U+1F600：2 个 UTF-16 码元 = 1 个码点）= 4001 码点
		const text = "修".repeat(3999) + "😀".repeat(2);
		const result = truncateForTitle(text);
		const chars = Array.from(result);
		expect(chars).toHaveLength(4001); // 4000 截断 + 1 个 …
		expect(chars[3999]).toBe("😀"); // 边界切在码点边界，emoji 不被劈成半个代理对
		expect(chars[4000]).toBe("…");
	});

	it("LTC12b: 不超长 → 原样返回（无 '…' 后缀）", () => {
		expect(truncateForTitle("你好")).toBe("你好");
		expect(truncateForTitle("")).toBe("");
	});

	it("LTC12c: 恰好 4000 码点 → 原样返回，不加后缀", () => {
		const text = "a".repeat(4000);
		const result = truncateForTitle(text);
		expect(result).toBe(text);
		expect(result.endsWith("…")).toBe(false);
	});
});

// ────────────────────────────────────────────────────
// buildTitleMessages（两段信号 + 指令的三段式构造）
// ────────────────────────────────────────────────────

describe("buildTitleMessages", () => {
	it("LTC14: finalText 非空 → 3 条 [user(prompt), assistant(finalText), user(instruction)]，user 条目带 timestamp", () => {
		const result = buildTitleMessages("帮我修复登录超时", "已修复：调整了超时配置", "生成标题指令");
		expect(result).toHaveLength(3);

		const first = result[0] as {
			role: string;
			content: { type: string; text: string }[];
			timestamp?: number;
		};
		expect(first.role).toBe("user");
		expect(first.content[0].type).toBe("text");
		expect(first.content[0].text).toBe("帮我修复登录超时");
		expect(typeof first.timestamp).toBe("number");

		const second = result[1] as { role: string; content: { type: string; text: string }[] };
		expect(second.role).toBe("assistant");
		expect(second.content[0].type).toBe("text");
		expect(second.content[0].text).toBe("已修复：调整了超时配置");

		const third = result[2] as {
			role: string;
			content: { type: string; text: string }[];
			timestamp?: number;
		};
		expect(third.role).toBe("user");
		expect(third.content[0].text).toBe("生成标题指令");
		expect(typeof third.timestamp).toBe("number");
	});

	it("LTC15: finalText 为空 → 2 条（降级只发 prompt + instruction，无 assistant 条目）", () => {
		const result = buildTitleMessages("继续刚才的", "", "生成标题指令");
		expect(result).toHaveLength(2);
		expect(result.map((m) => m.role)).toEqual(["user", "user"]);
		// 第二条 content 为 instruction（wave-1 followup 补强：降级路径的文本断言）
		const second = result[1] as { content: { type: string; text: string }[] };
		expect(second.content[0].type).toBe("text");
		expect(second.content[0].text).toBe("生成标题指令");
	});
});

// ────────────────────────────────────────────────────
// isSubagentSession（保留，不变）
// ────────────────────────────────────────────────────

describe("isSubagentSession", () => {
	it("LTC4: subagents 路径返回 true", () => {
		expect(isSubagentSession("/home/u/.pi/agent/subagents/--proj--/sessions")).toBe(true);
	});

	it("LTC5: 主 session 路径返回 false", () => {
		expect(isSubagentSession("/home/u/.pi/agent/sessions")).toBe(false);
	});
});

// ────────────────────────────────────────────────────
// RENAME_SYSTEM_PROMPT / RENAME_INSTRUCTION（slug 风格约束 + few-shot 锚定）
// ────────────────────────────────────────────────────

describe("RENAME_SYSTEM_PROMPT / RENAME_INSTRUCTION", () => {
	it("LTC16: SYSTEM_PROMPT string.length < 200（精简 prompt，对比改造前 ctx.getSystemPrompt() > 2000）", () => {
		expect(RENAME_SYSTEM_PROMPT.length).toBeLessThan(200);
	});

	it("LTC17: INSTRUCTION 含正例锚定（「修复登录超时」+「refactor-config-loader」）", () => {
		expect(RENAME_INSTRUCTION).toContain("修复登录超时");
		expect(RENAME_INSTRUCTION).toContain("refactor-config-loader");
	});

	it("LTC18: INSTRUCTION 含反例锚定（「我帮你修复了登录 bug」——主谓宾句子是错误形态）", () => {
		expect(RENAME_INSTRUCTION).toContain("我帮你修复了登录 bug");
	});

	it("LTC19: 两常量均含 slug 风格约束词（逐常量 toContain 强断言，不用 or 弱断言）", () => {
		for (const c of [RENAME_SYSTEM_PROMPT, RENAME_INSTRUCTION]) {
			expect(c).toContain("kebab-case");
			expect(c).toContain("名词或动名词");
		}
	});
});

// ────────────────────────────────────────────────────
// 空 ref fallback（空 ref → ctx.model 跟随会话主模型；非空无效 ref → 静默跳过 + warn）
// ────────────────────────────────────────────────────

describe("callRenameLLM D5 空 ref fallback（跟随会话主模型）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("TC-D5-1: 空 ref + ctx.model 可用 → 用 ctx.model 发起调用，resolveModel 不被调（探针 P2：首轮 ctx.model 非 undefined）", async () => {
		const ctx = createCtx(undefined, STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "标题" });

		const result = await callRenameLLM(ctx, { ...BASE_CONFIG, model: { type: "ref", ref: "" } }, FINAL_MESSAGE);

		expect(result).toBe("标题");
		expect(resolveModel).not.toHaveBeenCalled(); // 空 ref 不走独立选模
		expect(callLLM).toHaveBeenCalledTimes(1);
		const callOpts = vi.mocked(callLLM).mock.calls[0][1] as { model: unknown };
		expect(callOpts.model).toBe(STUB_MODEL); // 传给 callLLM 的就是 ctx.model
	});

	it("TC-D5-2: 空 ref + ctx.model undefined → 返回 null + warn（维持现状可诊断，不报错）", async () => {
		loggerMock.warn.mockClear();
		const ctx = createCtx(undefined, undefined);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "标题" });

		const result = await callRenameLLM(ctx, { ...BASE_CONFIG, model: { type: "ref", ref: "" } }, FINAL_MESSAGE);

		expect(result).toBeNull();
		expect(loggerMock.warn).toHaveBeenCalledWith("model not available, skipping");
		expect(callLLM).not.toHaveBeenCalled();
	});

	it("TC-D5-3: 非空无效 ref（显式配错）→ 仍走 resolveModel 独立选模，null 时静默跳过 + warn（不掩盖配置错误）", async () => {
		loggerMock.warn.mockClear();
		vi.mocked(resolveModel).mockReturnValue(null);

		const result = await callRenameLLM(createCtx(undefined, STUB_MODEL), BASE_CONFIG, FINAL_MESSAGE);

		expect(resolveModel).toHaveBeenCalledTimes(1); // 非空 ref 才走独立选模
		expect(result).toBeNull();
		expect(loggerMock.warn).toHaveBeenCalledWith("model not available, skipping");
		expect(callLLM).not.toHaveBeenCalled();
	});

	it("TC-D5-4: 非空有效 ref → resolveModel 结果优先于 ctx.model（显式配置不被会话模型遮蔽）", async () => {
		const configured: Model<Api> = { ...STUB_MODEL, id: "configured-model" };
		vi.mocked(resolveModel).mockReturnValue(configured);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "标题" });

		await callRenameLLM(createCtx(undefined, STUB_MODEL), BASE_CONFIG, FINAL_MESSAGE);

		const callOpts = vi.mocked(callLLM).mock.calls[0][1] as { model: unknown };
		expect(callOpts.model).toBe(configured);
	});
});

// ────────────────────────────────────────────────────
// promptText 选项（first-prompt：文本从 message_end 载荷取，不走 entries）
// ────────────────────────────────────────────────────

describe("callRenameLLM promptText 选项（first-prompt 载荷取文本）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("TC-D2-1: 传 promptText → user prompt 从选项取（entries 里的 user 不被读取）", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "标题" });
		// entries 故意无 user message：first-prompt 时点 entries 尚未 append 本条（探针 P1），
		// 若代码误走 entries 路径会得到 null → 不调 callLLM，本用例红
		const ctx = createCtx([]);

		await callRenameLLM(ctx, BASE_CONFIG, { content: [] }, { promptText: "载荷里的完整 prompt" });

		expect(callLLM).toHaveBeenCalledTimes(1);
		const callOpts = vi.mocked(callLLM).mock.calls[0][1] as {
			messages: { role: string; content: { type: string; text: string }[] }[];
		};
		// finalText 空（first-prompt 不等回复）→ 两条降级：user(promptText) + user(instruction)
		expect(callOpts.messages.map((m) => m.role)).toEqual(["user", "user"]);
		expect(callOpts.messages[0].content[0].text).toBe("载荷里的完整 prompt");
		expect(callOpts.messages[1].content[0].text).toBe(RENAME_INSTRUCTION);
	});

	it("TC-D2-2: 不传 promptText → 走 entries 提取（first-stop 现状路径回归锚）", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "标题" });

		await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);

		const callOpts = vi.mocked(callLLM).mock.calls[0][1] as {
			messages: { role: string; content: { type: string; text: string }[] }[];
		};
		expect(callOpts.messages[0].content[0].text).toBe("hi"); // 来自 entries 的首条 user
	});
});

// ────────────────────────────────────────────────────
// callRenameLLM（mock resolveModel + callLLM @ llm-shared 边界）
// ────────────────────────────────────────────────────

/** 开 debug 开关 + 清空 warn mock，返回 loggerMock.warn 供日志断言（还原由顶层 afterEach 统一负责）。 */
function debugWarnSpy(): ReturnType<typeof vi.fn> {
	vi.stubEnv("TAIJI_AGENT_DEBUG", "1");
	loggerMock.warn.mockClear();
	return loggerMock.warn;
}

/** warn spy 的全部调用文本行（debug 日志断言用）。 */
function warnLines(warnSpy: ReturnType<typeof vi.fn>): string[] {
	return warnSpy.mock.calls.map((c) => String(c[0]));
}

/** resolveModel 的合法 Model<Api> 常量（pi-ai Model 接口全字段，消除 unsafe-cast 强断言）。 */
const STUB_MODEL: Model<Api> = {
	id: "stub-model",
	name: "Stub Model",
	api: "anthropic-messages",
	provider: "stub",
	baseUrl: "https://stub.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

const BASE_CONFIG: RenameSessionConfig = {
	enabled: true,
	model: { type: "ref", ref: "stub/stub-model" },
	mode: "first-stop",
	maxTitleLength: 50,
	thinkingLevel: "off",
};

/** 触发 turn 的最终 assistant message（turn_end 的 event.message）——thinking 混排验证只取 text。 */
const FINAL_MESSAGE = {
	stopReason: "stop",
	content: [
		{ type: "thinking", thinking: "思考过程不进标题输入" },
		{ type: "text", text: "已修复：调整了超时配置" },
	],
};

function createCtx(entries?: unknown[], model?: Model<Api> | undefined): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () =>
				entries ?? [
					{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
				],
			getSessionId: () => "test-session-id",
		},
		model,
		signal: new AbortController().signal,
	} as unknown as ExtensionContext;
}

describe("callRenameLLM", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("resolveModel 返回 null（model 不可用）→ 返回 null，不调 callLLM（静默跳过）", async () => {
		vi.mocked(resolveModel).mockReturnValue(null);
		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);
		expect(result).toBeNull();
		expect(callLLM).not.toHaveBeenCalled();
	});

	it("callLLM 返回 {ok:false} → 返回 null（静默跳过，不抛错）", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: false, error: "boom" });
		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);
		expect(result).toBeNull();
	});

	it("callLLM 返回 {ok:true, content} → cleanTitle 后返回", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "  修复登录bug  " });
		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);
		expect(result).toBe("修复登录bug");
	});

	it("callLLM 返回空 content（cleanTitle 空串）→ 返回 null", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "   " });
		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);
		expect(result).toBeNull();
	});

	it("传给 callLLM 的 opts：model/systemPrompt(<200)/maxTokens=64/timeoutMs=30000/signal/sessionId/无 tools，messages 三段式", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "标题" });
		await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);

		expect(callLLM).toHaveBeenCalledTimes(1);
		const callOpts = vi.mocked(callLLM).mock.calls[0][1] as {
			model: unknown;
			systemPrompt: string;
			messages: { role: string; content: { type: string; text: string }[] }[];
			maxTokens: number;
			timeoutMs: number;
			signal: AbortSignal;
			sessionId: string;
			tools?: unknown;
		};
		expect(callOpts.model).toBe(STUB_MODEL);
		expect(callOpts.systemPrompt).toBe(RENAME_SYSTEM_PROMPT);
		expect(callOpts.systemPrompt.length).toBeLessThan(200);
		expect(callOpts.maxTokens).toBe(64);
		// 固定 30s 超时（超时归一 ok:false 走静默跳过）
		expect(callOpts.timeoutMs).toBe(30000);
		expect(callOpts.signal).toBeInstanceOf(AbortSignal);
		expect(callOpts.sessionId).toBe("test-session-id");
		// 三段式：user(prompt) + assistant(finalText) + user(instruction)
		expect(callOpts.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(callOpts.messages[0].content[0].text).toBe("hi");
		// finalText 只取 text block（FINAL_MESSAGE 内 thinking 跳过）
		expect(callOpts.messages[1].content[0].text).toBe("已修复：调整了超时配置");
		expect(callOpts.messages[2].content[0].text).toBe(RENAME_INSTRUCTION);
		// tools 不在 opts（callLLM 内部显式传 tools:[]，调用方不传）
		expect(callOpts.tools).toBeUndefined();
	});

	it("TC4: 两段输入构造——entries 多轮混排只取首 user prompt + finalMessage 文本；finalText 空时降级两条", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "标题" });
		// 多轮混排：中间 assistant 轮 / toolResult entry 都不该进入标题输入
		const entries = [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "帮我修复登录超时" }] } },
			{
				type: "message",
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
				},
			},
			{ type: "toolResult", message: { role: "toolResult" } },
			{
				type: "message",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "entries 里的 stop 轮不作为 final" }],
				},
			},
		];
		await callRenameLLM(createCtx(entries), BASE_CONFIG, FINAL_MESSAGE);

		const callOpts = vi.mocked(callLLM).mock.calls[0][1] as {
			messages: { role: string; content: { type: string; text: string }[] }[];
		};
		expect(callOpts.messages).toHaveLength(3);
		expect(callOpts.messages[0].content[0].text).toBe("帮我修复登录超时");
		// assistant 条目来自 finalMessage（第三参），不来自 entries 反扫
		expect(callOpts.messages[1].content[0].text).toBe("已修复：调整了超时配置");
		expect(callOpts.messages[2].content[0].text).toBe(RENAME_INSTRUCTION);

		// finalText 空（text blocks 为空的 stop 轮）→ 两条降级（prompt + instruction）
		vi.mocked(callLLM).mockClear();
		await callRenameLLM(createCtx(entries), BASE_CONFIG, { stopReason: "stop", content: [] });
		const downgraded = vi.mocked(callLLM).mock.calls[0][1] as {
			messages: { role: string }[];
		};
		expect(downgraded.messages.map((m) => m.role)).toEqual(["user", "user"]);
	});

	it("TC5: debug 日志内省在 callLLM 之前打出；长文本 head200…tail100 截断格式", async () => {
		const warnSpy = debugWarnSpy();
		// 甲乙丙三段唯一定位符：甲=首200 丙=尾100 乙=中段100（RENAME_INSTRUCTION 与夹具均不含这三字）
		const head = "甲".repeat(200);
		const middle = "乙".repeat(100);
		const tail = "丙".repeat(100);
		const longPrompt = head + middle + tail; // 401 字符 > 300
		const ctx = createCtx([
			{ type: "message", message: { role: "user", content: [{ type: "text", text: longPrompt }] } },
		]);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		// mockImplementation 在被调时刻快照日志状态——若日志后置到 callLLM 之后，快照为空则本用例红
		let logAtCallTime = "";
		vi.mocked(callLLM).mockImplementation(async () => {
			logAtCallTime = warnLines(warnSpy).join("\n");
			return { ok: true, content: "修复登录超时" };
		});

		const result = await callRenameLLM(ctx, BASE_CONFIG, FINAL_MESSAGE);

		expect(result).toBe("修复登录超时");
		// 内省日志在请求发起前已打出（debug 证据链时序契约）
		expect(logAtCallTime).toContain("LLM request messages:");
		expect(logAtCallTime).toContain('"role":"user"');
		// 截断格式（C3）：head 200 + 字面 … + tail 100，中段被截掉
		expect(logAtCallTime).toContain(head);
		expect(logAtCallTime).toContain(tail);
		expect(logAtCallTime).not.toContain("乙");
		// 「renamed to」日志已移位到 landing.ts landTitle（setSessionName 之后）——
		// callRenameLLM 全流程（含成功路径）不再打出该日志
		const logAfter = warnLines(warnSpy).join("\n");
		expect(logAfter).not.toContain("renamed to");
	});

	it("TC5b: preview 截断按 Unicode 码点——emoji（代理对）在 head/tail 边界不被劈开", async () => {
		const warnSpy = debugWarnSpy();
		const emoji = "😀"; // U+1F600：2 个 UTF-16 码元 = 1 码点
		// head 200 码点（末位 emoji）+ middle 100 + tail 100 码点（末位 emoji）= 401 码点 > 300。
		// 若按 UTF-16 码元截断，head/tail 末位会把 emoji 劈成孤立高/低代理
		const head = "甲".repeat(199) + emoji;
		const middle = "乙".repeat(100);
		const tail = "丙".repeat(99) + emoji;
		const ctx = createCtx([
			{ type: "message", message: { role: "user", content: [{ type: "text", text: head + middle + tail }] } },
		]);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "标题" });

		await callRenameLLM(ctx, BASE_CONFIG, FINAL_MESSAGE);

		const marker = "LLM request messages: ";
		const reqLine = warnLines(warnSpy).find((l) => l.includes(marker));
		expect(reqLine).toBeDefined();
		const jsonPart = reqLine !== undefined ? reqLine.slice(reqLine.indexOf(marker) + marker.length) : "";
		const json = JSON.parse(jsonPart) as Array<{ role: string; text: string }>;
		const preview = json[0]?.text ?? "";
		// 码点截断契约：head 200 码点（末位完整 emoji）+ 字面 … + tail 100 码点（末位完整 emoji）
		expect(preview).toBe(head + "…" + tail);
		expect(preview).not.toContain("乙");
	});

	it("TC6: entries 无 user message → 返回 null 不调 callLLM，debug 输出 skip: no user prompt", async () => {
		const warnSpy = debugWarnSpy();
		// resolveModel 先 stub 可用模型（extract 在 resolveModel 之后，不 stub 会走 model not available 分支）
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);

		const result = await callRenameLLM(createCtx([]), BASE_CONFIG, FINAL_MESSAGE);

		expect(result).toBeNull();
		expect(callLLM).not.toHaveBeenCalled();
		// C3 契约：t=<ISO>（llm.ts 侧不含 turnIndex；[rename-session] 前缀由共享 logger prefixMsg 自动补，spy 捕获原始入参）
		const line = warnLines(warnSpy).find((l) => l.includes("skip: no user prompt"));
		expect(line).toMatch(/^t=\d{4}-\d{2}-\d{2}T/);
	});

	it("TC7: callLLM ok:false（超时/模型错误）→ 返回 null 不抛错（失败归一静默跳过）", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: false, error: "timeout" });
		await expect(callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE)).resolves.toBeNull();
	});

	it("TC9: debug 开启 + callLLM 空 content → 输出 skip: title empty 且返回 null", async () => {
		const warnSpy = debugWarnSpy();
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "   " });

		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);

		expect(result).toBeNull();
		// 该日志在 cleanTitle 清洗为空、返回 null 前打出（7 条契约文案之一）
		const line = warnLines(warnSpy).find((l) => l.includes("skip: title empty"));
		expect(line).toMatch(/^t=\d{4}-\d{2}-\d{2}T/);
	});

	it("maxTitleLength 截断生效（config.maxTitleLength 透传给 cleanTitle）", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		const longTitle = "一二三四五六七八九十一二三四五六七八九十";
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: longTitle });
		const result = await callRenameLLM(createCtx(), { ...BASE_CONFIG, maxTitleLength: 5 }, FINAL_MESSAGE);
		expect(Array.from(result as string).length).toBe(5);
	});

	it("resolveModel 收到 config.model（验证 selector 透传）", async () => {
		vi.mocked(resolveModel).mockReturnValue(null);
		const ctx = createCtx();
		await callRenameLLM(ctx, BASE_CONFIG, FINAL_MESSAGE);
		expect(resolveModel).toHaveBeenCalledWith(ctx, BASE_CONFIG.model);
	});

	it("thinkingLevel=off → 透传 reasoning=off（llm-shared 内部映射为不传）", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "标题" });
		await callRenameLLM(createCtx(), { ...BASE_CONFIG, thinkingLevel: "off" }, FINAL_MESSAGE);

		const callOpts = vi.mocked(callLLM).mock.calls[0][1] as { reasoning?: unknown };
		expect(callOpts.reasoning).toBe("off");
	});

	it("thinkingLevel=high → 透传 reasoning=high", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "标题" });
		await callRenameLLM(createCtx(), { ...BASE_CONFIG, thinkingLevel: "high" }, FINAL_MESSAGE);

		const callOpts = vi.mocked(callLLM).mock.calls[0][1] as { reasoning?: unknown };
		expect(callOpts.reasoning).toBe("high");
	});
});

// ────────────────────────────────────────────────────
// usage 落账回调（appendUsageEntry 注入；时点与 catch 归属契约见 llm.ts CallRenameLLMOptions）
// ────────────────────────────────────────────────────

/** 合法 Usage 夹具（pi-ai Usage 全必填字段，消除 unsafe-cast 强断言）。 */
const STUB_USAGE: Usage = {
	input: 10,
	output: 5,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 18,
	cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};

describe("callRenameLLM usage 落账回调（appendUsageEntry 注入）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("usage 存在 + 注入回调 → 恰被调一次、参数 (provider/id, usage 同一引用)，且在 cleanTitle 之前", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({
			ok: true,
			content: "  修复登录bug  ",
			usage: STUB_USAGE,
		});
		const appendUsageEntry = vi.fn();

		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE, {
			appendUsageEntry,
		});

		expect(result).toBe("修复登录bug");
		expect(appendUsageEntry).toHaveBeenCalledTimes(1);
		expect(appendUsageEntry).toHaveBeenCalledWith("stub/stub-model", STUB_USAGE);
		// 时点契约：ok:true && usage 后立即、cleanTitle 之前
		expect(appendUsageEntry.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(cleanTitle).mock.invocationCallOrder[0],
		);
	});

	it("计量与标题清洗成败解耦：content 清洗后为空（rename 跳过返回 null）→ 回调仍恰被调一次", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "   ", usage: STUB_USAGE });
		const appendUsageEntry = vi.fn();

		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE, {
			appendUsageEntry,
		});

		expect(result).toBeNull();
		expect(appendUsageEntry).toHaveBeenCalledTimes(1);
		expect(appendUsageEntry).toHaveBeenCalledWith("stub/stub-model", STUB_USAGE);
	});

	it("usage 缺失（provider 不回）→ 跳过回调不落账（存在性守卫），标题照常返回", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "修复登录bug" });
		const appendUsageEntry = vi.fn();

		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE, {
			appendUsageEntry,
		});

		expect(result).toBe("修复登录bug");
		expect(appendUsageEntry).not.toHaveBeenCalled();
	});

	it("回调内部抛错被回调实现 catch（契约：catch 位于回调实现内部，模拟 landing.ts 注入的真实回调）→ 不阻断 cleanTitle 流程，标题照常返回", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "修复登录bug", usage: STUB_USAGE });
		const appendUsageEntry = vi.fn((_model: string, _usage: Usage) => {
			try {
				throw new Error("session switched"); // 模拟 pi.appendEntry 抛错（session 已切换等）
			} catch {
				// 回调体内 catch（catch 必须位于回调实现内部）——landing.ts 注入实现同款
			}
		});

		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE, {
			appendUsageEntry,
		});

		expect(result).toBe("修复登录bug");
		expect(appendUsageEntry).toHaveBeenCalledTimes(1);
	});

	it("违约回调（实现未自吞错直接抛出）→ callRenameLLM reject（llm.ts 不吞错——catch 归属钉死回调实现内部，防双重 catch 漂移；真实接线的兜底由 landing.ts 回调体内 catch + 外层 .catch 覆盖）", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "修复登录bug", usage: STUB_USAGE });
		const appendUsageEntry = vi.fn(() => {
			throw new Error("contract violation");
		});

		await expect(
			callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE, { appendUsageEntry }),
		).rejects.toThrow("contract violation");
	});
});

// ────────────────────────────────────────────────────
// A1 日志（失败路径 + 成功路径可排查，契约 C1 文案锁定）
// ────────────────────────────────────────────────────

describe("callRenameLLM A1 日志", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("TC1: resolveModel null → logger.warn('model not available, skipping')（前缀由真实 logger 补），返回 null", async () => {
		loggerMock.warn.mockClear();
		vi.mocked(resolveModel).mockReturnValue(null);
		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);
		expect(result).toBeNull();
		expect(loggerMock.warn).toHaveBeenCalledWith("model not available, skipping");
	});

	it("TC2: callLLM {ok:false} → logger.warn('rename LLM call failed', {error})（前缀由真实 logger 补），返回 null", async () => {
		loggerMock.warn.mockClear();
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: false, error: "boom" });
		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);
		expect(result).toBeNull();
		expect(loggerMock.warn).toHaveBeenCalledWith("rename LLM call failed", { error: "boom" });
	});

	it("TC2b: callLLM {ok:false} → 不输出 'rename with model' 成功日志（B2 位置修正：成功日志已移到 result.ok 分支后），但仍输出 failed 日志", async () => {
		loggerMock.warn.mockClear();
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: false, error: "boom" });
		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);
		expect(result).toBeNull();
		// 失败分支仍输出 failed 日志
		expect(loggerMock.warn).toHaveBeenCalledWith(
			"rename LLM call failed",
			{ error: "boom" },
		);
		// 失败分支不应输出成功日志（B2：成功日志移到 result.ok=true 之后）
		const successLogCalls = loggerMock.warn.mock.calls.filter((c) =>
			String(c[0]).includes("rename with model"),
		);
		expect(successLogCalls).toHaveLength(0);
	});

	it("TC3: callLLM 成功 → 默认不输出 'rename with model'（避免常开日志污染 Pi 输入框），返回标题", async () => {
		loggerMock.warn.mockClear();
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "修复登录bug" });
		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);
		expect(result).toBe("修复登录bug");
		const successLogCalls = loggerMock.warn.mock.calls.filter((c) =>
			String(c[0]).includes("rename with model"),
		);
		expect(successLogCalls).toHaveLength(0);
	});

	it("TC3b: debug 开启 + callLLM 成功 → 输出 'rename with model <provider>/<modelId>'（B3 带 provider 前缀），返回标题", async () => {
		const warnSpy = debugWarnSpy();
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "修复登录bug" });
		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);
		expect(result).toBe("修复登录bug");
		const line = warnLines(warnSpy).find((l) => l.includes("rename with model"));
		expect(line).toMatch(
			/^t=\d{4}-\d{2}-\d{2}T.*rename with model stub\/stub-model/,
		);
	});
});
