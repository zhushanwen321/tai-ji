// keychain-extract.test.ts — 钥匙串提取链 fixture 单测（验收条款③）。
//
// 输入 = fixtures/wool-qoder-crypto.json 的 keychainExtract 段（Python 参考实现
// 对固定 password + 合成 auth JSON 生成的完整密文）；mock security CLI 输出 +
// 临时密文文件，验证 PBKDF2 派生、AES 解密、schema 解析与错误路径（不触真实钥匙串、
// 不读真实凭据文件）。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { decryptSafeStorageBlob, defaultAuthFilePath, detectCredentialFile, extractCredentials, parseAuthPayload, type QoderAuthPayload } from "../keychain-extract.ts";
import { KEYCHAIN_ACCOUNT_CN, KEYCHAIN_SERVICE_CN, SAFE_STORAGE_ITERATIONS, SAFE_STORAGE_KEY_LEN, SAFE_STORAGE_SALT } from "../constants.ts";

interface CryptoFixture { // oe-exempt:20261022:test:keychain 提取测试的 fixture JSON 形状——仅本文件消费（无 src 消费），字段随用例演进
	keychainExtract: {
		keychainPassword: string;
		pbkdf2KeyHex: string;
		magic: string;
		ivSpacesHex: string;
		plainUtf8: string;
		ciphertextHex: string;
	};
}

const fixture = JSON.parse(
	readFileSync(join(import.meta.dirname, "fixtures", "wool-qoder-crypto.json"), "utf8"),
) as CryptoFixture;
const kc = fixture.keychainExtract;

/** fixture 密文文件字节（"v10" 魔数 + AES 密文）。 */
function fixtureBlob(): Uint8Array {
	const cipher = Buffer.from(kc.ciphertextHex, "hex");
	return new Uint8Array(Buffer.concat([Buffer.from(kc.magic, "ascii"), cipher]));
}

describe("Safe Storage 解密链", () => {
	it("PBKDF2-HMAC-SHA1 派生密钥与参考实现一致（salt/迭代/长度参数锁定）", async () => {
		const { pbkdf2Sync } = await import("node:crypto");
		const key = pbkdf2Sync(kc.keychainPassword, SAFE_STORAGE_SALT, SAFE_STORAGE_ITERATIONS, SAFE_STORAGE_KEY_LEN, "sha1");
		expect(key.toString("hex")).toBe(kc.pbkdf2KeyHex);
		// 参数族常量防漂移：saltysalt / 1003 / 16 / IV=16 空格。
		expect(SAFE_STORAGE_SALT).toBe("saltysalt");
		expect(SAFE_STORAGE_ITERATIONS).toBe(1003);
		expect(SAFE_STORAGE_KEY_LEN).toBe(16);
		expect(kc.ivSpacesHex).toBe("20202020202020202020202020202020");
	});

	it("解密 fixture 密文得合成 auth JSON（PKCS7 填充由 final 校验）", () => {
		const plain = decryptSafeStorageBlob(fixtureBlob(), kc.keychainPassword);
		expect(Buffer.from(plain).toString("utf8")).toBe(kc.plainUtf8);
	});

	it("魔数错误显式报错（schema 变更的可诊断信号）", () => {
		const bad = new Uint8Array(Buffer.concat([Buffer.from("v99", "ascii"), Buffer.from(kc.ciphertextHex.slice(0, 64), "hex")]));
		expect(() => decryptSafeStorageBlob(bad, kc.keychainPassword)).toThrow(/unexpected payload magic/);
	});

	it("密钥错误（password 不符）在填充校验处失败", () => {
		expect(() => decryptSafeStorageBlob(fixtureBlob(), "wrong-password")).toThrow();
	});
});

describe("auth.v1.dat schema 解析（读侧不信任外部格式）", () => {
	it("fixture 明文解析为强类型凭据", () => {
		const payload = parseAuthPayload(new Uint8Array(Buffer.from(kc.plainUtf8, "utf8")));
		expect(payload.token).toBe("dt-fixture-access-token-000");
		expect(payload.refreshToken).toBe("drt-fixture-refresh-token-00");
		expect(payload.user.id).toBe("fixture-user-id");
		expect(payload.user.name).toBe("fixture@example.com");
		expect(payload.expiresAt).toBe(1763624866000);
	});

	it("缺 token / 非 JSON / 非对象 各自显式报错", () => {
		expect(() => parseAuthPayload(new Uint8Array(Buffer.from('{"refreshToken":"x"}', "utf8")))).toThrow(/missing "token"/);
		expect(() => parseAuthPayload(new Uint8Array(Buffer.from("not-json", "utf8")))).toThrow(/not JSON/);
		expect(() => parseAuthPayload(new Uint8Array(Buffer.from("[1,2]", "utf8")))).toThrow(/not a JSON object/);
	});
});

describe("提取链全流程（mock 钥匙串 + 临时密文文件）", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	});

	function writeTempBlob(): string {
		const dir = mkdtempSync(join(tmpdir(), "wool-qoder-extract-"));
		tempDirs.push(dir);
		const filePath = join(dir, "auth.v1.dat");
		writeFileSync(filePath, fixtureBlob());
		return filePath;
	}

	it("extractCredentials 产出完整凭据", () => {
		const authFilePath = writeTempBlob();
		const payload: QoderAuthPayload = extractCredentials({
			keychainRead: (service, account) => {
				expect(service).toBe(KEYCHAIN_SERVICE_CN);
				expect(account).toBe(KEYCHAIN_ACCOUNT_CN);
				return `${kc.keychainPassword}\n`;
			},
			authFilePath,
		});
		expect(payload.token).toBe("dt-fixture-access-token-000");
		expect(payload.user.id).toBe("fixture-user-id");
	});

	it("钥匙串读取失败 → 错误消息带恢复动作（PAT 次级入口指引）", () => {
		const authFilePath = writeTempBlob();
		expect(() =>
			extractCredentials({
				keychainRead: () => {
					throw new Error("could not be found");
				},
				authFilePath,
			}),
		).toThrow(/keychain read failed.*PAT/s);
	});

	it("凭据文件缺失 → 错误消息带恢复动作", () => {
		expect(() =>
			extractCredentials({
				keychainRead: () => kc.keychainPassword,
				authFilePath: join(tmpdir(), "wool-qoder-extract-missing", "auth.v1.dat"),
			}),
		).toThrow(/cannot read.*logged in at least once/s);
	});

	it("登录态检测 = 存在性 stat（存在/缺失两态）", () => {
		const authFilePath = writeTempBlob();
		expect(detectCredentialFile(authFilePath)).toBe(true);
		expect(detectCredentialFile(join(authFilePath, ".missing"))).toBe(false);
	});

	it("缺省凭据路径动态推导（不写死用户目录）", () => {
		const path = defaultAuthFilePath("/Users/fixtures-home");
		expect(path).toBe(join("/Users/fixtures-home", "Library", "Application Support", "com.qodercn.app.stable", "auth.v1.dat"));
	});
});
