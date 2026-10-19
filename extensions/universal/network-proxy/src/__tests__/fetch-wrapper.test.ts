/**
 * fetch 包装状态机单测（fake 依赖注入，不触真实网络）：
 * 命中/未命中分流、计数、noProxy 优先、禁用恢复、外部覆盖重装、构造失败锁定、
 * reload 残留摘除、入参形态覆盖。转移表见 fetch-wrapper.ts 文件头。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dispatcher } from "undici";

import type { NetworkProxyConfig } from "../config.ts";
import {
	applyNetworkProxyConfig,
	detachResidualFetchWrapper,
	type FetchLike,
	type FetchWrapperDeps,
	type ProxyFetchInit,
} from "../fetch-wrapper.ts";
import { resetCounters, snapshotCounters } from "../stats.ts";

class FakeDispatcher extends Dispatcher {}

interface FetchCall { // oe-exempt:20261020:test:测试观测记录形状别名，仅本测试文件消费
	input: string | URL | Request;
	init?: RequestInit;
}

interface ProxyCall { // oe-exempt:20261020:test:测试观测记录形状别名，仅本测试文件消费
	input: string | URL | Request;
	init: ProxyFetchInit;
}

function config(overrides?: Partial<NetworkProxyConfig>): NetworkProxyConfig {
	return {
		enabled: true,
		proxy: { protocol: "http", host: "127.0.0.1", port: 7890, username: "", password: "" },
		noProxy: ["localhost"],
		rules: ["api.anthropic.com"],
		...overrides,
	};
}

function withProxy(patch: Partial<NetworkProxyConfig["proxy"]>): Partial<NetworkProxyConfig> {
	return { proxy: { ...config().proxy, ...patch } };
}

/** fake 依赖装配：original fetch / 代理 fetch / 构造器全部可观测、可注入失败。 */
function createHarness() {
	const originalCalls: FetchCall[] = [];
	const originalFetch: FetchLike = async (input, init) => {
		originalCalls.push({ input, init });
		return new Response("original");
	};
	let currentFetch: FetchLike = originalFetch;

	const proxyCalls: ProxyCall[] = [];
	const proxy = new FakeDispatcher();
	const proxyFetch = async (input: string | URL | Request, init: ProxyFetchInit): Promise<Response> => {
		proxyCalls.push({ input, init });
		return new Response("proxy");
	};

	let buildProxy = (_config: NetworkProxyConfig): Dispatcher => proxy;
	const buildCalls: NetworkProxyConfig[] = [];
	const errors: string[] = [];

	const deps: FetchWrapperDeps = {
		getFetch: () => currentFetch,
		setFetch: (fetch) => {
			currentFetch = fetch;
		},
		buildProxy: (next) => {
			buildCalls.push(next);
			return buildProxy(next);
		},
		proxyFetch,
		onError: (message) => errors.push(message),
	};

	return {
		deps,
		originalFetch,
		originalCalls,
		proxyCalls,
		proxy,
		buildCalls,
		errors,
		getCurrent: () => currentFetch,
		setCurrent: (fetch: FetchLike) => {
			currentFetch = fetch;
		},
		setBuildProxy: (next: (config: NetworkProxyConfig) => Dispatcher) => {
			buildProxy = next;
		},
	};
}

beforeEach(() => {
	resetCounters();
});

