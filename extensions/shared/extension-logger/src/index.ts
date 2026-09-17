// src/index.ts
//
// 共享 extension logger —— 双通道日志封装，按受众路由。
//
// 设计依据：pi 宿主层（ExtensionAPI/ExtensionContext）不提供 logger 接口。
// extension 只能裸 console（污染 TUI raw stderr）或自组 ctx.ui.notify（刷屏）+
// pi.appendEntry（持久化但用户不可见）。本模块封装这套通道，让 @zhushanwen/pi-*
// 各包统一调用，消除裸 console。
//
// 三通道分类法（本模块实装其中两通道；通道 1 为 pi 原生行为，仅登记不封装）：
//   1. AI 实时    → tool result / block reason（pi 原生，本模块不涉及）
//   2. 事后排查   → pi.appendEntry（custom entry 不进 LLM 上下文，不显 TUI）【实装】
//   3. 开发者调试 → 文件日志，双开关分级（写 <agentDir>/logs/，均未注入默认 no-op）【实装】：
//        - TAIJI_AGENT_DEBUG=1 → DEBUG 全量（现状语义，level 原样标注）
//        - TAIJI_AGENT_EXT_LOG=1 → INFO 级落盘（taiji 托管环境由 runtime spawn 时经
//          buildOutboundChildEnv extras 注入，设计 file-lock-unification-and-reaper-sink
//          §3.2-D4 / U3-3）+ 7 天保留期清理；debug() 调用此模式下重标 info 写入
//        - 两变量同时注入按更详细的生效（DEBUG 全量优先）
//      裸 pi 独立用户（两个变量都未注入）保持 no-op，零磁盘/行为影响。
//
// notify（用户操作反馈）刻意不封装——它是 UI 决策，留给各 extension 在命令/视图层
// 直接调 ctx.ui.notify。
//
// fileLog 单日文件无 size cap——显式豁免，依据：写入方为每 session 短命 pi 进程
// + 7 天保留期清理 + DEBUG 档系开发者主动排障。

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";

// ============================================================
// Per-message 固定窗口限流（P3 防线）
//
// 语义：同一个 (extName, level, msg) 三元组在 60s 窗口内，前 10 条 warn/error
// 直写 pi.appendEntry（session JSONL），第 11 条起抑制并在内存计数。窗口
// 过期后下一条到来时，先写 1 条聚合摘要（"...[+M suppressed in last 60s]"），
// 再正常写本条并开新窗口。纯惰性实现——无 timer，全部状态在调用时检查
// （Date.now() 判断窗口是否过期）。
//
// 已知限制：
//   - key = msg 原文（不包含 data 参数）。若调用方把动态 id 拼进 msg
//     （如 `session=${id}`），每条 msg 不同则限流不命中。根治靠调用方把
//     动态值放 data 参数（D4 已声明）。
//   - fileLog 通道全量不限流（TAIJI_AGENT_DEBUG=1 / TAIJI_AGENT_EXT_LOG=1 时日志写文件）。
//   - Map cap 512 超限时全量清空（简化策略，对齐 cap-1024 先例），
//     等价于所有 key 窗口重置，防无界增长。
//
// 设计依据：extension-log-cleanup-design §3.4 D4
// ============================================================

/** 同 key 每窗口允许直写 appendEntry 的最大条数。 */
const RATE_LIMIT_MAX = 10;
/** 固定窗口时长（ms）。 */
const RATE_LIMIT_WINDOW_MS = 60_000;
/** 限流状态 Map 的容量上限——超限全量清空（对齐 cap-1024 先例的简化策略）。 */
const RATE_LIMIT_STATE_CAP = 512;

interface RateLimiterEntry {
	/** 当前窗口起始时间戳（ms）。 */
	windowStart: number;
	/** 当前窗口内已直写 appendEntry 的条数。 */
	count: number;
	/** 当前窗口内被抑制的条数（窗口过期后用于聚合摘要）。 */
	suppressed: number;
}

