// src/__tests__/channel-handler.test.ts
//
// Tests createAskUserChannelHandler：把 subagent 子进程的 ask_user 请求透传到主进程 UI。
//
// 覆盖：
//   - RPC 路径（ctx.mode === 'rpc'）：转发器——handler 内部调 askUserInteract（select 通道），
//     把 proto answers JSON.stringify 成 {value} 返回，子进程 JSON.parse(value) 正确 decode。
//   - TUI 路径（ctx.mode === 'tui'）：handler 走 ctx.ui.custom（mock 成返回预设 Result），
//     验证内部结构化 Result.answers（AnswerValue）→ proto AskUserAnswers 重新编码
//     （single/multi/Other 三种答案形态，经 encodeAnswer 序列化）。
//   - 取消（askUserInteract/custom 返回 null 或 cancelled）→ {cancelled: true}
//   - 输入校验（channelPayload 缺失/无 questions）→ {cancelled: true}
import type { AskUserQuestion } from "@taiji/extension-protocol";
import { describe, expect, it } from "vitest";

import { createAskUserChannelHandler } from "../channel-handler";
import type { Result } from "../types";

// ── Mock ctx ───────────────────────────────────────────
// RPC：ctx.ui.select 模拟前端回传的 proto answers（JSON.stringify(AskUserAnswers)）。
// TUI：ctx.ui.custom 模拟 AskUserComponent 产出的内部 Result。
type CtxMode = "tui" | "rpc";

