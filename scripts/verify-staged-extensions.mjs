#!/usr/bin/env node
/**
 * verify-staged-extensions.mjs — staged builtin extension 完整性校验门（fail-fast）。
 *
 * 对每个 staged 包做两层校验：
 *  1. 文件结构：index.js 存在、无 .ts 残留（R3：extension-resolver fallback 顺序
 *     index.ts 优先于 index.js，残留 .ts 会旁路 bundle）、pi-permission 含 2 wasm。
 *  2. dry-run import：dynamic import() 加载 index.js，捕获加载期错误
 *     （Cannot find module / SyntaxError / import 解析失败）。
 *
 * import 错误分类：
 *  - external 模块缺失（@earendil-works/*、typebox 等 pi virtualModules）→ 降级 warning。
 *    这些模块由 pi 进程运行时注入，dev 环境（staged 在仓库根，node_modules 可达）能完整
 *    import；prod 环境（Resources/extensions 无 node_modules）必然缺失，属预期，不算 bundle 缺陷。
 *  - 其它错误（inline 模块缺失、语法错误、非 external 模块缺失）→ fail。
 *    bundle 成功后 inline 模块必都在 bundle 内，此类失败表示真缺陷。
 *
 * extension 的 export default 是工厂函数，import 模块不调用工厂，不触发 pi API 调用 ——
 * 这是安全的 dry-run（验证依赖完整性，不验证功能）。
 *
 * Usage:
 *   node scripts/verify-staged-extensions.mjs                      # 默认 dev staged
 *   node scripts/verify-staged-extensions.mjs --staged-dir <path>  # 自定义（如 postbuild Resources/extensions/@zhushanwen）
 */
import { readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 解析 --staged-dir 参数（默认 dev staged 目录）
let STAGED_DIR = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--staged-dir" && args[i + 1]) {
		STAGED_DIR = resolve(args[i + 1]);
		i++;
	} else if (args[i] === "--help" || args[i] === "-h") {
		console.log("Usage: verify-staged-extensions.mjs [--staged-dir <path>]");
		process.exit(0);
	}
}
const STAGED = STAGED_DIR || join(REPO_ROOT, "apps/electron/resources/extensions/@zhushanwen");

/** pi 运行时 virtualModules（external）—— 缺失时降级，不视为 bundle 缺陷 */
const EXTERNAL_PREFIXES = ["@earendil-works/", "@mariozechner/", "typebox", "@sinclair/typebox"];

/** pi manifest 资源字段：声明引用非 JS bundle 内容，bundle 时须已整体拷贝（M6a-04） */
const MANIFEST_RESOURCE_FIELDS = ["agents", "skills", "workflows"];

/**
 * 校验 staged package.json 的 pi manifest 引用（M6a-09 + M6a-04）。
 * 返回失败原因数组（空 = 通过）。
 *  - pi.extensions：resolver 发现入口，缺失/指向不存在的文件 = pi 静默不加载该扩展
 *  - pi.agents / pi.skills / pi.workflows：bundle 应已拷贝引用文件，缺失 = bundle 拷贝逻辑回归
 */
