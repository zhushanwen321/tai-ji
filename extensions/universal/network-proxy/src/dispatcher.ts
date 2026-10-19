/**
 * 代理分发器构造（供 fetch-wrapper 在规则命中时按请求注入）。
 *
 * 拦截点已从 undici 全局分发器改为 `globalThis.fetch` 包装（见 fetch-wrapper.ts 头注：
 * 打包版 pi 内置 undici 与扩展 bundle 内联的 undici 是两套副本，全局槽互不相通）。本模块
 * 只负责按协议构造代理分发器，规则判定 / 计数 / 直连委托都在 fetch-wrapper 完成。
 *
 * 两协议构造契约（undici 7.28.0 源码读码核实，单测冒烟防回归）：
 * - http/https 走 ProxyAgent，调优经 `proxyTls: { autoSelectFamilyAttemptTimeout: 2000 }`
 *   （构造内部 buildConnector({...opts.proxyTls}) 透传到「到代理」连接）；禁传 connect 选项
 *   ——ProxyAgent 不消费该字段，传入被静默忽略、调优失效且不报错。
 * - socks5 走 Socks5ProxyAgent（实验性 API），调优经 `connect: buildConnector({...})` 的
 *   connector 函数形态——该构造选项只收函数，对象形态首个请求建隧道时 TypeError；
 *   `proxyTls` 是「代理连接走 TLS」开关（truthy 即按 TLS 连代理），不可当调优参数袋。
 * - 高延迟路由语义：到代理服务器的连接不回落 autoSelectFamilyAttemptTimeout 默认 250ms，
 *   对齐 pi 原生调优同值 2000（pi dist/core/http-dispatcher.js:5
 *   DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000；其 :4 注释即 250ms 默认会
 *   终止高延迟路由有效连接尝试的动机）。
 */

import { EventEmitter } from "node:events";

import { buildConnector, ProxyAgent, Socks5ProxyAgent } from "undici";
import type { Dispatcher as IDispatcher } from "undici";

import type { NetworkProxyConfig, NetworkProxyServer } from "./config.js";

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
