// credential-resolve.test.ts — Trae 家族凭据获取面单测（无模块 mock）：
// - extract 管理动作响应契约（traeExtractToAcquireData：JWT 作 apiKey）；
// - 请求时凭据解析（resolveTraeAuth：复合串（oauth 钩子）与裸 JWT（models.json
//   apiKey 条目，设备要素从 storage.json 现读）双形态）。
// 真实凭据样本绝不入库——全部样本为合成假令牌。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { resolveTraeAuth, traeExtractToAcquireData } from "../index.ts";
import { TRAE_FIXTURE_LOGIN, traeStorageJson } from "./helpers/trae-container-fixture.ts";

/** extract 动作的 fixture 响应（假令牌）。 */
const acquireFixture = {
	credentials: {
		apiKey: TRAE_FIXTURE_LOGIN.token,
		refreshToken: TRAE_FIXTURE_LOGIN.refreshToken,
	},
	expiresAt: Date.parse(TRAE_FIXTURE_LOGIN.expiredAt),
};

describe("traeExtractToAcquireData（extract 动作响应契约）", () => {
	it("apiKey = 容器 JWT，refreshToken/expiresAt 带出（ISO → Unix ms）；容器无展示名 → account 缺席", () => {
		const data = traeExtractToAcquireData(TRAE_FIXTURE_LOGIN);
		expect(data).toEqual(acquireFixture);
		expect(data.account).toBeUndefined();
	});

	it("refreshToken 缺席省略；expiredAt 不可解析省略（0 = 不入契约）", () => {
		const data = traeExtractToAcquireData({ ...TRAE_FIXTURE_LOGIN, refreshToken: "", expiredAt: "not-a-date" });
		expect(data).toEqual({ credentials: { apiKey: TRAE_FIXTURE_LOGIN.token } });
	});
});

describe("resolveTraeAuth（请求时凭据双形态）", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "trae-resolve-auth-"));

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	/** 含 fixture 容器 + 设备要素的 storage.json 路径。 */
	function writeStorage(): string {
		const path = join(tmpDir, `storage-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
		writeFileSync(path, traeStorageJson(TRAE_FIXTURE_LOGIN, { machineId: "fixture-machine-id", soloDeviceId: "4242424242424242" }));
		return path;
	}

	it("复合串形态（oauth 钩子通道）：JWT + 设备三要素齐备直取，不触 storage.json", () => {
		const bundle = JSON.stringify({
			token: "fixture-jwt-bundle",
			userId: "u1",
			machineId: "m1",
			soloDeviceId: "s1",
		});
		expect(resolveTraeAuth(bundle)).toEqual({ token: "fixture-jwt-bundle", userId: "u1", machineId: "m1", soloDeviceId: "s1" });
	});

	it("裸 JWT 形态（models.json apiKey 通道）：设备要素 + userId 从本机 storage.json 现读", () => {
		const auth = resolveTraeAuth("fixture-jwt-bare-models-json", { storagePath: writeStorage() });
		expect(auth).toEqual({
			token: "fixture-jwt-bare-models-json",
			userId: "fixture-user-id",
			machineId: "fixture-machine-id",
			soloDeviceId: "4242424242424242",
		});
	});

	it("裸 JWT 且 storage.json 缺失 → 明确错误（恢复指引 = 重跑向导提取 / IDE 重登）", () => {
		expect(() => resolveTraeAuth("fixture-jwt-bare", { storagePath: join(tmpDir, "missing.json") })).toThrow(
			/Re-run the taiji wizard extraction.*Open Trae IDE and sign in again/s,
		);
	});

	it("apiKey 缺席（scaffold 双通道皆无形态）→ 统一「凭据未配置」错误", () => {
		expect(() => resolveTraeAuth(undefined)).toThrow(/凭据未配置：经 taiji 向导接入或在 pi 内 \/login/);
	});
});
