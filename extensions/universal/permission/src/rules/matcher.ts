/**
 * 规则匹配引擎（W3 层 2 核心入口）。
 *
 * 三个 critical gap 修正（design-review）：
 *
 *  ── G1: no-match 兜底语义 ──
 *  无匹配返回 `{ action: 'ask', matchedRule: undefined }`（非 'deny'）。
 *  deny 会让 auto 模式所有未匹配命令被拦截，无法到 AI 层。ask 让未匹配命令
 *  进入下游（auto 模式 → AI classifier；approve/strict 模式 → 人工审批）。
 *
 *  ── G2: pattern 双语义 ──
 *  source='builtin-danger' 的 pattern 是 RegExp 源字符串（含 `\b`/`\s`），
 *  用 `new RegExp(pattern, 'i')` 编译；其余（builtin-safe/user）是 OpenCode
 *  wildcard，用 `wildcardToRegExp(pattern)` 编译。resolvePattern 按 source 分发。
 *
 *  ── G3: 50+9 白名单用函数（C3 修正：不再短路）──
 *  matchRulesForArgv 先遍历 rules（last-match-wins）；若无 deny/allow 命中（ask），
 *  再查 isKnownSafeCommand(argv) 兜底返回 allow。白名单不再短路：用户 deny 规则
 *  可覆盖白名单。白名单不进 Rule[] 数组（Codex flag 子检查无法用单条 wildcard 表达）。
 *
 * 匹配语义：last-match-wins（rules 数组顺序遍历，最后匹配的 rule 胜出），
 * 循环单源在 lastMatchWins（E11，pipeline.matchNonBashTool 也消费）。
 * 拼接顺序由调用方（W5）负责：[...builtin-danger, ...userRules]。
 */

import type { Rule, RuleMatchResult } from "../types.js";
import { isKnownSafeCommand } from "./builtins.js";
import { wildcardToRegExp } from "./wildcard.js";

// ──────────────────────── pattern 缓存（module-level 状态）────────────────────────

/**
 * pattern → RegExp 缓存，key = `source + ':' + pattern`。
 *
 * 唯一的 module-level 可变状态（matcher 是纯函数，缓存为性能优化，不改变语义）。
 * 进程级生命周期，无需手动清理（pattern 集合有限且有界）。
 */
const patternCache = new Map<string, RegExp>();

/**
 * 把 rule.pattern 编译为 RegExp，按 source 分发（G2）。
 *
 *  - source='builtin-danger'：pattern 是 RegExp 源字符串 → `new RegExp(pattern, 'i')`
 *  - 其余（builtin-safe/user）：pattern 是 OpenCode wildcard → `wildcardToRegExp(pattern)`
 *
 * 结果缓存到 patternCache。
 */
export function resolvePattern(rule: Rule): RegExp {
	const cacheKey = rule.source + ":" + rule.pattern;
	const cached = patternCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const re =
		rule.source === "builtin-danger"
			? new RegExp(rule.pattern, "i")
			: wildcardToRegExp(rule.pattern);

	patternCache.set(cacheKey, re);
	return re;
}

// ──────────────────────── lastMatchWins（循环单源，E11） ────────────────────────

/**
 * last-match-wins 循环单源（E11：原三份循环——matchRulesForArgv / matchRules /
 * pipeline.matchNonBashTool——收敛）。
 *
 * 按 rules 数组顺序遍历，predicate 命中时记录 winner，最后匹配者胜出；
 * 无匹配返回 `{ action: 'ask', matchedRule: undefined }`（G1 兜底）。
 */
export function lastMatchWins(
	rules: readonly Rule[],
	predicate: (rule: Rule) => boolean,
): RuleMatchResult {
	let winner: RuleMatchResult = { action: "ask", matchedRule: undefined };
	for (const rule of rules) {
		if (predicate(rule)) {
			winner = { action: rule.action, matchedRule: rule };
		}
	}
	return winner;
}

