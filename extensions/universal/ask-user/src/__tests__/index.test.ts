// src/__tests__/index.test.ts
// Tests the factory + execute orchestration (FR-1/7/8/9/10/13) with mocked ctx/pi.
import { describe, expect, it } from "vitest";

import factory from "../index";
import { mockTui, stubTheme } from "./fixtures";

// ── Types for the registered tool ───────────────────────
type TestMode = "tui" | "rpc" | "json" | "print";

interface RegisteredTool {
	name: string;
	label: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: {
			mode: TestMode;
			hasUI: boolean;
			signal?: AbortSignal;
			ui: {
				custom<T = void>(
					factory: (...args: unknown[]) => unknown,
					options?: { overlay?: boolean },
				): Promise<T>;
				select?: (
					title: string,
					options: string[],
					opts?: { signal?: AbortSignal },
				) => Promise<string | undefined>;
			};
		},
	) => Promise<Record<string, unknown>>;
	renderCall: (args: Record<string, unknown>, theme: unknown) => unknown;
	renderResult: (result: { details: unknown }, options: { expanded: boolean }, theme: unknown) => unknown;
}

interface MockPi {
	tool?: RegisteredTool;
	registerTool(tool: RegisteredTool): void;
	getAllTools(): { name: string }[];
	activeTools?: string[] | null;
	setActiveTools(names: string[]): void;
	// session_start handler：factory 注册 ask_user channel handler 时调用（透传功能）。
	// 测试不验证透传，提供空 on 让 factory 不抛错。
	on(event: string, handler: (...args: unknown[]) => unknown): void;
}

/** Runs the factory, returns the captured registered tool. */
const getTool = (overrides: Partial<MockPi> = {}): RegisteredTool => {
	const pi: MockPi = {
		registerTool(tool) {
			this.tool = tool;
		},
		getAllTools() {
			return [{ name: "ask_user" }, { name: "other_tool" }];
		},
		setActiveTools(names) {
			this.activeTools = names;
		},
		on() {
			// no-op：session_start handler 注册透传 channel（subagent-workflow 可选），
			// 测试不覆盖透传路径
		},
		...overrides,
	};
	factory(pi as never);
	if (!pi.tool) throw new Error("factory did not register a tool");
	return pi.tool;
};

// 真 headless ctx：mode='print'（无 dialog 能力，hasUI=false），ui 上无 select。
// isGuiCapable(ctx)=false（mode≠'rpc'）→ 不走 RPC 分支 → custom 也不可用 → catch 走禁用。
const makeHeadlessCtx = () => ({
	mode: "print" as const,
	hasUI: false,
	signal: undefined as AbortSignal | undefined,
	ui: {},
});

// ── Mock ctx builder ────────────────────────────────────
// mode 区分三场景：'tui'（默认，走 custom）/ 'rpc'（走 select）/ 'print'（headless）。
// Pi 的 hasUI：TUI 和 RPC 都为 true（dialog-capable），print/json 为 false。
// RPC 模式才挂 select（与真实 Pi 一致：TUI 模式的 ctx.ui 不一定有 select）。
const makeCtx = (
	overrides: Partial<{
		mode: TestMode;
		customResult: unknown;
		customThrows: Error | null;
		selectResult: string | undefined;
		selectThrows: Error | null;
	}> = {},
) => {
	const {
		mode = "tui",
		customResult = null,
		customThrows = null,
		selectResult = undefined,
		selectThrows = null,
	} = overrides;
	const hasUI = mode === "tui" || mode === "rpc";
	// RPC 模式才挂 select（与真实 Pi 一致：TUI 模式的 ctx.ui 不一定有 select）
	const hasSelect = mode === "rpc";
	return {
		mode,
		hasUI,
		signal: undefined as AbortSignal | undefined,
		ui: {
			custom: async <T = void>(..._args: unknown[]): Promise<T> => {
				if (customThrows) throw customThrows;
				return customResult as T;
			},
			...(hasSelect
				? {
						select: async (
							_title: string,
							_options: string[],
							_opts?: { signal?: AbortSignal },
						): Promise<string | undefined> => {
							if (selectThrows) throw selectThrows;
							return selectResult;
						},
					}
				: {}),
		},
	};
};