describe("applyNetworkProxyConfig 包装状态机", () => {
	it("首装 enabled：包装 globalThis.fetch 槽位（fake 槽），返回包装状态", () => {
		const h = createHarness();
		const state = applyNetworkProxyConfig(config(), null, h.deps);
		expect(state).not.toBeNull();
		expect(state?.wrapper).not.toBeNull();
		expect(h.getCurrent()).toBe(state?.wrapper);
		expect(h.errors).toHaveLength(0);
	});

	it("规则命中：走代理 fetch + proxied 计数，init 保留并注入 dispatcher", async () => {
		const h = createHarness();
		applyNetworkProxyConfig(config(), null, h.deps);
		const response = await h.getCurrent()("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: { "x-test": "1" },
			body: "{}",
		});
		expect(await response.text()).toBe("proxy");
		expect(h.proxyCalls).toHaveLength(1);
		expect(h.originalCalls).toHaveLength(0);
		expect(h.proxyCalls[0]?.init.dispatcher).toBe(h.proxy);
		expect(h.proxyCalls[0]?.init.method).toBe("POST");
		expect(h.proxyCalls[0]?.init.headers).toEqual({ "x-test": "1" });
		expect(h.proxyCalls[0]?.init.body).toBe("{}");
		expect(snapshotCounters().get("api.anthropic.com")).toEqual({ proxied: 1, direct: 0 });
	});

	it("规则未命中：原样委托原 fetch + direct 计数", async () => {
		const h = createHarness();
		applyNetworkProxyConfig(config(), null, h.deps);
		const init: RequestInit = { method: "GET" };
		const response = await h.getCurrent()("https://open.bigmodel.cn/api", init);
		expect(await response.text()).toBe("original");
		expect(h.originalCalls).toHaveLength(1);
		expect(h.originalCalls[0]?.init).toBe(init);
		expect(h.proxyCalls).toHaveLength(0);
		expect(snapshotCounters().get("open.bigmodel.cn")).toEqual({ proxied: 0, direct: 1 });
	});

	it("noProxy 优先于 rules：同主机名两侧都出现时直连", async () => {
		const h = createHarness();
		applyNetworkProxyConfig(
			config({ noProxy: ["api.anthropic.com"], rules: ["api.anthropic.com"] }),
			null,
			h.deps,
		);
		await h.getCurrent()("https://api.anthropic.com/v1/messages");
		expect(h.proxyCalls).toHaveLength(0);
		expect(h.originalCalls).toHaveLength(1);
		expect(snapshotCounters().get("api.anthropic.com")).toEqual({ proxied: 0, direct: 1 });
	});

	it("子域命中 + 点边界：子域走代理，前缀拼接不命中", async () => {
		const h = createHarness();
		applyNetworkProxyConfig(config({ noProxy: [], rules: ["api.anthropic.com"] }), null, h.deps);
		await h.getCurrent()("https://eu.api.anthropic.com/v1");
		await h.getCurrent()("https://xapi.anthropic.com/v1");
		expect(h.proxyCalls).toHaveLength(1);
		expect(h.originalCalls).toHaveLength(1);
	});

	it("入参形态：string / URL / Request 都能识别主机名", async () => {
		const h = createHarness();
		applyNetworkProxyConfig(config({ noProxy: [], rules: ["api.anthropic.com"] }), null, h.deps);
		await h.getCurrent()("https://api.anthropic.com/a");
		await h.getCurrent()(new URL("https://api.anthropic.com/b"));
		await h.getCurrent()(new Request("https://api.anthropic.com/c"));
		expect(h.proxyCalls).toHaveLength(3);
		expect(snapshotCounters().get("api.anthropic.com")).toEqual({ proxied: 3, direct: 0 });
	});

	it("无法解析目标（相对 URL / 空 host）：原样放行且不计数", async () => {
		const h = createHarness();
		applyNetworkProxyConfig(config(), null, h.deps);
		await h.getCurrent()("/relative/path");
		await h.getCurrent()(new URL("file:///tmp/a"));
		expect(h.originalCalls).toHaveLength(2);
		expect(h.proxyCalls).toHaveLength(0);
		expect(snapshotCounters().size).toBe(0);
	});

	it("指纹未变且包装仍在槽位：零动作（状态对象复用，不重建）", () => {
		const h = createHarness();
		const state = applyNetworkProxyConfig(config(), null, h.deps);
		const again = applyNetworkProxyConfig(config(), state, h.deps);
		expect(again).toBe(state);
		expect(h.buildCalls).toHaveLength(1);
	});

	it("指纹变化：重建代理分发器并换新包装", async () => {
		const h = createHarness();
		const first = applyNetworkProxyConfig(config(), null, h.deps);
		const second = applyNetworkProxyConfig(
			config({ rules: ["api.openai.com"] }),
			first,
			h.deps,
		);
		expect(second?.wrapper).not.toBe(first?.wrapper);
		expect(h.buildCalls).toHaveLength(2);
		await h.getCurrent()("https://api.openai.com/v1");
		expect(h.proxyCalls).toHaveLength(1);
	});

	it("槽位被外部覆盖（pi 重跑 configureHttpDispatcher → undici.install）：同指纹也以覆盖者为 original 重新包装", async () => {
		const h = createHarness();
		const first = applyNetworkProxyConfig(config(), null, h.deps);
		// 模拟 pi 设置变更：globalThis.fetch 被 pi 原生实现整体替换，本扩展状态未感知
		const piReinstalled: FetchLike = async () => new Response("pi-native");
		h.setCurrent(piReinstalled);

		const again = applyNetworkProxyConfig(config(), first, h.deps);
		expect(again).not.toBe(first);
		expect(again?.wrapper).not.toBeNull();
		expect(h.getCurrent()).toBe(again?.wrapper);
		// 未命中流量走覆盖者（pi 当前实现），不是旧 original
		await h.getCurrent()("https://open.bigmodel.cn/api");
		expect(h.originalCalls).toHaveLength(0);
		// 命中流量仍走代理
		await h.getCurrent()("https://api.anthropic.com/v1");
		expect(h.proxyCalls).toHaveLength(1);
	});

	it("enabled true→false：恢复原 fetch + 状态清空", () => {
		const h = createHarness();
		const state = applyNetworkProxyConfig(config(), null, h.deps);
		const after = applyNetworkProxyConfig(config({ enabled: false }), state, h.deps);
		expect(after).toBeNull();
		expect(h.getCurrent()).toBe(h.originalFetch);
	});

	it("首装即禁用：零动作", () => {
		const h = createHarness();
		expect(applyNetworkProxyConfig(config({ enabled: false }), null, h.deps)).toBeNull();
		expect(h.buildCalls).toHaveLength(0);
		expect(h.errors).toHaveLength(0);
	});

	it("构造失败：onError + 不包装（全直连），同指纹锁定不重试；指纹变化后重试", () => {
		const h = createHarness();
		h.setBuildProxy(() => {
			throw new TypeError("this[kConnector] is not a function");
		});
		const locked = applyNetworkProxyConfig(config(), null, h.deps);
		expect(locked?.wrapper).toBeNull();
		expect(h.getCurrent()).toBe(h.originalFetch);
		expect(h.errors).toHaveLength(1);
		expect(h.errors[0]).toContain("构造失败");
		expect(h.errors[0]).toContain("直连");

		const stillLocked = applyNetworkProxyConfig(config(), locked, h.deps);
		expect(stillLocked?.wrapper).toBeNull();
		expect(h.buildCalls).toHaveLength(1); // 同指纹不重试

		h.setBuildProxy(() => new FakeDispatcher());
		const recovered = applyNetworkProxyConfig(config(withProxy({ port: 7891 })), stillLocked, h.deps);
		expect(recovered?.wrapper).not.toBeNull();
		expect(h.getCurrent()).toBe(recovered?.wrapper);
	});

	it("运行中重建遇构造失败：撤下旧包装恢复原 fetch，记指纹锁定", () => {
		const h = createHarness();
		const installed = applyNetworkProxyConfig(config(), null, h.deps);
		h.setBuildProxy(() => {
			throw new Error("socks5 experimental API changed");
		});
		const locked = applyNetworkProxyConfig(
			config(withProxy({ protocol: "socks5" })),
			installed,
			h.deps,
		);
		expect(locked?.wrapper).toBeNull();
		expect(h.getCurrent()).toBe(h.originalFetch);
		expect(h.errors[0]).toContain("socks5");
	});

	it("锁定态再遇禁用：状态清空、零槽位操作", () => {
		const h = createHarness();
		h.setBuildProxy(() => {
			throw new Error("boom");
		});
		const locked = applyNetworkProxyConfig(config(), null, h.deps);
		const after = applyNetworkProxyConfig(config({ enabled: false }), locked, h.deps);
		expect(after).toBeNull();
		expect(h.getCurrent()).toBe(h.originalFetch);
	});
});

