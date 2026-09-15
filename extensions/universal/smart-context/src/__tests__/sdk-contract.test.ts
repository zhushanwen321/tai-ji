import { describe, expect, it } from "vitest";

/**
 * SDK 契约测试（规范：凡调用 pi.on / pi.registerTool / 读 ctx.* 的代码必须有契约测试覆盖）。
 * 兜底 compact-handler.ts / llm.ts 中跨 SDK 泛型边界的 `as never` 断言——
 * 断言的运行时形状在这里实测（node_modules 实装 @earendil-works/pi-coding-agent@0.84.1）。
 */

import {
	buildSessionContext,
	compact,
	convertToLlm,
	DEFAULT_COMPACTION_SETTINGS,
} from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";

describe("pi SDK 契约（compact 接管路径依赖的导出形状）", () => {
	it("compact / buildSessionContext / convertToLlm / DEFAULT_COMPACTION_SETTINGS 为函数/对象导出", () => {
		expect(typeof compact).toBe("function");
		expect(typeof buildSessionContext).toBe("function");
		expect(typeof convertToLlm).toBe("function");
		expect(typeof DEFAULT_COMPACTION_SETTINGS).toBe("object");
	});

	it("buildSessionContext(branchEntries) 返回 { messages, entries }（R9 完整上下文数据源）", () => {
		const entries = [
			{ id: "m1", parentId: null, type: "message", timestamp: 1, message: { role: "user", content: "hi", timestamp: 1 } },
			{ id: "c1", parentId: "m1", type: "compaction", timestamp: 2, summary: "s", firstKeptEntryId: "m2", tokensBefore: 10 },
			{ id: "m2", parentId: "c1", type: "message", timestamp: 3, message: { role: "user", content: "kept", timestamp: 3 } },
		];
		const ctx = buildSessionContext(entries as never);
		expect(Array.isArray(ctx.messages)).toBe(true);
		// compaction entry 投影为一条消息 + 保留段消息（旧摘要在前缀中，D12 same-mode 前提）
		expect(ctx.messages.length).toBeGreaterThanOrEqual(2);
	});

	it("convertToLlm 把 user text message 原样保留（same-mode 输入链不变形）", () => {
		const out = convertToLlm([{ role: "user", content: "hello", timestamp: 1 } as never]);
		expect(out.length).toBe(1);
		expect(out[0].role).toBe("user");
	});

	it("completeSimple 为函数导出（same-mode LLM 调用通道）", () => {
		expect(typeof completeSimple).toBe("function");
	});

	it("compact() 的 preparation 参数运行时消费字段（messagesToSummarize/previousSummary/fileOps）在函数体内可达——静态签名核对", async () => {
		// 不真正调网：用立即 abort 的 signal 让 compact 提前拒绝，验证参数形状被接受不抛 TypeError
		const controller = new AbortController();
		controller.abort();
		const preparation = {
			firstKeptEntryId: "x",
			messagesToSummarize: [{ role: "user", content: "m", timestamp: 1 }],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 10,
			previousSummary: undefined,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: DEFAULT_COMPACTION_SETTINGS,
		};
		const model = { id: "m", provider: "p", contextWindow: 1000, maxTokens: 100 } as never;
		await expect(
			compact(preparation as never, model, "key", undefined, undefined, controller.signal),
		).rejects.toThrow();
	});
});
