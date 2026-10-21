// crypto-family.test.ts — 签名/加密族 fixture 对照测试（验收条款②）。
//
// 期望值全部由 Python 参考实现（shuishuipingan/qoder2api-hub v1.6.4 的
// qoder_sign.py / qoder_fingerprint.py）对同一固定输入生成（gen-fixtures.py，
// 产物已脱敏入库 fixtures/wool-qoder-crypto.json）——TS 实装与参考实现逐字节对齐
// 即通过；这是「翻译保真度」的机器证据（不依赖真实凭据/真实上游）。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { aesCbcEncrypt, CosySession, deriveId, deriveMachineHostname, deriveMachineToken, deriveMachineType, signatureDigest, type CosyIdentity } from "../cosy.ts";
import { jsonSortedCompact, qoderDecode, qoderEncode } from "../encode.ts";
import { COSY_VERSION, QODER_CUSTOM_ALPHABET, QODER_PAD, SNAPSHOT_FALLBACK_MODELS } from "../constants.ts";

interface CryptoFixture { // oe-exempt:20261022:test:加密族一致性测试的 fixture JSON 形状——仅本文件消费（无 src 消费），字段随用例演进
	qoderEncode: { plainUtf8: string; expected: string; roundtrip: string };
	jsonSortedCompact: { input: Record<string, unknown>; expectedUtf8: string };
	infoAes: { tempKey: string; plainUtf8: string; expectedB64: string };
	signature: { payloadB64: string; cosyKey: string; date: string; body: string; path: string; rawToMd5: string; expectedMd5: string };
	fingerprint: { uid: string; machineId: string; sessionId: string; machineType: string; machineToken: string };
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

/** fixture 的 identity dict（与 gen-fixtures.py FIXED_IDENTITY 逐键一致）。 */
const FIXTURE_IDENTITY: CosyIdentity = {
	name: "fixture-user",
	aid: "fixture-uid-0001",
	uid: "fixture-uid-0001",
	yx_uid: "",
	organization_id: "",
	organization_name: "",
	user_type: "personal_professional_trial",
	security_oauth_token: "dt-fixture-access-token",
	refresh_token: "drt-fixture-refresh-token",
};

describe("qoder 自定义 base64 变体（对照 qoder_sign.py qoder_encode）", () => {
	it("编码与参考实现逐字符一致", () => {
		const encoded = qoderEncode(new Uint8Array(Buffer.from(fixture.qoderEncode.plainUtf8, "utf8")));
		expect(encoded).toBe(fixture.qoderEncode.expected);
	});

	it("解码 roundtrip 还原标准 base64", () => {
		const plain = qoderDecode(fixture.qoderEncode.expected);
		expect(Buffer.from(plain).toString("base64")).toBe(fixture.qoderEncode.roundtrip);
	});

	it("字母表 64 字符 + '$' 填充（服务端逐字符映射的形态前提）", () => {
		expect(QODER_CUSTOM_ALPHABET.length).toBe(64);
		expect(new Set(QODER_CUSTOM_ALPHABET).size).toBe(64);
		expect(QODER_PAD).toBe("$");
	});

	it("未知字符拒绝（映射表外的输入显式报错，不静默产出）", () => {
		expect(() => qoderDecode("contains+slash/and=pad")).toThrow(/not in the mapping table/);
	});
});

describe("键排序紧凑 JSON（对照 qoder_sign.py json_sorted_compact）", () => {
	it("键序 + None→空串 + 非 ASCII 不转义", () => {
		const bytes = jsonSortedCompact(fixture.jsonSortedCompact.input);
		expect(Buffer.from(bytes).toString("utf8")).toBe(fixture.jsonSortedCompact.expectedUtf8);
	});

	it("非 ASCII 字符原样输出（ensure_ascii=False 对齐——决定 MD5/AES 字节序列）", () => {
		const bytes = jsonSortedCompact({ 名称: "羊毛", n: 1 });
		expect(Buffer.from(bytes).toString("utf8")).toBe('{"n":1,"名称":"羊毛"}');
	});
});

describe("AES-128-CBC 身份体加密（对照 aes_cbc_encrypt）", () => {
	it("identity 9 键紧凑 JSON 加密与参考实现逐字节一致", () => {
		const tempKeyBytes = new Uint8Array(Buffer.from(fixture.infoAes.tempKey, "utf8"));
		const cipher = aesCbcEncrypt(jsonSortedCompact({ ...FIXTURE_IDENTITY }), tempKeyBytes, tempKeyBytes);
		expect(Buffer.from(cipher).toString("base64")).toBe(fixture.infoAes.expectedB64);
	});

	it("明文形态与 fixture 一致（加密输入的排序/空串形态锁定）", () => {
		expect(Buffer.from(jsonSortedCompact({ ...FIXTURE_IDENTITY })).toString("utf8")).toBe(fixture.infoAes.plainUtf8);
	});

	it("key/iv 长度校验 fail-fast", () => {
		expect(() => aesCbcEncrypt(new Uint8Array(0), new Uint8Array(8), new Uint8Array(16))).toThrow(/16 bytes/);
	});
});

describe("COSY 签名摘要（对照 CosySession.bearer 拼接序）", () => {
	it("五段 \\n 拼接 MD5 与参考实现一致", () => {
		const { payloadB64, cosyKey, date, body, path, rawToMd5, expectedMd5 } = fixture.signature;
		const digest = signatureDigest({ payloadB64, cosyKey, date, body, path });
		expect(digest).toBe(expectedMd5);
		// fixture 的 rawToMd5 是 Python 侧的拼接串——锁住「顺序即协议」。
		expect([payloadB64, cosyKey, date, body, path].join("\n")).toBe(rawToMd5);
	});

	it("CosySession.headers 产出 Bearer COSY 授权头族（结构形态）", () => {
		const session = CosySession.create(FIXTURE_IDENTITY);
		const headers = session.headers("encoded-body", "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=x", "qfmodel", true);
		expect(headers.authorization).toMatch(/^Bearer COSY\.[A-Za-z0-9+/=]+\.[a-f0-9]{32}$/);
		expect(headers["cosy-user"]).toBe("fixture-uid-0001");
		expect(headers["cosy-version"]).toBe(COSY_VERSION);
		expect(headers["cosy-key"]).toBe(session.cosyKey);
		expect(headers["x-model-key"]).toBe("qfmodel");
		expect(headers["cosy-machinehostname"]).toBeDefined();
		// 签名 path 去 /algo 前缀、去查询串——与 fixture.path 同形态。
		const sign = session.sign("body", "https://gateway.qoder.com.cn/algo/x?y=1");
		expect(sign).toBeDefined();
	});

	it("空 uid 拒绝构造（无身份体的签名必被服务端拒）", () => {
		expect(() => CosySession.create({ ...FIXTURE_IDENTITY, uid: " " })).toThrow(/empty uid/);
	});
});

describe("设备指纹派生（对照 qoder_fingerprint.py）", () => {
	it("machineId / sessionId / machineType / machineToken 四项与参考实现一致", () => {
		const { uid, machineId, sessionId, machineType, machineToken } = fixture.fingerprint;
		expect(deriveId(uid, "machine")).toBe(machineId);
		expect(deriveId(uid, "session")).toBe(sessionId);
		expect(deriveMachineType(uid)).toBe(machineType);
		expect(deriveMachineToken(uid)).toBe(machineToken);
	});

	it("同 uid 派生稳定（防随机机器码触发上游风控的前提）", () => {
		expect(deriveId("fixture-uid-0001", "machine")).toBe(deriveId("fixture-uid-0001", "machine"));
		expect(deriveMachineHostname("fixture-uid-0001")).toMatch(/^DESKTOP-[0-9A-F]{7}$/);
	});
});

describe("包内快照词表一致性", () => {
	it("SNAPSHOT_FALLBACK_MODELS 与快照文件模型 id 集一致（双登记不漂移）", async () => {
		const snapshot = JSON.parse(
			readFileSync(join(import.meta.dirname, "..", "..", "snapshots", "qoder.json"), "utf8"),
		) as { models: { id: string }[] };
		const snapshotIds = snapshot.models.map((model) => model.id).sort();
		const constantIds = SNAPSHOT_FALLBACK_MODELS.map((model) => model.id).sort();
		expect(snapshotIds).toEqual(constantIds);
	});
});
