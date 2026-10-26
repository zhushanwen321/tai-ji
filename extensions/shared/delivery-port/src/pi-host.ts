// src/pi-host.ts
//
// pi 扩展运行时端口接线工厂：把 ExtensionAPI / ExtensionContext 的八个端口接线成
// DeliveryPortHost，供 session_start 装配点传入 bindDeliveryPort。
//
// 接线纪律：
// - 原样透传（appendEntry / getEntries / isIdle / sendMessage），不加工不缓存；
// - 订阅面（message_end / agent_settled / session_before_compact / session_compact /
//   session_compact_failed）透传 handler 并返回 pi 的退订函数（pi 1.0.0 起 on 返回
//   unsubscribe，port dispose 时兑现——防 session_start 重绑累积死 handler）；
// - 事件回调的入参裁剪：port 只消费事件的事件体（message 等），ctx 参数不透传
//   （port 的宿主状态面只经构造期注入的 ctx）；
// - 注入 sendMessage 恒 { triggerTurn: true }（custom 消息 append 后若无 turn 则成
//   死文——deliverAs 两档控制队列位置，triggerTurn 控制空闲唤醒，两者正交）。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { DeliveryPortHost } from "./types.ts";

/** 工厂选项：装配观测差异参数化。 */
export interface CreatePiDeliveryPortHostOptions { // oe-exempt:20261017:framework:pi 半区装配契约接口（宿主注入面，适配层持久契约）
  /** warn/debug 归因标签（建议装配扩展名，如 "base-tool-enhance"）。 */
  component: string;
  /** 降级与诊断出口（@zhushanwen/pi-extension-logger 的 ExtensionLogger）。 */
  logger: DeliveryPortHost["logger"];
}

/** 接线 pi 扩展运行时端口为 DeliveryPortHost（纯端口面，无业务状态）。 */
export function createPiDeliveryPortHost(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: CreatePiDeliveryPortHostOptions,
): DeliveryPortHost {
	return {
		appendEntry: (customType, data) => {
			pi.appendEntry(customType, data);
		},
		readSessionEntries: () => ctx.sessionManager.getEntries(),
		isIdle: () => ctx.isIdle(),
		sendMessage: (message, portOptions) => {
			pi.sendMessage(message, { triggerTurn: true, deliverAs: portOptions.deliverAs });
		},
		onMessageEnd: (handler) =>
			pi.on("message_end", (event) => {
				handler(event.message);
			}),
		onAgentSettled: (handler) =>
			pi.on("agent_settled", () => {
				handler();
			}),
		onSessionBeforeCompact: (handler) =>
			pi.on("session_before_compact", () => {
				handler();
			}),
		onSessionCompact: (handler) =>
			pi.on("session_compact", () => {
				handler();
			}),
		onSessionCompactFailed: (handler) =>
			pi.on("session_compact_failed", () => {
				handler();
			}),
		logger: options.logger,
	};
}
