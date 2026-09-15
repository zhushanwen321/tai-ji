/**
 * 完成通知与 pending-notifications 接入（M3，设计 §3.5 数据流 ⑤⑧⑨ / §3.3 D5·D17）。
 *
 * 通道形态（与 pending-notifications index.ts listener / subagent-workflow notifier
 * 先例对齐——先例经父进程 IPC 投递与本包同进程异步时机不同构，探针 P3 已实测）：
 *  - register/unregister 经 pi.events.emit（EventBus，pending 侧 pi.events.on 消费）
 *  - 完成通知经 pi.sendMessage({customType, content, display:true},
 *    {deliverAs:"steer", triggerTurn:true}) 驱动新 turn
 *
 * D17 pi 引用刷新：轮询器与通知通路持模块级「当前 pi 引用」——同进程 session 替换
 * （/fork、选择器切换、RPC session.*）会重建 eventBus 并重新 load extension，本
 * 模块引用由新实例 load 时 refreshPiReference 刷新，完成通知投递新 session。
 *
 * 已知竞态（设计 §3.5 原样登记，不修）：dispose → 新实例 load 间毫秒窗口任务恰好
 * 完成时，sendMessage/emit 落旧 bus 丢一条——对账在该 session 重开时补 unregister，
 * 完成内容可由 bash_output 查询；窗口极窄且后果可恢复，不加同步握手。旧引用 throw
 * （旧 bus 已 dispose）时捕获降级为日志，不中断轮询（后续任务仍可通知）。
 *
 * kill 路径不 sendMessage（§3.5「bash_kill 终态收尾的单点归属」）：reason:"killed"
 * 只 emit unregister——kill 调用方就在当前 turn 等结果，双发是噪音。
 *
 * peer 版本门槛（D16 独立安装场景）——运行时检测**降级为静态声明**：pi 0.84.1 的
 * ExtensionAPI/ExtensionContext 均无「枚举已加载 extensions」接口（types.d.ts 全文
 * 核实，LoadExtensionsResult 是 loader 内部结果不经 pi 暴露），EventBus 探针式握手
 * 属硬造检测机制（设计禁止）。登记落点：package.json peerDependencies（optional，
 * 未装则通知链路缺失但 bash 后台功能完整）+ extension-dependencies.json dependsOn。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import type { BackgroundTask, BackgroundTaskEndReason } from "./types.ts";

const logger = getLogger("base-tool-enhance");

/**
 * 通知消息 customType：桌面 custom_message 通用渲染通道（subagent-bg-notify 先例，
 * §3.1 用户视角「对话流中以 custom entry 形式出现」）。
 */
export const BACKGROUND_BASH_CUSTOM_TYPE = "background-bash";

/**
 * pending register 的 name 截断长度（§3.5 数据流 ⑤「command 前 80 字符」）。
 * 与 spawn-background COMMAND_DISPLAY_LIMIT 同值但刻意不共享 import——notify 被
 * spawn-background import，反向 import 会造成 spawn ↔ notify 循环依赖；两处语义
 * （pending 列表展示 / 错误文案展示）各自独立演化，仅数值对齐。
 */
const PENDING_NAME_LIMIT = 80;

/** 模块级「当前 pi 引用」（D17 核心可变状态，见文件头）。 */
let currentPi: ExtensionAPI | undefined;

/**
 * 刷新当前 pi 引用：extension 实例 load 时调用（index.ts 接线）。
 * session 替换 → extension 重新 load → 引用指向新 pi → 完成通知投递新 session。
 */
export function refreshPiReference(pi: ExtensionAPI): void {
	currentPi = pi;
}

/** 测试专用：复位模块级 pi 引用（跨测试文件残留清理）。 */
export function resetNotifyForTest(): void {
	currentPi = undefined;
}

/**
 * 本包终态 reason → pending reason 字符串。
 * 映射值全部落在 pending-notifications mapReasonToStatus 的已知分支（四个值在该
 * switch 全部直通同名 status），保证 emit 后 listener 算出的 status 与本包预期一致：
 *  - natural + exitCode 0 → "completed"（正常完成）
 *  - natural + 非零/不可知 → "failed"（§3.1 失败路径：通知带 error 与末尾输出摘要）
 *  - timeout   → "time_limited"
 *  - killed    → "cancelled"
 *  - process-exit → "cancelled"（进程退出收殓终止，非任务自身成败）
 */
export function toPendingReason(
	reason: BackgroundTaskEndReason,
	exitCode: number | null | undefined,
): "completed" | "failed" | "time_limited" | "cancelled" {
	switch (reason) {
		case "timeout":
			return "time_limited";
		case "killed":
		case "process-exit":
			return "cancelled";
		default:
			// natural：exit 0 = 成功；非零（含 null 不可知，保守按失败处理引导查看输出）
			return exitCode === 0 ? "completed" : "failed";
	}
}

/**
 * ⑤ 登记成功后 emit pending:register（§3.5 数据流 ⑤）。
 * 形态对齐 pending-notifications parseRegisterEvent 期望：{id, type, name}——
 * type:"bash" 经 D16 直通（process 档），**不携带 expiresAt**（该字段由 pending 侧
 * listener 按分档决定，process 档落盘省略）。引用未注入或 emit throw（旧 bus）时
 * 静默降级——pending 差集只影响通知链路，不影响任务本体。
 */
