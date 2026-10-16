// notify-delivery-discipline.test.ts — recordManagedNotify 的投递接入纪律
// （unified-delivery 波 2：投递路径切 pi 半区投递端口后的消费纪律锁）。
//
// 覆盖（原 notify-ledger-discipline.test.ts 场景的 port 形态对位——账本装配纪律
// ①②③④与 stale 守卫随账本退役：bind/recover 收敛由 pi-delivery-port 套件的
// 「重复 bind 替换并 dispose 旧实例」锁定，stale 注入 throw → 内核 retain 由其
// 「注入 throw → retain 留账」锁定，compaction 接线随 append-only 契约裁决删除）：
//   ⑤ 消费点经 getDeliveryPort() 动态查槽（禁缓存实例引用——后 bind 方 dispose
//      旧实例后缓存引用的 deliver 静默 rejected，对半概率丢全部通知的 D3⑤ 同律）；
//   通道 = managed-session-notify 外部通道（payload.customType，port 批组隔离恒
//   逐条不合批）；槽空降级（port 缺席 → warn + false，STANDARDS §11.1）；port
//   rejected（persist-failed）→ warn + false（幂等键未登记，watch 重试合法）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoggerModuleMock, getLoggerMock } from "./helpers/logger-mock.ts";

vi.mock("@zhushanwen/pi-extension-logger", () => createLoggerModuleMock());

const loggerMock = getLoggerMock();

// pi-delivery-port 进程级槽（C-ext-06；recordManagedNotify 的消费入口）。
const PORT_SLOT_KEY = Symbol.for(DELIVERY_PORT_SLOT_KEY);

import { recordManagedNotify } from "../notify-delivery.ts";
import type { ManagedNotifyDetails } from "../notify-content.ts";
import { DELIVERY_PORT_SLOT_KEY } from "@zhushanwen/pi-delivery-port";

/** recordManagedNotify 的最小合法 details（ManagedNotifyDetails 收紧后的测试桩形状）。 */
function makeDetails(notifyId: string): ManagedNotifyDetails {
	return { notifyId, sessionId: "s-test", reason: "completed", fulfills: 1, label: "test" };
}

type DeliverCall = {
	id: string | undefined;
	customType: string;
	content: string;
	details: unknown;
};

function plantPort(behavior: "accept" | "reject" = "accept"): Array<DeliverCall> {
	const calls: Array<DeliverCall> = [];
	Reflect.set(globalThis, PORT_SLOT_KEY, {
		current: {
			deliver: (envelope: {
				id?: string;
				payload: { customType: string; content: string; details?: unknown };
			}) => {
				if (behavior === "reject") return { kind: "rejected", reason: "persist-failed (fake)" };
				calls.push({
					id: envelope.id,
					customType: envelope.payload.customType,
					content: envelope.payload.content,
					details: envelope.payload.details,
				});
				return { kind: "accepted", id: envelope.id ?? "gen-id" };
			},
			flush: () => {},
		},
	});
	return calls;
}

beforeEach(() => {
	loggerMock.warn.mockClear();
});

afterEach(() => {
	// 摘除槽注入——防泄漏到同文件后续用例（生产槽由 base-tool-enhance session_start 装配）。
	Reflect.deleteProperty(globalThis, PORT_SLOT_KEY);
});

describe("recordManagedNotify 投递接入纪律（unified-delivery 波 2：port 消费面）", () => {
	it("槽空（port 未装配）→ 降级 false + warn 留痕（通知类接入点降级，非静默吞）", () => {
		Reflect.deleteProperty(globalThis, PORT_SLOT_KEY);
		expect(recordManagedNotify("sm-x", "content", makeDetails("sm-x"))).toBe(false);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			expect.stringContaining("delivery port not bound"),
			expect.objectContaining({ notifyId: "sm-x" }),
		);
	});

	it("port 在 → 动态查槽投递：id = notifyId、payload.customType = managed-session-notify（外部通道）、details 原样", () => {
		const delivered = plantPort();
		const details = makeDetails("sm-a");
		expect(recordManagedNotify("sm-a", "hello", details)).toBe(true);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]!.id).toBe("sm-a");
		expect(delivered[0]!.customType).toBe("managed-session-notify");
		expect(delivered[0]!.content).toBe("hello");
		expect(delivered[0]!.details).toBe(details);
	});

	it("port rejected（persist-failed）→ warn + false（幂等键未登记，watch 重试合法；不静默吞）", () => {
		plantPort("reject");
		expect(recordManagedNotify("sm-rej", "content", makeDetails("sm-rej"))).toBe(false);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			expect.stringContaining("delivery port rejected notification"),
			expect.objectContaining({ notifyId: "sm-rej" }),
		);
	});

	it("投递异常（port.deliver 抛错）→ warn 留痕不外抛（不拖垮 watch 应答编排，unregister 照常）", () => {
		Reflect.set(globalThis, PORT_SLOT_KEY, {
			current: {
				deliver: () => {
					throw new Error("session context is no longer active (assertActive)");
				},
				flush: () => {},
			},
		});
		expect(() => recordManagedNotify("sm-throw", "content", makeDetails("sm-throw"))).not.toThrow();
		expect(recordManagedNotify("sm-throw-2", "content", makeDetails("sm-throw-2"))).toBe(false);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			expect.stringContaining("notify delivery failed"),
			expect.objectContaining({ notifyId: "sm-throw-2" }),
		);
	});
});
