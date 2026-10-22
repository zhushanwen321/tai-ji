/**
 * 网络代理请求拦截层：包装 pi 进程的 `globalThis.fetch`（打包版兼容设计）。
 *
 * 为什么不是 undici 全局分发器：打包版 pi 是 Bun 单文件二进制，HTTP 栈用二进制内置的
 * undici（`builtin://thirdparty/undici`）；扩展 bundle 由 esbuild 内联自己的 undici 副本
 * （`scripts/bundle-extensions.mjs` 的 EXTERNAL 不含 undici）。undici 的
 * `setGlobalDispatcher` 槽是模块级变量，两套副本互不相通——扩展改的全局槽 pi 根本不用，
 * LLM 请求照常直连（2026-10-20 打包版实测：请求直连 Cloudflare，统计文件零行）。
 * dev 用 `node_modules/.bin/pi`，pi 与扩展源码解析到同一份 undici，所以旧方案在 dev 正常、
 * 打包版静默失效。
 *
 * 稳定接缝 = `globalThis.fetch`：pi-ai 的 OpenAI 兼容请求在每次构造 client 时经
 * `Shims.getDefaultFetch()` 动态取当前全局 fetch（node_modules/openai/internal/shims.js），
 * 包装它不依赖 pi 与扩展是否共享 undici 副本。命中规则的请求用扩展自己的 undici fetch +
 * 分发器发出（代理或 IPv4 锁定，见 dispatcher.ts）；未命中的请求原样调用包装前的 fetch，
 * 保留 pi 原生 EnvHttpProxyAgent / 连接调优 / 错误处理语义。
 *
 * 生命周期与旧安装状态机同构：
 * - 加载 / 每 turn 开始：重读配置推进状态（`enabled` 关且 `ipv4Only` 空 = 摘除包装恢复原
 *   fetch；`ipv4Only` 非空时包装保留——IPv4 锁定是直连地址族修正，独立于代理开关）；
 * - 指纹未变且包装仍在进程槽位：零动作（不重建）；
  * - 槽位被第三方整体覆盖（其他 extension 包装 / 手动改写；pi 的 configureHttpDispatcher
  *   有 shouldInstallGlobals 守卫（pi dist/core/http-dispatcher.js:88-99）——检测到 fetch
  *   已被第三方覆盖即保留不重装，本扩展的包装在同进程内持续生效）→ 以覆盖者为新 original
  *   重新包装（防御路径）；
 * - 构造失败：onError + 恢复原 fetch（全部直连），同指纹锁定不重试（首败即停）。
 *
 * reload 残留：jiti 全量 reload 后旧模块环境的包装可能仍挂在 globalThis.fetch 上；包装函数
 * 带 `Symbol.for` 标记（跨模块环境共享），新环境推进前先摘除，防嵌套双计。
 */

import type { Dispatcher } from "undici";

import {
	hitsIpv4Only,
	hitsNoProxy,
	hitsRules,
	networkProxyFingerprint,
	type NetworkProxyConfig,
} from "./config.js";
import { normalizeHostname } from "./match.js";
import { recordDispatch } from "./stats.js";

/** pi 进程的全局 fetch 形态（Node 类型由 @types/node 的 web-globals 提供）。 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type FetchInput = Parameters<FetchLike>[0];

/**
 * 经分发器发出时的 init：保留调用方全部选项，附上本次请求的分发器（代理或 IPv4 锁定）。
 * Omit 掉 Node 全局 RequestInit 自带的 dispatcher（undici-types 类型身份），避免与 npm
 * undici 的 Dispatcher 形成 `Dispatcher & Dispatcher` 冲突；运行时由本字段整体覆盖。
 * 签名自包含（不引用文件内私有别名 FetchInit）——导出签名的被引用类型必须可命名。
 */
export type ProxyFetchInit = Omit<NonNullable<Parameters<FetchLike>[1]>, "dispatcher"> & { dispatcher: Dispatcher };

/** 代理 fetch 注入接缝：生产环境 = undici.fetch；单测用 fake 避免真实网络。 */
export type ProxyFetch = (input: Parameters<FetchLike>[0], init: ProxyFetchInit) => Promise<Response>;

