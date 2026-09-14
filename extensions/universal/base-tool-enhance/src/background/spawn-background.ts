/**
 * 后台任务 spawn（D7/D10/D12/D15，设计文档 §3.5 后台任务生命周期数据流 ③④）。
 *
 * spawn 细节：detached（自成进程组，进程树 kill 的语义基础）+ stdio 直接落
 * <dataDir>/base-tool-enhance/<sessionId>/<task_id>.log（append fd，不占内存、
 * 无 pipe backpressure）+ child.unref()（pi 不等它）。abort/interrupt 不传播到
 * 后台任务（D15）——execute 立即返回，本模块不接触 signal。
 *
 * D6：本包不强加任务寿命上限（无 TTL/墙钟）——vitest watch、dev server 这类任务
 * 的合法寿命就是「跑到用户叫停」，强加上限会把长任务误判死、完成通知链路随之失效。
 * 寿命出口只有三个：自然退出 / 显式 timeout（LLM 传值或配置 backgroundTimeoutSeconds）
 * / bash_kill。
 */

import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { getProcessStartTimeSec, killProcessTree, pidStartMatchesRegistered } from "@xyz-agent/extension-protocol/background-task";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { emitPendingRegister } from "./notify.ts";
import { ensurePollerRunning } from "./poller.ts";
import { getRegistryPath, taskToRegistryEntry, writeRegistryEntry } from "./registry.ts";
import { countActiveTasks, markKillingIntent, oldestActiveTask, registerSpawnedTask } from "./task-store.ts";
import type { BackgroundTask } from "./types.ts";

/** task_id 随机段熵源字节数（crypto 大数采样，8 字节 = 64 bit）。 */
const TASK_ID_ENTROPY_BYTES = 8;
/** 秒 → 毫秒。 */
const MS_PER_SECOND = 1000;

const logger = getLogger("base-tool-enhance");

/**
 * 并发上限默认值（D10）。M4：取值来源已配置化——bash-tool execute 每次读
 * maxConcurrentBackground 配置经 opts.maxConcurrent 传入；本常量仅在调用方未传时
 * 兜底（与 config.ts DEFAULT_BASE_TOOL_ENHANCE_CONFIG.maxConcurrentBackground 同源）。
 */
export const DEFAULT_MAX_CONCURRENT_BACKGROUND = 8;

/**
 * task_id 随机段长度（base36 小写）。6 字符 ≈ 31 bit 熵：同毫秒内数百次 spawn 的
 * 生日碰撞概率 ~1e-7（4 字符实测在 500 次内可撞——唯一性是 pending 差集前提，
 * §2.3，熵按此约束取值）。
 */
const TASK_ID_RAND_LENGTH = 6;
const TASK_ID_RADIX = 36;
const TASK_ID_RAND_SPACE = TASK_ID_RADIX ** TASK_ID_RAND_LENGTH;

/** 命令在错误文案中的展示长度上限。 */
const COMMAND_DISPLAY_LIMIT = 80;

/**
 * task_id 生成：`bt-<ts>-<rand>`（前缀 bt- 刻意区别于 subagent-workflow 的
 * bg-/run-，§2.3）。**禁止进程内自增序列**——pi 重启后撞旧 id 会破坏 pending
 * 差集前提（register 被幂等忽略 / 旧 unregister 误消新任务）。
 */
export function generateTaskId(now: number = Date.now()): string {
	return `bt-${now}-${randomRandSegment()}`;
}

/** 均匀 base36 随机段：crypto 随机大数取模，无 base64 字符集替换导致的采样偏置。 */
function randomRandSegment(): string {
	const value = randomBytes(TASK_ID_ENTROPY_BYTES).readBigUInt64BE() % BigInt(TASK_ID_RAND_SPACE);
	return value.toString(TASK_ID_RADIX).padStart(TASK_ID_RAND_LENGTH, "0");
}

/**
 * 后台 timeout 解析（秒），优先级 = LLM 显式值 > 配置默认值 > 不限（§3.5）：
 *  - 显式值有效 → 显式值；显式值无效（非有限/≤0）→ 沿用 pi 内置文案抛错
 *  - 显式值缺省 && 配置默认提供 → 配置默认（M4 注入接缝：调用侧传
 *    backgroundTimeoutSeconds；已 normalize，必为正有限数）
 *  - 双缺省 → undefined（不限）
 * D13 例外由调用侧实现：白名单强转后台时传 explicitSec=undefined（显式值整体忽略）。
 */
