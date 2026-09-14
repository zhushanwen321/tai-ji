// src/__tests__/subagent-guard.test.ts
//
// subagent-guard 判据钉值（ext-simplify-17 D4 重锚定后）：
//   - XYZ_AGENT_SUBAGENT === "1" 命中（引擎 spawn 链恒注入的现行标记）
//   - 其他值 / 缺失不命中（顶层会话不误降级，background 正常后台化）
//
// [HISTORICAL] 对照（D4 重锚前的旧行为）：旧判据查 PI_SUBAGENT_* 身份键族两枚、
// 任一存在即命中——该键族已无写入方，旧判据实际恒 false（降级从未生效）。旧键
// 不命中的钉值在 ext-guards predicates 测试（谓词实现方领地），此处只钉 bte
// 消费面的现行语义。

import { describe, expect, it } from "vitest";

import { isSubagentProcess } from "../background/subagent-guard.ts";

describe("isSubagentProcess（subagent-guard，D4 重锚后）", () => {
	it("XYZ_AGENT_SUBAGENT=1 命中（引擎链 subagent → D14 background 降级前提恢复）", () => {
		expect(isSubagentProcess({ XYZ_AGENT_SUBAGENT: "1" })).toBe(true);
	});

	it("值非 \"1\" 不命中", () => {
		expect(isSubagentProcess({ XYZ_AGENT_SUBAGENT: "0" })).toBe(false);
		expect(isSubagentProcess({ XYZ_AGENT_SUBAGENT: "" })).toBe(false);
	});

	it("缺失不命中（顶层会话 → background 正常后台化，guard 不误命中）", () => {
		expect(isSubagentProcess({})).toBe(false);
	});
});
