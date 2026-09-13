/**
 * bash_output 工具（D9：独立小工具，查询与 kill 权限语义分离）。
 *
 * 规格（§3.5）：{task_id?}。
 *  - 省略 = list：单例表与 registry 终态条目合并（同 task_id 以单例表为准——它的
 *    状态更新），返回 {tasks:[...]}，按 startedAt 升序
 *  - 指定 = 详情：{state, exitCode?, reason?, durationMs?, output(tail 2000 行/50KB
 *    截断，同内置规则), outputFile, truncated}；输出文件被删后返回
 *    {output:"<lost>", state} 不崩溃（§3.6）
 *
 * 查询归属边界（§3.5 跨进程边界）：单例表 = 本进程全部任务（含同进程 session 替换
 * 前发起的）；registry 侧只读当前 sessionId 目录。他进程任务查不到（回发起 session）。
 */

import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readOutputTail } from "@xyz-agent/extension-protocol/background-task";
import { Type } from "typebox";

import { TAIL_MAX_BYTES, TAIL_MAX_LINES } from "./background/output-tail.ts";
import { getRegistryPath, readRegistry } from "./background/registry.ts";
import { truncateCommand } from "./background/spawn-background.ts";
import { getAllTasks } from "./background/task-store.ts";
import { isTerminalState, type BackgroundTask, type RegistryEntry } from "./background/types.ts";

const bashOutputSchema = Type.Object({
	task_id: Type.Optional(Type.String({ description: "Task id returned by the background bash tool. Omit to list all background tasks." })),
});

/** JSON 输出缩进（registry.ts 同款）。 */
const JSON_INDENT = 2;

const BASH_OUTPUT_DESCRIPTION = [
	"Fetch output and status of a background bash task started with bash {background:true}.",
	"Provide task_id to get task detail: state (running|killing|exited|orphaned), exitCode, reason, duration and tail output (last 2000 lines / 50KB).",
	'reason "killed" means the task was terminated by the user from the UI — do not restart the command unless explicitly asked.',
	'reason "orphaned" means the owner process died before the task finished — the task is no longer supervised.',
	"Omit task_id to list known background tasks (process-wide; may include tasks started under earlier sessions).",
].join("\n");

/** list 视图条目（§3.5：command 前 80 字符）。 */
function toListRow(source: BackgroundTask | RegistryEntry) {
	return {
		task_id: source.taskId,
		command: truncateCommand(source.command),
		state: source.state,
		...(source.exitCode !== undefined ? { exitCode: source.exitCode } : {}),
		...(source.reason !== undefined ? { reason: source.reason } : {}),
		startedAt: source.startedAt,
		...(source.durationMs !== undefined ? { durationMs: source.durationMs } : {}),
	};
}

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

/**
 * list 视图：单例表优先，registry 终态条目补差（同 id 已在单例表则跳过）。
 * registry 侧只并入终态（exited/orphaned）——running/killing 条目属他进程
 * 任务（本进程活跃任务必在单例表），并入会显示幻影 running 行（§3.5
 * 「单例表与 registry 终态条目合并」）。
 */
function listTasksText(registry: Map<string, RegistryEntry>): string {
	const rows = new Map<string, ReturnType<typeof toListRow>>();
	for (const task of getAllTasks()) rows.set(task.taskId, toListRow(task));
	for (const entry of registry.values()) {
		if (!isTerminalState(entry.state)) continue;
		if (!rows.has(entry.taskId)) rows.set(entry.taskId, toListRow(entry));
	}
	const tasks = [...rows.values()].sort((a, b) => a.startedAt - b.startedAt);
	return JSON.stringify({ tasks }, null, JSON_INDENT);
}

/**
 * 按 taskId 定位任务：单例表 → 当前 session registry（回落限定终态条目——
 * 他进程 running 条目不可查，§3.5 跨进程边界）。
 */
function findTask(
	taskId: string,
	registry: Map<string, RegistryEntry>,
): BackgroundTask | RegistryEntry | undefined {
	const registryEntry = registry.get(taskId);
	return (
		getAllTasks().find((t) => t.taskId === taskId) ??
		(registryEntry !== undefined && isTerminalState(registryEntry.state) ? registryEntry : undefined)
	);
}

/** 详情视图：tail 输出（丢失时 "<lost>"，§3.6）+ 终态字段按存在性展开。 */
function taskDetailText(task: BackgroundTask | RegistryEntry): string {
	// protocol 原语返回 {text, truncated}；50KB/2000 行口径（本包产品决策）在此传参。
	// 返回 JSON 的 `output` 字段名是 LLM 可见契约（工具 schema/描述零变化），仅在
	// 此处从原语的 text 投影，ext-simplify-13 D2 有意内部变化
	const tail = readOutputTail(task.outputFile, { maxBytes: TAIL_MAX_BYTES, maxLines: TAIL_MAX_LINES });
	const detail = {
		task_id: task.taskId,
		state: task.state,
		...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
		...(task.reason !== undefined ? { reason: task.reason } : {}),
		startedAt: task.startedAt,
		...(task.durationMs !== undefined ? { durationMs: task.durationMs } : {}),
		output: tail?.text ?? "<lost>",
		truncated: tail?.truncated ?? false,
		outputFile: task.outputFile,
	};
	return JSON.stringify(detail, null, JSON_INDENT);
}

export function createBashOutputToolDefinition() {
	return {
		name: "bash_output",
		label: "bash_output",
		description: BASH_OUTPUT_DESCRIPTION,
		parameters: bashOutputSchema,
		async execute(
			_toolCallId: string,
			args: { task_id?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const sessionId = ctx.sessionManager.getSessionId();
			const registry = readRegistry(getRegistryPath(getAgentDir(), sessionId));

			if (args.task_id === undefined) return textResult(listTasksText(registry));

			const task = findTask(args.task_id, registry);
			if (task === undefined) {
				throw new Error(
					`No such task: ${args.task_id}. Use bash_output without task_id to list known background tasks.`,
				);
			}
			return textResult(taskDetailText(task));
		},
	};
}
