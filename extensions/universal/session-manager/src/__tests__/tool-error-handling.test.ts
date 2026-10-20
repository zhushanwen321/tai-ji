// tool-error-handling.test.ts — U5-A4: null/undefined returns → cancelled throw; exceptions → propagate;
// {error} respond → throw（W4 throw 范式：execute throw → pi agent-loop catch 置 isError:true——
// pi-agent-core dist/agent-loop.js executePreparedToolCall，1.0.0 实读 catch :581-588；1.0.0 起
// 正常 return 的 isError 也被尊重（同文件 :579 `isError: result.isError === true`，0.84.4 才是
// 硬编码 false）——本包失败恒走 throw，两版语义等价（语义登记 PS-56）

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createToolHarness, expectToolRejects, runToolForText } from "./helpers/extension-harness.ts";

describe("U5-A4 tool-error-handling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("select returning undefined (user cancel/channel error) → cancelled throw（W4 范式：错误路径 throw）", async () => {
		await expectToolRejects(
			createToolHarness(vi.fn().mockResolvedValue(undefined)),
			"create_managed_session",
			{ cwd: "/tmp" },
			/cancelled/,
		);
	});

	it("select returning null → cancelled throw", async () => {
		await expectToolRejects(
			createToolHarness(vi.fn().mockResolvedValue(null)),
			"send_to_session",
			{ sessionId: "s1", prompt: "hi" },
			/cancelled/,
		);
	});

	it("select throwing exception → cancelled throw（select 通道异常同折叠）", async () => {
		await expectToolRejects(
			createToolHarness(vi.fn().mockRejectedValue(new Error("channel closed"))),
			"get_session_status",
			{ sessionId: "s1" },
			/cancelled/,
		);
	});

	it("select throwing non-Error → cancelled throw", async () => {
		await expectToolRejects(
			createToolHarness(vi.fn().mockRejectedValue("string error")),
			"abort_session",
			{ sessionId: "s1" },
			/cancelled/,
		);
	});

	it("runtime respond 携带 {error} JSON → throw（禁止错误成功模式；pi 置 isError:true）", async () => {
		await expectToolRejects(
			createToolHarness(
				vi.fn().mockResolvedValue(JSON.stringify({ error: "session unreachable", hint: "check get_session_status" })),
			),
			"send_to_session",
			{ sessionId: "s1", prompt: "hi" },
			/session unreachable[\s\S]*hint/,
		);
	});

	it("runtime respond 携带 {error, code}（ArchiveError 码透传）→ throw 文本含结构化错误码（决策 5：archive_generating 对模型可见）", async () => {
		await expectToolRejects(
			createToolHarness(
				vi.fn().mockResolvedValue(
					JSON.stringify({
						error: "会话正在生成中，无法归档 (sessionId=s1)",
						code: "archive_generating",
						hint: "abort first or wait for completion, then retry archive",
					}),
				),
			),
			"archive_session",
			{ sessionId: "s1" },
			/archive_generating/,
		);
	});

	it("runtime respond 正常 JSON → 成功返回（不含 isError 字段）", async () => {
		const result = await runToolForText(
			createToolHarness(vi.fn().mockResolvedValue(JSON.stringify({ queued: true }))),
			"send_to_session",
			{ sessionId: "s1", prompt: "hi" },
		);
		expect(Object.hasOwn(result, "isError")).toBe(false);
		expect(JSON.parse(result.content[0].text)).toEqual({ queued: true });
	});

	it("all 8 tools handle null gracefully（cancelled throw）", async () => {
		const { registered, ctx } = createToolHarness(vi.fn().mockResolvedValue(null));
		for (const tool of registered) {
			const params = tool.name === "create_managed_session"
				? { cwd: "/tmp" }
				: tool.name === "send_to_session"
					? { sessionId: "s1", prompt: "hi" }
					: tool.name === "read_session_history"
						? { sessionId: "s1" }
						: tool.name === "list_my_sessions"
							? {}
							: { sessionId: "s1" };
			await expect(tool.execute("call-1", params, undefined, undefined, ctx)).rejects.toThrow(
				/cancelled/,
			);
		}
	});
});
