// src/__tests__/channel-handler.test.ts
//
// Tests createAskUserChannelHandler：把 subagent 子进程的 ask_user 请求透传到主进程 UI。
//
// D9 双 payload mock 轨：孙进程 npm 版本不可控——新孙进程发 {formQuestions: FormQuestion[]}
// （ui_form channel），旧孙进程发 {questions: AskUserQuestion[]}（ask_user channel）。
// 核心行为用例全部在两种 payload 形态下各跑一遍（payloadShapes 参数化），断言输出逐字一致。
//
// 覆盖：
//   - RPC 路径（ctx.mode === 'rpc'）：转发器——handler 内部调 uiFormInteract（select 通道 +
//     UI_FORM_MARKER），把 proto answers JSON.stringify 成 {value} 返回，子进程 JSON.parse(value)
//     正确 decode（回包 isFormAnswers 校验通过）。
//   - TUI 路径（ctx.mode === 'tui'）：handler 走 ctx.ui.custom（mock 成返回预设 Result），
//     验证内部结构化 Result.answers（AnswerValue）→ proto answers 重新编码
//     （single/multi/Other/text 四种答案形态，经 encodeAnswer 序列化）。
//   - 取消（uiFormInteract 不 ok / custom 返回 null 或 cancelled）→ {cancelled: true}
//   - 输入校验（channelPayload 缺失 / 双读两键皆空 / formQuestions 全不合法）→ {cancelled: true}
import type { AskUserQuestion, FormQuestion } from "@zhushanwen/extension-protocol";
import { describe, expect, it } from "vitest";

import { createAskUserChannelHandler } from "../channel-handler";
import type { Result } from "../types";

// ── Mock ctx ───────────────────────────────────────────
// RPC：ctx.ui.select 模拟前端回传的 proto answers（JSON.stringify(FormAnswers)）。
// selectEcho = true 时 select 原样回显 options[0]（模拟旧宿主不识别 UI_FORM_MARKER 的
// band 单选项回显——uiFormInteract echo 检测命中 → channel-error → handler 折叠 cancelled）。
// TUI：ctx.ui.custom 模拟 AskUserComponent 产出的内部 Result。
type CtxMode = "tui" | "rpc";

interface MockCtxOpts {
	mode: CtxMode;
	/** RPC：select 返回的 value（JSON.stringify 后的 proto answers）；undefined = 取消 */
	selectResult?: string | undefined;
	/** RPC：select 原样回显收到的 options[0]（echo 场景） */
	selectEcho?: boolean;
	/** TUI：custom 返回的内部 Result；null = 用户取消 */
	customResult?: Result | null;
}

function makeCtx(opts: MockCtxOpts): {
	mode: CtxMode;
	hasUI: boolean;
	ui: {
		select?: (title: string, options: string[], o?: { signal?: AbortSignal }) => Promise<string | undefined>;
		custom: <T = void>(factory: unknown) => Promise<T>;
	};
} {
	const { mode, selectResult, selectEcho, customResult } = opts;
	const hasUI = true;
	if (mode === "rpc") {
		return {
			mode,
			hasUI,
			ui: {
				select: async (_title: string, options: string[]): Promise<string | undefined> =>
					selectEcho ? options[0] : selectResult,
				custom: async <T = void>(): Promise<T> => undefined as T,
			},
		};
	}
	// TUI
	return {
		mode,
		hasUI,
		ui: {
			custom: async <T = void>(): Promise<T> => customResult as T,
		},
	};
}

// ── 样例问题（legacy AskUserQuestion 与等价 FormQuestion 双形态）──
const legacySingle: AskUserQuestion = {
	question: "Which DB?",
	options: [{ label: "Postgres" }, { label: "SQLite" }],
};
const formSingle: FormQuestion = {
	type: "choice",
	question: "Which DB?",
	options: [{ label: "Postgres" }, { label: "SQLite" }],
};

const legacyMulti: AskUserQuestion = {
	question: "Which tools?",
	header: "Tools",
	multiSelect: true,
	options: [{ label: "A" }, { label: "B" }, { label: "C" }],
};
const formMulti: FormQuestion = {
	type: "choice",
	question: "Which tools?",
	header: "Tools",
	multi: true,
	options: [{ label: "A" }, { label: "B" }, { label: "C" }],
};

/** D9 双 payload 轨：同一问题集的两种 wire 形态（旧 questions / 新 formQuestions） */
function payloadShapes(
	legacy: AskUserQuestion[],
	form: FormQuestion[],
	allowCancel?: boolean,
): { label: string; req: unknown }[] {
	return [
		{
			label: "legacy payload {questions}",
			req: { channelPayload: { questions: legacy, ...(allowCancel !== undefined ? { allowCancel } : {}) } },
		},
		{
			label: "new payload {formQuestions}",
			req: { channelPayload: { formQuestions: form, ...(allowCancel !== undefined ? { allowCancel } : {}) } },
		},
	];
}

