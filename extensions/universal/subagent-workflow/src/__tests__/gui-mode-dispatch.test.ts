// src/__tests__/gui-mode-dispatch.test.ts
//
// S6: ctx.mode RPC 分发契约测试。
//
// 审查发现：sdk-contract.test.ts 只测 ctx.model 透传，未覆盖 ctx.mode === "rpc"
// 时 __gui__ 被填充、ctx.mode === "tui" 时不填充的 GUI 通道分发。
//
// adapter() 是纯函数，ctx.mode === "rpc" → details.__gui__ 被附加，
// ctx.mode === "tui"/"json"/"print" → details.__gui__ 为 undefined。

import type { GuiContext } from "@zhushanwen/extension-protocol";
import { describe, expect, it } from "vitest";

import type { AdapterInput } from "../interface/subagent-actions.ts";
import { adapter } from "../interface/subagent-actions.ts";

function makeStartInput(): AdapterInput {
	return {
		action: "start",
		domain: {
			subagentId: "test-id",
			sessionFile: "/test/session.jsonl",
			slug: "test-slug",
			response: { status: "started" },
		},
	} as unknown as AdapterInput;
}

describe("S6: ctx.mode dispatches __gui__ output correctly", () => {
	it("ctx.mode=rpc → details.__gui__ is populated", () => {
		const ctx = { mode: "rpc", hasUI: true } as GuiContext;
		const result = adapter(makeStartInput(), ctx);
		expect(result.details).toHaveProperty("__gui__");
		expect(result.details.__gui__).toBeDefined();
	});

	it("ctx.mode=tui → details.__gui__ is undefined (TUI renders differently)", () => {
		const ctx = { mode: "tui", hasUI: true } as GuiContext;
		const result = adapter(makeStartInput(), ctx);
		expect(result.details.__gui__).toBeUndefined();
	});

	it("ctx.mode=json → details.__gui__ is undefined (headless)", () => {
		const ctx = { mode: "json", hasUI: false } as GuiContext;
		const result = adapter(makeStartInput(), ctx);
		expect(result.details.__gui__).toBeUndefined();
	});

	it("ctx.mode=print → details.__gui__ is undefined (headless)", () => {
		const ctx = { mode: "print", hasUI: false } as GuiContext;
		const result = adapter(makeStartInput(), ctx);
		expect(result.details.__gui__).toBeUndefined();
	});

	it("ctx=undefined → details.__gui__ is undefined (backward compat)", () => {
		const result = adapter(makeStartInput(), undefined);
		expect(result.details.__gui__).toBeUndefined();
	});
});
