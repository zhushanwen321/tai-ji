/**
 * e2e-modes.test.ts — W6 T10: checkPermission 四档模式 e2e + G5 auto Racing e2e。
 *
 * 与 pipeline.test.ts 的区别：
 *  - pipeline.test.ts 测各层内部函数（runLayer2/applyAutoApproveOverrides/matchNonBashTool）
 *  - 本文件测 checkPermission 主入口的端到端行为（模拟完整 tool_call 流程）
 *
 * 5 个基础 e2e case（每档模式一个典型场景）：
 *  - W6TC-E1: yolo + 危险命令 → allow（快速路径，不跑管道）
 *  - W6TC-E2: strict + 任意命令 → user 审批
 *  - W6TC-E3: approve + 安全命令（ls）→ rule allow
 *  - W6TC-E4: approve + 非安全命令 → user 审批
 *  - W6TC-E5: auto + 安全命令（ls）→ rule allow（不跑 AI）
 *
 * G5 补充 e2e case（W6 design-review gap）：
 *  - W6TC-E6: auto + 未知命令 + mock classifier → AI Racing（层 3 完整流程）
 *    当前 5 e2e 没覆盖 auto 层 3，本 case 补齐。
 */
import { describe, expect, it, vi } from "vitest";

import { checkPermission, type CheckPermissionDeps } from "../pipeline.js";
import { getDefaultRules, matchRulesForArgv } from "../rules/index.js";
import type {
	BashAnalysis,
	ClassifierConfig,
	ClassifierResult,
	Rule,
	RuleMatchResult,
	ToolInvocationContext,
	UserDecision,
} from "../types.js";

// ──────────────────────── mock helpers ────────────────────────

const CFG: ClassifierConfig = {
	enabled: true,
	model: "auto",
	timeout: 90,
	autoApproveLowRisk: true,
	autoDenyHighRisk: true,
};

const ctxBase = { cwd: "/project", agentName: "test-agent" };

function cleanAnalysis(commands: string[][] = []): BashAnalysis {
	return { clean: true, commands, dangerousStructures: [], parseError: false };
}

function dirtyAnalysis(dangerous: string[] = ["subshell"]): BashAnalysis {
	return { clean: false, commands: [], dangerousStructures: dangerous, parseError: false };
}

/**
 * 构造完整 mock deps（模拟真实生产装配，但所有外部依赖可控）。
 * 关键：用真实的 getDefaultRules + matchRulesForArgv（测真实规则引擎），
 * 只 mock analyzeBashStructure（避免跑 wasm）+ classifier + requestUserApproval。
 */
function makeRealisticDeps(overrides: {
	analyze?: (cmd: string) => Promise<BashAnalysis>;
	classify?: (ctx: ToolInvocationContext, cfg: ClassifierConfig, signal?: AbortSignal) => Promise<ClassifierResult>;
	approve?: (req: { toolName: string; command?: string; reason: string }, ctx: ToolInvocationContext, signal?: AbortSignal) => Promise<UserDecision>;
	userRules?: Rule[];
} = {}): CheckPermissionDeps {
	const userRules = overrides.userRules ?? [];
	return {
		analyzeBashStructure: overrides.analyze ?? (() => Promise.resolve(cleanAnalysis())),
		// 用真实的 matchRulesForArgv（测真实规则引擎 + 白名单）
		matchRulesForArgv: (argv: string[], rules: readonly Rule[]): RuleMatchResult => matchRulesForArgv(argv, rules),
		// 用真实的 getDefaultRules + 用户规则
		getDefaultRules: () => [...getDefaultRules(), ...userRules],
		classifier: {
			classifyRisk: overrides.classify ?? (() => Promise.resolve({ risk_level: "medium" as const, outcome: "ask" as const, reasoning: "fallback", confidence: 0 })),
		},
		isHeadless: () => false,
		requestUserApproval:
			overrides.approve ?? (() => Promise.resolve({ approved: false, reason: "default-deny" })),
	};
}

function allowClassifier(risk: "low" | "medium" | "high" = "low"): ClassifierResult {
	return { risk_level: risk, outcome: "allow", reasoning: "ai-allow", confidence: 0.9 };
}

