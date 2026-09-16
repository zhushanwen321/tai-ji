// src/__tests__/answer-codec.test.ts
// encodeAnswer 单向序列化 round-trip 测试（TC-09）。
// 反向验证用 @zhushanwen/extension-protocol 的解码 helper（getAskUserAnswer / getAskUserOther）
// ——该 helper 是 proto answers 格式的唯一解码 SSOT，encode 输出必须与其字节级对齐。
// m1 增量（TC-01）：property-based describe 作为 5 个确定性用例的随机化超集补充。
import { getAskUserAnswer, getAskUserOther } from "@zhushanwen/extension-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { encodeAnswer } from "../answer-codec";

describe("encodeAnswer", () => {
	it("single-select: 主 key 写选中 label，other=null 不写 __other；getAskUserAnswer 解码得 string", () => {
		const answers = encodeAnswer({ selected: ["A"], other: null }, { key: "db", multiSelect: false });
		expect(answers).toEqual({ db: "A" });
		expect(getAskUserAnswer(answers, { question: "db", options: [{ label: "A" }] })).toBe("A");
	});

	it("multi-select: 主 key 写 JSON.stringify(selected)；getAskUserAnswer 解码得 string[]", () => {
		const answers = encodeAnswer({ selected: ["A", "B"], other: null }, { key: "lang", multiSelect: true });
		expect(answers).toEqual({ lang: '["A","B"]' });
		expect(getAskUserAnswer(answers, { question: "lang", multiSelect: true })).toEqual(["A", "B"]);
	});

	it("selected 空 + other 有值: 只写 ${key}__other 不写主 key；getAskUserOther 解码得文本", () => {
		const answers = encodeAnswer({ selected: [], other: "foo" }, { key: "db", multiSelect: false });
		expect(answers).toEqual({ db__other: "foo" });
		expect(getAskUserOther(answers, { question: "db" })).toBe("foo");
	});

	it("selected 空 + other null/空串: 返回 {}（未答，调用方不写入）", () => {
		expect(encodeAnswer({ selected: [], other: null }, { key: "db", multiSelect: false })).toEqual({});
		expect(encodeAnswer({ selected: [], other: "" }, { key: "db", multiSelect: true })).toEqual({});
	});

	it("selected 与 other 同时有值: 主 key + __other 都写；两个 helper 各自解码", () => {
		const answers = encodeAnswer(
			{ selected: ["A"], other: "custom" },
			{ key: "db", multiSelect: false },
		);
		expect(answers).toEqual({ db: "A", db__other: "custom" });
		expect(getAskUserAnswer(answers, { question: "db", options: [{ label: "A" }] })).toBe("A");
		expect(getAskUserOther(answers, { question: "db" })).toBe("custom");
	});
});

// ── m1 property-based round-trip（TC-01）─────────────────
// fast-check 随机生成合法 AnswerValue 组合 → encodeAnswer → 用协议解码 helper 反向验证
// 信息保持。六分支断言对应 encodeAnswer 序列化契约（C1）与解码契约（C2）：
//   (1) selected 非空 + multiSelect → 解码 deepEqual selected
//   (2) selected 非空 + 单选 → 解码 === selected[0]
//   (3) selected 空 → 主 key 不存在
//   (4) other 非 null 非空串 → getAskUserOther 精确还原；否则 undefined
//   (5) selected 空 + other null/空串 → 返回 {}（未答，调用方不写入）
//   (6) 输出对象无多余键（主 key + __other 至多 2 个）
// key 生成器过滤 Object.prototype 属性名（toString/constructor/__proto__ 等）：
// 这些名字读 answers[key] 会落到原型链（拿到 Function/原型对象而非 undefined），
// 是 plain-object answers 的既有协议局限（编码侧赋值本身安全），m1 只测不改 src/。
describe("encodeAnswer — property-based round-trip", () => {
	it("任意 AnswerValue 组合序列化后经解码 helper 不丢信息", () => {
		fc.assert(
			fc.property(
				fc.string().filter((k) => Object.prototype[k] === undefined),
				fc.boolean(),
				fc.array(fc.string(), { maxLength: 5 }),
				fc.option(fc.string(), { nil: null }),
				(key, multiSelect, selected, other) => {
					const answers = encodeAnswer({ selected, other }, { key, multiSelect });

					// (6) 输出对象无多余键
					expect(Object.keys(answers).length).toBeLessThanOrEqual(2);

					if (selected.length > 0) {
						// (1)(2) 主 key 写入：多选 JSON.stringify(selected) / 单选 selected[0]
						const decoded = getAskUserAnswer(answers, { question: key, multiSelect });
						if (multiSelect) {
							expect(decoded).toEqual(selected);
						} else {
							expect(decoded).toBe(selected[0]);
						}
					} else {
						// (3) selected 空 → 主 key 不产生
						expect(answers[key]).toBeUndefined();
						expect(getAskUserAnswer(answers, { question: key, multiSelect })).toBeUndefined();
					}

					// (4) other：非 null 非空串才写 __other，解码精确还原
					if (other !== null && other !== "") {
						expect(getAskUserOther(answers, { question: key })).toBe(other);
					} else {
						expect(getAskUserOther(answers, { question: key })).toBeUndefined();
					}

					// (5) 全空 → 返回 {}（未答，调用方不写入）
					if (selected.length === 0 && (other === null || other === "")) {
						expect(answers).toEqual({});
					}
				},
			),
		);
	});
});
