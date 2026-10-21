// byte-crypto.ts — Trae storage.json 登录态容器解密提取器（D3 ide-extract 家族）。
//
// 容器格式与算法来源（加密常量表，来源与提取方法注释——任务书红线）：
// - 容器载体：`~/Library/Application Support/Trae CN/User/globalStorage/storage.json`
//   的 `iCubeAuthInfo://icube.cloudide` 键，值为 base64(容器字节)。
// - 算法权威源：Trae IDE `/Applications/Trae CN.app/Contents/Resources/app/out/main.js`
//   内的模块 `out-build/vs/base/common/byteCrypto.js`（minify 前偏移约 1739000-1744500
//   区域，2026-10-21 读取实装核对）。提取方法：解包 app.asar 前的 out/main.js 直接
//   可读，按 `byteCrypto.js` 模块工厂函数内的常量表（Gle/zle XOR 表、容器魔数、
//   SHA512 派生逻辑）逐行翻译。
// - 容器布局：头 6 字节版本判定（"tc" 魔数 [116,99] + 版本字节）+ 32 字节随机 seed
//   （偏移 6..38）+ AES-CBC 密文（偏移 38 起）。
// - key 派生（AES 版）：SHA512(seed) ‖ (Gle[i]^zle[i]，i=0..63) 拼成 128 字节缓冲
//   → 整体 SHA512 → 前 16 字节 aesKey + 次 16 字节 iv（AES-128-CBC）。
// - 明文布局：64 字节 SHA512(plaintext) 校验头 + plaintext（JSON：token/refreshToken/
//   expiredAt/refreshExpiredAt/userId/host/account 等）。
// - AES_PRIVATE 版本：同构，仅 XOR 表换成 Vle^qle、头字节 [18,57,32,32,2,3]。
//   SS_V1/V2/V31-33 为旧格式，本实装不识别（按 UNKNOWN 拒绝并给恢复指引）。

import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * hex 字符串 → 字节表（常量表的编码形态；数据表逐十进制字面量会触发
 * no-magic-numbers 对 64 字节数据的逐字误报，hex 形态语义不变）。
 */
function decodeHexTable(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / HEX_DIGITS_PER_BYTE);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(hex.slice(i * HEX_DIGITS_PER_BYTE, (i + 1) * HEX_DIGITS_PER_BYTE), HEX_RADIX);
	}
	return out;
}

/** hex 编码每字节的位数。 */
const HEX_DIGITS_PER_BYTE = 2;

/** 十六进制基数。 */
const HEX_RADIX = 16;

/** AES 版 XOR 表 A（来源：main.js byteCrypto.js 常量 Gle；十进制逐字节抄录后 hex 编码）。 */
const XOR_TABLE_A = decodeHexTable(
	"52096ad53036a538bf40a39e81f3d7fb7ce339829b2fff87348e4344c4dee9cb" +
		"547b9432a6c2233dee4c950b42fac34e082ea16628d924b2765ba2496d8bd125",
);

/** AES 版 XOR 表 B（来源：main.js byteCrypto.js 常量 zle；十进制逐字节抄录后 hex 编码）。 */
const XOR_TABLE_B = decodeHexTable(
	"1fdda8338807c731b11210592780ec5f60517fa919b54a0d2de57a9f93c99cef" +
		"a0e03b4dae2af5b0c8ebbb3c83539961172b047eba77d626e169146355210c7d",
);

/** AES_PRIVATE 版 XOR 表 A（来源：main.js byteCrypto.js 常量 Vle；十进制逐字节抄录后 hex 编码）。 */
const PRIVATE_TABLE_A = decodeHexTable(
	"bfc0d8fa7af6dc611ffe621b084847b0876360127f65cb68d366bf7d2548969c" +
		"33e5792311998db16e839680acfffe06128c373eecf98740870c75045995a8d1",
);

/** AES_PRIVATE 版 XOR 表 B（来源：main.js byteCrypto.js 常量 qle；十进制逐字节抄录后 hex 编码）。 */
const PRIVATE_TABLE_B = decodeHexTable(
	"f6cc1ae8e846816ddf92a9f217f1699132c4a52afe780336f4cfd15535068a6a" +
		"af941fccbabaa5b6578e310a276e1a9a5638ad7d1240c6e163635352bf864caa",
);

/** 容器头长度（字节）。 */
const HEADER_LEN = 6;
/** 容器内嵌 seed 长度（32 字节，偏移 6..38）。 */
const SEED_LEN = 32;
/** 明文校验头长度（SHA512 摘要 64 字节）。 */
const CHECKSUM_LEN = 64;
/** 派生缓冲长度（SHA512 输出 64 + XOR 表 64）。 */
const DERIVE_BUF_LEN = 128;
/** XOR 派生表长度（字节，Gle/zle 各 64 字节）。 */
const TABLE_LEN = 64;
/** AES-128 密钥长度（字节）。 */
const AES_KEY_LEN = 16;
/** AES-CBC IV 长度（字节）。 */
const IV_LEN = 16;
/** AES-CBC 单块长度（字节）——容器最小合法密文长度。 */
const AES_BLOCK_LEN = 16;

