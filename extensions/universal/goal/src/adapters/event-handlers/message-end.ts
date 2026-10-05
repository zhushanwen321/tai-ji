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

/**
 * 畸形防御读取 message.role（D13①）：pi 事件经 JSON 解析，message 缺失 / 非对象 /
 * 缺 role 的畸形形态不得崩 handler——一律按「非对话轴形态」拒绝（测试契约：
 * toolResult / 缺 role / 缺 message 同走拒绝）。typeof + in 收窄替代 as 全可选
 * 结构断言（后者任何对象都能通过，等于无校验）。
 */
function readMessageRole(event: MessageEndEvent): unknown {
	const message: unknown = event.message;
	if (typeof message !== "object" || message === null) return undefined;
	if (!("role" in message)) return undefined;
	return message.role;
}

export async function handleMessageEnd(
	session: GoalSession,
	ctx: ExtensionContext,
	event: MessageEndEvent,
): Promise<void> {
	if (!session.state) return;
	// FR-6.7 ESC 守卫
	if (ctx.signal?.aborted) return;

	// D13① role 过滤：仅对话轴两形态（AgentMessage role 域为开放联合，宽比较）
	const role = readMessageRole(event);
	if (role !== "user" && role !== "assistant") return;

	applyEvent(session, "message_end", event);
}