export function emitPendingRegister(task: BackgroundTask): void {
	const pi = currentPi;
	if (pi === undefined) return;
	const name =
		task.command.length > PENDING_NAME_LIMIT
			? `${task.command.slice(0, PENDING_NAME_LIMIT)}…`
			: task.command;
	try {
		pi.events.emit("pending:register", { id: task.taskId, type: "bash", name });
	} catch (err) {
		logger.warn("pending:register emit failed (stale bus?); task unaffected", {
			detail: { taskId: task.taskId, err: toErrorMessage(err) },
		});
	}
}

/**
 * ⑧ emit pending:unregister（§3.5 数据流 ⑧）。
 * data 形态对齐 pending-notifications parseUnregisterEvent 期望：{id, reason}——
 * status 不在 emit data 里（listener 用 mapReasonToStatus(reason) 自行计算）；
 * appendEntry 侧（对账/收殓）的落盘形态 {id, reason, status} 见 pending-reconcile.ts。
 * 轮询器 exit 边沿与进程退出收殓两条路径共用。
 */
export function emitPendingUnregister(
	taskId: string,
	reason: BackgroundTaskEndReason,
	exitCode: number | null | undefined,
): void {
	const pi = currentPi;
	if (pi === undefined) return;
	try {
		pi.events.emit("pending:unregister", { id: taskId, reason: toPendingReason(reason, exitCode) });
	} catch (err) {
		logger.warn("pending:unregister emit failed (stale bus?); reconcile covers on next session_start", {
			detail: { taskId, err: toErrorMessage(err) },
		});
	}
}

/**
 * ⑧⑨ 轮询器 exit 边沿的完成通知入口（poller setOnTaskExit 接线，index.ts load 时挂）。
 * 入参是 finalizeTask 之后的终态条目（state=exited）。kill 路径不 sendMessage
 * （文件头）；process-exit 不经过这里（收殓路径直接 finalizeTask + 只 emit）。
 */
export function handleTaskExit(task: BackgroundTask): void {
	emitPendingUnregister(task.taskId, task.reason ?? "natural", task.exitCode ?? null);
	if (task.reason === "killed") return;
	sendTaskFinishedMessage(task);
}

/** ⑨ sendMessage steer 驱动新 turn（探针 P3 已实测同进程异步时机可用）。 */
function sendTaskFinishedMessage(task: BackgroundTask): void {
	const pi = currentPi;
	if (pi === undefined) return;
	try {
		pi.sendMessage(
			{ customType: BACKGROUND_BASH_CUSTOM_TYPE, content: buildNotificationContent(task), display: true },
			{ deliverAs: "steer", triggerTurn: true },
		);
	} catch (err) {
		// 旧 bus 已 dispose（session 替换毫秒窗口）——降级日志，不中断轮询（文件头已知竞态）
		logger.warn("background task notify sendMessage failed; poll continues", {
			detail: {
				taskId: task.taskId,
				err: toErrorMessage(err),
			},
		});
	}
}

/**
 * 通知文案（§3.1 终态样例）：
 *
 *   [background-bash] bt-x finished (exit 0, 3m12s): pnpm test
 *   Last lines: ... Tests: 42 passed ...
 *   Full output: <path>; use bash_output {task_id:"bt-x"} for details.
 *
 * 失败任务 head 行标 failed（exit code 即 error 摘要，尾部输出佐证）；timeout 标
 * timed out；tailSummary 为空（无输出/文件丢失）时省略 Last lines 行。
 */
export function buildNotificationContent(task: BackgroundTask): string {
	const duration = formatDurationMs(task.durationMs ?? 0);
	const command =
		task.command.length > PENDING_NAME_LIMIT
			? `${task.command.slice(0, PENDING_NAME_LIMIT)}…`
			: task.command;
	let head: string;
	if (task.reason === "timeout") {
		head = `[background-bash] ${task.taskId} timed out (${duration}): ${command}`;
	} else if (task.exitCode === 0) {
		head = `[background-bash] ${task.taskId} finished (exit 0, ${duration}): ${command}`;
	} else {
		head = `[background-bash] ${task.taskId} failed (exit ${task.exitCode ?? "unknown"}, ${duration}): ${command}`;
	}
	const lines = [head];
	if (task.tailSummary !== undefined && task.tailSummary.length > 0) {
		lines.push(`Last lines: ${task.tailSummary}`);
	}
	lines.push(`Full output: ${task.outputFile}; use bash_output {task_id:"${task.taskId}"} for details.`);
	return lines.join("\n");
}

/** 耗时换算常量（毫秒/秒/分/时 + 时分两位补零宽度）。 */
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const TWO_DIGIT_WIDTH = 2;

/** 耗时格式：秒内 "45s" → 分 "3m12s" → 时 "1h02m03s"（时/分段补零两位）。 */
function formatDurationMs(ms: number): string {
	const totalSec = Math.max(0, Math.round(ms / MS_PER_SECOND));
	const sec = totalSec % SECONDS_PER_MINUTE;
	const min = Math.floor(totalSec / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
	const hour = Math.floor(totalSec / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR));
	if (hour > 0) {
		return `${hour}h${String(min).padStart(TWO_DIGIT_WIDTH, "0")}m${String(sec).padStart(TWO_DIGIT_WIDTH, "0")}s`;
	}
	if (min > 0) return `${min}m${sec}s`;
	return `${totalSec}s`;
}
