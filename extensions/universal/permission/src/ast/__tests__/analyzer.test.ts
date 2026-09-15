/**
 * WT1-WT23 + WT-concurrent: analyzeBashStructure 集成测试（跑真实 wasm）。
 *
 * 覆盖矩阵：
 *  - WT1-WT7: 干净命令（clean=true，commands 正确）
 *  - WT8-WT15: 危险结构（clean=false，dangerousStructures 含对应 node type）
 *  - WT16-WT19: malformed 语法（parseError=true）
 *  - WT20: 空命令
 *  - WT21-WT22: 超长边界
 *  - WT23: 多管道
 *  - WT-concurrent: 并发共享 Parser 单例不 race
 *
 * 真实跑 wasm（不 mock）—— 验证 tree-sitter-bash grammar 实际行为。
 * beforeAll 预热 Parser 一次，避免第一个测试承担初始化耗时。
 */
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeBashStructure } from "../analyzer.js";
import { getBashParser } from "../loader.js";

beforeAll(async () => {
	// 预热 Parser 单例（所有测试共享）
	await getBashParser();
});

// ──────────────────────── WT1-WT7: 干净命令 ────────────────────────

describe("WT1-WT7: 干净命令（clean=true）", () => {
	it("WT1: ls -la", async () => {
		const r = await analyzeBashStructure("ls -la");
		expect(r.clean).toBe(true);
		expect(r.parseError).toBe(false);
		expect(r.dangerousStructures).toEqual([]);
		expect(r.commands).toEqual([["ls", "-la"]]);
	});

	it("WT2: echo hi", async () => {
		const r = await analyzeBashStructure("echo hi");
		expect(r.clean).toBe(true);
		expect(r.commands).toEqual([["echo", "hi"]]);
	});

	it("WT3: git status", async () => {
		const r = await analyzeBashStructure("git status");
		expect(r.clean).toBe(true);
		expect(r.commands).toEqual([["git", "status"]]);
	});

	it("WT4: cmd1 && cmd2", async () => {
		const r = await analyzeBashStructure("cmd1 && cmd2");
		expect(r.clean).toBe(true);
		expect(r.commands).toEqual([["cmd1"], ["cmd2"]]);
	});

	it("WT5: echo 'str' | wc -l", async () => {
		const r = await analyzeBashStructure("echo 'str' | wc -l");
		expect(r.clean).toBe(true);
		expect(r.commands).toEqual([
			["echo", "str"],
			["wc", "-l"],
		]);
	});

	it("WT6: -g\"*.py\"（concatenation flag + 双引号）", async () => {
		const r = await analyzeBashStructure('rg -g"*.py"');
		expect(r.clean).toBe(true);
		expect(r.commands).toEqual([["rg", "-g*.py"]]);
	});

	it("WT7: cd /tmp", async () => {
		const r = await analyzeBashStructure("cd /tmp");
		expect(r.clean).toBe(true);
		expect(r.commands).toEqual([["cd", "/tmp"]]);
	});
});

// ──────────────────────── WT8-WT15: 危险结构 ────────────────────────

describe("WT8-WT15: 危险结构（clean=false）", () => {
	it("WT8: \$(pwd) —— command_substitution", async () => {
		const r = await analyzeBashStructure("echo $(pwd)");
		expect(r.clean).toBe(false);
		expect(r.parseError).toBe(false);
		expect(r.dangerousStructures).toContain("command_substitution");
	});

	it("WT9: `pwd` —— backtick command_substitution", async () => {
		const r = await analyzeBashStructure("echo `pwd`");
		expect(r.clean).toBe(false);
		expect(r.dangerousStructures.length).toBeGreaterThan(0);
	});

	it("WT10: ls > out —— file_redirect", async () => {
		const r = await analyzeBashStructure("ls > out");
		expect(r.clean).toBe(false);
		expect(r.dangerousStructures).toContain("file_redirect");
	});

	it("WT11: (ls) —— subshell", async () => {
		const r = await analyzeBashStructure("(ls)");
		expect(r.clean).toBe(false);
		// subshell 节点 + 括号 anonymous token
		expect(r.dangerousStructures).toContain("subshell");
	});

	it("WT12: FOO=bar ls —— variable_assignment", async () => {
		const r = await analyzeBashStructure("FOO=bar ls");
		expect(r.clean).toBe(false);
		expect(r.dangerousStructures).toContain("variable_assignment");
	});

	it("WT13: echo a>b —— 内联重定向", async () => {
		const r = await analyzeBashStructure("echo a>b");
		expect(r.clean).toBe(false);
		expect(r.dangerousStructures).toContain("file_redirect");
	});

	it("WT14: { ls; } —— brace compound（语法变体）", async () => {
		// 注：`{ls;}` 无空格 grammar 可能不识别，用标准 `{ ls; }`
		const r = await analyzeBashStructure("{ ls; }");
		expect(r.clean).toBe(false);
		expect(r.dangerousStructures.length).toBeGreaterThan(0);
	});

	it("WT15: [[ x ]] —— test_expression", async () => {
		const r = await analyzeBashStructure("[[ x ]]");
		expect(r.clean).toBe(false);
		expect(r.dangerousStructures.length).toBeGreaterThan(0);
	});

	it("WT15b: echo $HOME —— simple_expansion（裸变量展开）", async () => {
		// $HOME 在双引号外 → tree-sitter-bash 产出 simple_expansion named node（非白名单）
		const r = await analyzeBashStructure("echo $HOME");
		expect(r.clean).toBe(false);
		expect(r.parseError).toBe(false);
		expect(r.dangerousStructures).toContain("simple_expansion");
	});
});

