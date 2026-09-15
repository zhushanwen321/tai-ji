/**
 * 事件 6: agent_end（FR-8.7 + ESC 守卫 + 并发保护）。
 *
 * 关键约定：
 * - FR-8.2 G-021 防重入：session.isProcessing 入口加锁，finally 释放
 * - FR-8.2 G-020 stale 快照：入口 makeStaleChecker snapshot goalId，每个副作用前 checkStale
 * - FR-6.7 ESC 守卫（最关键）：ctx.signal?.aborted → 不发 continuation、不做 budget 检查、
 *   不做任何状态变更，goal 保持 active，等用户下次输入恢复
 *
 * #8 后流程：budget 预警/steering → continuation 去抖 + 轮次活性熔断（W5：
 * 连发总次数封顶 + 无进展退避 + defer 通知去重，见 handleContinuation 头注）。
 * agent_end 只做提醒（warning + steering），不做终态转换。
 * 终态转换不在 agent_end——由 persistAndUpdate 兜底（#5 范围，单一检查点）。
 *
 * 全解耦：不再做 allTasksDone followUp（原依赖 pi.__todoGetList，跨 ext 失效）。
 * todo 是否全完成由 AI 自行判断（prompt 软建议）。
 *
 * ESC 路径：aborted 时直接 return（goal 保持 active）。注意 ESC 守卫在终态/非 active
 * 检查之后——终态 goal 仍走终态 notify（不被 ESC 影响），非 active 状态直接返回。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { countActiveFromEntries } from "@zhushanwen/pi-pending-notifications";

import { checkBudgetOnTurnEnd } from "../../engine/budget";
import { isActiveStatus, isTerminalStatus } from "../../engine/goal";
import {
	type LivenessConfig,
	continuationBackoffDelayMs,
	countToolCallBlocks,
	isContinuationCapped,
	isProgressSignal,
	nextNoProgressTurns,
	pendingSetChanged,
	resolveLivenessConfig,
} from "../../engine/liveness";
import {
	budgetLimitPrompt,
	continuationPrompt,
} from "../../projection/prompts";
import { persistAndUpdate, tickState } from "../../service";
import { serializeState } from "../../persistence";
import { cancelContinuationTimer, type GoalSession } from "../../session";
import type { ServicePorts } from "../../service";
import { buildPorts } from "../ports";

export async function handleAgentEnd(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
): Promise<void> {
	if (!session.state || session.isProcessing) return;
	session.isProcessing = true;
	try {
		const checkStale = makeStaleChecker(session);
		if (checkStale()) return;
		const ports = buildPorts(pi, ctx);

		// 终态处理（complete / blocked）
		if (session.state.status === "complete" || session.state.status === "blocked") {
			await handleTerminalStateAgentEnd(session, ports, ctx, checkStale);
			return;
		}
		if (!isActiveStatus(session.state.status)) return;

		// FR-6.7 ESC 守卫（最关键）：aborted 时 goal 保持 active，不做任何副作用
		if (ctx.signal?.aborted) {
			return;
		}

		// 预算检查（仅 token 维度）——先 tick 把当前运行段计入 timeUsedSeconds，
		// 否则累计耗时（timeUsedSeconds）记账会比实际晚一轮（回归修复）
		tickState(session.state);
		const budgetResult = checkBudgetOnTurnEnd(session.state);
		const budgetAction = await handleBudgetChecks(ports, session, ctx, budgetResult, checkStale);
		if (budgetAction !== "continue") return;

		// continuation 去抖（budget 预警未拦截时）
		await handleContinuation(pi, ports, session, ctx, checkStale);
	} finally {
		session.isProcessing = false;
	}
}

/** 终态 agent_end：persist + notify（complete/blocked 各一条消息）。 */
async function handleTerminalStateAgentEnd(
	session: GoalSession,
	ports: ServicePorts,
	ctx: ExtensionContext,
	checkStale: () => boolean,
): Promise<void> {
	const state = session.state!;
	if (persistAndUpdate(session, ports, checkStale)) return;
	if (state.status === "complete") {
		ctx.ui.notify(`Objective completed ✓ (${state.currentTurnIndex} turns)`, "info");
	} else {
		ctx.ui.notify(
			"Goal blocked. Use /goal resume to continue or /goal clear to reset.",
			"warning",
		);
	}
}

type BudgetAction = "continue" | "stop";

