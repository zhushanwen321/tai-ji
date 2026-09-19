#!/usr/bin/env node
/**
 * bundle-extensions.mjs — 用 esbuild 把 builtin pi extension（数量以
 * packages/shared/src/mandatory-extensions.json SSOT 为准，不写死计数）各自 bundle 成
 * 自包含 .js，解决 prepare-builtin-extensions.sh 旧机制的根本缺陷。
 *
 * 旧机制（"拷源码 + 人工声明 PKG_DEPS + 从根 node_modules 拷依赖"）的两个根因：
 *  1. workspace 包（@taiji/*、@zhushanwen/*）不在根 node_modules（pnpm hoisted），
 *     copy_dep 从根 node_modules 拷不到 → staged 缺依赖 → pi 加载报 Cannot find module。
 *  2. PKG_DEPS 人工维护，与 package.json 无机械同步，新增 value import 漏声明即断链。
 *
 * 新机制：esbuild 在构建期静态分析 import，把所有可 inline 的 value 依赖打进单个
 * index.js。只有 pi 运行时 virtualModules 标 external（pi 进程注入，无需 staged 自带）。
 * 从结构上消除上述两个根因，并兑现 G3（新增静态 value 依赖不改脚本）。
 *
 * 产物（apps/electron/resources/extensions/@zhushanwen/<pkg>/）：
 *  - index.js + index.js.map（所有 JS value dep inline）
 *  - package.json（pi.extensions 改指 ./index.js；源码 package.json 不动）
 *  - permission 额外含 tree-sitter-bash.wasm + web-tree-sitter.wasm（手动拷贝，与 index.js 同目录）
 *  - subagent-workflow 额外含 relay/（独立执行零依赖脚本）+ workflows/（内置 workflow
 *    脚本资产，u1-staged 起源在 packages/subagent-core/workflows/，见下方常量注释）
 *  - plan 额外含 templates/（内置计划模板 .md，list-template/select-template 数据源，
 *    见 TEMPLATES_DIR_PACKAGES 注释）
 *
 * external 边界权威源：0.84.1 pi binary virtualModules 实测（0.80.3 首测，2026-08-12
 * 随 pi 0.84.1 升级重测 10 包 get_state 加载全绿后更新；见
 * 本地 harness 档案（已不入库）design §1.1）。
 *  - @earendil-works/*（pi-coding-agent / pi-ai / pi-tui / pi-agent-core 等）
 *  - @mariozechner/*（旧名别名）
 *  - typebox / @sinclair/typebox（pi binary 内提供）
 * 其余（@zhushanwen/extension-protocol、@zhushanwen/pi-* workspace value dep、
 * web-tree-sitter、ajv、croner 等）全部 inline。
 *
 * Usage: node scripts/bundle-extensions.mjs
 */
