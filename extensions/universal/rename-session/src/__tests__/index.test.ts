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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock llm-shared：只 override resolveModel + callLLM（callRenameLLM 的依赖），
// loadConfig/saveConfig 等保留真实实现（pure.ts 顶层 import 不受影响）。
// 竞态/编排用例在此 mock callLLM 为 deferred promise 制造 LLM 调用窗口（mock 架构方案 B：
// 不 mock llm.js——LTC8-12 走真实 callRenameLLM 全链路）。
vi.mock("@zhushanwen/pi-llm-shared", async (importActual) => {
	const actual = await importActual<typeof import("@zhushanwen/pi-llm-shared")>();
	return { ...actual, resolveModel: vi.fn(), callLLM: vi.fn() };
});

// mock pure.js：只 override loadRenameConfig（开关控制）；
// countSuccessfulAssistantReplies/cleanTitle 保留真实（触发判定接线由此覆盖）。
vi.mock("../pure.js", async (importActual) => {
	const actual = await importActual<typeof import("../pure.js")>();
	return { ...actual, loadRenameConfig: vi.fn() };
});

// 被测模块须在 vi.mock 之后 import（vitest 提升 vi.mock）
import { callLLM, resolveModel } from "@zhushanwen/pi-llm-shared";

import renameSessionExtension from "../index";
import { type RenameSessionConfig, loadRenameConfig } from "../pure.js";

// 每用例收尾统一还原：logger mock 恢复 + stub 的 TAIJI_AGENT_DEBUG 还原，
// 防泄漏到后续用例（debug 开关 live 读 process.env，依赖 stubEnv/unstubAllEnvs 成对）
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// ── Mock 工具 ───────────────────────────────────────

interface MockSetup {
	pi: ExtensionAPI;
	setSessionNameMock: ReturnType<typeof vi.fn>;
	/** 防覆盖检查读 pi.getSessionName()，非 ctx——默认未命名（undefined）。 */
	getSessionNameMock: ReturnType<typeof vi.fn>;
	/** usage 落账入口：index.ts 注入回调体内调 pi.appendEntry，接线断言用（时点与 catch 归属契约见 llm.ts）。 */
	appendEntryMock: ReturnType<typeof vi.fn>;
	/** registerTool mock（设计 rename-session-three-modes.md D3 agent-tool 注册面接线断言用）。 */
	registerToolMock: ReturnType<typeof vi.fn>;
	turnEndHandler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
	/** message_end handler（first-prompt 入口，设计 rename-session-three-modes.md D2）。 */
	messageEndHandler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
	/** 工厂注册的 rename_session 工具定义（registerTool 捕获）。 */
	registeredTool: unknown;
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

const ENABLED_CONFIG: RenameSessionConfig = {
	enabled: true,
	model: { type: "ref", ref: "stub/stub-model" },
	mode: "first-stop",
	maxTitleLength: 50,
	thinkingLevel: "off",
};
const DISABLED_CONFIG: RenameSessionConfig = {
	enabled: false,
	model: { type: "ref", ref: "" },
	mode: "first-stop",
	maxTitleLength: 50,
	thinkingLevel: "off",
};
const FIRST_PROMPT_CONFIG: RenameSessionConfig = { ...ENABLED_CONFIG, mode: "first-prompt" };
const AGENT_TOOL_CONFIG: RenameSessionConfig = { ...ENABLED_CONFIG, mode: "agent-tool" };

function createMockPi(): MockSetup {
	const setSessionNameMock = vi.fn();
	const getSessionNameMock = vi.fn((): string | undefined => undefined);
	const appendEntryMock = vi.fn();
	const registerToolMock = vi.fn((tool: unknown) => {
		capturedTool = tool;
	});
	let capturedTool: unknown;
	let turnEndHandler!: MockSetup["turnEndHandler"];
	let messageEndHandler!: MockSetup["messageEndHandler"];
	const pi = {
		on: vi.fn((event: string, handler: (ev: unknown, ctx: ExtensionContext) => unknown) => {
			if (event === "turn_end") turnEndHandler = handler as MockSetup["turnEndHandler"];
			else if (event === "message_end")
				messageEndHandler = handler as MockSetup["messageEndHandler"];
		}),
		registerCommand: vi.fn(),
		registerTool: registerToolMock,
		getSessionName: getSessionNameMock,
		setSessionName: setSessionNameMock,
		appendEntry: appendEntryMock,
	} as unknown as ExtensionAPI;
	return {
		pi,
		setSessionNameMock,
		getSessionNameMock,
		appendEntryMock,
		registerToolMock,
		get turnEndHandler() {
			return turnEndHandler;
		},
		get messageEndHandler() {
			return messageEndHandler;
		},
		get registeredTool() {
			return capturedTool;
		},
	};
}

interface MockCtxOptions {
	entries?: unknown[];
	sessionDir?: string;
}

function createMockCtx(opts: MockCtxOptions = {}): ExtensionContext {
	const entries = opts.entries ?? ONE_ASSISTANT;
	const sessionDir = opts.sessionDir ?? "/home/u/.pi/agent/sessions";
	return {
		sessionManager: {
			getEntries: () => entries,
			getSessionId: () => "test-session-id",
			getSessionDir: () => sessionDir,
		},
		signal: new AbortController().signal,
	} as unknown as ExtensionContext;
}

// 触发态夹具：stopReason==='stop' 的 assistant 恰 1 条 → 成功计数 1
const ONE_ASSISTANT = [
	{ type: "message", message: { role: "user", content: "帮我修复登录超时" } },
	{ type: "message", message: { role: "assistant", stopReason: "stop", content: [] } },
];

/** fire 的事件 turnIndex（handler 侧 debug 日志含 turnIndex=<n>，断言锁定该值）。 */
const FIRE_TURN_INDEX = 3;

/**
 * 触发 turn_end handler。message 默认为 stop 轮的 assistant message（触发态），
 * 跳过类用例显式传非 stop 的 message。
 */
function fire(setup: MockSetup, ctx: ExtensionContext, message?: unknown): Promise<void> {
	return setup.turnEndHandler(
		{
			type: "turn_end",
			turnIndex: FIRE_TURN_INDEX,
			message: message ?? { stopReason: "stop", content: [{ type: "text", text: "已完成修复" }] },
			toolResults: [],
		},
		ctx,
	) as Promise<void>;
}

/**
 * 触发 message_end handler（first-prompt 入口，设计 rename-session-three-modes.md D2）。message 默认为首条 user prompt
 * （text blocks 形态——探针 P1 实测 rpc 模式 user 载荷 content 为 blocks 数组）。
 */
function fireMessageEnd(setup: MockSetup, ctx: ExtensionContext, message?: unknown): Promise<void> {
	return setup.messageEndHandler(
		{
			type: "message_end",
			message: message ?? { role: "user", content: [{ type: "text", text: "帮我修复登录超时，并补上单测" }] },
		},
		ctx,
	) as Promise<void>;
}

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

/** 拼接 warn spy 的全部调用为单行文本（debug 日志断言用）。 */
function warnText(warnSpy: ReturnType<typeof vi.fn>): string {
	return warnLines(warnSpy).join("\n");
}

// ────────────────────────────────────────────────────
// renameSessionExtension 工厂 + hook 注册
// ────────────────────────────────────────────────────

describe("renameSessionExtension", () => {
	let setup: MockSetup;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(loadRenameConfig).mockReset();
		vi.mocked(resolveModel).mockReset();
		vi.mocked(callLLM).mockReset();
		// 工厂注册面在 load 时读一次 config（工具注册判定，设计 rename-session-three-modes.md D1）——工厂调用前必须有可用返回值
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		setup = createMockPi();
		renameSessionExtension(setup.pi);
	});

