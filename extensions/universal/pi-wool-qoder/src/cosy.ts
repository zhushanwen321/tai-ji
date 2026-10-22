// cosy.ts — COSY 会话与请求签名（gateway 域对话/模型目录的出站鉴权族）。
//
// 翻译自开源参考实现（shuishuipingan/qoder2api-hub v1.6.4 qoder_sign.py CosySession
// 与 qoder_fingerprint.py）。加密原语用 node:crypto（AES/RSA/MD5 由 OpenSSL 承担，
// 与 hub 的纯 Python 实现同为标准算法语义；JSON 排序/三段轮转/MD5 拼接序等协议
// 层约定逐项对齐）。签名强度风险（tempKey 64bit 熵、RSA-1024）源自官方协议本身，
// 与参考实现一致，不为「加固」单方面偏离兼容性（同 hub qoder_sign.py 风险注记）。

import {
	constants,
	createCipheriv,
	createHash,
	createSign,
	createVerify,
	generateKeyPairSync,
	publicEncrypt,
	randomBytes,
	randomUUID,
} from "node:crypto";

import { AES_BLOCK_BYTES, COSY_USER_AGENT, COSY_VERSION, SERVER_PUBLIC_PEM } from "./constants.ts";
import { jsonSortedCompact } from "./encode.ts";

/** COSY 会话密钥字节长（16 个 hex 字符 = AES-128 key/iv 同宽；hub uuid4().hex[:16]）。 */
const COSY_TEMP_KEY_BYTES = 8;
/** epoch 秒换算（cosy-date 头与签名 payload 的 date 段都是秒）。 */
const MS_PER_SECOND = 1000;

/** 服务端公钥自检（加载期一次）：① PKCS#1 v1.5 加密原语就绪（临时密钥对，公钥加密
 * 两断言：密文长度 = modulus 字节数 + 同明文两次加密密文不同——type 2 随机填充的
 * 构造性证据，无需私钥解密回读）；② RSA 签名/验签往返（私钥原语完整性，Bun 宿主
 * 兼容层实测可用）；③ 官方公钥可被 OpenSSL 解析（公钥错 = 全部请求即刻失败，加载期
 * fail-fast 比首请求期报错更可诊断）。
 * [HISTORICAL] 自检原形态 = publicEncrypt→privateDecrypt 往返——D3 验收 a4 实测 pi
 * 宿主（Bun 编译）的 node:crypto 兼容层禁用 RSA_PKCS1_PADDING 私钥解密（「no longer
 * supported for private decryption」），而真实请求路径只用公钥加密方向（服务端响应
 * 走 AES 会话密钥对称通道），私钥解密仅为自检手段——改用无需私钥解密的等价断言。 */
let selfCheckDone = false;
function assertCryptoReady(): void {
	if (selfCheckDone) {
		return;
	}
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
	// 探针长度 = 会话密钥真实长度（16 字节——RSA 包裹的目标形态，自检才有代表性）。
	const probe = randomBytes(AES_BLOCK_BYTES);
	const wrapped = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, probe);
	const signer = createSign("SHA256");
	signer.update(probe);
	const signature = signer.sign(privateKey);
	// 签名长度 = modulus 字节数（RSA 输出恒等于模长）——密文长度与它对表。
	if (wrapped.length !== signature.length) {
		throw new Error("cosy: RSA PKCS#1 v1.5 ciphertext length mismatch");
	}
	if (publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, probe).equals(wrapped)) {
		throw new Error("cosy: RSA PKCS#1 v1.5 padding not randomized (deterministic ciphertext)");
	}
	const verifier = createVerify("SHA256");
	verifier.update(probe);
	if (!verifier.verify(publicKey, signature)) {
		throw new Error("cosy: RSA sign/verify roundtrip failed");
	}
	publicEncrypt({ key: SERVER_PUBLIC_PEM, padding: constants.RSA_PKCS1_PADDING }, probe);
	selfCheckDone = true;
}