/**
 * 仅 token 维度预算检查（#8 后只做提醒，不做终态）：
 * - 预警（warning70/warning90）：set flag + notify（不阻塞 continuation）
 * - 90% steering（shouldSendSteering）：set flag + 发 budgetLimitPrompt（收尾），返回 "stop" 中断 continuation
 *
 * 终态转换（budget 耗尽）不在 agent_end，由 persistAndUpdate 兜底（#5 范围，单一检查点）。
 */
async function handleBudgetChecks(
	ports: ServicePorts,
	session: GoalSession,
	ctx: ExtensionContext,
	budgetResult: ReturnType<typeof checkBudgetOnTurnEnd>,
	checkStale: () => boolean,
): Promise<BudgetAction> {
	const state = session.state!;

	// 发送预警（仅 token 维度）
	for (const w of budgetResult.warnings) {
		if (w.type === "warning90") {
			state.tokenWarning90Sent = true;
			ctx.ui.notify("Token budget 90% used — start wrapping up.", "warning");
		} else if (w.type === "warning70") {
			state.tokenWarning70Sent = true;
			ctx.ui.notify("Token budget 70% used — keep scope in check.", "info");
		}
	}

	// 90% steering → 收尾
	if (budgetResult.shouldSendSteering) {
		state.budgetLimitSteeringSent = true;
		if (persistAndUpdate(session, ports, checkStale)) return "stop";
		ports.messaging.sendContextMessage(
			budgetLimitPrompt(state),
			"steer",
		);
		return "stop";
	}

	if (checkStale()) return "stop";
	return "continue";
}

/**
 * continuation 去抖 + 轮次活性熔断（budget 预警未拦截时的尾部逻辑）。
 *
 * - continuation 去抖：tokenDelta=0（空 turn）不发，只 persist
 * - W5 主判据：continuation 连发总次数封顶（默认 50，PI_GOAL_CONTINUATION_CAP）——
 *   封顶必停发 + notify 用户 + goal 保持 active（不擅自终态）。与「是否调工具」
 *   正交：计数只在 deliverContinuation 实发时 +1，绝不被工具调用清零
 *   （2026-09-08 事故：pending 守卫击穿后 64 分钟 ~320 turn 空转，无任何熔断）。
 * - W5 辅判据：连续 N 轮（默认 5）无工具调用且 tokenDelta 低于阈值 → continuation
 *   延迟 base×2^level 发出（间隔 ×2 递增）；真实进展清零退避计数（不动总次数）。
 * - W5 defer 通知去重：pending 集合不变的连续 defer 轮不重复 notify。
 *
 * 注：maxTurnsReached / stall 自动终态分支随 #6 删除；budget terminal 分支随 #8 删除。
 * 终态转换由 persistAndUpdate 兜底（#5 范围，单一检查点）。
 */
