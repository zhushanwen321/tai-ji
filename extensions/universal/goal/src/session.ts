/**
 * Session 层 — 运行时句柄 + 状态重建（entry 不做 GC，只读最新一条）
 *
 * GoalSession 是进程内瞬态句柄（不持久化）。
 * reconstructGoalState 从 entry 恢复状态（session_start 时调）。
 *
 * FR-6.4: 删除 hasPendingInjection（僵尸字段）
 * FR-6.7: 删除 pendingPause（ESC 改用 aborted 守卫）
 * FR-8.1 G-006: session append-only——entry GC 不生效（生产），history 显示侧截断
 * FR-3: 崩溃后保持原状态（active 重启计时；paused/blocked 保持；终态保持）
 */

import type { GoalRuntimeState } from "./engine/types";
import { deserializeState, ENTRY_TYPE } from "./persistence";
import type { SessionEntryLike, SessionPort, UiPort } from "./ports";

// ── 运行时句柄 ────────────────────────────────────────

export interface GoalSession {
	state: GoalRuntimeState | null;
	/** 防重入标志：agent_end / before_agent_start 等事件处理器入口检查 */
	isProcessing: boolean;
	/**
	 * W5 退避延迟发送的 continuation 定时器（无进展退避时 continuation 不立即发出，
	 * 按间隔 ×2 递增延迟）。非 null 表示有一个待发的退避 continuation——调度前必须
	 * 先清（防双发）。清理面（cancelContinuationTimer 统一入口）：clearGoalSession、
	 * session_start（新 session 生命周期旧 timer 作废）、before_agent_start（新用户
	 * 活动使旧退避作废）、下一轮 agent_end 调度前。
	 */
	continuationTimer: ReturnType<typeof setTimeout> | null;
}

export function createGoalSession(): GoalSession {
	return {
		state: null,
		isProcessing: false,
		continuationTimer: null,
	};
}

// ── Stale Context 检测（FR-8.2 G-010）─────────────────
// [REMOVED W4] 原实现导出 STALE_CONTEXT_PATTERNS + isStaleContextError，双重废：
// ① 无生产调用方（仅测试引用）——goal 的 appendEntry/sendMessage 调用点均在 pi
//   event handler 内，pi runner 对 handler 错误有隔离，无「捕获后分诊 stale」的场景；
// ② patterns 与 pi 0.84.1 真实 stale 文案零匹配（"This extension ctx is stale
//   after session replacement..."，runner.js:352——"stale context" ≠ "ctx is stale"）。
// 复用价值场景请参照 scheduler 的已验证方案：runtime.ts STALE_CTX_MARKER
// 'stale after session replacement'（子串匹配真实文案）+ 代际计数治本（G1）。

// ── reconstructGoalState（session_start 时调）──────────

/**
 * 从 session entries 恢复 goal state。
 *
 * Pi SDK 的 session 是 append-only，getEntries() 返回 filter-copy——splice
 * 无法修改真实 entries。Entry GC（goal-state 留 1、goal-history 留 20）在生产
 * 不生效：本函数只读最新一条 goal-state，不删旧 entry；history 显示侧用
 * .slice(-MAX_HISTORY_ENTRIES) 截断（handleHistory）。长期需 compaction API。
 * FR-3: 崩溃后状态保持原状——active 重启计时（timeStartedAt = now），
 *   paused/blocked 保持（用户/agent 主动叫停不被抹除），终态保持。
 * FR-8.1 G-024: deserialize throw → state=null（部分损坏全丢）
 */
export function reconstructGoalState(session: GoalSession, sessionPort: SessionPort): void {
	session.state = null;
	const entries = sessionPort.getEntries();

	// 找到最新的 goal-state entry（从后往前）
	let latestStateIdx = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (isGoalStateEntry(entries[i]!)) {
			latestStateIdx = i;
			break;
		}
	}

	if (latestStateIdx >= 0) {
		const data = entries[latestStateIdx]!.data as Record<string, unknown> | undefined;
		if (data) {
			try {
				session.state = deserializeState(data);
			} catch {
				// FR-8.1 G-024: 部分损坏全丢
				session.state = null;
			}
		}
	}

	// FR-8.1 G-006: session append-only，splice GC 在生产不生效（见上方函数注释）。
	// 不在此处删旧 entry；history 显示侧截断。

	if (!session.state) return;

	// FR-3: 崩溃后状态保持。
	// - active：重启计时（timeStartedAt = now，开启新运行段）
	// - paused/blocked：保持原状（对称设计——用户/agent 主动叫停的状态不被崩溃抹除）
	// - 终态：保持终态（不会被强制激活）
	if (session.state.status === "active") {
		session.state.timeStartedAt = Date.now();
	}
}

function isGoalStateEntry(entry: SessionEntryLike): boolean {
	return entry.type === "custom" && entry.customType === ENTRY_TYPE;
}

// ── clearGoalSession ──────────────────────────────────

/**
 * 取消待发的退避 continuation timer（全部清理点走本函数，防止清理面遗漏）：
 * - clearGoalSession：goal 已终态/清除，发出即僵尸 turn
 * - session_start：session 句柄跨 session 复用，新 session 生命周期旧 timer 作废
 * - before_agent_start：新用户活动使旧退避作废，该轮 agent_end 按最新状态重新决策
 * - agent_end 调度前：防双发（任意时刻至多一个待发）
 */
export function cancelContinuationTimer(session: GoalSession): void {
	if (session.continuationTimer !== null) {
		clearTimeout(session.continuationTimer);
		session.continuationTimer = null;
	}
}

export function clearGoalSession(session: GoalSession, uiPort: UiPort): void {
	// W5：清 goal 时取消待发的退避 continuation（goal 已终态/清除，发出即僵尸 turn）
	cancelContinuationTimer(session);
	session.state = null;
	session.isProcessing = false;
	// FR-6.6: hasUI 守卫
	if (uiPort.hasUI) {
		uiPort.setWidget("goal", undefined);
		uiPort.setStatus("goal", undefined);
	}
}