export function resolveBackgroundTimeoutSec(
	explicitSec: number | undefined,
	defaultSec?: number,
): number | undefined {
	if (explicitSec === undefined) return defaultSec;
	if (!Number.isFinite(explicitSec) || explicitSec <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	return explicitSec;
}

export interface SpawnBackgroundOptions {
	command: string;
	/** execute ctx.cwd（权威 cwd） */
	cwd: string;
	/** pi getAgentDir() 同源 dataDir */
	dataDir: string;
	sessionId: string;
	/** LLM 显式 timeout（秒）；undefined 时若配置默认存在由调用侧注入（M4）。 */
	timeoutSec?: number;
	/** 并发上限（M4：bash-tool 从 maxConcurrentBackground 配置传入；缺省走默认常量）。 */
	maxConcurrent?: number;
}

export type SpawnBackgroundResult =
	| { ok: true; task: BackgroundTask }
	| { ok: false; error: string };

function shellForPlatform(): { shell: string; args: string[] } {
	if (process.platform === "win32") {
		return { shell: process.env.ComSpec || "cmd.exe", args: ["/c"] };
	}
	return { shell: process.env.SHELL || "/bin/sh", args: ["-c"] };
}

/**
 * 启动后台任务：并发检查 → spawn（输出重定向 .log）→ 单例表登记 + registry 写
 * running 条目 → 显式 timeout 定时器 → 启动轮询器。
 * 立即返回，不等待命令退出（turn 不被占用，G1）。
 */
export function spawnBackgroundTask(opts: SpawnBackgroundOptions): SpawnBackgroundResult {
	const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_BACKGROUND;
	if (countActiveTasks() >= maxConcurrent) {
		const oldest = oldestActiveTask();
		if (oldest === undefined) {
			// 防御缺口闭合：上限已满但找不出最老活跃任务 = maxConcurrent <= 0 且 0 活跃
			// ——同样拒绝，否则上限静默失效。config normalize 保证 >= 1，此处兜底
			// 绕过配置直传非法值的调用方（错误指向配置键，可操作）
			return {
				ok: false,
				error:
					`Background task concurrency limit configuration invalid (maxConcurrent=${maxConcurrent}, must be >= 1). ` +
				"Fix maxConcurrentBackground in the base-tool-enhance config.",
			};
		}
		const cmd = truncateCommand(oldest.command);
		return {
			ok: false,
			error:
				`Background task limit reached (max ${maxConcurrent} concurrent). ` +
				`Oldest task: ${oldest.taskId} (${cmd}). ` +
				`Kill it with bash_kill {task_id:"${oldest.taskId}"} or wait for it to finish.`,
		};
	}

	// cwd 校验对齐 pi 内置文案（bash.js createLocalBashOperations）
	try {
		accessOrThrow(opts.cwd);
	} catch {
		return {
			ok: false,
			error: `Working directory does not exist: ${opts.cwd}\nCannot execute bash commands.`,
		};
	}

	const taskId = generateTaskId();
	const registryPath = getRegistryPath(opts.dataDir, opts.sessionId);
	const outputFile = join(dirname(registryPath), `${taskId}.log`);
	mkdirSync(dirname(outputFile), { recursive: true });

	const { shell, args } = shellForPlatform();
	let outputFd: number | undefined;
	let child;
	try {
		outputFd = openSync(outputFile, "a");
		child = spawn(shell, [...args, opts.command], {
			cwd: opts.cwd,
			detached: true,
			stdio: ["ignore", outputFd, outputFd],
		});
		// 唯一的事件监听例外：no-op error listener 防 spawn 异步失败 emit error 无监听
		// 导致进程崩溃（EventEmitter 语义）。不做任何状态推进——exit 感知归轮询器（D17）。
		child.on("error", () => {});
		child.unref();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Failed to start background command: ${message}` };
	} finally {
		// 子进程已继承 fd 副本（含 spawn 同步失败路径：fd 未被子进程持有），父进程侧
		// 描述符统一在此关闭防句柄泄漏
		if (outputFd !== undefined) {
			try {
				closeSync(outputFd);
			} catch (err) {
				// 已关闭/不可关闭均不掩盖主流程，仅留诊断
				logger.debug("background spawn output fd close failed", {
					detail: { outputFile, err: err instanceof Error ? err.message : String(err) },
				});
			}
		}
	}

	if (child.pid === undefined) {
		return { ok: false, error: "Failed to start background command: no pid acquired" };
	}

	// M3 补写字段：spawn 后立即读子进程 start time（epoch 秒），供收殓/kill 侧
	// 精确比较防 pid 复用误杀。读取失败省略（undefined 不进条目）——消费方降级走
	// startedAt 秒级校验兜底，不报错不阻断 spawn
	const pidStartTime = getProcessStartTimeSec(child.pid);

	const task: BackgroundTask = {
		taskId,
		pid: child.pid,
		command: opts.command,
		outputFile,
		registryPath,
		startedAt: Date.now(),
		state: "running",
		ownerPiPid: process.pid,
		sessionId: opts.sessionId,
		...(pidStartTime !== undefined ? { pidStartTime } : {}),
		child,
	};

	if (opts.timeoutSec !== undefined) {
		armBackgroundTimeout(task, opts.timeoutSec);
	}

	// 登记顺序（§3.5 数据流 ③④⑤）：单例表（运行时权威）→ registry（持久化）→
	// pending:register emit。registry 写失败不阻断（条目停留 running 由 runtime
	// 收殓器兜底——孤儿判定按 ownerPiPid，§3.5；u-bte-remove 下沉后不再依赖本包
	// 扫描）；emit 失败同样无害（peer 未加载/引用未注入时无 listener，通知
	// 链路缺失不影响任务本体）
	registerSpawnedTask(task);
	writeRegistryEntry(registryPath, taskToRegistryEntry(task));
	emitPendingRegister(task);
	ensurePollerRunning();
	return { ok: true, task };
}

/**
 * 后台显式 timeout（D6：任务寿命可由使用者显式约束）。到点：pid 身份校验通过 →
 * kill-tree + 两侧标 killing intent（reason 候选 timeout）——实际终态由轮询器边沿
 * 收尾写（单一终态归属），此处不写终态。身份校验不过（登记原进程已不在：已死或
 * pid 复用嫌疑）→ 跳过 kill **且跳过 intent 标记**（D6-en/R2-S1 加固）：无条件
 * markKillingIntent("timeout") 会把 UI 代杀 / AI bash_kill 刚预写的 killed 改写成
 * timeout → reason=timeout → sendMessage 误报「timed out」唤醒 AI；跳过后由轮询器
 * 边沿按事实收尾（自然死亡 → natural；registry 预写 killing → 经 D6-en 读回判
 * killed）。接受语义微移：到期前 ~2s 内自然死亡的任务改标 natural（仅影响 AI
 * 通知文案）。
 */
function armBackgroundTimeout(task: BackgroundTask, timeoutSec: number): void {
	const timer = setTimeout(() => {
		// pid 复用防御（§3.6，同 bash_kill 范式，宁不杀勿误杀）：
		// 任务早已退出（exit 边沿未被轮询器收尾或竞态未及）且 pid 在到点前被系统复用
		// 时，直接 killProcessTree 会杀掉复用 pid 上的无辜进程（整进程组 SIGKILL）。
		if (!isRecordedPidStillOriginal(task)) {
			logger.warn("background timeout: pid identity unverified (reuse suspected or start time unreadable), skipping kill", {
				detail: {
					taskId: task.taskId,
					pid: task.pid,
					pidStartTime: task.pidStartTime,
					startedAt: task.startedAt,
				},
			});
			// D6-en/R2-S1 加固：登记原进程已不在时同样跳过 intent 标记——内存 intent
			// 是本进程权威（task-store.ts 头部不变量），被无条件改写为 timeout 即丢失
			// killed 语义（D6-en 读回与 AI bash_kill 预写双双失效）。此处提前 return
			// 时轮询器必在跑（本任务仍是活跃条目，惰性自停条件是活跃数为 0），边沿
			// 收尾不受影响。
			return;
		}
		// 回退路径诊断经 onFallback 注入 logger 适配（ext-simplify-13 D2）
		killProcessTree(task.pid, (step, err) =>
			logger.debug(step, {
				detail: { pid: task.pid, err: err instanceof Error ? err.message : String(err) },
			}),
		);
		const marked = markKillingIntent(task.taskId, "timeout");
		if (marked === undefined) return;
		writeRegistryEntry(marked.registryPath, taskToRegistryEntry(marked));
		ensurePollerRunning();
	}, timeoutSec * MS_PER_SECOND);
	timer.unref?.();
	task.timeoutTimer = timer;
}

/**
 * 到点 pid 身份校验：true = 登记时的原进程仍占用该 pid（可安全 kill-tree）。
 * 判据（精确比较 / startedAt 秒级降级 / 读不到保守 false）单点定义于
 * extension-protocol 的 pidStartMatchesRegistered（原 reaper.ts 单点，跨端原语
 * 归一后经 background-task 子出口消费——ext-simplify-13）。
 */
function isRecordedPidStillOriginal(task: BackgroundTask): boolean {
	const actualStartSec = getProcessStartTimeSec(task.pid);
	if (actualStartSec === undefined) return false;
	return pidStartMatchesRegistered(actualStartSec, task.pidStartTime, task.startedAt);
}

function accessOrThrow(cwd: string): void {
	// 独立小函数：保持与内置 fsAccess(constants.F_OK) 语义一致的同步版本
	accessSync(cwd, constants.F_OK);
}

export function truncateCommand(command: string): string {
	return command.length > COMMAND_DISPLAY_LIMIT
		? `${command.slice(0, COMMAND_DISPLAY_LIMIT)}…`
		: command;
}