// ──────────────────────── WT16-WT19: malformed ────────────────────────

describe("WT16-WT19: malformed 语法（parseError=true）", () => {
	it("WT16: ls && （trailing operator）", async () => {
		const r = await analyzeBashStructure("ls &&");
		expect(r.parseError).toBe(true);
		expect(r.clean).toBe(false);
		expect(r.dangerousStructures).toContain("ERROR");
	});

	it("WT17: ((incomplete —— 不完整括号", async () => {
		const r = await analyzeBashStructure("((incomplete");
		expect(r.parseError).toBe(true);
		expect(r.clean).toBe(false);
	});

	it("WT18: unclosed \" —— 未闭合双引号", async () => {
		const r = await analyzeBashStructure('echo "unclosed');
		expect(r.parseError).toBe(true);
		expect(r.clean).toBe(false);
	});

	it("WT19: 语法错误 token", async () => {
		const r = await analyzeBashStructure(";;;");
		expect(r.parseError).toBe(true);
		expect(r.clean).toBe(false);
	});
});

// ──────────────────────── WT20: 空命令 ────────────────────────

describe("WT20: 空命令", () => {
	it("WT20: '' 空字符串", async () => {
		const r = await analyzeBashStructure("");
		expect(r.clean).toBe(true);
		expect(r.commands).toEqual([]);
		expect(r.dangerousStructures).toEqual([]);
		expect(r.parseError).toBe(false);
	});

	it("WT20b: 纯空白", async () => {
		const r = await analyzeBashStructure("   \t\n  ");
		expect(r.clean).toBe(true);
		expect(r.commands).toEqual([]);
		expect(r.dangerousStructures).toEqual([]);
		expect(r.parseError).toBe(false);
	});
});

// ──────────────────────── WT21-WT22: 超长边界 ────────────────────────

describe("WT21-WT22: 超长边界", () => {
	it("WT21: 恰好 65536 字节（边界值，应可解析）", async () => {
		// 65536 字节的合法命令，padEnd 到精确长度
		const exact = "ls".padEnd(65536, " x");
		expect(exact.length).toBe(65536);
		const r = await analyzeBashStructure(exact);
		// 边界值不超长 → 走正常解析（clean 取决于 grammar，但 parseError 不应是 INPUT_TOO_LONG）
		expect(r.dangerousStructures).not.toContain("INPUT_TOO_LONG");
	});

	it("WT22: 65537 字节（超长，fail-closed）", async () => {
		const cmd = "x".repeat(65537);
		expect(cmd.length).toBe(65537);
		const r = await analyzeBashStructure(cmd);
		expect(r.clean).toBe(false);
		expect(r.parseError).toBe(true);
		expect(r.dangerousStructures).toContain("INPUT_TOO_LONG");
		expect(r.commands).toEqual([]);
	});
});

// ──────────────────────── WT23: 多管道 ────────────────────────

describe("WT23: 多管道（commands 顺序正确）", () => {
	it("WT23: a | b | c", async () => {
		const r = await analyzeBashStructure("a | b | c");
		expect(r.clean).toBe(true);
		expect(r.commands).toEqual([["a"], ["b"], ["c"]]);
	});

	it("WT23b: 复杂序列 ls && pwd; echo 'hi' | wc -l", async () => {
		const r = await analyzeBashStructure("ls && pwd; echo 'hi' | wc -l");
		expect(r.clean).toBe(true);
		expect(r.commands).toEqual([
			["ls"],
			["pwd"],
			["echo", "hi"],
			["wc", "-l"],
		]);
	});
});

// ──────────────────────── WT-concurrent: 并发 ────────────────────────

describe("WT-concurrent: 并发共享 Parser 单例", () => {
	it("多次并行 analyzeBashStructure 返回各自正确结果（不 race）", async () => {
		const inputs = [
			"ls -la",
			"echo hi && echo bye",
			"git status",
			"echo $(pwd)", // 危险
			"a | b | c",
			"FOO=bar ls", // 危险
			'rg -g"*.py"',
			"",
		];
		const results = await Promise.all(inputs.map((c) => analyzeBashStructure(c)));

		// 每个 result 必须与对应的单次调用结果一致
		expect(results[0].commands).toEqual([["ls", "-la"]]);
		expect(results[0].clean).toBe(true);
		expect(results[1].commands).toEqual([["echo", "hi"], ["echo", "bye"]]);
		expect(results[1].clean).toBe(true);
		expect(results[2].commands).toEqual([["git", "status"]]);
		expect(results[3].clean).toBe(false);
		expect(results[4].commands).toEqual([["a"], ["b"], ["c"]]);
		expect(results[5].clean).toBe(false);
		expect(results[6].commands).toEqual([["rg", "-g*.py"]]);
		expect(results[7].clean).toBe(true);
		expect(results[7].commands).toEqual([]);
	});
});
