import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearConfigCache, getConfigPath, loadConfig, saveConfig } from "../config.ts";
import * as fileLock from "@zhushanwen/pi-file-lock";

// mock 掉共享 logger，使 loggerMock.warn 可被断言（saveConfig 非致命降级路径的留痕）
const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

// node:fs 的 ESM namespace 不可配置，vi.spyOn 对具名导出失效（vitest 限制）。
// 用 vi.mock 包装 readFileSync/renameSync/statSync/unlinkSync（默认走 actual，
// 个别 test override），其他 fs 操作（writeFileSync/existsSync/mkdirSync...）原样
// 透传 actual。statSync/unlinkSync 供 U4 logger.warn 留痕用例 override。
// 注意：withFileLockSync 内部为自实现 mkdir-lock（lock-core.ts，零依赖直用 node:fs，非 proper-lockfile）；本 mock 默认透传 actual，锁行为不受影响。
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal() as typeof import("node:fs");
	return {
		...actual,
		readFileSync: vi.fn(actual.readFileSync),
		renameSync: vi.fn(actual.renameSync),
		statSync: vi.fn(actual.statSync),
		unlinkSync: vi.fn(actual.unlinkSync),
	};
});

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "llm-shared-cfg-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	clearConfigCache();
	// 预创建 config/ 子目录（loadConfig fixture 直接 writeFileSync 需要目录已存在；
	// saveConfig 内部会自己 mkdir，但 loadConfig fixture 不会）
	mkdirSync(join(dir, "config"), { recursive: true });
});

afterEach(() => {
	vi.mocked(fs.readFileSync).mockClear();
	vi.mocked(fs.renameSync).mockClear();
	vi.mocked(fs.statSync).mockClear();
	vi.mocked(fs.unlinkSync).mockClear();
	loggerMock.warn.mockClear();
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	vi.unstubAllEnvs();
});

/** 测试用 normalize：对象含 a → 原样，否则默认 {a:0}。 */
const normalize = (raw: unknown): { a: number } => {
	if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && "a" in raw) {
		return { a: (raw as { a: number }).a };
	}
	return { a: 0 };
};

describe("getConfigPath", () => {
	it("TC17 走 getAgentDir（PI_CODING_AGENT_DIR 覆盖生效）", () => {
		expect(getConfigPath("rename-session")).toBe(join(dir, "config", "rename-session-ext-config.json"));
	});
});

