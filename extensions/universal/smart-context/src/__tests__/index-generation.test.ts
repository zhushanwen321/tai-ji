// src/__tests__/index-generation.test.ts
//
// G1 装配级测试（crash-resilience D1，参照 scheduler __tests__/index-generation.test.ts 形态）：
// index.ts 装配点向 registerCompactContextTool 注入的 deps.isCtxStale 必须是 live 绑定
// wrapper（() => isCtxStale()）——registerCompactContextTool 在 factory 体同步执行，简写
// 属性 { isCtxStale } 会把该行时刻的初始 () => false 快照进 deps 对象，session_start
// handler 内的重新赋值不回写已构造对象 → compact onComplete/onError（E1 实锤崩溃点）
// 守卫的前置代际检查恒不生效，stale 分诊 100% 退化为 PS-30 文案兜底。
//
// 可区分快照 vs live 的唯一拓扑是 factory 重跑（生产主路径：pi 每次 session 替换
// newSession/fork/switchSession 都重跑 factory 函数体，loader.ts extensionCache 只缓存
// factory 函数对象）：同闭包内 fire session_start 后本闭包恒是当前代（isCtxStale 读到
// false，与快照实现值不可区分）；只有第一代 deps 在第二代 session_start 递增模块级
// sessionGeneration 后必须翻 true——快照实现在此恒 false，正是生产失效路径。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock 共享 logger（compact-handler 顶层 createLogger；同 scheduler index-generation 形态）
const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

// 装配捕获：mock tool.js，逐次登记 index.ts 传入的 deps（同 scheduler 捕获 runtime 构造第三参）
const { registerCompactContextToolCalls } = vi.hoisted(() => ({
	registerCompactContextToolCalls: [] as Array<{ deps?: { isCtxStale?: () => boolean } }>,
}));
vi.mock("../tool.js", () => ({
	registerCompactContextTool: (_pi: unknown, deps?: { isCtxStale?: () => boolean }) => {
		registerCompactContextToolCalls.push({ deps });
	},
}));

import smartContextExtension from "../index.js";

/** 最小 fake pi：装配路径只消费 on（事件接线）；registerTool/sendUserMessage 兜底。 */
function createMockPi(): {
	pi: ExtensionAPI
	events: Map<string, (...args: unknown[]) => void>
} {
	const events = new Map<string, (...args: unknown[]) => void>();
	const pi = {
		registerTool: vi.fn(),
		on: (event: string, handler: (...args: unknown[]) => void) => events.set(event, handler),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	return { pi, events };
}

/** 触发 session_start（handler 只更新模块级代数与闭包状态，ctx 不被读取）。 */
function fireSessionStart(events: Map<string, (...args: unknown[]) => void>): void {
	const sessionStart = events.get("session_start");
	expect(sessionStart).toBeDefined();
	sessionStart!({ type: "session_start" }, {} as ExtensionContext);
}

describe("G1: compact 工具 deps.isCtxStale live 绑定（crash-resilience D1 装配回归）", () => {
	beforeEach(() => {
		registerCompactContextToolCalls.length = 0;
	});

	it("factory 同步构造 deps：注入的是函数，首个 session_start 前恒 false（安全默认），fire 后本闭包为当前代", () => {
		const { pi, events } = createMockPi();
		smartContextExtension(pi);
		expect(registerCompactContextToolCalls).toHaveLength(1);
		const isCtxStale = registerCompactContextToolCalls[0]!.deps?.isCtxStale;
		expect(isCtxStale).toBeTypeOf("function");

		// 首个 session_start 前：无 session，恒 false（安全默认）
		expect(isCtxStale!()).toBe(false);

		// fire 后本闭包被装配为当前代 → false；同闭包重复 fire（rpc-mode bindExtensions
		// 重调）后仍为当前代。注意：单闭包拓扑内 live wrapper 与快照实现的返回值同为
		// false、不可区分——快照 vs live 的回归断言在下方 factory 重跑用例。
		fireSessionStart(events);
		expect(isCtxStale!()).toBe(false);
		fireSessionStart(events);
		expect(isCtxStale!()).toBe(false);
	});

	it("factory 重跑：第二次 factory + session_start 后，第一代 deps.isCtxStale 翻 true、第二代 false", () => {
		// 第一代：独立 factory 执行 + session_start 装配
		const first = createMockPi();
		smartContextExtension(first.pi);
		fireSessionStart(first.events);
		const firstIsCtxStale = registerCompactContextToolCalls[0]!.deps!.isCtxStale!;
		expect(firstIsCtxStale()).toBe(false); // 第一代是当前代

		// 第二代：再次独立执行 factory（模拟 newSession/fork/switchSession 的 factory 重跑，
		// 新闭包；模块级 sessionGeneration 跨 factory 重跑保留）+ session_start
		const second = createMockPi();
		smartContextExtension(second.pi);
		fireSessionStart(second.events);

		// 核心回归断言：第一代 deps 读到第一代闭包重新赋值后的 isCtxStale，感知换代翻
		// true（快照实现 = 简写属性 { isCtxStale }，在此恒 false——本用例的回归失败点）
		expect(firstIsCtxStale()).toBe(true);
		expect(registerCompactContextToolCalls[1]!.deps!.isCtxStale!()).toBe(false); // 第二代是当前代
	});
});
