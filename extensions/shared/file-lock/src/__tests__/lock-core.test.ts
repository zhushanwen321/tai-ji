// src/__tests__/lock-core.test.ts
//
// lock-core 零依赖锁原语单测（真实文件系统，不 mock fs）：
//   - mkdir 上锁 / rmdir 释放（<目标>.lock 目录协议）
//   - ELOCKED 错误码（async/sync 同构）
//   - stale 判死夺取（先 rmdir 再 mkdir）+ stale 下限 clamp 2000ms
//   - realpath:false 语义：不存在的目标可锁；symlink 目标锁在 symlink 路径（不解析）
//   - graceful exit 兜底：子进程持锁正常退出后锁目录被 process.on('exit') 清理
//
// 协议参照：proper-lockfile@4.1.2 实装（pi 内嵌同款），逐字段兼容是 S3 互斥探针的前提。

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acquireLock, acquireLockSync } from "../lock-core.ts";

// 真实文件系统 IO（含子进程），放宽文件级预算（vitest 默认 5s）
vi.setConfig({ testTimeout: 20000 });

const PKG_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/** 手工构造一把「死亡进程遗留」的锁：mkdir + mtime 回拨 ageMs。 */
function seedDeadLock(target: string, ageMs: number): string {
	const lockPath = `${target}.lock`;
	fs.mkdirSync(lockPath, { recursive: true });
	const past = new Date(Date.now() - ageMs);
	fs.utimesSync(lockPath, past, past);
	return lockPath;
}

