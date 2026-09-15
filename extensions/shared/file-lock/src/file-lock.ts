// src/file-lock.ts
//
// 跨进程同步文件锁（extension 侧共享 util，D5a/D1e，integrity-hardening.md §3.5）。
//
// 为什么存在：worktrees.json（多 pi 进程各一份扩展实例写）与 ext-config 家族
// （runtime + 扩展双写）都是跨进程 RMW——Node 单线程只能保证进程内不交错，
// 挡不住跨进程「后写者基于旧快照覆盖先写者」。
//
// 锁原语：自实现 mkdir-lock（src/lock-core.ts，D1-A，零第三方依赖）。磁盘协议与
// pi 内嵌 proper-lockfile@4.1.2 逐字段兼容（协议细节与行为边界声明见 lock-core.ts
// 头注释——关键边界：无周期保活 touch，临界区必须远小于 stale）。本文件职责：
// sync busy-wait 重试编排 + 对外 API + 诊断 logger 装配（logger 本体由包入口
// index.ts 注入，本文件不 import extension-logger——lock-core 的零依赖约束向上传导）。
//
// 锁协议（与 runtime 侧 packages/runtime/src/utils/file-lock.ts 对齐，登记表
// docs/architecture/data-source-registry.md §6）：
//   - lockfile 路径 = <目标文件>.lock（双方路径一致才互斥）
//   - realpath:false —— 目标文件不存在也可锁；不解析 symlink
//   - stale 30s：持锁进程崩溃后锁可被夺取（对齐 auth 惯例）
//   - sync 版 busy-wait 重试（25ms / 预算 1s fail-fast）：对齐 runtime 侧
//     withFileLockSync；ext-config 家族的扩展侧写方（saveConfig）保持 sync 签名
//     （调用链零波及），与 runtime 对端用同一把 lockfile 互斥
//   - onCompromised 语义随保活 touch 一并移除（无保活则无 compromise 检测）：
//     锁目录被外部删除时 release 静默成功（ENOENT 容忍，见 lock-core.ts removeLock）
//
// 契约：fn 内仅做既定读改写（读目标文件 + 纯内存变更 + 原子写），禁其他 I/O /
// 再次对本文件加锁（嵌套取锁 ELOCKED → 重试耗尽 → 抛错），毫秒级完成（必须
// 远小于 stale 30s——无保活 touch，超时持锁会被对端夺取）。

import { acquireLockSync, DEFAULT_STALE_MS } from "./lock-core";

export { DEFAULT_STALE_MS };

/** sync 版锁参数（对齐 runtime withFileLockSync 默认值；测试可覆盖以缩短等待）。 */
export interface SyncFileLockOptions {
	/** 锁 mtime 超过该值视为持锁者已死可夺取（stale 语义）。默认 30_000ms。 */
	staleMs?: number;
	/** ELOCKED 重试间隔（同步 sleep）。默认 25ms。 */
	retryDelayMs?: number;
	/** ELOCKED 重试总预算，耗尽 fail-fast。默认 1_000ms。 */
	retryBudgetMs?: number;
}

// 默认锁参数（sync 版导出供对照测试断言与 runtime 侧 utils/file-lock.ts 默认值相等
// ——互斥由 lockfile 路径 + mkdir 原子协议保证，默认值对齐锚定的是两侧夺取时机
// （stale）与失败速度（重试参数）行为一致；runtime 侧 test/file-lock-parity.test.ts）
export const DEFAULT_RETRY_DELAY_MS = 25;
export const DEFAULT_RETRY_BUDGET_MS = 1_000;

// 诊断 logger：由包入口 index.ts 经 setFileLockLogger 注入（core 不沾 logger 依赖）。
// 默认 no-op——不经入口直接 import 本文件的测试/工具静默无日志。
let diagnosticsLogger: ((msg: string) => void) | undefined;

/**
 * 注入诊断日志函数（包入口装配点；传 undefined 恢复 no-op）。
 * 诊断内容：stale 夺取、release 失败等关键分支。
 */
export function setFileLockLogger(log?: (msg: string) => void): void {
	diagnosticsLogger = log;
}

/**
 * 同步跨进程文件锁内执行 fn：ELOCKED busy-wait 重试，预算耗尽抛带 ELOCKED code
 * 的错误；unlock 放 finally（fn 抛错也释放）。
 *
 * 与 runtime 侧 sync 实现（packages/runtime/src/utils/file-lock.ts 的
 * withFileLockSync）同协议——同一把 lockfile（<目标文件>.lock），互斥不依赖
 * 实现归属。适用场景：调用链必须保持 sync 签名（如 llm-shared saveConfig，
 * permission/rename-session 的命令回调零波及）。
 * sleep 用 Atomics.wait（真 sleep 不烧 CPU，对齐 runtime 侧实现）。
 */
export function withFileLockSync<T>(
	filePath: string,
	fn: () => T,
	opts?: SyncFileLockOptions,
): T {
	const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
	const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const retryBudgetMs = opts?.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;

	const deadline = Date.now() + retryBudgetMs;
	let release: (() => void) | undefined;
	while (release === undefined) {
		try {
			release = acquireLockSync(filePath, { staleMs, log: diagnosticsLogger });
		} catch (err) {
			if (!isElocked(err)) throw err;
			if (Date.now() >= deadline) {
				throw Object.assign(
					new Error(
						`[file-lock] ${filePath} 写锁获取失败：ELOCKED 重试预算 ${retryBudgetMs}ms 耗尽` +
						`（持锁方临界区异常或已崩溃，stale ${staleMs}ms 后可夺取）。恢复指引：稍后重试本次写入。`,
						// cause 挂原始 ELOCKED 错误，保留锁原语诊断信息
						{ cause: err },
					),
					{ code: "ELOCKED" },
				);
			}
			sleepSync(retryDelayMs);
		}
	}
	try {
		return fn();
	} finally {
		release();
	}
}

function isElocked(err: unknown): boolean {
	// in 收窄而非 as 断言（extensions taste/no-unsafe-catch：全可选属性断言 = 无校验）
	return err instanceof Error && "code" in err && err.code === "ELOCKED";
}

/** Atomics.wait 需要一个共享内存对象作等待目标；4 字节 = 一个 Int32 元素，仅占位不被写入。 */
const SLEEP_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function sleepSync(ms: number): void {
	Atomics.wait(SLEEP_WAIT_BUFFER, 0, 0, ms);
}
