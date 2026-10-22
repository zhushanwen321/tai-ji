// manage-authorize.test.ts — WorkBuddy authorize/extract 管理动作接线测试：
// 经注册的 wool-workbuddy 命令发 envelope，authorize 全链路 = stubbed 上游 fetch
//（state/token/account 路由）+ 真实本机回调监听 + ctx.ui.notify 投递授权页 URL +
// done 信号驱动令牌交换 → 断言 WoolCredentialAcquireData 契约字段。fixture 令牌
// 全部为测试合成 JWT（凭据值绝不入测试 fixture 红线）。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import piWoolWorkbuddy from "../index.ts";

/** 测试用 JWT（payload sub/exp/domain 固定）。 */
function jwtWith(payload: Record<string, unknown>): string {
	return `h.${btoa(JSON.stringify(payload))}.s`;
}

const ACCESS_1 = jwtWith({ sub: "user-123", exp: 9999999999, domain: "copilot.tencent.com" });

/** 按 URL 分发的 fetch mock：未命中 route 的请求（本机回调端点）走真实 fetch。 */
function routerFetch(routes: Array<{ match: (url: string) => boolean; respond: () => { body: unknown } }>): typeof globalThis.fetch {
	const realFetch = globalThis.fetch.bind(globalThis);
	return (async (url: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
		const href = String(url);
		const route = routes.find((entry) => entry.match(href));
		if (route === undefined) {
			return realFetch(url, init);
		}
		return new Response(JSON.stringify(route.respond().body), { status: 200 });
	}) as typeof globalThis.fetch;
}

type CommandOptions = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };

/** 最小 pi 替身：捕获管理命令 handler 与 appendEntry 回写。 */
function fakePi() {
	const commands = new Map<string, CommandOptions>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const api = {
		on: () => undefined,
		registerProvider: () => undefined,
		registerCommand: (name: string, options: CommandOptions) => {
			commands.set(name, options);
		},
		appendEntry: (type: string, data?: unknown) => {
			entries.push({ type, data });
		},
	};
	return { api: api as unknown as ExtensionAPI, commands, entries };
}

function lastResponse(mock: ReturnType<typeof fakePi>): { ok: boolean; data?: unknown; error?: { code: string; message: string } } {
	const last = mock.entries.filter((entry) => entry.type === "wool-manage-response").at(-1);
	return (last?.data as { response: { ok: boolean; data?: unknown; error?: { code: string; message: string } } }).response;
}

describe("authorize 管理动作接线（wool-workbuddy 命令通道）", () => {
	it("全链路：notify 投递授权页 URL（单行 JSON）→ 回调 done → 令牌交换 → 契约 data 回写 envelope", async () => {
		const mock = fakePi();
		piWoolWorkbuddy(mock.api);
		const command = mock.commands.get("wool-workbuddy");
		expect(command).toBeDefined();

		vi.stubGlobal(
			"fetch",
			routerFetch([
				{
					match: (url) => url.includes("/auth/state"),
					respond: () => ({ body: { code: 0, data: { state: "st-authorize", authUrl: "https://auth.example/login" } } }),
				},
				{
					match: (url) => url.includes("/auth/token?"),
					respond: () => ({ body: { code: 0, data: { accessToken: ACCESS_1, refreshToken: "rt-1", domain: "copilot.tencent.com" } } }),
				},
				{
					match: (url) => url.includes("/login/account"),
					respond: () => ({ body: { code: 0, data: { nickname: "wool-user" } } }),
				},
			]),
		);
		try {
			// ctx.ui.notify 捕获：授权页投递到达后模拟 taiji 浮层发 done 信号（真实 HTTP）。
			let deliverNotice: ((message: string) => void) | undefined;
			const noticePromise = new Promise<string>((resolve) => {
				deliverNotice = resolve;
			});
			const ctx = {
				ui: { notify: (message: string) => deliverNotice?.(message) },
			} as unknown as ExtensionCommandContext;

			const pending = command!.handler('{"v":1,"action":"authorize"}', ctx);
			const notice = JSON.parse(await noticePromise) as {
				type: string;
				family: string;
				authUrl: string;
				callbackUrl: string;
				state: string;
			};
			expect(notice.type).toBe("wool-authorize");
			expect(notice.family).toBe("workbuddy");
			expect(notice.authUrl).toBe("https://auth.example/login");
			expect(notice.state).toBe("st-authorize");
			expect(notice.callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/wool-auth\/callback$/);

			const done = await fetch(`${notice.callbackUrl}?state=${notice.state}&status=done`);
			expect(done.status).toBe(200);
			await pending;

			expect(lastResponse(mock)).toEqual({
				v: 1,
				ok: true,
				data: {
					credentials: { apiKey: ACCESS_1, refreshToken: "rt-1" },
					account: { displayName: "wool-user" },
					expiresAt: 9999999999_000,
				},
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("action=extract（OAuth 家族不走提取）→ invalid_request 明确报不支持", async () => {
		const mock = fakePi();
		piWoolWorkbuddy(mock.api);
		const command = mock.commands.get("wool-workbuddy");
		await command!.handler('{"v":1,"action":"extract"}', {} as ExtensionCommandContext);
		const response = lastResponse(mock);
		expect(response.ok).toBe(false);
		if (!response.ok) {
			expect(response.error.code).toBe("invalid_request");
			expect(response.error.message).toContain("authorize");
		}
	});
});
