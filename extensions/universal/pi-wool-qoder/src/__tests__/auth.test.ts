// auth.test.ts — oauth 钩子族 + 凭据状态 + openapi 域客户端的单测（PAT 次级入口 =
// 设计 D3 残留风险的恢复路径；全部 mock fetch / mock 钥匙串，零真实上游）。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { extractToCredentialState, login, makeGetApiKey, patToCredentialState, refreshToken, type LoginInteraction } from "../auth.ts";
import { QoderAuthStore, readCredentialState, toCosyIdentity, toOAuthCredential } from "../credentials.ts";
import { fetchQuotaUsage, fetchUserinfo, openapiHeaders, refreshDeviceToken } from "../openapi.ts";
import { PATH_DEVICE_TOKEN_REFRESH } from "../constants.ts";

interface CryptoFixture { // oe-exempt:20261022:test:auth 测试的 fixture JSON 形状——仅本文件消费（无 src 消费），字段随用例演进
	keychainExtract: { keychainPassword: string; plainUtf8: string; ciphertextHex: string; magic: string };
}

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "wool-qoder-crypto.json"), "utf8")) as CryptoFixture;

/** fixture 密文文件字节。 */
function fixtureBlob(): Uint8Array {
	return new Uint8Array(Buffer.concat([Buffer.from(fixture.keychainExtract.magic, "ascii"), Buffer.from(fixture.keychainExtract.ciphertextHex, "hex")]));
}

/** mock 钥匙串读取（返回 fixture password）。 */
const fixtureKeychain = (): string => fixture.keychainExtract.keychainPassword;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("credentials 状态域", () => {
	it("readCredentialState 收窄：access 缺失拒绝，扩展字段学习", () => {
		expect(readCredentialState(undefined)).toBeUndefined();
		expect(readCredentialState({ refresh: "drt-x" })).toBeUndefined();
		const state = readCredentialState({ access: "dt-x", refresh: "drt-x", expires: 123, uid: "u1", nickname: "昵称", source: "pat" });
		expect(state).toMatchObject({ accessToken: "dt-x", refreshToken: "drt-x", uid: "u1", nickname: "昵称", source: "pat" });
	});

	it("toOAuthCredential / toCosyIdentity 形态（身份体 9 键）", () => {
		const state = readCredentialState({ access: "dt-x", refresh: "drt-x", uid: "u1", nickname: "n", userType: "t", organizationId: "o1", organizationName: "on" });
		expect(toOAuthCredential(state!)).toMatchObject({ type: "oauth", access: "dt-x", refresh: "drt-x", uid: "u1", nickname: "n", source: "ide-extract" });
		expect(toCosyIdentity(state!)).toEqual({
			name: "n",
			aid: "u1",
			uid: "u1",
			yx_uid: "",
			organization_id: "o1",
			organization_name: "on",
			user_type: "t",
			security_oauth_token: "dt-x",
			refresh_token: "drt-x",
		});
	});

	it("QoderAuthStore：learn 恢复 + COSY 会话按 access 轮换重建", () => {
		const store = new QoderAuthStore();
		store.learn({ access: "dt-1", refresh: "drt-1", uid: "u1" });
		const sessionA = store.session();
		expect(sessionA).toBeDefined();
		// 同 access 缓存命中。
		expect(store.session()).toBe(sessionA);
		// access 轮换 → 整体重建（旧 info 内嵌旧 token）。
		store.learn({ access: "dt-2", refresh: "drt-2", uid: "u1" });
		const sessionB = store.session();
		expect(sessionB).not.toBe(sessionA);
		expect(sessionB?.uid).toBe("u1");
		// 无 uid 凭据 → 无会话（调用方转明确错误）。
		const noUid = new QoderAuthStore();
		noUid.learn({ access: "dt-3" });
		expect(noUid.session()).toBeUndefined();
	});
});

describe("oauth.login（D3：提取即登录 + PAT 次级入口）", () => {
	it("提取成功路径：fixture 密文 → OAuthCredentials 入库形态", async () => {
		// 全链：临时文件承载 fixture 密文。
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const dir = mkdtempSync(join(tmpdir(), "wool-qoder-login-"));
		const filePath = join(dir, "auth.v1.dat");
		writeFileSync(filePath, fixtureBlob());
		try {
			const progress: string[] = [];
			const interaction: LoginInteraction = {
				onPrompt: async () => {
					throw new Error("PAT prompt must not appear when extraction succeeds");
				},
				onProgress: (message) => progress.push(message),
			};
			const credentials = await login(interaction, { keychainRead: fixtureKeychain, authFilePath: filePath });
			expect(credentials.access).toBe("dt-fixture-access-token-000");
			expect(credentials.refresh).toBe("drt-fixture-refresh-token-00");
			expect(credentials.uid).toBe("fixture-user-id");
			expect(progress.join(";")).toContain("提取成功");
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	});

	it("提取失败 → PAT 次级入口（onPrompt 通道 + userinfo 验证）", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown) => {
				expect(String(url)).toContain("/api/v1/userinfo");
				return new Response(JSON.stringify({ id: "pat-uid", name: "PAT 用户", user_type: "personal" }), { status: 200 });
			}),
		);
		const credentials = await login(
			{
				onPrompt: async (prompt) => {
					expect(prompt.placeholder).toBe("pt-...");
					expect(prompt.message).toContain("PAT");
					return "pt-fixture-pat-token";
				},
			},
			{ keychainRead: () => {
				throw new Error("keychain unavailable");
			}, authFilePath: "/nonexistent" },
		);
		expect(credentials.access).toBe("pt-fixture-pat-token");
		expect(credentials.uid).toBe("pat-uid");
		expect(credentials.source).toBe("pat");
	});

	it("PAT 为空（用户取消）→ 显式失败不入库半残凭据", async () => {
		await expect(
			login(
				{ onPrompt: async () => "  " },
				{ keychainRead: () => {
					throw new Error("x");
				}, authFilePath: "/nonexistent" },
			),
		).rejects.toThrow(/PAT entry cancelled|userinfo/);
	});
});