describe("acquireLock / release（async）", () => {
	let tmpDir: string;
	let target: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-core-test-"));
		target = path.join(tmpDir, "target.json");
	});
	afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

	it("acquire 创建 <目标>.lock 目录，release 删除", async () => {
		const release = await acquireLock(target);
		const lockPath = `${target}.lock`;
		expect(fs.existsSync(lockPath)).toBe(true);
		expect(fs.statSync(lockPath).isDirectory()).toBe(true);
		await release();
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it("release 幂等（二调 no-op 不抛错）", async () => {
		const release = await acquireLock(target);
		await release();
		await expect(release()).resolves.toBeUndefined();
	});

	it("重复 acquire 同一目标 → ELOCKED（code + file 字段）", async () => {
		const release = await acquireLock(target);
		try {
			const err = await acquireLock(target).catch((e: unknown) => e);
			expect((err as { code?: string }).code).toBe("ELOCKED");
			expect((err as { file?: string }).file).toBe(target);
			expect((err as Error).message).toContain("Lock file is already being held");
		} finally {
			await release();
		}
	});

	it("stale 判死夺取：mtime 超龄 → 先 rmdir 再 mkdir，锁目录 mtime 刷新", async () => {
		seedDeadLock(target, 31_000);
		const logs: string[] = [];
		const before = fs.statSync(`${target}.lock`).mtime.getTime();
		const release = await acquireLock(target, { log: (m) => logs.push(m) });
		try {
			const lockPath = `${target}.lock`;
			// 锁目录仍是目录（rmdir 后重新 mkdir），且 mtime 已刷新（夺取 = 新建）
			expect(fs.statSync(lockPath).isDirectory()).toBe(true);
			expect(fs.statSync(lockPath).mtime.getTime()).toBeGreaterThanOrEqual(before);
			// 诊断日志注入可见（stale 夺取分支）
			expect(logs.some((m) => m.includes("stale lock taken over"))).toBe(true);
		} finally {
			await release();
		}
	});

	it("stale 下限 clamp 2000ms（照抄 proper-lockfile）：staleMs 50 实际按 2000 判死", async () => {
		// mtime 老 1.5s（居中于 1s/2s 判定线之间，余量防 timing 抖动）：staleMs 50 →
		// clamp 为 2000 → 1500 < 2000 不判死 → ELOCKED。若实现漏掉 clamp（直接用 50），
		// 50 < 1500 将错误夺取 → 本用例红。超龄夺取路径由「stale 判死夺取」用例覆盖
		seedDeadLock(target, 1_500);
		await expect(acquireLock(target, { staleMs: 50 })).rejects.toMatchObject({ code: "ELOCKED" });
		// 清理测试自造的锁目录（acquire 未持有，afterEach 的 rmSync 亦可清，显式表达意图）
		fs.rmSync(`${target}.lock`, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	it("realpath:false：不存在的目标可锁；symlink 目标锁在 symlink 路径（不解析）", async () => {
		// 目标文件不存在也可锁（realpath:true 时 ENOENT）
		const release = await acquireLock(target);
		expect(fs.existsSync(`${target}.lock`)).toBe(true);
		await release();

		// symlink 目标：锁必须落在 `${symlink}.lock`，不得解析到真实路径
		const realTarget = path.join(tmpDir, "real.json");
		fs.writeFileSync(realTarget, "{}", "utf-8");
		const linkPath = path.join(tmpDir, "link.json");
		fs.symlinkSync(realTarget, linkPath);
		const releaseLink = await acquireLock(linkPath);
		try {
			expect(fs.existsSync(`${linkPath}.lock`)).toBe(true);
			expect(fs.existsSync(`${realTarget}.lock`)).toBe(false);
		} finally {
			await releaseLink();
		}
	});

	it("路径规范化：path.resolve 归一化（.. 消除后同锁）", async () => {
		const release = await acquireLock(path.join(tmpDir, "sub", "..", "target.json"));
		try {
			// sub/.. 归一化为 tmpDir 本身 → 锁在 `${tmpDir}/target.json.lock`
			expect(fs.existsSync(`${path.join(tmpDir, "target.json")}.lock`)).toBe(true);
			expect(fs.existsSync(`${path.join(tmpDir, "sub")}`)).toBe(false);
		} finally {
			await release();
		}
	});
});

describe("acquireLockSync", () => {
	let tmpDir: string;
	let target: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-core-sync-test-"));
		target = path.join(tmpDir, "target.json");
	});
	afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

	it("acquire/release 同构 async 版（目录创建与删除）", () => {
		const release = acquireLockSync(target);
		expect(fs.statSync(`${target}.lock`).isDirectory()).toBe(true);
		release();
		expect(fs.existsSync(`${target}.lock`)).toBe(false);
	});

	it("重复 acquireSync → ELOCKED", () => {
		const release = acquireLockSync(target);
		try {
			try {
				acquireLockSync(target);
				expect.unreachable("must throw");
			} catch (err) {
				expect((err as Error).message).toContain("Lock file is already being held");
				expect((err as { code?: string }).code).toBe("ELOCKED");
			}
		} finally {
			release();
		}
	});

	it("sync 版 stale 夺取", () => {
		seedDeadLock(target, 31_000);
		const logs: string[] = [];
		const release = acquireLockSync(target, { log: (m) => logs.push(m) });
		try {
			expect(fs.statSync(`${target}.lock`).isDirectory()).toBe(true);
			expect(logs.some((m) => m.includes("stale lock taken over"))).toBe(true);
		} finally {
			release();
		}
	});
});

describe("graceful exit 兜底（process.on('exit') 配对 rmdir）", () => {
	it("子进程持锁正常退出后，锁目录被 exit hook 清理（无需等 stale）", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-core-exit-"));
		const target = path.join(tmpDir, "target.json");
		try {
			// 子进程 acquire 后自然退出（graceful exit）——'exit' hook 必须清掉锁目录。
			// 子进程内先断言锁已创建（证明「锁曾存在」），失败以非零退出码表达（不用
			// console——extensions 日志规范禁 console；诊断信息由父进程断言消息带出）。
			const worker = `
import * as fs from "node:fs";
import { acquireLock } from "${PKG_DIR}/src/lock-core.ts";
const target = process.argv[2];
await acquireLock(target);
if (!fs.existsSync(target + ".lock")) {
	process.exit(1);
}
`;
			const workerFile = path.join(tmpDir, "worker.ts");
			fs.writeFileSync(workerFile, worker, "utf-8");
			const proc = spawnSync(process.execPath, ["--experimental-strip-types", workerFile, target], {
				encoding: "utf-8",
				timeout: 30_000,
			});
			// 失败消息带出 worker stderr/stdout，保证非零退出时调试信息不丢
			expect(proc.status, `worker stderr: ${proc.stderr} stdout: ${proc.stdout}`).toBe(0);
			// graceful exit 后锁目录不残留（等价 proper-lockfile signal-exit 清理语义）
			expect(fs.existsSync(`${target}.lock`)).toBe(false);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	});
});
