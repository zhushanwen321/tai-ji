/**
 * 事件 3: message_end（FR-6.7 ESC 守卫 + token 累加）。
 *
 * FR-6.7 ESC 守卫：ctx.signal.aborted 时跳过 token 累加。
 * FR-8.6: token 累加算法（委托 service.applyEvent("message_end")）。
 *
 * role 过滤（D13①，rename-session 先例同形态）：仅 user/assistant 的 message_end
 * 进入消费——pi 1.0 起追加 system 消息（工具集变更高频写入）与嵌套形态，goal 的
 * 事件消费是对话回合语义，系统/工具结果/扩展形态的 message_end 显式不消费。
 * （token 累加在 service 层另有 assistant-only 收窄，本层过滤是消费关系显式化，
 * 不依赖下游巧合兜住。）
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

	// D13① role 过滤：仅对话轴两形态（AgentMessage role 域为开放联合，宽比较）
	const role: unknown = (event as { message?: { role?: unknown } }).message?.role;
	if (role !== "user" && role !== "assistant") return;

	applyEvent(session, "message_end", event);
}