	it("TC13: 注册 turn_end + message_end 两个 handler（first-stop 与 first-prompt 入口），工具不注册", () => {
		expect(setup.pi.on).toHaveBeenCalledTimes(2);
		expect(setup.pi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
		expect(setup.pi.on).toHaveBeenCalledWith("message_end", expect.any(Function));
		expect(setup.turnEndHandler).toBeTypeOf("function");
		expect(setup.messageEndHandler).toBeTypeOf("function");
		// first-stop（ENABLED_CONFIG）非 agent-tool → 工具不注册（设计 rename-session-three-modes.md D1 求值时点）
		expect(setup.registerToolMock).not.toHaveBeenCalled();
	});

	it("TC14: config.enabled=false → handler 触发后不调 resolveModel/setSessionName", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(DISABLED_CONFIG);

		await fire(setup, createMockCtx());

		expect(loadRenameConfig).toHaveBeenCalled();
		expect(resolveModel).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("TC15: getEntries 抛错时 handler 不抛（catch logger.error）", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		loggerMock.error.mockClear();
		const ctx = {
			sessionManager: {
				getEntries: () => {
					throw new Error("boom");
				},
				getSessionId: () => "test-session-id",
				getSessionDir: () => "/home/u/.pi/agent/sessions",
			},
			signal: new AbortController().signal,
		} as unknown as ExtensionContext;

		await expect(fire(setup, ctx)).resolves.toBeUndefined();

		expect(loggerMock.error).toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	// ────────────────────────────────────────────────────
	// message_end 入口三模式分派（设计 rename-session-three-modes.md D1 live 读 mode / D2 first-prompt 守卫链）
	// ────────────────────────────────────────────────────

	it("TC-M1: first-prompt 模式首条 user message_end → callLLM 发起，prompt 从 event 载荷取（entries 空，finalText 空走两条降级）", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(FIRST_PROMPT_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "修复登录超时" });

		// entries 空：探针 P1 实测形态（handler 先于本条 append，getEntries() 无 user）
		await fireMessageEnd(setup, createMockCtx({ entries: [] }));
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));

		const opts = vi.mocked(callLLM).mock.calls[0][1] as {
			messages: { role: string; content: { type: string; text: string }[] }[];
		};
		// 不等回复（设计 rename-session-three-modes.md D2）：finalText 空 → 两条 [user(promptText), user(instruction)]，无 assistant 条目
		expect(opts.messages.map((m) => m.role)).toEqual(["user", "user"]);
		expect(opts.messages[0].content[0].text).toBe("帮我修复登录超时，并补上单测");
		// 落库走同一管道（防覆盖重查 → setSessionName → renamed to）
		await vi.waitFor(() => expect(setup.setSessionNameMock).toHaveBeenCalledWith("修复登录超时"));
	});

	it("TC-M2: first-prompt 模式 role=assistant 的 message_end → 不触发（role 过滤）", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(FIRST_PROMPT_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);

		await fireMessageEnd(setup, createMockCtx({ entries: [] }), {
			role: "assistant",
			content: [{ type: "text", text: "回复不该触发" }],
		});

		expect(resolveModel).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("TC-M3: first-prompt 模式 entries 已含 user（计数 ≥1，steering/第二条）→ skip: userCount=1，不触发", async () => {
		const warnSpy = debugWarnSpy();
		vi.mocked(loadRenameConfig).mockReturnValue(FIRST_PROMPT_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);

		const entries = [{ type: "message", message: { role: "user", content: "首条已入" } }];
		await fireMessageEnd(setup, createMockCtx({ entries }));

		expect(callLLM).not.toHaveBeenCalled();
		expect(warnText(warnSpy)).toContain("firstPrompt skip: userCount=1");
	});

	it("TC-M4: first-prompt 模式载荷无文本（纯 image blocks）→ skip: empty prompt，不触发", async () => {
		const warnSpy = debugWarnSpy();
		vi.mocked(loadRenameConfig).mockReturnValue(FIRST_PROMPT_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);

		await fireMessageEnd(setup, createMockCtx({ entries: [] }), {
			role: "user",
			content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
		});

		expect(callLLM).not.toHaveBeenCalled();
		expect(warnText(warnSpy)).toContain("firstPrompt skip: empty prompt");
	});

	it("TC-M5: first-stop 模式 message_end(user) → skip: mode=first-stop（本入口不负责），turn_end 才触发", async () => {
		const warnSpy = debugWarnSpy();
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);

		await fireMessageEnd(setup, createMockCtx({ entries: [] }));

		expect(callLLM).not.toHaveBeenCalled();
		expect(warnText(warnSpy)).toContain("firstPrompt skip: mode=first-stop");
	});

	it("TC-M6: agent-tool 模式 message_end(user) 与 turn_end 均不触发自动命名（事件面 live 分派，V10 A 段「切走即停」）", async () => {
		const warnSpy = debugWarnSpy();
		vi.mocked(loadRenameConfig).mockReturnValue(AGENT_TOOL_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);

		await fireMessageEnd(setup, createMockCtx({ entries: [] }));
		await fire(setup, createMockCtx());

		expect(callLLM).not.toHaveBeenCalled();
		const log = warnText(warnSpy);
		expect(log).toContain("firstPrompt skip: mode=agent-tool");
		expect(log).toContain(`turnIndex=${FIRE_TURN_INDEX} skip: mode=agent-tool`);
	});

	it("TC-M7: first-prompt 模式 subagents 路径 → isSubagentSession 早退（守卫链复用，C-ext-21 覆盖新入口）", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(FIRST_PROMPT_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);

		await fireMessageEnd(
			setup,
			createMockCtx({ entries: [], sessionDir: "/home/u/.pi/agent/subagents/--proj--/sessions" }),
		);

		expect(resolveModel).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("TC-M8: first-prompt 模式 enabled=false → 不触发（开关守卫优先于 mode）", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue({ ...FIRST_PROMPT_CONFIG, enabled: false });
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);

		await fireMessageEnd(setup, createMockCtx({ entries: [] }));

		expect(resolveModel).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("TC-M9: first-prompt 落库前防覆盖重查——LLM 窗口内已有名 → skip: name exists，不落库", async () => {
		const warnSpy = debugWarnSpy();
		vi.mocked(loadRenameConfig).mockReturnValue(FIRST_PROMPT_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		let resolveLLM!: (value: { ok: true; content: string }) => void;
		vi.mocked(callLLM).mockImplementation(
			() =>
				new Promise((res) => {
					resolveLLM = res;
				}),
		);

		await fireMessageEnd(setup, createMockCtx({ entries: [] }));
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));

		setup.getSessionNameMock.mockReturnValue("语义名不该被覆盖");
		resolveLLM({ ok: true, content: "自动标题" });
		await vi.waitFor(() => expect(warnText(warnSpy)).toContain("firstPrompt skip: name exists"));

		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
		expect(warnText(warnSpy)).not.toContain("firstPrompt renamed to");
	});

	// ────────────────────────────────────────────────────
	// turn_end 入口 mode 分派（设计 rename-session-three-modes.md D1 live 读：first-stop 以外的 mode 静默返回）
	// ────────────────────────────────────────────────────

	it("TC-M10: first-prompt 模式 turn_end（stop + count=1 触发态）→ skip: mode=first-prompt，不发起 LLM 调用", async () => {
		const warnSpy = debugWarnSpy();
		vi.mocked(loadRenameConfig).mockReturnValue(FIRST_PROMPT_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);

		await fire(setup, createMockCtx());

		expect(callLLM).not.toHaveBeenCalled();
		expect(warnText(warnSpy)).toContain(`turnIndex=${FIRE_TURN_INDEX} skip: mode=first-prompt`);
	});

	// ────────────────────────────────────────────────────
	// TC1 stopReason 快速路径（非 stop 的 turn 不触发）
	// ────────────────────────────────────────────────────

	it("TC1: 五种非 stop stopReason（toolUse/error/aborted/length/缺失）→ 不触发 rename，debug 输出 skip: stopReason=<r>", async () => {
		const warnSpy = debugWarnSpy();
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);

		// stopReason 缺失（undefined）也走快速路径——只认显式 stop，防误触发
		for (const r of ["toolUse", "error", "aborted", "length", undefined]) {
			warnSpy.mockClear();
			await fire(setup, createMockCtx(), { stopReason: r, content: [] });

			// C3 契约：[rename-session] + t=<ISO> + turnIndex=<n> + skip 文案
			const expected = `turnIndex=${FIRE_TURN_INDEX} skip: stopReason=${String(r)}`;
			expect(warnText(warnSpy)).toContain(expected);
			const line = warnLines(warnSpy).find((l) => l.includes(`skip: stopReason=${String(r)}`));
			expect(line).toMatch(/^t=\d{4}-\d{2}-\d{2}T/);
		}

		expect(resolveModel).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	// ────────────────────────────────────────────────────
	// TC2 成功计数触发判定（countSuccessfulAssistantReplies 接线）
	// ────────────────────────────────────────────────────

	it("TC2: 四组混合 entries——[user,toolUse,stop] 触发 / [user,error,stop] 触发 / 纯 error 不触发 / 2 stop 不触发", async () => {
		const warnSpy = debugWarnSpy();
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		// ok:false 即可满足断言需要（callLLM 被调 + 不落库），聚焦触发判定本身
		vi.mocked(callLLM).mockResolvedValue({ ok: false, error: "by-design" });

		const FINAL_TEXT = "最终回复：已修复登录超时";
		const stopMessage = { stopReason: "stop", content: [{ type: "text", text: FINAL_TEXT }] };

		// 组1（区分性数据）：旧判定（数全部 assistant 回复）=2 不触发 vs 新成功计数（只数 stop）=1 触发——
		// index 若仍用旧计数逻辑（不看 stopReason，忘接线 wave-1 纯函数），本组红（接线回归防护）
		const toolUseRound = [
			{ type: "message", message: { role: "user", content: "帮我修复登录超时" } },
			{ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [] } },
			{ type: "message", message: { role: "assistant", stopReason: "stop", content: [] } },
		];
		await fire(setup, createMockCtx({ entries: toolUseRound }), stopMessage);
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));

		// 第三参接线：event.message 作为 finalMessage → 其 text 进入 callLLM messages 的 assistant 条目
		const opts1 = vi.mocked(callLLM).mock.calls[0][1] as {
			messages: { role: string; content: { type: string; text: string }[] }[];
		};
		const assistantMsg = opts1.messages.find((m) => m.role === "assistant");
		expect(assistantMsg?.content[0]).toMatchObject({ type: "text", text: FINAL_TEXT });

		// 组2：error 轮后的下一成功轮（error 不计数）→ 触发
		const afterErrorRound = [
			{ type: "message", message: { role: "user", content: "继续修复" } },
			{ type: "message", message: { role: "assistant", stopReason: "error", content: [] } },
			{ type: "message", message: { role: "assistant", stopReason: "stop", content: [] } },
		];
		await fire(setup, createMockCtx({ entries: afterErrorRound }), stopMessage);
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(2));

		// 组3：纯 error 轮（stop entry 未落库的异常防御——真实时序 stop turn_end 时 count>=1 恒成立）
		// → 不触发 + skip: count=0
		const errorOnly = [
			{ type: "message", message: { role: "user", content: "继续修复" } },
			{ type: "message", message: { role: "assistant", stopReason: "error", content: [] } },
		];
		await fire(setup, createMockCtx({ entries: errorOnly }), stopMessage);

		// 组4：2 个 stop（resume 后的新 round）→ 不触发 + skip: count=2
		const twoStops = [
			{ type: "message", message: { role: "user", content: "第一轮" } },
			{ type: "message", message: { role: "assistant", stopReason: "stop", content: [] } },
			{ type: "message", message: { role: "user", content: "第二轮" } },
			{ type: "message", message: { role: "assistant", stopReason: "stop", content: [] } },
		];
		await fire(setup, createMockCtx({ entries: twoStops }), stopMessage);

		// 组3/组4 是同步 return 路径：fire resolve 即判定完成，callLLM 计数停在 2
		expect(callLLM).toHaveBeenCalledTimes(2);
		const log = warnText(warnSpy);
		expect(log).toContain(`turnIndex=${FIRE_TURN_INDEX} skip: count=0`);
		expect(log).toContain(`turnIndex=${FIRE_TURN_INDEX} skip: count=2`);
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	// ────────────────────────────────────────────────────
	// callRenameLLM 集成覆盖（fire-and-forget 时序）
	// ────────────────────────────────────────────────────

	it("LTC7: subagents 子 session 路径 → isSubagentSession 早退，不调 resolveModel/setSessionName", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);

		await fire(
			setup,
			createMockCtx({ sessionDir: "/home/u/.pi/agent/subagents/--proj--/sessions" }),
		);

		expect(resolveModel).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("LTC8: callLLM 返回 {ok:false} → callRenameLLM 返回 null，不调 setSessionName", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: false, error: "boom" });

		await fire(setup, createMockCtx());
		// handler 内 callRenameLLM 是 detached promise（fire-and-forget），等其 settle 后断言
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));

		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("LTC9: resolveModel 返回 null（model 不可用）→ 不调 callLLM/setSessionName（静默跳过）", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(null);

		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(resolveModel).toHaveBeenCalledTimes(1));

		expect(callLLM).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("LTC10: callLLM 返回 {ok:true,content} → cleanTitle 后 setSessionName 落库", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "  修复登录bug  " });

		await fire(setup, createMockCtx());
		// handler 内 callRenameLLM 是 detached promise（fire-and-forget），fire 立即 resolve；
		// 需等 detached promise settle 后再断言落库结果。
		await vi.waitFor(() => expect(setup.setSessionNameMock).toHaveBeenCalledWith("修复登录bug"));

		expect(callLLM).toHaveBeenCalledTimes(1);
	});

	it("LTC11: callLLM 返回空 content（cleanTitle 空串）→ 不调 setSessionName", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "   " });

		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));

		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("LTC12: callLLM reject → handler 不抛，setSessionName 未调用（detached catch 兜底）", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockRejectedValue(new Error("llm down"));
		loggerMock.error.mockClear();

		await expect(fire(setup, createMockCtx())).resolves.toBeUndefined();
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));

		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("LTC13: 首 turn 判定（成功 assistant 回复数 !== 1）→ 不调 resolveModel", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		// 0 个成功 assistant
		await fire(setup, createMockCtx({ entries: [{ type: "message", message: { role: "user" } }] }));
		expect(resolveModel).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	// ────────────────────────────────────────────────────
	// TC3 防覆盖：落库前重查（含 LLM 调用窗口竞态）
	// ────────────────────────────────────────────────────

	it("TC3: LLM 调用窗口内手动命名 → 落库前重查命中，不调 setSessionName（skip: name exists）", async () => {
		const warnSpy = debugWarnSpy();
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		// deferred promise 打开 LLM 调用窗口（不 mock llm.js，在 pi-llm-shared 的 callLLM 边界拦截）
		let resolveLLM!: (value: { ok: true; content: string }) => void;
		vi.mocked(callLLM).mockImplementation(
			() =>
				new Promise((res) => {
					resolveLLM = res;
				}),
		);

		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));

		// 竞态窗口内：用户手动 /name 命名（落库前重查必须看到它）
		setup.getSessionNameMock.mockReturnValue("我的手动名字");

		resolveLLM({ ok: true, content: "自动生成的标题" });
		await vi.waitFor(() => expect(warnText(warnSpy)).toContain("skip: name exists"));

		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
		// 移位契约：renamed to 在 setSessionName 之后才打——竞态命中（未落库）时该日志不出现
		expect(warnText(warnSpy)).not.toContain("renamed to");
	});

	it("TC3 对照组: getSessionName 始终 undefined → 正常落库 + renamed to 日志（setSessionName 之后、handler 侧带 turnIndex）", async () => {
		const warnSpy = debugWarnSpy();
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "自动生成的标题" });

		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(setup.setSessionNameMock).toHaveBeenCalledWith("自动生成的标题"));

		const renamedIdx = warnLines(warnSpy).findIndex((l) => l.includes('renamed to "自动生成的标题"'));
		expect(renamedIdx).toBeGreaterThanOrEqual(0);
		// handler 侧日志契约（C3）：t=<ISO> + turnIndex=<n> + renamed to "<title>"（[rename-session] 前缀由共享 logger 自动补）
		expect(String(warnSpy.mock.calls[renamedIdx][0])).toMatch(
			new RegExp(`^t=\\d{4}-\\d{2}-\\d{2}T.* turnIndex=${FIRE_TURN_INDEX} renamed to "自动生成的标题"$`),
		);
		// 移位契约（时序）：日志调用序晚于 setSessionName——先落库后报捷
		expect(warnSpy.mock.invocationCallOrder[renamedIdx]).toBeGreaterThan(
			setup.setSessionNameMock.mock.invocationCallOrder[0],
		);
	});

	// ────────────────────────────────────────────────────
	// TC9 debug 关闭态零输出（默认生产环境零噪音）
	// ────────────────────────────────────────────────────

	it("TC9: TAIJI_AGENT_DEBUG 未设 → 全流程 7 条 debug 契约文案零输出（既有 A1 日志除外）", async () => {
		// 显式清除（防宿主环境泄漏 TAIJI_AGENT_DEBUG 影响判定）
		vi.stubEnv("TAIJI_AGENT_DEBUG", undefined);
		loggerMock.warn.mockClear();
		const warnSpy = loggerMock.warn;
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);

		// 组1：有内容 → 全流程落库
		vi.mocked(callLLM).mockResolvedValueOnce({ ok: true, content: "标题一" });
		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(setup.setSessionNameMock).toHaveBeenCalledWith("标题一"));

		// 组2：空内容 → cleanTitle 空 → 返回 null 不落库
		vi.mocked(callLLM).mockResolvedValueOnce({ ok: true, content: "   " });
		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(2));
		// flush 微任务链（detached promise 的 .then 收尾）后再断言日志终态
		await new Promise((r) => setTimeout(r, 0));

		// 7 条 debug 契约文案（C3）逐条确认零输出
		const debugLiterals = [
			"skip: stopReason=",
			"skip: count=",
			"skip: no user prompt",
			"skip: name exists",
			"skip: title empty",
			"renamed to",
			"LLM request messages:",
		];
		for (const lit of debugLiterals) {
			expect(warnText(warnSpy)).not.toContain(lit);
		}
		// 「零调用」的精确口径：剔除既有 A1 日志（model not available / call failed，
		// 非本轮 debug 契约、本用例数据 ok:true 不触发这两类）后，其余 warn 调用必须为 0。
		// 成功路径的 rename with model 已改为 debug-only，debug 关闭时同样不得出现。
		const nonA1Calls = warnLines(warnSpy).filter(
			(l) =>
				!l.includes("model not available") &&
				!l.includes("rename LLM call failed"),
		);
		expect(nonA1Calls).toHaveLength(0);
	});
});

