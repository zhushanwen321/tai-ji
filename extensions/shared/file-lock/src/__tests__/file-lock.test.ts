// src/__tests__/file-lock.test.ts
//
// 跨进程文件锁单测（真实文件系统，不 mock fs）：
//   - sync 版临界区互斥（并发不交错）
//   - unlock 后可再锁（finally 释放语义）
//   - sync 版 fail-fast（ELOCKED 预算耗尽抛错，不用默认 1s——测试覆盖盖短预算）
//   - 真实跨进程互斥：两个 node 子进程并发 RMW 同一 JSON 文件，计数零丢失
//     （「两写方并发不丢条目」的 D5a/D1e 核心验收形态）

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withFileLockSync } from "../file-lock.ts";

// 本文件全部用例都是真实文件系统 IO（跨进程锁、子进程 RMW），CI 慢盘上单次用例
// 可达 7s+，统一放宽文件级预算（vitest 默认 5s）——断言强度不受影响
vi.setConfig({ testTimeout: 20000 });

const PKG_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

describe("withFileLockSync", () => {
	let tmpDir: string;
	let target: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-sync-test-"));
		target = path.join(tmpDir, "target.json");
	});
	afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

	it("返回 fn 结果且锁已释放（可立即再锁）", () => {
		expect(withFileLockSync(target, () => 42)).toBe(42);
		expect(withFileLockSync(target, () => "again")).toBe("again");
	});

	it("fn 抛错也释放锁", () => {
		expect(() =>
			withFileLockSync(target, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(withFileLockSync(target, () => "ok")).toBe("ok");
	});

	it("ELOCKED fail-fast：预算耗尽抛带 code 的错误（不用默认 1s 预算）", () => {
		// 先占锁（外层 sync 锁），再在 fn 内嵌套取锁 → 必 ELOCKED → 短预算快速失败
		expect(() =>
			withFileLockSync(
				target,
				() =>
					withFileLockSync(target, () => "never", {
						staleMs: 60_000, // stale 远大于预算，锁不会被夺取
						retryDelayMs: 10,
						retryBudgetMs: 30,
					}),
				{ staleMs: 60_000 },
			),
		).toThrowError(/ELOCKED 重试预算 30ms 耗尽/);
	});
});

describe("真实跨进程互斥（D5a/D1e 验收形态）", () => {
	it("两个子进程并发 RMW 同一 JSON 各 50 次，终值 100 零丢失", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-xproc-"));
		const target = path.join(tmpDir, "shared.json");
		fs.writeFileSync(target, JSON.stringify({ n: 0 }), "utf-8");
	try {
		// 子进程脚本：--experimental-strip-types 直接跑 TS 源码（Node >= 22.6），
		// 循环 50 次锁内读-改-写。exitCode 非 0 = 子进程自身失败（锁/IO 异常）。
		// 锁获取形态：withFileLockSync 传 retryBudgetMs:0（单次 fail-fast）+ 外层
		// ELOCKED 固定 20ms 间隔重试自旋、30s 预算（对齐 runtime 侧
		// pi-settings-store.test.ts 的 acquireLikePi 修复形态）——满载下临界区持有
		// 窗口可能被 OS 抢占拉长，默认 fail-fast 预算会被偶发耗尽致子进程非零退出；
		// 重试预算保证合理时间内必能拿到锁，互斥语义（lock-core 层）不受等待形态影响。
		const worker = `
import * as fs from "node:fs";
import { withFileLockSync } from "${PKG_DIR}/src/file-lock.ts";
const target = process.argv[2];
async function lockedRmw() {
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			return withFileLockSync(target, () => {
				const cur = JSON.parse(fs.readFileSync(target, "utf-8"));
				cur.n += 1;
				fs.writeFileSync(target, JSON.stringify(cur), "utf-8");
			}, { retryBudgetMs: 0 });
		} catch (err) {
			if (!err || err.code !== "ELOCKED" || Date.now() >= deadline) throw err;
			await new Promise((r) => setTimeout(r, 20));
		}
	}
}
for (let i = 0; i < 50; i++) {
	await lockedRmw();
}
`;
			// src 内相对 import 无 .ts 后缀（runtime tsc 无 allowImportingTsExtensions 的
			// 兼容形态，见 file-lock.ts 头注释），而 Node strip-types 的 ESM 严格扩展名解析
			// 要求显式后缀——resolve 钩子在 ERR_MODULE_NOT_FOUND 时补 .ts，两个约束的交集。
			// 纯 JS（钩子自身不经 strip-types），只对相对 specifier 生效。
			const resolveHook = `
export async function resolve(specifier, context, next) {
	if (specifier.startsWith("./") || specifier.startsWith("../")) {
		try {
			return await next(specifier, context);
		} catch (err) {
			if (err && err.code === "ERR_MODULE_NOT_FOUND") return next(specifier + ".ts", context);
			throw err;
		}
	}
	return next(specifier, context);
}
`;
			const registerScript = `
import { register } from "node:module";
register("./resolve-hook.mjs", import.meta.url);
`;
			fs.writeFileSync(path.join(tmpDir, "resolve-hook.mjs"), resolveHook, "utf-8");
			fs.writeFileSync(path.join(tmpDir, "register-hooks.mjs"), registerScript, "utf-8");
			const workerFile = path.join(tmpDir, "worker.ts");
			fs.writeFileSync(workerFile, worker, "utf-8");
			const procs = [1, 2].map(() =>
				spawnSync(
					process.execPath,
					["--experimental-strip-types", "--import", path.join(tmpDir, "register-hooks.mjs"), workerFile, target],
					{ encoding: "utf-8", timeout: 60_000 },
				),
			);
			for (const p of procs) {
				// 失败消息带出 worker stderr/stdout，保证非零退出时调试信息不丢
				expect(p.status, `worker stderr: ${p.stderr} stdout: ${p.stdout}`).toBe(0);
			}
			expect((JSON.parse(fs.readFileSync(target, "utf-8")) as { n: number }).n).toBe(100);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
		// 用例级预算须覆盖子进程 spawnSync timeout（60s，内含自旋重试预算 30s）：
		// 文件级 20s 会在子进程合法重试期间先红——预算放宽不改变断言强度（终值精确 100）
	}, 90_000);
});
