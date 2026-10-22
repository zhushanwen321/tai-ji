// OAuth 流协议测试：state 起始 / 令牌交换（pending→ok）/ 刷新轮换 / login 编排
//（onAuth 通道 + 回调 done 信号驱动令牌交换——fetch mock 按 URL 分发）。

import { describe, expect, it, vi } from "vitest";

import { workbuddyLogin, workbuddyRefresh, exchangeToken, startAuthState, toWorkbuddyCredentials, toWoolAcquireData, buildWoolAuthorizeNotice, runWorkbuddyAuthorization } from "../oauth.ts";
import { startWoolAuthCallbackServer } from "../callback-server.ts";

/** 按 URL 分发的 fetch mock。未命中 route 的请求委托 stub 前的真实 fetch
 *（测试里回调监听端点的请求必须走真通道）。 */
function routerFetch(routes: Array<{ match: (url: string, init: RequestInit) => boolean; respond: (url: string, init: RequestInit) => { status?: number; body: unknown } }>): {
	impl: typeof globalThis.fetch;
	calls: Array<{ url: string; init: RequestInit }>;
} {
	const realFetch = globalThis.fetch.bind(globalThis);
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const impl = (async (url: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
		const href = String(url);
		const captured = { url: href, init: (init ?? {}) as RequestInit };
		calls.push(captured);
		const route = routes.find((entry) => entry.match(href, captured.init));
		if (route === undefined) {
			return realFetch(url, init);
		}
		const response = route.respond(href, captured.init);
		return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
	}) as typeof globalThis.fetch;
	return { impl, calls };
}

/** 测试用 JWT（payload sub/exp/domain 固定）。 */
function jwtWith(payload: Record<string, unknown>): string {
	return `h.${btoa(JSON.stringify(payload))}.s`;
}

const ACCESS_1 = jwtWith({ sub: "user-123", exp: 9999999999, domain: "copilot.tencent.com" });
const ACCESS_2 = jwtWith({ sub: "user-123", exp: 9999999998, domain: "copilot.tencent.com" });

