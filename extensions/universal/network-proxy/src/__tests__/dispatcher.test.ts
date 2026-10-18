/**
 * 分流分发器行为 + 代理 URL 构造（dispatch 拦截点 / noProxy 优先 / 计数时点 / 委托语义）。
 * 两协议构造形态冒烟在 dispatcher-construction.test.ts（vi.mock undici 隔离）。
 */
import { describe, expect, it, vi } from "vitest";
import { Dispatcher } from "undici";
import type { Dispatcher as IDispatcher } from "undici";

import { buildProxyUrl, RuleDispatchDispatcher } from "../dispatcher.ts";
import type { NetworkProxyServer } from "../config.ts";

class RecordingDispatcher extends Dispatcher {
	calls: Array<{ origin: string | URL | undefined }> = [];
	dispatch(opts: IDispatcher.DispatchOptions, _handler: IDispatcher.DispatchHandler): boolean {
		this.calls.push({ origin: opts.origin });
		return true;
	}
}

function configLists(noProxy: string[], rules: string[]) {
	return { noProxy, rules };
}

function dispatchVia(
	dispatcher: RuleDispatchDispatcher,
	origin: string | URL | undefined,
): { toProxy: boolean; toFallback: boolean } {
	proxyDispatcher.calls = [];
	fallbackDispatcher.calls = [];
	dispatcher.dispatch({ origin, path: "/", method: "GET" }, {});
	return {
		toProxy: proxyDispatcher.calls.length > 0,
		toFallback: fallbackDispatcher.calls.length > 0,
	};
}

let fallbackDispatcher: RecordingDispatcher;
let proxyDispatcher: RecordingDispatcher;
let counted: Array<{ host: string; proxied: boolean }>;

function createDispatcher(noProxy: string[], rules: string[]): RuleDispatchDispatcher {
	fallbackDispatcher = new RecordingDispatcher();
	proxyDispatcher = new RecordingDispatcher();
	counted = [];
	return new RuleDispatchDispatcher({
		fallback: fallbackDispatcher,
		proxy: proxyDispatcher,
		...configLists(noProxy, rules),
		onCount: (host, proxied) => counted.push({ host, proxied }),
	});
}

describe("RuleDispatchDispatcher 分流行为", () => {
	it("规则命中 → 代理 dispatch + proxied 计数（计数时点 = 发起时，同步完成）", () => {
		const dispatcher = createDispatcher(["localhost"], ["api.anthropic.com"]);
		const result = dispatchVia(dispatcher, "https://api.anthropic.com/v1/messages");
		expect(result).toEqual({ toProxy: true, toFallback: false });
		expect(counted).toEqual([{ host: "api.anthropic.com", proxied: true }]);
	});

	it("规则未命中 → 委托原分发器（fallback）+ direct 计数", () => {
		const dispatcher = createDispatcher(["localhost"], ["api.anthropic.com"]);
		const result = dispatchVia(dispatcher, "https://open.bigmodel.cn/api");
		expect(result).toEqual({ toProxy: false, toFallback: true });
		expect(counted).toEqual([{ host: "open.bigmodel.cn", proxied: false }]);
	});

	it("noProxy 优先于 rules：同主机名两侧都出现时直连（决策 7）", () => {
		const dispatcher = createDispatcher(["api.anthropic.com"], ["api.anthropic.com"]);
		const result = dispatchVia(dispatcher, "https://api.anthropic.com/v1/messages");
		expect(result).toEqual({ toProxy: false, toFallback: true });
		expect(counted).toEqual([{ host: "api.anthropic.com", proxied: false }]);
	});

	it("子域命中 + 点边界：子域走代理，前缀拼接不命中走 fallback", () => {
		const dispatcher = createDispatcher([], ["api.anthropic.com"]);
		expect(dispatchVia(dispatcher, "https://eu.api.anthropic.com/v1").toProxy).toBe(true);
		expect(dispatchVia(dispatcher, "https://xapi.anthropic.com/v1").toFallback).toBe(true);
	});

	it("归一化参与分流：大写 / 末尾点 origin 命中规则", () => {
		const dispatcher = createDispatcher([], ["api.anthropic.com"]);
		expect(dispatchVia(dispatcher, "https://API.Anthropic.COM./v1").toProxy).toBe(true);
	});

	it("URL 对象形态的 origin 同样处理", () => {
		const dispatcher = createDispatcher([], ["api.anthropic.com"]);
		expect(dispatchVia(dispatcher, new URL("https://api.anthropic.com/v1")).toProxy).toBe(true);
	});

	it("origin 缺失（无已发生证据的异常路径）→ 委托 fallback + direct 计数，不抛", () => {
		const dispatcher = createDispatcher([], ["api.anthropic.com"]);
		expect(() => dispatchVia(dispatcher, undefined)).not.toThrow();
		expect(counted).toEqual([{ host: "", proxied: false }]);
	});

	it("计数按主机名聚合可累计（多次请求同主机名同键累加）", () => {
		const dispatcher = createDispatcher([], ["api.anthropic.com"]);
		dispatchVia(dispatcher, "https://api.anthropic.com/a");
		dispatchVia(dispatcher, "https://eu.api.anthropic.com/b");
		expect(counted).toEqual([
			{ host: "api.anthropic.com", proxied: true },
			{ host: "eu.api.anthropic.com", proxied: true },
		]);
	});

	it("handler 原样透传给目标分发器（未命中委托语义 = pi 原生行为不变）", () => {
		const dispatcher = createDispatcher([], []);
		const handler = { onHeaders: vi.fn() } as unknown as IDispatcher.DispatchHandler;
		const opts = { origin: "https://any.test", path: "/", method: "GET" } as IDispatcher.DispatchOptions;
		const seen: Array<unknown> = [];
		fallbackDispatcher = new RecordingDispatcher();
		vi.spyOn(fallbackDispatcher, "dispatch").mockImplementation((o, h) => {
			seen.push({ o, h });
			return true;
		});
		const relay = new RuleDispatchDispatcher({
			fallback: fallbackDispatcher,
			proxy: new RecordingDispatcher(),
			noProxy: [],
			rules: [],
			onCount: () => {},
		});
		relay.dispatch(opts, handler);
		expect(seen).toHaveLength(1);
		expect((seen[0] as { h: unknown }).h).toBe(handler);
	});
});

describe("buildProxyUrl（凭据 percent-encode 拼入）", () => {
	const base: NetworkProxyServer = {
		protocol: "http",
		host: "127.0.0.1",
		port: 7890,
		username: "",
		password: "",
	};

	it("无凭据形态", () => {
		expect(buildProxyUrl(base)).toBe("http://127.0.0.1:7890");
	});

	it("凭据 percent-encode 拼入（特殊字符被编码，undici 构造内部 decodeURIComponent 还原）", () => {
		expect(buildProxyUrl({ ...base, username: "user@example.com", password: "p@ss:word" })).toBe(
			"http://user%40example.com:p%40ss%3Aword@127.0.0.1:7890",
		);
	});

	it("socks5 协议形态（Socks5ProxyAgent 校验 socks5: 协议头）", () => {
		expect(buildProxyUrl({ ...base, protocol: "socks5", port: 1080 })).toBe("socks5://127.0.0.1:1080");
	});

	it("https 协议形态", () => {
		expect(buildProxyUrl({ ...base, protocol: "https", port: 443 })).toBe("https://127.0.0.1:443");
	});
});