const validSingle = {
	questions: [
		{
			question: "Which DB?",
			options: [{ label: "Postgres" }, { label: "SQLite" }],
		},
	],
};

// ── I-1 ~ I-4: 参数校验（AC-8/13）──────────────────────
// W4：错误路径 throw（pi 只对 execute throw 置 isError:true，返回值 isError 被丢弃）
describe("execute — validation (FR-2 / AC-8 / AC-13)", () => {
	it("I-1: duplicate question → throw", async () => {
		const tool = getTool();
		await expect(
			tool.execute(
				"id",
				{
					questions: [
						{ question: "Same", options: [{ label: "A" }, { label: "B" }] },
						{ question: "Same", options: [{ label: "C" }, { label: "D" }] },
					],
				},
				undefined,
				undefined,
				makeCtx(),
			),
		).rejects.toThrow("Duplicate");
	});

	it("I-2: duplicate option label → throw", async () => {
		const tool = getTool();
		await expect(
			tool.execute(
				"id",
				{
					questions: [
						{ question: "Q", options: [{ label: "A" }, { label: "A" }] },
					],
				},
				undefined,
				undefined,
				makeCtx(),
			),
		).rejects.toThrow("Duplicate option");
	});

	it("I-3: multi-question missing header → throw", async () => {
		const tool = getTool();
		await expect(
			tool.execute(
				"id",
				{
					questions: [
						{ question: "Q1", header: "H1", options: [{ label: "A" }, { label: "B" }] },
						{ question: "Q2", options: [{ label: "C" }, { label: "D" }] },
					],
				},
				undefined,
				undefined,
				makeCtx(),
			),
		).rejects.toThrow("header");
	});

	it("I-4b: string options (schema-relaxed) → execute → validateInput catches → throw + Correct hint", async () => {
		// 端到端证明：schema 放宽（Union([OptionSchema, string])）后 string options
		// 能穿过 TypeCompiler.Check、抵达 execute → validateInput 友好拦截（W4 后以 throw
		// 表达，pi catch 后文案进 toolResult content）。
		// test-coverage reviewer 点名的“execute wiring 未测”缺口。
		const tool = getTool();
		await expect(
			tool.execute(
				"id",
				{ questions: [{ question: "Q", options: ["A", "B"] }] },
				undefined,
				undefined,
				makeCtx(),
			),
		).rejects.toThrow(/not strings[\s\S]*Correct/);
	});
});

// ── I-5 ~ I-7: Headless（FR-8 / AC-7）──────────────────
// 真 headless：hasUI=false 且 ui 上无 select（print 模式）→ 禁用工具 + throw（W4）。
describe("execute — headless (FR-8 / AC-7)", () => {
	it("I-5: headless (no select) → throw with disabled message", async () => {
		const tool = getTool();
		await expect(
			tool.execute("id", validSingle, undefined, undefined, makeHeadlessCtx()),
		).rejects.toThrow(/disabled/);
	});

	it("I-6: headless disables ask_user tool via setActiveTools (收尾先于 throw)", async () => {
		let captured: string[] | null = null;
		const tool2 = getTool({
			getAllTools: () => [{ name: "ask_user" }, { name: "other" }],
			setActiveTools: (names: string[]) => {
				captured = names;
			},
		});
		await expect(
			tool2.execute("id", validSingle, undefined, undefined, makeHeadlessCtx()),
		).rejects.toThrow();
		expect(captured).not.toContain("ask_user");
		expect(captured).toContain("other");
	});
});

// ── I-8 ~ I-9: Signal abort（FR-10 / AC-14）────────────
describe("execute — signal abort (FR-10 / AC-14)", () => {
	it("I-8: pre-aborted signal → returns cancelled immediately", async () => {
		const tool = getTool();
		const controller = new AbortController();
		controller.abort();
		const ctx = makeCtx();
		ctx.signal = controller.signal;
		const result = await tool.execute("id", validSingle, controller.signal, undefined, ctx);
		// step3 是 agent abort（goal 取消/compact/session 切换），文案应明确告知 abort，
		// 区别于 step5 的用户取消（A5）
		expect(result.content[0].text).toContain("abort");
		expect(result.details.cancelled).toBe(true);
	});

	it("I-9: abort during custom → factory registers listener → done(null) → cancelled", async () => {
		const tool = getTool();
		const controller = new AbortController();
		// 真正调用 factory，使源码中的 signal.addEventListener("abort", () => done(null)) 被注册。
		// 此前 mock 直接返回 customResult、从不调用 factory，该 abort 监听器是 dead path。
		// 现在中断后监听器调用 done(null)，custom 解析为 null → cancelled。
		const ctx = {
			mode: "tui" as const,
			hasUI: true,
			signal: controller.signal,
			ui: {
				custom: <T = void>(factory: (...args: unknown[]) => unknown): Promise<T> =>
					new Promise((resolve) => {
						const done = (r: T): void => resolve(r);
						factory(mockTui, stubTheme, {}, done);
						setTimeout(() => controller.abort(), 0);
					}),
			},
		};
		const result = await tool.execute("id", validSingle, controller.signal, undefined, ctx);
		expect(result.details.cancelled).toBe(true);
	});
});