/** 容器版本（byteCrypto Zs 枚举的本实装子集）。 */
type ContainerVersion = "aes" | "aes-private" | "unknown";

/** AES 版容器头 hex（"tc" 魔数 74 63 + 版本字节 05 10 00 00——main.js 实测形态）。 */
const AES_HEADER_HEX = "746305100000";

/** AES_PRIVATE 版容器头 hex（main.js byteCrypto 实测魔数 12 39 20 20 02 03）。 */
const PRIVATE_HEADER_HEX = "123920200203";

/** "tc" 魔数 hex（AES 版容器头前两字节）。 */
const TC_MAGIC_HEX = "7463";

/** 容器版本判定（头 6 字节；对照 main.js VVe 函数）。 */
function detectVersion(header: Uint8Array): ContainerVersion {
	const headerHex = Buffer.from(header.subarray(0, HEADER_LEN)).toString("hex");
	if (headerHex === PRIVATE_HEADER_HEX) {
		return "aes-private";
	}
	if (!headerHex.startsWith(TC_MAGIC_HEX)) {
		// "tc" 魔数不符
		return "unknown";
	}
	if (headerHex === AES_HEADER_HEX) {
		return "aes";
	}
	// SS_V1/V2/V31-33 旧格式：不识别
	return "unknown";
}

function sha512(data: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha512").update(data).digest());
}

/** 派生 64 字节中间表（AES 版 = A^B；AES_PRIVATE 版 = 私有表对）。 */
function derivedTable(version: ContainerVersion): Uint8Array {
	const tableA = version === "aes" ? XOR_TABLE_A : PRIVATE_TABLE_A;
	const tableB = version === "aes" ? XOR_TABLE_B : PRIVATE_TABLE_B;
	const out = new Uint8Array(TABLE_LEN);
	for (let i = 0; i < TABLE_LEN; i++) {
		out[i] = tableA[i] ^ tableB[i];
	}
	return out;
}

/** key 派生（对照 main.js Fle 函数）：aesKey 16B + iv 16B。 */
function deriveKeyIv(seed: Uint8Array, version: ContainerVersion): { aesKey: Uint8Array; iv: Uint8Array } {
	const buffer = new Uint8Array(DERIVE_BUF_LEN);
	buffer.set(sha512(seed), 0);
	buffer.set(derivedTable(version), TABLE_LEN);
	buffer.set(sha512(buffer), 0);
	return { aesKey: buffer.slice(0, AES_KEY_LEN), iv: buffer.slice(AES_KEY_LEN, AES_KEY_LEN + IV_LEN) };
}

/** 容器解密失败（版本不识别 / 校验头不符 / 解密异常）。 */
export class TraeContainerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TraeContainerError";
	}
}

/**
 * 解密单个容器（base64 值 → 明文 JSON 字符串）。
 * 校验头不符时抛 TraeContainerError（数据损坏或算法漂移——IDE 升级改加密的场景）。
 */
