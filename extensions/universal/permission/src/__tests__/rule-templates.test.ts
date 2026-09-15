/**
 * rule-templates.test.ts — W8 T6: rule-templates 单元测试。
 *
 * 覆盖：
 *  - PRESET_COMMANDS 结构（31 命令，7 类 + Other）
 *  - 5 个模板 build（G4 wildcard pattern）
 *  - applyOps（add / edit / delete，纯函数）
 *  - makeNextIdCounter（从已有规则提取最大 user-N）
 */
import { describe, expect, it } from "vitest";

import {
	allowFamilyTemplate,
	allowSubcmdTemplate,
	applyOps,
	askBeforeTemplate,
	customTemplate,
	denyFamilyTemplate,
	makeNextIdCounter,
	PRESET_COMMANDS,
} from "../rule-templates.js";
import type { Rule } from "../types.js";

// ──────────────────────── helpers ────────────────────────

function makeRule(overrides: Partial<Rule> = {}): Rule {
	return {
		id: "user-1",
		tool: "bash",
		pattern: "npm *",
		action: "allow",
		source: "user",
		...overrides,
	};
}

// ──────────────────────── PRESET_COMMANDS ────────────────────────

describe("RT1: PRESET_COMMANDS", () => {
	it("共 53 个命令", () => {
		expect(PRESET_COMMANDS).toHaveLength(53);
	});

	it("每个命令有 cmd / label / category", () => {
		for (const cmd of PRESET_COMMANDS) {
			expect(typeof cmd.cmd).toBe("string");
			expect(cmd.cmd.length).toBeGreaterThan(0);
			expect(typeof cmd.label).toBe("string");
			expect(typeof cmd.category).toBe("string");
		}
	});

	it("涵盖 9 个 category", () => {
		const categories = new Set(PRESET_COMMANDS.map((c) => c.category));
		expect(categories.size).toBe(9);
		expect(categories.has("Package Managers")).toBe(true);
		expect(categories.has("Containers & Cloud")).toBe(true);
		expect(categories.has("Version Control")).toBe(true);
		expect(categories.has("Build & Tasks")).toBe(true);
		expect(categories.has("Network & Download")).toBe(true);
		expect(categories.has("Filesystem")).toBe(true);
		expect(categories.has("Runtime")).toBe(true);
		expect(categories.has("Text Processing")).toBe(true);
		expect(categories.has("System & Info")).toBe(true);
	});

	it("cmd 不含空格（单 token）", () => {
		for (const cmd of PRESET_COMMANDS) {
			expect(cmd.cmd).not.toMatch(/\s/);
		}
	});
});

// ──────────────────────── 模板 build（G4 wildcard） ────────────────────────

describe("RT2: 模板 build（G4 wildcard pattern）", () => {
	it("allow-family：{tool:'bash', pattern:'npm *', action:'allow', source:'user'}", () => {
		const built = allowFamilyTemplate.build({ cmd: "npm" });
		expect(built.tool).toBe("bash");
		expect(built.pattern).toBe("npm *");
		expect(built.action).toBe("allow");
		expect(built.source).toBe("user");
		expect(built).not.toHaveProperty("id"); // G8：无 id
	});

	it("deny-family any：{pattern:'git *', action:'deny'}", () => {
		const built = denyFamilyTemplate.build({ cmd: "git", subcmd: "__any__" });
		expect(built.pattern).toBe("git *");
		expect(built.action).toBe("deny");
	});

	it("deny-family specific：{pattern:'git push *', action:'deny'}", () => {
		const built = denyFamilyTemplate.build({ cmd: "git", subcmd: "push" });
		expect(built.pattern).toBe("git push *");
		expect(built.action).toBe("deny");
	});

	it("ask-before：{pattern:'docker *', action:'ask'}", () => {
		const built = askBeforeTemplate.build({ cmd: "docker" });
		expect(built.pattern).toBe("docker *");
		expect(built.action).toBe("ask");
	});

	it("allow-subcmd：{pattern:'git status *', action:'allow'}", () => {
		const built = allowSubcmdTemplate.build({ cmd: "git", subcmd: "status" });
		expect(built.pattern).toBe("git status *");
		expect(built.action).toBe("allow");
	});

	it("allow-subcmd __any__：退化为 allow-family 语义（pattern:'git *'）", () => {
		const built = allowSubcmdTemplate.build({ cmd: "git", subcmd: "__any__" });
		expect(built.pattern).toBe("git *");
		expect(built.action).toBe("allow");
	});

	it("allow-subcmd undefined subcmd：也退化为 allow-family", () => {
		const built = allowSubcmdTemplate.build({ cmd: "npm" });
		expect(built.pattern).toBe("npm *");
	});

	it("custom：直接用 selections 字段组装", () => {
		const built = customTemplate.build({
			pattern: "rm -rf *",
			action: "deny",
			tool: "bash",
			description: "never rm -rf",
		});
		expect(built.pattern).toBe("rm -rf *");
		expect(built.action).toBe("deny");
		expect(built.description).toBe("never rm -rf");
	});

	it("build 无 id 字段（G8）", () => {
		const built = allowFamilyTemplate.build({ cmd: "npm" });
		expect(built).not.toHaveProperty("id");
	});

	it("pattern 用 wildcard 不用正则（无 \\b 等）", () => {
		const built = denyFamilyTemplate.build({ cmd: "git", subcmd: "push" });
		expect(built.pattern).not.toContain("\\b");
		expect(built.pattern).not.toContain("\\s");
		expect(built.pattern).toBe("git push *");
	});
});

