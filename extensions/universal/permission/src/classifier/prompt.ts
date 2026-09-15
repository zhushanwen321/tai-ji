/**
 * AI Classifier prompt 构造（I4 classifyRisk 用）
 *
 * - CLASSIFIER_SYSTEM_PROMPT：约束 LLM 仅返回严格 JSON
 * - buildClassifierUserPrompt(ctx)：把待审工具调用拼成 user message
 *
 * 设计原则：prompt 短（控制成本/延迟）+ 强约束输出格式（配合 json-parser 三层容错）。
 */

import type { ToolInvocationContext } from "../types.js";

/**
 * System prompt：约束 LLM 作为权限风险分类器。
 *
 * 要求输出 JSON `{ outcome, risk_level, reasoning, confidence }`：
 * - outcome ∈ {allow, deny, ask}
 * - risk_level ∈ {low, medium, high}
 * - reasoning：简短人类可读理由（英文/中文均可，≤1 句）
 * - confidence：0-1 浮点
 *
 * 故意保持 ~80 token，降低首次调用延迟与成本。
 */
export const CLASSIFIER_SYSTEM_PROMPT = `You are a security risk classifier for tool invocations in an AI coding agent.
Evaluate the given tool invocation for destructive or unsafe operations.

Reply with ONLY a JSON object (no markdown, no prose before/after):
{"outcome": "allow" | "deny" | "ask", "risk_level": "low" | "medium" | "high", "reasoning": "one short sentence", "confidence": 0.0-1.0}

Rules:
- allow: safe operations (read-only commands, writing to project directory, git status/diff/log, ls, cat, echo, grep, find)
- deny: clearly destructive AND irreversible (rm -rf /, mkfs, force push to main, drop database, format disk)
- ask: potentially dangerous or system-wide changes (rm with recursion, sudo, writing to system dirs like /etc, network operations, deleting multiple files)
- For file writes: allow if writing to user's project/cwd directory; ask if writing to system dirs or sensitive paths (~/.ssh, /etc)
- confidence = your certainty in the outcome (0.0 = guessing, 1.0 = certain)`;

/**
 * 构造 user prompt：把 ToolInvocationContext 的关键字段拼成可读文本。
 *
 * 缺省字段用 "(none)" 占位，保证 LLM 看到稳定结构。
 */
export function buildClassifierUserPrompt(ctx: ToolInvocationContext): string {
	const lines: string[] = [
		`tool: ${ctx.toolName}`,
		`command: ${ctx.command ?? "(none)"}`,
		`path: ${ctx.path ?? "(none)"}`,
		`cwd: ${ctx.cwd}`,
	];
	if (ctx.agentName) {
		lines.push(`agent: ${ctx.agentName}`);
	}
	return `Evaluate this tool invocation:\n${lines.join("\n")}`;
}