// ── I-10 ~ I-11: 错误兜底（FR-13 / AC-15）─────────────
// W4：错误路径 throw（原 return {isError, details.error} 的 details 在 pi catch 后
// 不再产出——pi createErrorToolResult 只保留 content）
describe("execute — error fallback (FR-13 / AC-15)", () => {
	it("I-10: ui.custom throws → throw with 'ask_user failed'", async () => {
		const tool = getTool();
		await expect(
			tool.execute(
				"id",
				validSingle,
				undefined,
				undefined,
				makeCtx({ customThrows: new Error("boom") }),
			),
		).rejects.toThrow(/ask_user failed[\s\S]*boom/);
	});
});

// ── I-12 ~ I-15: 正常返回与取消（FR-7）─────────────────
describe("execute — result handling (FR-7)", () => {
	it("I-12: normal result returns answer summary", async () => {
		const tool = getTool();
		const fakeResult = {
			questions: [{ question: "Which DB?", options: [{ label: "Postgres" }] }],
			answers: { "Which DB?": { selected: ["Postgres"], other: null } },
			cancelled: false,
		};
		const result = await tool.execute(
			"id",
			validSingle,
			undefined,
			undefined,
			makeCtx({ customResult: fakeResult }),
		);
		expect(result.content[0].text).toContain("Postgres");
		expect(result.details.cancelled).toBe(false);
	});

	it("I-13: details passes through questions + answers", async () => {
		const tool = getTool();
		const fakeResult = {
			questions: [{ question: "Which DB?", options: [{ label: "Postgres" }] }],
			answers: { "Which DB?": { selected: ["Postgres"], other: null } },
			cancelled: false,
		};
		const result = await tool.execute(
			"id",
			validSingle,
			undefined,
			undefined,
			makeCtx({ customResult: fakeResult }),
		);
		expect(result.details.questions).toEqual(fakeResult.questions);
		expect(result.details.answers["Which DB?"]).toEqual({ selected: ["Postgres"], other: null });
	});

	it("I-14: cancelled (null) → 'User cancelled'", async () => {
		const tool = getTool();
		const result = await tool.execute(
			"id",
			validSingle,
			undefined,
			undefined,
			makeCtx({ customResult: null }),
		);
		expect(result.content[0].text).toContain("User cancelled");
		// P1-2: cancel message must guide the LLM not to assume an answer
		expect(result.content[0].text).toContain("Do not assume");
		expect(result.details.cancelled).toBe(true);
	});

	it("I-15: result.cancelled=true treated as cancel", async () => {
		const tool = getTool();
		const fakeResult = {
			questions: [],
			answers: {},
			cancelled: true,
		};
		const result = await tool.execute(
			"id",
			validSingle,
			undefined,
			undefined,
			makeCtx({ customResult: fakeResult }),
		);
		expect(result.content[0].text).toContain("User cancelled");
		expect(result.content[0].text).toContain("Do not assume");
		expect(result.details.cancelled).toBe(true);
	});
});

// ── I-16 ~ I-19: renderCall / renderResult（FR-9）──────

/** 渲染一个 Component 节点到连接后的纯文本（剥除 stubTheme passthrough 后即原始字符串）。 */
const renderText = (node: { render(width: number): string[] }, width = 80): string =>
	node.render(width).join("\n");

