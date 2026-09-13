/**
 * approval.test.ts — requestUserApproval（TUI/RPC/headless）+ ApprovalComponent +
 * renderApprovalView 测试。覆盖 G3 abort 时序 + G4 invalidate。
 */
import { describe, expect, it, vi } from "vitest";

import {
	ApprovalComponent,
	collectRejectReason,
	type ApprovalContext,
	renderApprovalView,
	requestUserApproval,
} from "../approval.js";
import type { ApprovalRequest } from "../pipeline.js";
import type { ClassifierResult, ToolInvocationContext, UserDecision } from "../types.js";

// ──────────────────────── mock helpers ────────────────────────

function makeApprovalCtx(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
	const base: ApprovalContext = {
		mode: "headless",
		ui: {
			notify: vi.fn(),
			select: vi.fn(() => Promise.resolve(undefined)),
			custom: vi.fn(() => Promise.resolve(undefined)),
		},
	};
	// 浅合并 ui（保留 base.ui 的方法，允许 overrides.ui 增量覆盖/新增如 input）
	return {
		mode: overrides.mode ?? base.mode,
		ui: { ...base.ui, ...overrides.ui },
	};
}

const req: ApprovalRequest = { toolName: "bash", command: "rm -rf /tmp", reason: "no allow rule" };
const ctx: ToolInvocationContext = { toolName: "bash", command: "rm -rf /tmp", cwd: "/tmp" };

// ──────────────────────── headless 分支（M1） ────────────────────────

describe("requestUserApproval: headless 模式（M1）", () => {
	it("json 模式 → 立即 fail-closed deny + notify", async () => {
		const approvalCtx = makeApprovalCtx({ mode: "json" });
		const controller = new AbortController();
		const decision = await requestUserApproval(req, ctx, controller.signal, approvalCtx);
		expect(decision.approved).toBe(false);
		expect(decision.reason).toContain("headless");
		expect(decision.reason).toContain("cannot prompt");
		expect(approvalCtx.ui.notify).toHaveBeenCalledOnce();
	});

	it("print 模式 → 立即 fail-closed deny + notify", async () => {
		const approvalCtx = makeApprovalCtx({ mode: "print" });
		const decision = await requestUserApproval(req, ctx, new AbortController().signal, approvalCtx);
		expect(decision.approved).toBe(false);
		expect(decision.reason).toContain("headless");
		expect(approvalCtx.ui.notify).toHaveBeenCalledOnce();
	});

	it("headless 即使 signal 已 aborted 也立即 deny（不依赖 signal）", async () => {
		const approvalCtx = makeApprovalCtx({ mode: "json" });
		const controller = new AbortController();
		controller.abort();
		const decision = await requestUserApproval(req, ctx, controller.signal, approvalCtx);
		expect(decision.approved).toBe(false);
		expect(decision.reason).toContain("headless");
	});

	// M1 语义：headless auto 的 Racing 在 runLayer3WithRacing 内部通过 isHeadless() 分支处理，
	// requestHeadless 只服务 strict/approve 的 askUser 路径（立即 deny，无 AI 可兜底）。
});

// ──────────────────────── rpc 分支 ────────────────────────

