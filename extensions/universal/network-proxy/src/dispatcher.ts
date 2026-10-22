/**
 * 分发器构造（供 fetch-wrapper 按请求注入）。
 *
 * ## undici 副本策略：按宿主运行时解析，不内联
 *
 * 本包的 undici 依赖在构建期标 external（`scripts/bundle-extensions.mjs` 的 EXTERNAL
 * 含 undici），运行时由宿主解析：Node 宿主（独立 pi / dev）解析 `node_modules` 的
 * npm undici；Bun 宿主（打包版 pi）解析二进制内置副本（`builtin://thirdparty/undici`，
 * Bun 团队随 Bun 版本适配测试）。每个宿主用自己官方维护的网络栈。
 * [HISTORICAL] 内联 npm undici 7.28.0 副本的旧形态在打包版（Bun 1.3.x 兼容层）下
 * `fetch` 读 chunked 流式响应体永不产块（LLM SSE 请求挂死 20 分钟，2026-10-22 事故，
 * 本地 https 分块流探针复现），不得回退内联。
 *
 * 两副本能力面差异（真机指纹实测，2026-10-22）：内置副本 49 导出，无
 * `Socks5ProxyAgent`——socks5 代理在打包版无承载，下方构造时按能力探测显式报错
 * （走 lockOnBuildFailure：error 上报 + 恢复全直连，同指纹锁定不重试）。
 * `Agent` / `buildConnector` / `ProxyAgent` / `fetch` 两副本都有且流式行为均实测正常。
 *
 * ## 两协议构造契约（undici 7.28.0 源码读码核实，单测冒烟防回归）
 *
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

// namespace 导入而非命名导入：打包版 Bun 内置副本缺 Socks5ProxyAgent 命名导出，
// 命名导入会在模块链接期整体失败；namespace 属性访问缺失导出为 undefined，
// 供下方运行时能力探测。
import * as undici from "undici";
import type { buildConnector, Dispatcher as IDispatcher } from "undici";

import type { NetworkProxyConfig, NetworkProxyServer } from "./config.js";
import { createIpv4Lookup } from "./ipv4.js";

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

/**
 * socks5 副本能力判定：当前解析到的 undici 副本是否提供 Socks5ProxyAgent。
 * 打包版 Bun 内置副本无此导出（2026-10-22 真机指纹实测）。`in` 探测短路 + typeof
 * 双保险——namespace 属性访问缺失导出按 ESM 语义是 undefined，但 `in` 的行为已在
 * 打包版真机验证（false，不抛）。
 */
export function socks5Supported(mod: object): boolean {
	if (!("Socks5ProxyAgent" in mod)) return false;
	// in 已保证成员存在，断言到必填字段形态取值
	const ctor = (mod as { Socks5ProxyAgent: unknown }).Socks5ProxyAgent;
	return typeof ctor === "function";
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
		// 能力探测（非宿主名判断）：当前解析到的 undici 副本无 Socks5ProxyAgent 即不可用
		// （打包版 Bun 内置副本）。抛错由 lockOnBuildFailure 收口：error 上报 + 恢复全直连。
		if (!socks5Supported(undici)) {
			throw new Error(
				"当前 undici 副本（打包版 Bun 内置）不提供 Socks5ProxyAgent，socks5 代理不可用；" +
					"请将代理协议改为 http/https 后重试",
			);
		}
		return withUndiciErrorListener(
			new undici.Socks5ProxyAgent(uri, {
				connect: undici.buildConnector(PROXY_TLS_TUNING),
			}),
		);
	}
	return withUndiciErrorListener(
		new undici.ProxyAgent({
			uri,
			proxyTls: PROXY_TLS_TUNING,
		}),
	);
}

/**
 * IPv4 锁定分发器（`ipv4Only` 规则的执行体装配）：唯一干预 = `connect.lookup` 把 DNS
 * 解析强制到 A 记录（选型依据见 ipv4.ts 头注——改 URL 会因 SNI/Host 不一致被 Cloudflare
 * 拒为 403，只有改 DNS 族在 Node 与 Bun 下都正确，两副本 Agent+lookup 已实测流式正常）。
 * URL / Host 头 / TLS 全部保持原样。
 *
 * 刻意不设 `connect.timeout`：保持 undici 默认语义（pi 原生 dispatcher 亦未设）——锁 v4
 * 后 happy-eyeballs 没有坏路径可耗预算，不需要也不应该改连接预算（调大 timeout 只是把
 * 失败推迟，2026-10-22 用户裁决）。
 */
export function buildIpv4Dispatcher(): IDispatcher {
	return withUndiciErrorListener(
		new undici.Agent({ connect: { lookup: createIpv4Lookup() } }),
	);
}