describe("renderCall / renderResult (FR-9)", () => {
	it("I-16: renderCall shows tool name + header topics", () => {
		const tool = getTool();
		const node = tool.renderCall(
			{ questions: [{ question: "Q", header: "MyHeader", options: [] }] },
			stubTheme,
		) as unknown as { render(width: number): string[] };
		const text = renderText(node);
		expect(text).toContain("ask_user");
		expect(text).toContain("MyHeader");
	});

	it("I-16b: renderCall falls back to truncated question when no header", () => {
		const tool = getTool();
		const node = tool.renderCall(
			{ questions: [{ question: "This is a very long question text", options: [] }] },
			stubTheme,
		) as unknown as { render(width: number): string[] };
		// 无 header → 用 truncateToWidth(question, 12)：按显示宽度截断（带省略号），
		// 不再按 UTF-16 slice，emoji 代理对安全。
		const text = renderText(node);
		expect(text).toContain("ask_user");
		expect(text).not.toContain("This is a very long question text");
	});

	it("I-16c: renderCall tolerates missing questions (?? [] defensive branch)", () => {
		// S-10: args.questions 缺失时 ?? [] 兜底，不崩溃、渲染工具名（topics 为空）
		const tool = getTool();
		const node = tool.renderCall({} as never, stubTheme) as unknown as {
			render(width: number): string[];
		};
		expect(renderText(node)).toContain("ask_user");
	});

	it("I-17: renderResult with answers lists ✓ <header>: <answer>", () => {
		const tool = getTool();
		const node = tool.renderResult(
			{
				details: {
					questions: [{ question: "Q", header: "H", options: [{ label: "A" }] }],
					answers: { Q: { selected: ["A"], other: null } },
					cancelled: false,
				},
			},
			{ expanded: false },
			stubTheme,
		) as unknown as { render(width: number): string[] };
		const text = renderText(node);
		expect(text).toContain("✓");
		expect(text).toContain("H:");
		expect(text).toContain("A");
	});

	it("I-17b: renderResult shows (no answer) when question unanswered in details", () => {
		const tool = getTool();
		const node = tool.renderResult(
			{
				details: {
					questions: [{ question: "Q", header: "H", options: [{ label: "A" }] }],
					answers: {},
					cancelled: false,
				},
			},
			{ expanded: false },
			stubTheme,
		) as unknown as { render(width: number): string[] };
		expect(renderText(node)).toContain("(no answer)");
	});

	it("I-18: renderResult cancelled shows Cancelled", () => {
		const tool = getTool();
		const node = tool.renderResult(
			{ details: { questions: [], answers: {}, cancelled: true } },
			{ expanded: false },
			stubTheme,
		) as unknown as { render(width: number): string[] };
		expect(renderText(node)).toContain("Cancelled");
	});

	// （I-19 已随 ErrorDetails 死类型删除：错误路径全部 throw（W4），pi 置 isError 后
	// details 为空对象，renderResult 不存在 {error} details 分支可渲染）

	// S-3: options.expanded 展开 —— 显示全部选项 + ●/○ 选中标记（spec FR-9）
	it("I-20: renderResult expanded shows all options with ●/○ marks", () => {
		const tool = getTool();
		const node = tool.renderResult(
			{
				details: {
					questions: [
						{
							question: "Which DB?",
							header: "DB",
							options: [{ label: "Postgres" }, { label: "SQLite" }],
						},
					],
					answers: { "Which DB?": { selected: ["Postgres"], other: null } },
					cancelled: false,
				},
			},
			{ expanded: true },
			stubTheme,
		) as unknown as { render(width: number): string[] };
		const text = renderText(node);
		// 两个选项都展开显示
		expect(text).toContain("Postgres");
		expect(text).toContain("SQLite");
		// 选中的 Postgres 用 ●，未选的 SQLite 用 ○
		expect(text).toContain("●");
		expect(text).toContain("○");
	});
});

// ── FR-1: tool registration shape ───────────────────────
describe("factory registration (FR-1)", () => {
	it("registers tool named 'ask_user' with full metadata", () => {
		const tool = getTool();
		expect(tool.name).toBe("ask_user");
		expect(tool.label).toBe("Ask User");
		expect(tool.description).toBeTruthy();
		expect(tool.parameters).toBeTruthy();
		expect(typeof tool.execute).toBe("function");
		expect(typeof tool.renderCall).toBe("function");
		expect(typeof tool.renderResult).toBe("function");
	});
});