async function handleContinuation(
	pi: ExtensionAPI,
	ports: ServicePorts,
	session: GoalSession,
	ctx: ExtensionContext,
	checkStale: () => boolean,
): Promise<void> {
	const state = session.state!;
	if (checkStale()) return;

	const cfg = resolveLivenessConfig();
	const entries = ctx.sessionManager.getEntries();

	// FR-8.6: continuation 去抖（空 turn 不发）
	const tokenDelta = state.tokensUsed - state.lastTurnTokensUsed;
	state.lastTurnTokensUsed = state.tokensUsed;

	// W5 辅判据记账：本 turn（自上次 agent_end 以来）真实工具活动 = toolCall 块差分。
	// 无进展 → 计数 +1；有进展（工具调用或 tokenDelta 越阈值）→ 清零退避计数
	// （主判据 continuationsSent 不在此处触碰——正交性）。
	const toolCallsTotal = countToolCallBlocks(entries);
	const toolDelta = toolCallsTotal - state.toolCallsSeen;
	state.toolCallsSeen = toolCallsTotal;
	state.noProgressTurns = nextNoProgressTurns(
		state.noProgressTurns,
		isProgressSignal(toolDelta, tokenDelta, cfg),
	);

	// pending 守卫：有活跃 background subagent/workflow 时不发 continuation。
	// 靠 subagent/workflow 完成时 sendMessage({triggerTurn:true,deliverAs:"steer"}) 自然唤醒主 agent；
	// goal 抢先催会与异步任务完成通知叠加，形成“停不下来”的死循环——continuation 排入
	// _followUpMessages 队列 → _handlePostAgentRun 的 hasQueuedMessages() 返回 true → agent.continue()
	// 新 turn → 又 agent_end → 又 continuation。
	// 刻意不校验 expiresAt：长任务 subagent（>1h TTL）完成时仍 triggerTurn 唤醒主 agent，
	// 按 TTL 判非活跃会让死循环在长任务场景复现。
	// [W4 读侧过滤①消费口] 传当前 session 基准：fork 继承的父级注册残留不进差集
	// （守卫不幻 defer）；设计 D4「读侧过滤一刀」在本消费口的落地（W6 探针实测
	// registry-fork-filter.test.ts 证不传则虚增，A9② 验收口径）。
	const pendingOps = countActiveFromEntries(entries, {
		currentSessionId: ctx.sessionManager.getSessionId(),
	});
	let deferred = false;
	if (pendingOps.count > 0) {
		deferred = true;
		pi.appendEntry("goal:log", {
			timestamp: Date.now(),
			level: "debug",
			component: "goal:agent-end",
			message: `continuation deferred: ${pendingOps.count} active pending operation(s)`,
			data: { activePending: pendingOps.count, ids: pendingOps.ids },
		});
		// W5 defer 通知去重：状态变化（pending 集合变化或首次进入 defer）才 notify——
		// 事故中每轮 agent_end 都发「Goal waiting for N…」，集合不变时是纯噪音。
		// 用户可见反馈保留：deferred 无反馈时用户只看到 goal active 但无产出，
		// 无法区分等待 vs 死循环。
		if (pendingSetChanged(pendingOps.ids, state.lastDeferredPendingIds)) {
			ctx.ui.notify(
				`Goal waiting for ${pendingOps.count} background task(s) to complete.`,
				"info",
			);
			state.lastDeferredPendingIds = [...pendingOps.ids].sort();
		}
	} else {
		// 非 defer 轮清空去重锚：每个等待 episode 的首次 defer 都会通知一次
		state.lastDeferredPendingIds = [];
	}

	// 单次 persist（H2 合并）：熔断计数（noProgressTurns / toolCallsSeen /
	// lastDeferredPendingIds）随同一快照落盘。budget 终态检查点在 persistAndUpdate
	// 内部（#5 单一检查点），与调用位置无关——合并不影响预算终态触发时机（explorer 论证）。
	persistAndUpdate(session, ports);
	if (deferred) {
		// defer 轮：已 persist + 已去重通知，不发 continuation
		return;
	}
	if (tokenDelta <= 0) {
		// 空 turn：已 persist，不发 continuation
		return;
	}
	// 终态守卫：persistAndUpdate 可能把 goal 转为 budget_limited 终态。
	// 此时不应发 continuation（deliverAs:"followUp" 会触发新 turn，让已耗尽预算的 agent 再跑一轮）。
	if (isTerminalStatus(state.status)) return;

	// W5 主判据：连发总次数封顶（与是否调工具正交——toolDelta 只影响辅判据退避）。
	// 封顶必停发 + 通知一次（含恢复指引）+ goal 保持 active（不擅自终态）。
	if (isContinuationCapped(state, cfg)) {
		if (!state.continuationCapNotified) {
			state.continuationCapNotified = true;
			ports.ui.notify(
				`Goal continuation stopped: ${cfg.continuationCap} continuations sent this cycle without completing (no-progress circuit breaker). The goal stays active. Use /goal resume to continue with a fresh allowance, or /goal clear to stop.`,
				"warning",
			);
			pi.appendEntry("goal:log", {
				timestamp: Date.now(),
				level: "info",
				component: "goal:agent-end",
				message: `continuation capped: ${state.continuationsSent}/${cfg.continuationCap} sent, stopping (goal stays active; /goal resume resets)`,
				data: { continuationsSent: state.continuationsSent, cap: cfg.continuationCap },
			});
			// 停发标志单独落盘（罕见路径——每激活周期至多一次）：否则下次 persist 前
			// 进程重启会让停发通知重发一次
			ports.persistence.appendState(serializeState(state));
		}
		return;
	}

	// W5 辅判据：无进展退避。到决策点先取消旧的待发退避 continuation——等待期内若
	// 有外部驱动的 turn（用户输入 / 后台任务通知唤醒）到达这里，按最新状态重算：
	// 有进展 → 立即发；仍无进展 → 按当前等级重排。保证任意时刻至多一个待发。
	cancelContinuationTimer(session);

	const delayMs = continuationBackoffDelayMs(state.noProgressTurns, cfg);
	if (delayMs <= 0) {
		deliverContinuation(ports, session);
		return;
	}
	pi.appendEntry("goal:log", {
		timestamp: Date.now(),
		level: "debug",
		component: "goal:agent-end",
		message: `continuation delayed by backoff: ${delayMs}ms (no-progress turns: ${state.noProgressTurns})`,
		data: { delayMs, noProgressTurns: state.noProgressTurns },
	});
	const goalId = state.goalId;
	session.continuationTimer = setTimeout(() => {
		session.continuationTimer = null;
		// MF-6②：timer 回调跨生命周期持有本次 agent_end 的 ctx/ports 闭包，且不在
		// pi runner 的 handler 错误隔离范围内——回调内同步异常 = uncaughtException，
		// 可能带崩 pi 进程。整体 try/catch：stale ctx（session 关闭/替换后 ctx 的
		// isIdle / sessionManager getter 走 assertActive 抛错，development-guide
		// §11.1）等异常降级为一条 goal:log 记录后放弃，goal 状态仍在盘上，后续任意
		// agent_end 会重新决策。（正常运行时路径的兜底：session_shutdown 已在
		// invalidate 前取消旧 timer，stale 到期属极端残留场景。）
		try {
			fireBackoffContinuation(session, ports, ctx, cfg, goalId);
		} catch (err) {
			// MF-R2-1 兜底：pi.appendEntry 与 ctx 同生命周期（loader.js appendEntry
			// 首行 assertActive，0.84.4 实装核对）——stale 场景此调用同样必抛，
			// 故降级日志自包 try/catch，保证 catch 块自身零抛出。放弃日志无害：
			// goal 状态在盘上，后续任意 agent_end 会重新决策。
			try {
				pi.appendEntry("goal:log", {
					timestamp: Date.now(),
					level: "warn",
					component: "goal:agent-end",
					message: `backoff continuation dropped after error: ${String(err)}`,
				});
			} catch (logErr) {
				// 刻意放弃：appendEntry（goal:log 落盘通道）自身失效的场景（stale /
				// runtime 失效）下再调任何 runtime 方法都会二次抛出——本 catch 存在的
				// 意义即阻断该 uncaughtException 路径。void 显式忽略，对齐
				// extension-logger 内部 appendEntry 失败兜底的既定惯例。
				void logErr;
			}
		}
	}, delayMs);
}

