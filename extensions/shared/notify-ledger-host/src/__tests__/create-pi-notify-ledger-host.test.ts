// createPiNotifyLedgerHost 工厂契约测试（真 guardStaleCtx 集成，无 mock）。钉两类
// 承载行为：
// ① 端口接线（appendEntry / getEntries / isIdle / agent_settled 原样透传）；
// ② 送达单通道形态与 stale 分诊——stale 静默降级 warn 归因、非 stale 原样上抛、
//    sendDelivery 恒 {triggerTurn:true} / sendDisplayMessage 恒单参不唤醒。
// 观测参数（guard label / stale warn 前缀）在 guard-observability.test.ts（mock 形态，
// vi.mock 全文件生效故独立成档）。
// 两装配方（subagent-workflow / session-manager）的字段级行为等价由本组锚定：
// 任何端口接线或送达形态漂移都在此红。
import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { STALE_CTX_MARKER } from "@zhushanwen/pi-ext-guards";

import { createPiNotifyLedgerHost } from "../index.ts";

/** pi 实装 stale 文案的完整形态（E1 崩溃堆栈原文，探针 PS-30 守卫其稳定性）。 */
const PI_STALE_ERROR = `This extension ctx is stale ${STALE_CTX_MARKER} or reload. Do not use a captured pi or command ctx after ctx.newSession().`;

interface PiMock { // oe-exempt:20260930:test:测试内 pi 桩形状契约
	pi: ExtensionAPI;
	appendEntry: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
}

/** 最小 pi 面（对齐 subagent-workflow session-lifecycle.test.ts makeLedgerPi 形态）。 */
function makePi(sendMessageImpl?: (...args: unknown[]) => void): PiMock {
	const appendEntry = vi.fn();
	const on = vi.fn();
	const sendMessage = vi.fn(sendMessageImpl);
	const pi = { appendEntry, on, sendMessage } as unknown as ExtensionAPI;
	return { pi, appendEntry, on, sendMessage };
}

/** 最小 ctx 面：getEntries / isIdle 返回值可注入。 */
function makeCtx(entries: readonly unknown[] = [], idle = true): ExtensionContext {
	return {
		sessionManager: { getEntries: () => entries },
		isIdle: () => idle,
	} as unknown as ExtensionContext;
}

function makeLogger() {
	return { warn: vi.fn() };
}

// ── ① 端口接线：原样透传 ────────────────────────────────────────────────────

describe("端口接线（appendEntry / getEntries / isIdle / agent_settled）", () => {
	it("appendLedgerEntry → pi.appendEntry(customType, data) 参数原样", () => {
		const { pi, appendEntry } = makePi();
		const host = createPiNotifyLedgerHost(pi, makeCtx(), { component: "c", logger: makeLogger() });
		host.appendLedgerEntry("custom/x", { v: 1 });
		expect(appendEntry).toHaveBeenCalledTimes(1);
		expect(appendEntry).toHaveBeenCalledWith("custom/x", { v: 1 });
	});

	it("readSessionEntries → ctx.sessionManager.getEntries() 返回值原样", () => {
		const { pi } = makePi();
		const entries = [{ type: "custom" }, { type: "message" }];
		const host = createPiNotifyLedgerHost(pi, makeCtx(entries), { component: "c", logger: makeLogger() });
		expect(host.readSessionEntries()).toBe(entries);
	});

	it("isIdle → ctx.isIdle() 布尔值原样（true / false 两态）", () => {
		const { pi } = makePi();
		expect(
			createPiNotifyLedgerHost(pi, makeCtx([], true), { component: "c", logger: makeLogger() }).isIdle(),
		).toBe(true);
		expect(
			createPiNotifyLedgerHost(pi, makeCtx([], false), { component: "c", logger: makeLogger() }).isIdle(),
		).toBe(false);
	});

	it('onAgentSettled → pi.on("agent_settled", handler) 事件名与 handler 原样', () => {
		const { pi, on } = makePi();
		const host = createPiNotifyLedgerHost(pi, makeCtx(), { component: "c", logger: makeLogger() });
		const handler = (): void => {};
		host.onAgentSettled(handler);
		expect(on).toHaveBeenCalledTimes(1);
		expect(on).toHaveBeenCalledWith("agent_settled", handler);
	});
});

// ── ② 送达单通道形态与 stale 分诊（真 guardStaleCtx 集成） ──────────────────

describe("送达形态与 stale 分诊（真 guardStaleCtx）", () => {
	const MESSAGE = { customType: "bg-notify", content: "subagent done: reviewer", display: true };

	it("sendDelivery 正常路径：sendMessage(message, { triggerTurn: true }) 单通道形态", () => {
		const { pi, sendMessage } = makePi();
		const host = createPiNotifyLedgerHost(pi, makeCtx(), {
			component: "subagent-workflow",
			logger: makeLogger(),
		});
		host.sendDelivery(MESSAGE);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage).toHaveBeenCalledWith(MESSAGE, { triggerTurn: true });
	});

	it("sendDelivery stale 错误：不外抛 + warn 归因（无前缀文案逐字节）", () => {
		const { pi, sendMessage } = makePi(() => {
			throw new Error(PI_STALE_ERROR);
		});
		const logger = makeLogger();
		const host = createPiNotifyLedgerHost(pi, makeCtx(), { component: "subagent-workflow", logger });
		expect(() => host.sendDelivery(MESSAGE)).not.toThrow();
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith("notify delivery skipped (stale ctx)", { error: PI_STALE_ERROR });
	});

	it("sendDelivery 非 stale 错误：同一实例原样上抛，守卫不吞真实 bug", () => {
		const boom = new Error("delivery rejected by runtime");
		const { pi } = makePi(() => {
			throw boom;
		});
		const logger = makeLogger();
		const host = createPiNotifyLedgerHost(pi, makeCtx(), { component: "subagent-workflow", logger });
		expect(() => host.sendDelivery(MESSAGE)).toThrow(boom);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("sendDisplayMessage 缺省不实现（最小 host，补显形前行为一致）", () => {
		const { pi } = makePi();
		const host = createPiNotifyLedgerHost(pi, makeCtx(), { component: "subagent-workflow", logger: makeLogger() });
		expect(host.sendDisplayMessage).toBeUndefined();
	});

	it("sendDisplayMessage 显式开启：sendMessage(message) 单参（无 triggerTurn，不唤醒）", () => {
		const { pi, sendMessage } = makePi();
		const host = createPiNotifyLedgerHost(pi, makeCtx(), {
			component: "subagent-workflow",
			logger: makeLogger(),
			sendDisplayMessage: true,
		});
		host.sendDisplayMessage?.(MESSAGE);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage.mock.calls[0]?.length).toBe(1);
		expect(sendMessage.mock.calls[0]?.[0]).toBe(MESSAGE);
	});
});