function denyClassifier(risk: "low" | "medium" | "high" = "high"): ClassifierResult {
	return { risk_level: risk, outcome: "deny", reasoning: "ai-deny", confidence: 0.95 };
}

// ──────────────────────── W6TC-E1: yolo 快速路径 ────────────────────────

describe("W6TC-E1: yolo 模式 e2e（危险命令也放行）", () => {
	it("yolo + rm -rf / → allow（source=mode，不跑管道）", async () => {
		const analyze = vi.fn(() => Promise.resolve(cleanAnalysis([["rm", "-rf", "/"]])));
		const deps = makeRealisticDeps({ analyze });
		const decision = await checkPermission("bash", { command: "rm -rf /" }, "yolo", CFG, [], deps, ctxBase);
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("mode");
		expect(analyze).not.toHaveBeenCalled(); // 快速路径不跑 AST
	});
});

// ──────────────────────── W6TC-E2: strict 全审批 ────────────────────────

describe("W6TC-E2: strict 模式 e2e（全部人工审批）", () => {
	it("strict + ls → user 审批（用户 approve → allow）", async () => {
		const approve = vi.fn(() => Promise.resolve<UserDecision>({ approved: true, reason: "ok" }));
		const deps = makeRealisticDeps({ approve });
		const decision = await checkPermission("bash", { command: "ls" }, "strict", CFG, [], deps, ctxBase);
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("user");
		expect(approve).toHaveBeenCalledOnce();
	});

	it("strict + 非 bash（read）→ user 审批（不跑 AST/规则）", async () => {
		const approve = vi.fn(() => Promise.resolve<UserDecision>({ approved: false, reason: "no" }));
		const deps = makeRealisticDeps({ approve });
		const decision = await checkPermission("read", { path: "/etc/passwd" }, "strict", CFG, [], deps, ctxBase);
		expect(decision.action).toBe("deny");
		expect(decision.source).toBe("user");
	});
});

// ──────────────────────── W6TC-E3: approve + 安全命令 ────────────────────────

describe("W6TC-E3: approve 模式 e2e（安全命令规则放行）", () => {
	it("approve + ls → rule allow（白名单，不跑 AI/审批）", async () => {
		const approve = vi.fn(() => Promise.resolve<UserDecision>({ approved: true, reason: "should-not-reach" }));
		const classify = vi.fn(() => Promise.resolve(allowClassifier()));
		const deps = makeRealisticDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["ls", "-la"]])),
			approve,
			classify,
		});
		const decision = await checkPermission("bash", { command: "ls -la" }, "approve", CFG, [], deps, ctxBase);
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("rule");
		expect(approve).not.toHaveBeenCalled();
		expect(classify).not.toHaveBeenCalled();
	});
});

// ──────────────────────── W6TC-E4: approve + 非安全命令 ────────────────────────

describe("W6TC-E4: approve 模式 e2e（非安全命令 → 人工审批）", () => {
	it("approve + curl（非白名单）→ user 审批", async () => {
		const approve = vi.fn(() => Promise.resolve<UserDecision>({ approved: false, reason: "denied" }));
		const classify = vi.fn(() => Promise.resolve(allowClassifier()));
		const deps = makeRealisticDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["curl", "http://example.com"]])),
			approve,
			classify,
		});
		const decision = await checkPermission("bash", { command: "curl http://example.com" }, "approve", CFG, [], deps, ctxBase);
		expect(decision.action).toBe("deny");
		expect(decision.source).toBe("user");
		expect(approve).toHaveBeenCalledOnce();
		expect(classify).not.toHaveBeenCalled(); // approve 不跑 AI
	});
});

// ──────────────────────── W6TC-E5: auto + 安全命令 ────────────────────────

describe("W6TC-E5: auto 模式 e2e（安全命令规则放行，不跑 AI）", () => {
	it("auto + git status → rule allow（白名单命中，不跑 AI）", async () => {
		const classify = vi.fn(() => Promise.resolve(allowClassifier()));
		const deps = makeRealisticDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["git", "status"]])),
			classify,
		});
		const decision = await checkPermission("bash", { command: "git status" }, "auto", CFG, [], deps, ctxBase);
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("rule");
		expect(classify).not.toHaveBeenCalled();
	});
});

