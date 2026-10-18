/**
 * 分流器安装状态机（设计 §3.1 行为序列 1/2 + §3.3 决策 5/8）。
 *
 * 进程级单一安装状态（全局分发器槽是进程级资源，状态必须模块级持有——session 替换重跑
 * factory 时不因闭包重建丢失 originalDispatcher 引用）。转移表：
 *
 * | 当前态           | 事件（新配置）      | 动作                                   | 次态 |
 * |-----------------|--------------------|----------------------------------------|------|
 * | 任意            | enabled=false      | 槽上仍是分流器则恢复 original           | null |
 * | null            | enabled+新指纹     | 捕获 original → 构造 → 安装             | 装载 |
 * | 装载/锁定       | enabled+同指纹     | 无动作（不重建不重复安装）               | 原态 |
 * | 任意            | enabled+新指纹     | 构造成功 → 撤旧装新                     | 装载 |
 * | 任意            | enabled+构造失败   | error 上报 + 撤旧（全部直连），记指纹锁定 | 锁定 |
 *
 * 锁定态（current=null）：同指纹不重试构造（fail-fast 首败即停，AGENTS.md 事实驱动原则⑧）；
 * 用户修正配置 → 指纹变化 → 自然重试。依赖注入（get/setGlobalDispatcher、buildProxy、
 * onError）使状态机在单测中以 fake 依赖驱动，不 mock undici 全局槽。
 */

import type { Dispatcher as IDispatcher } from "undici";

import { networkProxyFingerprint, type NetworkProxyConfig } from "./config.js";
import { RuleDispatchDispatcher } from "./dispatcher.js";
import { recordDispatch } from "./stats.js";

/** 当前安装状态；null = 未安装（槽上是 pi 原生分发器）。 */
export interface InstalledState { // oe-exempt:20261019:framework:安装状态机载体形状（状态机唯一状态类型，单实现为常态）

	/** 安装前捕获的原分发器引用（首次捕获后跨重建保留——恢复与 fallback 都用它）。 */
	originalDispatcher: IDispatcher;
	/** 已安装（或已锁定失败）配置的指纹。 */
	fingerprint: string;
	/** 槽上的分流器；null = 构造失败锁定态（未安装）。 */
	current: IDispatcher | null;
}

export interface InstallerDeps { // oe-exempt:20261019:framework:安装状态机依赖注入接缝（单测注入 get/setGlobalDispatcher 与可抛 buildProxy）

	getGlobalDispatcher: () => IDispatcher;
	setGlobalDispatcher: (dispatcher: IDispatcher) => void;
	/** 代理分发器构造（可注入抛错——「构造失败 → 不安装 → 全直连」单测入口）。 */
	buildProxy: (config: NetworkProxyConfig) => IDispatcher;
	/** extension error 呈现（logger.error；文案含恢复动作）。 */
	onError: (message: string) => void;
}

/**
 * 按新配置推进安装状态机（见模块头转移表）。config 契约 = loadNetworkProxyConfig 产物
 * （normalize 已校验合法——非法配置在读取层回落 defaults+error，构造性到达本函数恒合法）。
 */
export function applyNetworkProxyConfig(
	config: NetworkProxyConfig,
	state: InstalledState | null,
	deps: InstallerDeps,
): InstalledState | null {
	if (!config.enabled) {
		if (state?.current) {
			deps.setGlobalDispatcher(state.originalDispatcher);
		}
		return null;
	}

	const fingerprint = networkProxyFingerprint(config);
	if (state && state.fingerprint === fingerprint) {
		return state;
	}

	const original = state?.originalDispatcher ?? deps.getGlobalDispatcher();

	let proxy: IDispatcher;
	try {
		proxy = deps.buildProxy(config);
	} catch (error) {
		deps.onError(
			`网络代理分流器构造失败（协议 ${config.proxy.protocol}），已保持全部直连，不影响 pi 运行；` +
				`可核对代理配置后保存重试，或关闭网络代理开关。构造错误: ${error instanceof Error ? error.message : String(error)}`,
		);
		if (state?.current) {
			deps.setGlobalDispatcher(original);
		}
		return { originalDispatcher: original, fingerprint, current: null };
	}

	const dispatcher = new RuleDispatchDispatcher({
		fallback: original,
		proxy,
		noProxy: config.noProxy,
		rules: config.rules,
		onCount: recordDispatch,
	});
	deps.setGlobalDispatcher(dispatcher);
	return { originalDispatcher: original, fingerprint, current: dispatcher };
}
