// src/__tests__/command-display.test.ts
//
// truncateCommand 单源实现的输出等价锚（plan-mode-audit-remediation 批次 3
// 活路径去重组：原 spawn-background.ts / notify.ts 两份同构定义去重留一份）。
// 断言即两份旧副本共同产出的输出形态：
//  - ≤80 字符（含恰好 80）原样返回
//  - >80 取前 80 字符 + 单个省略号（总长 81，与 notify.test.ts 的 emit 路径断言一致）
import { describe, expect, it } from "vitest";

import { COMMAND_DISPLAY_LIMIT, truncateCommand } from "../background/command-display";

describe("truncateCommand（单源，原双份定义的输出等价锚）", () => {
	it("short command returned as-is", () => {
		expect(truncateCommand("pnpm test")).toBe("pnpm test");
	});

	it(`command of exactly ${COMMAND_DISPLAY_LIMIT} chars not truncated (boundary: length > limit)`, () => {
		const exact = "c".repeat(COMMAND_DISPLAY_LIMIT);
		expect(truncateCommand(exact)).toBe(exact);
	});

	it("long command truncated to first 80 chars + single ellipsis (total 81)", () => {
		const long = `echo ${"x".repeat(200)}`;
		expect(truncateCommand(long)).toBe(`${long.slice(0, COMMAND_DISPLAY_LIMIT)}…`);
		expect(truncateCommand(long).length).toBe(COMMAND_DISPLAY_LIMIT + 1);
	});
});