// ──────────────────────── W6TC-E6 (G5): auto + 未知命令 + mock classifier Racing ────────────────────────

describe("W6TC-E6 (G5): auto + 未知命令 → AI 层 3 Racing e2e", () => {
	it("auto + 未知命令（npm install）+ AI allow(low) → allow（source=ai）", async () => {
		// npm 不在白名单 → 规则 ask → 进层 3 → AI allow(low) + autoApproveLowRisk=true → allow
		const classify = vi.fn(() => Promise.resolve(allowClassifier("low")));
		const approve = vi.fn(() => new Promise<UserDecision>(() => undefined)); // 用户永不返回（AI 先赢）
		const deps = makeRealisticDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["npm", "install"]])),
			classify,
			approve,
		});
		const decision = await checkPermission("bash", { command: "npm install" }, "auto", CFG, [], deps, ctxBase);
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("ai");
		expect(decision.riskLevel).toBe("low");
		expect(classify).toHaveBeenCalledOnce();
	});

	it("auto + 未知命令 + AI deny(high) → deny（source=ai）", async () => {
		const classify = vi.fn(() => Promise.resolve(denyClassifier("high")));
		const approve = vi.fn(() => new Promise<UserDecision>(() => undefined));
		const deps = makeRealisticDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["wget", "http://evil.com"]])),
			classify,
			approve,
		});
		const decision = await checkPermission("bash", { command: "wget http://evil.com" }, "auto", CFG, [], deps, ctxBase);
		expect(decision.action).toBe("deny");
		expect(decision.source).toBe("ai");
		expect(decision.riskLevel).toBe("high");
	});

	it("auto + 未知命令 + AI ask → 转人工（source=user）", async () => {
		// AI 返回 ask → 不 resolveUser → 等用户最终决策
		const classify = vi.fn(() => Promise.resolve({ risk_level: "medium" as const, outcome: "ask" as const, reasoning: "uncertain", confidence: 0.5 }));
		const approve = vi.fn(() => Promise.resolve<UserDecision>({ approved: true, reason: "user-says-ok" }));
		const deps = makeRealisticDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["curl", "http://unknown.com"]])),
			classify,
			approve,
		});
		const decision = await checkPermission("bash", { command: "curl http://unknown.com" }, "auto", CFG, [], deps, ctxBase);
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("user");
		expect(classify).toHaveBeenCalledOnce();
		expect(approve).toHaveBeenCalledOnce();
	});

	it("auto + 危险结构（subshell）→ 直接进层 3（AI 评估）", async () => {
		// AST 检测到 subshell → clean=false → 直接进层 3（不走规则）
		const classify = vi.fn(() => Promise.resolve(denyClassifier("high")));
		const deps = makeRealisticDeps({
			analyze: () => Promise.resolve(dirtyAnalysis(["subshell"])),
			classify,
			approve: () => new Promise<UserDecision>(() => undefined),
		});
		const decision = await checkPermission("bash", { command: "$(rm -rf /)" }, "auto", CFG, [], deps, ctxBase);
		expect(decision.action).toBe("deny");
		expect(decision.source).toBe("ai");
		expect(classify).toHaveBeenCalledOnce();
	});

	it("auto + 用户规则 deny 命中 → deny（source=rule，不跑 AI）", async () => {
		// 用户写了 deny npm 规则 → 即使是未知命令也被规则 deny（last-match-wins）
		const userDenyRule: Rule = { id: "u-deny-npm", tool: "bash", pattern: "npm *", action: "deny", source: "user" };
		const classify = vi.fn(() => Promise.resolve(allowClassifier()));
		const deps = makeRealisticDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["npm", "install"]])),
			classify,
			userRules: [userDenyRule],
		});
		const decision = await checkPermission("bash", { command: "npm install" }, "auto", CFG, [], deps, ctxBase);
		expect(decision.action).toBe("deny");
		expect(decision.source).toBe("rule");
		expect(classify).not.toHaveBeenCalled(); // 规则 deny 不跑 AI
	});
});