describe("requestUserApproval: rpc 模式", () => {
	it("用户选 Approve → approved=true", async () => {
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve("Approve (once)")),
				custom: vi.fn(() => Promise.resolve(undefined)),
			},
		});
		const decision = await requestUserApproval(req, ctx, undefined, approvalCtx);
		expect(decision.approved).toBe(true);
	});

	it("用户选 Deny → approved=false", async () => {
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve("Deny")),
				custom: vi.fn(() => Promise.resolve(undefined)),
			},
		});
		const decision = await requestUserApproval(req, ctx, undefined, approvalCtx);
		expect(decision.approved).toBe(false);
	});

	it("用户关闭对话框（undefined）→ approved=false", async () => {
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve(undefined)),
				custom: vi.fn(() => Promise.resolve(undefined)),
			},
		});
		const decision = await requestUserApproval(req, ctx, undefined, approvalCtx);
		expect(decision.approved).toBe(false);
		expect(decision.reason).toContain("dismissed");
	});

	it("M2：signal 已 aborted → 短路 deny，不调 ctx.ui.select", async () => {
		const controller = new AbortController();
		controller.abort();
		const selectMock = vi.fn(() => Promise.resolve("Approve (once)"));
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: { notify: vi.fn(), select: selectMock, custom: vi.fn() },
		});
		const decision = await requestUserApproval(req, ctx, controller.signal, approvalCtx);
		expect(decision.approved).toBe(false);
		expect(decision.reason).toContain("aborted before prompt");
		expect(selectMock).not.toHaveBeenCalled();
	});

	it("M2：signal 透传给 ctx.ui.select（options.signal）", async () => {
		const controller = new AbortController();
		const selectMock = vi.fn((_title, _options, opts) => {
			// 验证 opts.signal 是传入的 controller.signal
			expect(opts?.signal).toBe(controller.signal);
			return Promise.resolve("Deny");
		});
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: { notify: vi.fn(), select: selectMock, custom: vi.fn() },
		});
		await requestUserApproval(req, ctx, controller.signal, approvalCtx);
		expect(selectMock).toHaveBeenCalledOnce();
	});

	it("M2：无 signal 时不透传 options（select 第三参为 undefined）", async () => {
		const selectMock = vi.fn((_title, _options, opts) => {
			expect(opts).toBeUndefined();
			return Promise.resolve("Approve (once)");
		});
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: { notify: vi.fn(), select: selectMock, custom: vi.fn() },
		});
		const decision = await requestUserApproval(req, ctx, undefined, approvalCtx);
		expect(decision.approved).toBe(true);
		expect(selectMock).toHaveBeenCalledOnce();
	});

	it("E6/M6：有 preClassification → title 6 行，含 AI 摘要行 + reasoning 行（漂移修复）", async () => {
		const pc: ClassifierResult = {
			risk_level: "high",
			outcome: "deny",
			reasoning: "dangerous pipe to shell",
			confidence: 0.95,
		};
		const reqWithPc: ApprovalRequest = { ...req, preClassification: pc };
		let capturedTitle = "";
		const selectMock = vi.fn((title: string) => {
			capturedTitle = title;
			return Promise.resolve("Deny");
		});
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: { notify: vi.fn(), select: selectMock, custom: vi.fn() },
		});
		await requestUserApproval(reqWithPc, ctx, undefined, approvalCtx);
		const lines = capturedTitle.split("\n");
		// RPC title 5→6 行：补 `  reasoning: <AI 理由>` 行（与 TUI 字段集同源，M6 漂移修复）
		expect(lines).toHaveLength(6);
		expect(lines[0]).toBe("[pi-permission] Approval required");
		expect(lines[1]).toBe("Tool: bash");
		expect(lines[2]).toBe("Command: rm -rf /tmp");
		expect(lines[3]).toBe("Reason: no allow rule");
		expect(lines[4]).toBe("AI: risk=high outcome=deny (conf=0.95)");
		expect(lines[5]).toBe("  reasoning: dangerous pipe to shell");
	});

	it("E6/M6：无 preClassification → title 仍 4 行（无 AI 摘要/reasoning 行）", async () => {
		let capturedTitle = "";
		const selectMock = vi.fn((title: string) => {
			capturedTitle = title;
			return Promise.resolve("Approve (once)");
		});
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: { notify: vi.fn(), select: selectMock, custom: vi.fn() },
		});
		await requestUserApproval(req, ctx, undefined, approvalCtx);
		const lines = capturedTitle.split("\n");
		// 无 AI 预分类：title/Tool/Command/Reason 共 4 行（设计「5→6」指有 preClassification 时）
		expect(lines).toHaveLength(4);
		expect(lines.join("\n")).not.toContain("reasoning");
		expect(lines.join("\n")).not.toContain("AI:");
	});
});

// ──────────────────────── tui 分支 + G3 ────────────────────────

describe("requestUserApproval: tui 模式", () => {
	it("G3：signal 已 aborted → 短路 deny，不调 ctx.ui.custom", async () => {
		const controller = new AbortController();
		controller.abort();
		const customMock = vi.fn(() => Promise.resolve({ approved: true } as UserDecision));
		const approvalCtx = makeApprovalCtx({
			mode: "tui",
			ui: { notify: vi.fn(), select: vi.fn(), custom: customMock },
		});
		const decision = await requestUserApproval(req, ctx, controller.signal, approvalCtx);
		expect(decision.approved).toBe(false);
		expect(decision.reason).toContain("aborted before prompt");
		expect(customMock).not.toHaveBeenCalled(); // G3：短路，不进 custom
	});

	it("G3：signal 未 aborted → 调 ctx.ui.custom，组件 done 决定结果", async () => {
		const approvalCtx = makeApprovalCtx({
			mode: "tui",
			ui: {
				notify: vi.fn(),
				select: vi.fn(),
				custom: vi.fn((_factory) => Promise.resolve({ approved: true, reason: "tui-ok" } as UserDecision)),
			},
		});
		const decision = await requestUserApproval(req, ctx, undefined, approvalCtx);
		expect(decision.approved).toBe(true);
		expect(approvalCtx.ui.custom).toHaveBeenCalledOnce();
	});
});

// ──────────────────────── ApprovalComponent + G4 ────────────────────────

