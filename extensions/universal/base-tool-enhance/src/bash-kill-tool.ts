/**
 * bash_kill 工具（D9，§3.5「bash_kill 终态收尾的单点归属」+ 跨进程边界段）。
 *
 * 职责边界：只负责杀进程树 + kill 前把单例表与 registry **两侧**标 killing intent
 * （查询面立即可见——kill 返回后 bash_output 即显示 killing，无「已 kill 仍 running」
 * 倒挂窗口）。实际终态（exited, reason:"killed"）由轮询器 exit 边沿收尾写——
 * bash_kill 不直接写终态（单一终态归属），也不 sendMessage（kill 调用方就在当前
 * turn 内等结果，再发 steer 通知是双发噪音——按 notify.ts 的单点归属规则，kill
 * 路径不 sendMessage，reason:"killed" 只 emit unregister，终态由 handleTaskExit 收尾）。
 *
 * kill 目标归属（§3.5）：**限定本进程单例表条目**；registry 回落限定终态条目
 * （exited/orphaned → already exited）——registry 中他进程的 running/killing 条目
 * **不可 kill**（跨进程边界：处置权归发起进程；孤儿收殓已下沉 xyz-agent runtime，
 * u-bte-remove 后由 background-task-reaper 按 ownerPiPid 属主判定处置）。
 * kill 前校验 pid 判活 + start time 匹配（防陈旧条目遇 pid 复用误杀无关进程，
 * 宁不杀勿误杀，§3.6 收殓侧同原则）。
 */

import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getProcessStartTimeSec, isPidAlive, killProcessTree } from "@xyz-agent/extension-protocol/background-task";
import { Type } from "typebox";

import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { ensurePollerRunning } from "./background/poller.ts";
import { getRegistryPath, readRegistry, taskToRegistryEntry, writeRegistryEntry } from "./background/registry.ts";
import { getAllTasks, markKillingIntent } from "./background/task-store.ts";
import { isActiveState, isTerminalState, type RegistryEntry } from "./background/types.ts";

const bashKillSchema = Type.Object({
	task_id: Type.String({ description: "Task id returned by the background bash tool." }),
});

const BASH_KILL_DESCRIPTION = [
	"Terminate a background bash task by killing its process tree (the task's whole process group).",
	"Returns immediately; poll bash_output {task_id} for the final exited state.",
].join("\n");

/** JSON 输出缩进（registry.ts 同款）。 */
const JSON_INDENT = 2;

const logger = getLogger("base-tool-enhance");

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

function killedFalse(reason: string, hint?: string): AgentToolResult<unknown> {
	return textResult(JSON.stringify({ killed: false, reason, ...(hint !== undefined ? { hint } : {}) }, null, JSON_INDENT));
}

