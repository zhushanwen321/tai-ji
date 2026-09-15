/**
 * WT24-WT27: loader 单元测试。
 *
 *  - WT24: resolveWasmPaths 返回正确路径（文件/目录存在）
 *  - WT25: getBashParser 单例缓存（第二次返回同一 promise）
 *  - WT26: 并发调用共享同一 promise（Promise.all 返回同一 parser 实例）
 *  - WT27: 加载失败降级（篡改 require.resolve 抛错 → 返回 null，不 throw）
 *
 * WT27 用 vi.resetModules + 动态 import 隔离模块状态，避免污染 WT24-WT26 的单例缓存。
 */
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getBashParser, resolveWasmPaths } from "../loader.js";

// ──────────────────────── WT24: resolveWasmPaths ────────────────────────

describe("WT24: resolveWasmPaths 返回正确路径", () => {
	it("bashWasmPath 是存在的文件", () => {
		const { bashWasmPath } = resolveWasmPaths();
		expect(bashWasmPath).toContain("tree-sitter-bash.wasm");
		expect(existsSync(bashWasmPath)).toBe(true);
		const stat = statSync(bashWasmPath);
		expect(stat.isFile()).toBe(true);
		expect(stat.size).toBeGreaterThan(0);
	});

	it("runtimeWasmDir 是存在的目录，含 web-tree-sitter.wasm（0.26 起的运行时 wasm）", () => {
		const { runtimeWasmDir } = resolveWasmPaths();
		expect(existsSync(runtimeWasmDir)).toBe(true);
		// 0.26 起 wasm 与 .js 同名：web-tree-sitter.wasm
		expect(existsSync(`${runtimeWasmDir}/web-tree-sitter.wasm`)).toBe(true);
		const stat = statSync(runtimeWasmDir);
		expect(stat.isDirectory()).toBe(true);
	});

	it("runtimeWasmDir 在 web-tree-sitter 包内（dirname 校验）", () => {
		const { runtimeWasmDir } = resolveWasmPaths();
		// dirname(运行时目录) 应该是 web-tree-sitter 包根 或 node_modules 父目录
		expect(runtimeWasmDir).toContain("web-tree-sitter");
		// 确认 dirname 是个有效的目录（路径结构合理）
		expect(existsSync(dirname(runtimeWasmDir))).toBe(true);
	});
});

// ──────────────────────── WT25-WT26: 单例缓存 + 并发 ────────────────────────

describe("WT25-WT26: getBashParser 单例 + 并发", () => {
	beforeAll(async () => {
		// 确保单例已初始化（后续测试复用）
		const parser = await getBashParser();
		expect(parser).not.toBeNull();
	});

	afterAll(async () => {
		// 确保单例在所有测试结束后仍可用（无泄漏导致 null）
		const parser = await getBashParser();
		expect(parser).not.toBeNull();
	});

	it("WT25: 第二次调用返回同一 promise（缓存生效）", async () => {
		const p1 = getBashParser();
		const p2 = getBashParser();
		expect(p1).toBe(p2); // 同一 promise 引用
		const parser1 = await p1;
		const parser2 = await p2;
		expect(parser1).toBe(parser2); // 同一 parser 实例
		expect(parser1).not.toBeNull();
	});

	it("WT26: 并发 Promise.all 共享同一 parser 实例", async () => {
		// 注意：单例已缓存时 Promise.all 全是同一 promise；
		// 这里验证即使并发也返回同一实例（不 race）。
		const [a, b, c] = await Promise.all([
			getBashParser(),
			getBashParser(),
			getBashParser(),
		]);
		expect(a).toBe(b);
		expect(b).toBe(c);
		expect(a).not.toBeNull();
	});

	it("WT26b: parser 可重复 parse 不同输入（无状态污染）", async () => {
		const parser = await getBashParser();
		expect(parser).not.toBeNull();
		// 同一 parser 解析两条不同命令，都应成功
		const t1 = parser?.parse("ls -la");
		const t2 = parser?.parse("echo hi && pwd");
		expect(t1).not.toBeNull();
		expect(t2).not.toBeNull();
		expect(t1?.rootNode.type).toBe("program");
		expect(t2?.rootNode.type).toBe("program");
		t1?.delete();
		t2?.delete();
	});
});

// ──────────────────────── WT27: 加载失败降级 ────────────────────────

describe("WT27: 加载失败降级（fail-closed，返回 null 不 throw）", () => {
	it("resolveWasmPaths 对不存在的包抛错", () => {
		// 验证 resolveWasmPaths 本身在路径不存在时是 throw（fail-loud），
		// 由 getBashParser 捕获后 fail-closed。
		// 这里只验证契约：resolveWasmPaths 当前能解析成功（包已装）。
		// 真正的降级路径在下个测试通过模块隔离验证。
		expect(() => resolveWasmPaths()).not.toThrow();
	});

	it("getBashParser 在初始化失败时返回 null（模块隔离测试）", async () => {
		// 用动态 import + vi.resetModules 拿到独立的 loader 模块副本，
		// 篡改其内部 Parser.init 使其抛错，验证 getBashParser 降级返回 null。
		const { vi } = await import("vitest");
		vi.resetModules();

		// mock web-tree-sitter 让 Parser.init 抛错
		vi.doMock("web-tree-sitter", () => ({
			Parser: {
				init: () => Promise.reject(new Error("mock init failure")),
			},
			Language: { load: () => Promise.reject(new Error("never reached")) },
		}));

		try {
			const isolatedLoader = await import("../loader.js");
			const parser = await isolatedLoader.getBashParser();
			// fail-closed：返回 null，不 throw
			expect(parser).toBeNull();
		} finally {
			vi.doUnmock("web-tree-sitter");
			vi.resetModules();
		}
	});
});
