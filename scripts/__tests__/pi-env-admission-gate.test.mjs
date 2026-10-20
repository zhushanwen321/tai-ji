/**
 * pi-env-admission-gate.mjs 单测（C-ext-31）。
 *
 * 门禁自身退化的风险形态：标记清单被清空 / 标记与 paths.ts 真实来源漂移（改名、改文案
 * 后门禁对含准入检查的新 bundle 静默全绿）/ 标记退化成注释可命中形态（bundler 保留
 * 注释时误拦合法 bundle）/ 扫描只认第一层不递归到 <pkg>/index.js / 违规被静默吞掉
 * （collect 返回非空但 assert 不抛）——任何一条回归都会让 2026-10-19 打包版 subagent
 * 全灭事故形态重新溜进 staged bundle。锁定行为：
 *  1. 标记命中（函数定义/调用点字面量、错误文案段两标记，含 keepNames __name 共现形态）
 *  2. 合法注释（含准入检查机制表述的注释文本）不误拦——标记只可能出现在可执行代码里
 *  3. staged 树扫描只认 <pkg>/index.js，目录缺失/无 index.js 的包静默跳过
 *  4. assert 非空即抛，错误消息含恢复动作与违规文件清单；空清单不抛
 *  5. 标记与 packages/shared/src/paths.ts 真实来源对拍（漂移即红）；合法 pi 子树模块
 *     （session-store-paths.ts）源码不含任何标记（注释撞串即红）
 *
 * 运行：cd <repo-root> && pnpm exec vitest run scripts/__tests__/pi-env-admission-gate.test.mjs
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
	PI_ENV_ADMISSION_GUARD_MARKERS,
	findPiEnvAdmissionGuardMarker,
	collectPiEnvAdmissionGuardViolations,
	assertNoPiEnvAdmissionGuard,
} from "../lib/pi-env-admission-gate.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 标记的真实来源（C-proc-26 准入检查本体）：改名/改文案漂移即门禁静默全绿。 */
const PATHS_TS = join(REPO_ROOT, "packages/shared/src/paths.ts");
/** 合法 pi 子树模块（纯公式）：其源码（含注释）不得出现任何禁入标记。 */
const SESSION_STORE_PATHS_TS = join(REPO_ROOT, "packages/shared/src/session-store-paths.ts");

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
	it("两标记各自命中：函数定义/调用点字面量与错误文案段（bundle 实测形态）", () => {
		// esbuild keepNames 实测产物形态（paths.ts 经同选项 bundle 的探针输出，2026-10-20）：
		// 定义、__name 包装、调用点三形态共现；定义/调用点的参数表是标记 1 的命中点。
		const bundleForm =
			'function assertNotLeakedProdDataDir(env) { throw new Error("... leaked env detected (C-proc-26 prod-admission guard).") }\n' +
			'__name(assertNotLeakedProdDataDir, "assertNotLeakedProdDataDir");\n' +
			"export function getDataDir(env = process.env) { assertNotLeakedProdDataDir(env); }";
		expect(findPiEnvAdmissionGuardMarker(bundleForm)).toBe("assertNotLeakedProdDataDir(env");
		expect(
			findPiEnvAdmissionGuardMarker('throw new Error("... leaked env detected (C-proc-26 prod-admission guard).")'),
		).toBe("(C-proc-26 prod-admission guard)");
	});

	it("干净 bundle（纯公式 + base 通道形态）返回 null", () => {
		const clean = 'import { getSessionStoreDir } from "@taiji/shared/session-store-paths"; const base = dataDir ?? getEngineDataDir();';
		expect(findPiEnvAdmissionGuardMarker(clean)).toBe(null);
	});

	it("含合法注释的 bundle 不误拦（标记只可能出现在可执行代码里）", () => {
		// 合法 pi 子树源码注释会陈述门禁机制本身（含准入检查的函数名/文案名）——
		// bundler 保留注释（legal-comments）时这类文本进 bundle 也不得命中。
		const withLegalComment =
			"// 机器门禁扫 staged bundle，出现准入检查标记（assertNotLeakedProdDataDir / prod-admission guard）即构建失败。\n" +
			'import { getSessionStoreDir } from "@taiji/shared/session-store-paths";';
		expect(findPiEnvAdmissionGuardMarker(withLegalComment)).toBe(null);
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
			expect(violations[0].marker).toBe("assertNotLeakedProdDataDir(env");
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
			assertNoPiEnvAdmissionGuard([{ file, marker: "(C-proc-26 prod-admission guard)" }], "[gate] 红灯："),
		).toThrow(/C-ext-31[\s\S]*session-store-paths[\s\S]*resolveSessionStoreBase[\s\S]*pi-x/);
	});

	it("空清单不抛", () => {
		expect(() => assertNoPiEnvAdmissionGuard([], "[gate]")).not.toThrow();
	});
});

describe("PI_ENV_ADMISSION_GUARD_MARKERS 与真实来源对拍（防漂移 / 防误拦）", () => {
	it("每个标记字面量都真实出现在 paths.ts 源码中（改名/改文案漂移即红）", () => {
		const source = readFileSync(PATHS_TS, "utf8");
		for (const marker of PI_ENV_ADMISSION_GUARD_MARKERS) {
			expect(
				source,
				`标记「${marker}」在 packages/shared/src/paths.ts 源码中已不存在——` +
					"paths.ts 改名/改文案后标记未同步，门禁会对含准入检查代码的新 bundle 静默放行" +
					"（2026-10-19 打包版 subagent 全灭事故形态复溜且无信号）",
			).toContain(marker);
		}
	});

	it("合法 pi 子树模块（session-store-paths.ts）源码不含任何标记（注释撞串即红）", () => {
		const source = readFileSync(SESSION_STORE_PATHS_TS, "utf8");
		for (const marker of PI_ENV_ADMISSION_GUARD_MARKERS) {
			expect(
				source,
				`标记「${marker}」出现在 packages/shared/src/session-store-paths.ts——` +
					"bundler 保留注释（legal-comments）时合法 bundle 会被误拦；" +
					"注释陈述须避开「只可能出现在可执行代码里」的标记字面量",
			).not.toContain(marker);
		}
	});
});
