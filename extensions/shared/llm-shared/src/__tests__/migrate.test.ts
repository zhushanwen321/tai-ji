import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyConfig } from "../migrate.ts";

describe("migrateLegacyConfig", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-migrate-test-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	it("旧路径不存在 → noop（migrated: false，不动文件系统）", () => {
		const result = migrateLegacyConfig(dir, "old.json", "config/new.json");
		expect(result.migrated).toBe(false);
		expect(existsSync(join(dir, "config/new.json"))).toBe(false);
	});

	it("旧路径存在 + 新路径不存在 → 原子搬移（旧消失、新出现、内容一致）", () => {
		writeFileSync(join(dir, "old.json"), '{"mode":"strict"}', "utf-8");
		const result = migrateLegacyConfig(dir, "old.json", "config/new.json");
		expect(result.migrated).toBe(true);
		expect(existsSync(join(dir, "old.json"))).toBe(false);
		expect(existsSync(join(dir, "config/new.json"))).toBe(true);
		expect(readFileSync(join(dir, "config/new.json"), "utf-8")).toBe('{"mode":"strict"}');
	});

	it("旧路径存在 + 新路径已存在 → 删除旧文件（新的是当前配置，旧的是残留副本）", () => {
		mkdirSync(join(dir, "config"), { recursive: true });
		writeFileSync(join(dir, "old.json"), "OLD", "utf-8");
		writeFileSync(join(dir, "config/new.json"), "NEW", "utf-8");
		const result = migrateLegacyConfig(dir, "old.json", "config/new.json");
		expect(result.migrated).toBe(false);
		expect(result.removedLegacy).toBe(true);
		// 旧文件被删（清理残留），新文件保留不被覆盖
		expect(existsSync(join(dir, "old.json"))).toBe(false);
		expect(readFileSync(join(dir, "config/new.json"), "utf-8")).toBe("NEW");
	});

	it("迁移失败 → 不抛错，返回 error（best-effort，旧文件仍在）", () => {
		// blocking-file 是文件不是目录，newRel 的父目录 mkdirSync 失败
		writeFileSync(join(dir, "blocking-file"), "", "utf-8");
		writeFileSync(join(dir, "old.json"), "X", "utf-8");
		const result = migrateLegacyConfig(dir, "old.json", "blocking-file/new.json");
		expect(result.migrated).toBe(false);
		expect(result.error).toBeDefined();
		expect(existsSync(join(dir, "old.json"))).toBe(true);
	});
});
