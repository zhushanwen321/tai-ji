/**
 * 轮次活性熔断行为测试（chat-domain-v1x 设计 §3.2 D4 / W5，验收 §4 A10 的单测面）
 *
 * 四断言（对齐 impl-plan W5 验收条款②）：
 * a. 主判据 50 次封顶必停发——含「每轮调一次工具」序列同样被封顶（正交性：
 *    工具调用只清零退避计数，绝不清零总次数——设计 R1 击穿记录的反向锁定）；
 * b. 连续 5 轮无工具调用且低 tokenDelta → 第 5 轮起间隔翻倍（×2 递增）；
 * c. 恢复（真实工具调用）清零退避计数但不重置主判据总次数；
 * d. defer 通知：pending 集合不变的连续 defer 轮中通知条数不增长。
 *
 * 另覆盖：停发通知含 /goal resume 恢复指引 + goal 保持 active；/goal resume
 * 恢复通道重置计数；未封顶 active goal 的 resume 语义不变。
 *
 * fake timers + fake pi/ctx（不 import Pi SDK 真实实现，harness 对齐 __tests__/event-adapter.test.ts）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleAgentEnd } from "../adapters/event-handlers/agent-end";
import { handleBeforeAgentStart } from "../adapters/event-handlers/before-agent-start";
import { handleSessionShutdown } from "../adapters/event-handlers/session-shutdown";
import { handleSessionStart } from "../adapters/event-handlers/session-start";
import { handleGoalCommand } from "../adapters/command-adapter";
import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import { createGoalSession, type GoalSession } from "../session";

// ── Fake pi / ctx（entries 数组可变，模拟 append-only 会话流）──

interface RecordedCall {
	kind: "appendState" | "appendHistory" | "notify" | "sendContext" | "sendUser";
	payload?: unknown;
	text?: string;
	level?: string;
	content?: unknown;
}

interface FakeHarness {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	entries: unknown[];
	piCalls: RecordedCall[];
	ctxCalls: RecordedCall[];
	/** 可控 isIdle（MF-6① 守卫断言用：延迟窗内有活动 turn 时置 false） */
	isIdle: { value: boolean };
	/**
	 * 可控 appendEntry 抛错（MF-R2-1 测试前提修正）：pi.appendEntry 与 ctx 同生命周期
	 * （loader.js appendEntry 首行 assertActive，0.84.4 实装核对）——模拟全量 stale
	 * 时必须置 true 按 SDK 契约抛错，否则测试默许了真实场景必抛的调用
	 */
	appendEntryFails: { value: boolean };
}

/** runner.js invalidate 默认 stale 文案首句（0.84.4 实装），assertActive 据此抛出 */
const STALE_CTX_MESSAGE = "This extension ctx is stale after session replacement or reload.";

function makeHarness(): FakeHarness {
	const piCalls: RecordedCall[] = [];
	const ctxCalls: RecordedCall[] = [];
	const entries: unknown[] = [];
	const isIdle = { value: true };
	const appendEntryFails = { value: false };

	const pi = {
		appendEntry(customType: string, data?: unknown): void {
			if (appendEntryFails.value) {
				throw new Error(STALE_CTX_MESSAGE);
			}
			piCalls.push({ kind: customType === "goal-history" ? "appendHistory" : "appendState", payload: data });
		},
		sendMessage(message: unknown, options?: unknown): void {
			const msg = message as { content?: unknown };
			piCalls.push({ kind: "sendContext", content: msg.content, payload: options });
		},
		sendUserMessage(content: string | unknown[], _options?: unknown): void {
			piCalls.push({ kind: "sendUser", content });
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		signal: { aborted: false } as AbortSignal,
		// MF-6①：SDK ExtensionContext.isIdle（types.d.ts L232），agent_end 后为 true
		isIdle: () => isIdle.value,
		getContextUsage: () => null,
		ui: {
			notify: (text: string, level: string) => ctxCalls.push({ kind: "notify", text, level }),
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => undefined,
			// W4 读侧过滤①消费口（agent-end 两处 countActiveFromEntries 传基准）
			getSessionId: () => "test-session",
		},
	} as unknown as ExtensionContext;

	return { pi, ctx, entries, piCalls, ctxCalls, isIdle, appendEntryFails };
}

// ── 辅助 ─────────────────────────────────────────────

function makeRunningState(overrides?: Partial<GoalRuntimeState>): GoalRuntimeState {
	return {
		...createGoalState("test objective"),
		timeStartedAt: 0, // 关闭时间累计口径（本文件不断言耗时）
		...overrides,
	};
}

/** assistant message entry，content 含 1 个 toolCall 块（pi 实测形态：toolCall 在 content 数组） */
function assistantToolCallEntry(id: string): unknown {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "working" }, { type: "toolCall", id, name: "bash", arguments: {} }],
		},
	};
}