describe("detachResidualFetchWrapper（reload 残留摘除）", () => {
	it("installed=null 且槽上是本扩展旧包装：恢复其 original fetch", () => {
		const h = createHarness();
		applyNetworkProxyConfig(config(), null, h.deps);
		expect(h.getCurrent()).not.toBe(h.originalFetch);

		// 模拟 reload 后新模块环境：installed=null，槽上仍是旧环境包装
		detachResidualFetchWrapper(null, h.deps);
		expect(h.getCurrent()).toBe(h.originalFetch);
	});

	it("installed=null 且槽上是非本扩展函数：零动作", () => {
		const h = createHarness();
		const foreignFetch: FetchLike = async () => new Response("foreign");
		h.setCurrent(foreignFetch);
		detachResidualFetchWrapper(null, h.deps);
		expect(h.getCurrent()).toBe(foreignFetch);
	});

	it("installed 非 null（同环境 factory 重跑）：早退，不误摘当前包装", () => {
		const h = createHarness();
		const state = applyNetworkProxyConfig(config(), null, h.deps);
		detachResidualFetchWrapper(state, h.deps);
		expect(h.getCurrent()).toBe(state?.wrapper);
	});

	it("reload 后重新推进：摘除旧包装后再包新层（不嵌套双计）", async () => {
		const h = createHarness();
		applyNetworkProxyConfig(config(), null, h.deps);
		detachResidualFetchWrapper(null, h.deps);
		const state = applyNetworkProxyConfig(config(), null, h.deps);
		expect(state?.originalFetch).toBe(h.originalFetch);
		await h.getCurrent()("https://api.anthropic.com/v1");
		expect(h.proxyCalls).toHaveLength(1);
		expect(snapshotCounters().get("api.anthropic.com")).toEqual({ proxied: 1, direct: 0 });
	});
});
