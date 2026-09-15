// injector 测试共享 mock 基建（subagent/workflow 两份测试逐字重复样板的提取，
// fallow 测试 duplication 条目消除）。提取的只是构造样板——断言全部留在各自测试文件。
//
// 使用方式（测试文件内，spies 必须留在文件里——vi.hoisted 保证 resetModules 后引用不变）：
//   const spies = vi.hoisted(() => ({ discoverResources: vi.fn(), getCachedFileContent: vi.fn() }));
//   vi.mock("../../shared/resource-discovery.ts", () => createDiscoveryModuleMock(spies));
//   vi.mock("@zhushanwen/pi-extension-logger", createLoggerModuleMock);
//
// vi.mock 工厂引用本 helper 的 import 绑定是安全的：工厂惰性执行（被 mock 模块首次被
// import 时），此时本 helper（静态 import、非被 mock 模块）已完成加载。
import type { Mock } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** injector 测试共用的 resource-discovery mock spies（调用计数跨 resetModules 连续）。 */
export interface DiscoverySpies {
	discoverResources: Mock;
	getCachedFileContent: Mock;
}

/**
 * resource-discovery 模块 mock 工厂：discoverResources/getCachedFileContent 直通
 * spies，findWorkspaceRoot 固定 "/ws"，getCachedParsed passthrough（真实实现走
 * mtime 缓存需真文件，测试里委托 getCachedFileContent 的 mock 返回值——保持
 * 「content → parse」语义）。
 */
export function createDiscoveryModuleMock(spies: DiscoverySpies) {
	return {
		discoverResources: spies.discoverResources,
		findWorkspaceRoot: () => "/ws",
		getCachedFileContent: spies.getCachedFileContent,
		getCachedParsed: (path: string, parse: (c: string) => unknown) =>
			parse(spies.getCachedFileContent(path) ?? ""),
	};
}

/** pi-extension-logger 模块 mock 工厂：全级别 no-op（测试不断言日志）。 */
export function createLoggerModuleMock() {
	return {
		getLogger: () => ({
			debug: () => {
				/* no-op */
			},
			info: () => {
				/* no-op */
			},
			warn: () => {
				/* no-op */
			},
			error: () => {
				/* no-op */
			},
		}),
		setPiHandle: () => {
			/* no-op */
		},
	};
}

/** before_agent_start handler 的返回结构（取 systemPrompt 断言）。 */
export interface BeforeAgentResult {
	systemPrompt: string;
}

/** 三 handler 捕获引用（setup*Injector 注册后填充）。 */
export interface CapturedHandlers {
	sessionStart?: (event: unknown, ctx: unknown) => Promise<void> | void;
	beforeAgentStart?: (
		event: { systemPrompt: string },
		ctx: unknown,
	) => Promise<BeforeAgentResult | void> | BeforeAgentResult | void;
	sessionShutdown?: (event: unknown, ctx: unknown) => void;
}

/** 构造 mock pi：捕获三 handler 引用，其余 prop 走 noop（仅 on 被调用）。 */
export function createMockPi(handlers: CapturedHandlers): ExtensionAPI {
	const on = (event: string, handler: (...args: unknown[]) => unknown): void => {
		if (event === "session_start") {
			handlers.sessionStart = handler as CapturedHandlers["sessionStart"];
		} else if (event === "before_agent_start") {
			handlers.beforeAgentStart = handler as CapturedHandlers["beforeAgentStart"];
		} else if (event === "session_shutdown") {
			handlers.sessionShutdown = handler as CapturedHandlers["sessionShutdown"];
		}
	};
	const noop = (): void => {
		/* mock */
	};
	// setup*Injector 仅调 pi.on；用最小对象 + 双重断言满足 ExtensionAPI 契约
	// （测试 mock 约定，见 crash-recovery.test.ts 的 Proxy 模式）
	return {
		on,
		appendEntry: noop,
		registerTool: noop,
		registerCommand: noop,
		registerMessageRenderer: noop,
		events: { emit: noop, on: noop },
	} as unknown as ExtensionAPI;
}

/** 最小 ctx mock（注入器只读 ctx.cwd）。 */
export function createMockCtx(): Record<string, unknown> {
	return { cwd: "/ws", mode: "tui" };
}
