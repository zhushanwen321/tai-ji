/**
 * 直连 + 强制 IPv4 执行层（`ipv4Only` 规则的执行体）。
 *
 * 存在理由（实测定因，非推测）：
 * 双栈域名（如 `amr-link.open-design.ai`）在「IPv6 连通但 TLS 握手抖动」时，
 * pi 的 fetch 走 happy-eyeballs——`autoSelectFamilyAttemptTimeout=2000` 会在 2s 后
 * 换下一个地址，而整个 socket 的 connect 预算由 undici dispatcher 决定（未显式配置时
 * 为 undici 默认 10s，实测复现 10.5s 报 `Request timed out.`）。结果是连接层把预算
 * 耗在坏路径上，最终报错文案看起来像 provider 故障。
 *
 * ## 实现选型：改 DNS 解析，不改 URL
 *
 * 早期实现（参考已废弃的外挂扩展）是「把 URL 主机名替换成 IPv4 字面量 + 保留 Host 头 +
 * 显式 TLS serverName」。**实测证伪**（2026-10-22，同一 provider / 同一 IP）：
 *
 * | 方式 | curl/node-undici 结果 |
 * |---|---|
 * | 域名 URL + `--resolve` 到 IPv4（SNI = 域名） | 200 |
 * | IP URL + `Host: 域名` 头（SNI = IP） | TLS 握手失败 / 经 `connect.servername` 补 SNI 后 403 |
 * | 域名 URL + `connect.lookup` 强制 family:4 | 200 |
 *
 * 根因：Cloudflare 侧按 **SNI + Host 一致**路由；IP 字面量形态即便补了 SNI 也进不了
 * 正确的 host 路由（403）。而「URL 保持域名 + 只改 DNS family」让 SNI / Host / 证书
 * 校验 / 路由全部自然正确——我们唯一要干预的就是「选哪个 IP」。
 *
 * 因此本层的产出 = 一个 `lookup` 实现（Node `net.connect` / `tls.connect` 的 `lookup`
 * 选项签名，见 dispatcher.ts 的接线），直接委托系统 `dns.lookup` 并覆写 `family: 4`——
 * /etc/hosts、resolver 配置、OS 级 DNS 缓存等语义全部保留，连接池化后每个 origin 的
 * 解析频次本就低，不另建应用层缓存。
 *
 * ## 边界（刻意不做的事）
 *
 * - 不缓存 Response、不重试、不改超时——只做地址族选择；
 * - 不回退 IPv6：`family: 4` 下系统解析器无 A 记录即报错（ENOTFOUND / ENODATA），
 *   错误沿连接层上抛——命中 ipv4Only 却解不到 A 记录是显式失败，「我要求锁 v4」的
 *   意图静默失效比失败更难归因；
 * - 纯 IPv6 服务命中 ipv4Only 会连接失败——这是配置错误的显式暴露，不是本层的兜底责任。
 */

import dns from "node:dns";
import type { LookupFunction } from "node:net";

/** 地址族标识：IPv4（Node dns/net 的 family 数字语义）。 */
const IPV4_FAMILY = 4;

/**
 * 构造 `connect.lookup` 实现：把任意 host 的解析强制到 IPv4（family: 4）。
 *
 * 两种回调形态都要支持（Node net / tls 的不同调用路径）：
 * - `all: true` → `(err, [{address, family}])`
 * - `all: false`（缺省）→ `(err, address, family)`
 *
 * 调用方传入的 `family`（含 6）一律覆写为 4——本函数的语义是「锁 v4」，不是「偏好 v4」。
 */
export function createIpv4Lookup(): LookupFunction {
	return (hostname, options, callback) => {
		const wantsAll = options?.all === true;
		dns.lookup(
			hostname,
			{ ...options, family: IPV4_FAMILY, all: wantsAll },
			(err, address, family) => {
				if (err) {
					callback(err, "", IPV4_FAMILY);
					return;
				}
				if (wantsAll) {
					callback(
						null,
						Array.isArray(address) ? address : [{ address, family: IPV4_FAMILY }],
					);
					return;
				}
				callback(null, address, family);
			},
		);
	};
}
