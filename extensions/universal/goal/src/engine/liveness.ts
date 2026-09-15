/**
 * 轮次活性熔断 — 纯函数（chat-domain-v1x 设计 §3.2 D4 / W5）
 *
 * 双维度互补（非二选一，职责不同）：
 * - 主判据：continuation 连发总次数独立上限。与「是否调工具」正交——计数绝不能被
 *   工具调用清零（设计 R1 击穿记录：旧提案「任何一轮有工具调用即清零」可被
 *   「每轮调一次 subagents list + 回一句等待」打成永不熔断）。清零只经用户显式
 *   /goal resume（新激活周期）。
 * - 辅判据：无进展退避。连续 N 轮无工具调用且 tokenDelta 低于阈值 → continuation
 *   间隔 ×2 递增；恢复 = 真实工具调用或 tokenDelta 越阈值（只清零退避计数）。
 *
 * 零 Pi 依赖（engine 层契约）。所有判定输入由调用方（agent-end）采集传入。
 */

import {
	DEFAULT_BACKOFF_BASE_MS,
	DEFAULT_BACKOFF_MAX_MS,
	DEFAULT_CONTINUATION_CAP,
	DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD,
	DEFAULT_NO_PROGRESS_TURNS,
} from "../constants";
import type { GoalRuntimeState } from "./types";

// ── 配置（env 可覆盖）─────────────────────────────────

export interface LivenessConfig {
	/** 主判据：单激活周期 continuation 连发总次数上限 */
	continuationCap: number;
	/** 辅判据：连续无进展轮数阈值（第 N 轮起退避） */
	noProgressTurnsThreshold: number;
	/** 辅判据：tokenDelta 低于此值视为低产出 */
	noProgressTokenThreshold: number;
	/** 辅判据：退避基础间隔 ms（×2 递增的基数） */
	backoffBaseMs: number;
	/** 辅判据：退避间隔上限 ms（指数天花板） */
	backoffMaxMs: number;
}

/**
 * 从 env 解析熔断配置（PI_GOAL_* 前缀，对齐 subagent-workflow 的 PI_SUBAGENT_* 风格）。
 *
 * 非法值（非数字 / 非正整数）一律回退默认值——熔断参数是安全网，坏配置降级为
 * 默认而非抛错挂掉 goal 循环。env 参数注入便于单测，不 mock 全局 process.env。
 */
export function resolveLivenessConfig(env: NodeJS.ProcessEnv = process.env): LivenessConfig {
	return {
		continuationCap: positiveIntEnv(env.PI_GOAL_CONTINUATION_CAP, DEFAULT_CONTINUATION_CAP),
		noProgressTurnsThreshold: positiveIntEnv(
			env.PI_GOAL_NO_PROGRESS_TURNS,
			DEFAULT_NO_PROGRESS_TURNS,
		),
		noProgressTokenThreshold: positiveIntEnv(
			env.PI_GOAL_NO_PROGRESS_TOKEN_THRESHOLD,
			DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD,
		),
		backoffBaseMs: positiveIntEnv(env.PI_GOAL_BACKOFF_BASE_MS, DEFAULT_BACKOFF_BASE_MS),
		backoffMaxMs: positiveIntEnv(env.PI_GOAL_BACKOFF_MAX_MS, DEFAULT_BACKOFF_MAX_MS),
	};
}

function positiveIntEnv(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	// Number + isInteger（而非 parseInt）：parseInt 会把 "2.7" 截断成 2 静默放行
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// ── 工具活动检测（辅判据输入）─────────────────────────

/** 退避乘数：间隔 = base × MULTIPLIER^level（设计语义「×2 递增」）。 */
const BACKOFF_MULTIPLIER = 2;

/**
 * 统计 session entries 中 assistant message content 里的 toolCall 块总数。
 *
 * pi 的工具调用落在 type="message"、role="assistant" 的 entry，content 数组内
 * `{type:"toolCall", id, name, arguments}` block（session-reader probe 实测 519/519，
 * message.toolCalls 顶层字段从未存在）。这里只数块个数——调用方以「相邻两次
 * agent_end 的差分」判定本 turn 是否有真实工具活动，不需要 name/arguments。
 *
 * duck-typed 逐层守卫（对齐 pending-notifications state.ts 的 EntryLike 风格），
 * 不依赖 SDK 具体类型；畸形 entry 跳过不计。
 */
export function countToolCallBlocks(entries: unknown[]): number {
	let count = 0;
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		// 断言目标带必填 unknown 字段（typeof object 已守卫），非全可选形状
		const entry = raw as { type: unknown; message: unknown };
		if (entry.type !== "message") continue;
		if (!entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as { role: unknown; content: unknown };
		if (message.role !== "assistant") continue;
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block && typeof block === "object" && (block as { type: unknown }).type === "toolCall") {
				count++;
			}
		}
	}
	return count;
}

// ── 辅判据：无进展判定与退避 ─────────────────────────

/**
 * 本轮是否有真实进展：出现工具调用（toolDelta>0）或 tokenDelta 越阈值。
 *
 * 两者任一即进展——纯文本迭代型任务（长文起草）每轮合法无工具调用，但 tokenDelta
 * 高（整段重写），不应被退避拖慢；事故形态（每轮回一句「等待」）则两者皆无。
 */
export function isProgressSignal(toolDelta: number, tokenDelta: number, cfg: LivenessConfig): boolean {
	return toolDelta > 0 || tokenDelta >= cfg.noProgressTokenThreshold;
}

/** 无进展 → 计数 +1；有进展 → 清零（只清退避计数，主判据总数不动）。 */
export function nextNoProgressTurns(current: number, progress: boolean): number {
	return progress ? 0 : current + 1;
}

/**
 * 退避等级：连续无进展轮数达到阈值（默认 5）的第 N 轮起 level=1，此后每多一轮 +1。
 * 间隔 = base × 2^level（第 5 轮起 ×2，第 6 轮 ×4，…），封顶 backoffMaxMs。
 */
export function continuationBackoffDelayMs(noProgressTurns: number, cfg: LivenessConfig): number {
	const level = Math.max(0, noProgressTurns - cfg.noProgressTurnsThreshold + 1);
	if (level <= 0) return 0;
	return Math.min(cfg.backoffBaseMs * BACKOFF_MULTIPLIER ** level, cfg.backoffMaxMs);
}

// ── 主判据：连发总次数封顶 ───────────────────────────

/** 是否已达连发总次数上限（封顶后必停发，goal 保持 active 等用户 /goal resume）。 */
export function isContinuationCapped(state: GoalRuntimeState, cfg: LivenessConfig): boolean {
	return state.continuationsSent >= cfg.continuationCap;
}

// ── defer 通知去重 ───────────────────────────────────

/**
 * 活跃 pending 集合是否发生变化（顺序无关）。
 *
 * defer 分支的用户通知只在「集合变化或首次进入 defer」时发——事故中每轮 agent_end
 * 都 notify「Goal waiting for N task(s)」，pending 集合不变时是纯噪音。
 */
export function pendingSetChanged(current: readonly string[], last: readonly string[]): boolean {
	if (current.length !== last.length) return true;
	const lastSet = new Set(last);
	return current.some((id) => !lastSet.has(id));
}
