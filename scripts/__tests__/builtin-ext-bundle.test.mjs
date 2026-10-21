/**
 * builtin-ext-bundle wave 的机器验证测试（TC3/TC4/TC7，verification=unit）。
 *
 * 这三个 testCase 覆盖 esbuild bundle 方案的核心保证：
 *  - TC3：新增静态 value 依赖自动 inline（G3）—— 验 staged 产物含 inline 的 protocol value
 *  - TC4：跨 ext workspace value import 自动 inline —— 验 goal 产物含 countActiveFromEntries
 *  - TC7：fail-fast 拦截残缺产物 —— 验 verify-staged 对缺 wasm 的产物 exit 1
 *
 * 另覆盖 C-ext-31 门禁（pi-env admission guard）：verify-staged postbuild 挂点的
 * spawn 级红灯/正向用例（含 --engines-dir 引擎根扫描）+ bundle-extensions.mjs
 * 构建期接线锁定（见文件尾部两个 describe）。
 *
 * 依赖前置：testCommand 先跑 prepare-builtin-extensions.sh 产出 staged 产物，本测试只读校验。
 * TC1/TC2/TC5/TC6（dev/packaged 发会话、permission 解析 bash、source map）是 integration/e2e/manual，留 T7/T8。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync, mkdirSync, copyFileSync, readdirSync, writeFileSync, mkdtempSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
// C-ext-31 禁入标记登记表（门禁单一实现导出）——fixture 植入的标记取自本表，
// 不硬编码字面量：标记形态调整时红灯用例自动跟随
import { PI_ENV_ADMISSION_GUARD_MARKERS } from "../lib/pi-env-admission-gate.mjs";

const REPO = process.cwd();
const STAGED = join(REPO, "apps/electron/resources/extensions/@zhushanwen");
const VERIFY_SRC = join(REPO, "scripts/verify-staged-extensions.mjs");
const ASSET_DIR_LIB_SRC = join(REPO, "scripts/lib/staged-asset-dirs.mjs");
const GATE_LIB_SRC = join(REPO, "scripts/lib/pi-env-admission-gate.mjs");

/**
 * mirror 复制检查脚本进 <tmp>/scripts/ 时同步带 scripts/lib/ 下两个被 import 的
 * 共享模块——staged-asset-dirs.mjs（MF-1-17 单一来源）与
 * pi-env-admission-gate.mjs（C-ext-31 门禁单一实现）。mirror 缺任一文件即
 * MODULE_NOT_FOUND，全部 spawn 用例假红（C-ext-31 接线引入时的回归形态）。
 */
function stageVerifyGuardInto(root) {
	mkdirSync(join(root, "scripts/lib"), { recursive: true });
	copyFileSync(VERIFY_SRC, join(root, "scripts/verify-staged-extensions.mjs"));
	copyFileSync(ASSET_DIR_LIB_SRC, join(root, "scripts/lib/staged-asset-dirs.mjs"));
	copyFileSync(GATE_LIB_SRC, join(root, "scripts/lib/pi-env-admission-gate.mjs"));
}