/**
 * 跨模块环境身份标记（Symbol.for 进程级注册表，jiti reload 后新旧环境共享）：
 * 记录包装前捕获的 original fetch，供新环境摘除旧包装。
 */
const FETCH_WRAPPER_MARK = Symbol.for("@zhushanwen/pi-network-proxy:fetch-wrapper");

interface FetchWrapperMark { // oe-exempt:20261020:framework:包装函数标记形状（跨模块环境身份契约，单实现为常态）

	originalFetch: FetchLike;
}

/** 当前包装状态；null = 未包装（globalThis.fetch 是 pi 原生实现）。 */
export interface FetchWrapperState { // oe-exempt:20261020:framework:包装状态机载体形状（状态机唯一状态类型，单实现为常态）

	/** 包装前捕获的原 fetch（首次捕获后跨重建保留——恢复与直连委托都用它）。 */
	originalFetch: FetchLike;
	/** 已应用（或已锁定失败）配置的指纹。 */
	fingerprint: string;
	/** 当前包装函数；null = 构造失败锁定态（未包装）。 */
	wrapper: FetchLike | null;
}

export interface FetchWrapperDeps { // oe-exempt:20261020:framework:状态机依赖注入接缝（单测注入 fake fetch / buildProxy / proxyFetch）

	getFetch: () => FetchLike;
	setFetch: (fetch: FetchLike) => void;
	/** 代理分发器构造（可注入抛错——「构造失败 → 不包装 → 全直连」单测入口）。 */
	buildProxy: (config: NetworkProxyConfig) => Dispatcher;
	/**
	 * IPv4 锁定分发器构造（`connect.lookup` 强制 family:4）。
	 * 只在 `ipv4Only` 非空时调用；可注入抛错（回退到「不做 v4 锁定」）。
	 */
	buildIpv4: () => Dispatcher;
	proxyFetch: ProxyFetch;
	/** extension error 呈现（logger.error；文案含恢复动作）。 */
	onError: (message: string) => void;
}

/** 从 URL 字符串取归一化主机名；非法 URL 返回空串（不计数、原样放行）。 */
function hostnameOfUrl(raw: string): string {
	try {
		return normalizeHostname(new URL(raw).hostname);
	} catch {
		return "";
	}
}

/**
 * 从 fetch 入参取主机名：string / URL / Request（含 url 属性的对象）。
 * 空串 = 无法判定目标（相对 URL / 非法入参），调用方原样放行且不计数。
 */
function hostnameOfInput(input: FetchInput): string {
	if (typeof input === "string") return hostnameOfUrl(input);
	if (input instanceof URL) return normalizeHostname(input.hostname);
	if (typeof input === "object" && input !== null && "url" in input) {
		const url: unknown = input.url;
		if (typeof url === "string") return hostnameOfUrl(url);
	}
	return "";
}

/** 给包装函数打标记（不可枚举，避免暴露给业务代码的序列化/枚举）。 */
function markWrapper(wrapper: FetchLike, originalFetch: FetchLike): void {
	Object.defineProperty(wrapper, FETCH_WRAPPER_MARK, {
		value: { originalFetch } satisfies FetchWrapperMark,
		enumerable: false,
		configurable: false,
		writable: false,
	});
}

/** 函数形态守卫（标记值的 originalFetch 校验，避免断言到 FetchLike）。 */
function isFetchLike(value: unknown): value is FetchLike {
	return typeof value === "function";
}

/** 读取包装标记；非本扩展包装返回 null。 */
function wrapperMarkOf(fetch: FetchLike): FetchWrapperMark | null {
	const descriptor = Object.getOwnPropertyDescriptor(fetch, FETCH_WRAPPER_MARK);
	if (descriptor === undefined || !("value" in descriptor)) return null;
	const value: unknown = descriptor.value;
	if (value === null || typeof value !== "object") return null;
	const original: unknown = Reflect.get(value, "originalFetch");
	return isFetchLike(original) ? { originalFetch: original } : null;
}

