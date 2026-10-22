// helpers/trae-container-fixture.ts — Trae storage.json 容器 fixture 构造器
//（同 IDE byteCrypto 算法正向构造：明文 → 合法容器 base64）。
// 真实凭据样本绝不入库（红线）——全部样本为测试运行时合成。

import { createCipheriv, createHash } from "node:crypto";

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

/** 与 IDE byteCrypto 加密方向同构的正向构造（AES 版）：明文 → 合法容器 base64。 */
export function encryptTraeFixture(plaintext: string, seed: Uint8Array): string {
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

/** 合成登录态（假令牌）。 */
export const TRAE_FIXTURE_LOGIN = {
	token: "fixture-jwt-token-not-a-real-credential",
	refreshToken: "fixture-refresh-token",
	expiredAt: "2026-10-26T01:58:45.107Z",
	refreshExpiredAt: "2027-04-10T01:58:45.107Z",
	userId: "fixture-user-id",
	host: "https://api.trae.cn",
};

/** 组装一个含合法容器 + 设备要素明文键的 storage.json 内容。 */
export function traeStorageJson(login: typeof TRAE_FIXTURE_LOGIN, device: { machineId: string; soloDeviceId: string }): string {
	return JSON.stringify({
		"iCubeAuthInfo://icube.cloudide": encryptTraeFixture(JSON.stringify(login), new Uint8Array(32).fill(7)),
		"telemetry.machineId": device.machineId,
		[`iCubeAuthInfo://icube-dc:${device.soloDeviceId}`]: "0",
	});
}
