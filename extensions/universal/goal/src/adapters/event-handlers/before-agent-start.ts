/**
 * 事件 5: before_agent_start（context wrap-up + injection）。
 *
 * FR-8.1 G-007 + FR-8.6。返回 message（注入到 LLM context）或 undefined（无注入）。
 *
 * 分支顺序：
 * 1. 终态：currentTurnIndex - completedAtTurnIndex >= AUTO_CLEAR_TURNS(2) → clearGoalSession
 * 2. ADR-002：Context 使用率 > 85% → 保持 active + 注入 wrap-up 指令
 * 3. 正常：注入 contextInjectionPrompt
 *
 * 无 ESC 守卫（before_agent_start 是 agent 开始前的信号，此时无 aborted 可能）。
 *
 * 全解耦：不再做 staleness 检测（原依赖 pi.__todoGetList，跨 ext 失效），
 * 不再探测 plan extension（原 typeof pi.__planStart，跨 ext 失效）。
 * contextInjectionPrompt 精简版（详尽审计收敛到 continuationPrompt，agent_end 发）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AUTO_CLEAR_TURNS, CONTEXT_USAGE_RATIO_LIMIT } from "../../constants";
import { isActiveStatus, isTerminalStatus } from "../../engine/goal";
import { contextInjectionPrompt } from "../../projection/prompts";
import { renderTerminalStatusLine } from "../../projection/widget";
import type { GoalSession } from "../../session";
import { cancelContinuationTimer, clearGoalSession } from "../../session";
import { buildPorts } from "../ports";

interface BeforeAgentStartResult {
	message: {
		customType: string;
		content: string;
		display: boolean;
	};
}

export async function handleBeforeAgentStart(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
): Promise<BeforeAgentStartResult | undefined> {
	// MF-6③：新用户活动（新 turn 开始）使旧的退避 continuation 作废——该轮
	// agent_end 会按最新状态重新决策。放在 state 检查之前：即使 goal 已清，
	// 旧 timer 也不该在新 turn 开始后仍存活
	cancelContinuationTimer(session);
	if (!session.state) return;

	pi.appendEntry("goal:log", {
		timestamp: Date.now(),
		level: "debug",
		component: "goal:before-agent-start",
		message: "handleBeforeAgentStart invoked",
		data: { status: session.state.status },
	});

	// 终态处理
	if (isTerminalStatus(session.state.status)) {
		handleTerminalStateBeforeAgent(pi, session, ctx);
		return;
	}
	if (!isActiveStatus(session.state.status)) return;

	// Context 使用率检查（ADR-002：保持 active，仅注入提示）
	const ctxResult = checkContextUsage(ctx);
	if (ctxResult) return ctxResult;

	// 正常 context injection（精简版，≤600 chars）。
	// plan 引导 / 详尽审计（intent≠evidence、预算耗尽≠完成、Fidelity）收敛到 continuationPrompt。
	// pending 感知由 LLM 自行调 pending_notifications tool（mandatory）查询当前活跃异步操作，
	// goal 不在此注入——避免与 tool 查询结果形成双信息源不一致（tool 是 EventBus+entries 维护的权威源）。
	return {
		message: {
			customType: "goal-context",
			content: contextInjectionPrompt(session.state),
			display: false,
		},
	};
}

/**
 * FR-8.1 G-007：终态 goal 在 AUTO_CLEAR_TURNS(2) 轮后自动清理。
 * 未到清理阈值时：折叠 status bar（显示终态单行），清 widget。
 */
function handleTerminalStateBeforeAgent(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
): void {
	const state = session.state!;
	const turnsInTerminal = state.currentTurnIndex - (state.completedAtTurnIndex ?? 0);
	if (turnsInTerminal >= AUTO_CLEAR_TURNS) {
		clearGoalSession(session, buildPorts(pi, ctx).ui);
		return;
	}
	// 折叠 status bar（终态显示）
	const statusText = renderTerminalStatusLine(state, buildPorts(pi, ctx).ui.theme);
	if (statusText && ctx.hasUI) ctx.ui.setStatus("goal", statusText);
	if (ctx.hasUI) ctx.ui.setWidget("goal", undefined);
}

/**
 * ADR-002 context usage 提示：getContextUsage 超过 CONTEXT_USAGE_RATIO_LIMIT(0.85)
 * → goal **保持 active**（不转 paused），仅注入 wrap-up 指令让 AI 自行 complete/cancel。
 * 不做状态变更、不 persist、不 tick（资源保护通过"提示"而非"状态机"实现）。
 */
function checkContextUsage(
	ctx: ExtensionContext,
): BeforeAgentStartResult | undefined {
	const usage = ctx.getContextUsage();
	if (
		usage &&
		usage.contextWindow > 0 &&
		(usage.tokens ?? 0) / usage.contextWindow > CONTEXT_USAGE_RATIO_LIMIT
	) {
		return {
			message: {
				customType: "goal-context-exceeded",
				content:
					"[GOAL — context space low, must wrap up now]\n" +
					"1. Check remaining work and verify what is genuinely completed\n" +
					"2. Only report completion for work backed by concrete evidence\n" +
					"3. Summarize current progress and remaining work\n" +
					"Do not start new work.",
				display: false,
			},
		};
	}
	return undefined;
}