// ──────────────────────── applyOps ────────────────────────

describe("RT4: applyOps", () => {
	it("空 ops → 原数组不变", () => {
		const rules = [makeRule()];
		const result = applyOps(rules, []);
		expect(result).toEqual(rules);
		expect(result).not.toBe(rules); // 新数组
	});

	it("add：push 新规则", () => {
		const rules = [makeRule({ id: "user-1" })];
		const newRule = makeRule({ id: "user-2", pattern: "git *" });
		const result = applyOps(rules, [{ kind: "add", rule: newRule }]);
		expect(result).toHaveLength(2);
		expect(result[1]!.id).toBe("user-2");
	});

	it("edit：替换指定 id 的规则", () => {
		const rules = [makeRule({ id: "user-1", pattern: "npm *" })];
		const edited = makeRule({ id: "user-1", pattern: "yarn *" });
		const result = applyOps(rules, [{ kind: "edit", id: "user-1", rule: edited }]);
		expect(result).toHaveLength(1);
		expect(result[0]!.pattern).toBe("yarn *");
	});

	it("delete：过滤指定 id", () => {
		const rules = [makeRule({ id: "user-1" }), makeRule({ id: "user-2" })];
		const result = applyOps(rules, [{ kind: "delete", id: "user-1" }]);
		expect(result).toHaveLength(1);
		expect(result[0]!.id).toBe("user-2");
	});

	it("多 ops 顺序执行", () => {
		const rules = [makeRule({ id: "user-1" })];
		const ops = [
			{ kind: "add" as const, rule: makeRule({ id: "user-2", pattern: "git *" }) },
			{ kind: "edit" as const, id: "user-1", rule: makeRule({ id: "user-1", pattern: "yarn *" }) },
			{ kind: "delete" as const, id: "user-2" },
		];
		const result = applyOps(rules, ops);
		expect(result).toHaveLength(1);
		expect(result[0]!.id).toBe("user-1");
		expect(result[0]!.pattern).toBe("yarn *");
	});

	it("edit 不存在的 id → 不变", () => {
		const rules = [makeRule({ id: "user-1" })];
		const result = applyOps(rules, [{ kind: "edit", id: "user-999", rule: makeRule({ id: "user-999" }) }]);
		expect(result).toHaveLength(1);
		expect(result[0]!.id).toBe("user-1");
	});
});

// ──────────────────────── makeNextIdCounter ────────────────────────

describe("RT5: makeNextIdCounter", () => {
	it("空规则 → 从 user-1 开始", () => {
		const counter = makeNextIdCounter([]);
		expect(counter()).toBe("user-1");
		expect(counter()).toBe("user-2");
	});

	it("已有 user-3 → 从 user-4 开始", () => {
		const existing = [makeRule({ id: "user-1" }), makeRule({ id: "user-3" })];
		const counter = makeNextIdCounter(existing);
		expect(counter()).toBe("user-4");
		expect(counter()).toBe("user-5");
	});

	it("忽略非 user-<n> 格式的 id", () => {
		const existing = [makeRule({ id: "builtin-safe-1" }), makeRule({ id: "user-5" })];
		const counter = makeNextIdCounter(existing);
		expect(counter()).toBe("user-6");
	});

	it("单调递增（多次调用）", () => {
		const counter = makeNextIdCounter([]);
		const ids = Array.from({ length: 10 }, () => counter());
		expect(ids).toEqual([
			"user-1", "user-2", "user-3", "user-4", "user-5",
			"user-6", "user-7", "user-8", "user-9", "user-10",
		]);
	});
});
