// encode.ts — Qoder 自定义 Base64 变体 + 签名用紧凑 JSON。
//
// 翻译自开源参考实现（shuishuipingan/qoder2api-hub v1.6.4 qoder_sign.py）：
//   std = standard_base64(plain)
//   a   = len(std) // 3
//   rearranged = std[n-a:] + std[a:n-a] + std[:a]   （尾/中/首 三段轮转）
//   逐字符按自定义字母表映射，'=' -> '$'
// 出站请求体与 model/list 签名 body 都必须是该形态（服务端逐字节校验）。

import { QODER_CUSTOM_ALPHABET, QODER_PAD } from "./constants.ts";

const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** 字母表长度（标准 base64 64 字符；自定义表同长一一映射）。 */
const ALPHABET_LENGTH = 64;
/** 三段轮转的段数（std 全长按 3 等分轮转——协议固定值，非可调参数）。 */
const ROTATION_SEGMENTS = 3;

const stdToCustom = new Map<string, string>();
const customToStd = new Map<string, string>();
for (let i = 0; i < ALPHABET_LENGTH; i++) {
	stdToCustom.set(STD_ALPHABET[i]!, QODER_CUSTOM_ALPHABET[i]!);
	customToStd.set(QODER_CUSTOM_ALPHABET[i]!, STD_ALPHABET[i]!);
}
stdToCustom.set("=", QODER_PAD);
customToStd.set(QODER_PAD, "=");

function remap(input: string, table: Map<string, string>): string {
	let out = "";
	for (const ch of input) {
		const mapped = table.get(ch);
		if (mapped === undefined) {
			throw new Error(`qoder encode: character ${JSON.stringify(ch)} is not in the mapping table`);
		}
		out += mapped;
	}
	return out;
}

/** 把明文编码成 Qoder 自定义 Base64 变体（出站请求体格式）。 */
export function qoderEncode(plain: Uint8Array): string {
	const std = Buffer.from(plain).toString("base64");
	const n = std.length;
	const a = Math.floor(n / ROTATION_SEGMENTS);
	// 三段轮转：尾(a) + 中(n-2a) + 首(a)——与 Python 切片 std[n-a:]+std[a:n-a]+std[:a] 同序。
	const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
	return remap(rearranged, stdToCustom);
}

/** qoderEncode 的逆运算（响应/调试/测试用）。
 * 正向 R = S[n-a:] + S[a:n-a] + S[:a]；逆向 S = R3 + R2 + R1。 */
export function qoderDecode(encoded: string): Uint8Array {
	const std = remap(encoded, customToStd);
	const n = std.length;
	const a = Math.floor(n / ROTATION_SEGMENTS);
	const r1 = std.slice(0, a);
	const r2 = std.slice(a, n - a);
	const r3 = std.slice(n - a);
	return new Uint8Array(Buffer.from(r3 + r2 + r1, "base64"));
}

/** JSON 值 → 签名/加密用的紧凑序列化形态。与 Python json.dumps(ensure_ascii=False)
 * 对齐：非 ASCII 字符原样输出 UTF-8（不转 \uXXXX），这决定 MD5/AES 的字节序列。 */
function jsonScalar(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (typeof value === "number") {
		return Number.isInteger(value) ? String(value) : String(value);
	}
	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}
	return JSON.stringify(value);
}

/** 键排序 + 无空白的紧凑 JSON（服务端签名字节与此强绑定，hub qoder_sign.py
 * json_sorted_compact）。None 值序列化为空串（Python 实装 `mapping[k] if not None
 * else ""` 的同构行为——identity/payload 里不允许出现 null 字面）。 */
export function jsonSortedCompact(mapping: Record<string, unknown>): Uint8Array {
	const parts: string[] = [];
	for (const key of Object.keys(mapping).sort()) {
		const value = mapping[key];
		parts.push(`${JSON.stringify(key)}:${jsonScalar(value === null || value === undefined ? "" : value)}`);
	}
	return new Uint8Array(Buffer.from(`{${parts.join(",")}}`, "utf8"));
}

/** 便捷形态：对象 → 紧凑 JSON 文本（请求体序列化用；保序不排序——请求体
 * 字段顺序服务端不校验，保持插入序可读性更好）。 */
export function compactJson(value: unknown): string {
	return JSON.stringify(value);
}