interface MockCtxOpts {
	mode: CtxMode;
	/** RPC：select 返回的 value（JSON.stringify 后的 proto answers）；undefined = 取消 */
	selectResult?: string | undefined;
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
	const { mode, selectResult, customResult } = opts;
	const hasUI = true;
	if (mode === "rpc") {
		return {
			mode,
			hasUI,
			ui: {
				select: async (): Promise<string | undefined> => selectResult,
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

// ── 样例 proto questions（handler 收到的格式） ──────────
const singleProto: AskUserQuestion = {
	question: "Which DB?",
	options: [{ label: "Postgres" }, { label: "SQLite" }],
};

const multiProto: AskUserQuestion = {
	question: "Which tools?",
	header: "Tools",
	multiSelect: true,
	options: [{ label: "A" }, { label: "B" }, { label: "C" }],
};

// ── Tests ───────────────────────────────────────────────

describe("createAskUserChannelHandler", () => {
	it("RPC: single-select proto answers → {value: JSON.stringify(answers)}", async () => {
		// 前端回传 proto answers：{[key]: value}，key = question 全文（无 header）
		const protoAnswers = { "Which DB?": "Postgres" };
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "rpc", selectResult: JSON.stringify(protoAnswers) }) as never,
		);
		const resp = await handler({ channelPayload: { questions: [singleProto] } });
		expect(resp).toEqual({ value: JSON.stringify({ "Which DB?": "Postgres" }) });
	});

	it("RPC: multi-select proto answers (JSON array value) → 透传", async () => {
		const protoAnswers = { Tools: JSON.stringify(["A", "C"]) };
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "rpc", selectResult: JSON.stringify(protoAnswers) }) as never,
		);
		const resp = await handler({ channelPayload: { questions: [multiProto] } });
		expect(resp).toEqual({ value: JSON.stringify({ Tools: JSON.stringify(["A", "C"]) }) });
	});

	it("RPC: Other proto answers → 透传", async () => {
		const protoAnswers = {
			"Which DB?": "Postgres",
			"Which DB?__other": "Custom DB",
		};
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "rpc", selectResult: JSON.stringify(protoAnswers) }) as never,
		);
		const resp = await handler({ channelPayload: { questions: [singleProto] } });
		expect(resp).toEqual({ value: JSON.stringify(protoAnswers) });
	});

	it("RPC: user cancel (select undefined) → {cancelled: true}", async () => {
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "rpc", selectResult: undefined }) as never,
		);
		const resp = await handler({ channelPayload: { questions: [singleProto] } });
		expect(resp).toEqual({ cancelled: true });
	});

	it("TUI: internal Result single-select AnswerValue → 重新编码为 proto answers", async () => {
		// 内部 Result.answers：key = question 全文，value = 结构化 AnswerValue
		const internalResult: Result = {
			questions: [],
			answers: { "Which DB?": { selected: ["Postgres"], other: null } },
			cancelled: false,
		};
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "tui", customResult: internalResult }) as never,
		);
		const resp = await handler({ channelPayload: { questions: [singleProto] } });
		// 期望：proto answers { "Which DB?": "Postgres" }
		expect(resp).toEqual({ value: JSON.stringify({ "Which DB?": "Postgres" }) });
	});

	it("TUI: multi-select internal Result → proto JSON array value", async () => {
		const internalResult: Result = {
			questions: [],
			answers: { "Which tools?": { selected: ["A", "C"], other: null } },
			cancelled: false,
		};
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "tui", customResult: internalResult }) as never,
		);
		const resp = await handler({ channelPayload: { questions: [multiProto] } });
		// 期望：key=header "Tools"，value = JSON.stringify(["A","C"])
		expect(resp).toEqual({ value: JSON.stringify({ Tools: JSON.stringify(["A", "C"]) }) });
	});

	it("TUI: Other free text → ${key}__other", async () => {
		// 内部 Result：selected label + Other 文本分离存储（AnswerValue.other）
		const internalResult: Result = {
			questions: [],
			answers: { "Which DB?": { selected: ["Postgres"], other: "Custom DB" } },
			cancelled: false,
		};
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "tui", customResult: internalResult }) as never,
		);
		const resp = await handler({ channelPayload: { questions: [singleProto] } });
		expect(resp).toEqual({
			value: JSON.stringify({ "Which DB?": "Postgres", "Which DB?__other": "Custom DB" }),
		});
	});

	it("TUI: Other-only answer（selected 空）→ 只写 ${key}__other 不写主 key", async () => {
		const internalResult: Result = {
			questions: [],
			answers: { "Which DB?": { selected: [], other: "custom text" } },
			cancelled: false,
		};
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "tui", customResult: internalResult }) as never,
		);
		const resp = await handler({ channelPayload: { questions: [singleProto] } });
		expect(resp).toEqual({
			value: JSON.stringify({ "Which DB?__other": "custom text" }),
		});
	});

	it("TUI: user cancel (custom returns null) → {cancelled: true}", async () => {
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "tui", customResult: null }) as never,
		);
		const resp = await handler({ channelPayload: { questions: [singleProto] } });
		expect(resp).toEqual({ cancelled: true });
	});

	it("TUI: custom returns cancelled Result → {cancelled: true}", async () => {
		const handler = createAskUserChannelHandler(
			makeCtx({
				mode: "tui",
				customResult: { questions: [], answers: {}, cancelled: true },
			}) as never,
		);
		const resp = await handler({ channelPayload: { questions: [singleProto] } });
		expect(resp).toEqual({ cancelled: true });
	});

	it("input: channelPayload missing → {cancelled: true}", async () => {
		const handler = createAskUserChannelHandler(makeCtx({ mode: "rpc" }) as never);
		const resp = await handler({});
		expect(resp).toEqual({ cancelled: true });
	});

	it("input: questions empty array → {cancelled: true}", async () => {
		const handler = createAskUserChannelHandler(makeCtx({ mode: "rpc" }) as never);
		const resp = await handler({ channelPayload: { questions: [] } });
		expect(resp).toEqual({ cancelled: true });
	});

	it("input: questions not an array → {cancelled: true}", async () => {
		const handler = createAskUserChannelHandler(makeCtx({ mode: "rpc" }) as never);
		const resp = await handler({ channelPayload: { questions: "not-array" } });
		expect(resp).toEqual({ cancelled: true });
	});

	it("input: req is null/undefined → {cancelled: true}", async () => {
		const handler = createAskUserChannelHandler(makeCtx({ mode: "rpc" }) as never);
		expect(await handler(null)).toEqual({ cancelled: true });
		expect(await handler(undefined)).toEqual({ cancelled: true });
	});

	it("RPC: allowCancel passed through to askUserInteract (default true)", async () => {
		// allowCancel 默认 true：验证不抛错（select mock 返回 undefined=取消）
		const handler = createAskUserChannelHandler(
			makeCtx({ mode: "rpc", selectResult: undefined }) as never,
		);
		const resp = await handler({ channelPayload: { questions: [singleProto] } });
		expect(resp).toEqual({ cancelled: true });
	});
});