/** RSA PKCS#1 v1.5 (type 2) 公钥加密：包裹 16 字节会话密钥（hub rsa_pkcs1v15_encrypt
 * 的 OpenSSL 等价——随机填充由密码库负责，数学语义同 pow(m,e,n)）。 */
export function rsaWrapSessionKey(plain: Uint8Array): Uint8Array {
	assertCryptoReady();
	return new Uint8Array(publicEncrypt({ key: SERVER_PUBLIC_PEM, padding: constants.RSA_PKCS1_PADDING }, plain));
}

/** AES-128-CBC 加密 + PKCS7 填充（info 身份体加密用；hub aes_cbc_encrypt 同语义，
 * key == iv == tempKey 的 UTF-8 字节，16 ASCII 字符）。 */
export function aesCbcEncrypt(plain: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
	if (key.length !== AES_BLOCK_BYTES || iv.length !== AES_BLOCK_BYTES) {
		throw new Error(`cosy: aes key/iv must be ${AES_BLOCK_BYTES} bytes, got key=${key.length} iv=${iv.length}`);
	}
	const cipher = createCipheriv("aes-128-cbc", key, iv);
	return new Uint8Array(Buffer.concat([cipher.update(plain), cipher.final()]));
}

// ---------------------------------------------------------------------------
// 稳定设备指纹派生（hub qoder_fingerprint.py；同一账号永远来自同一台虚拟设备，
// 防随机机器码触发上游风控；多账号之间天然隔离）。
// ---------------------------------------------------------------------------

/** UUID 形状参数（32 位 hex + 版本/变体位改写 + 连字符分段；hub 逐字符同形）。 */
const HEX_UUID_TOTAL = 32;
/** RFC 4122 版本位（第 13 个 hex 字符，index 12）改写为 "4" = version 4 形状。 */
const UUID_VERSION_NIBBLE_INDEX = 12;
/** 变体位（第 17 个 hex 字符，index 16）改写为 "a" = RFC 4122 variant 形状。 */
const UUID_VARIANT_NIBBLE_INDEX = 16;
/** RFC 4122 连字符位（8-4-4-4-12 hex 分段——四个插入位逐一具名）。 */
const UUID_HYPHEN_AT_FIRST = 8;
const UUID_HYPHEN_AT_SECOND = 12;
const UUID_HYPHEN_AT_THIRD = 16;
const UUID_HYPHEN_AT_FOURTH = 20;
const UUID_HYPHEN_POSITIONS = [UUID_HYPHEN_AT_FIRST, UUID_HYPHEN_AT_SECOND, UUID_HYPHEN_AT_THIRD, UUID_HYPHEN_AT_FOURTH] as const;
/** machine_type = 去横线形态截 18 位（cosy-machinetoken 同形；hub derive_machine_type）。 */
const MACHINE_TYPE_LENGTH = 18;
/** machine_token = sha512 base64url 截 43 字符（hub derive_machine_token 同长）。 */
const MACHINE_TOKEN_LENGTH = 43;
/** hostname 后缀段长（DESKTOP-XXXXXXX；hub _machine_hostname）。 */
const HOSTNAME_SUFFIX_HEX = 7;

/** 由 uid + salt 单向派生带连字符的 UUID 形状标识（版本位 4 / 变体位 a，与官方
 * 客户端 machineId 逐字符同形——hub issue #61 修正后的形态）。 */
export function deriveId(uid: string, salt: string): string {
	const h = createHash("md5").update(`${salt}:${uid || "anonymous"}`, "utf8").digest("hex");
	const shaped =
		h.slice(0, UUID_VERSION_NIBBLE_INDEX) +
		"4" +
		h.slice(UUID_VERSION_NIBBLE_INDEX + 1, UUID_VARIANT_NIBBLE_INDEX) +
		"a" +
		h.slice(UUID_VARIANT_NIBBLE_INDEX + 1, HEX_UUID_TOTAL);
	let dashed = shaped.slice(0, UUID_HYPHEN_POSITIONS[0]);
	for (let i = 0; i < UUID_HYPHEN_POSITIONS.length - 1; i++) {
		dashed += `-${shaped.slice(UUID_HYPHEN_POSITIONS[i], UUID_HYPHEN_POSITIONS[i + 1])}`;
	}
	return `${dashed}-${shaped.slice(UUID_HYPHEN_POSITIONS[UUID_HYPHEN_POSITIONS.length - 1])}`;
}

