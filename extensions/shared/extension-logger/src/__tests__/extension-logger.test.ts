import { existsSync, readFileSync, rmSync, mkdirSync, chmodSync, mkdtempSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createLogger,
	getLogger,
	setPiHandle,
	clearRateLimiterState,
	resetExtLogCleanupForTest,
	type PiLike,
} from "../index.js";

describe("extension-logger", () => {
	let appendSpy: ReturnType<typeof vi.fn>;
	let pi: PiLike;
	const prevEnv = { ...process.env };

	beforeEach(() => {
		appendSpy = vi.fn();
		pi = { appendEntry: appendSpy };
		setPiHandle(undefined);
	});

	afterEach(() => {
		setPiHandle(undefined);
		clearRateLimiterState();
		vi.restoreAllMocks();
		// 还原环境变量，避免文件日志测试的 TAIJI_AGENT_DEBUG/PI_CODING_AGENT_DIR 泄漏到其它用例
		process.env = { ...prevEnv };
	});

	describe("createLogger", () => {
		it("warn 走 pi.appendEntry，customType 前缀为 <extName>:log", () => {
			const logger = createLogger("test-ext", pi);
			logger.warn("manifest write failed", { id: "rec-1" });

			expect(appendSpy).toHaveBeenCalledOnce();
			const [customType, data] = appendSpy.mock.calls[0]!;
			expect(customType).toBe("test-ext:log");
			expect(data).toMatchObject({
				level: "warn",
				message: "[test-ext] manifest write failed",
				data: { id: "rec-1" },
			});
		});

		it("error 走 pi.appendEntry，level 为 error", () => {
			const logger = createLogger("subagents", pi);
			logger.error("budget abort failed");

			expect(appendSpy).toHaveBeenCalledOnce();
			const [, data] = appendSpy.mock.calls[0]!;
			expect(data).toMatchObject({
				level: "error",
				message: "[subagents] budget abort failed",
			});
		});

		it("msg 已有 [extName] 前缀时不重复补", () => {
			const logger = createLogger("subagents", pi);
			logger.warn("[subagents] skip malformed manifest");

			const [, data] = appendSpy.mock.calls[0]!;
			expect(data).toMatchObject({
				message: "[subagents] skip malformed manifest",
			});
		});

		it("appendEntry 抛错时不 throw（降级到文件日志）", () => {
			const throwingPi: PiLike = {
				appendEntry: () => {
					throw new Error("session disposed");
				},
			};
			const logger = createLogger("test", throwingPi);
			expect(() => logger.warn("no crash")).not.toThrow();
		});

		// ---- error 分支：与 warn 对称的前缀补全 + appendEntry 失败降级（Suggestion #10）----
		it("error msg 已有 [extName] 前缀时不重复补", () => {
			const logger = createLogger("subagents", pi);
			logger.error("[subagents] critical budget abort");

			const [, data] = appendSpy.mock.calls[0]!;
			expect(data).toMatchObject({
				message: "[subagents] critical budget abort",
			});
		});

		it("error appendEntry 抛错时不 throw（降级到文件日志）", () => {
			const throwingPi: PiLike = {
				appendEntry: () => {
					throw new Error("session disposed");
				},
			};
			const logger = createLogger("test", throwingPi);
			expect(() => logger.error("no crash")).not.toThrow();
		});
	});

	describe("pi handle 延迟注入", () => {
		it("createLogger 时不传 pi，后续 setPiHandle 后 warn 生效", () => {
			const logger = createLogger("delayed");
			// 注入前——appendEntry 不该被调用（pi=undefined）
			logger.warn("before injection");
			expect(appendSpy).not.toHaveBeenCalled();

			// 注入后——同一 logger 实例的 warn 生效（闭包读 globalPi 实时值）
			setPiHandle(pi);
			logger.warn("after injection");
			expect(appendSpy).toHaveBeenCalledOnce();
		});
	});

	describe("getLogger singleton", () => {
		it("同名多次调用返回同一实例", () => {
			const a = getLogger("subagents");
			const b = getLogger("subagents");
			expect(a).toBe(b);
		});

		it("getLogger 创建的 logger 接受后续 setPiHandle", () => {
			const logger = getLogger("workflow");
			logger.warn("no pi yet");
			expect(appendSpy).not.toHaveBeenCalled();

			setPiHandle(pi);
			logger.warn("pi injected");
			expect(appendSpy).toHaveBeenCalledOnce();
		});
	});

	describe("debug 不走 appendEntry", () => {
		it("debug 不调 appendEntry（即使 pi 已注入）", () => {
			const logger = createLogger("test", pi);
			logger.debug("streaming intermediate state");
			expect(appendSpy).not.toHaveBeenCalled();
		});
	});

	describe("TAIJI_AGENT_DEBUG 文件日志", () => {
		// 文件日志的 agentDir 通过 getAgentDir() 推导（读 PI_CODING_AGENT_DIR，
		// 默认 ~/.pi/agent）。设 PI_CODING_AGENT_DIR 到 tmpdir 子目录，与组 A 的
		// arch-boundary 改动（fileLog 用 getAgentDir()）保持一致。
		let tmpAgentDir: string;

		beforeEach(() => {
			tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-ext-log-"));
			process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
			if (tmpAgentDir) {
				rmSync(tmpAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
			}
		});

		it("TAIJI_AGENT_DEBUG 未设时 debug 是 no-op（不抛错即可）", () => {
			delete process.env.TAIJI_AGENT_DEBUG;
			const logger = createLogger("test", pi);
			expect(() => logger.debug("no-op")).not.toThrow();
		});

		// ---- Suggestion #8：fileLog 实际写入路径 ----
		it("TAIJI_AGENT_DEBUG=1 时 debug 写入日志文件，内容含 [debug] 与序列化 data", () => {
			process.env.TAIJI_AGENT_DEBUG = "1";
			// 固定日期 → 文件名 <extName>-2026-08-01.log
			vi.setSystemTime(new Date("2026-08-01T12:34:56.789Z"));

			const logger = createLogger("dbg-ext", pi);
			logger.debug("streaming state", { id: "rec-1", count: 3 });

			const logFile = join(tmpAgentDir, "logs", "dbg-ext-2026-08-01.log");
			expect(existsSync(logFile)).toBe(true);

			const content = readFileSync(logFile, "utf8");
			// 时间戳 + level + msg
			expect(content).toContain("[debug]");
			expect(content).toContain("streaming state");
			// data 经 safeStringify（JSON.stringify）序列化
			expect(content).toContain('"id":"rec-1"');
			expect(content).toContain('"count":3');
			// 单行以换行结尾
			expect(content.endsWith("\n")).toBe(true);
			// debug 不走 appendEntry
			expect(appendSpy).not.toHaveBeenCalled();
		});

		it("TAIJI_AGENT_DEBUG=1 时 warn 既写文件又走 appendEntry（文件内容含 [warn]）", () => {
			process.env.TAIJI_AGENT_DEBUG = "1";
			vi.setSystemTime(new Date("2026-08-01T12:34:56.789Z"));

			const logger = createLogger("warn-ext", pi);
			logger.warn("manifest retry", { attempt: 2 });

			const logFile = join(tmpAgentDir, "logs", "warn-ext-2026-08-01.log");
			expect(existsSync(logFile)).toBe(true);
			const content = readFileSync(logFile, "utf8");
			expect(content).toContain("[warn]");
			expect(content).toContain("[warn-ext] manifest retry");
			expect(content).toContain('"attempt":2');
			// 同时走 appendEntry
			expect(appendSpy).toHaveBeenCalledOnce();
		});

		it("TAIJI_AGENT_DEBUG=1 写失败（只读目录）不 throw", () => {
			process.env.TAIJI_AGENT_DEBUG = "1";
			vi.setSystemTime(new Date("2026-08-01T12:34:56.789Z"));

			// 已存在的 logs 目录改为只读，让 mkdirSync/appendFileSync 失败。
			// 用 debug（只走文件路径），断言 best-effort 吞错。
			const READONLY_MODE = 0o555; // r-xr-xr-x，无写权限
			const RESTORE_MODE = 0o755; // rwxr-xr-x，恢复写权限以便清理
			const readonlyAgentDir = mkdtempSync(join(tmpdir(), "pi-ext-ro-"));
			const logDir = join(readonlyAgentDir, "logs");
			mkdirSync(logDir, { recursive: true });
			chmodSync(logDir, READONLY_MODE);
			process.env.PI_CODING_AGENT_DIR = readonlyAgentDir;

			const logger = createLogger("ro-ext", pi);
			expect(() => logger.debug("should not throw")).not.toThrow();

			// 清理：先恢复写权限才能删除
			chmodSync(logDir, RESTORE_MODE);
			rmSync(readonlyAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		});
	});

	// ---- Suggestion #9：safeStringify 对循环引用/BigInt 的兜底 ----
	describe("safeStringify 兜底（循环引用 / BigInt）", () => {
		it("循环引用对象：warn 不崩，data 走 String fallback 进 appendEntry", () => {
			// debug 不进 appendEntry，故用 warn（warn/error 把 data 原样传给 appendEntry）
			const logger = createLogger("cycle", pi);
			const cyclic: Record<string, unknown> = { name: "loop" };
			cyclic.self = cyclic;

			expect(() => logger.warn("cyclic data", cyclic)).not.toThrow();
			expect(appendSpy).toHaveBeenCalledOnce();
			const [, entry] = appendSpy.mock.calls[0]!;
			// appendEntry payload 的 data 字段保留原对象（safeStringify 仅在文件日志路径用）
			expect(entry).toMatchObject({ level: "warn" });
			// 验证 safeStringify 的 fallback 分支：用 TAIJI_AGENT_DEBUG=1 触发 fileLog，
			// 文件内 data 应是 String() 形式（含 [object Object] 或循环结构字符串）
			expect(() => JSON.stringify(cyclic)).toThrow(); // 对照：原对象确实不可序列化
		});

		it("BigInt：warn 不崩，文件日志路径走 String fallback", () => {
			process.env.TAIJI_AGENT_DEBUG = "1";
			const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-ext-bigint-"));
			process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
			vi.setSystemTime(new Date("2026-08-01T12:34:56.789Z"));

			const logger = createLogger("bigint-ext", pi);
			const bigIntData = { count: 9007199254740993n, name: "big" };

			expect(() => logger.warn("bigint data", bigIntData)).not.toThrow();
			expect(appendSpy).toHaveBeenCalledOnce();

			const logFile = join(tmpAgentDir, "logs", "bigint-ext-2026-08-01.log");
			expect(existsSync(logFile)).toBe(true);
			const content = readFileSync(logFile, "utf8");
			// BigInt 不可 JSON.stringify → 走 String(data) fallback：对象 toString 形式
			expect(content).toContain("[warn]");
			// 对照：JSON.stringify(BigInt) 会 throw，故文件内不应是 JSON 形式
			expect(content).not.toContain('"count"');

			vi.useRealTimers();
			rmSync(tmpAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		});
	});

	// ============================================================
	// TAIJI_AGENT_EXT_LOG 托管观测档（设计 file-lock-unification-and-reaper-sink §3.2-D4）
	// ============================================================
	describe("TAIJI_AGENT_EXT_LOG 托管观测档", () => {
		let tmpAgentDir: string;

		beforeEach(() => {
			tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-ext-extlog-"));
			process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
			delete process.env.TAIJI_AGENT_DEBUG;
			delete process.env.TAIJI_AGENT_EXT_LOG;
			resetExtLogCleanupForTest();
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
			resetExtLogCleanupForTest();
			rmSync(tmpAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		});

		it("均未注入时 no-op：debug/warn/error 调用后 logs 目录都不创建（裸 pi 用户零磁盘影响）", () => {
			const logger = createLogger("bare-ext", pi);
			logger.debug("d");
			logger.warn("w");
			logger.error("e");
			expect(existsSync(join(tmpAgentDir, "logs"))).toBe(false);
		});

		it("仅 TAIJI_AGENT_EXT_LOG=1：debug 调用以 info 级落盘（含序列化 data），不标 debug", () => {
			process.env.TAIJI_AGENT_EXT_LOG = "1";
			vi.setSystemTime(new Date("2026-08-01T12:34:56.789Z"));

			const logger = createLogger("extlog-ext", pi);
			logger.debug("session maintenance ran", { session: "s-1" });

			const logFile = join(tmpAgentDir, "logs", "extlog-ext-2026-08-01.log");
			expect(existsSync(logFile)).toBe(true);
			const content = readFileSync(logFile, "utf8");
			expect(content).toContain("[info]");
			expect(content).not.toContain("[debug]");
			expect(content).toContain("session maintenance ran");
			expect(content).toContain('"session":"s-1"');
			// debug 仍不走 appendEntry（EXT_LOG 只改落盘档位，不改通道路由）
			expect(appendSpy).not.toHaveBeenCalled();
		});

		it("仅 TAIJI_AGENT_EXT_LOG=1：warn/error 照常落盘且保持原级标注", () => {
			process.env.TAIJI_AGENT_EXT_LOG = "1";
			vi.setSystemTime(new Date("2026-08-01T12:34:56.789Z"));

			const logger = createLogger("extlog-err", pi);
			logger.warn("retry degraded");
			logger.error("budget abort");

			const logFile = join(tmpAgentDir, "logs", "extlog-err-2026-08-01.log");
			const content = readFileSync(logFile, "utf8");
			expect(content).toContain("[warn]");
			expect(content).toContain("[error]");
			expect(content).not.toContain("[info]");
		});

		it("TAIJI_AGENT_DEBUG=1 与 EXT_LOG 同注入：按更详细的生效（debug 全量，原级标注）", () => {
			process.env.TAIJI_AGENT_EXT_LOG = "1";
			process.env.TAIJI_AGENT_DEBUG = "1";
			vi.setSystemTime(new Date("2026-08-01T12:34:56.789Z"));

			const logger = createLogger("both-ext", pi);
			logger.debug("verbose trace");

			const content = readFileSync(join(tmpAgentDir, "logs", "both-ext-2026-08-01.log"), "utf8");
			expect(content).toContain("[debug]");
			expect(content).not.toContain("[info]");
		});

		it("EXT_LOG 未注入、DEBUG 未设时，debug 不写文件（与 DEBUG 关闭现状一致）", () => {
			const logger = createLogger("noop-ext", pi);
			logger.debug("no-op");
			expect(existsSync(join(tmpAgentDir, "logs"))).toBe(false);
		});

		it("保留期清理：7 天前的 <ext>-<date>.log 被删，近期与本包 pattern 外文件保留", () => {
			process.env.TAIJI_AGENT_EXT_LOG = "1";
			// fake timers 冻结 Date 在真实当前时刻：文件 mtime 走真实时钟，utimesSync 把
			// old 的 mtime 设为 8 天前（> 7 天保留期），recent 与 unrelated 保留。
			const logDir = join(tmpAgentDir, "logs");
			mkdirSync(logDir, { recursive: true });
			const MS_PER_DAY = 24 * 60 * 60 * 1000;
			const oldTime = new Date(Date.now() - 8 * MS_PER_DAY);
			const oldFile = join(logDir, "cleanup-ext-2026-01-01.log");
			const recentFile = join(logDir, `keep-ext-${new Date().toISOString().slice(0, 10)}.log`);
			const unrelatedFile = join(logDir, "notes.txt");
			writeFileSync(oldFile, "old");
			writeFileSync(recentFile, "recent");
			writeFileSync(unrelatedFile, "keep");
			utimesSync(oldFile, oldTime, oldTime);

			const logger = createLogger("cleanup-ext", pi);
			logger.warn("trigger cleanup");

			expect(existsSync(oldFile)).toBe(false);
			expect(existsSync(recentFile)).toBe(true);
			expect(existsSync(unrelatedFile)).toBe(true);
			// 本次写入的文件在场（清理不误伤当前写路径）
			expect(existsSync(join(logDir, `cleanup-ext-${new Date().toISOString().slice(0, 10)}.log`))).toBe(true);
		});

		it("清理只认 <ext>-YYYY-MM-DD.log pattern，不动其他 .log 文件", () => {
			process.env.TAIJI_AGENT_EXT_LOG = "1";
			const logDir = join(tmpAgentDir, "logs");
			mkdirSync(logDir, { recursive: true });
			const MS_PER_DAY = 24 * 60 * 60 * 1000;
			const oldTime = new Date(Date.now() - 30 * MS_PER_DAY);
			const undated = join(logDir, "plain-old-name.log");
			writeFileSync(undated, "keep");
			utimesSync(undated, oldTime, oldTime);

			vi.setSystemTime(new Date("2026-08-01T12:34:56.789Z"));
			const logger = createLogger("pattern-ext", pi);
			logger.warn("trigger");

			expect(existsSync(undated)).toBe(true);
		});

		it("no-op 环境不触发保留期清理（零 fs 副作用覆盖清理路径）", () => {
			const logDir = join(tmpAgentDir, "logs");
			mkdirSync(logDir, { recursive: true });
			const MS_PER_DAY = 24 * 60 * 60 * 1000;
			const oldTime = new Date(Date.now() - 30 * MS_PER_DAY);
			const oldFile = join(logDir, "stale-ext-2026-01-01.log");
			writeFileSync(oldFile, "old");
			utimesSync(oldFile, oldTime, oldTime);

			const logger = createLogger("noop-clean-ext", pi);
			logger.debug("no-op");
			logger.warn("no-op");

			expect(existsSync(oldFile)).toBe(true);
			expect(readdirSync(logDir)).toContain("stale-ext-2026-01-01.log");
		});
	});

	// ============================================================
	// Per-message 固定窗口限流（P3 防线）
	// ============================================================
	describe("per-message 固定窗口限流", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("前 10 条同 msg warn 直写 appendEntry", () => {
			const logger = createLogger("ratelimit", pi);
			for (let i = 0; i < 10; i++) {
				logger.warn("hot path warning");
			}
			expect(appendSpy).toHaveBeenCalledTimes(10);
		});

		it("第 11-100 条同 msg warn 被抑制（计数仍 10）", () => {
			const logger = createLogger("ratelimit", pi);
			for (let i = 0; i < 100; i++) {
				logger.warn("hot path warning");
			}
			expect(appendSpy).toHaveBeenCalledTimes(10);
		});

		it("fake timers 推进 61s 后下一条触发聚合摘要 + 本条直写", () => {
			const logger = createLogger("ratelimit", pi);
			// 先发 100 条（10 条直写 + 90 条抑制）
			for (let i = 0; i < 100; i++) {
				logger.warn("hot path warning");
			}
			expect(appendSpy).toHaveBeenCalledTimes(10);

			// 推进 61s——窗口过期
			vi.advanceTimersByTime(61_000);

			// 下一条：先写聚合摘要（+90 suppressed），再写本条
			logger.warn("hot path warning");
			expect(appendSpy).toHaveBeenCalledTimes(12);

			// 验证聚合摘要 entry 内容
			const summaryCall = appendSpy.mock.calls[10]!;
			const summaryData = summaryCall[1] as { message: string };
			expect(summaryData.message).toContain("[+90 suppressed in last 60s]");

			// 验证本条 entry 是正常 warn
			const currentCall = appendSpy.mock.calls[11]!;
			const currentData = currentCall[1] as { message: string; level: string };
			expect(currentData.message).toBe("[ratelimit] hot path warning");
			expect(currentData.level).toBe("warn");
		});

		it("不同 msg 独立计数互不影响", () => {
			const logger = createLogger("ratelimit", pi);
			for (let i = 0; i < 15; i++) {
				logger.warn("msg-a");
			}
			for (let i = 0; i < 15; i++) {
				logger.warn("msg-b");
			}
			// 各自前 10 条直写 = 20
			expect(appendSpy).toHaveBeenCalledTimes(20);

			// 推进 61s 后，各触发 1 条聚合摘要 + 1 条本条 = 再加 4 条
			vi.advanceTimersByTime(61_000);
			logger.warn("msg-a");
			logger.warn("msg-b");
			expect(appendSpy).toHaveBeenCalledTimes(24);
		});

		it("Map cap 512 超限清空——所有 key 窗口重置", () => {
			const logger = createLogger("ratelimit", pi);
			// 填充 512 个不同 key（各发 1 条触发窗口创建）
			for (let i = 0; i < 512; i++) {
				logger.warn(`msg-${i}`);
			}
			expect(appendSpy).toHaveBeenCalledTimes(512);

			// 再发 1 条触发 cap 清空——此条也打开新窗口（count=1）
			logger.warn("msg-after-cap");
			expect(appendSpy).toHaveBeenCalledTimes(513);

			appendSpy.mockClear();
			// 推进时间让上面窗口过期，新窗口可直写 10 条
			vi.advanceTimersByTime(61_000);
			for (let i = 0; i < 10; i++) {
				logger.warn("msg-after-cap");
			}
			// 第一条过期后 suppressed=0 → "allow" + count=1，后 9 条 count→10 全 allow
			expect(appendSpy).toHaveBeenCalledTimes(10);
		});

		it("fileLog 通道不受限（TAIJI_AGENT_DEBUG=1 时 100 条全写文件）", () => {
			process.env.TAIJI_AGENT_DEBUG = "1";
			const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-ext-ratelimit-"));
			process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
			vi.setSystemTime(new Date("2026-08-01T12:34:56.789Z"));

			const logger = createLogger("rl-file", pi);
			for (let i = 0; i < 100; i++) {
				logger.warn("hot path warning");
			}

			// appendEntry 只被调用 10 次（限流生效）
			expect(appendSpy).toHaveBeenCalledTimes(10);

			// 但文件日志包含全部 100 条（fileLog 不受限流）
			const logFile = join(tmpAgentDir, "logs", "rl-file-2026-08-01.log");
			expect(existsSync(logFile)).toBe(true);
			const content = readFileSync(logFile, "utf8");
			const lines = content.split("\n").filter(Boolean);
			expect(lines).toHaveLength(100);

			rmSync(tmpAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		});

		it("appendEntry 抛错时降级不 throw（限流计数正常）", () => {
			const throwingPi: PiLike = {
				appendEntry: () => {
					throw new Error("session disposed");
				},
			};
			const logger = createLogger("rl-throw", throwingPi);

			// 10 条同 msg——appendEntry 每次抛但不 throw
			for (let i = 0; i < 10; i++) {
				expect(() => logger.warn("disposable")).not.toThrow();
			}
			// appendEntry 被调了 10 次（每条都 try 了）
			// 推进窗口过期，聚合摘要 + 本条 = 再调 2 次
			vi.advanceTimersByTime(61_000);
			expect(() => logger.warn("disposable")).not.toThrow();
			// appendEntry 异常时限流计数仍正常（不 throw、后续状态机不被破坏）
		});

		it("error 与 warn 同参数限流（一套机制）", () => {
			const logger = createLogger("ratelimit", pi);
			for (let i = 0; i < 15; i++) {
				logger.error("error path");
			}
			// error 前 10 条直写，第 11-15 条抑制
			expect(appendSpy).toHaveBeenCalledTimes(10);

			// 推进 61s 后聚合摘要 + 本条
			vi.advanceTimersByTime(61_000);
			logger.error("error path");
			expect(appendSpy).toHaveBeenCalledTimes(12);

			const summaryCall = appendSpy.mock.calls[10]!;
			const summaryData = summaryCall[1] as { message: string };
			expect(summaryData.message).toContain("[+5 suppressed in last 60s]");
		});
	});
});
