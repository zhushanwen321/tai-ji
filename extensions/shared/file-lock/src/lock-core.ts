// src/lock-core.ts
//
// 零依赖跨进程 mkdir 锁原语（D1-A 自实现，docs/architecture/file-lock-unification-and-reaper-sink.md §3.2）。
//
// 为什么自实现：包名入口原先包 proper-lockfile，但 runtime 经 tsup bundle 复用它时，
// 第三方对模块对象的内部操作（probe 精度缓存的 fs symbol）在 jiti 类加载器下失效——
// 本次事故根因。本文件只用 node:fs / node:path 内置调用实现同一磁盘协议，天然免疫
// 模块系统包装；runtime 经 `@zhushanwen/pi-file-lock/core` 子入口复用同一实现。
//
// 磁盘协议（逐字段照抄 proper-lockfile@4.1.2 实装 lib/lockfile.js——与 pi 内嵌版互斥
// 同一把锁的兼容性权威源；4.1.2 的 acquireLock/releaseLock 已内联在该文件）：
//   - 锁文件 = path.resolve(目标) + '.lock' 目录（mkdir 原子上锁）。realpath:false 分支：
//     仅字符串绝对化（path.resolve），不解析 symlink
//   - mkdir EEXIST → stat 锁目录 mtime，`mtime < Date.now() - stale` 判死；stale 下限
//     clamp 2000ms（照抄 `options.stale = Math.max(options.stale || 0, 2000)`）
//   - stale → 先 rmdir 再 mkdir 夺取。两步间存在竞态窗口（他方同时夺取），与
//     proper-lockfile 语义一致，接受
//   - 判死检查中锁目录 ENOENT（他方刚释放/刚夺取）→ 以 stale:0 重试（跳过判死直接
//     mkdir，失败即 ELOCKED），照抄防无限递归的结构
//   - 释放 = rmdir，容忍 ENOENT（照抄 removeLock）
//   - graceful exit 兜底：process.on('exit') 配对 rmdirSync，避免优雅退出后锁残留
//     要等 30s stale 才能夺取。覆盖范围边界：'exit' 只覆盖正常退出与 process.exit；
//     信号默认终止（SIGINT/SIGTERM 无 handler）场景 'exit' 不触发（proper-lockfile
//     经 signal-exit 额外覆盖该路径），锁残留回退 30s stale 夺取（同 SIGKILL 崩溃路径）
//
// 与 proper-lockfile 的行为边界（设计显式决策，非遗漏）：
//   - 不做周期 utimes 保活（proper-lockfile 的 updateLock 定时器）：现有契约临界区
//     毫秒级，远小于 stale/2；持锁超过 stale 的进程视为已死可被夺取。锁 mtime 即
//     mkdir 时刻，此后不变
//   - 因此无 compromise 检测（保活定时器 stat/utimes 失败路径不存在）；release 对
//     锁目录已被外部删除的场景静默成功（ENOENT 容忍）
//   - 被夺取后 release 的二阶后果：本方持锁被对端 stale 夺取后，本方 release 的
//     rmdir（及 exit-hook）会删除夺取者新建的锁目录——proper-lockfile 同场景由
//     updateLock 发现 mtime 非 ours 而拒绝 unlock，自实现无保活故无此防线。
//     触发前提 = 临界区违约超 stale 30s（契约要求毫秒级，违约 30000 倍才可达），
//     风险接受（设计显式决策，此处显式声明）
//
// 零依赖约束（D1-A）：本文件不得 import 任何项目内包或第三方包——extension-logger
// 携带 pi SDK peerDep 链，经 runtime re-export 会穿越 pi 边界。诊断日志走 opts.log
// 注入（包入口 index.ts 注入 extension-logger，runtime 不注入）。

