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
 * 代理分发器发出；未命中的请求原样调用包装前的 fetch，保留 pi 原生 EnvHttpProxyAgent /
 * 连接调优 / 错误处理语义。
 *
 * 生命周期与旧安装状态机同构：
 * - 加载 / 每 turn 开始：重读配置推进状态（禁用 = 摘除包装恢复原 fetch）；
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
type FetchInit = Parameters<FetchLike>[1];

/**
 * 经代理发出时的 init：保留调用方全部选项，附上本次请求的代理分发器。
 * Omit 掉 Node 全局 RequestInit 自带的 dispatcher（undici-types 类型身份），避免与 npm
 * undici 的 Dispatcher 形成 `Dispatcher & Dispatcher` 冲突；运行时由本字段整体覆盖。
 */
export type ProxyFetchInit = Omit<NonNullable<FetchInit>, "dispatcher"> & { dispatcher: Dispatcher };

/** 代理 fetch 注入接缝：生产环境 = undici.fetch；单测用 fake 避免真实网络。 */
export type ProxyFetch = (input: FetchInput, init: ProxyFetchInit) => Promise<Response>;

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
 * 构造包装函数：每次调用现算 host → 计数 → 命中规则走代理 fetch，未命中委托原 fetch。
 * 计数时点 = 请求发起时（与旧分流器一致；不等待完成，成败由 pi 原生错误链路呈现）。
 */
function createWrappedFetch(
	originalFetch: FetchLike,
	config: NetworkProxyConfig,
	proxy: Dispatcher,
	proxyFetch: ProxyFetch,
): FetchLike {
	const wrapped: FetchLike = async (input, init) => {
		const host = hostnameOfInput(input);
		if (host === "") return originalFetch(input, init);
		const proxied = !hitsNoProxy(host, config.noProxy) && hitsRules(host, config.rules);
		recordDispatch(host, proxied);
		if (!proxied) return originalFetch(input, init);
		const rest: Omit<NonNullable<FetchInit>, "dispatcher"> = { ...(init ?? {}) };
		return proxyFetch(input, { ...rest, dispatcher: proxy });
	};
	markWrapper(wrapped, originalFetch);
	return wrapped;
}

/** 禁用态收口：仅当槽位仍归本扩展时恢复原 fetch（槽位被外部覆盖时不改写别人的实现）。 */
function restoreOriginalIfOwned(
	state: FetchWrapperState | null,
	deps: Pick<FetchWrapperDeps, "getFetch" | "setFetch">,
): void {
	if (state?.wrapper !== null && state?.wrapper !== undefined && deps.getFetch() === state.wrapper) {
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
	if (state?.wrapper !== null && state?.wrapper !== undefined && deps.getFetch() === state.wrapper) {
		deps.setFetch(state.originalFetch);
	}
	return { originalFetch, fingerprint, wrapper: null };
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
	if (!config.enabled) {
		restoreOriginalIfOwned(state, deps);
		return null;
	}

	const fingerprint = networkProxyFingerprint(config);
	if (state && state.fingerprint === fingerprint && state.wrapper === null) {
		return state; // 锁定态：同指纹不重试构造（首败即停）
	}
	const currentFetch = deps.getFetch();
	const owned =
		state?.wrapper !== null &&
		state?.wrapper !== undefined &&
		currentFetch === state.wrapper;
	if (state && state.fingerprint === fingerprint && owned) {
		return state; // 同指纹且包装仍在槽位：零动作
	}
	const originalFetch = owned && state ? state.originalFetch : currentFetch;

	let proxy: Dispatcher;
	try {
		proxy = deps.buildProxy(config);
	} catch (error) {
		return lockOnBuildFailure(config, state, originalFetch, fingerprint, deps, error);
	}

	const wrapper = createWrappedFetch(originalFetch, config, proxy, deps.proxyFetch);
	deps.setFetch(wrapper);
	return { originalFetch, fingerprint, wrapper };
}