/**
 * 退避 timer 到期后的发射前守卫 + 实发（延迟期间状态可能已变）：
 * - goal 未被覆盖/清除（goalId 比对）、仍 active
 * - MF-6① idle 守卫：ctx.signal 为实时求值（pi-agent-core agent.js get signal 返回
 *   activeRun?.abortController.signal），agent idle 后恒 undefined，`signal?.aborted`
 *   恒放行、不可作守卫；改用 ctx.isIdle()（SDK types.d.ts L232）——延迟窗内有活动
 *   turn 时不发，该轮 agent_end 会按最新状态重新决策
 * - 未封顶、无活跃 pending（等待期新出现的后台任务由其完成通知唤醒，goal 不抢先催）
 */
function fireBackoffContinuation(
	session: GoalSession,
	ports: ServicePorts,
	ctx: ExtensionContext,
	cfg: LivenessConfig,
	goalId: string,
): void {
	if (!session.state || session.state.goalId !== goalId) return;
	if (!isActiveStatus(session.state.status)) return;
	if (!ctx.isIdle()) return;
	if (isContinuationCapped(session.state, cfg)) return;
	if (countActiveFromEntries(ctx.sessionManager.getEntries(), { currentSessionId: ctx.sessionManager.getSessionId() }).count > 0) return;
	deliverContinuation(ports, session);
}

/**
 * 发出一次 continuation 并立即落盘计数（主判据只在实发时 +1，发出即持久化——
 * 崩溃后封顶计数不从零开始）。
 */
function deliverContinuation(ports: ServicePorts, session: GoalSession): void {
	const state = session.state!;
	state.continuationsSent += 1;
	ports.messaging.sendContextMessage(continuationPrompt(state), "followUp");
	ports.persistence.appendState(serializeState(state));
}

/**
 * 构造 stale-check 闭包（FR-8.2 G-020）：入口快照 goalId，后续判断是否被新 goal 覆盖。
 *
 * 用法（agent_end）：
 * ```ts
 * const checkStale = makeStaleChecker(session);
 * // ... 长流程 ...
 * if (checkStale()) return; // goal 被覆盖，本次 agent_end 作废
 * ```
 *
 * 语义：snapshot 时 session.state 可能为 null（首次启动），此时 snapshotGoalId
 * 为 undefined；后续若有新 goal（goalId !== undefined）即视为 stale。
 */
export function makeStaleChecker(session: GoalSession): () => boolean {
	const snapshotGoalId = session.state?.goalId;
	return () => !session.state || session.state.goalId !== snapshotGoalId;
}
