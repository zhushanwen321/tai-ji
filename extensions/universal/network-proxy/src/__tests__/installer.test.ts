/**
 * 安装状态机单测（fake 依赖注入，不 mock undici 全局槽）：
 * 指纹比对重建 / 禁用恢复原分发器 / 「构造失败 → 不安装 → 全直连」mock 注入（任务书验收②）。
 * 转移表见 installer.ts 文件头。
 */
import { describe, expect, it, vi } from "vitest";
import { Dispatcher } from "undici";

import type { NetworkProxyConfig } from "../config.ts";
import { RuleDispatchDispatcher } from "../dispatcher.ts";
import { applyNetworkProxyConfig, type InstalledState, type InstallerDeps } from "../installer.ts";

class FakeDispatcher extends Dispatcher {
	readonly label: string;
	constructor(label: string) {
		super();
		this.label = label;
	}
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

/** proxy 字段深覆盖辅助（overrides 是浅合并——protocol/port 必须写进 proxy 对象才进指纹）。 */
function withProxy(patch: Partial<NetworkProxyConfig["proxy"]>): Partial<NetworkProxyConfig> {
	return { proxy: { ...config().proxy, ...patch } };
}

/** fake 依赖装配：original 捕获、set 调用记录、可注入的构造器（默认成功）。
 * original 可注入共享（真实场景进程内只有一个原分发器——跨 deps 实例传状态时恢复的是
 * 首装 deps 捕获的同一实例）。 */
function createDeps(
	buildProxy: (c: NetworkProxyConfig) => FakeDispatcher = () => new FakeDispatcher("proxy"),
	sharedOriginal = new FakeDispatcher("original"),
) {
	const original = sharedOriginal;
	const setCalls: FakeDispatcher[] = [];
	const errors: string[] = [];
	const deps: InstallerDeps & { original: FakeDispatcher; setCalls: FakeDispatcher[]; errors: string[] } = {
		getGlobalDispatcher: () => original,
		setGlobalDispatcher: (d) => {
			setCalls.push(d as FakeDispatcher);
		},
		buildProxy,
		onError: (message) => errors.push(message),
		original,
		setCalls,
		errors,
	};
	return deps;
}

describe("applyNetworkProxyConfig 状态机", () => {
	it("首装 enabled：捕获 original → 构造 → 安装，状态装载", () => {
		const deps = createDeps();
		const state = applyNetworkProxyConfig(config(), null, deps);
		expect(state).not.toBeNull();
		expect(state?.current).toBeInstanceOf(RuleDispatchDispatcher);
		expect(state?.originalDispatcher).toBe(deps.original);
		expect(deps.setCalls).toHaveLength(1);
		expect(deps.errors).toHaveLength(0);
	});

	it("指纹未变：不重建不重复安装（setGlobalDispatcher 零调用）", () => {
		const deps = createDeps();
		const state = applyNetworkProxyConfig(config(), null, deps);
		expect(deps.setCalls).toHaveLength(1);
		const again = applyNetworkProxyConfig(config(), state, deps);
		expect(again).toBe(state);
		expect(deps.setCalls).toHaveLength(1);
	});

	it("指纹变化：撤旧装新，original 引用跨重建保留", () => {
		const deps = createDeps();
		const first = applyNetworkProxyConfig(config(), null, deps);
		const changed = applyNetworkProxyConfig(
			config({ rules: ["api.openai.com"] }),
			first,
			deps,
		);
		expect(changed?.current).not.toBe(first?.current);
		expect(changed?.originalDispatcher).toBe(deps.original);
		expect(deps.setCalls).toHaveLength(2);
	});

	it("enabled true→false：恢复原分发器（槽上回到 original）+ 状态清空", () => {
		const deps = createDeps();
		const installed = applyNetworkProxyConfig(config(), null, deps);
		const after = applyNetworkProxyConfig(config({ enabled: false }), installed, deps);
		expect(after).toBeNull();
		expect(deps.setCalls).toHaveLength(2);
		expect(deps.setCalls[1]).toBe(deps.original);
	});

	it("首装即禁用（enabled=false + 无状态）：零动作", () => {
		const deps = createDeps();
		expect(applyNetworkProxyConfig(config({ enabled: false }), null, deps)).toBeNull();
		expect(deps.setCalls).toHaveLength(0);
		expect(deps.errors).toHaveLength(0);
	});

	it("构造失败（mock 注入抛错）：onError 上报 + 不安装（setGlobalDispatcher 零调用）——全直连", () => {
		const deps = createDeps(() => {
			throw new TypeError("this[kConnector] is not a function");
		});
		const state = applyNetworkProxyConfig(config(), null, deps);
		expect(state?.current).toBeNull();
		expect(deps.setCalls).toHaveLength(0); // 槽上仍是 pi 原生分发器 = 全部直连
		expect(deps.errors).toHaveLength(1);
		expect(deps.errors[0]).toContain("构造失败");
		expect(deps.errors[0]).toContain("直连");
	});

	it("锁定态同指纹不重试构造；指纹变化后重试（用户修正配置自然恢复）", () => {
		let shouldThrow = true;
		const deps = createDeps(() => {
			if (shouldThrow) throw new Error("boom");
			return new FakeDispatcher("proxy");
		});
		const locked = applyNetworkProxyConfig(config(), null, deps);
		expect(locked?.current).toBeNull();

		// 同指纹：不重试（fail-fast 首败即停）
		const stillLocked = applyNetworkProxyConfig(config(), locked, deps);
		expect(stillLocked?.current).toBeNull();
		expect(deps.errors).toHaveLength(1);

		// 用户修正（端口变化 → 指纹变化）：重试成功并安装
		shouldThrow = false;
		const recovered = applyNetworkProxyConfig(config(withProxy({ port: 7891 })), stillLocked, deps);
		expect(recovered?.current).toBeInstanceOf(RuleDispatchDispatcher);
		expect(deps.setCalls).toHaveLength(1);
	});

	it("运行中重建遇构造失败：撤下旧分流器恢复原分发器（全部直连），记指纹锁定", () => {
		const sharedOriginal = new FakeDispatcher("original");
		const deps = createDeps(() => new FakeDispatcher("proxy"), sharedOriginal);
		const installed = applyNetworkProxyConfig(config(), null, deps);
		expect(deps.setCalls).toHaveLength(1);

		const failing = createDeps(() => {
			throw new Error("socks5 experimental API changed");
		}, sharedOriginal);
		const locked = applyNetworkProxyConfig(config(withProxy({ protocol: "socks5" })), installed, failing);
		expect(locked?.current).toBeNull();
		// 撤旧：set 收到 original（回 pi 原生行为 = 全部直连/env 代理路由）
		expect(failing.setCalls).toHaveLength(1);
		expect(failing.setCalls[0]).toBe(sharedOriginal);
		expect(failing.errors[0]).toContain("socks5");
	});

	it("锁定态再遇禁用：无槽操作、状态清空（构造失败后关开关 = 干净退出）", () => {
		const deps = createDeps(() => {
			throw new Error("boom");
		});
		const locked = applyNetworkProxyConfig(config(), null, deps);
		const after = applyNetworkProxyConfig(config({ enabled: false }), locked, deps);
		expect(after).toBeNull();
		expect(deps.setCalls).toHaveLength(0);
	});

	it("安装状态的 current 即 setGlobalDispatcher 收到的实例（槽与状态一致）", () => {
		const deps = createDeps();
		const state: InstalledState | null = applyNetworkProxyConfig(config(), null, deps);
		expect(deps.setCalls[0]).toBe(state?.current);
		expect(vi.isMockFunction(deps.onError)).toBe(false);
	});
});