/** pending:register custom entry（对齐 countActiveFromEntries 读取契约） */
function pendingRegisterEntry(id: string): unknown {
	return { type: "custom", customType: "pending:register", data: { id, type: "subagent", name: "worker" } };
}

/** 实际发出的 continuation（followUp custom message）计数 */
function followUpSends(h: FakeHarness): RecordedCall[] {
	return h.piCalls.filter(
		(c) => c.kind === "sendContext" && (c.payload as { deliverAs?: string } | undefined)?.deliverAs === "followUp",
	);
}

function notifyTexts(h: FakeHarness, level?: string): string[] {
	return h.ctxCalls.filter((c) => c.kind === "notify" && (!level || c.level === level)).map((c) => c.text!);
}

/** 模拟一个 turn 结束：tokenDelta 注入 + 可选工具调用 + agent_end */
async function runTurn(
	h: FakeHarness,
	session: GoalSession,
	opts: { tokenDelta: number; toolCallId?: string },
): Promise<void> {
	const state = session.state!;
	state.tokensUsed += opts.tokenDelta;
	if (opts.toolCallId) h.entries.push(assistantToolCallEntry(opts.toolCallId));
	await handleAgentEnd(h.pi, session, h.ctx);
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ── 断言 a：主判据 50 次封顶（正交性）─────────────────

describe("主判据：continuation 连发总次数封顶", () => {
	it("每轮调一次工具（R1 击穿形态）连续 50 轮后必停发；停发通知含恢复指引；goal 保持 active", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeRunningState();

		for (let i = 1; i <= 50; i++) {
			await runTurn(h, session, { tokenDelta: 200, toolCallId: `tc-${i}` });
		}
		expect(followUpSends(h)).toHaveLength(50);
		expect(session.state!.continuationsSent).toBe(50);
		// 每轮都有工具调用 → 有进展 → 从未进入退避（无待发定时器）
		expect(session.continuationTimer).toBeNull();

		// 第 51 轮：同样有工具调用、tokenDelta>0，仍被封顶拦截（正交：工具调用绕不过封顶）
		await runTurn(h, session, { tokenDelta: 200, toolCallId: "tc-51" });
		expect(followUpSends(h)).toHaveLength(50); // 停发
		expect(session.state!.continuationsSent).toBe(50); // 总数封在 50
		expect(session.state!.status).toBe("active"); // goal 保持 active（不擅自终态）

		const warnings = notifyTexts(h, "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("circuit breaker");
		expect(warnings[0]).toContain("/goal resume"); // 恢复指引

		// 第 52 轮：停发通知不重复
		await runTurn(h, session, { tokenDelta: 200, toolCallId: "tc-52" });
		expect(followUpSends(h)).toHaveLength(50);
		expect(notifyTexts(h, "warning")).toHaveLength(1);
	});
});

// ── 断言 b：辅判据无进展退避 ─────────────────────────

describe("辅判据：无进展退避（间隔 ×2 递增）", () => {
	it("连续 5 轮无工具调用且低 tokenDelta → 第 5 轮起间隔翻倍（5 轮 2×base、6 轮 4×base）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeRunningState();

		// 轮 1-4：未达阈值 → 立即发出
		for (let i = 1; i <= 4; i++) {
			await runTurn(h, session, { tokenDelta: 200 });
			expect(followUpSends(h)).toHaveLength(i); // 同步发出，无延迟
		}

		// 轮 5：noProgressTurns=5 → 延迟 2×base = 20s（base 默认 10s）
		await runTurn(h, session, { tokenDelta: 200 });
		expect(followUpSends(h)).toHaveLength(4); // 未立即发
		expect(session.continuationTimer).not.toBeNull(); // 已排定退避定时器
		vi.advanceTimersByTime(19_999);
		expect(followUpSends(h)).toHaveLength(4); // 20s 边界前不发
		vi.advanceTimersByTime(1);
		expect(followUpSends(h)).toHaveLength(5); // 20s 整点发出
		expect(session.state!.continuationsSent).toBe(5);

		// 轮 6：间隔再翻倍 → 4×base = 40s
		await runTurn(h, session, { tokenDelta: 200 });
		expect(followUpSends(h)).toHaveLength(5);
		vi.advanceTimersByTime(39_999);
		expect(followUpSends(h)).toHaveLength(5);
		vi.advanceTimersByTime(1);
		expect(followUpSends(h)).toHaveLength(6);
	});
});

