/**
 * socks5 能力守卫单测：socks5Supported 判定「当前 undici 副本缺 Socks5ProxyAgent」
 * （打包版 pi 的 Bun 内置副本形态，2026-10-22 真机指纹实测 49 导出无 socks）。
 * buildProxyDispatcher 的 socks5 分支接入该判定（缺即抛可恢复错误，走
 * lockOnBuildFailure：error 上报 + 恢复全直连）；「副本有 Socks5 时构造成功」的接入
 * 正路径由 dispatcher-construction.test.ts 的 socks5 构造形态用例覆盖。
 *
 * 不用 vi.mock 造「缺导出的模块」——vitest 的 mock 层对访问 mock 未提供的原模块
 * 导出抛自己的拦截错误（要求 mock 与原模块导出面对齐），与真实 ESM namespace
 * 「缺失导出属性访问 = undefined」语义不一致。
 */
import { describe, expect, it } from "vitest";
import * as undici from "undici";

import { socks5Supported } from "../dispatcher.ts";

describe("socks5Supported（副本能力判定）", () => {
	it("缺 Socks5ProxyAgent 的副本（打包版 Bun 内置副本形态）→ false", () => {
		expect(socks5Supported({})).toBe(false);
		expect(socks5Supported({ Socks5ProxyAgent: undefined })).toBe(false);
		expect(socks5Supported({ Socks5ProxyAgent: "not-a-class" })).toBe(false);
	});

	it("提供函数形态 Socks5ProxyAgent 的副本（npm undici 形态）→ true", () => {
		expect(socks5Supported({ Socks5ProxyAgent: class {} })).toBe(true);
	});

	it("真实 npm undici 副本（Node 测试环境解析）→ true", () => {
		expect(socks5Supported(undici)).toBe(true);
	});
});