describe("ApprovalComponent（G4 invalidate）", () => {
	it("G4：implements Component，invalidate() 清空渲染缓存", () => {
		const requestRender = vi.fn();
		const tui = { requestRender };
		const done = vi.fn();
		const comp = new ApprovalComponent(req, tui, done);
		// constructor 调 invalidate → 缓存为空（首次 render 必须实际渲染）
		const first = comp.render(80);
		expect(first.length).toBeGreaterThan(0);

		// invalidate 清缓存（不直接 requestRender；rerender 才 requestRender）
		requestRender.mockClear();
		comp.invalidate();
		// 再次 render → 重新计算（非缓存）
		const second = comp.render(80);
		expect(second).not.toBe(first); // 不同引用，说明缓存被清
	});

	it("render 返回非空行数组，含工具名和命令", () => {
		const comp = new ApprovalComponent(req, { requestRender: vi.fn() }, vi.fn());
		const lines = comp.render(80);
		expect(lines.length).toBeGreaterThan(0);
		const joined = lines.join("\n");
		expect(joined).toContain("bash");
		expect(joined).toContain("rm -rf /tmp");
		// 工作区改动去掉了 y/n 快捷键，只保留 Enter（approve）/Esc（deny）。
		expect(joined).toContain("[Enter] Approve");
	});

	it("handleInput Enter → approve（done 调用一次）", () => {
		const done = vi.fn();
		const comp = new ApprovalComponent(req, { requestRender: vi.fn() }, done);
		// Enter 键：matchesKey(data, "enter") 匹配 "\r"（codepoint 13）
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledOnce();
		const result = done.mock.calls[0]![0] as UserDecision;
		expect(result.approved).toBe(true);
	});

	it("handleInput Esc → deny", () => {
		const done = vi.fn();
		const comp = new ApprovalComponent(req, { requestRender: vi.fn() }, done);
		// Esc 键：matchesKey(data, "escape") 匹配 "\x1b"（codepoint 27）
		comp.handleInput("\x1b");
		expect(done).toHaveBeenCalledOnce();
		const result = done.mock.calls[0]![0] as UserDecision;
		expect(result.approved).toBe(false);
	});

	it("handleInput 在 resolved 后 no-op（守卫）", () => {
		const done = vi.fn();
		const comp = new ApprovalComponent(req, { requestRender: vi.fn() }, done);
		comp.handleInput("\r"); // 首次 approve（Enter）
		comp.handleInput("\x1b"); // resolved 后 no-op（Esc 不再生效）
		expect(done).toHaveBeenCalledOnce();
	});

	it("M2: y 键是 no-op（已移除 y 快捷键，不再触发 approve）", () => {
		const done = vi.fn();
		const comp = new ApprovalComponent(req, { requestRender: vi.fn() }, done);
		comp.handleInput("y");
		expect(done).not.toHaveBeenCalled();
		// 组件仍未 resolve（后续 Enter 仍能 approve）
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledOnce();
		expect((done.mock.calls[0]![0] as UserDecision).approved).toBe(true);
	});

	it("M2: n 键是 no-op（已移除 n 快捷键，不再触发 deny）", () => {
		const done = vi.fn();
		const comp = new ApprovalComponent(req, { requestRender: vi.fn() }, done);
		comp.handleInput("n");
		expect(done).not.toHaveBeenCalled();
		// 组件仍未 resolve（后续 Esc 仍能 deny）
		comp.handleInput("\x1b");
		expect(done).toHaveBeenCalledOnce();
		expect((done.mock.calls[0]![0] as UserDecision).approved).toBe(false);
	});

	it("M2: 大写 Y / N 也是 no-op（大小写都不触发）", () => {
		const done = vi.fn();
		const comp = new ApprovalComponent(req, { requestRender: vi.fn() }, done);
		comp.handleInput("Y");
		comp.handleInput("N");
		expect(done).not.toHaveBeenCalled();
	});

	it("cancel()（signal abort）→ deny，resolved 后 no-op", () => {
		const done = vi.fn();
		const comp = new ApprovalComponent(req, { requestRender: vi.fn() }, done);
		comp.cancel();
		expect(done).toHaveBeenCalledOnce();
		expect((done.mock.calls[0]![0] as UserDecision).approved).toBe(false);
		comp.cancel(); // 二次 no-op
		expect(done).toHaveBeenCalledOnce();
	});

	it("render 缓存：同 width 第二次返回缓存（行数组引用相同）", () => {
		const comp = new ApprovalComponent(req, { requestRender: vi.fn() }, vi.fn());
		const first = comp.render(80);
		const second = comp.render(80);
		expect(second).toBe(first); // 同一引用（缓存命中）
		comp.invalidate();
		const third = comp.render(80);
		expect(third).not.toBe(first); // invalidate 后重新渲染
	});
});