// ── 断言 c：恢复清零退避但不重置总数 ─────────────────

describe("恢复条件：真实工具调用", () => {
	it("清零退避计数（下一轮立即发），但不重置主判据总次数", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeRunningState();

		// 进入退避：5 轮无进展（4 立即 + 1 延迟）
		for (let i = 0; i < 4; i++) await runTurn(h, session, { tokenDelta: 200 });
		await runTurn(h, session, { tokenDelta: 200 });
		vi.advanceTimersByTime(20_000);
		expect(followUpSends(h)).toHaveLength(5);
		expect(session.state!.noProgressTurns).toBe(5);

		// 轮 6：真实工具调用 → 进展 → noProgressTurns 清零，立即发（无定时器）
		await runTurn(h, session, { tokenDelta: 200, toolCallId: "tc-recover" });
		expect(session.state!.noProgressTurns).toBe(0);
		expect(session.continuationTimer).toBeNull();
		expect(followUpSends(h)).toHaveLength(6); // 同步发出
		expect(session.state!.continuationsSent).toBe(6); // 总次数不重置（正交性）

		// 轮 7：再次无进展 → 计数从 1 重新累计，间隔回到立即
		await runTurn(h, session, { tokenDelta: 200 });
		expect(session.state!.noProgressTurns).toBe(1);
		expect(followUpSends(h)).toHaveLength(7);
	});
});

// ── 断言 d：defer 通知去重 ───────────────────────────

describe("defer 通知去重", () => {
	it("pending 集合不变的连续 defer 轮中通知条数不增长；集合变化才再发", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeRunningState();
		h.entries.push(pendingRegisterEntry("bg-1"));

		for (let i = 0; i < 3; i++) {
			await runTurn(h, session, { tokenDelta: 200 });
		}
		expect(followUpSends(h)).toHaveLength(0); // defer 轮不发 continuation
		const waitNotifies = () => notifyTexts(h).filter((t) => t.includes("waiting"));
		expect(waitNotifies()).toHaveLength(1); // 集合不变 → 3 轮只通知 1 次
		expect(waitNotifies()[0]).toContain("1 background task");

		// 集合变化（新增 bg-2）→ 再通知一次（含新计数）
		h.entries.push(pendingRegisterEntry("bg-2"));
		await runTurn(h, session, { tokenDelta: 200 });
		expect(waitNotifies()).toHaveLength(2);
		expect(waitNotifies()[1]).toContain("2 background task");

		// 集合再次不变 → 不增长
		await runTurn(h, session, { tokenDelta: 200 });
		expect(waitNotifies()).toHaveLength(2);
	});
});