// ────────────────────────────────────────────────────
// usage 落账接线（appendUsageEntry 回调注入；时点与 catch 归属契约见 llm.ts）
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

describe("usage 落账接线（appendUsageEntry 回调注入）", () => {
	let setup: MockSetup;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(loadRenameConfig).mockReset();
		vi.mocked(resolveModel).mockReset();
		vi.mocked(callLLM).mockReset();
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		setup = createMockPi();
		renameSessionExtension(setup.pi);
	});

	it("接线：callLLM ok:true + usage → pi.appendEntry 恰被调一次 ('rename-session', {model, usage})，且先于 setSessionName（标题照常落库）", async () => {
		vi.mocked(callLLM).mockResolvedValue({
			ok: true,
			content: "自动生成的标题",
			usage: STUB_USAGE,
		});

		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(setup.setSessionNameMock).toHaveBeenCalledWith("自动生成的标题"));

		expect(setup.appendEntryMock).toHaveBeenCalledTimes(1);
		expect(setup.appendEntryMock).toHaveBeenCalledWith("rename-session", {
			model: "stub/stub-model",
			usage: STUB_USAGE,
		});
		// 时序：appendEntry 在 callRenameLLM 内（cleanTitle 前）触发，setSessionName 在其后 .then——落账先于落库
		expect(setup.appendEntryMock.mock.invocationCallOrder[0]).toBeLessThan(
			setup.setSessionNameMock.mock.invocationCallOrder[0],
		);
	});

	it("catch 在回调体内：pi.appendEntry 抛错（session 已切换等）→ logger.error 且后续流程照常（标题照常落库）", async () => {
		vi.mocked(callLLM).mockResolvedValue({
			ok: true,
			content: "自动生成的标题",
			usage: STUB_USAGE,
		});
		setup.appendEntryMock.mockImplementation(() => {
			throw new Error("session switched");
		});

		await fire(setup, createMockCtx());
		// 「标题照常落库」：appendEntry 抛错被回调体内 catch，detached 链继续走 cleanTitle → setSessionName
		await vi.waitFor(() => expect(setup.setSessionNameMock).toHaveBeenCalledWith("自动生成的标题"));

		expect(loggerMock.error).toHaveBeenCalledWith("failed to append usage entry", {
			error: "Error: session switched",
		});
		// 外层 .catch（rename LLM failed）不应被触发——错误在回调体内已被吞掉
		const outerCatchCalls = loggerMock.error.mock.calls.filter((c) =>
			String(c[0]).includes("rename LLM failed"),
		);
		expect(outerCatchCalls).toHaveLength(0);
	});

	it("usage 缺失 → appendEntry 不被调（存在性守卫），标题照常落库", async () => {
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "自动生成的标题" });

		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(setup.setSessionNameMock).toHaveBeenCalledWith("自动生成的标题"));

		expect(setup.appendEntryMock).not.toHaveBeenCalled();
	});
});