// ──────────────────────── renderApprovalView（preClassification） ────────────────────────

describe("renderApprovalView（含 AI 预分类）", () => {
	it("无 preClassification → 不渲染 AI 块", () => {
		const lines = renderApprovalView(req, 80);
		const joined = lines.join("\n");
		expect(joined).not.toContain("AI classification");
	});

	it("有 preClassification → 渲染 risk/outcome/confidence", () => {
		const pc: ClassifierResult = {
			risk_level: "high",
			outcome: "deny",
			reasoning: "dangerous pipe to shell",
			confidence: 0.95,
		};
		const reqWithPc: ApprovalRequest = { ...req, preClassification: pc };
		const lines = renderApprovalView(reqWithPc, 80);
		const joined = lines.join("\n");
		expect(joined).toContain("AI classification");
		expect(joined).toContain("high");
		expect(joined).toContain("deny");
		expect(joined).toContain("0.95");
	});
});

// ──────────────────────── W6 T9 G3: Reject-with-Reason ────────────────────────

describe("W6 T9 G3: Reject-with-Reason（collectRejectReason）", () => {
	it("ctx.ui.input 存在 → 采集真实 reason", async () => {
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(),
				custom: vi.fn(),
				input: vi.fn(() => Promise.resolve("destroys production data")),
			},
		});
		const reason = await collectRejectReason(req, approvalCtx);
		expect(reason).toBe("denied via rpc: destroys production data");
		expect(approvalCtx.ui.input).toHaveBeenCalledOnce();
	});

	it("ctx.ui.input 不存在 → fallback 固定文案（受阻条件）", async () => {
		// makeApprovalCtx 默认无 input → fallback
		const approvalCtx = makeApprovalCtx({ mode: "rpc" });
		const reason = await collectRejectReason(req, approvalCtx);
		expect(reason).toBe("denied via rpc");
	});

	it("ctx.ui.input 返回空字符串 → fallback（用户跳过）", async () => {
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(),
				custom: vi.fn(),
				input: vi.fn(() => Promise.resolve("   ")),
			},
		});
		const reason = await collectRejectReason(req, approvalCtx);
		expect(reason).toBe("denied via rpc");
	});

	it("ctx.ui.input 返回 undefined → fallback（用户取消）", async () => {
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(),
				custom: vi.fn(),
				input: vi.fn(() => Promise.resolve(undefined)),
			},
		});
		const reason = await collectRejectReason(req, approvalCtx);
		expect(reason).toBe("denied via rpc");
	});

	it("ctx.ui.input 抛异常 → fail-soft fallback（不阻塞 deny）", async () => {
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(),
				custom: vi.fn(),
				input: vi.fn(() => Promise.reject(new Error("input UI crashed"))),
			},
		});
		const reason = await collectRejectReason(req, approvalCtx);
		expect(reason).toBe("denied via rpc");
	});

	it("reason 被去空白（trim）", async () => {
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(),
				custom: vi.fn(),
				input: vi.fn(() => Promise.resolve("  too dangerous  ")),
			},
		});
		const reason = await collectRejectReason(req, approvalCtx);
		expect(reason).toBe("denied via rpc: too dangerous");
	});
});

describe("W6 T9 G3: RPC 分支拒绝时调 input 采集理由", () => {
	it("用户选 Deny + ctx.ui.input 存在 → reason 含真实理由", async () => {
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve("Deny")),
				custom: vi.fn(),
				input: vi.fn(() => Promise.resolve("not safe for prod")),
			},
		});
		const decision = await requestUserApproval(req, ctx, undefined, approvalCtx);
		expect(decision.approved).toBe(false);
		expect(decision.reason).toBe("denied via rpc: not safe for prod");
		expect(approvalCtx.ui.input).toHaveBeenCalledOnce();
	});

	it("用户选 Deny + ctx.ui.input 缺失 → reason 是 fallback 文案", async () => {
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve("Deny")),
				custom: vi.fn(),
			},
		});
		const decision = await requestUserApproval(req, ctx, undefined, approvalCtx);
		expect(decision.approved).toBe(false);
		expect(decision.reason).toBe("denied via rpc");
	});

	it("用户选 Approve → 不调 input（approve 不需要理由）", async () => {
		const inputMock = vi.fn(() => Promise.resolve("should-not-be-called"));
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve("Approve (once)")),
				custom: vi.fn(),
				input: inputMock,
			},
		});
		const decision = await requestUserApproval(req, ctx, undefined, approvalCtx);
		expect(decision.approved).toBe(true);
		expect(inputMock).not.toHaveBeenCalled();
	});
});
