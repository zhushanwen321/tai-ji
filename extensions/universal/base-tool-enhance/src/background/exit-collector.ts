/**
 * exit 边沿收尾（ADR-0112 改造：原 2s kill(pid,0) 轮询器已删，感知归 ChildProcess
 * exit 事件——事件驱动，无时间驱动成分）。
 *
 * 为什么事件可用（原 D17 轮询的根因已消解）：同进程 session 替换（fork/switch/new）
 * 重建 eventBus 并重新 load extension 实例，但 jiti 模块体只执行一次——本模块与
 * task-store / notify 均为模块级单例，跨替换存活；exit 监听挂在 ChildProcess 对象
 * （进程内实体，与 bus 生命周期无关）上，回调链（finalizeExitedTask → task-store
 * 模块级表 → notify 模块级 currentPi）不含任何实例级 bus/pi 引用。通知可达性由
 * notify.ts 的 D17 pi 引用刷新承担（新实例 load 时 refreshPiReference 指向新 pi）。
 *
 * 幂等：exit 事件与 bash_kill / timeout 收尾并发时，finalizeTask 的终态守卫
 * （isTerminalState）保证单一终态归属，先到者写、后到者 no-op。
 *
 * 已知竞态（设计文档 §3.5 原样登记，不修）：同进程 session 替换 dispose → 新实例
 * load 间毫秒窗口任务恰好完成时通知可能落旧 bus——窗口极窄且后果可恢复（bash_output
 * 可查、对账可补），不加同步握手。父进程死亡场景不归本模块（exit 监听随进程消失，
 * 由 process-exit-guard 收殓 + runtime 孤儿收殓兜底）。
 */

import { readTailSummary } from "./output-tail.ts";
import { readRegistry, taskToRegistryEntry, writeRegistryEntry } from "./registry.ts";
import { finalizeTask } from "./task-store.ts";
import type { BackgroundTask, BackgroundTaskEndReason } from "./types.ts";

/**
 * M3 通知接入点（本单元 no-op 占位）：exit 边沿收尾（单例表 + registry 终态写完）
 * 之后同步回调。M3 在这里接 pending:unregister emit + sendMessage steer。
 */
let onTaskExitCallback: ((task: BackgroundTask) => void) | undefined;

export function setOnTaskExit(callback: ((task: BackgroundTask) => void) | undefined): void {
	onTaskExitCallback = callback;
}

/**
 * spawn 登记时挂接 exit 监听（唯一调用点 = spawn-background.ts）：
 * exit 边沿触发收尾（读 exitCode → 组装 tail 摘要 → reason 判定 → 两侧写终态 →
 * M3 回调）。error 监听仍由 spawn 侧持 no-op（spawn 异步失败只防崩溃，不推进状态
 * ——spawn 失败即无 pid 无任务）。
 */
export function attachExitCollector(task: BackgroundTask): void {
	task.child?.on("exit", () => {
		finalizeExitedTask(task);
	});
}

/**
 * exit 边沿收尾（单一终态归属）：读 exitCode → 组装 tail 摘要 → reason 判定
 * （内存 intent 优先：intent.killed → "killed"、intent.timeout → "timeout"；intent
 * 缺省 → 读回 registry：state==="killing" → "killed"（D6-en，跨进程 UI 代杀预写），
 * 否则/读失败 → "natural"；"process-exit" 由收殓路径直接调 finalizeTask，不经这里）
 * → 单例表 + registry 两侧写终态 → 触发 onTaskExit 回调（M3 接入点）。
 */
function finalizeExitedTask(task: BackgroundTask): void {
	const exitCode = task.child?.exitCode ?? null;
	const reason = task.intent !== undefined ? task.intent.reason : readBackReasonFromRegistry(task);
	const endedAt = Date.now();
	const tailSummary = readTailSummary(task.outputFile);
	const finalized = finalizeTask(task.taskId, { exitCode, reason, endedAt, tailSummary });
	if (finalized === undefined) return;
	writeRegistryEntry(finalized.registryPath, taskToRegistryEntry(finalized));
	onTaskExitCallback?.(finalized);
}

/**
 * D6-en intent 读回：内存 intent 缺省时读回本条目的 registry 条目——
 * state==="killing" ↔ reason=killed。跨进程 UI 代杀（runtime kill handler）只写
 * registry 侧 killing（对 pi 内存表不可见），且 killing 条目落盘剥离 intent
 * （taskToRegistryEntry），state 字段是唯一可读信号；判 killed 后 handleTaskExit
 * 不 sendMessage → 主路径 AI 零感知（background-task-sidebar-view 设计 D6-en）。
 * 读失败/条目缺失/状态非 killing → 按无 intent（"natural"）处理，不阻塞终态化
 * （readRegistry 对读失败/损坏一律返回空表，读侧无锁依赖 tmp+rename 原子写）。
 * 内存 intent 存在时不进入本函数（本进程 bash_kill/timeout 预写是内存权威，
 * 不读回——见 task-store.ts 头部不变量登记）。
 */
function readBackReasonFromRegistry(task: BackgroundTask): BackgroundTaskEndReason {
	const entry = readRegistry(task.registryPath).get(task.taskId);
	return entry?.state === "killing" ? "killed" : "natural";
}