// ──────────────────────── matchRulesForArgv（happy path，W2 clean=true 有 argv[]）────────────────────────

/** 命中 isKnownSafeCommand 时构造的虚拟 builtin-safe rule（保持 matchedRule 字段一致性）。 */
function virtualSafeRule(argv0: string): Rule {
	return {
		id: "builtin-safe",
		tool: "bash",
		pattern: argv0,
		action: "allow",
		source: "builtin-safe",
		description: "known safe command (Codex safelist)",
	};
}

/**
 * 对已 tokenize 的 argv 做规则匹配（happy path）。
 *
 * 顺序（C3 修正：白名单不再短路，用户 deny 可覆盖白名单，符合 last-match-wins 契约）：
 *  1. 遍历 rules（last-match-wins），对每条用 resolvePattern(rule).test(argv.join(' '))
 *     记录 winner。
 *  2. winner.action === 'deny' → 返回 deny（用户/builtin deny 优先于白名单）
 *  3. winner.action === 'allow' → 返回 allow
 *  4. winner.action === 'ask'（无匹配）：
 *       - isKnownSafeCommand(argv) → allow（白名单兜底，虚拟 builtin-safe rule）
 *       - 否则 → ask
 *  5. 空 argv → ask（G1）
 *
 * 匹配目标字符串统一为 `argv.join(' ')`（builtin-danger 正则与 user wildcard 都对它匹配）。
 */
export function matchRulesForArgv(argv: string[], rules: readonly Rule[]): RuleMatchResult {
	if (argv.length === 0) {
		// 空命令无法匹配任何规则 → ask（G1）
		return { action: "ask", matchedRule: undefined };
	}

	const commandStr = argv.join(" ");

	const winner = lastMatchWins(rules, (rule) => resolvePattern(rule).test(commandStr));

	// deny / allow 直接由 winner 决定（用户规则可覆盖白名单）
	if (winner.action === "deny" || winner.action === "allow") {
		return winner;
	}

	// winner.action === 'ask'（无规则匹配）→ 白名单兜底
	if (isKnownSafeCommand(argv)) {
		return { action: "allow", matchedRule: virtualSafeRule(argv[0] ?? "") };
	}
	return winner;
}

// ──────────────────────── matchRules（退化路径，command 字符串）────────────────────────

/**
 * 对原始 command 字符串做规则匹配（退化路径 + C1 完整字符串补充检查）。
 *
 * 两种使用场景：
 *  1. 退化路径：W2 AST 解析失败（parseError）或调用方只拿到 command 字符串
 *     （无法可靠 tokenize argv）。
 *  2. C1 补充检查：pipeline.ts 对 bash 工具的完整 command 字符串做一次额外
 *     builtin-danger deny 匹配，覆盖「curl | sh」这类跨 argv 管道命令（AST 按
 *     管道拆分后单个 argv 不含 `|`，deny 规则的正则无法命中）。
 *
 * 行为：
 *  - command === undefined / 空字符串 → ask
 *  - 遍历 rules（last-match-wins），对每条用 resolvePattern(rule).test(command)
 *  - 无匹配 → ask（G1）
 *
 * E11：toolName 参数与 `toolName !== 'bash'` 守卫已删——生产调用点（pipeline.runLayer2）
 * 恒在 bash 分支内调用，非 bash 由 matchNonBashTool 承接，守卫是不可达的投机分支。
 *
 * 不调 isKnownSafeCommand（不查白名单）：command 字符串无法可靠提取 argv
 * （含引号/转义/管道），argv 级白名单判断由 matchRulesForArgv 在 happy path 负责。
 * 因此本函数仅用于 deny 补充检查或退化路径，不用作 allow 放行依据。
 */
export function matchRules(
	command: string | undefined,
	rules: readonly Rule[],
): RuleMatchResult {
	if (command === undefined || command === "") {
		return { action: "ask", matchedRule: undefined };
	}
	return lastMatchWins(rules, (rule) => resolvePattern(rule).test(command));
}
