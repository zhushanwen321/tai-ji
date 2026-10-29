// createPiDeliveryPortHost 接线行为锁：八个端口的透传语义逐成员断言（pi-host.ts 头注
// 接线纪律的行为集）——原样透传不加工、订阅返回 pi 退订函数、事件回调只裁剪事件体、
// sendMessage 恒 { triggerTurn: true }。fake pi/ctx 全内存，无 fs。
import { describe, expect, it } from "vitest";

import { createPiDeliveryPortHost } from "../pi-host.ts";

type RegisteredEvent = { event: string; handler: (raw: unknown) => void };

/** fake pi：记录 appendEntry / sendMessage / on 注册；on 返回可核验的退订函数。 */
function makePi() {
	const appended: Array<{ customType: string; data: unknown }> = [];
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const registered: RegisteredEvent[] = [];
	const unsubscribed: string[] = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => {
			appended.push({ customType, data });
		},
		sendMessage: (message: unknown, options: unknown) => {
			sent.push({ message, options });
		},
		on: (event: string, handler: (raw: unknown) => void) => {
			registered.push({ event, handler });
			return () => {
				unsubscribed.push(event);
			};
		},
	};
	return { pi, appended, sent, registered, unsubscribed };
}

/** fake ctx：sessionManager.getEntries + isIdle 可编程。 */
function makeCtx(entries: unknown[], idle: boolean) {
	return {
		sessionManager: { getEntries: () => entries },
		isIdle: () => idle,
	};
}

function makeOptions() {
	const logger = {
		warn: () => {},
		debug: () => {},
	};
	return { component: "test", logger };
}

describe("createPiDeliveryPortHost 接线（七端口逐成员）", () => {
	it("appendEntry / readSessionEntries / isIdle 透传", () => {
		const { pi, appended } = makePi();
		const entries = [{ type: "message" }];
		const host = createPiDeliveryPortHost(
			pi as never,
			makeCtx(entries, false) as never,
			makeOptions(),
		);

		host.appendEntry("custom_x", { a: 1 });
		expect(appended).toEqual([{ customType: "custom_x", data: { a: 1 } }]);

		expect(host.readSessionEntries()).toBe(entries);
		expect(host.isIdle()).toBe(false);
		// [subagent-observability §3.3.7③] hasRunningBackground 已随攒批窗退役删除，
		// 接线结果不再含该成员（结构断言：host 对象无此键）。
		expect("hasRunningBackground" in host).toBe(false);
	});

	it("sendMessage 注入恒携带 triggerTurn: true，deliverAs 透传", () => {
		const { pi, sent } = makePi();
		const host = createPiDeliveryPortHost(
			pi as never,
			makeCtx([], true) as never,
			makeOptions(),
		);

		const message = { customType: "c", content: "hi", display: false };
		host.sendMessage(message, { deliverAs: "steer" });
		expect(sent).toHaveLength(1);
		expect(sent[0].message).toBe(message);
		expect(sent[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
	});

	it("订阅类端口注册到 pi.on 对应事件、handler 只收事件体、退订兑现 pi 退订函数", () => {
		const { pi, registered, unsubscribed } = makePi();
		const host = createPiDeliveryPortHost(
			pi as never,
			makeCtx([], true) as never,
			makeOptions(),
		);

		const onMessageEnd = () => {};
		const offMessageEnd = host.onMessageEnd(onMessageEnd);
		host.onAgentSettled(() => {});
		host.onSessionBeforeCompact(() => {});
		host.onSessionCompact(() => {});
		host.onSessionCompactFailed(() => {});

		expect(registered.map((r) => r.event)).toEqual([
			"message_end",
			"agent_settled",
			"session_before_compact",
			"session_compact",
			"session_compact_failed",
		]);

		// message_end 裁剪：handler 只收 event.message，不透传事件包装
		let received: unknown = undefined;
		host.onMessageEnd((m) => {
			received = m;
		});
		const messageEndHandler = registered[registered.length - 1].handler;
		messageEndHandler({ message: { role: "custom" } });
		expect(received).toEqual({ role: "custom" });

		// 退订函数 = pi.on 返回的退订（port dispose 时兑现的契约）
		offMessageEnd();
		expect(unsubscribed).toEqual(["message_end"]);
	});

	it("logger 透传 options.logger（宿主提供的分桶出口）", () => {
		const { pi } = makePi();
		const logger = { warn: () => {}, debug: () => {} };
		const host = createPiDeliveryPortHost(
			pi as never,
			makeCtx([], true) as never,
			{ component: "probe", logger },
		);
		expect(host.logger).toBe(logger);
	});
});