describe("state 起始与令牌交换", () => {
	it("startAuthState：POST platform=CLI + billing 头族 → {state, authUrl}", async () => {
		const { impl, calls } = routerFetch([
			{
				match: (url) => url.startsWith("https://copilot.tencent.com/v2/plugin/auth/state"),
				respond: () => ({ body: { code: 0, data: { state: "st1", authUrl: "https://auth.example/login" } } }),
			},
		]);
		vi.stubGlobal("fetch", impl);
		try {
			const result = await startAuthState("cn");
			expect(result).toEqual({ state: "st1", authUrl: "https://auth.example/login" });
			expect(calls[0]?.url).toBe("https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI");
			expect(calls[0]?.init.method).toBe("POST");
			expect((calls[0]?.init.headers as Record<string, string>)["User-Agent"]).toBe("WorkBuddy/5.8.3");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("startAuthState 无 state/authUrl → throw", async () => {
		const { impl } = routerFetch([
			{ match: (url) => url.includes("/auth/state"), respond: () => ({ body: { code: 0, data: {} } }) },
		]);
		vi.stubGlobal("fetch", impl);
		try {
			await expect(startAuthState("cn")).rejects.toThrow("no state/authUrl");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("exchangeToken：code 11217 → pending；code 0 → 凭据四元组", async () => {
		let call = 0;
		const { impl } = routerFetch([
			{
				match: (url) => url.includes("/auth/token?"),
				respond: () => {
					call += 1;
					return call === 1
						? { body: { code: 11217, msg: "pending" } }
						: { body: { code: 0, data: { accessToken: ACCESS_1, refreshToken: "rt-1", domain: "copilot.tencent.com" } } };
				},
			},
		]);
		vi.stubGlobal("fetch", impl);
		try {
			const pending = await exchangeToken("cn", "st1");
			expect(pending.status).toBe("pending");
			const ok = await exchangeToken("cn", "st1");
			expect(ok.status).toBe("ok");
			expect(ok.credentials?.accessToken).toBe(ACCESS_1);
			expect(ok.credentials?.refreshToken).toBe("rt-1");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("toWorkbuddyCredentials：uid/exp/realm 从 JWT 解", () => {
		const credentials = toWorkbuddyCredentials("cn", { accessToken: ACCESS_1, refreshToken: "rt" }, "昵称");
		expect(credentials.uid).toBe("user-123");
		expect(credentials.expires).toBe(9999999999_000);
		expect(credentials.realm).toBe("cn");
		expect(credentials.nickname).toBe("昵称");
		expect(credentials.access).toBe(ACCESS_1);
		expect(credentials.refresh).toBe("rt");
	});
});

describe("refreshToken 钩子", () => {
	it("刷新轮换：新 access/refresh + expires 从新 JWT 解", async () => {
		const { impl, calls } = routerFetch([
			{
				match: (url) => url.endsWith("/v2/plugin/auth/token/refresh"),
				respond: () => ({ body: { code: 0, data: { accessToken: ACCESS_2, refreshToken: "rt-2" } } }),
			},
		]);
		vi.stubGlobal("fetch", impl);
		try {
			const refreshed = await workbuddyRefresh(
				{ type: "oauth", access: ACCESS_1, refresh: "rt-1", expires: 1, uid: "user-123", realm: "cn" },
				new AbortController().signal,
			);
			expect(refreshed.access).toBe(ACCESS_2);
			expect(refreshed.refresh).toBe("rt-2");
			expect(refreshed.expires).toBe(9999999998_000);
			const headers = calls[0]?.init.headers as Record<string, string>;
			expect(headers["X-Refresh-Token"]).toBe("rt-1");
			expect(headers["X-Auth-Refresh-Source"]).toBe("workbuddy");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("data 双层嵌套形态（hub 实测 {data:{data:...}}）兼容", async () => {
		const { impl } = routerFetch([
			{
				match: (url) => url.endsWith("/token/refresh"),
				respond: () => ({ body: { code: 0, data: { data: { accessToken: ACCESS_2, refreshToken: "rt-2" } } } }),
			},
		]);
		vi.stubGlobal("fetch", impl);
		try {
			const refreshed = await workbuddyRefresh(
				{ type: "oauth", access: ACCESS_1, refresh: "rt-1", expires: 1, uid: "user-123", realm: "cn" },
				new AbortController().signal,
			);
			expect(refreshed.access).toBe(ACCESS_2);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("login 编排（onAuth 通道 + done 信号驱动令牌交换）", () => {
	it("完整链路：state → 回调监听 → onAuth(url + instructions{callbackUrl,state}) → done → 令牌交换 → credentials", async () => {
		const { impl, calls } = routerFetch([
			{
				match: (url) => url.includes("/auth/state"),
				respond: () => ({ body: { code: 0, data: { state: "st-login", authUrl: "https://auth.example/login" } } }),
			},
			{
				match: (url) => url.includes("/auth/token?"),
				respond: () => ({ body: { code: 0, data: { accessToken: ACCESS_1, refreshToken: "rt-1", domain: "copilot.tencent.com" } } }),
			},
			{
				match: (url) => url.includes("/login/account"),
				respond: () => ({ body: { code: 0, data: { nickname: "wool-user" } } }),
			},
		]);
		vi.stubGlobal("fetch", impl);
		let authInfo: { url: string; instructions?: string } | undefined;
		try {
			const credentialsPromise = workbuddyLogin({
				onAuth: (info) => {
					authInfo = { url: info.url, instructions: info.instructions };
					// 浮层完成后向回调端点发 done 信号（真实 HTTP）
					void (async () => {
						const callback = JSON.parse(info.instructions ?? "{}") as { callbackUrl?: string; state?: string };
						if (typeof callback.callbackUrl === "string" && typeof callback.state === "string") {
							await fetch(`${callback.callbackUrl}?state=${callback.state}&status=done`);
						}
					})();
				},
			});
			const credentials = await credentialsPromise;
			expect(authInfo?.url).toBe("https://auth.example/login");
			const callback = JSON.parse(authInfo?.instructions ?? "{}") as { callbackUrl: string; state: string };
			expect(callback.state).toBe("st-login");
			expect(callback.callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/wool-auth\/callback$/);
			expect(credentials.access).toBe(ACCESS_1);
			expect((credentials as { nickname?: string }).nickname).toBe("wool-user");
			// 昵称拉取带 Bearer（login/account 端点头检查）
			const accountCall = calls.find((call) => call.url.includes("/login/account"));
			expect((accountCall?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_1}`);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("浮层取消信号 → login 以 AbortError 终止", async () => {
		const { impl } = routerFetch([
			{
				match: (url) => url.includes("/auth/state"),
				respond: () => ({ body: { code: 0, data: { state: "st-cancel", authUrl: "https://auth.example/login" } } }),
			},
		]);
		vi.stubGlobal("fetch", impl);
		try {
			const promise = workbuddyLogin({
				onAuth: (info) => {
					void (async () => {
						const callback = JSON.parse(info.instructions ?? "{}") as { callbackUrl?: string };
						if (typeof callback.callbackUrl === "string") {
							await fetch(`${callback.callbackUrl}?state=st-cancel&status=cancel`);
						}
					})();
				},
			});
			await expect(promise).rejects.toThrow("cancelled");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("authorize 管理动作面（凭据获取契约 + 宿主通知）", () => {
	it("toWoolAcquireData：apiKey=access / refreshToken 轮换令牌 / 昵称与 expires 随行", () => {
		const credentials = toWorkbuddyCredentials("cn", { accessToken: ACCESS_1, refreshToken: "rt-1" }, "wool-user");
		expect(toWoolAcquireData(credentials)).toEqual({
			credentials: { apiKey: ACCESS_1, refreshToken: "rt-1" },
			account: { displayName: "wool-user" },
			expiresAt: 9999999999_000,
		});
	});

	it("toWoolAcquireData：昵称缺席省略 account；空 refreshToken 省略", () => {
		const credentials = toWorkbuddyCredentials("cn", { accessToken: ACCESS_1, refreshToken: "" }, undefined);
		expect(toWoolAcquireData(credentials)).toEqual({
			credentials: { apiKey: ACCESS_1 },
			expiresAt: 9999999999_000,
		});
	});

	it("buildWoolAuthorizeNotice：单行 JSON（type/family 标记 + authUrl/callbackUrl/state）", () => {
		const notice = JSON.parse(
			buildWoolAuthorizeNotice({ authUrl: "https://auth.example/login", callbackUrl: "http://127.0.0.1:9/wool-auth/callback", state: "st1" }),
		);
		expect(notice).toEqual({
			type: "wool-authorize",
			family: "workbuddy",
			authUrl: "https://auth.example/login",
			callbackUrl: "http://127.0.0.1:9/wool-auth/callback",
			state: "st1",
		});
	});

	it("runWorkbuddyAuthorization：deliverAuthInfo 收结构化三元组（authorize 通道同骨架）", async () => {
		const { impl } = routerFetch([
			{
				match: (url) => url.includes("/auth/state"),
				respond: () => ({ body: { code: 0, data: { state: "st-notify", authUrl: "https://auth.example/login" } } }),
			},
			{
				match: (url) => url.includes("/auth/token?"),
				respond: () => ({ body: { code: 0, data: { accessToken: ACCESS_1, refreshToken: "rt-1", domain: "copilot.tencent.com" } } }),
			},
			{
				match: (url) => url.includes("/login/account"),
				respond: () => ({ body: { code: 0, data: { nickname: "wool-user" } } }),
			},
		]);
		vi.stubGlobal("fetch", impl);
		try {
			const credentialsPromise = runWorkbuddyAuthorization({
				deliverAuthInfo: (info) => {
					// 浮层（或 pi onAuth）完成后向回调端点发 done 信号（真实 HTTP）。
					expect(info.authUrl).toBe("https://auth.example/login");
					expect(info.state).toBe("st-notify");
					expect(info.callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/wool-auth\/callback$/);
					void fetch(`${info.callbackUrl}?state=${info.state}&status=done`);
				},
			});
			const credentials = await credentialsPromise;
			expect(credentials.access).toBe(ACCESS_1);
			expect(credentials.nickname).toBe("wool-user");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("回调监听与 login 的集成形态（生命周期边界）", () => {
	it("login 取消后回调监听回收（端口释放）", async () => {
		const controller = new AbortController();
		const server = await startWoolAuthCallbackServer({
			state: "s",
			signal: controller.signal,
			onDone: async () => ({ completed: true, pageMessage: "done" }),
		});
		const port = Number(new URL(server.callbackUrl).port);
		controller.abort();
		await server.wait();
		// 端口可重绑 = 监听已回收
		const probe = await import("node:net").then(({ createServer }) => createServer());
		await new Promise<void>((resolve, reject) => {
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", () => {
				probe.off("error", reject);
				resolve();
			});
		});
		await new Promise<void>((resolve) => probe.close(() => resolve()));
	});
});