// ────────────────────────────────────────────────────
// rename_session 工具注册与 execute 守卫（设计 rename-session-three-modes.md D1 求值时点 / D3 agent-tool 模式）
// ────────────────────────────────────────────────────

/** 注册到的工具定义形态（registerTool 捕获后测试侧调用 execute 用）。 */
interface RegisteredRenameTool {
	name: string;
	parameters: object;
	execute: (
		toolCallId: string,
		params: { title: string },
		signal: undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<unknown>;
}

describe("rename_session 工具注册与 execute 守卫（D3）", () => {
	let setup: MockSetup;

	/** 显式设置 load 时 mode 后重建工厂（注册面只在 load 求值一次，设计 rename-session-three-modes.md D1）。 */
	function setupWithMode(config: RenameSessionConfig): void {
		vi.mocked(loadRenameConfig).mockReset();
		vi.mocked(loadRenameConfig).mockReturnValue(config);
		setup = createMockPi();
		renameSessionExtension(setup.pi);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(loadRenameConfig).mockReset();
		vi.mocked(resolveModel).mockReset();
		vi.mocked(callLLM).mockReset();
	});

	it("TC-T1: load 时 mode=agent-tool → registerTool 被调一次，name=rename_session，参数 schema 含 title", () => {
		setupWithMode(AGENT_TOOL_CONFIG);

		expect(setup.registerToolMock).toHaveBeenCalledTimes(1);
		const tool = setup.registeredTool as RegisteredRenameTool;
		expect(tool.name).toBe("rename_session");
		expect(tool.parameters).toHaveProperty("properties.title");
	});

	it("TC-T2: load 时 mode=first-prompt → 工具不注册（三值互斥，工具面 load 求值）", () => {
		setupWithMode(FIRST_PROMPT_CONFIG);
		expect(setup.registerToolMock).not.toHaveBeenCalled();
	});

	it("TC-T3: load 时 mode=first-stop → 工具不注册", () => {
		setupWithMode(ENABLED_CONFIG);
		expect(setup.registerToolMock).not.toHaveBeenCalled();
	});

	it("TC-T4: execute 时 live mode 非 agent-tool（load 是 agent-tool、运行中切走）→ isError（经 throw，pi 0.84.4 实装契约），文案含恢复动作指引", async () => {
		setupWithMode(AGENT_TOOL_CONFIG); // load 时注册
		const tool = setup.registeredTool as RegisteredRenameTool;

		// 运行中 GUI 切到 first-stop（live 读 config，残留工具被守卫兜底——V10 B 段）
		vi.mocked(loadRenameConfig).mockReturnValue(FIRST_PROMPT_CONFIG);

		await expect(
			tool.execute("call-1", { title: "新标题" }, undefined, undefined, createMockCtx()),
		).rejects.toThrow(/切回 agent-tool/);
		await expect(
			tool.execute("call-1", { title: "新标题" }, undefined, undefined, createMockCtx()),
		).rejects.toThrow(/\/name/);
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("TC-T5: execute 时 mode=agent-tool + title 清洗后非空 → 直接 setSessionName（cleanTitle 生效）", async () => {
		setupWithMode(AGENT_TOOL_CONFIG);
		const tool = setup.registeredTool as RegisteredRenameTool;

		await tool.execute("call-1", { title: "  **重构配置加载**  " }, undefined, undefined, createMockCtx());

		expect(setup.setSessionNameMock).toHaveBeenCalledWith("重构配置加载");
	});

	it("TC-T6: execute 时 title 清洗后为空（纯标点）→ isError（throw），不落库", async () => {
		setupWithMode(AGENT_TOOL_CONFIG);
		const tool = setup.registeredTool as RegisteredRenameTool;

		await expect(
			tool.execute("call-1", { title: "。。。" }, undefined, undefined, createMockCtx()),
		).rejects.toThrow();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("TC-T7: agent 显式改名允许覆盖既有名（不走 getSessionName 防覆盖守卫——语义等同 GUI 手动 rename，D3）", async () => {
		setupWithMode(AGENT_TOOL_CONFIG);
		const tool = setup.registeredTool as RegisteredRenameTool;
		// 既有自动名/语义名
		setup.getSessionNameMock.mockReturnValue("自动生成的旧标题");

		await tool.execute("call-1", { title: "agent 的新名字" }, undefined, undefined, createMockCtx());

		expect(setup.setSessionNameMock).toHaveBeenCalledWith("agent 的新名字");
	});

	it("TC-T8: execute 时 subagent session 路径 → isError（throw 守卫，D7 三入口闭环 / C-ext-21）且不调 setSessionName；正常 session 路径不受影响", async () => {
		setupWithMode(AGENT_TOOL_CONFIG);
		const tool = setup.registeredTool as RegisteredRenameTool;

		// subagent 路径：throw 且不落库（文案只说结论与指引，不暴露 subagents 目录路径细节）
		await expect(
			tool.execute(
				"call-1",
				{ title: "子会话标题" },
				undefined,
				undefined,
				createMockCtx({ sessionDir: "/home/u/.pi/agent/subagents/--proj--/sessions" }),
			),
		).rejects.toThrow(/subagent.*不支持重命名/);
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();

		// 对照：正常 session 路径（默认 sessionDir 不含 subagents 段）同一工具照常落库
		await tool.execute("call-2", { title: "正常标题" }, undefined, undefined, createMockCtx());
		expect(setup.setSessionNameMock).toHaveBeenCalledWith("正常标题");
	});
});

// ────────────────────────────────────────────────────
// first-prompt 在途去重（设计 rename-session-three-modes.md D2：工厂闭包级——pi extensionCache 缓存 factory，
// 每次 session 创建重执行工厂，闭包变量 = per-session 生命周期）
// ────────────────────────────────────────────────────

describe("first-prompt in-flight 去重（工厂闭包级）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(loadRenameConfig).mockReset();
		vi.mocked(resolveModel).mockReset();
		vi.mocked(callLLM).mockReset();
		vi.mocked(loadRenameConfig).mockReturnValue(FIRST_PROMPT_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
	});

	it("TC-I1: LLM 调用窗口内同 session 第二条 message_end 被拦（callLLM 恒 1 次），settle 后标志释放（再触发可发起）", async () => {
		const setup = createMockPi();
		renameSessionExtension(setup.pi);
		// entries 恒空：模拟「首条 user 尚未 append」的极端交错窗口（首条判定不拦，靠 in-flight）
		const ctx = createMockCtx({ entries: [] });
		let resolveLLM!: (value: { ok: true; content: string }) => void;
		vi.mocked(callLLM).mockImplementation(
			() =>
				new Promise((res) => {
					resolveLLM = res;
				}),
		);

		await fireMessageEnd(setup, ctx);
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));

		// in-flight 窗口内第二条：被标志拦截，不二次发起
		await fireMessageEnd(setup, ctx);
		await new Promise((r) => setTimeout(r, 0)); // flush 微任务链
		expect(callLLM).toHaveBeenCalledTimes(1);

		// settle → finally 释放标志 → 再到达的 message_end 可再次发起（真实时序下会被
		// userCount ≥1 拦截，此处 entries 恒空以孤立验证释放逻辑本身）
		resolveLLM({ ok: true, content: "标题一" });
		await vi.waitFor(() => expect(setup.setSessionNameMock).toHaveBeenCalledWith("标题一"));
		await fireMessageEnd(setup, ctx);
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(2));
	});

