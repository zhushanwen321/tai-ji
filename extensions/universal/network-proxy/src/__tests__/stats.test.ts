/**
 * stats 增量行格式 + 单行 write 原子性（任务书验收②）。
 * 单行原子性 = 每次 appendFileSync 调用的 payload 恰好是一行完整 JSON + \n（O_APPEND 单次
 * write 是多 pi 进程并发追加不交错的实现前提，防改为分片 write 时静默交错）。
 * fs-guard 白名单：写入目标 = PI_CODING_AGENT_DIR 注入的 mkdtemp tmp 目录。
 */
import * as fs from "node:fs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { appendCalls } = vi.hoisted(() => ({
	appendCalls: [] as Array<{ path: string; data: string }>,
}));

// node:fs 的 ESM namespace 不可配置，vi.spyOn 对具名导出失效（vitest 限制，llm-shared 同款）——
// 用 vi.mock 包装 appendFileSync（默认透传原始实现并记录调用），其余 fs 操作原样透传。
// 注意：本文件级 mock 覆盖 fs-guard 全局 mock（fs-guard 头注已登记的既有形态）——本文件
// 写入目标全部为 mkdtemp tmp，自守白名单纪律。
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal() as typeof import("node:fs");
	return {
		...actual,
		appendFileSync: vi.fn((path: string, data: string) => {
			appendCalls.push({ path, data });
			return actual.appendFileSync(path, data);
		}),
	};
});

const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

import {
	flushStats,
	recordDispatch,
	resetCounters,
	snapshotCounters,
	statsFilePath,
} from "../stats.ts";

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "network-proxy-stats-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	resetCounters();
	appendCalls.length = 0;
	loggerMock.warn.mockClear();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("stats 增量行格式", () => {
	it("flush 后每行完整 JSON：字段 {ts, host, proxied, direct}，ts 为 flush 时刻 ISO 串", () => {
		recordDispatch("api.anthropic.com", true);
		recordDispatch("open.bigmodel.cn", false);
		flushStats();

		const lines = readFileSync(statsFilePath(), "utf-8").split("\n").filter((l) => l !== "");
		expect(lines).toHaveLength(2);
		const rows = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
		expect(rows).toContainEqual({
			ts: expect.any(String),
			host: "api.anthropic.com",
			proxied: 1,
			direct: 0,
		});
		expect(rows).toContainEqual({
			ts: expect.any(String),
			host: "open.bigmodel.cn",
			proxied: 0,
			direct: 1,
		});
		for (const row of rows) {
			expect(() => new Date(row.ts as string).toISOString()).not.toThrow();
		}
	});

	it("flush 清空已写增量，下次 flush 只写新增量（追加式增量行语义）", () => {
		recordDispatch("a.test", true);
		flushStats();
		expect(readFileSync(statsFilePath(), "utf-8").trim().split("\n")).toHaveLength(1);

		recordDispatch("b.test", false);
		flushStats();
		const lines = readFileSync(statsFilePath(), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1]).host).toBe("b.test");
	});

	it("同主机名聚合：多次同向计数累加为一行", () => {
		recordDispatch("api.anthropic.com", true);
		recordDispatch("api.anthropic.com", true);
		recordDispatch("api.anthropic.com", false);
		flushStats();
		const rows = readFileSync(statsFilePath(), "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(rows).toEqual([
			{ ts: expect.any(String), host: "api.anthropic.com", proxied: 2, direct: 1 },
		]);
	});

	it("空增量 flush 零 IO（不建目录不写文件）", () => {
		flushStats();
		expect(appendCalls).toHaveLength(0);
	});

	it("snapshotCounters / resetCounters（内存视图）", () => {
		recordDispatch("a.test", true);
		expect(snapshotCounters().get("a.test")).toEqual({ proxied: 1, direct: 0 });
		resetCounters();
		expect(snapshotCounters().size).toBe(0);
	});
});

describe("单行 write 原子性", () => {
	it("每行恰好一次 appendFileSync 调用，payload 为单行完整 JSON + \\n（禁止分片 write）", () => {
		recordDispatch("api.anthropic.com", true);
		recordDispatch("open.bigmodel.cn", false);
		flushStats();

		expect(appendCalls).toHaveLength(2);
		for (const call of appendCalls) {
			expect(call.path).toBe(statsFilePath());
			expect(call.data.endsWith("\n")).toBe(true);
			expect(call.data.split("\n")).toHaveLength(2); // 单行内容 + 尾换行
			const row = JSON.parse(call.data);
			expect(Object.keys(row).sort()).toEqual(["direct", "host", "proxied", "ts"]);
		}
	});
});

describe("写失败不阻断（log + 增量保留重试）", () => {
	it("appendFileSync 抛错 → warn 留痕 + 增量保留；恢复后重试成功且不丢行", () => {
		recordDispatch("a.test", true);
		recordDispatch("b.test", false);

		vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
		});
		expect(() => flushStats()).not.toThrow();
		expect(loggerMock.warn).toHaveBeenCalledTimes(1);
		// 失败行的增量保留在内存
		expect(snapshotCounters().size).toBe(2);

		// 恢复：重试把保留的增量完整落盘
		flushStats();
		const hosts = readFileSync(statsFilePath(), "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l).host);
		expect(hosts).toEqual(["a.test", "b.test"]);
		expect(snapshotCounters().size).toBe(0);
	});
});
