/**
 * 两协议构造形态冒烟（任务书验收②，防回归锚——防实现照抄错形态）：
 * - http/https：ProxyAgent 必须收到 proxyTls 调优（主类内部 buildConnector({...opts.proxyTls})
 *   透传），且不得传 connect 选项（ProxyAgent 不消费该字段——传入被静默忽略、调优失效不报错）
 * - socks5：Socks5ProxyAgent 必须收到函数形态 connect（buildConnector 产物）——构造选项只收
 *   connector 函数，对象形态首个请求建隧道时 TypeError；proxyTls 是 TLS 开关不可当调优袋
 * 契约来源：设计 §3.1 行为序列 3（undici 7.28.0 源码读码 + 构造探针核实）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { proxyAgentCalls, socks5AgentCalls, connectorResults, mockBuildConnector } = vi.hoisted(() => ({
	proxyAgentCalls: [] as Array<Record<string, unknown>>,
	socks5AgentCalls: [] as Array<{ url: string; options: Record<string, unknown> }>,
	connectorResults: [] as Array<(...args: unknown[]) => unknown>,
	mockBuildConnector: (options: Record<string, unknown>) => {
		const connector = () => {};
		connectorResults.push(options);
		return connector;
	},
}));

vi.mock("undici", async (importOriginal) => {
	const actual = await importOriginal<typeof import("undici")>();
	class MockProxyAgent extends actual.Dispatcher {
		constructor(options: Record<string, unknown>) {
			super();
			proxyAgentCalls.push(options);
		}
	}
	class MockSocks5ProxyAgent extends actual.Dispatcher {
		constructor(url: string, options: Record<string, unknown> = {}) {
			super();
			socks5AgentCalls.push({ url, options });
		}
	}
	return {
		...actual,
		ProxyAgent: MockProxyAgent,
		Socks5ProxyAgent: MockSocks5ProxyAgent,
		buildConnector: mockBuildConnector,
	};
});

import {
	buildProxyDispatcher,
	buildProxyUrl,
	PROXY_CONNECT_ATTEMPT_TIMEOUT_MS,
} from "../dispatcher.ts";
import type { NetworkProxyConfig } from "../config.ts";

function config(protocol: "http" | "https" | "socks5"): NetworkProxyConfig {
	return {
		enabled: true,
		proxy: { protocol, host: "127.0.0.1", port: 7890, username: "", password: "" },
		noProxy: [],
		rules: [],
	};
}

beforeEach(() => {
	proxyAgentCalls.length = 0;
	socks5AgentCalls.length = 0;
	connectorResults.length = 0;
});

describe("两协议构造形态冒烟（防回归锚）", () => {
	it("http：ProxyAgent 收到 proxyTls 调优，不传 connect 选项（传入会被静默忽略）", () => {
		buildProxyDispatcher(config("http"));
		expect(proxyAgentCalls).toHaveLength(1);
		const options = proxyAgentCalls[0];
		expect(options.uri).toBe(buildProxyUrl(config("http").proxy));
		// port: 0 = BuildOptions 类型占位（实际建连被目标端口覆盖，见 dispatcher.ts PROXY_TLS_TUNING 注）
		expect(options.proxyTls).toEqual({
			port: 0,
			autoSelectFamilyAttemptTimeout: PROXY_CONNECT_ATTEMPT_TIMEOUT_MS,
		});
		expect("connect" in options).toBe(false);
	});

	it("https 与 http 同走 ProxyAgent（proxyTls 形态一致）", () => {
		buildProxyDispatcher(config("https"));
		expect(proxyAgentCalls).toHaveLength(1);
		expect(proxyAgentCalls[0].proxyTls).toEqual({
			port: 0,
			autoSelectFamilyAttemptTimeout: PROXY_CONNECT_ATTEMPT_TIMEOUT_MS,
		});
	});

	it("socks5：Socks5ProxyAgent 收到函数形态 connect（buildConnector 产物）+ 调优值透传", () => {
		buildProxyDispatcher(config("socks5"));
		expect(socks5AgentCalls).toHaveLength(1);
		const { url, options } = socks5AgentCalls[0];
		expect(url).toBe(buildProxyUrl(config("socks5").proxy));
		expect(typeof options.connect).toBe("function");
		// connect 必须是本实现经 buildConnector 构造的产物（调优经函数形态生效的唯一通道）
		expect(connectorResults).toEqual([
			{ port: 0, autoSelectFamilyAttemptTimeout: PROXY_CONNECT_ATTEMPT_TIMEOUT_MS },
		]);
		// proxyTls 不得作为调优袋传给 socks5（它是 TLS 开关：truthy 即按 TLS 连代理，明文代理会被错误握手）
		expect("proxyTls" in options).toBe(false);
	});

	it("两协议 agent 均挂防崩溃 error listener（对齐 pi withUndiciErrorListener 形态）", () => {
		const httpDispatcher = buildProxyDispatcher(config("http"));
		// EventEmitter "error" 无监听时 emit 会抛——挂上 noop listener 后 listenerCount > 0
		expect(httpDispatcher.listenerCount("error")).toBeGreaterThan(0);
		const socks5Dispatcher = buildProxyDispatcher(config("socks5"));
		expect(socks5Dispatcher.listenerCount("error")).toBeGreaterThan(0);
	});
});