	it("TC-I2: 工厂闭包级（非模块级）——同进程第二个 session（工厂重执行）的 in-flight 独立，不被第一个 session 吞掉命名机会", async () => {
		const setupA = createMockPi();
		renameSessionExtension(setupA.pi);
		const setupB = createMockPi();
		renameSessionExtension(setupB.pi);

		let resolveA!: (value: { ok: true; content: string }) => void;
		let resolveB!: (value: { ok: true; content: string }) => void;
		let callCount = 0;
		vi.mocked(callLLM).mockImplementation(() => {
			callCount++;
			return new Promise((res) => {
				if (callCount === 1) resolveA = res;
				else resolveB = res;
			});
		});

		// session A 触发并停在其 LLM 窗口内（A 的 in-flight=true）
		await fireMessageEnd(setupA, createMockCtx({ entries: [] }));
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));

		// session B（/fork、/session 切换后工厂重执行）同窗口触发：B 的闭包标志独立 → 照常发起
		await fireMessageEnd(setupB, createMockCtx({ entries: [] }));
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(2));

		resolveA({ ok: true, content: "A 的标题" });
		resolveB({ ok: true, content: "B 的标题" });
		await vi.waitFor(() => expect(setupA.setSessionNameMock).toHaveBeenCalledWith("A 的标题"));
		await vi.waitFor(() => expect(setupB.setSessionNameMock).toHaveBeenCalledWith("B 的标题"));
	});
});
