/**
 * web-tree-sitter WASM loader + bash Parser singleton.
 *
 * 职责：
 *  - 定位 tree-sitter-bash.wasm + web-tree-sitter 运行时 wasm 的物理路径
 *  - 初始化 Parser 运行时（locateFile 指向 wasm 目录）
 *  - 加载 bash grammar，构造并缓存 Parser 单例（promise memoization，天然并发互斥）
 *
 * 失败策略（fail-closed）：任一步抛错 → logger.warn + 返回 null，永不 throw。
 * analyzer 拿到 null 时降级为 { clean:false, parseError:true }。
 *
 * 注意（实测 web-tree-sitter 0.26.11 的事实，与 pi-lens 用的 0.24.5 有差异）：
 *  - web-tree-sitter 0.26 是 **named export**（`export class Parser / Language`），不是 default。
 *  - `Parser.init({ locateFile })` 是 static method（返回 Promise<void>）。
 *  - `Language.load(path)` 是 static method（返回 Promise<Language>）。
 *  - `new Parser()` 构造实例；`parser.setLanguage(lang)` 实例方法。
 *  - 运行时 wasm 在 0.26 叫 `web-tree-sitter.wasm`（与 .js 同名），
 *    而非 0.24.5 时代的 `tree-sitter.wasm`。emscripten 的 locateFile 回调会
 *    传入实际请求的文件名，所以我们只需定位 .js 所在目录，不硬编码 wasm 文件名。
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Language, Parser } from "web-tree-sitter";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

const logger = getLogger("pi-permission/ast");

const nodeRequire = createRequire(import.meta.url);

/** 解析出的 wasm 物理路径（bashWasmPath 是文件，runtimeWasmDir 是目录）。 */
export interface WasmPaths {
	bashWasmPath: string;
	runtimeWasmDir: string;
}

/**
 * 定位两个 wasm：
 *  - bashWasmPath：tree-sitter-bash 的 grammar wasm（解析 bash 用）—— 包根 `tree-sitter-bash.wasm`
 *  - runtimeWasmDir：web-tree-sitter 运行时 wasm 所在目录（emscripten 运行时用）
 *
 * tree-sitter-bash 0.25 不在 exports 暴露 .wasm 子路径（package.json files 用 `*.wasm` glob
 * 打包，但 exports 只暴露 `.` 主入口给原生 binding）。所以用 package.json 目录定位。
 * web-tree-sitter 0.26 的运行时 wasm 与 .js 同目录（0.26 起叫 `web-tree-sitter.wasm`，
 * 不再是 0.24 时代的 `tree-sitter.wasm`）。emscripten 的 locateFile 会传入实际文件名，
 * 所以这里只定位 .js 所在目录，不硬编码 wasm 文件名（跨版本健壮）。
 *
 * 任一不存在则 throw（fail-loud，由 getBashParser 捕获后 fail-closed）。
 *
 * 双模式（R1，bundle 适配）：builtin extension 经 esbuild bundle 成自包含 index.js 后，
 * web-tree-sitter 被 inline、staged 产物无 node_modules，nodeRequire.resolve 必然失败。
 * 故优先尝试 bundle 模式 —— 用 fileURLToPath(import.meta.url) 定位 index.js 所在目录，
 * 查同目录的 tree-sitter-bash.wasm；命中则返回（wasm 由 bundle-extensions.mjs 拷至此）。
 * 未命中则 fallback 到 nodeRequire.resolve（开发期 dev-link，源码 node_modules 完整）。
 */
export function resolveWasmPaths(): WasmPaths {
	// bundle 模式：bundle 后 wasm 与 index.js 同目录（bundle-extensions.mjs 拷贝至此）。
	// 查两个 wasm 都存在才返回，避免不对称 guard（bash.wasm 在但 web-tree-sitter.wasm
	// 缺失时 emscripten locateFile 会失败，虽 fail-closed 但不如入口 guard 显式拦截）。
	const bundleDir = dirname(fileURLToPath(import.meta.url));
	const bundleBashWasm = join(bundleDir, "tree-sitter-bash.wasm");
	const bundleRuntimeWasm = join(bundleDir, "web-tree-sitter.wasm");
	if (existsSync(bundleBashWasm) && existsSync(bundleRuntimeWasm)) {
		return { bashWasmPath: bundleBashWasm, runtimeWasmDir: bundleDir };
	}

	// fallback：开发期从 node_modules 解析（dev-link，源码目录完整）
	const bashPkgDir = dirname(nodeRequire.resolve("tree-sitter-bash/package.json"));
	const bashWasmPath = join(bashPkgDir, "tree-sitter-bash.wasm");
	if (!existsSync(bashWasmPath)) {
		throw new Error(
			`tree-sitter-bash.wasm not found at ${bashWasmPath} (tree-sitter-bash package may be incomplete)`,
		);
	}

	const runtimeEntry = nodeRequire.resolve("web-tree-sitter");
	const runtimeWasmDir = dirname(runtimeEntry);
	if (!existsSync(runtimeWasmDir)) {
		throw new Error(
			`web-tree-sitter runtime dir not found at ${runtimeWasmDir} (web-tree-sitter package may be incomplete)`,
		);
	}

	return { bashWasmPath, runtimeWasmDir };
}

/**
 * 模块级 promise 缓存。首次调用触发完整初始化链路；
 * 再次调用直接返回同一个 promise（天然并发互斥，无需锁）。
 * 失败时缓存 null（下一次调用会重试 —— wasm 加载失败可能是瞬时问题）。
 */
let parserPromise: Promise<Parser | null> | null = null;

/**
 * 获取（并在首次调用时初始化）bash Parser 单例。
 *
 * @returns 可用的 Parser 实例；初始化失败返回 null（fail-closed）。
 *          永不 throw。
 */
export function getBashParser(): Promise<Parser | null> {
	if (parserPromise) {
		return parserPromise;
	}

	parserPromise = (async () => {
		try {
			const { bashWasmPath, runtimeWasmDir } = resolveWasmPaths();

			// locateFile 让 emscripten 从 web-tree-sitter 目录加载 tree-sitter.wasm 运行时。
			await Parser.init({
				locateFile: (name: string) => join(runtimeWasmDir, name),
			});

			const bash = await Language.load(bashWasmPath);
			const parser = new Parser();
			parser.setLanguage(bash);
			return parser;
		} catch (err) {
			// fail-closed：清空缓存让下次调用重试，warn 后返回 null。
			parserPromise = null;
			const msg = toErrorMessage(err);
			logger.warn("getBashParser init failed", { error: msg });
			return null;
		}
	})();

	return parserPromise;
}