/**
 * per-msg 限流状态。
 *
 * key = `${extName}:${level}:${msg}`（msg 为原 msg，非 prefixed）。
 * 同进程所有 logger 实例共享（模块级 singleton）。
 *
 * ⚠️ 生命周期与进程一致——taiji 每 session 一个独立 pi 进程
 * （见 runtime process-manager.ts 的类注释），故不存在跨 session 残留问题。
 */
const rateLimiterState = new Map<string, RateLimiterEntry>();

/**
 * 检查并更新 per-msg 限流状态。返回值：
 *   - "allow": 直写 appendEntry
 *   - "suppress": 抑制（不写 appendEntry，内存计数）
 *   - { emitSummary: M }: 窗口过期后首条——先写聚合摘要（M = 被抑制数），再写本条
 *
 * 纯惰性实现：无 timer，窗口过期判断在调用时通过 Date.now() 计算。
 */
function checkRateLimiter(
	key: string,
): "allow" | "suppress" | { emitSummary: number } {
	// 防无界增长：超限清空（等价所有 key 窗口重置）
	if (rateLimiterState.size >= RATE_LIMIT_STATE_CAP) {
		rateLimiterState.clear();
	}

	const now = Date.now();
	const entry = rateLimiterState.get(key);

	if (!entry) {
		// 首次见到该 key：开新窗口，count=1（本条是第 1 条）
		rateLimiterState.set(key, {
			windowStart: now,
			count: 1,
			suppressed: 0,
		});
		return "allow";
	}

	const elapsed = now - entry.windowStart;

	if (elapsed >= RATE_LIMIT_WINDOW_MS) {
		// 窗口过期：本条触发新窗口。若有被抑制数，先返回聚合摘要。
		const suppressed = entry.suppressed;
		// 开新窗口（count=1 计入本条）
		rateLimiterState.set(key, {
			windowStart: now,
			count: 1,
			suppressed: 0,
		});
		if (suppressed > 0) {
			return { emitSummary: suppressed };
		}
		return "allow";
	}

	// 窗口内
	if (entry.count < RATE_LIMIT_MAX) {
		entry.count++;
		return "allow";
	}

	// 已满额：抑制，计数
	entry.suppressed++;
	return "suppress";
}

/**
 * 清空限流状态（测试用导出，生产代码不调用）。
 */
export function clearRateLimiterState(): void {
	rateLimiterState.clear();
}

/**
 * Pi ExtensionAPI 的最小子集——仅 appendEntry（持久化审计通道）。
 *
 * 不直接 import 完整 ExtensionAPI 类型，避免本包强耦合 pi-coding-agent 版本。
 * 各 extension 在 createLogger 时传入的 pi handle 满足此结构即可。
 */
export interface PiLike {
	/** 写一条 custom entry 进 session.jsonl（不进 LLM 上下文，不显 TUI）。 */
	appendEntry?(customType: string, data?: unknown): void;
}

/** 日志级别。debug = 开发调试；info = TAIJI_AGENT_EXT_LOG 模式下 debug() 的落盘标注；warn/error = 内部降级与失败（事后排查价值）。 */
type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Extension logger 接口。方法名即语义——不做运行时 level filtering（pi 不支持，
 * 自建太重）。warn/error 走 appendEntry 持久化；debug 默认 no-op。
 */
export interface ExtensionLogger {
	/**
	 * 开发调试日志。默认 no-op；TAIJI_AGENT_DEBUG=1 时写文件日志（原级标注）；
	 * TAIJI_AGENT_EXT_LOG=1（无 DEBUG）时以 info 级落盘（托管环境 INFO 观测档）。
	 * 不进 appendEntry。
	 */
	debug(msg: string, data?: unknown): void;
	/** 内部降级/竞态/IO 失败——appendEntry 持久化，不显 TUI，不进 LLM。 */
	warn(msg: string, data?: unknown): void;
	/** 同 warn，语义更严重（关键步骤失败但仍继续）。 */
	error(msg: string, data?: unknown): void;
}

// ============================================================
// 全局 singleton registry
// ============================================================

