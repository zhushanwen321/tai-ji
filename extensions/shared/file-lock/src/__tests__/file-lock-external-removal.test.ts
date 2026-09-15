// src/__tests__/file-lock-external-removal.test.ts
//
// 锁目录被外部删除的容忍路径单测（真实文件系统）。前身 file-lock-compromise.test.ts
// （proper-lockfile onCompromised：保活定时器 stat 发现锁被删 → ERELEASED → debug 留痕）。
// D1-A 自实现无保活 touch（边界声明见 lock-core.ts 头注释），compromise 检测不存在：
//   - fn 执行期间锁目录被外部删除 → 无定时器发现，fn 正常返回
//   - release 时 rmdir 命中 ENOENT → 静默成功（照抄 proper-lockfile removeLock 容忍），
//     不外抛、不影响 fn 结果；同目标随后可立即再锁（目录确已消失，非残留态）

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withFileLockSync } from "../file-lock.ts";

describe("withFileLockSync 锁目录被外部删除（原 compromise 场景的自实现语义）", () => {
	let tmpDir: string;
	let target: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-extrem-"));
		target = path.join(tmpDir, "target.json");
	});
	afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

	it("fn 执行期间锁被外部删除 → fn 正常返回 + release 静默成功 + 可立即再锁", () => {
		const result = withFileLockSync(
			target,
			() => {
				// 模拟外部清理（对端 stale 夺取会先 rmdir 再 mkdir；此处直接删）：
				// 自实现无保活定时器，删除本身不触发任何回调
				fs.rmSync(`${target}.lock`, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
				return "fn-done";
			},
			{ staleMs: 2000 },
		);

		// fn 结果原样返回（无 compromised 拦截——该机制随保活一并移除）
		expect(result).toBe("fn-done");
		// release 对已消失的锁目录静默成功（ENOENT 容忍）——由下一断言间接证明：
		// 若 release 抛错，sync 版 finally 不吞错会直接外抛；直接再锁验证锁已释放
		expect(withFileLockSync(target, () => "again")).toBe("again");
	});

	it("fn 抛错且锁目录已被外部删除 → 错误照常外抛 + release 不叠加失败", () => {
		expect(() =>
			withFileLockSync(target, () => {
				fs.rmSync(`${target}.lock`, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
				throw new Error("boom");
			}),
		).toThrow("boom");
		// finally 的 release 对 ENOENT 静默——不遮蔽原始 boom 错误（上方断言已过）
	});
});
