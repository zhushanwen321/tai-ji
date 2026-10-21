// keychain-extract.ts — macOS 钥匙串提取链（Qoder 桌面端登录态 → pi auth.json 凭据）。
//
// 链路（任务书协议事实锚 + 本机实测打通）：`security find-generic-password` 免弹窗读
// Safe Storage 密码（base64 字符串原文）→ PBKDF2-HMAC-SHA1(salt="saltysalt",
// iterations=1003, dkLen=16) 派生 AES-128 密钥 → AES-128-CBC（IV=16 个空格字节）
// 解密 auth.v1.dat（去 "v10" 头，PKCS7 由 cipher.final 校验）→ 解析 JSON schema。
// 该形态 = Chromium os_crypt 的 mac safeStorage 经典变体；Windows 走 DPAPI 另一变体
// （参考实现 qoder_accounts.py 仅实装 Windows 侧）——平台差异落在交付说明，本模块
// 只实装本机实测可行的 mac 链路。
//
// 登录态检测语义（设计 D3）：detect 只做凭据文件 stat 存在性检查——不读内容、
// 不解密、不轮询。

import { execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	AUTH_FILE_BASENAME,
	APP_DATA_DIRNAME,
	KEYCHAIN_ACCOUNT_CN,
	KEYCHAIN_SERVICE_CN,
	OS_CRYPT_MAGIC,
	SAFE_STORAGE_ITERATIONS,
	SAFE_STORAGE_IV,
	SAFE_STORAGE_KEY_LEN,
	SAFE_STORAGE_SALT,
} from "./constants.ts";

/** auth.v1.dat 明文 schema（本机实测 + hub 注释同形；读侧不信任外部格式——
 * 字段缺失/形态不符直接抛错，不静默产出半残凭据）。 */
export type QoderAuthPayload = {
	schemaVersion: number;
	/** 设备访问令牌（`dt-` 前缀），openapi 域纯 Bearer 直调可用。 */
	token: string;
	/** 刷新令牌（`drt-` 前缀），pi oauth refreshToken 钩子的交换凭据。 */
	refreshToken: string;
	/** 访问令牌到期（Unix ms）。 */
	expiresAt: number;
	refreshTokenExpiresAt?: number;
	user: { id: string; name: string; email?: string };
};

/** 钥匙串读取通道（可注入；生产 = `security` CLI 子进程）。 */
export type KeychainReader = (service: string, account: string) => string;

function defaultKeychainRead(service: string, account: string): string {
	// -w 只输出密码本体；免弹窗（非交互读自身会话写入的条目）。
	return execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
		encoding: "utf8",
	});
}

/** CN 区凭据文件绝对路径（本机动态推导，不写死用户目录）。 */
export function defaultAuthFilePath(home = homedir()): string {
	return join(home, "Library", "Application Support", APP_DATA_DIRNAME, AUTH_FILE_BASENAME);
}

/** 登录态检测（D3 语义）：凭据文件存在性一次 stat 检查。 */
export function detectCredentialFile(authFilePath = defaultAuthFilePath()): boolean {
	return existsSync(authFilePath);
}

/** 单条解密：PBKDF2 派生密钥 + AES-128-CBC（IV=16 空格）解 "v10" 密文。
 * 独立导出供 fixture 对照测试（同输入期望值由 Python 参考实现生成）。 */
export function decryptSafeStorageBlob(blob: Uint8Array, keychainPassword: string): Uint8Array {
	// "v10" 魔数长度按常量本体推导（魔数变更时此处跟随，不另设数字）。
	const magicLength = OS_CRYPT_MAGIC.length;
	const magic = Buffer.from(blob.slice(0, magicLength)).toString("ascii");
	if (magic !== OS_CRYPT_MAGIC) {
		throw new Error(`qoder extract: unexpected payload magic ${JSON.stringify(magic)}, expected "${OS_CRYPT_MAGIC}" (Qoder app data schema may have changed)`);
	}
	// password = base64 字符串**原文**作 PBKDF2 材料（本机实测口径：不做 base64 解码）。
	const key = pbkdf2Sync(keychainPassword, SAFE_STORAGE_SALT, SAFE_STORAGE_ITERATIONS, SAFE_STORAGE_KEY_LEN, "sha1");
	const decipher = createDecipheriv("aes-128-cbc", key, Buffer.from(SAFE_STORAGE_IV, "utf8"));
	// PKCS7 填充错误在 final() 抛——密钥错/格式变都到这里，统一转可操作信息。
	const plain = Buffer.concat([decipher.update(blob.subarray(magicLength)), decipher.final()]);
	return new Uint8Array(plain);
}

/** 解析明文 schema 为强类型凭据（读侧不信任外部格式）。 */
export function parseAuthPayload(plain: Uint8Array): QoderAuthPayload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(plain).toString("utf8"));
	} catch (error) {
		throw new Error(
			`qoder extract: decrypted payload is not JSON (${error instanceof Error ? error.message : String(error)}) — schema may have changed`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("qoder extract: decrypted payload is not a JSON object");
	}
	const record = parsed as Record<string, unknown>;
	const token = record.token;
	const refreshToken = record.refreshToken;
	const user = record.user;
	if (typeof token !== "string" || token.length === 0) {
		throw new Error('qoder extract: payload missing "token" (not logged in or schema changed)');
	}
	if (typeof refreshToken !== "string") {
		throw new Error('qoder extract: payload missing "refreshToken"');
	}
	if (typeof user !== "object" || user === null || typeof (user as Record<string, unknown>).id !== "string") {
		throw new Error('qoder extract: payload missing "user.id"');
	}
	const name = (user as Record<string, unknown>).name;
	const email = (user as Record<string, unknown>).email;
	return {
		schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : 0,
		token,
		refreshToken,
		expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : 0,
		...(typeof record.refreshTokenExpiresAt === "number" ? { refreshTokenExpiresAt: record.refreshTokenExpiresAt } : {}),
		user: {
			id: (user as Record<string, unknown>).id as string,
			name: typeof name === "string" ? name : "",
			...(typeof email === "string" ? { email } : {}),
		},
	};
}

/** 提取链入口（D3：只在用户点「提取」时执行一次）。任一步失败抛 Error，
 * 消息带恢复动作（确认桌面端已登录 / 改用官方 PAT）。 */
export function extractCredentials(options?: {
	keychainRead?: KeychainReader;
	authFilePath?: string;
}): QoderAuthPayload {
	const keychainRead = options?.keychainRead ?? defaultKeychainRead;
	const authFilePath = options?.authFilePath ?? defaultAuthFilePath();
	let password: string;
	try {
		password = keychainRead(KEYCHAIN_SERVICE_CN, KEYCHAIN_ACCOUNT_CN).trim();
	} catch (error) {
		throw new Error(
			`qoder extract: keychain read failed (${error instanceof Error ? error.message : String(error)}). Confirm Qoder desktop app is installed and logged in, or fall back to the official PAT entry`,
		);
	}
	if (password.length === 0) {
		throw new Error("qoder extract: keychain returned an empty Safe Storage password. Confirm Qoder desktop app is logged in, or fall back to the official PAT entry");
	}
	let blob: Uint8Array;
	try {
		blob = readFileSync(authFilePath);
	} catch (error) {
		throw new Error(
			`qoder extract: cannot read ${authFilePath} (${error instanceof Error ? error.message : String(error)}). Confirm Qoder desktop app is logged in at least once, or fall back to the official PAT entry`,
		);
	}
	return parseAuthPayload(decryptSafeStorageBlob(blob, password));
}