// ⚠️ 单 session 约束：本 registry 是模块级可变共享态。
//   - `globalPi`（let）与 `loggerCache`（const Map）被同进程所有 session 共享。
//   - 多 session 并发时，后注册 session 的 setPiHandle 会覆盖前者，导致先 session
//     的 logger 路由到错误的 appendEntry（session 隔离缺失）。
//   - 当前 pi 设计为单主 session，此约束可接受；多 session 是远期场景，届时需把
//     logger 按 sessionManager 维度分区（如 getLogger(extName, ctx)）。
//   详见 development-guide §2.3「闭包状态隔离」——本处为已知、有据的例外。

/**
 * 进程级 pi handle（延迟注入）。
 *
 * extension 初始化分两阶段：default export 函数拿到 pi → setPiHandle 注入；
 * 之后深层代码（best-effort / error-recovery）通过 getLogger 拿到的 logger
 * 才能走 appendEntry。注入前 warn/error 降级到文件日志（不丢诊断信息）。
 *
 * ⚠️ 模块级共享态：见上方「单 session 约束」——多 session 并发时后注册覆盖前者。
 */
let globalPi: PiLike | undefined;

/**
 * 各 extension name → logger 实例的缓存（getLogger 多次调用返回同一实例）。
 *
 * ⚠️ 模块级共享态：见上方「单 session 约束」——多 session 并发时共享同一缓存。
 */
const loggerCache = new Map<string, ExtensionLogger>();

/**
 * 注入 pi handle（extension default export 函数最早期调用）。
 *
 * 多次调用安全——后调覆盖先调（session_start 可能多次触发，取最新的 pi）。
 * 注入后，已创建的 logger 实例自动生效 appendEntry（闭包读 globalPi 实时值）。
 *
 * ⚠️ 单 session 约束：本函数写模块级 `globalPi`。多 session 并发时后调覆盖先调，
 *    详见上方「单 session 约束」注释。
 */
export function setPiHandle(pi: PiLike | undefined): void {
	globalPi = pi;
}

/**
 * 创建具名 logger。
 *
 * @param extName  extension 名（如 "subagents"、"smart-context"），用作：
 *                  - appendEntry 的 customType 前缀（`<extName>:log`）
 *                  - 文件日志名（`<extName>-YYYY-MM-DD.log`）
 *                  - msg 前缀（`[<extName>]`，自动补）
 * @param pi       可选 pi handle；测试隔离注入用，生产一律 setPiHandle/getLogger。
 *                  不传则用 setPiHandle 注入的全局 handle
 * @returns        ExtensionLogger 实例（每次返回同一引用，便于模块级 const 缓存）
 */