/**
 * 构造包装函数：每次调用现算 host → 计数 → 三态分流，全部未命中则委托原 fetch。
 *
 * 分流优先级（单一源在这里，config.ts 的 hits* 只提供匹配，不重复排序）：
 * 1. `noProxy` 命中 → 原样直连（用户显式排除，连 IPv4 锁定也不做）；
 * 2. `ipv4Only` 命中 → IPv4 锁定直连（**不走代理**，本扩展只做地址族选择；独立于
 *    `enabled` 代理开关——开关关闭时本分支照常生效）；
 * 3. `enabled` 且 `rules` 命中 → 经代理 fetch（开关关闭时 rules 不参与分流，落入直连）；
 * 4. 其余 → 原样直连。
 *
 * 计数时点 = 请求发起时（与旧分流器一致；不等待完成，成败由 pi 原生错误链路呈现）。
 * ipv4 锁定计入 `direct`（语义上确实是直连，与经代理区分）。
 */
function createWrappedFetch(
	originalFetch: FetchLike,
	config: NetworkProxyConfig,
	proxy: Dispatcher | null,
	ipv4: Dispatcher | null,
	proxyFetch: ProxyFetch,
): FetchLike {
	const wrapped: FetchLike = async (input, init) => {
		const host = hostnameOfInput(input);
		if (host === "") return originalFetch(input, init);

		if (hitsNoProxy(host, config.noProxy)) {
			recordDispatch(host, false);
			return originalFetch(input, init);
		}

		if (hitsIpv4Only(host, config.ipv4Only)) {
			recordDispatch(host, false);
			// URL / Host 头 / TLS 全部保持原样，只把 DNS 族锁到 IPv4（connect.lookup）。
			// 构造失败（ipv4 === null）= 降级为普通直连（不阻断请求）。
			if (ipv4 === null) return originalFetch(input, init);
			return proxyFetch(input, { ...(init ?? {}), dispatcher: ipv4 });
		}

		if (config.enabled && hitsRules(host, config.rules)) {
			recordDispatch(host, true);
			// proxy 非空由 applyNetworkProxyConfig 保证（rules 非空才会构造）。
			if (proxy === null) return originalFetch(input, init);
			return proxyFetch(input, { ...(init ?? {}), dispatcher: proxy });
		}

		recordDispatch(host, false);
		return originalFetch(input, init);
	};
	markWrapper(wrapped, originalFetch);
	return wrapped;
}

/**
 * 槽位归属判定：state 记录的包装当前是否仍挂在 globalThis.fetch 上。
 * 三处共用（禁用恢复 / 构造失败恢复 / 重建前 original 推导）——槽位被第三方
 * 整体覆盖时不再改写别人的实现，也不把覆盖者误当自己的 original。
 */
function wrapperStillInstalled(
	state: FetchWrapperState | null,
	currentFetch: FetchLike,
): boolean {
	return (
		state?.wrapper !== null && state?.wrapper !== undefined && currentFetch === state.wrapper
	);
}

/** 禁用态收口：仅当槽位仍归本扩展时恢复原 fetch（槽位被外部覆盖时不改写别人的实现）。 */
function restoreOriginalIfOwned(
	state: FetchWrapperState | null,
	deps: Pick<FetchWrapperDeps, "getFetch" | "setFetch">,
): void {
	// state !== null 前置（谓词函数不向调用方传播 narrowing；state 为 null 时谓词恒 false，语义等价）
	if (state !== null && wrapperStillInstalled(state, deps.getFetch())) {
		deps.setFetch(state.originalFetch);
	}
}

/**
 * jiti reload 残留摘除：新模块环境 installed=null 但旧环境的包装仍挂在 globalThis.fetch 上。
 * 不摘除则 enabled=false 时判「未包装」零动作（旧包装继续生效），或 enabled=true 时把旧包装
 * 当作 original 再包一层（同一请求两次计数、两级代理判定）。
 */
export function detachResidualFetchWrapper(
	state: FetchWrapperState | null,
	deps: Pick<FetchWrapperDeps, "getFetch" | "setFetch">,
): void {
	if (state !== null) return;
	const current = deps.getFetch();
	const mark = wrapperMarkOf(current);
	if (mark !== null) deps.setFetch(mark.originalFetch);
}