describe("builtin-ext-bundle (wave:builtin-ext-bundle)", () => {
	it("TC3: bundle 自动 inline 静态 value 依赖（pi-ask-user 含 @zhushanwen/extension-protocol 的 runtime export）", () => {
		const idx = join(STAGED, "pi-ask-user/index.js");
		expect(existsSync(idx), "staged pi-ask-user/index.js 存在").toBe(true);
		const src = readFileSync(idx, "utf8");
		// @zhushanwen/extension-protocol 有 runtime value export（u5 迁移后 = uiFormInteract /
		// UI_FORM_MARKER，旧 ASK_USER_MARKER / PROTOCOL_VERSION 已随 a384df59d 换血移除），
		// esbuild 应将其 inline 进 bundle（非 external）。若 inline 失败，bundle 里不会有这些标识符。
		// 锚点换血记录（MF-2-1）：u5（a384df59d）ASK_USER_MARKER|PROTOCOL_VERSION →
		// uiFormInteract|UI_FORM_MARKER——协议范围再迁移时须同步更新此锚点，防过时恒红。
		expect(src, "protocol runtime value 被 inline").toMatch(/uiFormInteract|UI_FORM_MARKER/);
		// 反证：protocol 不应作为 external import 残留（@taiji 不是 virtualModule）
		expect(src, "无 @taiji external 残留 import").not.toMatch(/from\s+["']@taiji\//);
	});

	it("TC4: bundle 自动 inline 跨 ext workspace value import（pi-goal 含 pi-pending-notifications 的 countActiveFromEntries）", () => {
		const idx = join(STAGED, "pi-goal/index.js");
		expect(existsSync(idx)).toBe(true);
		const src = readFileSync(idx, "utf8");
		// countActiveFromEntries 是 goal 从 @zhushanwen/pi-pending-notifications 的 value import
		// （extensions/universal/goal/src/adapters/event-handlers/agent-end.ts），esbuild 应 inline。
		// 这正是本 bug 的根因形态（workspace value import 旧机制拷不到），bundle 从结构上消除。
		expect(src, "countActiveFromEntries 被 inline").toMatch(/countActiveFromEntries/);
		// 反证：pi-pending-notifications 不应作为 external import 残留
		expect(src, "无 pi-pending-notifications external 残留 import").not.toMatch(
			/from\s+["']@zhushanwen\/pi-pending-notifications["']/,
		);
	});

	/**
	 * TC7 fixture（mirror 形态，同 MF-1-6 makeMirror）：检查脚本复制进 <tmp>/scripts/
	 * （REPO_ROOT 即 <tmp>），SSOT fixture 只含 permission 且 staged 同集——SSOT 同集
	 * 断言恒过。非 wasm 形态不拷 skills/（真实 package.json 声明 pi.skills=["./skills"]），
	 * checkManifest 的 pi.skills 引用缺失与 wasm 缺失同时红灯（stderr 共 3 条失败），
	 * wasm 分支由 stderr toContain 定位断言钉住；正向对照 withWasm 拷齐 skills + 2 wasm
	 * → exit 0。改造前 tmp 单包直接对仓库真实 19 包 SSOT 跑 verify-staged，必然在 SSOT
	 * 分支先行 exit 1，exitCode 断言 trivially pass、wasm 分支从未触达（MF-2-3）。
	 */
	function makePermissionMirror({ withWasm = false } = {}) {
		const root = mkdtempSync(join(tmpdir(), "builtin-ext-bundle-staged-"));
		stageVerifyGuardInto(root);
		mkdirSync(join(root, "packages/shared/src"), { recursive: true });
		writeFileSync(
			join(root, "packages/shared/src/mandatory-extensions.json"),
			JSON.stringify([{ name: "@zhushanwen/pi-permission", description: "fixture", tier: "feature" }]),
			"utf8",
		);
		const scoped = join(root, "staged/@zhushanwen");
		const perm = join(scoped, "pi-permission");
		mkdirSync(perm, { recursive: true });
		// 构造残缺 staged：复制 permission（index.js + package.json），wasm 按 withWasm 决定是否拷
		copyFileSync(join(STAGED, "pi-permission/index.js"), join(perm, "index.js"));
		copyFileSync(join(STAGED, "pi-permission/package.json"), join(perm, "package.json"));
		if (withWasm) {
			for (const w of ["tree-sitter-bash.wasm", "web-tree-sitter.wasm"]) {
				copyFileSync(join(STAGED, "pi-permission", w), join(perm, w));
			}
			// 真实 package.json 声明 pi.skills=["./skills"]，正向对照须一并拷齐才能过 checkManifest
			cpSync(join(STAGED, "pi-permission/skills"), join(perm, "skills"), { recursive: true });
		}
		const run = () =>
			spawnSync(process.execPath, [join(root, "scripts/verify-staged-extensions.mjs"), "--staged-dir", scoped], {
				encoding: "utf8",
			});
		return { run, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) };
	}

	it("TC7: verify-staged 对残缺产物 fail-fast（pi-permission 缺 wasm → exit 1 + stderr 定位 wasm）", () => {
		// fs-guard：fixture 落 os.tmpdir() mkdtemp 自建自删（仓库相对 .cw/ 路径在白名单外被拦）
		const fx = makePermissionMirror();
		try {
			const r = fx.run();
			// fail-fast：缺 wasm 必须被拦截（exit 1），否则残缺产物会到 pi 加载时报错
			expect(r.status, "缺 wasm 时 verify-staged exit 1").toBe(1);
			// stderr 定位到 wasm 缺失本身，防 SSOT/manifest 等其它分支先行 exit 1 的假绿
			expect(r.stderr, "失败原因定位到 wasm").toContain("tree-sitter-bash.wasm");
		} finally {
			fx.cleanup();
		}
	});

	it("TC7 正向对照: pi-permission wasm 齐备 → exit 0", () => {
		// 同 fixture 拷入 2 个真实 wasm → 全部校验通过，证明红灯确由 wasm 缺失引起（防 fixture 系统性误红）
		const fx = makePermissionMirror({ withWasm: true });
		try {
			const r = fx.run();
			expect(r.status, "wasm 齐备应通过").toBe(0);
		} finally {
			fx.cleanup();
		}
	});

	it("TC8: bundle 拷贝 pi.skills 资源目录（M6a-04，manifest 资源拷贝分支）", () => {
		// pi-subagent-workflow 源码 package.json 声明 pi.skills=["./skills"]，
		// bundle-extensions.mjs 的 MANIFEST_RESOURCE_FIELDS 循环必须把这些目录随 bundle 拷到 staged。
		// 回归后果：拷贝循环被删 → 新装用户内置 skills 整体消失（staged 非 discovery 扫描源）。
		// [C1 convergence 86b700f67] 10 个 agent 模板迁至 packages/subagent-core/agents/（随
		// npm 包 files 分发），本包 pi.agents 声明与 agents/ 目录已删——agents 断言改为「不存在」，
		// 防止迁移回潮；manifest 资源拷贝分支的回归测试由 skills 单独承载（workflows 走 C 包
		// 专线拷贝，不经 manifest 字段，见 bundle-extensions.mjs 常量注释）。
		const swDir = join(STAGED, "pi-subagent-workflow");
		expect(existsSync(swDir), "staged pi-subagent-workflow 存在").toBe(true);

		// staged package.json：pi.extensions 改指 ./index.js，pi.skills 保留源声明
		const pkg = JSON.parse(readFileSync(join(swDir, "package.json"), "utf8"));
		expect(pkg.pi.extensions, "pi.extensions 改指 ./index.js").toEqual(["./index.js"]);
		expect(pkg.pi.agents, "pi.agents 声明已随 C1 迁移移除").toBeUndefined();
		expect(Array.isArray(pkg.pi.skills) && pkg.pi.skills.includes("./skills"), "pi.skills 声明保留").toBe(true);

		// 资源目录已拷贝且非空（证明 MANIFEST_RESOURCE_FIELDS 拷贝分支执行，非空目录创建）
		const skillsDir = join(swDir, "skills");
		expect(existsSync(skillsDir), "staged skills/ 目录已拷贝").toBe(true);
		// skills 含子目录（skill 包）—— 拷贝了内容而非空壳
		const skillEntries = existsSync(skillsDir) ? readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
		expect(skillEntries.length, "skills/ 含 skill 子目录（拷贝了内容）").toBeGreaterThan(0);

		// staged workflows/（u1-staged 起源 packages/subagent-core/workflows/，bundle 经
		// cp recursive 全量拷贝）与源目录文件集合一致且逐文件同字节（含 _shared/ 递归）
		// ——对齐「逐字节一致」验收语义：拷贝环节任何过滤/截断/编码漂移在此拦截。
		const wfSrcDir = join(REPO, "packages/subagent-core/workflows");
		const wfStagedDir = join(swDir, "workflows");
		expect(existsSync(wfStagedDir), "staged workflows/ 目录存在").toBe(true);
		/** 递归收集目录下全部文件的相对路径（含子目录，如 _shared/） */
		function listWorkflowFiles(dir, prefix = "") {
			const out = [];
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				const rel = prefix ? `${prefix}/${e.name}` : e.name;
				if (e.isDirectory()) out.push(...listWorkflowFiles(join(dir, e.name), rel));
				else out.push(rel);
			}
			return out;
		}
		const wfSrcFiles = listWorkflowFiles(wfSrcDir).sort();
		const wfStagedFiles = listWorkflowFiles(wfStagedDir).sort();
		expect(wfStagedFiles, "staged workflows 文件集合与源一致").toEqual(wfSrcFiles);
		for (const f of wfSrcFiles) {
			const srcBuf = readFileSync(join(wfSrcDir, f));
			const stagedBuf = readFileSync(join(wfStagedDir, f));
			expect(stagedBuf.equals(srcBuf), `workflows/${f} 逐字节一致`).toBe(true);
		}
	});
});

/**
 * verify-staged checkManifest 失败分支测试（M6a-09 / MF-3）。
 *
 * checkManifest 是 CI gate：staged package.json 的 pi manifest 引用必须自洽。
 * TC7 只覆盖 pi-permission 缺 wasm（wasm 校验，非 checkManifest），本组覆盖 checkManifest
 * 的 6 个失败分支——回归时任一分支失效会让残缺 manifest 的产物过 gate 进 pi 加载。
 *
 * 构造模式（mirror 形态，同 MF-1-6）：检查脚本复制进 <tmp>/scripts/（REPO_ROOT 即
 * <tmp>），SSOT fixture 只含 pi-test-pkg 且 staged 同集——SSOT 集合断言恒过，残缺
 * manifest 成为唯一红灯源；合法 index.js 过文件级检查到达 checkManifest；断言 stderr
 * 含对应失败文案，防其它分支先行 exit 1 的假绿。改造前 tmp 单包直接对仓库真实 19 包
 * SSOT 跑 verify-staged，六个用例的 exitCode 断言 trivially pass、checkManifest 分支
 * 从未触达（MF-2-3）。
 */
describe("verify-staged checkManifest failure branches (M6a-09, MF-3)", () => {
	let tmpBase;
	let tmpScoped;
	let tmpPkg;

	beforeEach(() => {
		// fs-guard：fixture 落 os.tmpdir() mkdtemp 自建自删（仓库相对 .cw/ 路径在白名单外被拦；
		// mkdtemp 每次全新目录，免旧路径的预清理 rmSync）
		tmpBase = mkdtempSync(join(tmpdir(), "builtin-ext-bundle-verify-"));
		stageVerifyGuardInto(tmpBase);
		mkdirSync(join(tmpBase, "packages/shared/src"), { recursive: true });
		writeFileSync(
			join(tmpBase, "packages/shared/src/mandatory-extensions.json"),
			JSON.stringify([{ name: "@zhushanwen/pi-test-pkg", description: "fixture", tier: "feature" }]),
			"utf8",
		);
		tmpScoped = join(tmpBase, "staged/@zhushanwen");
		tmpPkg = join(tmpScoped, "pi-test-pkg");
		mkdirSync(tmpPkg, { recursive: true });
		// 合法 index.js：过文件级检查（index.js 存在 + 无 .ts 残留），到达 checkManifest
		writeFileSync(join(tmpPkg, "index.js"), "export default {};\n", "utf8");
	});

	afterEach(() => {
		rmSync(tmpBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	/** 运行 mirror 内 verify-staged，返回 spawnSync 结果（status=0 通过，非 0 失败） */
	function runVerify() {
		return spawnSync(process.execPath, [join(tmpBase, "scripts/verify-staged-extensions.mjs"), "--staged-dir", tmpScoped], {
			encoding: "utf8",
		});
	}

	it("缺 package.json → exit 1 + stderr 定位缺 manifest", () => {
		// package.json 未生成（bundle 失败的早期回归）
		const r = runVerify();
		expect(r.status, "checkManifest 应报「缺 package.json」").toBe(1);
		expect(r.stderr, "失败原因定位到缺 package.json（非 SSOT 假绿）").toContain("缺 package.json");
	});

	it("package.json JSON 损坏 → exit 1 + stderr 定位解析失败", () => {
		writeFileSync(join(tmpPkg, "package.json"), "{ not valid json,,,", "utf8");
		const r = runVerify();
		expect(r.status, "checkManifest 应报「package.json 解析失败」").toBe(1);
		expect(r.stderr, "失败原因定位到解析失败").toContain("package.json 解析失败");
	});

	it("缺 pi.extensions 声明 → exit 1 + stderr 定位缺声明", () => {
		writeFileSync(
			join(tmpPkg, "package.json"),
			JSON.stringify({ name: "pi-test-pkg" }),
			"utf8",
		);
		const r = runVerify();
		expect(r.status, "checkManifest 应报「缺 pi.extensions 声明」").toBe(1);
		expect(r.stderr, "失败原因定位到缺 pi.extensions 声明").toContain("缺 pi.extensions 声明");
	});

	it("pi.extensions 引用不存在的文件 → exit 1 + stderr 定位引用缺失", () => {
		writeFileSync(
			join(tmpPkg, "package.json"),
			JSON.stringify({ name: "pi-test-pkg", pi: { extensions: ["./nonexistent.js"] } }),
			"utf8",
		);
		const r = runVerify();
		expect(r.status, "checkManifest 应报「pi.extensions 引用文件缺失」").toBe(1);
		expect(r.stderr, "失败原因定位到引用文件缺失").toContain("pi.extensions 引用文件缺失");
	});

	it("pi.{agents,skills,workflows} 资源引用缺失 → exit 1 + stderr 定位资源缺失", () => {
		// pi.extensions 合法（指 ./index.js），但 pi.agents 引用未拷贝的目录 → bundle 拷贝逻辑回归
		writeFileSync(
			join(tmpPkg, "package.json"),
			JSON.stringify({
				name: "pi-test-pkg",
				pi: { extensions: ["./index.js"], agents: ["./agents"] },
			}),
			"utf8",
		);
		const r = runVerify();
		expect(r.status, "checkManifest 应报「pi.agents 引用缺失」").toBe(1);
		expect(r.stderr, "失败原因定位到 pi.agents 引用缺失").toContain("pi.agents 引用缺失");
	});

	it("pi.extensions 含非字符串项 → exit 1 + stderr 定位非字符串项", () => {
		writeFileSync(
			join(tmpPkg, "package.json"),
			JSON.stringify({ name: "pi-test-pkg", pi: { extensions: [{ bad: "object" }] } }),
			"utf8",
		);
		const r = runVerify();
		expect(r.status, "checkManifest 应报「pi.extensions 含非字符串项」").toBe(1);
		expect(r.stderr, "失败原因定位到非字符串项").toContain("pi.extensions 含非字符串项");
	});

	it("合法 manifest → exit 0（正向对照：mirror fixture 无系统性误红）", () => {
		writeFileSync(
			join(tmpPkg, "package.json"),
			JSON.stringify({ name: "pi-test-pkg", pi: { extensions: ["./index.js"] } }),
			"utf8",
		);
		const r = runVerify();
		expect(r.status, "合法 manifest 应通过（SSOT fixture 与 staged 同集、manifest 自洽）").toBe(0);
	});
});

/**
 * verify-staged per-package 特殊资产目录校验测试（MF-1-6）。
 *
 * plan 的 templates/ 由 bundle-extensions.mjs 专项拷贝（scripts/lib/staged-asset-dirs.mjs
 * 登记表驱动），不走 pi manifest 三字段——checkManifest 探测不到，缺失 = 打包版
 * list-template 恒 0 / select-template 恒 null 的静默失效（templates.ts scanTemplateDir
 * 防御性返回空清单、listTemplates 仅 warn）。共享登记表是唯一 postbuild 拦截点。
 *
 * 构造模式（tmp mirror × spawnSync，同 check-guide-contract-projection 惯例）：
 * 检查脚本复制进 <tmp>/scripts/（REPO_ROOT 即 <tmp>，SSOT mandatory-extensions.json
 * 落 fixture），staged 给全量最小合法包集（每包 index.js + pi.extensions 指向它）
 * ——SSOT 集合断言与 manifest 校验恒通过，templates 缺失成为唯一红灯源；并对
 * stderr 断言定位原因，防「其它校验先行 exit 1」的假绿。
 */
describe("verify-staged per-package asset dirs (MF-1-6)", () => {
	/**
	 * 组装 tmp mirror。planTemplates 三形态：undefined = 不建 templates/（缺失）、
	 * "empty" = 空目录、nonempty = 含一个 .md（正向对照）。
	 */
	function makeMirror({ planTemplates } = {}) {
		const root = mkdtempSync(join(tmpdir(), "verify-staged-assets-"));
		stageVerifyGuardInto(root);
		// SSOT fixture：最小两包集，不含 permission（绕开 wasm 专项校验的无关面）
		mkdirSync(join(root, "packages/shared/src"), { recursive: true });
		writeFileSync(
			join(root, "packages/shared/src/mandatory-extensions.json"),
			JSON.stringify([
				{ name: "@zhushanwen/pi-plan", description: "fixture", tier: "feature" },
				{ name: "@zhushanwen/pi-ask-user", description: "fixture", tier: "feature" },
			]),
			"utf8",
		);
		const scoped = join(root, "staged/@zhushanwen");
		for (const pkgDirName of ["pi-plan", "pi-ask-user"]) {
			const pkgDir = join(scoped, pkgDirName);
			mkdirSync(pkgDir, { recursive: true });
			writeFileSync(join(pkgDir, "index.js"), "export default {};\n", "utf8");
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({ name: `@zhushanwen/${pkgDirName}`, pi: { extensions: ["./index.js"] } }),
				"utf8",
			);
		}
		if (planTemplates === "empty") {
			mkdirSync(join(scoped, "pi-plan/templates"));
		} else if (planTemplates === "nonempty") {
			mkdirSync(join(scoped, "pi-plan/templates"));
			writeFileSync(join(scoped, "pi-plan/templates/feature-plan.md"), "# plan\n", "utf8");
		}
		const run = () =>
			spawnSync(
				process.execPath,
				[join(root, "scripts/verify-staged-extensions.mjs"), "--staged-dir", scoped],
				{ encoding: "utf8" },
			);
		return { run, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) };
	}

	it("pi-plan 缺 templates/ → exit 1 + stderr 定位 templates（缺失形态）", () => {
		const fx = makeMirror();
		try {
			const r = fx.run();
			expect(r.status, "缺 templates/ 必须 fail-fast").toBe(1);
			expect(r.stderr, "失败原因定位到 templates（非 SSOT/manifest 假绿）").toContain("templates");
		} finally {
			fx.cleanup();
		}
	});

	it("pi-plan templates/ 空目录 → exit 1 + stderr 定位 templates（空与缺失同罪）", () => {
		const fx = makeMirror({ planTemplates: "empty" });
		try {
			const r = fx.run();
			expect(r.status, "空 templates/ 必须 fail-fast").toBe(1);
			expect(r.stderr, "失败原因定位到 templates").toContain("templates");
		} finally {
			fx.cleanup();
		}
	});

	it("pi-plan templates/ 非空 → exit 0（正向对照：资产齐备不误报）", () => {
		const fx = makeMirror({ planTemplates: "nonempty" });
		try {
			const r = fx.run();
			expect(r.status, "资产齐备应通过").toBe(0);
		} finally {
			fx.cleanup();
		}
	});
});

/**
 * C-ext-31 门禁的 verify-staged 接线测试（pi-env admission gate）。
 *
 * 门禁单一实现在 scripts/lib/pi-env-admission-gate.mjs，两个挂点：
 * bundle-extensions.mjs（构建期，接线锁定见下方 describe）与
 * verify-staged-extensions.mjs（postbuild，本组用例）。完整包集 mirror
 * （SSOT 与 staged 同集，集合断言恒过）中植入禁入标记 → spawn 真
 * verify-staged → 断言 exit 1 且 stderr 定位包名与 C-ext-31 恢复动作；
 * --engines-dir 传入时引擎 staged 根同扫（与构建期覆盖对齐），目录不存在
 * 静默跳过。无标记 fixture 正向对照 exit 0（门禁不误拦合法产物）。
 */
describe("verify-staged C-ext-31 pi-env admission gate", () => {
	/**
	 * 组装 tmp mirror。marker = pi-ask-user 的 index.js 植入禁入标记；
	 * engines = 建 <root>/engines/zcode 引擎产物，enginesMarker = 其 index.js 植入标记。
	 */
	function makeGateMirror({ marker = false, engines = false, enginesMarker = false } = {}) {
		const root = mkdtempSync(join(tmpdir(), "verify-staged-gate-"));
		stageVerifyGuardInto(root);
		mkdirSync(join(root, "packages/shared/src"), { recursive: true });
		writeFileSync(
			join(root, "packages/shared/src/mandatory-extensions.json"),
			JSON.stringify([
				{ name: "@zhushanwen/pi-plan", description: "fixture", tier: "feature" },
				{ name: "@zhushanwen/pi-ask-user", description: "fixture", tier: "feature" },
			]),
			"utf8",
		);
		/**
		 * 植入形态：登记表内每个禁入标记各造一条 throw（标记是 bundle 源码的子串匹配，
		 * 任一条命中即红灯）。标记形态调整（函数名 ↔ 错误文案段）时 fixture 自动跟随；
		 * 登记表被清空则植入代码退化为合法 bundle、红灯用例失败——「门禁恒绿」形态
		 * 必须被测试抓到，不做宽容。
		 */
		const planted = (tag) =>
			`export default {};\n${PI_ENV_ADMISSION_GUARD_MARKERS.map((m) => `throw new Error(${JSON.stringify(`${m}: ${tag}`)});`).join("\n")}\n`;
		const scoped = join(root, "staged/@zhushanwen");
		for (const pkgDirName of ["pi-plan", "pi-ask-user"]) {
			const pkgDir = join(scoped, pkgDirName);
			mkdirSync(pkgDir, { recursive: true });
			writeFileSync(
				join(pkgDir, "index.js"),
				marker && pkgDirName === "pi-ask-user" ? planted("planted") : "export default {};\n",
				"utf8",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({ name: `@zhushanwen/${pkgDirName}`, pi: { extensions: ["./index.js"] } }),
				"utf8",
			);
		}
		// plan 的 templates/ 是 verify 侧专项校验项，正向对照（exit 0）须齐备；
		// 红灯用例门禁先行（main 内早于逐包校验），与此无关。
		mkdirSync(join(scoped, "pi-plan/templates"), { recursive: true });
		writeFileSync(join(scoped, "pi-plan/templates/feature-plan.md"), "# plan\n", "utf8");
		const enginesDir = join(root, "engines");
		if (engines) {
			const engineDir = join(enginesDir, "zcode");
			mkdirSync(engineDir, { recursive: true });
			writeFileSync(
				join(engineDir, "index.js"),
				enginesMarker ? planted("planted engine") : "export default {};\n",
				"utf8",
			);
			writeFileSync(
				join(engineDir, "package.json"),
				JSON.stringify({ name: "fixture-engine", type: "module" }),
				"utf8",
			);
		}
		const run = (extraArgs = []) =>
			spawnSync(
				process.execPath,
				[join(root, "scripts/verify-staged-extensions.mjs"), "--staged-dir", scoped, ...extraArgs],
				{ encoding: "utf8" },
			);
		return {
			run,
			enginesDir,
			cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
		};
	}

	it("扩展 bundle 植入禁入标记 → exit 1 + stderr 定位包名与 C-ext-31 恢复动作", () => {
		const fx = makeGateMirror({ marker: true });
		try {
			const r = fx.run();
			expect(r.status, "C-ext-31 门禁必须 fail-fast（打包态 subagent 全灭事故形态）").toBe(1);
			expect(r.stderr, "违规 bundle 定位到植入包").toContain("pi-ask-user");
			expect(r.stderr, "错误消息含约束编号 C-ext-31").toContain("C-ext-31");
			expect(r.stderr, "错误消息含恢复动作锚点（resolveSessionStoreBase）").toContain(
				"resolveSessionStoreBase",
			);
		} finally {
			fx.cleanup();
		}
	});

	it("干净 bundle → exit 0（正向对照：门禁不误拦合法产物）", () => {
		const fx = makeGateMirror();
		try {
			const r = fx.run();
			expect(r.status, "无标记应通过").toBe(0);
		} finally {
			fx.cleanup();
		}
	});

	it("引擎 bundle 植入标记 + --engines-dir → exit 1 + stderr 定位引擎产物（postbuild 覆盖对齐构建期）", () => {
		const fx = makeGateMirror({ engines: true, enginesMarker: true });
		try {
			const r = fx.run(["--engines-dir", fx.enginesDir]);
			expect(r.status, "引擎产物禁入标记必须被 postbuild 拦截").toBe(1);
			expect(r.stderr, "违规 bundle 定位到引擎产物").toContain("zcode");
			expect(r.stderr, "错误消息含约束编号 C-ext-31").toContain("C-ext-31");
		} finally {
			fx.cleanup();
		}
	});

	it("--engines-dir 指向不存在目录 → 静默跳过（宽容形态，不影响扩展侧校验）", () => {
		const fx = makeGateMirror();
		try {
			const r = fx.run(["--engines-dir", join(fx.enginesDir, "nonexistent")]);
			expect(r.status, "engines 目录不存在时应静默跳过并正常通过").toBe(0);
		} finally {
			fx.cleanup();
		}
	});
});

/**
 * C-ext-31 门禁在 bundle-extensions.mjs 的接线锁定（源码文本级）。
 *
 * 断言曾藏在 bundleEngines() 函数体末尾、main() 仅间接触发——引擎 staging
 * 逻辑重构可无声吞掉门禁。现断言固定在 main() 内 staging 全部完成之后执行；
 * 本用例锁死「await bundleEngines() 之后存在 assertNoPiEnvAdmissionGuard
 * 调用」的源码顺序，并反向锁定 bundleEngines() 函数体不再持断言。
 */
describe("C-ext-31 gate wiring lock (bundle-extensions.mjs)", () => {
	it("门禁断言位于 main() 内 staging 完成后（await bundleEngines() 之后）", () => {
		const bundleSrc = readFileSync(join(REPO, "scripts/bundle-extensions.mjs"), "utf8");
		expect(bundleSrc, "bundle 侧 import 门禁单一实现").toContain(
			'from "./lib/pi-env-admission-gate.mjs"',
		);
		expect(bundleSrc, "门禁调用在 await bundleEngines() 之后（main 内，与 staging 解耦）").toMatch(
			/await bundleEngines\(\);[\s\S]*assertNoPiEnvAdmissionGuard\(/,
		);
		const enginesFnStart = bundleSrc.indexOf("async function bundleEngines()");
		expect(enginesFnStart, "bundleEngines() 函数在场").toBeGreaterThan(-1);
		const enginesFnBody = bundleSrc.slice(enginesFnStart, bundleSrc.lastIndexOf("main();"));
		expect(enginesFnBody, "bundleEngines() 函数体内不得再持门禁断言").not.toContain(
			"assertNoPiEnvAdmissionGuard",
		);
	});
});

/**
 * staged 特殊资产目录单一登记表结构检查（MF-1-17）。
 *
 * bundle 侧 templates/ 专项拷贝与 verify 侧 staged 校验共读 scripts/lib/staged-asset-dirs.mjs
 * 的唯一登记表（键 = 包 short 名，值 = staged 包根下资产目录名）——原「双登记 + 仅注释
 * 互指」结构已删除（bundle 侧加条目漏改 verify 侧时 MF-1-6 校验静默失效、缺失形态复辟，
 * 运行期无任何红灯）。本用例做结构性回归检查：两脚本必须 import 共享登记表、不得另持
 * 字面量表；登记表本体非空（空表 = bundle 不拷 + verify 不查的双侧失明）。
 */
describe("staged asset dirs single-source registry (MF-1-17)", () => {
	it("两脚本均消费共享登记表且不再各持字面量表", () => {
		const bundleSrc = readFileSync(join(REPO, "scripts/bundle-extensions.mjs"), "utf8");
		const verifySrc = readFileSync(join(REPO, "scripts/verify-staged-extensions.mjs"), "utf8");

		expect(bundleSrc, "bundle 侧 import 共享登记表").toContain('from "./lib/staged-asset-dirs.mjs"');
		expect(bundleSrc, "bundle 侧不得另持 TEMPLATES_DIR_PACKAGES 字面量 Set").not.toMatch(
			/TEMPLATES_DIR_PACKAGES\s*=\s*new Set/,
		);
		expect(verifySrc, "verify 侧 import 共享登记表").toContain('from "./lib/staged-asset-dirs.mjs"');
		expect(verifySrc, "verify 侧不得另持 PACKAGE_ASSET_DIRS 字面量表").not.toMatch(/const PACKAGE_ASSET_DIRS\s*=\s*\{/);

		const libSrc = readFileSync(join(REPO, "scripts/lib/staged-asset-dirs.mjs"), "utf8");
		const tableBody = libSrc.match(/export const PACKAGE_ASSET_DIRS = \{([\s\S]*?)\n\};/)?.[1] ?? "";
		const shorts = [...tableBody.matchAll(/^\t(\S+):/gm)].map((m) => m[1]);
		expect(shorts.length, "登记表条目非空（空表 = bundle 不拷 + verify 不查的双侧失明）").toBeGreaterThan(0);
	});
});