// ── 恢复通道：/goal resume ───────────────────────────

describe("/goal resume 恢复通道", () => {
	it("封顶停发后 resume → 熔断计数清零 + 触发 AI + 后续 agent_end 恢复发送", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		// 直接构造封顶临界态（continuationsSent=50），经一次 agent_end 触发停发分支
		session.state = makeRunningState({ continuationsSent: 50 });
		await runTurn(h, session, { tokenDelta: 200 });
		expect(session.state!.continuationCapNotified).toBe(true);
		expect(followUpSends(h)).toHaveLength(0);

		await handleGoalCommand(h.pi, session, "resume", h.ctx);
		expect(session.state!.continuationsSent).toBe(0); // 新激活周期
		expect(session.state!.continuationCapNotified).toBe(false);
		expect(session.state!.status).toBe("active");
		const userSends = h.piCalls.filter((c) => c.kind === "sendUser");
		expect(userSends).toHaveLength(1); // FR-8.12 触发 AI

		// 恢复后：下一次 agent_end 正常发 continuation（新周期额度）
		await runTurn(h, session, { tokenDelta: 200 });
		expect(followUpSends(h)).toHaveLength(1);
	});

	it("未封顶的普通 active goal → resume 提示无需恢复（原语义不变）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeRunningState();

		await handleGoalCommand(h.pi, session, "resume", h.ctx);

		expect(notifyTexts(h).some((t) => t.includes("no need to resume"))).toBe(true);
		expect(h.piCalls.filter((c) => c.kind === "sendUser")).toHaveLength(0);
	});
});

// ── MF-6（round1 review）：退避 timer 回调跨生命周期防护 ──

/** 进入退避态：4 轮立即发 + 第 5 轮延迟 20s 排定 timer（base 默认 10s ×2） */
async function enterBackoff(): Promise<{ h: FakeHarness; session: GoalSession }> {
	const h = makeHarness();
	const session = createGoalSession();
	session.state = makeRunningState();
	for (let i = 0; i < 4; i++) await runTurn(h, session, { tokenDelta: 200 });
	await runTurn(h, session, { tokenDelta: 200 });
	expect(session.continuationTimer).not.toBeNull();
	return { h, session };
}

describe("MF-6① idle 守卫：ctx.signal 实时求值失效场景由 isIdle 拦截", () => {
	it("延迟窗内有活动 turn（isIdle=false、signal=undefined）→ 到期不误发", async () => {
		const { h, session } = await enterBackoff();

		// agent idle 后 SDK get signal 实时求值为 undefined（旧 signal?.aborted 守卫恒放行）；
		// 用户在延迟窗内发新消息 → 活动 turn 占用 → isIdle=false
		h.ctx.signal = undefined;
		h.isIdle.value = false;
		vi.advanceTimersByTime(20_000);

		expect(followUpSends(h)).toHaveLength(4); // 不误发（该轮 agent_end 会重新决策）
		expect(session.state!.continuationsSent).toBe(4);
	});

	it("延迟窗内 idle（isIdle=true、signal=undefined）→ 正常发出（守卫不误伤退避路径）", async () => {
		const { h, session } = await enterBackoff();

		h.ctx.signal = undefined;
		vi.advanceTimersByTime(20_000);

		expect(followUpSends(h)).toHaveLength(5);
		expect(session.state!.continuationsSent).toBe(5);
	});
});