/** 构造失败收口：error 上报 + 恢复原 fetch（全部直连），返回记指纹的锁定态。 */
function lockOnBuildFailure(
	config: NetworkProxyConfig,
	state: FetchWrapperState | null,
	originalFetch: FetchLike,
	fingerprint: string,
	deps: FetchWrapperDeps,
	error: unknown,
): FetchWrapperState {
	deps.onError(
		`网络代理转发器构造失败（协议 ${config.proxy.protocol}），已保持全部直连，不影响 pi 运行；` +
			`可核对代理配置后保存重试，或关闭网络代理开关。构造错误: ${error instanceof Error ? error.message : String(error)}`,
	);
	restoreOriginalIfOwned(state, deps);
	return { originalFetch, fingerprint, wrapper: null };
}

/**
 * IPv4 锁定分发器构造（失败只降级「不锁 v4」，不撤整层包装——代理分流仍应生效）。
 * 独立成函数：构造失败是设计内降级路径（error 上报后返回 null），不与主状态机转移混排。
 */
function buildIpv4Dispatcher(
	config: NetworkProxyConfig,
	deps: FetchWrapperDeps,
): Dispatcher | null {
	if (config.ipv4Only.length === 0) return null;
	try {
		return deps.buildIpv4();
	} catch (error) {
		deps.onError(
			`IPv4 锁定分发器构造失败，ipv4Only 规则降级为普通直连（其余分流不受影响）：${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return null;
	}
}

/**
 * 按新配置推进包装状态机（转移表见模块头）。config 契约 = loadNetworkProxyConfig 产物
 * （normalize 已校验合法——非法配置在读取层回落 defaults+error，构造性到达本函数恒合法）。
 */
export function applyNetworkProxyConfig(
	config: NetworkProxyConfig,
	state: FetchWrapperState | null,
	deps: FetchWrapperDeps,
): FetchWrapperState | null {
	// 包装层的存在条件 = 代理开关开（rules 分流可用）或 ipv4Only 非空（IPv4 锁定直连）。
	// 两者全无才摘除包装——ipv4Only 是直连地址族修正，语义上不依赖代理开关；
	// 依据：2026-10-22 真机事故，用户仅配 ipv4Only（enabled=false）时整层被摘，
	// subagent 的 LLM 请求全部 Connection error（双栈域名的 IPv6 路径抖动）。
	if (!config.enabled && config.ipv4Only.length === 0) {
		restoreOriginalIfOwned(state, deps);
		return null;
	}

	const fingerprint = networkProxyFingerprint(config);
	const currentFetch = deps.getFetch();
	const installed = wrapperStillInstalled(state, currentFetch);
	// 同指纹短路：锁定态不重试构造（首败即停）；包装仍在槽位零动作。
	if (state && state.fingerprint === fingerprint && (state.wrapper === null || installed)) {
		return state;
	}
	const originalFetch = installed && state ? state.originalFetch : currentFetch;

	// 代理分发器只在「确实可能用到代理」时构造：开关关闭或 rules 为空 = 无任何主机走
	// 代理，此时不应因代理配置不可用而锁死整个包装（含 ipv4Only 直连改写）。
	// 依据：一次事故（2026-10-22 真机验证）——仅配 ipv4Only、rules=[] 时仍构造
	// ProxyAgent 并失败，lockOnBuildFailure 把包装整层撤下，ipv4Only 静默失效。
	let proxy: Dispatcher | null = null;
	if (config.enabled && config.rules.length > 0) {
		try {
			proxy = deps.buildProxy(config);
		} catch (error) {
			return lockOnBuildFailure(config, state, originalFetch, fingerprint, deps, error);
		}
	}

	const ipv4 = buildIpv4Dispatcher(config, deps);
	const wrapper = createWrappedFetch(originalFetch, config, proxy, ipv4, deps.proxyFetch);
	deps.setFetch(wrapper);
	return { originalFetch, fingerprint, wrapper };
}