export function createBashKillToolDefinition() {
	return {
		name: "bash_kill",
		label: "bash_kill",
		description: BASH_KILL_DESCRIPTION,
		parameters: bashKillSchema,
		async execute(
			_toolCallId: string,
			args: { task_id: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const sessionId = ctx.sessionManager.getSessionId();
			// 查找顺序（§3.5 kill 目标归属）：单例表（本进程，kill 权威目标）→ registry
			// 回落（限定终态——他进程 running/killing 条目不可 kill）
			const fromStore = getAllTasks().find((t) => t.taskId === args.task_id);
			if (fromStore === undefined) {
				const entry: RegistryEntry | undefined = readRegistry(getRegistryPath(getAgentDir(), sessionId)).get(
					args.task_id,
				);
				if (entry === undefined) {
					return killedFalse("no such task", "use bash_output to list");
				}
				if (isTerminalState(entry.state)) {
					return killedFalse(
						`already exited${entry.exitCode !== undefined && entry.exitCode !== null ? ` (code ${entry.exitCode})` : ""}`,
					);
				}
				// registry-only 活跃条目 = 他进程任务（本进程活跃任务必在单例表）——跨进程
				// 不可 kill：处置权归发起进程；属主若已死，孤儿由 xyz-agent runtime 在
				// session 销毁时或启动期兜底扫描时收殓（属主判定，u-bte-remove 下沉；
				// 纯 CLI 独立安装无 runtime 收殓兜底，孤儿自然退出或手动杀——E11 已
				// 接受边界，hint 按形态分流，不写死 runtime 承诺）
				return killedFalse(
					"cross-process running task owned by another pi process",
					"the task is managed by the pi process that started it (bash_kill from that session); " +
						"if that process is gone, the orphan keeps running until it exits on its own; " +
						"inside the xyz-agent runtime it is collected when the owner's session ends or on app restart; " +
						"standalone pi: kill the process group manually (kill -- -<pgid>; the registered task pid is the pgid) if it lingers",
				);
			}
			if (isTerminalState(fromStore.state)) {
				return killedFalse(
					`already exited${fromStore.exitCode !== undefined && fromStore.exitCode !== null ? ` (code ${fromStore.exitCode})` : ""}`,
				);
			}

			// pid 复用防御（§3.6 宁不杀勿误杀）：
			//  - pid 已死 → already exited 风格返回，不发 kill（终态由轮询边沿收尾）
			//  - 有 pidStartTime 字段 → 校验实际进程 start time 匹配；不匹配/读不到 =
			//    复用嫌疑，拒绝 kill 并说明
			//  - 无字段（spawn 时 ps 不可用平台）→ 放行：本进程轮询器 ≤2s 前判过活，
			//    复用窗口毫秒级；registry 终态条目不会走到这里（上面 already exited）
			if (!isPidAlive(fromStore.pid)) {
				return killedFalse("already exited (process no longer alive; final state pending poll)");
			}
			if (fromStore.pidStartTime !== undefined) {
				const actualStartSec = getProcessStartTimeSec(fromStore.pid);
				if (actualStartSec === undefined) {
					return killedFalse(
						"cannot verify process start time; refusing to kill (better safe than sorry)",
						`pid ${fromStore.pid} is alive but its start time is unreadable, so pid reuse cannot be ruled out; ` +
							"poll bash_output for the poll edge, or kill the process group manually if certain",
					);
				}
				if (actualStartSec !== fromStore.pidStartTime) {
					return killedFalse(
						`pid reuse suspected: recorded start time ${fromStore.pidStartTime} but actual ${actualStartSec}; refusing to kill`,
						`pid ${fromStore.pid} likely belongs to an unrelated recycled process now; ` +
							"if you are certain, kill the process group manually (kill -- -<pgid>)",
					);
				}
			}

			// 两侧标 killing intent（单例表内存标记 + registry 同步写盘）→ 再杀进程树。
			// intent 落盘在 kill 信号之前，查询面无倒挂窗口。markKillingIntent 只查
			// 单例表——可 kill 目标此时必在单例表（registry-only 活跃条目上面已拒绝、
			// registry 终态条目 already exited 返回），无另一侧需同步
			const marked = markKillingIntent(fromStore.taskId, "killed");
			if (marked !== undefined) {
				writeRegistryEntry(marked.registryPath, taskToRegistryEntry(marked));
			}
			// 回退路径诊断经 onFallback 注入 logger 适配（ext-simplify-13 D2：进程原语
			// 零日志依赖，协议侧 step 标识符 + 本包落盘通道）
			killProcessTree(fromStore.pid, (step, err) =>
				logger.debug(step, {
					detail: { pid: fromStore.pid, err: toErrorMessage(err) },
				}),
			);
			// 轮询器确保在跑：边沿收尾（写终态）依赖它
			ensurePollerRunning();
			return textResult(
				JSON.stringify(
					{
						killed: true,
						reason: isActiveState(fromStore.state)
							? "kill signal sent; poll bash_output for the final state"
							: "kill signal re-sent; poll bash_output for the final state",
					},
					null,
					JSON_INDENT,
				),
			);
		},
	};
}