export function createLogger(extName: string, pi?: PiLike): ExtensionLogger {
	// 优先用传入的 pi，否则用全局注入的
	const resolvePi = (): PiLike | undefined => pi ?? globalPi;

	const logger: ExtensionLogger = {
		debug(msg: string, data?: unknown): void {
			fileLog(extName, "debug", msg, data);
		},
		warn(msg: string, data?: unknown): void {
			const piResolved = resolvePi();
			const prefixed = prefixMsg(extName, msg);
			// appendEntry 通道：per-msg 固定窗口限流（debug 不限流——只走 fileLog）
			const rateLimitKey = `${extName}:warn:${msg}`;
			const rateLimitResult = checkRateLimiter(rateLimitKey);
			try {
				if (rateLimitResult === "allow") {
					piResolved?.appendEntry?.(`${extName}:log`, {
						timestamp: Date.now(),
						level: "warn",
						message: prefixed,
						data,
					});
				} else if (typeof rateLimitResult === "object") {
					// 窗口过期后首条：先写聚合摘要
					piResolved?.appendEntry?.(`${extName}:log`, {
						timestamp: Date.now(),
						level: "warn",
						message: `${prefixed} ... [+${rateLimitResult.emitSummary} suppressed in last 60s]`,
					});
					// 再写本条
					piResolved?.appendEntry?.(`${extName}:log`, {
						timestamp: Date.now(),
						level: "warn",
						message: prefixed,
						data,
					});
				}
				// else: "suppress" — 不写 appendEntry
			} catch (appendErr) {
				// appendEntry 失败（session 已 disposed 等）→ 降级文件日志（下方 fileLog 兜底），不 throw
				void appendErr;
			}
			// fileLog 全量不限流（TAIJI_AGENT_DEBUG=1 排障时可见全部）
			fileLog(extName, "warn", prefixed, data);
		},
		error(msg: string, data?: unknown): void {
			const piResolved = resolvePi();
			const prefixed = prefixMsg(extName, msg);
			// appendEntry 通道：per-msg 固定窗口限流（与 warn 同参数，一套机制）
			const rateLimitKey = `${extName}:error:${msg}`;
			const rateLimitResult = checkRateLimiter(rateLimitKey);
			try {
				if (rateLimitResult === "allow") {
					piResolved?.appendEntry?.(`${extName}:log`, {
						timestamp: Date.now(),
						level: "error",
						message: prefixed,
						data,
					});
				} else if (typeof rateLimitResult === "object") {
					// 窗口过期后首条：先写聚合摘要
					piResolved?.appendEntry?.(`${extName}:log`, {
						timestamp: Date.now(),
						level: "error",
						message: `${prefixed} ... [+${rateLimitResult.emitSummary} suppressed in last 60s]`,
					});
					// 再写本条
					piResolved?.appendEntry?.(`${extName}:log`, {
						timestamp: Date.now(),
						level: "error",
						message: prefixed,
						data,
					});
				}
			} catch (appendErr) {
				// 同 warn：appendEntry 失败降级文件日志，不 throw
				void appendErr;
			}
			// fileLog 全量不限流
			fileLog(extName, "error", prefixed, data);
		},
	};
	return logger;
}

/**
 * 获取（或创建）具名 logger 的全局 singleton。
 *
 * 深层代码（拿不到 pi 的执行层，如 best-effort.ts、error-recovery.ts）
 * 用 `getLogger("subagents")` 拿全局缓存实例，无需逐层透传 pi。
 *
 * 首次调用时 pi 尚未注入 → logger 的 warn/error 降级到文件日志；
 * 后续 setPiHandle 注入后，同一 logger 实例自动生效 appendEntry
 * （闭包读 globalPi 实时值，不是创建时的快照）。
 */
export function getLogger(extName: string): ExtensionLogger {
	const existing = loggerCache.get(extName);
	if (existing) return existing;
	const logger = createLogger(extName);
	loggerCache.set(extName, logger);
	return logger;
}

// ============================================================
// 内部工具
// ============================================================

/**
 * 给 msg 补 `[extName]` 前缀（若已有则不重复补）。
 * 保持与旧 console 日志一致的视觉格式，便于从 session.jsonl 逆向搜索。
 */
function prefixMsg(extName: string, msg: string): string {
	const tag = `[${extName}]`;
	return msg.startsWith(tag) ? msg : `${tag} ${msg}`;
}

// ============================================================
// TAIJI_AGENT_EXT_LOG 托管观测档 + 保留期清理
// ============================================================

/** 托管观测档（TAIJI_AGENT_EXT_LOG=1）的日志保留天数，超期文件在首次落盘时清理。 */
const EXT_LOG_KEEP_DAYS = 7;
// 一天的毫秒数（数字分隔符形式对齐 session-reader hash-provider 的时间常量惯例）
const MS_PER_DAY = 86_400_000;
/** ISO 日期前 10 字符 = "YYYY-MM-DD" */
const ISO_DATE_PREFIX_LEN = 10;

/**
 * 保留期清理是否已执行（进程级 once）。
 *
 * pi 进程按 session 短命（runtime 每 session 一个独立 pi），进程生命周期清理一次
 * 足够；无需 timer——惰性挂在首次实际落盘时执行，未落盘（两个开关都没开）则
 * 永不触发任何 fs 调用（no-op 契约：裸 pi 独立用户零磁盘影响）。
 */
let extLogCleanupDone = false;

