/**
 * 安装状态机单测（fake 依赖注入，不 mock undici 全局槽）：
 * 指纹比对重建 / 禁用恢复原分发器 / 「构造失败 → 不安装 → 全直连」mock 注入（任务书验收②）。
 * 转移表见 installer.ts 文件头。
 */
import { describe, expect, it, vi } from "vitest";
import { Dispatcher } from "undici";

import type { NetworkProxyConfig } from "../config.ts";
import { RuleDispatchDispatcher } from "../dispatcher.ts";
import {
	applyNetworkProxyConfig,
	detachResidualDispatcher,
	type InstalledState,
	type InstallerDeps,
} from "../installer.ts";

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
	// get/set 连通同一槽变量（与真实全局槽语义一致：set 改写 get 的返回）——
	// 槽位归属核查（installer 同指纹分支）依赖该语义判「槽上是谁」。
	let slot: FakeDispatcher = original;
	const setCalls: FakeDispatcher[] = [];
	const errors: string[] = [];
	const deps: InstallerDeps & { original: FakeDispatcher; setCalls: FakeDispatcher[]; errors: string[] } = {
		getGlobalDispatcher: () => slot,
		setGlobalDispatcher: (d) => {
			slot = d as FakeDispatcher;
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

	// ── 槽位归属核查（pi 启动序列在 extension 安装后重跑 configureHttpDispatcher 整槽覆盖，
	// dist main.js:707 实证——指纹未变也必须重装，否则会话整段生命周期不走代理）──

	/** 可变槽 deps：getGlobalDispatcher 返回当前槽变量（覆盖测试用，createDeps 槽固定）。 */
	function createMutableSlotDeps(initialSlot: FakeDispatcher) {
		let slot: FakeDispatcher = initialSlot;
		const setCalls: FakeDispatcher[] = [];
		const errors: string[] = [];
		const deps: InstallerDeps & { setCalls: FakeDispatcher[]; errors: string[]; setSlot: (d: FakeDispatcher) => void } = {
			getGlobalDispatcher: () => slot,
			setGlobalDispatcher: (d) => {
				slot = d as FakeDispatcher;
				setCalls.push(d as FakeDispatcher);
			},
			buildProxy: () => new FakeDispatcher("proxy"),
			onError: (message) => errors.push(message),
			setCalls,
			errors,
			setSlot: (d) => {
				slot = d;
			},
		};
		return deps;
	}

	it("同指纹但槽位被外部覆盖（pi 启动重装形态）：撤旧装新，fallback = 覆盖者", () => {
		const piNative = new FakeDispatcher("pi-native");
		const deps = createMutableSlotDeps(piNative);
		const first = applyNetworkProxyConfig(config(), null, deps);
		expect(first?.current).not.toBeNull();
		// pi 启动序列整槽覆盖：槽上换成 pi 原生分发器，本扩展状态未感知
		const overwritten = new FakeDispatcher("pi-native-after-reconfigure");
		deps.setSlot(overwritten);
		// 同一配置（指纹未变）下一 turn 推进：必须重装
		const again = applyNetworkProxyConfig(config(), first, deps);
		expect(again?.current).not.toBeNull();
		expect(again?.current).not.toBe(first?.current);
		expect(again?.fingerprint).toBe(first?.fingerprint);
		// 新分流器 fallback = 槽上覆盖者（未命中委托 = 覆盖者的行为）
		expect((again?.current as RuleDispatchDispatcher).fallback).toBe(overwritten);
		// 槽上回到本扩展分发器
		expect(deps.getGlobalDispatcher()).toBe(again?.current);
	});

	it("同指纹且槽位仍归本扩展：零动作（覆盖核查不误伤既有无动作分支）", () => {
		const deps = createMutableSlotDeps(new FakeDispatcher("pi-native"));
		const first = applyNetworkProxyConfig(config(), null, deps);
		const setCallsAfterInstall = deps.setCalls.length;
		const again = applyNetworkProxyConfig(config(), first, deps);
		expect(again).toBe(first);
		expect(deps.setCalls).toHaveLength(setCallsAfterInstall);
	});

	it("禁用时槽位已被外部覆盖：不回写（槽保持覆盖者）、状态清空", () => {
		const deps = createMutableSlotDeps(new FakeDispatcher("pi-native"));
		const installed = applyNetworkProxyConfig(config(), null, deps);
		const overwritten = new FakeDispatcher("pi-native-after-reconfigure");
		deps.setSlot(overwritten);
		const setCallsAfterInstall = deps.setCalls.length;
		const after = applyNetworkProxyConfig(config({ enabled: false }), installed, deps);
		expect(after).toBeNull();
		expect(deps.setCalls).toHaveLength(setCallsAfterInstall);
		expect(deps.getGlobalDispatcher()).toBe(overwritten);
	});
});

