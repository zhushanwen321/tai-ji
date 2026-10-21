/**
 * ipv4Only 真机行为（真实 DNS + 真实网络 + 真实 dispatcher，标记为集成用例）。
 *
 * 默认跳过（需要外网 + 真实域名）；显式开：
 *   NETWORK_PROXY_LIVE_IPV4=1 npx vitest run src/__tests__/ipv4-live.test.ts
 *
 * 验证点（connect.lookup 方案，与旧「URL 改写」方案的区别见 ipv4.ts 头注选型表）：
 * - 请求成功（200/401）：TLS SNI / Host / 证书校验全按原域名，未被 IP 形态破坏；
 * - 输入 URL 原样未被改写（域名保持原域名，只干预「选哪个 IP」）；
 * - 请求确实经本扩展构造的 IPv4 锁定分发器发出；
 * - net.connect 层实测：用该 lookup 建连，remoteAddress 是 IPv4 点分形态（锁 v4 生效）。
 */

import dns from "node:dns";
import net from "node:net";
import { fetch as undiciFetch } from "undici";

import { describe, expect, it } from "vitest";

import type { NetworkProxyConfig } from "../config.js";
import { buildIpv4Dispatcher } from "../dispatcher.js";
import {
	applyNetworkProxyConfig,
	type FetchLike,
	type FetchWrapperDeps,
	type ProxyFetchInit,
} from "../fetch-wrapper.js";
import { createIpv4Lookup } from "../ipv4.js";

const LIVE = process.env.NETWORK_PROXY_LIVE_IPV4 === "1";
const HOST = "amr-link.open-design.ai";

function config(overrides: Partial<NetworkProxyConfig> = {}): NetworkProxyConfig {
	return {
		enabled: true,
		proxy: { protocol: "http", host: "127.0.0.1", port: 7890, username: "", password: "" },
		noProxy: ["localhost"],
		rules: [],
		ipv4Only: [HOST],
		...overrides,
	};
}

describe.skipIf(!LIVE)("ipv4Only 真机行为", () => {
	it("锁 v4 后请求成功且 URL 未被改写（经本扩展 ipv4 分发器发出）", async () => {
		// 前提：该域名确有 A 记录（锁 v4 才有地址可用，纯 IPv6 域名是配置错误）
		const aRecords = await new Promise<dns.LookupAddress[]>((resolve, reject) =>
			dns.lookup(HOST, { family: 4, all: true }, (e, a) => (e ? reject(e) : resolve(a))),
		);
		expect(aRecords.length).toBeGreaterThan(0);

		const ipv4Dispatcher = buildIpv4Dispatcher();
		let currentFetch: FetchLike = async () => new Response("unset");
		const captured: { input?: string | URL | Request; dispatcher?: unknown } = {};
		const deps: FetchWrapperDeps = {
			getFetch: () => currentFetch,
			setFetch: (f) => {
				currentFetch = f;
			},
			buildProxy: () => {
				throw new Error("rules 为空不应构造代理分发器");
			},
			buildIpv4: () => ipv4Dispatcher,
			proxyFetch: (input, init: ProxyFetchInit) => {
				captured.input = input;
				captured.dispatcher = init.dispatcher;
				return undiciFetch(input as never, init as never);
			},
			onError: () => {},
		};

		applyNetworkProxyConfig(config(), null, deps);

		const res = await currentFetch(`https://${HOST}/v1/models`);
		// 无 bearer token → 401 是预期（证明 TLS + Host 正确到达服务端，而非连接/证书失败）
		expect([200, 401]).toContain(res.status);
		await res.body?.cancel();

		expect(captured.input).toBe(`https://${HOST}/v1/models`); // URL 不改写
		expect(captured.dispatcher).toBe(ipv4Dispatcher); // 经本扩展的 ipv4 分发器
	}, 30_000);

	it("createIpv4Lookup 在 net.connect 层锁住地址族（remoteAddress 为 IPv4 点分形态）", async () => {
		const socket = await new Promise<net.Socket>((resolve, reject) => {
			const s = net.connect({ host: HOST, port: 443, lookup: createIpv4Lookup() }, () => resolve(s));
			s.once("error", reject);
		});
		// 点分十进制 = IPv4；IPv6 会是冒号十六进制（含或不含 ::ffff: 前缀）
		expect(socket.remoteAddress ?? "").toMatch(/^\d+\.\d+\.\d+\.\d+$/);
		socket.destroy();
	}, 15_000);
});
