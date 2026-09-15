// 测试框架：vitest
// 运行命令：npx vitest run src/__tests__/fingerprint.test.ts
//
// 指纹纯函数层测试（经公有面 hashOf / buildProbeEntry / extractSystem / sentToolsOf）：
// hash 稳定性（key 序 / undefined→null / 数组有序）、hash 为 16 hex、
// buildProbeEntry 的 baseline-全量、normal-增量、无变化-null。

import { describe, expect, it } from "vitest";

import {
	buildProbeEntry,
	extractSystem,
	hashOf,
	sentToolsOf,
	type Fingerprints,
} from "../fingerprint";

// hash 为 16 hex 是 entry schema v2 的契约（fingerprint.ts 头注释），硬编码断言
const HASH_HEX_LEN = 16;

const fp = (over: Partial<Fingerprints> = {}): Fingerprints => ({
	spFull: "a".repeat(HASH_HEX_LEN),
	toolsSent: "b".repeat(HASH_HEX_LEN),
	contextFiles: "c".repeat(HASH_HEX_LEN),
	skills: "d".repeat(HASH_HEX_LEN),
	toolsList: "e".repeat(HASH_HEX_LEN),
	toolsReg: "f".repeat(HASH_HEX_LEN),
	append: "0".repeat(HASH_HEX_LEN),
	guidelines: "1".repeat(HASH_HEX_LEN),
	customPrompt: "2".repeat(HASH_HEX_LEN),
	...over,
});

describe("hashOf（stable stringify 语义经公有面断言）", () => {
	it("hash 为 16 hex 字符且同输入同输出", () => {
		const h = hashOf({ a: 1 });
		expect(h).toMatch(new RegExp(`^[0-9a-f]{${HASH_HEX_LEN}}$`));
		expect(hashOf({ a: 1 })).toBe(h);
		expect(hashOf({ b: 1 })).not.toBe(h);
	});

	it("key 顺序不影响 hash（防假变化的核心保证，嵌套对象同）", () => {
		expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
		expect(hashOf({ a: 1, b: { d: 4, c: 3 } })).toBe(hashOf({ b: { c: 3, d: 4 }, a: 1 }));
	});

	it("undefined 归一为 null（与显式 null 同 hash）", () => {
		expect(hashOf(undefined)).toBe(hashOf(null));
		expect(hashOf({ x: undefined })).toBe(hashOf({ x: null }));
	});

	it("数组保序、原始值类型不混淆", () => {
		expect(hashOf([2, 1])).not.toBe(hashOf([1, 2]));
		expect(hashOf("3")).not.toBe(hashOf(3));
	});
});

describe("extractSystem（payload 四口径）", () => {
	it("OpenAI 兼容：messages 内 role=system", () => {
		expect(extractSystem({ messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] })).toEqual([
			{ role: "system", content: "s" },
		]);
	});

	it("OpenAI 兼容：role=developer（pi useDeveloperRole 分支，实测命中）", () => {
		expect(extractSystem({ messages: [{ role: "developer", content: "s" }] })).toEqual([
			{ role: "developer", content: "s" },
		]);
	});

	it("Anthropic：顶层 system 数组", () => {
		expect(extractSystem({ system: [{ type: "text", text: "s" }], messages: [] })).toEqual([
			{ type: "text", text: "s" },
		]);
	});

	it("伪造对象形态：顶层 systemInstruction（实装恒传 string，仅测试构造可达）", () => {
		expect(extractSystem({ systemInstruction: { role: "system", parts: [] } })).toEqual({
			role: "system",
			parts: [],
		});
	});

	it("无 system 内容返回 null", () => {
		expect(extractSystem({ messages: [{ role: "user", content: "u" }] })).toBeNull();
		expect(extractSystem(null)).toBeNull();
		expect(extractSystem("str")).toBeNull();
	});
});

describe("sentToolsOf", () => {
	it("有 tools 返回数组，缺失返回 null", () => {
		expect(sentToolsOf({ tools: [{ name: "read" }] })).toEqual([{ name: "read" }]);
		expect(sentToolsOf({})).toBeNull();
		expect(sentToolsOf(null)).toBeNull();
	});
});

describe("buildProbeEntry（diff 语义经 changed 数组断言）", () => {
	it("diff 只报变化项（changed 数组 + 增量 h）", () => {
		const e = buildProbeEntry(
			fp({ contextFiles: "x".repeat(HASH_HEX_LEN), skills: "y".repeat(HASH_HEX_LEN) }),
			fp(),
			{ seq: 3, needsBaseline: false, startReason: null, cwd: "/w" },
		);
		expect(e?.changed).toEqual(["contextFiles", "skills"]);
		expect(e?.h).toEqual({
			contextFiles: "x".repeat(HASH_HEX_LEN),
			skills: "y".repeat(HASH_HEX_LEN),
		});
	});

	it("baseline：全量 hash + changed ['*'] + cwd + startReason", () => {
		const cur = fp();
		const e = buildProbeEntry(cur, null, { seq: 1, needsBaseline: true, startReason: "startup", cwd: "/w" });
		expect(e).toEqual({
			v: 2,
			seq: 1,
			baseline: true,
			startReason: "startup",
			cwd: "/w",
			changed: ["*"],
			h: cur,
		});
	});

	it("normal：只存变化项（增量），不带 cwd", () => {
		const last = fp();
		const cur = fp({ contextFiles: "x".repeat(HASH_HEX_LEN) });
		const e = buildProbeEntry(cur, last, { seq: 3, needsBaseline: false, startReason: null, cwd: "/w" });
		expect(e).toEqual({
			v: 2,
			seq: 3,
			changed: ["contextFiles"],
			h: { contextFiles: "x".repeat(HASH_HEX_LEN) },
		});
	});

	it("无变化返回 null（不写 entry）", () => {
		expect(buildProbeEntry(fp(), fp(), { seq: 2, needsBaseline: false, startReason: null, cwd: "/w" })).toBeNull();
	});
});