describe("detachResidualDispatcher（reload 残留摘除）", () => {
	/** 模拟旧模块环境残留在全局槽上的分流器（跨环境识别走 Symbol.for 标记，不走 instanceof）。 */
	function residualDispatcher(original: FakeDispatcher): RuleDispatchDispatcher {
		return new RuleDispatchDispatcher({
			fallback: original,
			proxy: new FakeDispatcher("proxy"),
			noProxy: [],
			rules: [],
			onCount: () => {},
		});
	}

	it("installed=null 且槽上是残留分流器：恢复其 fallback（旧环境安装时捕获的原分发器）", () => {
		const sharedOriginal = new FakeDispatcher("original");
		const deps = createDeps(() => new FakeDispatcher("proxy"), sharedOriginal);
		const residual = residualDispatcher(sharedOriginal);
		detachResidualDispatcher(null, { ...deps, getGlobalDispatcher: () => residual });
		expect(deps.setCalls).toEqual([sharedOriginal]);
	});

	it("installed=null 且槽上是 pi 原生分发器（非本扩展）：零动作", () => {
		const deps = createDeps();
		detachResidualDispatcher(null, deps);
		expect(deps.setCalls).toHaveLength(0);
	});

	it("installed 非 null（同环境 factory 重跑）：早退零动作——槽上 current 不被误摘", () => {
		const deps = createDeps();
		const state = applyNetworkProxyConfig(config(), null, deps);
		expect(state).not.toBeNull();
		detachResidualDispatcher(state, deps);
		expect(deps.setCalls).toHaveLength(1); // 仅首装那一次，摘除未触发
	});

	it("reload 后推进状态机：enabled=false 恢复直连（摘除 + 零动作，无旧分流器残留）", () => {
		const sharedOriginal = new FakeDispatcher("original");
		const deps = createDeps(() => new FakeDispatcher("proxy"), sharedOriginal);
		const residual = residualDispatcher(sharedOriginal);
		// reload 形态：新环境 installed=null、槽上是旧环境残留
		detachResidualDispatcher(null, { ...deps, getGlobalDispatcher: () => residual });
		const after = applyNetworkProxyConfig(config({ enabled: false }), null, {
			...deps,
			getGlobalDispatcher: () => sharedOriginal,
		});
		expect(after).toBeNull();
		expect(deps.setCalls).toEqual([sharedOriginal]); // 摘除那一次；禁用分支零动作
	});

	it("reload 后推进状态机：enabled=true 捕获的 original 是原分发器（无嵌套双计）", () => {
		const sharedOriginal = new FakeDispatcher("original");
		const deps = createDeps(() => new FakeDispatcher("proxy"), sharedOriginal);
		const residual = residualDispatcher(sharedOriginal);
		detachResidualDispatcher(null, { ...deps, getGlobalDispatcher: () => residual });
		const state = applyNetworkProxyConfig(config(), null, {
			...deps,
			getGlobalDispatcher: () => sharedOriginal,
		});
		expect(state?.originalDispatcher).toBe(sharedOriginal);
		expect(state?.current).toBeInstanceOf(RuleDispatchDispatcher);
		// 新分流器的 fallback 是原分发器而非旧残留——同一请求只经一层计数
		expect((state?.current as RuleDispatchDispatcher).fallback).toBe(sharedOriginal);
	});
});