export function decryptContainer(base64Value: string): string {
	const container = new Uint8Array(Buffer.from(base64Value, "base64"));
	if (container.length < HEADER_LEN + SEED_LEN + AES_BLOCK_LEN) {
		throw new TraeContainerError(`container too short: ${container.length} bytes`);
	}
	const version = detectVersion(container.subarray(0, HEADER_LEN));
	if (version === "unknown") {
		throw new TraeContainerError(
			`unknown container header ${Array.from(container.subarray(0, HEADER_LEN)).join(",")}: Trae IDE may have changed its encryption — update this extractor from the IDE main.js byteCrypto module`,
		);
	}
	const seed = container.slice(HEADER_LEN, HEADER_LEN + SEED_LEN);
	const { aesKey, iv } = deriveKeyIv(seed, version);
	const ciphertext = container.slice(HEADER_LEN + SEED_LEN);
	let plain: Uint8Array;
	try {
		const decipher = createDecipheriv("aes-128-cbc", Buffer.from(aesKey), Buffer.from(iv));
		plain = new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]));
	} catch (error) {
		throw new TraeContainerError(`AES decryption failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (plain.length <= CHECKSUM_LEN) {
		throw new TraeContainerError("decrypted payload shorter than checksum header");
	}
	const expected = sha512(plain.slice(CHECKSUM_LEN));
	for (let i = 0; i < CHECKSUM_LEN; i++) {
		if (expected[i] !== plain[i]) {
			throw new TraeContainerError("SHA512 checksum mismatch after decryption");
		}
	}
	return Buffer.from(plain.slice(CHECKSUM_LEN)).toString("utf8");
}

/** storage.json 解密所得登录态（容器 payload 的消费形态）。 */
export type TraeStoredLogin = {
	token: string;
	refreshToken: string;
	/** token 过期时点（ISO 字符串，上游原样）。 */
	expiredAt: string;
	refreshExpiredAt: string;
	userId: string;
	host: string;
};

/** 运行时守卫：容器 payload 形状校验（读侧不信任外部格式）。 */
function isTraeStoredLogin(value: unknown): value is TraeStoredLogin {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.token === "string" &&
		record.token.length > 0 &&
		typeof record.refreshToken === "string" &&
		typeof record.expiredAt === "string" &&
		typeof record.refreshExpiredAt === "string" &&
		typeof record.userId === "string" &&
		typeof record.host === "string"
	);
}

/** mac 数据目录布局（设计非目标：Windows/Linux 首发不交付，代码不写死 mac 路径）。 */
function storageJsonPath(platform: NodeJS.Platform = process.platform): string | undefined {
	if (platform !== "darwin") {
		return undefined;
	}
	return join(homedir(), "Library", "Application Support", "Trae CN", "User", "globalStorage", "storage.json");
}

/**
 * 登录态检测（D3 语义）：只 stat storage.json 是否存在，不读取内容、不解密、不轮询。
 * 返回 false = 未检测到登录态（未装 IDE 或未登录）。storagePath 供测试注入 fixture。
 */
export function detectTraeLoginState(storagePath: string = storageJsonPath() ?? ""): boolean {
	if (storagePath.length === 0) {
		return false;
	}
	try {
		return statSync(storagePath).isFile();
	} catch {
		return false;
	}
}

/** 提取失败的恢复指引（D3：无 PAT 入口，唯一恢复路径 = IDE 重登）。 */
export const TRAE_EXTRACT_RECOVERY_HINT =
	"Open Trae IDE and sign in again, then retry the extraction.";

/** storage.json 明文区读取的设备要素（x-machine-id 与 SOLO 设备 id）。 */
type TraeDeviceFacts = {
	machineId: string;
	soloDeviceId: string;
};

/** SOLO 设备 id 键名形态：`iCubeAuthInfo://icube-dc:<digits>`（取键名数字段，不读值）。 */
const SOLO_DEVICE_KEY = /^iCubeAuthInfo:\/\/icube-dc:(\d+)$/;

function readDeviceFacts(storage: Record<string, unknown>): TraeDeviceFacts {
	const machineId = typeof storage["telemetry.machineId"] === "string" ? storage["telemetry.machineId"] : "";
	let soloDeviceId = "";
	for (const key of Object.keys(storage)) {
		const match = SOLO_DEVICE_KEY.exec(key);
		if (match !== null) {
			soloDeviceId = match[1];
			break;
		}
	}
	return { machineId, soloDeviceId };
}

/**
 * 提取链（D3：仅在用户向导显式触发时执行一次）：
 * 读 storage.json → 取 `iCubeAuthInfo://icube.cloudide` 容器 → 解密 → 形状校验。
 * 附带读取明文区设备要素（machineId / soloDeviceId，供请求头族）。
 * 抛错 = 提取失败（调用方把 TRAE_EXTRACT_RECOVERY_HINT 呈给用户）。
 * storagePath 供测试注入 fixture（生产缺省 = 平台推导路径）。
 */
export function extractTraeLogin(storagePath: string = storageJsonPath() ?? ""): { login: TraeStoredLogin; device: TraeDeviceFacts } {
	if (storagePath.length === 0) {
		throw new TraeContainerError(
			`Trae CN credential extraction is not supported on ${process.platform}. ${TRAE_EXTRACT_RECOVERY_HINT}`,
		);
	}
	let storage: unknown;
	try {
		storage = JSON.parse(readFileSync(storagePath, "utf8"));
	} catch (error) {
		throw new TraeContainerError(
			`cannot read storage.json (${error instanceof Error ? error.message : String(error)}). ${TRAE_EXTRACT_RECOVERY_HINT}`,
		);
	}
	if (typeof storage !== "object" || storage === null) {
		throw new TraeContainerError(`storage.json is not an object. ${TRAE_EXTRACT_RECOVERY_HINT}`);
	}
	const record = storage as Record<string, unknown>;
	const containerValue = record["iCubeAuthInfo://icube.cloudide"];
	if (typeof containerValue !== "string" || containerValue.length === 0) {
		throw new TraeContainerError(`no login container found in storage.json. ${TRAE_EXTRACT_RECOVERY_HINT}`);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(decryptContainer(containerValue));
	} catch (error) {
		if (error instanceof TraeContainerError) {
			throw error;
		}
		throw new TraeContainerError(
			`decrypted payload is not valid JSON (${error instanceof Error ? error.message : String(error)}). ${TRAE_EXTRACT_RECOVERY_HINT}`,
		);
	}
	if (!isTraeStoredLogin(payload)) {
		throw new TraeContainerError(
			`decrypted payload has unexpected shape — Trae IDE may have changed its credential format. ${TRAE_EXTRACT_RECOVERY_HINT}`,
		);
	}
	return { login: payload, device: readDeviceFacts(record) };
}