describe("loadConfig", () => {
	it("TC14 文件存在 → 解析 + normalize", () => {
		writeFileSync(join(dir, "config", "test-ext-config.json"), JSON.stringify({ a: 1 }));
		expect(loadConfig("test", { a: 0 }, normalize)).toEqual({ a: 1 });
	});

	it("TC14 mtime+size 不变 → 命中缓存（readFileSync 只调一次）", () => {
		writeFileSync(join(dir, "config", "test-ext-config.json"), JSON.stringify({ a: 1 }));
		vi.mocked(fs.readFileSync).mockClear();

		const r1 = loadConfig("test", { a: 0 }, normalize);
		const r2 = loadConfig("test", { a: 0 }, normalize);

		expect(r1).toEqual({ a: 1 });
		expect(r2).toEqual({ a: 1 });
		// statSync 命中缓存，readFileSync 只调一次
		expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledTimes(1);
	});

	it("TC14 缓存返回值是深拷贝（改返回值不污染缓存）", () => {
		writeFileSync(join(dir, "config", "test-ext-config.json"), JSON.stringify({ a: 1 }));
		const r1 = loadConfig("test", { a: 0 }, normalize);
		r1.a = 999; // 篡改返回值
		const r2 = loadConfig("test", { a: 0 }, normalize);
		expect(r2).toEqual({ a: 1 }); // 缓存未被污染
	});

	it("TC15 文件不存在 → defaults", () => {
		expect(loadConfig("missing", { a: 0 }, normalize)).toEqual({ a: 0 });
	});

	it("TC15 坏 JSON → defaults + onWarning 回调", () => {
		writeFileSync(join(dir, "config", "bad-ext-config.json"), "{not json");
		const onWarning = vi.fn();
		expect(loadConfig("bad", { a: 0 }, normalize, onWarning)).toEqual({ a: 0 });
		expect(onWarning).toHaveBeenCalledTimes(1);
	});

	it("C1: mtime 变化（size 不变）→ 重新 readFileSync（缓存失效重读）", () => {
		const cfgPath = join(dir, "config", "test-ext-config.json");
		// v1: {"a":1}（7 字节），mtime 固定 1s → mtimeMs=1000
		writeFileSync(cfgPath, JSON.stringify({ a: 1 }));
		utimesSync(cfgPath, 1, 1);
		loadConfig("test", { a: 0 }, normalize); // 首次读，cache=(1000ms, 7)

		// v2: {"a":2}（仍 7 字节，size 不变），mtime 改为 2s → mtimeMs=2000
		writeFileSync(cfgPath, JSON.stringify({ a: 2 }));
		utimesSync(cfgPath, 2, 2);

		vi.mocked(fs.readFileSync).mockClear();
		const loaded = loadConfig("test", { a: 0 }, normalize);

		expect(loaded).toEqual({ a: 2 });
		// mtime 变化 → 缓存失效 → 重读
		expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledTimes(1);
	});

	it("C1: size 变化但 mtime 不变（APFS 截断模拟）→ 触发重读（双 key 设计核心验证）", () => {
		const cfgPath = join(dir, "config", "test-ext-config.json");
		// v1: {"a":1}（7 字节），mtime 固定 1s
		writeFileSync(cfgPath, JSON.stringify({ a: 1 }));
		utimesSync(cfgPath, 1, 1);
		loadConfig("test", { a: 0 }, normalize); // cache=(1000ms, 7)

		// v2: {"a":99}（8 字节，size 变），mtime 强制回 1s（模拟 APFS 精度截断：内容变了 mtime 没变）
		writeFileSync(cfgPath, JSON.stringify({ a: 99 }));
		utimesSync(cfgPath, 1, 1);

		vi.mocked(fs.readFileSync).mockClear();
		const loaded = loadConfig("test", { a: 0 }, normalize);

		expect(loaded).toEqual({ a: 99 });
		// size 变化 → 缓存失效 → 重读（即使 mtimeMs 相同，双 key 设计的核心价值）
		expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledTimes(1);
	});
});