describe("MF-6② stale 保护：timer 回调内异常不冒泡（catch 块自身零抛出）", () => {
	it("全量 stale（isIdle / getEntries / appendEntry 均按 SDK 契约抛错）→ 不崩、不发、不产生任何调用", async () => {
		const { h, session } = await enterBackoff();

		// SDK 契约（0.84.4 实装核对）：invalidate 后 isIdle / sessionManager getter
		// （runner.js assertActive）与 pi.appendEntry（loader.js appendEntry 首行
		// assertActive）全部抛错——旧 fake appendEntry 永不抛，默许了真实场景必抛的调用
		h.ctx.isIdle = () => {
			throw new Error(STALE_CTX_MESSAGE);
		};
		(h.ctx.sessionManager as { getEntries: () => unknown }).getEntries = () => {
			throw new Error(STALE_CTX_MESSAGE);
		};
		h.appendEntryFails.value = true;
		const callsBefore = h.piCalls.length;

		expect(() => vi.advanceTimersByTime(20_000)).not.toThrow();

		expect(followUpSends(h)).toHaveLength(4); // 不发 continuation
		expect(session.state!.continuationsSent).toBe(4);
		expect(h.piCalls).toHaveLength(callsBefore); // 降级日志 stale 下同样必抛 → 放弃
	});

	it("回调内非 stale 异常（getEntries 抛运行时错误、appendEntry 可用）→ 降级 warn 落一条", async () => {
		const { h, session } = await enterBackoff();

		(h.ctx.sessionManager as { getEntries: () => unknown }).getEntries = () => {
			throw new Error("entries read failed");
		};
		expect(() => vi.advanceTimersByTime(20_000)).not.toThrow();

		expect(followUpSends(h)).toHaveLength(4); // 不发 continuation
		expect(session.state!.continuationsSent).toBe(4);
		// 降级诊断：非 stale 异常时 pi.appendEntry 可用，goal:log 落一条 warn
		const dropLogs = h.piCalls.filter(
			(c) => c.kind === "appendState" && (c.payload as { message?: string } | undefined)?.message?.includes("dropped after error"),
		);
		expect(dropLogs).toHaveLength(1);
		expect((dropLogs[0]!.payload as { level?: string }).level).toBe("warn");
	});
});

describe("MF-R2-1 根修：session_shutdown 取消旧退避 timer", () => {
	it("session_shutdown（invalidate 前触发）后旧 timer 到期不发；全量 stale 下不崩、不冒泡", async () => {
		const { h, session } = await enterBackoff();

		// SDK 触发序：所有失效路径（reload / new / resume / fork / quit）先 emit
		// session_shutdown 再 runner.invalidate——此刻 pi/ctx 仍可用
		await handleSessionShutdown(session);
		expect(session.continuationTimer).toBeNull();

		// 全量 stale 注入：若 timer 未被取消，回调在 isIdle 首查即抛、catch 内
		// appendEntry 二次抛出 → advanceTimersByTime 冒泡（本用例即红）
		h.ctx.isIdle = () => {
			throw new Error(STALE_CTX_MESSAGE);
		};
		(h.ctx.sessionManager as { getEntries: () => unknown }).getEntries = () => {
			throw new Error(STALE_CTX_MESSAGE);
		};
		h.appendEntryFails.value = true;
		const callsBefore = h.piCalls.length;

		expect(() => vi.advanceTimersByTime(20_000)).not.toThrow();
		expect(followUpSends(h)).toHaveLength(4); // 不发 continuation
		expect(session.state!.continuationsSent).toBe(4);
		expect(h.piCalls).toHaveLength(callsBefore); // 到期零回调（timer 已取消）
	});
});

describe("MF-6③ timer 清理面：session_start / before_agent_start 取消旧 timer", () => {
	it("session_start 重建 → 旧退避 timer 被取消，到期不发", async () => {
		const { h, session } = await enterBackoff();

		await handleSessionStart(h.pi, session, h.ctx);

		expect(session.continuationTimer).toBeNull();
		vi.advanceTimersByTime(20_000);
		expect(followUpSends(h)).toHaveLength(4);
	});

	it("before_agent_start（新用户活动）→ 旧退避 timer 被取消，到期不发", async () => {
		const { h, session } = await enterBackoff();

		await handleBeforeAgentStart(h.pi, session, h.ctx);

		expect(session.continuationTimer).toBeNull();
		vi.advanceTimersByTime(20_000);
		expect(followUpSends(h)).toHaveLength(4);
	});
});
