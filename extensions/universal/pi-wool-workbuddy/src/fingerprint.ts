// fingerprint.ts — 会话头族 ID 生成与按账号派生的设备指纹。
//
// 形态按官方客户端 5.8.4 抓包对齐（hub wb_identity.py / wb_fingerprint.py 实读）：
// - X-Conversation-ID：带连字符 UUID（官方同会话复用同一 id；按 uid+会话键稳定派生）
// - X-Request-ID / X-Conversation-Message-ID：32 位无连字符 hex（每请求新生成）
// - X-Conversation-Request-ID = X-Root-Request-ID：一轮 user send 生成一次、整轮复用
// - X-Machine-ID / X-Session-ID（billing 头族用）：按账号 uid 稳定派生的带连字符 UUID
//   （进程级共享值会把多账号关联到同一台设备——风控关联键）
// - 链路头族：X-Trace-ID / traceparent / b3 / X-B3-*（桌面端无父 span，b3 三段）

import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// UUID 位布局常量（RFC 9562 UUIDv7 / v4 形状；上游不校验版本位——抓包 v4/v7 均被
// 接受，形态贴近即可）。
// ---------------------------------------------------------------------------
const UUIDV7_TIMESTAMP_BITS = 48n;
const BIGINT_ONE = 1n;
const TIMESTAMP_MASK = (BIGINT_ONE << UUIDV7_TIMESTAMP_BITS) - BIGINT_ONE;
const RAND_A_MASK = 0xfffn;
const RAND_B_MASK = 0x3fff_ffff_ffff_ffffn;
const VERSION_SHIFT = 76n;
const VERSION_NIBBLE = 0x7n;
const RAND_A_SHIFT = 64n;
const VARIANT_SHIFT = 62n;
const VARIANT_BITS = 0b10n;
const TIMESTAMP_SHIFT = 80n;
const HEX_RADIX = 16;
const UUID_HEX_LENGTH = 32;
/** 链路头族 span id 与 randB 种子的字节宽。 */
const SPAN_ID_BYTES = 8;
const RAND_A_SEED_BYTES = 2;
/** 连字符 UUID 的分段边界（8-4-4-4-12 → 各段结束下标）。 */
const SEG1_END = 8;
const SEG2_END = 12;
const SEG3_END = 16;
const SEG4_END = 20;
/** 摘要 hex 派生 UUIDv4 形状的版本位/变体位下标。 */
const VERSION_NIBBLE_INDEX = 12;
const AFTER_VERSION_INDEX = 13;
const VARIANT_NIBBLE_INDEX = 16;
const AFTER_VARIANT_INDEX = 17;

function formatUuidHex(hex: string): string {
	return `${hex.slice(0, SEG1_END)}-${hex.slice(SEG1_END, SEG2_END)}-${hex.slice(SEG2_END, SEG3_END)}-${hex.slice(SEG3_END, SEG4_END)}-${hex.slice(SEG4_END, UUID_HEX_LENGTH)}`;
}

/** RFC 9562 UUIDv7（时间戳打头）。 */
export function uuid7(): string {
	const ms = BigInt(Date.now()) & TIMESTAMP_MASK;
	// rand_a 12 位、rand_b 62 位（位宽按 RFC 9562；rand_b 掩码防越位覆盖版本/变体位）
	const randA = BigInt(`0x${randomBytes(RAND_A_SEED_BYTES).toString("hex")}`) & RAND_A_MASK;
	const randB = BigInt(`0x${randomBytes(SPAN_ID_BYTES).toString("hex")}`) & RAND_B_MASK;
	const value =
		(ms << TIMESTAMP_SHIFT) |
		(VERSION_NIBBLE << VERSION_SHIFT) |
		(randA << RAND_A_SHIFT) |
		(VARIANT_BITS << VARIANT_SHIFT) |
		randB;
	return formatUuidHex(value.toString(HEX_RADIX).padStart(UUID_HEX_LENGTH, "0"));
}

/** X-Request-ID 形态：32 位无连字符 hex（每请求新生成）。 */
export function newRequestId(): string {
	return uuid7().replace(/-/g, "");
}

/** 版本位/变体位固定成 UUIDv4 形状（真实客户端 machineId 的形态）。 */
function uuidShapedHex(hex32: string): string {
	const shaped =
		hex32.slice(0, VERSION_NIBBLE_INDEX) +
		"4" +
		hex32.slice(AFTER_VERSION_INDEX, VARIANT_NIBBLE_INDEX) +
		"a" +
		hex32.slice(AFTER_VARIANT_INDEX);
	return formatUuidHex(shaped);
}

/**
 * 由 uid + salt 稳定派生带连字符的 UUID 形状设备标识（hub wb_fingerprint.derive_id
 * 的 md5 单向派生：同一账号恒定、账号间互不相同——等价「每账号一台设备」）。
 */
export function deriveDeviceId(uid: string, salt: string): string {
	return uuidShapedHex(createHash("md5").update(`${salt}:${uid || "anonymous"}`).digest("hex"));
}

/** billing 头族 X-Machine-ID：按账号派生。 */
export function machineIdFor(uid: string): string {
	return deriveDeviceId(uid, "machine");
}

/** billing 头族 X-Session-ID：按账号派生。 */
export function sessionIdFor(uid: string): string {
	return deriveDeviceId(uid, "session");
}

/**
 * X-Conversation-ID：按「账号 + 会话键」稳定派生（官方同一会话复用同一 id；
 * 每请求现生成会把一次多轮对话拆成多个一次性会话——非人类画像）。
 * sha256 派生（hub conversation_id_for 同构）。
 */
export function conversationIdFor(uid: string, sessionKey: string): string {
	return uuidShapedHex(createHash("sha256").update(`${uid || ""}|${sessionKey}`).digest("hex"));
}

/** 对话请求链路头族（桌面端形态：无父 span，b3 三段）。 */
export function traceHeaders(): Record<string, string> {
	const trace = newRequestId();
	const span = randomBytes(SPAN_ID_BYTES).toString("hex");
	return {
		"X-Trace-ID": trace,
		traceparent: `00-${trace}-${span}-01`,
		b3: `${trace}-${span}-1`,
		"X-B3-TraceId": trace,
		"X-B3-SpanId": span,
		"X-B3-Sampled": "1",
	};
}