const singleShapes = payloadShapes([legacySingle], [formSingle]);
const multiShapes = payloadShapes([legacyMulti], [formMulti]);

// ── Tests ───────────────────────────────────────────────

describe("createAskUserChannelHandler — D9 双 payload 轨（两种形态行为逐字一致）", () => {
	it.each(singleShapes)("RPC single-select: $label → {value: JSON.stringify(answers)}", async ({ req }) => {
		// 前端回传 proto answers：{[key]: value}，key = question 全文（无 header）
		const protoAnswers = { "Which DB?": "Postgres" };
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "rpc", selectResult: JSON.stringify(protoAnswers) }) as never,
		);
		const resp = await handler(req);
		expect(resp).toEqual({ value: JSON.stringify({ "Which DB?": "Postgres" }) });
	});

	it.each(multiShapes)("RPC multi-select: $label → JSON array value 透传", async ({ req }) => {
		const protoAnswers = { Tools: JSON.stringify(["A", "C"]) };
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "rpc", selectResult: JSON.stringify(protoAnswers) }) as never,
		);
		const resp = await handler(req);
		expect(resp).toEqual({ value: JSON.stringify({ Tools: JSON.stringify(["A", "C"]) }) });
	});

	it.each(singleShapes)("RPC Other: $label → __other 键透传", async ({ req }) => {
		const protoAnswers = {
			"Which DB?": "Postgres",
			"Which DB?__other": "Custom DB",
		};
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "rpc", selectResult: JSON.stringify(protoAnswers) }) as never,
		);
		const resp = await handler(req);
		expect(resp).toEqual({ value: JSON.stringify(protoAnswers) });
	});

	it.each(singleShapes)("RPC user cancel: $label → {cancelled: true}", async ({ req }) => {
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "rpc", selectResult: undefined }) as never,
		);
		const resp = await handler(req);
		expect(resp).toEqual({ cancelled: true });
	});

	it.each(singleShapes)(
		"RPC echo（旧宿主回显 payload）: $label → channel-error 折叠 {cancelled: true}",
		async ({ req }) => {
			// uiFormInteract echo 检测命中（value === payload）→ channel-error；
			// 间接链回包形状只有 {value}|{cancelled}，throw 会被 dialog-queue 兜底成同一结果
			const handler = createAskUserChannelHandler(
				makeCtx({ mode: "rpc", selectEcho: true }) as never,
			);
			const resp = await handler(req);
			expect(resp).toEqual({ cancelled: true });
		},
	);

	it.each(singleShapes)("TUI single-select: $label → 重新编码为 proto answers", async ({ req }) => {
		// 内部 Result.answers：key = question 全文，value = 结构化 AnswerValue
		const internalResult: Result = {
			questions: [],
			answers: { "Which DB?": { selected: ["Postgres"], other: null } },
			cancelled: false,
		};
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "tui", customResult: internalResult }) as never,
		);
		const resp = await handler(req);
		// 期望：proto answers { "Which DB?": "Postgres" }
		expect(resp).toEqual({ value: JSON.stringify({ "Which DB?": "Postgres" }) });
	});

	it.each(multiShapes)("TUI multi-select: $label → proto JSON array value", async ({ req }) => {
		const internalResult: Result = {
			questions: [],
			answers: { "Which tools?": { selected: ["A", "C"], other: null } },
			cancelled: false,
		};
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "tui", customResult: internalResult }) as never,
		);
		const resp = await handler(req);
		// 期望：key=header "Tools"，value = JSON.stringify(["A","C"])
		expect(resp).toEqual({ value: JSON.stringify({ Tools: JSON.stringify(["A", "C"]) }) });
	});

	it.each(singleShapes)("TUI Other free text: $label → ${key}__other", async ({ req }) => {
		// 内部 Result：selected label + Other 文本分离存储（AnswerValue.other）
		const internalResult: Result = {
			questions: [],
			answers: { "Which DB?": { selected: ["Postgres"], other: "Custom DB" } },
			cancelled: false,
		};
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "tui", customResult: internalResult }) as never,
		);
		const resp = await handler(req);
		expect(resp).toEqual({
			value: JSON.stringify({ "Which DB?": "Postgres", "Which DB?__other": "Custom DB" }),
		});
	});

	it.each(singleShapes)("TUI user cancel: $label → {cancelled: true}", async ({ req }) => {
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "tui", customResult: null }) as never,
		);
		const resp = await handler(req);
		expect(resp).toEqual({ cancelled: true });
	});
});

