/**
 * pi 进程退出收殓（D12：后台任务生命周期绑定 pi 进程，不绑定 session）。
 *
 * 绝不能挂在 extension dispose / session_shutdown 上——session 替换（fork/switch/new）
 * 也触发它们，那会误杀全部后台任务（任务跨同进程 session 替换继续运行）。收殓只认
 * process 级信号与进程退出：
 *  - SIGTERM handler：只收殓不 exit（pi rpc-mode 自有 SIGTERM → shutdown 流程，抢
 *    exit 会打断其 tracked-pid 清理与日志 flush），随后 process.exit 触发下方兜底
 *  - process.on("exit")：同步兜底路径——kill-tree 同步 kill + registry 同步原子写
 *  - 幂等：cleaned flag 保证信号 handler 先跑收殓后，exit 兜底再跑一次无害
 *
 * 不挂 SIGINT handler（pi 0.84.1 实装核实，2026-08 review 轮修复）：
 *  - TUI 常态 raw mode，Ctrl+C 是按键不走信号；唯一收到 SIGINT 的 TUI 场景是挂起态
 *    （cooked mode），而 pi 挂起态刻意注册 ignoreSigint 免疫 Ctrl+C
 *    （interactive-mode.js「Ignore SIGINT while suspended」）。Node 对同一信号调用
 *    全部 listener，本包任何 SIGINT listener（含 once）都会在此刻被触发——cleanup
 *    杀光后台任务（违背 D15「interrupt 不传播后台任务」）再 exit 掐死本应存活的
 *    挂起进程，pi 的 ignore 语义完全失效
 *  - rpc/print 模式 Ctrl+C：pi 无 SIGINT listener（dist 全量 grep 唯一注册点在 TUI
 *    挂起态）→ 默认处置进程即死。探针实测：无 listener 的信号默认终止**不触发
 *    exit 事件**，同步收殓在该路径本就不可达；孤儿由 xyz-agent runtime 收殓器按
 *    属主判定收殓（u-bte-remove 下沉后；与 SIGKILL 强杀同类，设计内兜底）
 *  - cleanup-only listener 更不可取：注册即抑制默认终止，rpc 前台 Ctrl+C 后 pi 变
 *    成杀不死的僵尸进程
 *
 * 子进程死后 registry 目录由 xyz-agent runtime 启动期兜底扫描覆盖（收殓下沉）——
 * 本单元不管。
 */

import { killProcessTree } from "@xyz-agent/extension-protocol/background-task";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { emitPendingUnregister } from "./notify.ts";
import { stopPoller } from "./poller.ts";
import { taskToRegistryEntry, writeRegistryEntry } from "./registry.ts";
import { finalizeTask, getActiveTasks } from "./task-store.ts";

const logger = getLogger("base-tool-enhance");

let installed = false;
let cleaned = false;

/**
 * 安装进程级收殓（幂等，extension load 时调用一次；同进程 session 替换重新 load
 * 不会重复挂 handler——模块级 installed flag）。
 */
export function installProcessExitGuard(): void {
	if (installed) return;
	installed = true;

	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		reapBackgroundTasksNow();
	};

	// SIGTERM：只收殓不 exit——pi rpc-mode 的 SIGTERM handler（先注册先跑）走自己的
	// shutdown 流程，最终 process.exit 触发下方 exit 兜底（幂等跳过）。
	// SIGINT 刻意不挂 handler——会破坏 pi TUI 挂起态的 ignoreSigint 语义，且 rpc
	// 默认终止路径 exit 事件本就不触发、孤儿归 runtime 收殓兜底（完整论证见文件头
	// 「不挂 SIGINT handler」专段）
	process.once("SIGTERM", cleanup);
	// 同步兜底：exit handler 里只能做同步收殓（kill-tree 同步 + registry 同步原子写）
	process.on("exit", cleanup);
}

/**
 * 收殓动作（导出供测试直接调用，不真杀 pi 进程）：
 * 轮询器停止 → 遍历**单例表**活跃条目 kill-tree（单例表 = 本进程任务全集，天然
 * 不含他进程条目——不遍历 registry，否则 ephemeral 附着进程退出会误杀属主进程的
 * 任务）→ registry 写终态 exited(reason:"process-exit")。
 *
 * 终态与轮询器边沿共用 finalizeTask（单一终态归属）。
 */
export function reapBackgroundTasksNow(): void {
	stopPoller();
		for (const task of getActiveTasks()) {
			try {
				// 回退路径诊断经 onFallback 注入 logger 适配（ext-simplify-13 D2）
				killProcessTree(task.pid, (step, err) =>
					logger.debug(step, {
						detail: { pid: task.pid, err: err instanceof Error ? err.message : String(err) },
					}),
				);
			} catch (err) {
			// 单条 kill 失败不阻断其余条目收殓；进程将退出，残余由 runtime 收殓兜底
			logger.warn("kill-tree failed during process-exit reap", {
				detail: { taskId: task.taskId, pid: task.pid, err: err instanceof Error ? err.message : String(err) },
			});
		}
		const finalized = finalizeTask(task.taskId, {
			exitCode: task.child?.exitCode ?? null,
			reason: "process-exit",
			endedAt: Date.now(),
		});
		if (finalized !== undefined) {
			writeRegistryEntry(finalized.registryPath, taskToRegistryEntry(finalized));
			// 尽力补 emit pending:unregister（§3.5「pi API 若仍可用」）：SIGTERM
			// 信号路径 pi 引用尚活（emit 经模块级 notify 引用，bus 未 dispose 时送达
			// pending listener 落盘）；process.on("exit") 同步路径 bus 可能已 dispose，
			// emit throw 被 notify 内部捕获降级——残留由 session_start 对账兜底。
			// **不 sendMessage**：进程都退了，无投递目标。
			emitPendingUnregister(finalized.taskId, "process-exit", finalized.exitCode ?? null);
		}
	}
}

/** 测试专用：复位幂等 flag（clearTaskStoreForTest 配套）。 */
export function resetProcessExitGuardForTest(): void {
	installed = false;
	cleaned = false;
}
