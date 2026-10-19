/**
 * 按主机名规则分流的 undici 全局分发器。
 *
 * 形态依据（设计 .tmp/tech-design/llm-network-proxy.md §3.1 行为序列 3 + §3.3 决策 1/7/8）：
 * - 拦截点 = 公开 `dispatch(opts, handler)`：参照 pi 自装 EnvHttpProxyAgent（pi 内部继承
 *   undici 非公开 DispatcherBase override [kDispatch] symbol 方法）；undici 7.28 未公开
 *   导出 DispatcherBase（运行时 require 返回 undefined、类型层无声明，✅ 本会话读码核实
 *   undici types/index.d.ts 导出清单与 lib/dispatcher/dispatcher-base.js），照抄内部形态
 *   需 any/深路径 import，故继承公开导出的 `Dispatcher` override 公开 dispatch（close/
 *   destroy 不 override，见类尾注释）。
 * - 两协议构造契约（✅ undici 7.28.0 源码读码核实，单测冒烟防回归）：
 *   http/https 走 ProxyAgent，调优经 `proxyTls: { autoSelectFamilyAttemptTimeout: 2000 }`
 *   （构造内部 buildConnector({...opts.proxyTls}) 透传到「到代理」连接）；禁传 connect 选项
 *   ——ProxyAgent 不消费该字段，传入被静默忽略、调优失效且不报错。
 *   socks5 走 Socks5ProxyAgent（实验性 API），调优经 `connect: buildConnector({...})` 的
 *   connector 函数形态——该构造选项只收函数，对象形态首个请求建隧道时 TypeError；
 *   `proxyTls` 是「代理连接走 TLS」开关（truthy 即按 TLS 连代理），不可当调优参数袋。
 * - 高延迟路由语义：到代理服务器的连接不回落 autoSelectFamilyAttemptTimeout 默认 250ms，
 *   对齐 pi 原生调优同值 2000（pi dist/core/http-dispatcher.js:5
 *   DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000；其 :4 注释即 250ms 默认会
 *   终止高延迟路由有效连接尝试的动机）。
 * - 计数时点 = 请求发起时（不等待完成——统计观测「按规则尝试的出站方式」，成败由 pi 原生
 *   错误链路呈现）。
 */

import { EventEmitter } from "node:events";

import {
	buildConnector,
	Dispatcher,
	ProxyAgent,
	Socks5ProxyAgent,
} from "undici";
import type { Dispatcher as IDispatcher } from "undici";

import { hitsNoProxy, hitsRules, type NetworkProxyConfig, type NetworkProxyServer } from "./config.js";
import { normalizeHostname } from "./match.js";

/** 到代理服务器连接的 autoSelectFamilyAttemptTimeout（对齐 pi 原生调优同值）。 */
export const PROXY_CONNECT_ATTEMPT_TIMEOUT_MS = 2000;

/**
 * 调优选项（BuildOptions 类型走 TcpNetConnectOpts 分支，port 必填 → 0 占位）：
 * 构造 connector 时的 options.port 是默认值，实际建连时被目标端口后置覆盖
 * （undici connect.js 的 `...options` 前置展开 + connector 参数 port 后置，✅ 读码核实），
 * 0 不会落到真实连接参数。
 */
const PROXY_TLS_TUNING: buildConnector.BuildOptions = {
	port: 0,
	autoSelectFamilyAttemptTimeout: PROXY_CONNECT_ATTEMPT_TIMEOUT_MS,
};

/** 代理出站计数回调：host = 归一化目标主机名；proxied = true 经代理 / false 直连。 */
export type DispatchCounter = (host: string, proxied: boolean) => void;

/**
 * 跨模块环境身份标记：jiti 全量 reload 产生的新模块环境与旧环境的类对象互异（instanceof
 * 失效；根因 = reload 后 extensions/loader.js:472-476 新建 jiti 实例（moduleCache: false）
 * 重新 import 本扩展，两环境各持一份类构造函数——pi reload 链总锚点见 installer.ts
 * detachResidualDispatcher 注释），而 Symbol.for 全局注册表是进程级注册表、跨模块环境
 * 共享——以它识别全局槽上本扩展旧环境残留的
 * 分流器实例（残留不摘除则禁用失效 / 重装嵌套双计，见 installer.ts detachResidualDispatcher）。
 */
const RULE_DISPATCH_MARK = Symbol.for("@zhushanwen/pi-network-proxy:rule-dispatch");

