/**
 * pi-env-admission-gate.mjs 单测（C-ext-31）。
 *
 * 门禁自身退化的风险形态：标记清单被清空 / 扫描只认第一层不递归到 <pkg>/index.js /
 * 违规被静默吞掉（collect 返回非空但 assert 不抛）——任何一条回归都会让
 * 2026-10-19 打包版 subagent 全灭事故形态重新溜进 staged bundle。锁定行为：
 *  1. 标记命中（函数名 / 错误文案两标记、含 keepNames __name 形态）
 *  2. staged 树扫描只认 <pkg>/index.js，目录缺失/无 index.js 的包静默跳过
 *  3. assert 非空即抛，错误消息含恢复动作与违规文件清单；空清单不抛
 *
 * 运行：cd <repo-root> && pnpm exec vitest run scripts/__tests__/pi-env-admission-gate.test.mjs
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	PI_ENV_ADMISSION_GUARD_MARKERS,
	findPiEnvAdmissionGuardMarker,
	collectPiEnvAdmissionGuardViolations,
	assertNoPiEnvAdmissionGuard,
} from "../lib/pi-env-admission-gate.mjs";

/** 造一个 staged 树 fixture：<root>/<pkg>/index.js（内容可控）。 */
function makeStagedRoot(packages) {
	const root = mkdtempSync(join(tmpdir(), "pi-env-gate-"));
	for (const [name, code] of Object.entries(packages)) {
		mkdirSync(join(root, name), { recursive: true });
		writeFileSync(join(root, name, "index.js"), code);
	}
	return root;
}

describe("findPiEnvAdmissionGuardMarker（单 bundle 标记检测）", () => {
	it("两标记各自命中：函数名（keepNames __name 形态）与错误文案段", () => {
		expect(
			findPiEnvAdmissionGuardMarker('__name(assertNotLeakedProdDataDir, "assertNotLeakedProdDataDir")'),
		).toBe("assertNotLeakedProdDataDir");
		expect(
			findPiEnvAdmissionGuardMarker('throw new Error("... leaked env detected (C-proc-26 prod-admission guard).")'),
		).toBe("prod-admission guard");
	});

	it("干净 bundle（纯公式 + base 通道形态）返回 null", () => {
		const clean = 'import { getSessionStoreDir } from "@taiji/shared/session-store-paths"; const base = dataDir ?? getEngineDataDir();';
		expect(findPiEnvAdmissionGuardMarker(clean)).toBe(null);
	});

	it("标记清单非空（防清单被清空致门禁恒绿）", () => {
		expect(PI_ENV_ADMISSION_GUARD_MARKERS.length).toBeGreaterThan(0);
	});
});

describe("collectPiEnvAdmissionGuardViolations（staged 树扫描）", () => {
	it("命中违规包并给出文件与标记；干净包不报", async () => {
		const root = makeStagedRoot({
			"pi-subagent-workflow": "function getDataDir(){assertNotLeakedProdDataDir(env)}",
			"pi-ask-user": "export default function factory(){ return {}; }",
		});
		try {
			const violations = await collectPiEnvAdmissionGuardViolations([root]);
			expect(violations).toHaveLength(1);
			expect(violations[0].file).toBe(join(root, "pi-subagent-workflow", "index.js"));
			expect(violations[0].marker).toBe("assertNotLeakedProdDataDir");
		} finally {
			rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	});

	it("不存在的根静默跳过；无 index.js 的包不扫（verify-staged 对自定义目录的宽容形态）", async () => {
		const root = makeStagedRoot({
			"pkg-without-bundle": "",
		});
		rmSync(join(root, "pkg-without-bundle", "index.js"));
		try {
			expect(await collectPiEnvAdmissionGuardViolations([root, join(root, "no-such-root")])).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	});
});

describe("assertNoPiEnvAdmissionGuard（fail-fast 出口）", () => {
	it("非空违规抛错，消息含恢复动作与违规文件", () => {
		const file = join(tmpdir(), "staged", "pi-x", "index.js");
		expect(() =>
			assertNoPiEnvAdmissionGuard([{ file, marker: "prod-admission guard" }], "[gate] 红灯："),
		).toThrow(/C-ext-31[\s\S]*session-store-paths[\s\S]*resolveSessionStoreBase[\s\S]*pi-x/);
	});

	it("空清单不抛", () => {
		expect(() => assertNoPiEnvAdmissionGuard([], "[gate]")).not.toThrow();
	});
});