describe("createAskUserChannelHandler — 形态特有用例", () => {
	it("TUI Other-only answer（selected 空）→ 只写 ${key}__other 不写主 key", async () => {
		const internalResult: Result = {
			questions: [],
			answers: { "Which DB?": { selected: [], other: "custom text" } },
			cancelled: false,
		};
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "tui", customResult: internalResult }) as never,
		);
		const resp = await handler({ channelPayload: { questions: [legacySingle] } });
		expect(resp).toEqual({
			value: JSON.stringify({ "Which DB?__other": "custom text" }),
		});
	});

	it("TUI custom returns cancelled Result → {cancelled: true}", async () => {
		const handler = createAskUserChannelHandler(
			makeCtx({
				mode: "tui",
				customResult: { questions: [], answers: {}, cancelled: true },
			}) as never,
		);
		const resp = await handler({ channelPayload: { questions: [legacySingle] } });
		expect(resp).toEqual({ cancelled: true });
	});

	it("TUI text question（新形态）：自由文本答案只写 ${key}__other", async () => {
		// 旧 payload 无 options 问题 → text；组件渲染为空 options 自由输入，
		// 答案经 AnswerValue.other 编码为 __other 键（与 FormOverlay text 题键位一致）
		const internalResult: Result = {
			questions: [],
			answers: { "Describe the issue": { selected: [], other: "typed free text" } },
			cancelled: false,
		};
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "tui", customResult: internalResult }) as never,
		);
		const resp = await handler({
			channelPayload: { formQuestions: [{ type: "text", question: "Describe the issue" }] },
		});
		expect(resp).toEqual({
			value: JSON.stringify({ "Describe the issue__other": "typed free text" }),
		});
	});

	it("新 payload 逐项守卫：不合法项过滤，合法项照常服务", async () => {
		const protoAnswers = { "Which DB?": "Postgres" };
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "rpc", selectResult: JSON.stringify(protoAnswers) }) as never,
		);
		const resp = await handler({
			channelPayload: {
				formQuestions: [{ type: "choice", question: 123 }, formSingle, "garbage"],
			},
		});
		expect(resp).toEqual({ value: JSON.stringify({ "Which DB?": "Postgres" }) });
	});

	it("新 payload formQuestions 空数组 → ?? 语义生效 → {cancelled: true}（不回落旧键）", async () => {
		const handler = createAskUserChannelHandler(makeCtx({ mode: "rpc" }) as never);
		const resp = await handler({
			channelPayload: { formQuestions: [], questions: [legacySingle] },
		});
		expect(resp).toEqual({ cancelled: true });
	});
});

describe("createAskUserChannelHandler — input 校验", () => {
	it("channelPayload missing → {cancelled: true}", async () => {
		const handler = createAskUserChannelHandler(makeCtx({ mode: "rpc" }) as never);
		const resp = await handler({});
		expect(resp).toEqual({ cancelled: true });
	});

	it("questions empty array → {cancelled: true}", async () => {
		const handler = createAskUserChannelHandler(makeCtx({ mode: "rpc" }) as never);
		const resp = await handler({ channelPayload: { questions: [] } });
		expect(resp).toEqual({ cancelled: true });
	});

	it("questions not an array → {cancelled: true}", async () => {
		const handler = createAskUserChannelHandler(makeCtx({ mode: "rpc" }) as never);
		const resp = await handler({ channelPayload: { questions: "not-array" } });
		expect(resp).toEqual({ cancelled: true });
	});

	it("formQuestions 全不合法 → {cancelled: true}", async () => {
		const handler = createAskUserChannelHandler(makeCtx({ mode: "rpc" }) as never);
		const resp = await handler({ channelPayload: { formQuestions: ["nope", 42] } });
		expect(resp).toEqual({ cancelled: true });
	});

	it("req is null/undefined → {cancelled: true}", async () => {
		const handler = createAskUserChannelHandler(makeCtx({ mode: "rpc" }) as never);
		expect(await handler(null)).toEqual({ cancelled: true });
		expect(await handler(undefined)).toEqual({ cancelled: true });
	});

	it("RPC: allowCancel passed through to uiFormInteract (default true)", async () => {
		// allowCancel 默认 true：验证不抛错（select mock 返回 undefined=取消）
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "rpc", selectResult: undefined }) as never,
		);
		const resp = await handler({ channelPayload: { questions: [legacySingle] } });
		expect(resp).toEqual({ cancelled: true });
	});
});