import { mkdirSync, rmdirSync, statSync } from "node:fs";
import { mkdir, rmdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** 锁 mtime 超过该值视为持锁者已死可夺取。默认 30_000ms（对齐 auth 惯例）。 */
export const DEFAULT_STALE_MS = 30_000;

/** stale 判死下限 clamp（照抄 proper-lockfile：`Math.max(options.stale || 0, 2000)`）。 */
const MIN_STALE_MS = 2_000;

/** 锁原语选项（内部参数类型：重试/常量编排属消费方，runtime 传字面量不 import 本类型）。 */
interface LockCoreOptions {
	/** 锁 mtime 超过该值视为持锁者已死可夺取。下限 clamp 2000ms。默认 DEFAULT_STALE_MS。 */
	staleMs?: number;
	/** 诊断日志注入（stale 夺取等关键分支）。core 自身零输出。 */
	log?: (msg: string) => void;
}

/** async release 函数：释放锁目录（幂等；锁目录已消失时静默成功）。 */
export type LockRelease = () => Promise<void>;

// ──────────────────────── 协议原语（照抄 lockfile.js 对应函数） ────────────────────────

/** realpath:false 分支：仅字符串绝对化，不解析 symlink（照抄 resolveCanonicalPath）。 */
function resolveTarget(filePath: string): string {
	return resolve(filePath);
}

/** 照抄 getLockFile：`options.lockfilePath || \`${file}.lock\``（不自定义 lockfilePath）。 */
function lockPathOf(target: string): string {
	return `${target}.lock`;
}

/** 照抄 isLockStale：`stat.mtime.getTime() < Date.now() - stale`。 */
function isLockStale(mtimeMs: number, staleMs: number): boolean {
	return mtimeMs < Date.now() - staleMs;
}

/** ELOCKED 错误（message/fields 照抄 proper-lockfile）。 */
function elocked(target: string): Error {
	return Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file: target });
}

/** Node fs 错误 code 收窄（in 收窄，禁 as 断言——taste/no-unsafe-cast）。 */
function errCode(err: unknown): string | undefined {
	return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/** 锁前确保父目录存在（mkdir lockfile 需要；recursive 对已存在目录静默成功）。 */
async function ensureParentDir(target: string): Promise<void> {
	await mkdir(dirname(target), { recursive: true });
}

// ──────────────────────── graceful exit 兜底（照抄 signal-exit 清理语义） ────────────────────────

/**
 * 当前进程持有的活跃锁（key = lockfilePath，value = 该锁的诊断 log 注入）。
 * release/夺取移除时同步删表。
 */
const activeLocks = new Map<string, ((msg: string) => void) | undefined>();

let exitHookInstalled = false;

/**
 * 进程退出点配对清理（模块级注册一次）：exit handler 内只能同步操作，用 rmdirSync。
 * 单把锁清理失败仅经注入 log 留痕、不阻断其余锁清理——进程已终止，无恢复动作
 * （对齐 proper-lockfile onExit 的逐把 try/catch，可观测性略强）。
 */
function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const [lockfilePath, log] of activeLocks) {
			try {
				rmdirSync(lockfilePath);
			} catch (err) {
				log?.(`[lock-core] exit cleanup failed for ${lockfilePath}: ${errCode(err) ?? String(err)}`);
			}
		}
		activeLocks.clear();
	});
}

/** 单次释放（rmdir，容忍 ENOENT——照抄 removeLock）。 */
async function removeLockAsync(lockfilePath: string): Promise<void> {
	try {
		await rmdir(lockfilePath);
	} catch (err) {
		if (errCode(err) !== "ENOENT") throw err;
	}
}

/** removeLockAsync 的同步版。 */
function removeLockSync(lockfilePath: string): void {
	try {
		rmdirSync(lockfilePath);
	} catch (err) {
		if (errCode(err) !== "ENOENT") throw err;
	}
}

/** release 闭包：幂等（二调 no-op）；释放即出活跃锁表。 */
function makeRelease(lockfilePath: string): LockRelease {
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		activeLocks.delete(lockfilePath);
		await removeLockAsync(lockfilePath);
	};
}

// ──────────────────────── acquire ────────────────────────

/**
 * 照抄 acquireLock（async 版）：mkdir 成功即获锁；EEXIST → stale 判死 → 夺取；
 * stale<=0（重试轮）直接 ELOCKED，跳过判死防递归。
 */