/**
 * 清理 `<logDir>` 下超保留期（EXT_LOG_KEEP_DAYS 天）的本包日志文件。
 *
 * 只清本包命名惯例内的文件（`<extName>-YYYY-MM-DD.log`，日期后缀 pattern 精确匹配），
 * 不触碰目录内其他产物。逐文件 best-effort：单个 stat/unlink 失败（并发删除/权限）
 * 不影响其余文件。读目录失败（目录刚创建为空等）整体跳过。
 */
function cleanExpiredExtLogsOnce(logDir: string): void {
	if (extLogCleanupDone) return;
	extLogCleanupDone = true;
	let entries: string[];
	try {
		entries = readdirSync(logDir);
	} catch (readErr) {
		// 目录不存在/不可读：无清理对象，跳过（首次 mkdir 由调用方完成，此处兜底）
		void readErr;
		return;
	}
	const cutoff = Date.now() - EXT_LOG_KEEP_DAYS * MS_PER_DAY;
	for (const name of entries) {
		if (!/^.+-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
		const full = join(logDir, name);
		try {
			if (statSync(full).mtimeMs < cutoff) {
				unlinkSync(full);
			}
		} catch (fileErr) {
			// 单文件清理失败不阻断（best-effort，与 fileLog 主路径容错同档）
			void fileErr;
		}
	}
}

/**
 * 重置保留期清理的 once 标记（测试用导出，生产代码不调用）。
 * 对齐 clearRateLimiterState 的测试出口先例——模块级状态跨用例需可重置。
 */
export function resetExtLogCleanupForTest(): void {
	extLogCleanupDone = false;
}

/**
 * 写文件日志到 `<agentDir>/logs/<extName>-YYYY-MM-DD.log`。
 *
 * 双开关分级（设计 file-lock-unification-and-reaper-sink §3.2-D4）：
 * - TAIJI_AGENT_DEBUG=1 → DEBUG 全量，level 原样标注（现状语义不变）；
 * - 仅 TAIJI_AGENT_EXT_LOG=1 → INFO 级落盘：debug() 调用重标 info 写入，warn/error 照写；
 * - 均未注入 → no-op（零 fs 调用，裸 pi 独立用户零磁盘/行为影响）。
 * agentDir 通过 pi 的 SSOT `getAgentDir()` 推导（读
 * `PI_CODING_AGENT_DIR`/`${APP_NAME}_CODING_AGENT_DIR`，默认 `~/.pi/agent`），
 * 与其它 extension 的路径派生保持一致。
 * 首次实际落盘时顺带执行一次保留期清理（进程级 once）。
 * 写失败静默吞错（文件日志是 best-effort，不应影响主流程）。
 *
 * 线程安全：appendFileSync 保证单次写入原子性；多 worker 并发写同文件时
 * 行可能交错（可接受——debug 日志不要求严格顺序）。
 */
function fileLog(extName: string, level: LogLevel, msg: string, data?: unknown): void {
	const debugMode = process.env.TAIJI_AGENT_DEBUG === "1";
	const extLogMode = !debugMode && process.env.TAIJI_AGENT_EXT_LOG === "1";
	if (!debugMode && !extLogMode) return;
	// 托管观测档：debug() 调用降档标注为 info（INFO 级观测，非 DEBUG 全量）
	const effectiveLevel: LogLevel = extLogMode && level === "debug" ? "info" : level;
	try {
		const agentDir = getAgentDir();
		const logDir = join(agentDir, "logs");
		mkdirSync(logDir, { recursive: true });
		cleanExpiredExtLogsOnce(logDir);
		const today = new Date().toISOString().slice(0, ISO_DATE_PREFIX_LEN);
		const logFile = join(logDir, `${extName}-${today}.log`);
		const ts = new Date().toISOString();
		const dataStr = data !== undefined ? " " + safeStringify(data) : "";
		appendFileSync(logFile, `${ts} [${effectiveLevel}] ${msg}${dataStr}\n`);
	} catch (fileErr) {
		// 文件日志 best-effort：磁盘满/权限问题等不阻断主流程
		void fileErr;
	}
}

/** 安全序列化 data（循环引用/BigInt 不崩）。 */
function safeStringify(data: unknown): string {
	try {
		return JSON.stringify(data);
	} catch {
		return String(data);
	}
}
