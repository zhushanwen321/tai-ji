// 容器解密提取器单测：合成加密样本（同算法正向构造）+ mock key（随机 seed）。
// 真实凭据样本绝不入库（红线）——本文件全部样本为测试运行时合成。

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
	TRAE_EXTRACT_RECOVERY_HINT,
	TraeContainerError,
	decryptContainer,
	detectTraeLoginState,
	extractTraeLogin,
} from "../byte-crypto.ts";

/** 与 IDE byteCrypto 加密方向同构的正向构造（AES 版）：明文 → 合法容器 base64。 */
function encryptFixture(plaintext: string, seed: Uint8Array): string {
	const derived = new Uint8Array(64);
	for (let i = 0; i < 64; i++) {
		derived[i] = FIXTURE_TABLE_A[i] ^ FIXTURE_TABLE_B[i];
	}
	const buffer = new Uint8Array(128);
	buffer.set(new Uint8Array(createHash("sha512").update(seed).digest()), 0);
	buffer.set(derived, 64);
	buffer.set(new Uint8Array(createHash("sha512").update(buffer).digest()), 0);
	const aesKey = buffer.slice(0, 16);
	const iv = buffer.slice(16, 32);
	const checksum = new Uint8Array(createHash("sha512").update(Buffer.from(plaintext, "utf8")).digest());
	const plain = Buffer.concat([Buffer.from(checksum), Buffer.from(plaintext, "utf8")]);
	const cipher = createCipheriv("aes-128-cbc", Buffer.from(aesKey), Buffer.from(iv));
	const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
	const container = Buffer.concat([Buffer.from([116, 99, 5, 16, 0, 0]), Buffer.from(seed), ciphertext]);
	return container.toString("base64");
}

/** 与 byte-crypto.ts 抄录常量一致的 fixture 侧表（正向构造用；改动需双向同步）。 */
const FIXTURE_TABLE_A = Uint8Array.from([
	82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52,
	142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161,
	102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
]);
const FIXTURE_TABLE_B = Uint8Array.from([
	31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229,
	122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4,
	126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
]);

const FIXTURE_LOGIN = {
	token: "fixture-jwt-token-not-a-real-credential",
	refreshToken: "fixture-refresh-token",
	expiredAt: "2026-10-26T01:58:45.107Z",
	refreshExpiredAt: "2027-04-10T01:58:45.107Z",
	userId: "fixture-user-id",
	host: "https://api.trae.cn",
};

describe("decryptContainer（AES 版容器）", () => {
	it("合法容器往返解密（校验头通过）", () => {
		const seed = new Uint8Array(randomBytes(32));
		const container = encryptFixture(JSON.stringify(FIXTURE_LOGIN), seed);
		const decrypted = decryptContainer(container);
		expect(JSON.parse(decrypted)).toEqual(FIXTURE_LOGIN);
	});

	it("容器头魔数为 tc + 版本字节 [116,99,5,16,0,0]（IDE main.js byteCrypto 实测形态）", () => {
		const container = Buffer.from(encryptFixture("{}", randomBytes(32)), "base64");
		expect(Array.from(container.subarray(0, 6))).toEqual([116, 99, 5, 16, 0, 0]);
		expect(container.subarray(0, 2).toString("latin1")).toBe("tc");
	});

	it("校验头被篡改 → TraeContainerError（不静默输出损坏明文）", () => {
		const container = Buffer.from(encryptFixture("{}", randomBytes(32)), "base64");
		// 破坏密文首块（校验头随之不符）
		container[38] ^= 0xff;
		expect(() => decryptContainer(container.toString("base64"))).toThrow(TraeContainerError);
	});

	it("未知容器头 → TraeContainerError + IDE 重登恢复指引（算法漂移场景）", () => {
		const bogus = Buffer.from([1, 2, 3, 4, 5, 6, ...randomBytes(64)]).toString("base64");
		expect(() => decryptContainer(bogus)).toThrow(TraeContainerError);
		try {
			decryptContainer(bogus);
		} catch (error) {
			expect((error as Error).message).toContain("byteCrypto");
		}
	});

	it("过短容器 → TraeContainerError", () => {
		expect(() => decryptContainer(Buffer.from([116, 99, 5, 16, 0, 0, 1, 2, 3]).toString("base64"))).toThrow(
			TraeContainerError,
		);
	});
});

describe("extractTraeLogin（提取链，fixture 路径注入）", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "trae-extract-test-"));

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	function writeStorage(extra: Record<string, unknown>): string {
		const path = join(tmpDir, `storage-${randomBytes(4).toString("hex")}.json`);
		writeFileSync(
			path,
			JSON.stringify({
				"telemetry.machineId": "fixture-machine-id",
				"iCubeAuthInfo://icube-dc:4242424242424242": "irrelevant-value-not-read",
				"iCubeAuthInfo://icube.cloudide": encryptFixture(JSON.stringify(FIXTURE_LOGIN), randomBytes(32)),
				...extra,
			}),
		);
		return path;
	}

	it("完整提取链：容器解密 + 设备要素（machineId / soloDeviceId 取自键名）", () => {
		const { login, device } = extractTraeLogin(writeStorage({}));
		expect(login.token).toBe(FIXTURE_LOGIN.token);
		expect(login.refreshToken).toBe(FIXTURE_LOGIN.refreshToken);
		expect(login.userId).toBe(FIXTURE_LOGIN.userId);
		expect(device.machineId).toBe("fixture-machine-id");
		expect(device.soloDeviceId).toBe("4242424242424242");
	});

	it("容器键缺失 → TraeContainerError + 恢复指引", () => {
		const path = join(tmpDir, `storage-empty-${randomBytes(4).toString("hex")}.json`);
		writeFileSync(path, JSON.stringify({ "telemetry.machineId": "x" }));
		expect(() => extractTraeLogin(path)).toThrow(TraeContainerError);
		try {
			extractTraeLogin(path);
		} catch (error) {
			expect((error as Error).message).toContain(TRAE_EXTRACT_RECOVERY_HINT);
		}
	});
});

describe("detectTraeLoginState（D3：只 stat 存在性）", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "trae-detect-test-"));

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	it("文件存在 → true；缺失 → false", () => {
		const path = join(tmpDir, "storage.json");
		expect(detectTraeLoginState(path)).toBe(false);
		writeFileSync(path, "{}");
		expect(detectTraeLoginState(path)).toBe(true);
	});
});
