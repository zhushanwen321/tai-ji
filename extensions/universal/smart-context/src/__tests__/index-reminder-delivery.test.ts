// src/__tests__/index-reminder-delivery.test.ts
//
// D4' + D15 装配回归：越档提醒的「静默注入 + 档位持久化」两条语义在 index.ts 装配点成立。
//
// 现场（2026-09-19 会话 01a0b8b3）：taiji skill-reload 发 `/__taiji_reload__` → pi ctx.reload()
// 重跑 extension factory（jiti moduleCache:false 重新 import）→ firedThresholds 归零，且 reload
// 补发的 session_start reason 是 `startup`（区分不了重载与新会话）→ 同一档被提醒两次；同时
// sendUserMessage(followUp) 恒触发一轮（pi 语义），用户收工后仍被唤醒烧掉一整轮全量上下文。
//
// 本文件锁两件事：
//   ① 投递形态 = sendMessage({customType, display:false}, {triggerTurn:false})，且不再用 sendUserMessage；
//   ② fired 档位写入 session entries（appendEntry marker），工厂重跑（reload 等价拓扑）后
//      从 entries 重建 → 同档不重复、跨档照常提醒。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

// 工具注册短路（本文件只测提醒链路装配；compact 工具装配由 index-generation.test.ts 覆盖）
vi.mock("../tool.js", () => ({
	registerCompactContextTool: vi.fn(),
}));

// 配置冻结：loadSmartContextConfig 走 llm-shared loadConfig（读真实 agentDir 磁盘文件），
// 测试必须确定（不随本机 ~/.taiji 配置漂移）→ 只覆写该函数，pure.js 其余纯函数保持实装。
const TEST_CONFIG = {
	enabled: true,
	compactModel: { type: "ref" as const, ref: "" },
	reminderThresholds: [200_000, 400_000, 600_000],
	excludedModels: [] as string[],
};
vi.mock("../pure.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../pure.js")>()),
	loadSmartContextConfig: () => structuredClone(TEST_CONFIG),
}));

import { FIRED_ENTRY_CUSTOM_TYPE, THRESHOLD_REMINDER_CUSTOM_TYPE } from "../pure.js";
import smartContextExtension from "../index.js";

interface MockPi {
	pi: ExtensionAPI
	events: Map<string, (...args: unknown[]) => void>
	sendMessage: ReturnType<typeof vi.fn>
	sendUserMessage: ReturnType<typeof vi.fn>
	appendEntry: ReturnType<typeof vi.fn>
}

/** 最小 fake pi：本文件消费 on / sendMessage / sendUserMessage / appendEntry。 */
function createMockPi(): MockPi {
	const events = new Map<string, (...args: unknown[]) => void>();
	const sendMessage = vi.fn();
	const sendUserMessage = vi.fn();
	const appendEntry = vi.fn();
	const pi = {
		registerTool: vi.fn(),
		on: (event: string, handler: (...args: unknown[]) => void) => events.set(event, handler),
		sendMessage,
		sendUserMessage,
		appendEntry,
	} as unknown as ExtensionAPI;
	return { pi, events, sendMessage, sendUserMessage, appendEntry };
}

/** 最小 fake ctx：提醒链路只消费 model / getContextUsage / sessionManager.getEntries。 */
function makeCtx(tokens: number, entries: ReadonlyArray<unknown> = []): ExtensionContext {
	return {
		model: { provider: "zai", id: "glm" },
		getContextUsage: () => ({ tokens, contextWindow: 1_000_000 }),
		sessionManager: { getEntries: () => entries, getSessionId: () => "s1" },
	} as unknown as ExtensionContext;
}

/** fired marker entry 的持久形态（与 index.ts 写入口径一致）。 */
function markerEntry(tiers: number[], tokens: number) {
	return { type: "custom", customType: FIRED_ENTRY_CUSTOM_TYPE, data: { tiers, tokens } };
}

/** 触发 agent_settled（提醒唯一触发点）。 */
function settle(pi: MockPi, ctx: ExtensionContext): void {
	pi.events.get("agent_settled")!({ type: "agent_settled" }, ctx);
}

/** 触发 session_start（factory 重跑后的状态装配点）。 */
function fireSessionStart(pi: MockPi, ctx: ExtensionContext): void {
	pi.events.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
}