// ── FR-3: inline 渲染（不传 overlay）───────────────────────
describe("execute — inline render (FR-3)", () => {
	it("I-FR3: ui.custom called WITHOUT overlay options (inline, not modal)", async () => {
		const tool = getTool();
		let customArgCount = -1;
		const ctx = {
			mode: "tui" as const,
			hasUI: true,
			signal: undefined as AbortSignal | undefined,
			ui: {
				custom: async (...args: unknown[]): Promise<null> => {
					customArgCount = args.length;
					return null; // cancelled — simplest resolve
				},
			},
		};
		await tool.execute("id", validSingle, undefined, undefined, ctx);
		// FR-3: execute 调用 ui.custom 只传 factory（1 个参数），不传 overlay options
		expect(customArgCount).toBe(1);
	});
});

// ── RPC 模式（taiji GUI 富交互协议）──────────────────
// mode='rpc' + ui.select 存在 → 走 uiFormInteract（统一表单协议：select 通道 +
// UI_FORM_MARKER，问题经 form-adapter 转 FormQuestion choice 形态）。
// select 的返回值是前端 FormOverlay JSON.stringify 的 FormAnswers（choice 部分与旧
// AskUserAnswers 逐字兼容），index.ts 做格式转换。
describe("execute — RPC mode (uiFormInteract via select channel)", () => {
	it("R-1: single-select answer → converted to Result.answers (key=question)", async () => {
		const tool = getTool();
		// 协议 answers：key=header（单问题无 header → question 全文），value=选中 label
		const protoAnswers = JSON.stringify({ "Which DB?": "Postgres" });
		const result = await tool.execute(
			"id",
			validSingle,
			undefined,
			undefined,
			makeCtx({ mode: "rpc", selectResult: protoAnswers }),
		);
		expect(result.details.cancelled).toBe(false);
		expect(result.details.answers["Which DB?"]).toEqual({ selected: ["Postgres"], other: null });
		expect(result.content[0].text).toContain("Postgres");
	});

	it("R-2: multi-select answer (JSON array) → AnswerValue.selected", async () => {
		const tool = getTool();
		const multi = {
			questions: [
				{
					question: "Which tools?",
					header: "Tools",
					options: [{ label: "A" }, { label: "B" }, { label: "C" }],
					multiSelect: true,
				},
			],
		};
		// 协议多选：value = JSON.stringify(["A","C"])
		const protoAnswers = JSON.stringify({ Tools: JSON.stringify(["A", "C"]) });
		const result = await tool.execute(
			"id",
			multi,
			undefined,
			undefined,
			makeCtx({ mode: "rpc", selectResult: protoAnswers }),
		);
		expect(result.details.answers["Which tools?"]).toEqual({ selected: ["A", "C"], other: null });
	});

	it("R-2b: multi-select 乱序回传 → 按 options 定义顺序排序（S#3）", async () => {
		const tool = getTool();
		const multi = {
			questions: [
				{
					question: "Which tools?",
					header: "Tools",
					options: [{ label: "A" }, { label: "B" }, { label: "C" }],
					multiSelect: true,
				},
			],
		};
		// 前端回传顺序 ["C", "A"] —— 应按 options 索引重排为 "A, C"
		const protoAnswers = JSON.stringify({ Tools: JSON.stringify(["C", "A"]) });
		const result = await tool.execute(
			"id",
			multi,
			undefined,
			undefined,
			makeCtx({ mode: "rpc", selectResult: protoAnswers }),
		);
		expect(result.details.answers["Which tools?"]).toEqual({ selected: ["A", "C"], other: null });
	});

	// R-3 用例名（TC-03）：旧措辞（parseAnswerParts 时代的拼接语义）残留，
	// 断言已结构化（{selected, other} 分离），更名为实际契约：AnswerValue.other 独立字段。
	it("R-3: Other free text → AnswerValue.other 独立字段", async () => {
		const tool = getTool();
		// 单选 Postgres + Other "Custom DB"
		const protoAnswers = JSON.stringify({
			"Which DB?": "Postgres",
			"Which DB?__other": "Custom DB",
		});
		const result = await tool.execute(
			"id",
			validSingle,
			undefined,
			undefined,
			makeCtx({ mode: "rpc", selectResult: protoAnswers }),
		);
		// 结构化：selected + other 分离
		expect(result.details.answers["Which DB?"]).toEqual({ selected: ["Postgres"], other: "Custom DB" });
	});

	it("R-3b: other-only answer (no main key) → AnswerValue {selected:[], other}", async () => {
		const tool = getTool();
		// 修复后前端无选项自由文本问题只写 `${key}__other`（与 encodeAnswer 契约一致），
		// 不写主 key——解码必须得 {selected:[], other}，不得产生 selected 双持有。
		const protoAnswers = JSON.stringify({
			"Which DB?__other": "Custom DB",
		});
		const result = await tool.execute(
			"id",
			validSingle,
			undefined,
			undefined,
			makeCtx({ mode: "rpc", selectResult: protoAnswers }),
		);
		expect(result.details.answers["Which DB?"]).toEqual({ selected: [], other: "Custom DB" });
	});

	it("R-5: user cancel (select returns undefined) → cancelled details", async () => {
		const tool = getTool();
		const result = await tool.execute(
			"id",
			validSingle,
			undefined,
			undefined,
			makeCtx({ mode: "rpc", selectResult: undefined }),
		);
		expect(result.content[0].text).toContain("User cancelled");
		expect(result.details.cancelled).toBe(true);
	});

	it("R-6: select throws → throw + disabled message (not retriable; W4)", async () => {
		const tool = getTool();
		await expect(
			tool.execute(
				"id",
				validSingle,
				undefined,
				undefined,
				makeCtx({ mode: "rpc", selectThrows: new Error("channel broken") }),
			),
		).rejects.toThrow(/channel broken[\s\S]*disabled/);
	});

	it("R-7: header used as answers key when provided", async () => {
		const tool = getTool();
		const multiQ = {
			questions: [
				{
					question: "Which database?",
					header: "DB",
					options: [{ label: "Postgres" }, { label: "MySQL" }],
				},
			],
		};
		// 协议 answers key = header（"DB"），但 Result.answers key = question 全文
		const protoAnswers = JSON.stringify({ DB: "Postgres" });
		const result = await tool.execute(
			"id",
			multiQ,
			undefined,
			undefined,
			makeCtx({ mode: "rpc", selectResult: protoAnswers }),
		);
		// 转换后 key 必须是 question 全文（与 TUI 版 buildResult 一致）
		expect(result.details.answers["Which database?"]).toEqual({ selected: ["Postgres"], other: null });
	});

	it("R-8: multi-question mixed (single-select + multi-select + Other)", async () => {
		const tool = getTool();
		const mixed = {
			questions: [
				{
					question: "Which database?",
					header: "DB",
					options: [{ label: "Postgres" }, { label: "MySQL" }],
				},
				{
					question: "Which tools?",
					header: "Tools",
					options: [{ label: "A" }, { label: "B" }, { label: "C" }],
					multiSelect: true,
				},
				{
					question: "Which region?",
					header: "Region",
					options: [{ label: "US" }, { label: "EU" }],
				},
			],
		};
		// Q1: single-select Postgres
		// Q2: multi-select [C, A] (乱序 → 应重排为 A, C) + Other "Custom"
		// Q3: 无选中 (parts.length === 0 → skip, 不出现在 answers 中)
		const protoAnswers = JSON.stringify({
			DB: "Postgres",
			Tools: JSON.stringify(["C", "A"]),
			"Tools__other": "Custom",
			// Region 无选中 → protoAnswersToResult 的 `if (parts.length === 0) continue` 跳过
		});
		const result = await tool.execute(
			"id",
			mixed,
			undefined,
			undefined,
			makeCtx({ mode: "rpc", selectResult: protoAnswers }),
		);

		expect(result.details.cancelled).toBe(false);
		// Q1: single-select
		expect(result.details.answers["Which database?"]).toEqual({ selected: ["Postgres"], other: null });
		// Q2: multi-select 重排 + Other
		expect(result.details.answers["Which tools?"]).toEqual({ selected: ["A", "C"], other: "Custom" });
		// Q3: 无选中 → 跳过（不在 answers map 中）
		expect(result.details.answers["Which region?"]).toBeUndefined();
	});

	it("R-9: select 收到 title=UI_FORM_MARKER + options[0]={formQuestions, allowCancel}（D2 adapter 形态）", async () => {
		const tool = getTool();
		let capturedTitle = "";
		let capturedOptions: string[] = [];
		const ctx = {
			mode: "rpc" as const,
			hasUI: true,
			signal: undefined as AbortSignal | undefined,
			ui: {
				select: async (
					title: string,
					options: string[],
				): Promise<string> => {
					capturedTitle = title;
					capturedOptions = options;
					return JSON.stringify({ "Which DB?": "Postgres" });
				},
				custom: async <T = void>(): Promise<T> => undefined as T,
			},
		};
		await tool.execute("id", validSingle, undefined, undefined, ctx);

		// wire 形态：统一表单协议 marker + 单元素 options
		expect(capturedTitle).toBe("\x00TAIJI_UI_FORM");
		expect(capturedOptions).toHaveLength(1);
		const payload = JSON.parse(capturedOptions[0]!) as {
			formQuestions?: Array<Record<string, unknown>>;
			questions?: unknown;
			allowCancel?: boolean;
		};
		expect(payload.questions).toBeUndefined();
		expect(payload.allowCancel).toBe(true);
		expect(payload.formQuestions).toEqual([
			{
				type: "choice",
				question: "Which DB?",
				options: [
					{ label: "Postgres", description: undefined },
					{ label: "SQLite", description: undefined },
				],
				allowOther: true,
			},
		]);
		// A1 对拍基准：问题对象无 allowComment / comment 类字段
		for (const key of Object.keys(payload.formQuestions![0]!)) {
			expect(key.includes("comment"), `字段 ${key} 不应含 comment`).toBe(false);
		}
	});

	it("R-9b: multiSelect → multi 重命名进 wire 形态", async () => {
		const tool = getTool();
		let capturedOptions: string[] = [];
		const ctx = {
			mode: "rpc" as const,
			hasUI: true,
			signal: undefined as AbortSignal | undefined,
			ui: {
				select: async (_title: string, options: string[]): Promise<string> => {
					capturedOptions = options;
					return JSON.stringify({ Tools: JSON.stringify(["A"]) });
				},
				custom: async <T = void>(): Promise<T> => undefined as T,
			},
		};
		const multi = {
			questions: [
				{
					question: "Which tools?",
					header: "Tools",
					options: [{ label: "A" }, { label: "B" }],
					multiSelect: true,
				},
			],
		};
		await tool.execute("id", multi, undefined, undefined, ctx);
		const payload = JSON.parse(capturedOptions[0]!) as {
			formQuestions?: Array<Record<string, unknown>>;
		};
		expect(payload.formQuestions![0]!.multi).toBe(true);
		expect(payload.formQuestions![0]!.multiSelect).toBeUndefined();
	});

	it("R-10: select 回显 payload（echo，旧 taiji 宿主）→ channel-error throw 带升级指引 + 工具禁用", async () => {
		let capturedActive: string[] | null = null;
		const tool = getTool({
			getAllTools: () => [{ name: "ask_user" }, { name: "other" }],
			setActiveTools: (names: string[]) => {
				capturedActive = names;
			},
		});
		// 旧宿主不识别 UI_FORM_MARKER → band 单选项 = payload 自身，点选回显
		const ctx = {
			mode: "rpc" as const,
			hasUI: true,
			signal: undefined as AbortSignal | undefined,
			ui: {
				select: async (_title: string, options: string[]): Promise<string> => options[0]!,
				custom: async <T = void>(): Promise<T> => undefined as T,
			},
		};
		await expect(
			tool.execute("id", validSingle, undefined, undefined, ctx),
		).rejects.toThrow(/ask_user failed[\s\S]*upgrade taiji/);
		// channel-error 折叠 = 禁用工具（防 LLM 反复重试），与 R-6 一致
		expect(capturedActive).not.toContain("ask_user");
		expect(capturedActive).toContain("other");
	});

	it("R-11: select 返回合法 JSON 但非 FormAnswers 形状（JSON 数组）→ 折叠 cancelled（非 throw）", async () => {
		const tool = getTool();
		const result = await tool.execute(
			"id",
			validSingle,
			undefined,
			undefined,
			makeCtx({ mode: "rpc", selectResult: JSON.stringify(["A", "B"]) }),
		);
		expect(result.content[0].text).toContain("User cancelled");
		expect(result.details.cancelled).toBe(true);
	});

});