/** 类型守卫：目标分发器是否本扩展的 RuleDispatchDispatcher（跨模块环境可辨，见 RULE_DISPATCH_MARK）。 */
export function isRuleDispatchDispatcher(
	dispatcher: IDispatcher,
): dispatcher is RuleDispatchDispatcher {
	return RULE_DISPATCH_MARK in dispatcher;
}

/**
 * 防崩溃 error listener（对齐 pi withUndiciErrorListener 形态）：undici 内部 Client 在
 * 中途终止 fetch body 时可能 emit "error"——EventEmitter 的 unhandled "error" 特例会炸掉
 * pi 进程，listener 只吞事件不掩盖请求本身的错误（body 流照常经 reader.read() reject）。
 */
function withUndiciErrorListener<T extends IDispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", () => {});
	}
	return dispatcher;
}

/** 代理服务器 URL：凭据非空时 percent-encode 拼入（undici 构造内部 decodeURIComponent 还原）。 */
export function buildProxyUrl(proxy: NetworkProxyServer): string {
	const auth =
		proxy.username !== ""
			? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
			: "";
	return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
}

/** 按协议构造代理分发器（协议词表校验在配置层已完成；未知协议不可达）。 */
export function buildProxyDispatcher(config: NetworkProxyConfig): IDispatcher {
	const uri = buildProxyUrl(config.proxy);
	if (config.proxy.protocol === "socks5") {
		return withUndiciErrorListener(
			new Socks5ProxyAgent(uri, {
				connect: buildConnector(PROXY_TLS_TUNING),
			}),
		);
	}
	return withUndiciErrorListener(
		new ProxyAgent({
			uri,
			proxyTls: PROXY_TLS_TUNING,
		}),
	);
}

/** 从 dispatch opts.origin 取归一化主机名；origin 缺失/非法（无已发生证据的异常路径）返回空串。 */
function hostnameOf(origin: string | URL | undefined): string {
	if (origin === undefined) return "";
	try {
		const url = origin instanceof URL ? origin : new URL(origin);
		return normalizeHostname(url.hostname);
	} catch {
		return "";
	}
}

export interface RuleDispatchDeps { // oe-exempt:20261019:framework:分流器依赖注入接缝（单测以 fake 分发器驱动，不 mock undici 全局槽）

	/** 安装前捕获的原分发器：noProxy 命中与规则未命中流量委托——保留 pi 原生 EnvHttpProxyAgent 的 env 代理路由/连接调优/防崩溃语义（构造性等价：未命中 = 未安装本扩展时 pi 的确切行为）。 */
	fallback: IDispatcher;
	/** 规则命中流量的代理分发器（buildProxyDispatcher 产物）。 */
	proxy: IDispatcher;
	noProxy: string[];
	rules: string[];
	/** 分流计数回调（发起时点，本类不落盘）。 */
	onCount: DispatchCounter;
}

/**
 * 规则分流分发器：dispatch 内 noProxy（排除，优先）→ rules（命中走代理）→ 委托 fallback。
 * 分流覆盖一切经全局分发器的请求（含 WebSocket 升级请求——Node 全局 WebSocket 建连默认取
 * 全局分发器，设计 §3.1 行为序列 3）。
 */
export class RuleDispatchDispatcher extends Dispatcher {
	readonly [RULE_DISPATCH_MARK] = true;
	readonly fallback: IDispatcher;
	readonly proxy: IDispatcher;
	readonly noProxy: string[];
	readonly rules: string[];
	readonly onCount: DispatchCounter;

	constructor(deps: RuleDispatchDeps) {
		super();
		this.fallback = deps.fallback;
		this.proxy = deps.proxy;
		this.noProxy = deps.noProxy;
		this.rules = deps.rules;
		this.onCount = deps.onCount;
	}

	dispatch(opts: IDispatcher.DispatchOptions, handler: IDispatcher.DispatchHandler): boolean {
		const host = hostnameOf(opts.origin);
		const useProxy = !hitsNoProxy(host, this.noProxy) && hitsRules(host, this.rules);
		this.onCount(host, useProxy);
		return useProxy ? this.proxy.dispatch(opts, handler) : this.fallback.dispatch(opts, handler);
	}

	// 不 override close/destroy：①全链路无全局分发器 close/destroy 调用方（✅ 本会话读码
	// 核实——undici fetch 链路、pi http-dispatcher.js（只构造与 setGlobalDispatcher）、本包
	// 代码均不调用）；②undici 父类 close/destroy 是 void 与 Promise<void> 返回互斥的重载集，
	// 单一实现签名无法通过 TS override 兼容检查（实测 TS2322）；父类默认抛 not implemented
	// = 若未来出现调用方则 fail-fast 暴露，不为无已发生证据的调用方保留透传实现。
}