function checkManifest(pkgDir) {
	const failures = [];
	const pkgJsonPath = join(pkgDir, "package.json");
	if (!existsSync(pkgJsonPath)) {
		return [`缺 package.json（bundle 未生成 manifest）`];
	}
	let pkgJson;
	try {
		pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
	} catch {
		return [`package.json 解析失败（JSON 损坏）`];
	}
	const pi = pkgJson.pi;
	if (!pi || !Array.isArray(pi.extensions) || pi.extensions.length === 0) {
		failures.push(`缺 pi.extensions 声明（resolver 无法发现该扩展）`);
	} else {
		for (const ref of pi.extensions) {
			if (typeof ref !== "string") {
				failures.push(`pi.extensions 含非字符串项: ${JSON.stringify(ref)}`);
				continue;
			}
			const rel = ref.replace(/^\.\//, "");
			if (!existsSync(join(pkgDir, rel))) {
				failures.push(`pi.extensions 引用文件缺失: ${ref}`);
			}
		}
	}
	for (const field of MANIFEST_RESOURCE_FIELDS) {
		const refs = pi?.[field];
		if (!Array.isArray(refs)) continue;
		for (const ref of refs) {
			if (typeof ref !== "string") {
				failures.push(`pi.${field} 含非字符串项: ${JSON.stringify(ref)}`);
				continue;
			}
			const rel = ref.replace(/^\.\//, "");
			if (!existsSync(join(pkgDir, rel))) {
				failures.push(`pi.${field} 引用缺失: ${ref}（bundle 未拷贝该资源）`);
			}
		}
	}
	return failures;
}

/**
 * 分类 import 错误：判断是否为 pi runtime 差异导致的 dev 环境假阳性。
 *
 * bundle 的正确性由 esbuild 保证（inline 完整、无语法错，否则不产出 index.js）。
 * pi 0.84.1 实测能加载全部 builtin 包（get_state success，2026-08-12 重测，包数以
 * mandatory-extensions.json SSOT 为准，不在此写死计数）。
 * verify-staged 用 node import，
 * 与 pi jiti runtime 有两类差异，需降级（不视为 bundle 缺陷）：
 *  - external：涉及 pi virtualModules（@earendil-works/* 等），dev 环境 node_modules
 *    版本可能与 pi binary 不一致（缺失或 named export 不匹配）。
 *  - interop：esbuild inline 的 CJS 依赖产生 __require("process") 等，node ESM 不
 *    支持裸 require（报 Dynamic require of X），但 pi jiti runtime 能正常处理。
 */
function classifyImportError(err) {
	const msg = String((err && err.message) || err);
	// external 模块相关：缺失或 named export 不匹配（pi runtime 提供，dev 版本差异）
	if (EXTERNAL_PREFIXES.some((p) => msg.includes(p))) {
		return { kind: "external", msg };
	}
	// esbuild CJS→ESM interop 的 node 限制（bundle 在 pi jiti 下正常）
	if (/Dynamic require of/.test(msg)) {
		return { kind: "interop", msg };
	}
	// inline 模块缺失（bundle 应已 inline，缺失表示真缺陷）
	const m = msg.match(/Cannot find (?:module|package) ['"]([^'"]+)['"]/);
	if (m) return { kind: "inline", mod: m[1], msg };
	return { kind: "unknown", msg };
}

function assertStagedDirExists() {
	if (!existsSync(STAGED)) {
		console.error(`[verify-staged] ✗ staged 目录不存在: ${STAGED}`);
		console.error(`[verify-staged] 恢复: bash scripts/prepare-builtin-extensions.sh`);
		process.exit(1);
	}
}

async function listStagedPackageDirs() {
	const entries = await readdir(STAGED, { withFileTypes: true });
	const pkgDirs = entries
		.filter((e) => e.isDirectory() && e.name.startsWith("pi-"))
		.map((e) => e.name)
		.sort();
	if (pkgDirs.length === 0) {
		console.error(`[verify-staged] ✗ staged 无 pi-* 包目录: ${STAGED}`);
		console.error(`[verify-staged] 恢复: bash scripts/prepare-builtin-extensions.sh`);
		process.exit(1);
	}
	return pkgDirs;
}

function readExpectedDirs(mandatoryPath) {
	try {
		const mandatory = JSON.parse(readFileSync(mandatoryPath, "utf8"));
		return mandatory.map((p) => p.name.replace(/^@zhushanwen\//, "")).sort();
	} catch (err) {
		console.error(`[verify-staged] ✗ 无法读取 mandatory-extensions.json SSOT: ${mandatoryPath}`);
		console.error(`[verify-staged] ${err.message}`);
		process.exit(1);
	}
}

// SSOT 集合断言：staged 包集合必须与 mandatory-extensions.json 派生集合完全相等
//（多/少都 fail）。逐包校验只保证「发现的包各自合格」，bundle-extensions.mjs 或
// extraResources 拷贝漏掉部分包时会静默放行（PR #185 review S2：13 包漏 1 剩 12 全 pass）。
function assertPackageSetMatchesSSOT(pkgDirs) {
	const mandatoryPath = join(REPO_ROOT, "packages/shared/src/mandatory-extensions.json");
	const expectedDirs = readExpectedDirs(mandatoryPath);
	const stagedSet = new Set(pkgDirs);
	const missingFromStaged = expectedDirs.filter((d) => !stagedSet.has(d));
	const extraInStaged = pkgDirs.filter((d) => !expectedDirs.includes(d));
	if (missingFromStaged.length > 0 || extraInStaged.length > 0) {
		console.error(`[verify-staged] ✗ staged 包集合与 mandatory-extensions.json SSOT 不一致:`);
		if (missingFromStaged.length > 0) {
			console.error(`[verify-staged]   SSOT 有而 staged 缺（bundle/拷贝遗漏）: ${missingFromStaged.join(", ")}`);
		}
		if (extraInStaged.length > 0) {
			console.error(`[verify-staged]   staged 有而 SSOT 无（残留或 SSOT 未更新）: ${extraInStaged.join(", ")}`);
		}
		console.error(`[verify-staged] 恢复: 重新运行 bash scripts/prepare-builtin-extensions.sh；仍不一致则核对 packages/shared/src/mandatory-extensions.json`);
		process.exit(1);
	}
}

/**
 * 对单个 staged 包做两层校验（文件结构 + dry-run import）。
 * 返回 { status: "verified" | "skipped" | "failed", ... }——与原 main 内联逻辑的
 * failed/skipped/verified 三分类一一对应，每包至多一个结论（前序校验失败即短路）。
 */
async function verifyPackage(pkgDir) {
	const indexJs = join(pkgDir, "index.js");

	// 文件级校验 1：index.js 存在
	if (!existsSync(indexJs)) {
		return { status: "failed", reason: "缺 index.js（bundle 失败或未运行 prepare）" };
	}

	// 文件级校验 2：无 .ts 残留（R3 关键防护）
	const files = await readdir(pkgDir);
	const tsResidue = files.filter((f) => f.endsWith(".ts"));
	if (tsResidue.length > 0) {
		return {
			status: "failed",
			reason: `残留 .ts 文件 [${tsResidue.join(", ")}]，resolver fallback 会旁路 bundle（R3）`,
		};
	}

	// manifest 校验（M6a-09 + M6a-04）：pi.extensions 指向存在的入口；
	// pi.{agents,skills,workflows} 引用文件存在（bundle 已拷贝，缺失 = 拷贝逻辑回归）
	const manifestFailures = checkManifest(pkgDir);
	if (manifestFailures.length > 0) {
		return { status: "failed", reason: manifestFailures.join("; ") };
	}

	// dry-run import：加载 index.js，捕获依赖缺失 / 语法错误
	try {
		await import(pathToFileURL(indexJs).href);
		return { status: "verified" };
	} catch (err) {
		const { kind } = classifyImportError(err);
		const firstLine = String(err.message || err).split("\n")[0];
		if (kind === "external" || kind === "interop") {
			return { status: "skipped", kind, msg: firstLine };
		}
		return { status: "failed", reason: firstLine };
	}
}

async function verifyAllPackages(pkgDirs) {
	const verified = [];
	const skipped = [];
	const failed = [];
	for (const pkg of pkgDirs) {
		const outcome = await verifyPackage(join(STAGED, pkg));
		if (outcome.status === "verified") {
			verified.push(pkg);
		} else if (outcome.status === "skipped") {
			skipped.push({ pkg, kind: outcome.kind, msg: outcome.msg });
		} else {
			failed.push({ pkg, reason: outcome.reason });
		}
	}
	return { verified, skipped, failed };
}

// pi-permission wasm 校验（运行时 bash 解析必需）
function checkPermissionWasm(failed) {
	const permDir = join(STAGED, "pi-permission");
	if (!existsSync(permDir)) return;
	for (const w of ["tree-sitter-bash.wasm", "web-tree-sitter.wasm"]) {
		if (!existsSync(join(permDir, w))) {
			failed.push({ pkg: "pi-permission", reason: `缺 ${w}（permission 将无法解析 bash）` });
		}
	}
}

function printPackageOutcomes(verified, skipped) {
	if (verified.length > 0) {
		console.log(`✓ import 通过 (${verified.length}):`);
		for (const p of verified) console.log(`    - ${p}`);
	}
	if (skipped.length > 0) {
		console.log("");
		console.log(`ℹ import 降级 (${skipped.length}) — pi runtime 提供 / CJS interop，dev node 环境假阳性:`);
		for (const { pkg, kind, msg } of skipped) {
			console.log(`    - ${pkg} [${kind}]: ${msg}`);
		}
	}
}

function printFailuresAndExit(failed) {
	console.error("");
	console.error(`✗ 失败 (${failed.length}):`);
	for (const { pkg, reason } of failed) {
		console.error(`    - ${pkg}: ${reason}`);
	}
	console.error("");
	console.error(`[verify-staged] 校验未通过，dev/build 中断。`);
	console.error(`[verify-staged] 恢复: 重新运行 bash scripts/prepare-builtin-extensions.sh`);
	process.exit(1);
}

async function main() {
	assertStagedDirExists();
	const pkgDirs = await listStagedPackageDirs();
	assertPackageSetMatchesSSOT(pkgDirs);

	console.log(`=== verify-staged-extensions ===`);
	console.log(`staged: ${STAGED}`);
	console.log(`packages: ${pkgDirs.length}`);
	console.log("");

	const { verified, skipped, failed } = await verifyAllPackages(pkgDirs);
	checkPermissionWasm(failed);

	// 输出结果
	printPackageOutcomes(verified, skipped);
	if (failed.length > 0) printFailuresAndExit(failed);

	console.log("");
	console.log(`[verify-staged] ✓ 全部通过（${verified.length} import + ${skipped.length} 降级 / ${pkgDirs.length} 包）`);
	process.exit(0);
}

main().catch((err) => {
	console.error(`[verify-staged] 未预期错误:`, err);
	process.exit(1);
});
