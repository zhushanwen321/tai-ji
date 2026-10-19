/**
 * 代理 URL 构造（凭据 percent-encode 拼入）。
 * 分流行为与计数已随拦截点迁移到 fetch-wrapper.test.ts；两协议构造形态冒烟在
 * dispatcher-construction.test.ts（vi.mock undici 隔离）。
 */
import { describe, expect, it } from "vitest";

import { buildProxyUrl } from "../dispatcher.ts";
import type { NetworkProxyServer } from "../config.ts";

describe("buildProxyUrl（凭据 percent-encode 拼入）", () => {
	const base: NetworkProxyServer = {
		protocol: "http",
		host: "127.0.0.1",
		port: 7890,
		username: "",
		password: "",
	};

	it("无凭据形态", () => {
		expect(buildProxyUrl(base)).toBe("http://127.0.0.1:7890");
	});

	it("凭据 percent-encode 拼入（特殊字符被编码，undici 构造内部 decodeURIComponent 还原）", () => {
		expect(buildProxyUrl({ ...base, username: "user@example.com", password: "p@ss:word" })).toBe(
			"http://user%40example.com:p%40ss%3Aword@127.0.0.1:7890",
		);
	});

	it("socks5 协议形态（Socks5ProxyAgent 校验 socks5: 协议头）", () => {
		expect(buildProxyUrl({ ...base, protocol: "socks5", port: 1080 })).toBe("socks5://127.0.0.1:1080");
	});

	it("https 协议形态", () => {
		expect(buildProxyUrl({ ...base, protocol: "https", port: 443 })).toBe("https://127.0.0.1:443");
	});
});