describe("D4': 越档提醒静默注入（不触发 turn、不进对话流）", () => {
	it("命中档位 → sendMessage(customType, display:false) + {triggerTurn:false}；不再 sendUserMessage", () => {
		const mock = createMockPi();
		smartContextExtension(mock.pi);
		fireSessionStart(mock, makeCtx(0));
		settle(mock, makeCtx(250_000));

		expect(mock.sendUserMessage).not.toHaveBeenCalled();
		expect(mock.sendMessage).toHaveBeenCalledTimes(1);
		const [message, options] = mock.sendMessage.mock.calls[0]!;
		expect(message).toMatchObject({ customType: THRESHOLD_REMINDER_CUSTOM_TYPE, display: false });
		expect(String(message.content)).toContain("[smart-context]");
		expect(options).toEqual({ triggerTurn: false });
	});

	it("命中档位 → 先写 fired marker（session entries 持久化）", () => {
		const mock = createMockPi();
		smartContextExtension(mock.pi);
		fireSessionStart(mock, makeCtx(0));
		settle(mock, makeCtx(250_000));

		expect(mock.appendEntry).toHaveBeenCalledTimes(1);
		expect(mock.appendEntry.mock.calls[0]![0]).toBe(FIRED_ENTRY_CUSTOM_TYPE);
		expect(mock.appendEntry.mock.calls[0]![1]).toEqual({ tiers: [200_000], tokens: 250_000 });
	});

	it("未达首档 → 不投递不写 marker", () => {
		const mock = createMockPi();
		smartContextExtension(mock.pi);
		fireSessionStart(mock, makeCtx(0));
		settle(mock, makeCtx(150_000));

		expect(mock.sendMessage).not.toHaveBeenCalled();
		expect(mock.appendEntry).not.toHaveBeenCalled();
	});

	it("同档二次 settle 不重复投递；跨下一档只带新增档位", () => {
		const mock = createMockPi();
		smartContextExtension(mock.pi);
		fireSessionStart(mock, makeCtx(0));

		settle(mock, makeCtx(250_000));
		settle(mock, makeCtx(260_000)); // 同档 → 静默
		expect(mock.sendMessage).toHaveBeenCalledTimes(1);

		settle(mock, makeCtx(450_000)); // 跨 400K → 只报新档
		expect(mock.sendMessage).toHaveBeenCalledTimes(2);
		expect(mock.appendEntry.mock.calls[1]![1]).toEqual({ tiers: [400_000], tokens: 450_000 });
	});
});

describe("D15: 档位持久化跨 factory 重跑（reload 等价拓扑）", () => {
	it("marker 已在 entries → 新实例同档不重复提醒，跨下一档仍提醒", () => {
		// 第一代：命中 200K 档并落 marker
		const first = createMockPi();
		smartContextExtension(first.pi);
		fireSessionStart(first, makeCtx(0));
		settle(first, makeCtx(250_000));
		expect(first.sendMessage).toHaveBeenCalledTimes(1);

		// 第二代（reload 等价：factory 重跑 + 新模块态 + session_start）——entries 里带着 marker
		const entries = [markerEntry([200_000], 250_000)];
		const second = createMockPi();
		smartContextExtension(second.pi);
		fireSessionStart(second, makeCtx(250_000, entries));

		settle(second, makeCtx(255_000, entries)); // 同档 → 不重复
		expect(second.sendMessage).not.toHaveBeenCalled();
		expect(second.appendEntry).not.toHaveBeenCalled();

		settle(second, makeCtx(450_000, entries)); // 跨 400K → 照常提醒
		expect(second.sendMessage).toHaveBeenCalledTimes(1);
		expect(second.appendEntry.mock.calls[0]![1]).toEqual({ tiers: [400_000], tokens: 450_000 });
	});

	it("session_start 未送达新实例时，首次 settle 兜底 seed（reload 先 settle 后 start 的窗口）", () => {
		const entries = [markerEntry([200_000, 400_000], 450_000)];
		const mock = createMockPi();
		smartContextExtension(mock.pi); // 只重跑 factory，不 fire session_start
		settle(mock, makeCtx(460_000, entries));

		expect(mock.sendMessage).not.toHaveBeenCalled();
	});

	it("compaction entry 之后档位重置（同档再次提醒）", () => {
		const entries = [markerEntry([200_000], 250_000), { type: "compaction" }];
		const mock = createMockPi();
		smartContextExtension(mock.pi);
		fireSessionStart(mock, makeCtx(0, entries));
		settle(mock, makeCtx(250_000, entries));

		expect(mock.sendMessage).toHaveBeenCalledTimes(1);
		expect(mock.appendEntry.mock.calls[0]![1]).toEqual({ tiers: [200_000], tokens: 250_000 });
	});

	it("session_compact 事件清空内存档位（D3 既有契约不回退）", () => {
		const mock = createMockPi();
		smartContextExtension(mock.pi);
		fireSessionStart(mock, makeCtx(0));
		settle(mock, makeCtx(250_000));
		expect(mock.sendMessage).toHaveBeenCalledTimes(1);

		mock.events.get("session_compact")!({ type: "session_compact" }, makeCtx(250_000));
		settle(mock, makeCtx(255_000));
		expect(mock.sendMessage).toHaveBeenCalledTimes(2);
	});
});

describe("D15: entries 读取异常降级（不阻断提醒链路）", () => {
	beforeEach(() => {
		loggerMock.debug.mockClear();
	});

	it("getEntries 抛错 → seed 降级为空集，提醒照常投递", () => {
		const mock = createMockPi();
		smartContextExtension(mock.pi);
		const brokenCtx = {
			model: { provider: "zai", id: "glm" },
			getContextUsage: () => ({ tokens: 250_000, contextWindow: 1_000_000 }),
			sessionManager: {
				getEntries: () => {
					throw new Error("boom");
				},
			},
		} as unknown as ExtensionContext;

		fireSessionStart(mock, brokenCtx);
		settle(mock, brokenCtx);

		expect(mock.sendMessage).toHaveBeenCalledTimes(1);
	});
});
