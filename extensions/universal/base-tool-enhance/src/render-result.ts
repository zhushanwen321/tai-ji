/**
 * bash_output / bash_kill 的收起态一行摘要 + TUI renderResult。
 *
 * summary 来源：两个工具的成功/失败产出都是自产 JSON 文本（content[0].text），
 * summary 纯函数对它做防御性 JSON.parse 取数（自家 stringify 产物，解析失败走兜底）。
 * 原 details 为 undefined → 统一改为 { summary }。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { firstContentText } from "@zhushanwen/extension-protocol";

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

/** bash_kill 摘要：killed=true → `Killed task <id>`；killed=false（正常返回的失败形态）
 *  → `Kill failed: <reason>`。 */
export function buildBashKillSummary(args: { task_id: string }, result: ToolResultLike): string {
	const parsed = parseOwnJson(result);
	if (parsed === undefined) return "Done";
	if (parsed.killed === true) return `Killed task ${args.task_id}`;
	const reason = typeof parsed.reason === "string" ? parsed.reason : "unknown";
	const clipped = reason.length > KILL_REASON_SUMMARY_CHARS
		? `${reason.slice(0, KILL_REASON_SUMMARY_CHARS)}…`
		: reason;
	return `Kill failed: ${clipped}`;
}

// ── TUI renderResult ─────────────────────────────────

/** unknown 值按字段名安全取值（index-signature 收窄，替代全可选结构断言）。 */
function fieldValue(v: unknown, key: string): unknown {
	if (typeof v !== "object" || v === null) return undefined;
	return (v as Record<string, unknown>)[key];
}

/** 从 details 安全读取 summary（容错非对象形态与旧版本 entry）。 */
function readDetailsSummary(result: unknown): string | undefined {
	const summary = fieldValue(fieldValue(result, "details"), "summary");
	return typeof summary === "string" && summary !== "" ? summary : undefined;
}

/** content[0] 的 text 纯文本（content 缺失或非 text 类型时兜底空串）。 */
function contentText(result: unknown): string {
	const content = fieldValue(result, "content");
	if (!Array.isArray(content)) return "";
	return firstContentText({ content });
}

/** 折叠态回退：JSON 文本取首行（保持一行摘要形态）。 */
function firstLine(text: string): string {
	const idx = text.indexOf("\n");
	return idx === -1 ? text : text.slice(0, idx);
}

/** 折叠态（expanded=false）= details.summary 一行（dim）；展开态 = content 纯文本。 */
export function renderBashToolResult(
	result: unknown,
	options: { expanded: boolean },
	theme: Theme,
): Text {
	if (options.expanded) return new Text(contentText(result), 0, 0);
	const summary = readDetailsSummary(result) ?? firstLine(contentText(result));
	return new Text(theme.fg("dim", summary), 0, 0);
}
