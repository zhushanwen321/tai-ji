/**
 * 事件 4: session_start（状态重建）。
 *
 * 调 reconstructGoalState 重建持久化状态 + updateWidget。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { updateWidget } from "../../projection/widget";
import type { GoalSession } from "../../session";
import { cancelContinuationTimer, reconstructGoalState } from "../../session";
import { buildPorts } from "../ports";

export async function handleSessionStart(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
): Promise<void> {
	// MF-6③：session 句柄跨 session 复用，新 session 生命周期开始时上一 session
	// 遗留的退避 timer 作废（不清理则旧 timer 携旧 ctx 闭包存活至多 600s）
	cancelContinuationTimer(session);
	const ports = buildPorts(pi, ctx);
	reconstructGoalState(session, ports.session);
	if (session.state) {
		updateWidget(session, ports.ui);
	}
}
