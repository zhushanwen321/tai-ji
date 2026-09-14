/**
 * IT 系列：rules/index.ts barrel 导出验证。
 *
 * E10 收敛后 barrel 只保留有生产消费的 2 符号（getDefaultRules / matchRulesForArgv）；
 * 其余符号的行为测试走深路径（matcher.test.ts / builtins.test.ts / wildcard.test.ts）。
 */
import { describe, expect, it } from "vitest";

import * as rulesApi from "../index.js";

describe("IT: rules barrel 导出", () => {
	it("只导出 2 个有生产消费的符号", () => {
		expect(Object.keys(rulesApi).sort()).toEqual(["getDefaultRules", "matchRulesForArgv"]);
		expect(typeof rulesApi.getDefaultRules).toBe("function");
		expect(typeof rulesApi.matchRulesForArgv).toBe("function");
	});
});
