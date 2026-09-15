/**
 * JT 系列：json-parser.ts 单元测试（三层容错）。
 *
 * 覆盖：
 *  - 正常 JSON 提取与字段验证
 *  - 三层容错：正则提取 / JSON.parse / 字段验证 各层失败路径
 *  - G5 多 JSON 对象 limitation
 *  - fail-closed fallback
 */
import { describe, expect, it } from "vitest";

import { PARSE_FALLBACK_RESULT, parseClassifierResponse } from "../json-parser.js";

describe("JT1: 正常 JSON（裸 JSON）", () => {
	it("裸 JSON 对象 → 解析成功", () => {
		const r = parseClassifierResponse('{"outcome":"allow","risk_level":"low","reasoning":"safe","confidence":0.9}');
		expect(r).toEqual({ outcome: "allow", risk_level: "low", reasoning: "safe", confidence: 0.9 });
	});

	it("JSON 含大写枚举 → 小写归一", () => {
		const r = parseClassifierResponse('{"outcome":"DENY","risk_level":"HIGH","reasoning":"x","confidence":0.8}');
		expect(r.outcome).toBe("deny");
		expect(r.risk_level).toBe("high");
	});
});

describe("JT2: 第一层 — 正则提取（前后有 prose / code fence）", () => {
	it("markdown code fence 包裹的 JSON → 提取成功", () => {
		const text = 'Here is the result:\n```json\n{"outcome":"ask","risk_level":"medium","reasoning":"maybe","confidence":0.5}\n```\n';
		const r = parseClassifierResponse(text);
		expect(r.outcome).toBe("ask");
		expect(r.risk_level).toBe("medium");
		expect(r.confidence).toBeCloseTo(0.5);
	});

	it("JSON 后有尾部 prose → 贪婪匹配到最后的 }", () => {
		const text = '{"outcome":"allow","risk_level":"low","reasoning":"ok","confidence":1.0} That looks safe.';
		const r = parseClassifierResponse(text);
		expect(r.outcome).toBe("allow");
	});

	it("无 { } → fallback", () => {
		expect(parseClassifierResponse("no json here at all")).toEqual(PARSE_FALLBACK_RESULT);
	});
});

describe("JT3: 第二层 — JSON.parse 失败", () => {
	it("提取到非法 JSON（缺引号）→ fallback", () => {
		expect(parseClassifierResponse('{outcome:"allow"}')).toEqual(PARSE_FALLBACK_RESULT);
	});

	it("G5 多 JSON 对象（贪婪吞掉中间）→ fallback", () => {
		// 两个独立对象：贪婪正则匹配成 '{...}{...}'，JSON.parse 失败
		const text = '{"outcome":"allow","risk_level":"low","reasoning":"a","confidence":0.1} {"outcome":"deny","risk_level":"high","reasoning":"b","confidence":0.9}';
		expect(parseClassifierResponse(text)).toEqual(PARSE_FALLBACK_RESULT);
	});
});

describe("JT4: 第三层 — 字段验证失败 → fallback", () => {
	it("outcome 非法值 → fallback", () => {
		const r = parseClassifierResponse('{"outcome":"maybe","risk_level":"low","reasoning":"x","confidence":0.5}');
		expect(r).toEqual(PARSE_FALLBACK_RESULT);
	});

	it("risk_level 非法值 → fallback", () => {
		const r = parseClassifierResponse('{"outcome":"allow","risk_level":"critical","reasoning":"x","confidence":0.5}');
		expect(r).toEqual(PARSE_FALLBACK_RESULT);
	});

	it("confidence 非数字 → fallback", () => {
		const r = parseClassifierResponse('{"outcome":"allow","risk_level":"low","reasoning":"x","confidence":"high"}');
		expect(r).toEqual(PARSE_FALLBACK_RESULT);
	});
});

describe("JT5: confidence 归一化", () => {
	it("confidence 字符串数字 → 接受", () => {
		const r = parseClassifierResponse('{"outcome":"allow","risk_level":"low","reasoning":"x","confidence":"0.7"}');
		expect(r.confidence).toBeCloseTo(0.7);
	});

	it("confidence > 1 → clamp 到 1", () => {
		const r = parseClassifierResponse('{"outcome":"allow","risk_level":"low","reasoning":"x","confidence":1.5}');
		expect(r.confidence).toBe(1);
	});

	it("confidence < 0 → clamp 到 0", () => {
		const r = parseClassifierResponse('{"outcome":"allow","risk_level":"low","reasoning":"x","confidence":-0.3}');
		expect(r.confidence).toBe(0);
	});
});

describe("JT6: 兼容字段 + 边界", () => {
	it("reason 别名（reasoning 缺省时）→ 接受", () => {
		const r = parseClassifierResponse('{"outcome":"allow","risk_level":"low","reason":"alt","confidence":0.5}');
		expect(r.reasoning).toBe("alt");
	});

	it("score 别名 confidence → 接受", () => {
		const r = parseClassifierResponse('{"outcome":"allow","risk_level":"low","reasoning":"x","score":0.4}');
		expect(r.confidence).toBeCloseTo(0.4);
	});

	it("空字符串输入 → fallback", () => {
		expect(parseClassifierResponse("")).toEqual(PARSE_FALLBACK_RESULT);
	});

	it("reasoning 缺省 → 用 fallback reasoning", () => {
		const r = parseClassifierResponse('{"outcome":"allow","risk_level":"low","confidence":0.5}');
		expect(r.reasoning).toBe(PARSE_FALLBACK_RESULT.reasoning);
	});

	it("返回的对象是深拷贝（修改不影响 PARSE_FALLBACK_RESULT）", () => {
		const r = parseClassifierResponse("garbage");
		r.reasoning = "mutated";
		expect(PARSE_FALLBACK_RESULT.reasoning).not.toBe("mutated");
	});
});