import { build } from "esbuild";
import { readFile, writeFile, copyFile, cp, mkdir, stat, rm, chmod, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** builtin 包清单 SSOT：packages/shared/src/mandatory-extensions.json */
const BUILTIN_PACKAGES = JSON.parse(
	await readFile(join(REPO_ROOT, "packages/shared/src/mandatory-extensions.json"), "utf8"),
);

const EXTENSIONS_DIR = join(REPO_ROOT, "extensions");
const STAGED_ROOT = join(REPO_ROOT, "apps/electron/resources/extensions/@zhushanwen");
/** 引擎包 staged 根（W9，设计 §3.7 Electron 打包态：apps/electron/resources/engines/<id>/）。 */
const ENGINES_STAGED_ROOT = join(REPO_ROOT, "apps/electron/resources/engines");
/** 引擎包源码目录前缀（packages/ 下，设计 §3.7「引擎包落位 packages/」）。 */
const PACKAGES_DIR = join(REPO_ROOT, "packages");

/**
 * pi 运行时 virtualModules — external（pi 进程注入，staged 不自带）。
 * typebox / @sinclair/typebox 加 /* 后缀确保子路径（typebox/value 等）也 external。
 */
const EXTERNAL = [
	"@earendil-works/*",
	"@mariozechner/*",
	"typebox",
	"typebox/*",
	"@sinclair/typebox",
	"@sinclair/typebox/*",
	// W9 边界（设计 §3.7 external 边界加引擎包）：引擎 CLI 包是「被 spawn 的独立进程」，
	// 不是可链接库——extension bundle 静态 import 它们属打包配置回归，external 化使
	// 任何误 import 在 staged 运行期报 Cannot find module（fail-fast）而非静默内联。
	"@zhushanwen/pi-subagent-cli",
	"@zhushanwen/zcode-subagent-cli",
];

/** 包名 @zhushanwen/pi-<x> → 源码目录 extensions/<group>/<x>/（group = taiji | universal，见 docs/extensions/extension-conventions.md 分组约定） */
function srcDirFor(pkgName) {
	const short = pkgName.replace(/^@zhushanwen\/pi-/, "");
	for (const group of ["taiji", "universal"]) {
		const dir = join(EXTENSIONS_DIR, group, short);
		if (existsSync(dir)) return dir;
	}
	throw new Error(
		`source dir not found for ${pkgName}: tried extensions/{taiji,universal}/${short}`,
	);
}

function fmtSize(bytes) {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kb`;
	return `${(bytes / (1024 * 1024)).toFixed(2)}mb`;
}

/**
 * pi manifest 资源字段（agents/skills/workflows）：声明引用非 JS bundle 内容
 * （agent .md / skill / workflow .js），必须随 bundle 整体拷贝。
 * 缺失后果（M6a-04）：staged 目录不是 resource-discovery 扫描源，migrate 移除 npm 记录后
 * 新装用户不再有 npm 副本——不拷则 subagent-workflow 的内置 agents/skills 对新装用户整体消失。
 */
const MANIFEST_RESOURCE_FIELDS = ["agents", "skills", "workflows"];

/**
 * permission 的 2 个 wasm：从 node_modules 拷到 staged 与 index.js 同目录。
 * loader.ts 的 resolveWasmPaths() 双模式 bundle 分支用 fileURLToPath(import.meta.url)
 * 定位 index.js 目录后，在同目录查这 2 个 wasm 文件名。
 */
const PERMISSION_WASM = [
	["tree-sitter-bash/tree-sitter-bash.wasm", "tree-sitter-bash.wasm"],
	["web-tree-sitter/web-tree-sitter.wasm", "web-tree-sitter.wasm"],
];

/**
 * subagent-workflow 的 relay/ 目录（E-1 代理 CLI relay.mjs）：不参与 esbuild bundle——
 * 它是被 TAIJI_SUBAGENT_RELAY_NODE（打包版 = Electron 内嵌 node + ELECTRON_RUN_AS_NODE，
 * dev = node）独立执行的零依赖脚本，必须保持源文件形态（禁 import 非 node-builtin，
 * esbuild bundle 无意义且引入 workspace 解析依赖）。整目录拷贝到 staged，运行时经
 * TAIJI_SUBAGENT_RELAY_SCRIPT env 指向 staged 副本。
 * 分发链：bundle staged（此处）→ electron-builder extraResources
 * （resources/extensions → extensions，已有规则整目录携带，无需改 yml）。
 */
const RELAY_DIR_PACKAGES = new Set(["subagent-workflow"]);

/**
 * subagent-workflow 的内置 workflow 脚本资产（u1-staged，设计 D1）：随 subagent-core
 * 包抽离（u1-move）物理迁至 packages/subagent-core/workflows/（内置四件 chain/
 * parallel/map-reduce/scatter-gather + review-fix-loop 双件 + _shared/），E 包源码目录
 * 不再持有 workflows/。源路径因此改指 C 包——pi manifest 的 workflows 字段从不参与
 * 本拷贝（E 的 pi 字段迁移前后均只有 extensions/skills/agents，MANIFEST_RESOURCE_FIELDS
 * 循环对 workflows 不触发；也不给 E 补该声明：E 的 npm 发布面已不含 workflows/，加了
 * 会让 standalone pi 用户经 resource-discovery manifest 模式命中「声明路径不存在 →
 * 整包失败占位」，npm 安装形态的 workflow 发现已由 C 作为 E 的传递依赖 + C 包约定
 * 目录成立）。staged 布局无 node_modules 解析面，整目录复制后 worker 的
 * workerData.scriptPath 目录锚定（require(dirname(scriptPath) + "/...-utils.cjs")，
 * 不经 node_modules）即成立——D1 既验证模式。
 *
 * V1-④ staged 布局双形态探针（可复现命令，重跑 bundle 后在仓库根执行）：
 *
 * ① 正向（真实 scriptPath 注入 → utils 解析成功；「未知参数」报错 = utils 已解构、
 *    白名单校验已执行，且脚本在编排段之前 fail 退出不会真跑 agent）：
 *   node -e '
 *     const fs = require("fs"), path = require("path");
 *     const p = "apps/electron/resources/extensions/@zhushanwen/pi-subagent-workflow/workflows/review-fix-loop.js";
 *     const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
 *     const runner = new AsyncFunction("workerData", "$ARGS", "require", "log", fs.readFileSync(p, "utf8") + "\n");
 *     runner({ scriptPath: path.resolve(p) }, { definitelyNotAValidKey: true }, require, () => {})
 *       .catch((e) => { console.error(e.message); process.exit(1); });
 *   '
 *   期望 stderr 含「未知参数: definitelyNotAValidKey」且不含 core_module_load_failed。
 *
 * ② 负向（scriptPath 缺席 → fail-fast core_module_load_failed，不再 cwd 静默回退；
 *    cwd 侧预置植入版依赖，标记出现即证明回退仍在）：
 *   REPO=$(git rev-parse --show-toplevel); d=$(mktemp -d) && mkdir -p "$d/_shared" \
 *     && echo 'throw new Error("PLANTED-CWD-UTILS-LOADED");' > "$d/review-fix-loop-utils.cjs" \
 *     && echo 'throw new Error("PLANTED-CWD-UTILS-LOADED");' > "$d/_shared/agent-refs.cjs" \
 *     && node -e '
 *     const fs = require("fs");
 *     const p = process.argv[1] + "/apps/electron/resources/extensions/@zhushanwen/pi-subagent-workflow/workflows/review-fix-loop.js";
 *     const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
 *     const runner = new AsyncFunction("workerData", "$ARGS", "require", "log", fs.readFileSync(p, "utf8") + "\n");
 *     runner(undefined, { targetType: "file", target: "probe" }, require, () => {})
 *       .catch((e) => { console.error(e.message); process.exit(1); });
 *   ' "$REPO"; echo "exit=$?"
 *   期望非零退出、stderr 含 core_module_load_failed（并指出 workerData/WorkerHost
 *   注入点）、不含 PLANTED-CWD-UTILS-LOADED。
 *   语义与 packages/subagent-core/src/orchestration/__tests__/
 *   review-fix-loop-scriptpath-failfast.test.ts 的既有探针族同构，对象换成 staged 副本。
 */
const SUBAGENT_CORE_WORKFLOWS_DIR = join(REPO_ROOT, "packages", "subagent-core", "workflows");
const WORKFLOW_DIR_PACKAGES = new Set(["subagent-workflow"]);

/**
 * plan 的内置模板资产（PR #19 review MF-7）：templates/*.md 是 list-template /
 * select-template 的数据源。templates.ts 被 esbuild inline 进包根 index.js 后按同级
 * templates/ 定位（双形态探测见该文件 getBuiltinTemplateDir 注释），esbuild 只 bundle
 * JS，.md 资产必须在此整目录拷到 staged 包根。缺失后果：打包版 list-template 恒 0、
 * select-template 恒 null（静默失效，prompts.ts 仍在引导 agent 调 list-template）。
 * 不走 pi manifest 三字段（agents/skills/workflows）：templates 非 pi manifest 声明的
 * 资源目录，manifest 模式的 resource-discovery 不会扫它（与 relay/workflows 同理）。
 * 分发链与 relay 一致：bundle staged（此处）→ electron-builder extraResources 整目录携带。
 */
const TEMPLATES_DIR_PACKAGES = new Set(["plan"]);

// permission 特殊处理（R1）：拷 2 个 wasm 到 staged 与 index.js 同目录
async function copyPermissionWasm(outDir, extraAssets) {
	for (const [depRel, outName] of PERMISSION_WASM) {
		const src = join(REPO_ROOT, "node_modules", depRel);
		const dest = join(outDir, outName);
		if (!existsSync(src)) {
			throw new Error(
				`permission wasm 源缺失: ${src}（先 pnpm install 确保依赖安装）`,
			);
		}
		await copyFile(src, dest);
		extraAssets.push(outName);
	}
}

// relay 代理 CLI（E-1）：零依赖脚本保持源形态整目录拷贝（不 bundle，见常量注释）
async function copyRelayDir(srcDir, outDir, extraAssets) {
	const src = join(srcDir, "relay");
	if (!existsSync(src)) {
		throw new Error(
			`relay dir missing: ${src}（E-1 资产已登记但源码目录缺失 = 打包配置回归）`,
		);
	}
	await cp(src, join(outDir, "relay"), { recursive: true });
	extraAssets.push("relay/");
}

// 内置 workflow 脚本资产（u1-staged / 设计 D1）：源在 packages/subagent-core/workflows/
//（u1-move 后 E 包不再持有），整目录拷到 E staged 目录。拷贝动机与 manifest 字段的
// 关系、scriptPath 锚定原理、V1-④ 双形态探针命令见 WORKFLOW_DIR_PACKAGES 常量注释。
async function copyWorkflowDir(outDir, extraAssets) {
	if (!existsSync(SUBAGENT_CORE_WORKFLOWS_DIR)) {
		throw new Error(
			`workflows dir missing: ${SUBAGENT_CORE_WORKFLOWS_DIR}（subagent-core 包 workflow 资产缺失 = 打包配置回归）`,
		);
	}
	await cp(SUBAGENT_CORE_WORKFLOWS_DIR, join(outDir, "workflows"), { recursive: true });
	extraAssets.push("workflows/");
}

// plan 内置模板（MF-7）：templates/*.md 整目录拷到 staged 包根（bundle 形态路径探测
// 由 templates.ts getBuiltinTemplateDir 同级 existsSync 完成；动机与缺失后果见
// TEMPLATES_DIR_PACKAGES 常量注释）
async function copyTemplatesDir(srcDir, outDir, extraAssets) {
	const src = join(srcDir, "templates");
	if (!existsSync(src)) {
		throw new Error(
			`templates dir missing: ${src}（plan 包内置模板资产缺失 = 打包配置回归）`,
		);
	}
	await cp(src, join(outDir, "templates"), { recursive: true });
	extraAssets.push("templates/");
}

// 按包名 short 分发的特殊资产拷贝（顺序敏感：permission → relay → workflows →
// templates，与 extraAssets 汇总顺序及 fail-fast 先后一致）
async function copySpecialAssets(short, srcDir, outDir, extraAssets) {
	if (short === "permission") await copyPermissionWasm(outDir, extraAssets);
	if (RELAY_DIR_PACKAGES.has(short)) await copyRelayDir(srcDir, outDir, extraAssets);
	if (WORKFLOW_DIR_PACKAGES.has(short)) await copyWorkflowDir(outDir, extraAssets);
	if (TEMPLATES_DIR_PACKAGES.has(short)) await copyTemplatesDir(srcDir, outDir, extraAssets);
}

// 改写 staged 副本 package.json：pi.extensions 指向 ./index.js（不改源码 package.json）
async function stagePackageJson(srcDir, outDir) {
	const pkg = JSON.parse(await readFile(join(srcDir, "package.json"), "utf8"));
	if (pkg.pi && Array.isArray(pkg.pi.extensions)) {
		pkg.pi.extensions = ["./index.js"];
	}
	await writeFile(join(outDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
	return pkg;
}

// 文档随 staged 产物自描述（有则拷无则跳过；原 prepare-builtin-extensions.sh 的
// rsync 步骤下沉至此，bundle 管线内「mandatory 包 → 源码目录 → staged 产物」单一 owner）
async function copyDocAssets(srcDir, outDir) {
	const docAssets = [];
	for (const doc of ["README.md", "ARCHITECTURE.md"]) {
		const src = join(srcDir, doc);
		if (existsSync(src)) {
			await copyFile(src, join(outDir, doc));
			docAssets.push(doc);
		}
	}
	return docAssets;
}

// M6a-04：pi.{agents,skills,workflows} 引用的资源目录随 bundle 拷贝。
// 引用值是相对路径（如 "./agents"），解析到源码目录后整目录拷贝（filter 排除
// node_modules）。缺失即 fail-fast（manifest 声明了但源码缺 = 打包配置回归）。
async function copyManifestResourceDirs(pkg, srcDir, outDir) {
	const copiedManifestDirs = [];
	for (const field of MANIFEST_RESOURCE_FIELDS) {
		const refs = pkg.pi?.[field];
		if (!Array.isArray(refs)) continue;
		for (const ref of refs) {
			if (typeof ref !== "string") continue;
			const rel = ref.replace(/^\.\//, "");
			const src = join(srcDir, rel);
			const dest = join(outDir, rel);
			if (!existsSync(src)) {
				throw new Error(
					`pi.${field} 引用缺失: ${src}（源码目录 ${srcDir} 缺 ${rel}）`,
				);
			}
			await cp(src, dest, {
				recursive: true,
				filter: (s) => !s.includes(`${sep}node_modules${sep}`),
			});
			copiedManifestDirs.push(`${field}:${rel}`);
		}
	}
	return copiedManifestDirs;
}

async function bundleOne(pkgName) {
	const short = pkgName.replace(/^@zhushanwen\/pi-/, "");
	const srcDir = srcDirFor(pkgName);
	const entry = join(srcDir, "index.ts");
	// staged 目录名用 pkgName 的 name 部分（pi-ask-user），不含 scope 前缀
	// （STAGED_ROOT 已含 @zhushanwen scope 目录）
	const pkgDirName = pkgName.split("/")[1];
	const outDir = join(STAGED_ROOT, pkgDirName);

	if (!existsSync(entry)) {
		throw new Error(`entry not found: ${entry} (源码目录 ${srcDir} 缺 index.ts)`);
	}

	await mkdir(outDir, { recursive: true });

	const result = await build({
		entryPoints: [entry],
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node18",
		sourcemap: true,
		keepNames: true,
		external: EXTERNAL,
		outfile: join(outDir, "index.js"),
		// import.meta.url 在 ESM format 下保留（已实测），loader.ts 用它定位 bundle 目录
		logLevel: "warning",
	});

	const extraAssets = [];
	await copySpecialAssets(short, srcDir, outDir, extraAssets);

	const pkg = await stagePackageJson(srcDir, outDir);
	const docAssets = await copyDocAssets(srcDir, outDir);
	const manifestDirs = await copyManifestResourceDirs(pkg, srcDir, outDir);

	const jsStat = await stat(join(outDir, "index.js"));
	return {
		pkgName,
		short,
		size: jsStat.size,
		warnings: result.warnings || [],
		extraAssets,
		manifestDirs,
		docAssets,
	};
}

async function main() {
	// 清空 staged 根后重建：防旧机制（拷源码）残留的 index.ts/src 旁路 bundle
	// （extension-resolver resolveExtensionEntries 的 pi.extensions 优先级最高，
	// 但若 staged package.json 退化或缺 pi.extensions，fallback 顺序 index.ts 优先于
	// index.js，残留 .ts 会让 pi 加载源码旁路 bundle，bug 原样存在）。
	await rm(STAGED_ROOT, { recursive: true, force: true });
	await mkdir(STAGED_ROOT, { recursive: true });

	await rm(ENGINES_STAGED_ROOT, { recursive: true, force: true });
	await mkdir(ENGINES_STAGED_ROOT, { recursive: true });

	console.log("=== bundle-extensions: esbuild self-contained bundles ===");
	console.log(`staged root: ${STAGED_ROOT}`);
	console.log(`packages: ${BUILTIN_PACKAGES.length}`);
	console.log("");

	const results = [];
	for (const { name } of BUILTIN_PACKAGES) {
		process.stdout.write(`  bundling ${name}...`);
		try {
			const r = await bundleOne(name);
			results.push(r);
			const warn = r.warnings.length ? ` (${r.warnings.length} warnings)` : "";
			const assets = r.extraAssets.length ? ` + ${r.extraAssets.join(", ")}` : "";
			const dirs = r.manifestDirs.length ? ` + manifest[${r.manifestDirs.join(", ")}]` : "";
			const docs = r.docAssets.length ? ` + docs[${r.docAssets.join(", ")}]` : "";
			console.log(` ${fmtSize(r.size)}${assets}${dirs}${docs}${warn}`);
		} catch (err) {
			console.log(" FAILED");
			console.error(`\n[bundle-extensions] ${name} 打包失败:`);
			console.error(err.stack || err.message);
			process.exit(1);
		}
	}

	console.log("");
	console.log("=== bundle complete ===");
	for (const r of results) {
		const assets = r.extraAssets.length ? ` + ${r.extraAssets.join(", ")}` : "";
		const dirs = r.manifestDirs.length ? ` + manifest[${r.manifestDirs.join(", ")}]` : "";
		const docs = r.docAssets.length ? ` + docs[${r.docAssets.join(", ")}]` : "";
		console.log(`  ${r.pkgName}: index.js ${fmtSize(r.size)}${assets}${dirs}${docs}`);
	}
	const total = results.reduce((s, r) => s + r.size, 0);
	console.log(`  ────────────`);
	console.log(`  total index.js: ${fmtSize(total)} (${results.length} packages)`);

	// 有 esbuild warning 时汇总提示（不阻断，warning 多为 tree-shaking 建议）
	const totalWarnings = results.reduce((s, r) => s + r.warnings.length, 0);
	if (totalWarnings > 0) {
		console.log("");
		console.log(`[hint] ${totalWarnings} esbuild warning(s) — 多为 tree-shaking 建议，详见上方输出`);
	}

	await bundleEngines();
}

/**
 * W9 引擎包 staging（设计 §3.7 Electron 打包态）：packages/*-subagent-cli（带
 * taiji.subagentEngine manifest 的包，动态发现不枚举）bundle 成自包含
 * apps/electron/resources/engines/<id>/：
 *  - index.js（src/main.ts bundle，SDK 等 value dep 全部 inline；带 node shebang +
 *    chmod 0755——发现器 canExecute 检查 + 独立安装形态直接可执行）
 *  - package.json（manifest 原样保留 + bin 改指 ./index.js；源码 package.json 不动）
 * electron-builder.yml extraResources 增该目录（resources/engines → engines）；
 * runtime 侧 engine-roots.ts 推导该位置并经 env TAIJI_AGENT_ENGINE_ROOTS 显式注入
 * （绝对路径，不 cwd 探测——防用户 repo 预置同名目录冒充）。
 */
async function bundleEngines() {
	console.log("");
	console.log("=== bundle engines: subagent CLI packages ===");
	const enginePkgs = [];
	for (const entry of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const pkgJson = join(PACKAGES_DIR, entry.name, "package.json");
		if (!existsSync(pkgJson)) continue;
		const pkg = JSON.parse(await readFile(pkgJson, "utf8"));
		if (pkg["taiji"]?.["subagentEngine"]?.id) {
			enginePkgs.push({ srcDir: join(PACKAGES_DIR, entry.name), pkg });
		}
	}
	if (enginePkgs.length === 0) {
		throw new Error(
			"no engine packages found under packages/ (expected packages/*-subagent-cli with taiji.subagentEngine manifest — W5/W7 deliverables missing = packaging regression)",
		);
	}

	for (const { srcDir, pkg } of enginePkgs) {
		const manifest = pkg["taiji"]["subagentEngine"];
		const id = manifest.id;
		const entry = join(srcDir, "src", "main.ts");
		if (!existsSync(entry)) {
			throw new Error(`engine entry not found: ${entry}（引擎包缺 src/main.ts）`);
		}
		const outDir = join(ENGINES_STAGED_ROOT, id);
		await mkdir(outDir, { recursive: true });
		const result = await build({
			entryPoints: [entry],
			bundle: true,
			format: "esm",
			platform: "node",
			target: "node22",
			sourcemap: true,
			keepNames: true,
			external: EXTERNAL,
			outfile: join(outDir, "index.js"),
			banner: { js: "#!/usr/bin/env node" },
			logLevel: "warning",
		});
		await chmod(join(outDir, "index.js"), 0o755);

		// staged manifest：bin 解析目标改指 bundle 产物；manifest 其余字段原样
		//（发现器只读 manifest 不执行——安全立场见设计 §3.7）。
		const staged = {
			name: pkg.name,
			version: pkg.version,
			type: "module",
			bin: { [manifest.bin]: "./index.js" },
			"taiji": { subagentEngine: manifest },
		};
		await writeFile(
			join(outDir, "package.json"),
			JSON.stringify(staged, null, 2) + "\n",
			"utf8",
		);

		const jsStat = await stat(join(outDir, "index.js"));
		const warn = result.warnings.length ? ` (${result.warnings.length} warnings)` : "";
		console.log(`  ${id}: index.js ${fmtSize(jsStat.size)} (bin ${manifest.bin})${warn}`);
	}
	console.log(`  staged root: ${ENGINES_STAGED_ROOT}`);
}

main();
