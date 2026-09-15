/**
 * 事件 2: turn_end（FR-6.7 ESC 守卫 + 递增）。
 *
 * FR-6.7 ESC 守卫：ctx.signal.aborted 时跳过递增（ESC 不算 goal turn）。
 * 正常路径：currentTurnIndex++ + updateWidget。
 *
 * 委托 service.applyEvent("turn_end") 递增 currentTurnIndex（H3：applyEvent 改 void，
 * updateWidget 副作用在此直接调用，不再经 effect 数组中转）。
 *
 * 不 persist（与旧 index.ts 行为对齐——turn_end 只内存变更 + widget）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { updateWidget } from "../../projection/widget";
import { applyEvent } from "../../service";
import type { GoalSession } from "../../session";
import { buildPorts } from "../ports";

export async function handleTurnEnd(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
): Promise<void> {
	if (!session.state) return;
	// FR-6.7 ESC 守卫
	if (ctx.signal?.aborted) return;

	const ports = buildPorts(pi, ctx);
	applyEvent(session, "turn_end", undefined);
	// turn_end 递增 currentTurnIndex 后直接刷新 widget
	updateWidget(session, ports.ui);
}
