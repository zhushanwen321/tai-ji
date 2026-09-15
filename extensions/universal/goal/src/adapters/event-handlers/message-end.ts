/**
 * 事件 3: message_end（FR-6.7 ESC 守卫 + token 累加）。
 *
 * FR-6.7 ESC 守卫：ctx.signal.aborted 时跳过 token 累加。
 * FR-8.6: token 累加算法（委托 service.applyEvent("message_end")）。
 *
 * 不 persist / updateWidget。
 */

import type { ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";

import { applyEvent } from "../../service";
import type { GoalSession } from "../../session";

export async function handleMessageEnd(
	session: GoalSession,
	ctx: ExtensionContext,
	event: MessageEndEvent,
): Promise<void> {
	if (!session.state) return;
	// FR-6.7 ESC 守卫
	if (ctx.signal?.aborted) return;

	applyEvent(session, "message_end", event);
}
