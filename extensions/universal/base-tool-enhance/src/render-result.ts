/**
 * bash_output / bash_kill 的收起态一行摘要 + TUI renderResult。
 *
 * summary 来源：两个工具的成功/失败产出都是自产 JSON 文本（content[0].text），
 * summary 纯函数对它做防御性 JSON.parse 取数（自家 stringify 产物，解析失败走兜底）。
 * 原 details 为 undefined → 统一改为 { summary }。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { firstContentText, firstLine, readDetailsSummary, resultContentText } from "@zhushanwen/extension-protocol";

// ── summary 纯函数 ───────────────────────────────────

interface ToolResultLike { // oe-exempt:20261017:framework:details 数据形状窄 view（单实现消费，非抽象接口）
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

/** 自产 JSON 文本的安全解析（解析失败/非对象 → undefined）。 */
function parseOwnJson(result: ToolResultLike): Record<string, unknown> | undefined {
	const text = firstContentText(result);
	if (text === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** 文本行数（去末尾换行后按 \n 切分；空文本 = 0 行）。 */
function countLines(text: string): number {
	if (text === "") return 0;
	return text.replace(/\n$/, "").split("\n").length;
}

/** bash_output 摘要：详情 → `Output of task <id> · N lines`；列表 → `N background tasks`。 */
export function buildBashOutputSummary(
	args: { task_id?: string },
	result: ToolResultLike,
): string {
	const parsed = parseOwnJson(result);
	if (parsed === undefined) return "Done";
	if (args.task_id === undefined) {
		const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.length : 0;
		return tasks === 0 ? "No background tasks" : `${tasks} background tasks`;
	}
	if (parsed.output === "<lost>") return `Output of task ${args.task_id}`;
	const lines = countLines(typeof parsed.output === "string" ? parsed.output : "");
	return lines === 0 ? `Output of task ${args.task_id}` : `Output of task ${args.task_id} · ${lines} lines`;
}

/** 收起态摘要中失败 reason 的保留长度（超长截断加省略号）。 */
const KILL_REASON_SUMMARY_CHARS = 80;

/** reason 归一单行 + 码点安全截断到上限（超长补省略号；与 goal/todo/plan 的摘要 helper
 *  同语义：换行/连续空白折叠为单空格，Array.from 按码点切分，emoji 代理对不劈半——
 *  details.summary 单行契约见 extension-conventions.md）。 */
function clipSummaryText(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	const chars = Array.from(line);
	return chars.length > max ? chars.slice(0, max).join("") + "…" : line;
}

/** bash_kill 摘要：killed=true → `Killed task <id>`；killed=false（正常返回的失败形态）
 *  → `Kill failed: <reason>`。 */
export function buildBashKillSummary(args: { task_id: string }, result: ToolResultLike): string {
	const parsed = parseOwnJson(result);
	if (parsed === undefined) return "Done";
	if (parsed.killed === true) return `Killed task ${args.task_id}`;
	const reason = typeof parsed.reason === "string" ? parsed.reason : "unknown";
	return `Kill failed: ${clipSummaryText(reason, KILL_REASON_SUMMARY_CHARS)}`;
}

// ── TUI renderResult ─────────────────────────────────

/** 折叠态（expanded=false）= details.summary 一行（dim）；展开态 = content 纯文本。 */
export function renderBashToolResult(
	result: unknown,
	options: { expanded: boolean },
	theme: Theme,
): Text {
	if (options.expanded) return new Text(resultContentText(result), 0, 0);
	const summary = readDetailsSummary(result) ?? firstLine(resultContentText(result));
	return new Text(theme.fg("dim", summary), 0, 0);
}
