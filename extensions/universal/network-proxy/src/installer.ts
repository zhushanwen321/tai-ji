/**
 * 分流器安装状态机（设计 §3.1 行为序列 1/2 + §3.3 决策 5/8）。
 *
 * 进程级单一安装状态（全局分发器槽是进程级资源，状态必须模块级持有——session 替换重跑
 * factory 时不因闭包重建丢失 originalDispatcher 引用）。转移表：
 *
 * | 当前态           | 事件（新配置）      | 动作                                   | 次态 |
 * |-----------------|--------------------|----------------------------------------|------|
 * | 任意            | enabled=false      | 槽上仍是分流器则恢复 original（仅限槽位归属核查通过） | null |
 * | null            | enabled+新指纹     | 捕获 original → 构造 → 安装             | 装载 |
 * | 装载            | enabled+同指纹+槽位仍归本扩展 | 无动作（不重建不重复安装）        | 装载 |
 * | 装载            | enabled+同指纹+槽位被外部覆盖 | 撤旧装新（pi 启动重装覆盖形态，original=覆盖者） | 装载 |
 * | 锁定            | enabled+同指纹     | 无动作（首败即停不重试）                 | 锁定 |
 * | 任意            | enabled+新指纹     | 构造成功 → 撤旧装新                     | 装载 |
 * | 任意            | enabled+构造失败   | error 上报 + 撤旧（全部直连），记指纹锁定 | 锁定 |
 *
 * 锁定态（current=null）：同指纹不重试构造（fail-fast 首败即停，AGENTS.md 事实驱动原则⑧）；
 * 用户修正配置 → 指纹变化 → 自然重试。依赖注入（get/setGlobalDispatcher、buildProxy、
 * onError）使状态机在单测中以 fake 依赖驱动，不 mock undici 全局槽。
 *
 * 状态机前置伴随入口 = detachResidualDispatcher：jiti 全量 reload 后 installed=null 但槽上
 * 仍挂着旧环境残留分流器，状态机自身无法区分「真无状态」与「reload 残留」，由它在推进前
 * 摘除（转移表各分支才从干净基线成立；pi reload 链实装锚点见该函数注释）。
 */

import type { Dispatcher as IDispatcher } from "undici";

import { networkProxyFingerprint, type NetworkProxyConfig } from "./config.js";
import { isRuleDispatchDispatcher, RuleDispatchDispatcher } from "./dispatcher.js";
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
 * reload 残留摘除（设计 §3.1 行为序列 2 在 reload 窗口的兑现）：jiti 全量 reload 后本扩展
 * 换了新模块环境，installed=null 但全局槽仍挂着旧环境安装的 RuleDispatchDispatcher——
 * 不摘除则 enabled=false 状态机判「无状态」零动作（旧分流器继续生效，禁用失效），或
 * enabled=true 时旧分流器被捕获为 original 嵌套（同一请求经新旧两层各计一次，统计双计）。
 * 摘除 = 恢复残留分流器安装时捕获的原分发器（fallback 引用），状态机从干净基线推进。
 * installed 非 null（同环境 factory 重跑）早退：槽上就是 state.current，摘掉会与
 * 「指纹未变无动作」分支冲突（分流器被摘而状态机不重装）。
 *
 * pi reload 链实装锚点（@earendil-works/pi-coding-agent 1.0.0 dist，逐文件读码核实）：
 * agent-session.js:2899 reload() → :2903 oldRunner.invalidate()（extensions/loader.js:141-149
 * 退订旧 runtime 的全部 eventBus 订阅）→ :2908 resourceLoader.reload()（resource-loader.js:350，
 * :353 clearExtensionCache() 清空 jiti 模块缓存并递增缓存代际）→ loader.js:456-484 缓存代际
 * 失效后 :472-476 新建 jiti 实例（moduleCache: false）重新 import 本扩展、:505-509 重跑工厂
 * ——新环境模块级 installed 重置为 null，旧环境分流器滞留全局槽无人恢复，即本函数的前提。
 */
export function detachResidualDispatcher(
	installed: InstalledState | null,
	deps: Pick<InstallerDeps, "getGlobalDispatcher" | "setGlobalDispatcher">,
): void {
	if (installed !== null) return;
	const current = deps.getGlobalDispatcher();
	if (!isRuleDispatchDispatcher(current)) return;
	deps.setGlobalDispatcher(current.fallback);
}

/**
 * 禁用态收口（转移表首行）：恢复仅限槽位仍归本扩展时执行——槽位已被外部覆盖（pi 启动重装，
 * 见下）时槽上已是 pi 原生分发器，回写 state.originalDispatcher 会把它挤掉（无害但多余），
 * 语义上禁用 = 摘除自己的安装，不是改写别人的。
 */
function restoreOriginalIfOwned(
	state: InstalledState | null,
	deps: Pick<InstallerDeps, "getGlobalDispatcher" | "setGlobalDispatcher">,
): void {
	if (state?.current && deps.getGlobalDispatcher() === state.current) {
		deps.setGlobalDispatcher(state.originalDispatcher);
	}
}

/**
 * 槽位归属核查（pi 启动时序缺陷的根因修复）：pi 1.0.0 启动序列在 extension 安装之后
 * 仍会重跑 configureHttpDispatcher() 整槽覆盖（dist main.js:707 实证）——指纹未变但槽上
 * 已非本扩展分发器时按「撤旧装新」重装。original 统一取槽上现持有者：覆盖场景下
 * state.originalDispatcher 是上一代 pi 原生分发器，fallback 必须指向当前覆盖者才是
 * 「未命中委托 = 未安装本扩展时 pi 的确切行为」。
 */
function resolveOriginal(state: InstalledState | null, slotNow: IDispatcher): IDispatcher {
	return state && state.current !== null && slotNow === state.current
		? state.originalDispatcher
		: slotNow;
}

/** 构造失败收口（转移表末行）：error 上报 + 撤旧（全部直连），返回记指纹的锁定态。 */
function lockOnBuildFailure(
	config: NetworkProxyConfig,
	state: InstalledState | null,
	original: IDispatcher,
	fingerprint: string,
	deps: InstallerDeps,
	error: unknown,
): InstalledState {
	deps.onError(
		`网络代理分流器构造失败（协议 ${config.proxy.protocol}），已保持全部直连，不影响 pi 运行；` +
			`可核对代理配置后保存重试，或关闭网络代理开关。构造错误: ${error instanceof Error ? error.message : String(error)}`,
	);
	if (state?.current) {
		deps.setGlobalDispatcher(original);
	}
	return { originalDispatcher: original, fingerprint, current: null };
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
		restoreOriginalIfOwned(state, deps);
		return null;
	}

	const fingerprint = networkProxyFingerprint(config);
	if (state && state.fingerprint === fingerprint && state.current === null) {
		return state; // 锁定态：同指纹不重试构造（首败即停，决策 8）
	}
	const slotNow = deps.getGlobalDispatcher();
	if (state && state.fingerprint === fingerprint && slotNow === state.current) {
		return state; // 同指纹且槽位仍归本扩展：无动作（不重建不重复安装）
	}
	const original = resolveOriginal(state, slotNow);

	let proxy: IDispatcher;
	try {
		proxy = deps.buildProxy(config);
	} catch (error) {
		return lockOnBuildFailure(config, state, original, fingerprint, deps, error);
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