describe("saveConfig", () => {
	/** tmp 残留断言（D1e 唯一化后 tmp 名为 <path>.tmp_<pid>_<rand>，用前缀 glob 断言）。 */
	function tmpResidues(pkg: string): string[] {
		const cfgDir = join(dir, "config");
		return readdirSync(cfgDir).filter((f) => f.startsWith(`${pkg}-ext-config.json.tmp`));
	}

	it("TC16 原子写：文件落盘 + 内容正确 + 无 tmp 残留", () => {
		const result = saveConfig("test", { b: 2 });
		expect(result.success).toBe(true);

		const cfgPath = join(dir, "config", "test-ext-config.json");
		expect(existsSync(cfgPath)).toBe(true);
		expect(JSON.parse(readFileSync(cfgPath, "utf-8"))).toEqual({ b: 2 });
		expect(tmpResidues("test")).toEqual([]); // 无 tmp 残留（唯一化 tmp 名，前缀断言）
	});

	it("TC16 文件 mode 0o600", () => {
		saveConfig("test", { b: 2 });
		const cfgPath = join(dir, "config", "test-ext-config.json");
		const mode = statSync(cfgPath).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("TC16 写后 loadConfig 命中缓存返回新值（写后读竞态覆盖）", () => {
		saveConfig("test", { a: 5 });
		// saveConfig 写后已更新缓存，loadConfig 直接命中（不重读盘）
		vi.mocked(fs.readFileSync).mockClear();
		const loaded = loadConfig("test", { a: 0 }, normalize);
		expect(loaded).toEqual({ a: 5 });
		expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled();
	});

	it("review RK3: renameSync throw → {success:false} + tmp 被清理", () => {
		// mock renameSync 抛 EPERM，模拟 rename 失败（writeFileSync 已创建 tmp）
		vi.mocked(fs.renameSync).mockImplementationOnce(() => {
			throw new Error("EPERM: operation not permitted, rename");
		});

		const result = saveConfig("fail", { x: 1 });

		expect(result.success).toBe(false);
		expect(result.error).toContain("EPERM");
		// tmp 文件被 catch 块的 unlinkSync 清理（唯一化 tmp 名，前缀断言）
		expect(tmpResidues("fail")).toEqual([]);
		// 目标文件未被创建（rename 失败）
		expect(existsSync(join(dir, "config", "fail-ext-config.json"))).toBe(false);
	});

	it("探针 4: renameSync ENOENT → {success:false} + onWarning 含 Failed to save config + tmp 清理", () => {
		// mock renameSync 抛 ENOENT（目标目录被删/路径无效场景）
		vi.mocked(fs.renameSync).mockImplementationOnce(() => {
			throw new Error("ENOENT: no such file or directory, rename");
		});
		const onWarning = vi.fn();

		const result = saveConfig("enoent", { x: 1 }, onWarning);

		expect(result.success).toBe(false);
		expect(result.error).toContain("ENOENT");
		// onWarning 输出前缀契约：`[llm-shared] Failed to save config at '<path>': <message>`
		expect(onWarning).toHaveBeenCalledTimes(1);
		const warning = String(onWarning.mock.calls[0][0]);
		expect(warning).toContain("[llm-shared] Failed to save config at '" + join(dir, "config", "enoent-ext-config.json") + "'");
		expect(warning).toContain("[llm-shared] Failed to save config at '" + join(dir, "config", "enoent-ext-config.json") + "'");
		expect(warning).toContain("ENOENT");
		// tmp 清理（前缀断言）+ 目标未创建
		expect(tmpResidues("enoent")).toEqual([]);
		expect(existsSync(join(dir, "config", "enoent-ext-config.json"))).toBe(false);
	});

	it("探针 4: renameSync EPERM → onWarning 输出契约 + {success:false}（Windows 目标占用模拟）", () => {
		vi.mocked(fs.renameSync).mockImplementationOnce(() => {
			throw new Error("EPERM: operation not permitted, rename");
		});
		const onWarning = vi.fn();

		const result = saveConfig("eperm", { x: 1 }, onWarning);

		expect(result.success).toBe(false);
		expect(onWarning).toHaveBeenCalledTimes(1);
		const warning = String(onWarning.mock.calls[0][0]);
		expect(warning).toContain("[llm-shared] Failed to save config at '" + join(dir, "config", "eperm-ext-config.json") + "'");
		expect(warning).toContain("EPERM");
		// tmp 清理（Windows 目标占用场景 rename 失败后 tmp 残留被清理；前缀断言）
		expect(tmpResidues("eperm")).toEqual([]);
		expect(existsSync(join(dir, "config", "eperm-ext-config.json"))).toBe(false);
	});

	it("U4: rename 成功但写后 stat 失败 → logger.warn 留痕 + 保存仍成功（缓存未更新，下次 load 重读）", () => {
		// saveConfig 流程内 node:fs 的 statSync 只有写后更新缓存这一次调用
		// （withFileLockSync 走 graceful-fs，不经过本 mock），once 必命中
		vi.mocked(fs.statSync).mockImplementationOnce(() => {
			throw new Error("EACCES: permission denied, stat");
		});

		const result = saveConfig("statfail", { x: 1 });

		// stat 失败不影响保存成功语义（缓存下次 load 时会重读）
		expect(result.success).toBe(true);
		expect(loggerMock.warn).toHaveBeenCalledTimes(1);
		expect(String(loggerMock.warn.mock.calls[0]![0])).toContain("saveConfig stat after write failed");
		expect(JSON.stringify(loggerMock.warn.mock.calls[0]![1])).toContain("EACCES");
		// 文件已落盘（rename 已成功）
		expect(JSON.parse(readFileSync(join(dir, "config", "statfail-ext-config.json"), "utf-8"))).toEqual({ x: 1 });
		// 缓存未更新（stat 失败跳过 set）→ 下次 load 重读盘而非命中缓存
		vi.mocked(fs.readFileSync).mockClear();
		const loaded = loadConfig("statfail", { a: 0 }, normalize);
		expect(loaded).toEqual({ a: 0 }); // normalize({x:1}) 不含 a → defaults
		expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledTimes(1);
	});

	it("U4: rename 失败且 tmp 清理也失败 → logger.warn 留痕 + {success:false}（清理失败不吞保存失败）", () => {
		vi.mocked(fs.renameSync).mockImplementationOnce(() => {
			throw new Error("EPERM: operation not permitted, rename");
		});
		// unlinkSync 在本流程内只有 catch 路径的 tmp 清理这一次调用，once 必命中
		vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
			throw new Error("EBUSY: resource busy or locked, unlink");
		});
		const onWarning = vi.fn();

		const result = saveConfig("cleanupfail", { x: 1 }, onWarning);

		// 保存失败的返回不被清理失败吞掉
		expect(result.success).toBe(false);
		expect(result.error).toContain("EPERM");
		expect(onWarning).toHaveBeenCalledTimes(1);
		// tmp 清理失败留痕
		expect(loggerMock.warn).toHaveBeenCalledTimes(1);
		expect(String(loggerMock.warn.mock.calls[0]![0])).toContain("saveConfig tmp cleanup failed");
		expect(JSON.stringify(loggerMock.warn.mock.calls[0]![1])).toContain("EBUSY");
		// unlink 失败 → tmp 残留（反向证明清理路径确实失败）
		expect(tmpResidues("cleanupfail")).toHaveLength(1);
		// 目标文件未被创建（rename 失败）
		expect(existsSync(join(dir, "config", "cleanupfail-ext-config.json"))).toBe(false);
	});

	it("saveConfig 多次写同文件 → 每次成功 + 最新内容", () => {
		expect(saveConfig("test", { v: 1 }).success).toBe(true);
		expect(saveConfig("test", { v: 2 }).success).toBe(true);
		expect(JSON.parse(readFileSync(join(dir, "config", "test-ext-config.json"), "utf-8"))).toEqual({ v: 2 });
	});

	it("W4 锁不可用（ELOCKED 预算耗尽）→ {success:false} + 不降级无锁写（目标文件不落盘）", () => {
		// 模拟 runtime 对端长期持锁：withFileLockSync 抛 ELOCKED。扩展侧契约 =
		// 不降级无锁写（降级会与 runtime 持锁写交错丢字段），按保存失败返回。
		const lockErr = Object.assign(new Error("[file-lock] lock unavailable: ELOCKED"), { code: "ELOCKED" });
		const spy = vi.spyOn(fileLock, "withFileLockSync").mockImplementation(() => {
			throw lockErr;
		});
		const onWarning = vi.fn();

		try {
			const result = saveConfig("lockbusy", { x: 1 }, onWarning);

			expect(result.success).toBe(false);
			expect(result.error).toContain("lock unavailable");
			expect(onWarning).toHaveBeenCalledTimes(1);
			// 关键：未降级写盘（无锁写会破坏与 runtime 的互斥）
			expect(existsSync(join(dir, "config", "lockbusy-ext-config.json"))).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});
});
