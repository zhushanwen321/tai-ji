/**
 * engine/liveness.ts 纯函数测试 — 轮次活性熔断判定单元（chat-domain-v1x D4 / W5）
 *
 * 覆盖：env 配置解析（合法/非法/缺省）、退避等级数学（第 N 轮起 ×2、指数天花板）、
 * 进展信号边界、toolCall 块计数（duck-typed 守卫）、pending 集合变化判定。
 * 行为级四断言（封顶/退避/恢复/defer 去重经 handleAgentEnd）见 circuit-breaker.test.ts。
 */
import { describe, expect, it } from "vitest";

import {
	continuationBackoffDelayMs,
	countToolCallBlocks,
	isProgressSignal,
	nextNoProgressTurns,
	pendingSetChanged,
	resolveLivenessConfig,
	type LivenessConfig,
} from "../engine/liveness";
import { createGoalState } from "../engine/goal";

const CFG: LivenessConfig = resolveLivenessConfig({});

// ── resolveLivenessConfig（env 覆盖）──────────────────

describe("resolveLivenessConfig", () => {
	it("缺省 env → 全默认值（50 / 5 / 1000 / 10s / 10min）", () => {
		const cfg = resolveLivenessConfig({});
		expect(cfg.continuationCap).toBe(50);
		expect(cfg.noProgressTurnsThreshold).toBe(5);
		expect(cfg.noProgressTokenThreshold).toBe(1000);
		expect(cfg.backoffBaseMs).toBe(10_000);
		expect(cfg.backoffMaxMs).toBe(600_000);
	});

	it("PI_GOAL_* 合法正整数 → 覆盖默认值", () => {
		const cfg = resolveLivenessConfig({
			PI_GOAL_CONTINUATION_CAP: "10",
			PI_GOAL_NO_PROGRESS_TURNS: "3",
			PI_GOAL_NO_PROGRESS_TOKEN_THRESHOLD: "500",
			PI_GOAL_BACKOFF_BASE_MS: "1000",
			PI_GOAL_BACKOFF_MAX_MS: "30000",
		});
		expect(cfg.continuationCap).toBe(10);
		expect(cfg.noProgressTurnsThreshold).toBe(3);
		expect(cfg.noProgressTokenThreshold).toBe(500);
		expect(cfg.backoffBaseMs).toBe(1000);
		expect(cfg.backoffMaxMs).toBe(30000);
	});

	it.each([
		["非数字", "abc"],
		["零", "0"],
		["负数", "-5"],
		["小数", "2.7"],
	])("非法值（%s）→ 回退默认（安全网不因坏配置挂掉）", (_label, raw) => {
		const cfg = resolveLivenessConfig({ PI_GOAL_CONTINUATION_CAP: raw });
		expect(cfg.continuationCap).toBe(50);
	});
});

// ── 进展信号 + 无进展计数 ────────────────────────────

describe("isProgressSignal / nextNoProgressTurns", () => {
	it("有工具调用（toolDelta>0）即进展，即使 tokenDelta 低", () => {
		expect(isProgressSignal(1, 100, CFG)).toBe(true);
	});

	it("tokenDelta 越阈值即进展，即使无工具调用（纯文本迭代型任务豁免退避）", () => {
		expect(isProgressSignal(0, 1000, CFG)).toBe(true);
		expect(isProgressSignal(0, 999, CFG)).toBe(false);
	});

	it("无进展 → 计数 +1；进展 → 清零", () => {
		expect(nextNoProgressTurns(4, false)).toBe(5);
		expect(nextNoProgressTurns(4, true)).toBe(0);
	});
});

// ── 退避等级数学 ─────────────────────────────────────

describe("continuationBackoffDelayMs", () => {
	it("未达阈值（1~4 轮）→ 0（立即发）", () => {
		expect(continuationBackoffDelayMs(0, CFG)).toBe(0);
		expect(continuationBackoffDelayMs(4, CFG)).toBe(0);
	});

	it("第 5 轮起 ×2 递增：5 轮 → 2×base，6 轮 → 4×base，7 轮 → 8×base", () => {
		expect(continuationBackoffDelayMs(5, CFG)).toBe(20_000);
		expect(continuationBackoffDelayMs(6, CFG)).toBe(40_000);
		expect(continuationBackoffDelayMs(7, CFG)).toBe(80_000);
	});

	it("指数封顶：delay 永不超过 backoffMaxMs", () => {
		expect(continuationBackoffDelayMs(50, CFG)).toBe(600_000);
		expect(continuationBackoffDelayMs(1000, CFG)).toBe(600_000);
	});
});

// ── toolCall 块计数 ──────────────────────────────────

describe("countToolCallBlocks", () => {
	it("assistant content 内 toolCall 块计数（多个 entry 累计）", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "hi" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "thinking..." },
						{ type: "toolCall", id: "tc-1", name: "bash" },
						{ type: "toolCall", id: "tc-2", name: "read" },
					],
				},
			},
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", id: "tc-3", name: "bash" }] },
			},
			{ type: "message", message: { role: "toolResult", content: [], toolName: "bash", toolCallId: "tc-1" } },
			{ type: "custom", customType: "goal-state", data: {} },
		];
		expect(countToolCallBlocks(entries)).toBe(3);
	});

	it("畸形 entry（null/非对象/缺 message/content 非数组）→ 跳过不计数", () => {
		expect(
			countToolCallBlocks([null, 42, "x", { type: "message" }, { type: "message", message: null }, {
				type: "message",
				message: { role: "assistant", content: "plain-string" },
			}]),
		).toBe(0);
	});
});

// ── pending 集合变化 ─────────────────────────────────

describe("pendingSetChanged", () => {
	it("集合相同（含顺序不同）→ 无变化", () => {
		expect(pendingSetChanged(["a", "b"], ["b", "a"])).toBe(false);
		expect(pendingSetChanged([], [])).toBe(false);
	});

	it("首次进入 defer（last 为空）或有增删 → 变化", () => {
		expect(pendingSetChanged(["a"], [])).toBe(true);
		expect(pendingSetChanged(["a"], ["a", "b"])).toBe(true);
		expect(pendingSetChanged(["a", "c"], ["a", "b"])).toBe(true);
	});
});

// ── createGoalState 初始化 ───────────────────────────

describe("createGoalState — W5 计数初始化", () => {
	it("新 goal 熔断计数全部从零开始", () => {
		const state = createGoalState("obj");
		expect(state.continuationsSent).toBe(0);
		expect(state.noProgressTurns).toBe(0);
		expect(state.continuationCapNotified).toBe(false);
		expect(state.lastDeferredPendingIds).toEqual([]);
		expect(state.toolCallsSeen).toBe(0);
	});
});