async function acquireOnceAsync(target: string, lockfilePath: string, staleMs: number, log: ((msg: string) => void) | undefined): Promise<void> {
	let acquired = false;
	try {
		await mkdir(lockfilePath);
		acquired = true;
	} catch (err) {
		if (errCode(err) !== "EEXIST") throw err;
	}

	if (acquired) {
		activeLocks.set(lockfilePath, log);
		return;
	}

	// 重试轮（stale:0）：不再判死，失败即 ELOCKED（照抄 `options.stale <= 0` 分支）
	if (staleMs <= 0) throw elocked(target);

	let mtimeMs: number;
	try {
		mtimeMs = (await stat(lockfilePath)).mtime.getTime();
	} catch (err) {
		// 锁目录刚被释放/夺取：跳过判死直接重试（照抄 ENOENT → stale:0 重入，防递归）
		if (errCode(err) === "ENOENT") return acquireOnceAsync(target, lockfilePath, 0, log);
		throw err;
	}

	if (!isLockStale(mtimeMs, staleMs)) throw elocked(target);

	log?.(`[lock-core] stale lock taken over: ${lockfilePath} (mtime age > ${staleMs}ms), removing and retrying`);
	await removeLockAsync(lockfilePath);
	return acquireOnceAsync(target, lockfilePath, 0, log);
}

/**
 * acquireLockSync（照抄 acquireLock 的 sync 语义，同构 acquireOnceAsync）。
 */
function acquireOnceSync(target: string, lockfilePath: string, staleMs: number, log: ((msg: string) => void) | undefined): void {
	let acquired = false;
	try {
		mkdirSync(lockfilePath);
		acquired = true;
	} catch (err) {
		if (errCode(err) !== "EEXIST") throw err;
	}

	if (acquired) {
		activeLocks.set(lockfilePath, log);
		return;
	}

	if (staleMs <= 0) throw elocked(target);

	let mtimeMs: number;
	try {
		mtimeMs = statSync(lockfilePath).mtime.getTime();
	} catch (err) {
		if (errCode(err) === "ENOENT") return acquireOnceSync(target, lockfilePath, 0, log);
		throw err;
	}

	if (!isLockStale(mtimeMs, staleMs)) throw elocked(target);

	log?.(`[lock-core] stale lock taken over: ${lockfilePath} (mtime age > ${staleMs}ms), removing and retrying`);
	removeLockSync(lockfilePath);
	return acquireOnceSync(target, lockfilePath, 0, log);
}

// ──────────────────────── 对外 API ────────────────────────

/**
 * 单次获取跨进程锁：成功返回 release（幂等）；锁被他人持有且未 stale 时抛
 * code:"ELOCKED" 错误（重试编排属消费方：extension 侧 sync busy-wait——
 * src/file-lock.ts / runtime 侧 async 退避——packages/runtime/src/utils/file-lock.ts）。
 */
export async function acquireLock(filePath: string, opts?: LockCoreOptions): Promise<LockRelease> {
	const target = resolveTarget(filePath);
	const lockfilePath = lockPathOf(target);
	const staleMs = Math.max(opts?.staleMs ?? DEFAULT_STALE_MS, MIN_STALE_MS);
	await ensureParentDir(target);
	installExitHook();
	await acquireOnceAsync(target, lockfilePath, staleMs, opts?.log);
	return makeRelease(lockfilePath);
}

/**
 * acquireLock 的同步版（sync 调用链专用；语义同 async 版，无事件循环依赖）。
 */
export function acquireLockSync(filePath: string, opts?: LockCoreOptions): () => void {
	const target = resolveTarget(filePath);
	const lockfilePath = lockPathOf(target);
	const staleMs = Math.max(opts?.staleMs ?? DEFAULT_STALE_MS, MIN_STALE_MS);
	mkdirSync(dirname(target), { recursive: true });
	installExitHook();
	acquireOnceSync(target, lockfilePath, staleMs, opts?.log);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeLocks.delete(lockfilePath);
		removeLockSync(lockfilePath);
	};
}