describe("oauth.refreshToken（drt- 换新 dt-；PAT 无刷新链）", () => {
	it("drt- 形态：POST deviceToken/refresh 换新凭据", async () => {
		const calls: { url: string; body: string }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown, init?: RequestInit) => {
				calls.push({ url: String(url), body: String(init?.body) });
				return new Response(JSON.stringify({ token: "dt-next", refresh_token: "drt-next", expiresAt: 1790000000000 }), { status: 200 });
			}),
		);
		const next = await refreshToken({ access: "dt-old", refresh: "drt-old", expires: 1 });
		expect(next.access).toBe("dt-next");
		expect(next.refresh).toBe("drt-next");
		expect(next.expires).toBe(1790000000000);
		expect(calls[0]?.url).toContain(PATH_DEVICE_TOKEN_REFRESH);
		expect(JSON.parse(calls[0]!.body)).toEqual({ refresh_token: "drt-old" });
	});

	it("PAT 形态（无 refresh）：原样续期、零网络动作", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const next = await refreshToken({ access: "pt-x", refresh: "", expires: 1 });
		expect(next.access).toBe("pt-x");
		expect(next.expires).toBeGreaterThan(Date.now());
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("刷新 401（会话死）→ 抛错触发 pi 重新 login", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unauthorized", { status: 401 })),
		);
		await expect(refreshToken({ access: "dt-x", refresh: "drt-dead", expires: 1 })).rejects.toThrow(/401/);
	});
});

describe("oauth.getApiKey（学习通道）", () => {
	it("每请求学习 credential 全量并返回 access", () => {
		const store = new QoderAuthStore();
		const getApiKey = makeGetApiKey(store);
		expect(getApiKey({ access: "dt-live", refresh: "drt-live", uid: "u9" })).toBe("dt-live");
		expect(store.current()?.accessToken).toBe("dt-live");
	});
});

describe("openapi 域客户端（纯 Bearer + 官方 UA + 稳定机器头）", () => {
	it("userinfo 形态解析", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown, init?: RequestInit) => {
				expect(String(url)).toContain("openapi.qoder.com.cn/api/v1/userinfo");
				const headers = init?.headers as Record<string, string>;
				expect(headers.Authorization).toBe("Bearer dt-x");
				expect(headers["User-Agent"]).toMatch(/^QoderWork\//);
				return new Response(JSON.stringify({ id: "u1", name: "n", user_type: "t", organization_id: "o1" }), { status: 200 });
			}),
		);
		const userinfo = await fetchUserinfo("dt-x", "u1");
		expect(userinfo).toEqual({ id: "u1", name: "n", userType: "t", organizationId: "o1" });
	});

	it("quota 两桶聚合（userQuota + addOnQuota）", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(
					JSON.stringify({ userQuota: { used: 1.5, remaining: 398.5, total: 400 }, addOnQuota: { used: 0, remaining: 20, total: 20 } }),
					{ status: 200 },
				),
			),
		);
		const quota = await fetchQuotaUsage("dt-x", "u1");
		expect(quota).toEqual({ used: 1.5, remaining: 418.5, total: 420 });
	});

	it("稳定机器头（同 uid 同值，不同 salt 不同值）", () => {
		const headers = openapiHeaders("dt-x", "u1");
		expect(headers["X-Machine-ID"]).toBe(headers["X-Machine-ID"]);
		expect(headers["X-Machine-ID"]).not.toBe(headers["X-Session-ID"]);
		expect(headers.Origin).toBe("https://qoder.com.cn");
	});

	it("refreshDeviceToken 的 token 别名形态（device_token 字段族兼容）", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ device_token: "dt-alias", expiresAt: 1 }), { status: 200 })),
		);
		const next = await refreshDeviceToken("drt-x");
		expect(next.token).toBe("dt-alias");
		// 响应未回传 refresh_token → 保留原值。
		expect(next.refreshToken).toBe("drt-x");
	});
});