/** 18 位去横线 machine_type（cosy-machinetoken 同形；hub derive_machine_type）。 */
export function deriveMachineType(uid: string): string {
	return deriveId(uid, "machinetype").replace(/-/g, "").slice(0, MACHINE_TYPE_LENGTH);
}

/** machine_token：sha512 派生的 base64url 随机串外观（hub derive_machine_token）。 */
export function deriveMachineToken(uid: string): string {
	return createHash("sha512").update(`machinetoken:${uid}`, "utf8").digest("base64url").slice(0, MACHINE_TOKEN_LENGTH);
}

/** 按账号稳定派生主机名（形如 DESKTOP-1A2B3C4；hub _machine_hostname）。 */
export function deriveMachineHostname(uid: string): string {
	const h = createHash("md5").update(`hostname:${uid || "anonymous"}`, "utf8").digest("hex");
	return `DESKTOP-${h.slice(0, HOSTNAME_SUFFIX_HEX).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// COSY 会话
// ---------------------------------------------------------------------------

/** COSY 身份体 9 键（hub CosySession.__init__ identity 字典——「唯一真源」，
 * 增删键必须与服务端预期同步）。 */
export type CosyIdentity = {
	name: string;
	aid: string;
	uid: string;
	yx_uid: string;
	organization_id: string;
	organization_name: string;
	user_type: string;
	security_oauth_token: string;
	refresh_token: string;
};

/** gateway 域缺省用户类型（hub DEFAULT_USER_TYPE；identity 缺省填充值）。 */
export const DEFAULT_USER_TYPE = "personal_professional_trial";

/** 签名摘要（hub CosySession.bearer 的 MD5 拼接序）：五段按 payloadB64/cosyKey/
 * date/body/path 以 "\n" 连接后取 MD5 hex。服务端按同序拼接校验——顺序即协议，
 * 独立导出供 fixture 对照测试（同输入期望值由 Python 参考实现生成）。 */
export function signatureDigest(parts: { payloadB64: string; cosyKey: string; date: string; body: string; path: string }): string {
	const raw = [parts.payloadB64, parts.cosyKey, parts.date, parts.body, parts.path].join("\n");
	return createHash("md5").update(raw, "utf8").digest("hex");
}

/** 单账号 COSY 签名会话（hub CosySession）：machine 系列按 uid 稳定派生；
 * tempKey/cosyKey/info 在会话创建时生成。access token 轮换后必须整体重建
 * （旧 info 内嵌旧 token，服务端校验不再通过）。 */
export class CosySession {
	readonly uid: string;
	readonly machineId: string;
	readonly machineToken: string;
	readonly machineType: string;
	readonly machineHostname: string;
	readonly tempKey: string;
	readonly cosyKey: string;
	readonly info: string;

	private constructor(identity: CosyIdentity) {
		this.uid = identity.uid;
		this.machineId = deriveId(identity.uid, "machine");
		this.machineToken = deriveMachineToken(identity.uid);
		this.machineType = deriveMachineType(identity.uid);
		this.machineHostname = deriveMachineHostname(identity.uid);
		// 会话密钥：16 个 hex 字符（hub uuid4().hex[:16] 同形——字节序列必须与
		// 服务端 RSA 解包后的 AES key/iv 逐字节一致，长度或编码一变请求整体失败）。
		this.tempKey = randomBytes(COSY_TEMP_KEY_BYTES).toString("hex");
		const tempKeyBytes = new Uint8Array(Buffer.from(this.tempKey, "utf8"));
		this.cosyKey = Buffer.from(rsaWrapSessionKey(tempKeyBytes)).toString("base64");
		this.info = Buffer.from(aesCbcEncrypt(jsonSortedCompact({ ...identity }), tempKeyBytes, tempKeyBytes)).toString("base64");
	}

	/** 构造会话（空 uid 拒绝——无身份体的签名必然被服务端拒绝，fail-fast）。 */
	static create(identity: CosyIdentity): CosySession {
		if (identity.uid.trim().length === 0) {
			throw new Error("cosy: empty uid; login first (extract IDE credentials or provide a PAT)");
		}
		return new CosySession(identity);
	}

	/** 签名三件套（hub CosySession.bearer）：payloadB64 + date + Authorization 值。
	 * 签名覆盖 body 与去 /algo 前缀、去查询串的 path（服务端按同序拼接 MD5）。 */
	sign(body: string, rawUrl: string): { payloadB64: string; date: string; authorization: string } {
		// "://" 分隔符长度（定位 URL path 起点的偏移）。
		const SCHEME_SEPARATOR_LENGTH = 3;
		const pathStart = rawUrl.indexOf("/", rawUrl.indexOf("://") + SCHEME_SEPARATOR_LENGTH);
		let path = pathStart === -1 ? "/" : rawUrl.slice(pathStart);
		const queryStart = path.indexOf("?");
		if (queryStart !== -1) {
			path = path.slice(0, queryStart);
		}
		// /algo 是网关路由前缀，不参与签名（hub bearer 同剥离）。
		const ALGO_PREFIX = "/algo";
		if (path.startsWith(ALGO_PREFIX)) {
			path = path.slice(ALGO_PREFIX.length);
		}
		const payloadB64 = Buffer.from(
			jsonSortedCompact({
				cosyVersion: COSY_VERSION,
				ideVersion: "",
				info: this.info,
				requestId: randomUUID(),
				version: "v1",
			}),
		).toString("base64");
		const date = String(Math.floor(Date.now() / MS_PER_SECOND));
		const sig = signatureDigest({ payloadB64, cosyKey: this.cosyKey, date, body, path });
		return { payloadB64, date, authorization: `Bearer COSY.${payloadB64}.${sig}` };
	}

	/** 一次推理/模型请求的完整 COSY 头族（hub CosySession.headers，对齐 qodercli 1.1.75）。
	 * 头表为服务端指纹校验面：缺头/多头都会被识别为非官方客户端，禁止删改。 */
	headers(body: string, rawUrl: string, modelKey: string, sse: boolean): Record<string, string> {
		const { date, authorization } = this.sign(body, rawUrl);
		const h: Record<string, string> = {
			"cosy-data-policy": "agree",
			"content-type": "application/json",
			"cosy-business-product": "cli",
			"cosy-business-type": "agent",
			"cosy-scene": "assistant",
			"cosy-clienttype": "5",
			"cosy-date": date,
			"cosy-user": this.uid,
			"cosy-key": this.cosyKey,
			accept: sse ? "text/event-stream" : "application/json",
			authorization,
			"accept-encoding": "identity",
			"cosy-version": COSY_VERSION,
			"cosy-machineid": this.machineId,
			"cosy-machinetoken": this.machineToken,
			"cosy-machinetype": this.machineType,
			"cosy-clientip": "169.254.198.161",
			"login-version": "v2",
			"user-agent": COSY_USER_AGENT,
			// issue #64：官方请求层对所有请求注入 Cosy-MachineOS；hostname 只在
			// infer-sse（流式）场景带。取值保持 hub 缺省口径（非 win 平台恒
			// x86_64_linux）：存量账号设备指纹不漂移，避免升级即「换设备」。
			"cosy-machineos": "x86_64_linux",
		};
		if (sse) {
			h["cosy-machinehostname"] = this.machineHostname;
			h["cache-control"] = "no-cache";
		}
		if (modelKey.length > 0) {
			h["x-model-key"] = modelKey;
			h["x-model-source"] = "system";
		}
		return h;
	}
}
