/**
 * builtin-ext-bundle wave 的机器验证测试（TC3/TC4/TC7，verification=unit）。
 *
 * 这三个 testCase 覆盖 esbuild bundle 方案的核心保证：
 *  - TC3：新增静态 value 依赖自动 inline（G3）—— 验 staged 产物含 inline 的 protocol value
 *  - TC4：跨 ext workspace value import 自动 inline —— 验 goal 产物含 countActiveFromEntries
 *  - TC7：fail-fast 拦截残缺产物 —— 验 verify-staged 对缺 wasm 的产物 exit 1
 *
 * 依赖前置：testCommand 先跑 prepare-builtin-extensions.sh 产出 staged 产物，本测试只读校验。
 * TC1/TC2/TC5/TC6（dev/packaged 发会话、permission 解析 bash、source map）是 integration/e2e/manual，留 T7/T8。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync, mkdirSync, copyFileSync, readdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const REPO = process.cwd();
const STAGED = join(REPO, "apps/electron/resources/extensions/@zhushanwen");

describe("builtin-ext-bundle (wave:builtin-ext-bundle)", () => {
	it("TC3: bundle 自动 inline 静态 value 依赖（pi-ask-user 含 @taiji/extension-protocol 的 runtime export）", () => {
		const idx = join(STAGED, "pi-ask-user/index.js");
		expect(existsSync(idx), "staged pi-ask-user/index.js 存在").toBe(true);
		const src = readFileSync(idx, "utf8");
		// @taiji/extension-protocol 有 runtime value export（PROTOCOL_VERSION/ASK_USER_MARKER），
		// esbuild 应将其 inline 进 bundle（非 external）。若 inline 失败，bundle 里不会有这些标识符。
		expect(src, "protocol runtime value 被 inline").toMatch(/ASK_USER_MARKER|PROTOCOL_VERSION/);
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

	it("TC7: verify-staged 对残缺产物 fail-fast（pi-permission 缺 wasm → exit 1）", () => {
		// 构造残缺 staged：复制 permission（index.js + package.json）但故意不拷 2 个 wasm
		const tmpScoped = join(REPO, ".cw/builtin-ext-bundle/tmp-staged/@zhushanwen");
		const tmpPerm = join(tmpScoped, "pi-permission");
		rmSync(tmpScoped, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		mkdirSync(tmpPerm, { recursive: true });
		copyFileSync(join(STAGED, "pi-permission/index.js"), join(tmpPerm, "index.js"));
		copyFileSync(join(STAGED, "pi-permission/package.json"), join(tmpPerm, "package.json"));

		const verify = join(REPO, "scripts/verify-staged-extensions.mjs");
		let exitCode = 0;
		try {
			execSync(`node "${verify}" --staged-dir "${tmpScoped}"`, { stdio: "pipe", cwd: REPO });
		} catch (err) {
			exitCode = err.status ?? 1;
		}
		rmSync(tmpScoped, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		// fail-fast：缺 wasm 必须被拦截（exit 非 0），否则残缺产物会到 pi 加载时报错
		expect(exitCode, "缺 wasm 时 verify-staged exit 非 0").not.toBe(0);
	});

	it("TC8: bundle 拷贝 pi.skills 资源目录（M6a-04，manifest 资源拷贝分支）", () => {
		// pi-subagent-workflow 源码 package.json 声明 pi.skills=["./skills"]，
		// bundle-extensions.mjs 的 MANIFEST_RESOURCE_FIELDS 循环必须把这些目录随 bundle 拷到 staged。
		// 回归后果：拷贝循环被删 → 新装用户内置 skills 整体消失（staged 非 discovery 扫描源）。
		// [C1 convergence 86b700f67] 10 个 agent 模板迁至 packages/subagent-core/agents/（随
		// npm 包 files 分发），本包 pi.agents 声明与 agents/ 目录已删——agents 断言改为「不存在」，
		// 防止迁移回潮；manifest 资源拷贝分支的回归面由 skills 单独承载（workflows 走 C 包
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
 * 构造模式（同 TC7）：临时 scoped 目录 + 合法 index.js（过文件级检查到达 checkManifest）
 * + 残缺 package.json，断言 verify-staged exit 非 0。
 */
describe("verify-staged checkManifest failure branches (M6a-09, MF-3)", () => {
	const VERIFY = join(REPO, "scripts/verify-staged-extensions.mjs");
	let tmpScoped;
	let tmpPkg;

	beforeEach(() => {
		tmpScoped = join(REPO, ".cw/builtin-ext-bundle/tmp-verify/@zhushanwen");
		tmpPkg = join(tmpScoped, "pi-test-pkg");
		rmSync(tmpScoped, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		mkdirSync(tmpPkg, { recursive: true });
		// 合法 index.js：过文件级检查（index.js 存在 + 无 .ts 残留），到达 checkManifest
		writeFileSync(join(tmpPkg, "index.js"), "export default {};\n", "utf8");
	});

	afterEach(() => {
		rmSync(tmpScoped, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	/** 运行 verify-staged，返回 exit code（0=通过，非0=失败） */
	function runVerify() {
		try {
			execSync(`node "${VERIFY}" --staged-dir "${tmpScoped}"`, { stdio: "pipe", cwd: REPO });
			return 0;
		} catch (err) {
			return err.status ?? 1;
		}
	}

	it("缺 package.json → exit 非 0", () => {
		// package.json 未生成（bundle 失败的早期回归）
		expect(runVerify(), "checkManifest 应报「缺 package.json」").not.toBe(0);
	});

	it("package.json JSON 损坏 → exit 非 0", () => {
		writeFileSync(join(tmpPkg, "package.json"), "{ not valid json,,,", "utf8");
		expect(runVerify(), "checkManifest 应报「package.json 解析失败」").not.toBe(0);
	});

	it("缺 pi.extensions 声明 → exit 非 0", () => {
		writeFileSync(
			join(tmpPkg, "package.json"),
			JSON.stringify({ name: "pi-test-pkg" }),
			"utf8",
		);
		expect(runVerify(), "checkManifest 应报「缺 pi.extensions 声明」").not.toBe(0);
	});

	it("pi.extensions 引用不存在的文件 → exit 非 0", () => {
		writeFileSync(
			join(tmpPkg, "package.json"),
			JSON.stringify({ name: "pi-test-pkg", pi: { extensions: ["./nonexistent.js"] } }),
			"utf8",
		);
		expect(runVerify(), "checkManifest 应报「pi.extensions 引用文件缺失」").not.toBe(0);
	});

	it("pi.{agents,skills,workflows} 资源引用缺失 → exit 非 0", () => {
		// pi.extensions 合法（指 ./index.js），但 pi.agents 引用未拷贝的目录 → bundle 拷贝逻辑回归
		writeFileSync(
			join(tmpPkg, "package.json"),
			JSON.stringify({
				name: "pi-test-pkg",
				pi: { extensions: ["./index.js"], agents: ["./agents"] },
			}),
			"utf8",
		);
		expect(runVerify(), "checkManifest 应报「pi.agents 引用缺失」").not.toBe(0);
	});

	it("pi.extensions 含非字符串项 → exit 非 0", () => {
		writeFileSync(
			join(tmpPkg, "package.json"),
			JSON.stringify({ name: "pi-test-pkg", pi: { extensions: [{ bad: "object" }] } }),
			"utf8",
		);
		expect(runVerify(), "checkManifest 应报「pi.extensions 含非字符串项」").not.toBe(0);
	});
});
