import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_UI_LOCALE, readUiLocale } from "../ui-locale.ts";

// node:fs 的 ESM namespace 不可配置，vi.spyOn 对具名导出失效（vitest 限制，
// 同 config.test.ts）：mock 包装 readFileSync/statSync（默认透传 actual），
// 供缓存命中断言 override / 计数；其余 fs 操作原样透传。
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal() as typeof import("node:fs");
	return {
		...actual,
		readFileSync: vi.fn(actual.readFileSync),
		statSync: vi.fn(actual.statSync),
	};
});

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "llm-shared-ui-locale-"));
	vi.stubEnv("TAIJI_AGENT_DATA_DIR", dir);
});

afterEach(() => {
	vi.mocked(fs.readFileSync).mockClear();
	vi.mocked(fs.statSync).mockClear();
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	vi.unstubAllEnvs();
});

/** 在 <dir>/ui-preferences.json 写入 locale 并钉住 mtime（防快速连写 mtime 粒度截断）。 */
function writePreferences(locale: unknown, mtimeSec: number): void {
	const filePath = join(dir, "ui-preferences.json");
	writeFileSync(filePath, JSON.stringify({ v: 1, locale, updatedAt: 0 }));
	utimesSync(filePath, mtimeSec, mtimeSec);
}

describe("readUiLocale（<dataDir>/ui-preferences.json 读单点）", () => {
	it("zh-CN / en-US 命中；文件缺失 / env 缺失 → 回落 en-US", () => {
		expect(readUiLocale()).toBe(DEFAULT_UI_LOCALE); // 文件缺失

		writePreferences("zh-CN", 1_000);
		expect(readUiLocale()).toBe("zh-CN");

		writePreferences("en-US", 2_000);
		expect(readUiLocale()).toBe("en-US");

		vi.stubEnv("TAIJI_AGENT_DATA_DIR", undefined);
		expect(readUiLocale()).toBe(DEFAULT_UI_LOCALE); // env 缺失
	});

	it("locale 值域外 / 顶层非对象 / JSON 损坏 → 回落 en-US", () => {
		// 值域外：换新目录绕开 (filePath, mtime, size) 模块缓存（同 plan i18n.test.ts 手法）
		const dir2 = mkdtempSync(join(tmpdir(), "llm-shared-ui-locale-oor-"));
		vi.stubEnv("TAIJI_AGENT_DATA_DIR", dir2);
		writePreferences("fr-FR", 1_000);
		expect(readUiLocale()).toBe(DEFAULT_UI_LOCALE);
		rmSync(dir2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });

		vi.stubEnv("TAIJI_AGENT_DATA_DIR", dir);
		writeFileSync(join(dir, "ui-preferences.json"), "not-json{{");
		utimesSync(join(dir, "ui-preferences.json"), 3_000, 3_000);
		expect(readUiLocale()).toBe(DEFAULT_UI_LOCALE); // JSON 损坏（缓存已驱逐，重读失败同路径）

		writeFileSync(join(dir, "ui-preferences.json"), JSON.stringify([1, 2]));
		utimesSync(join(dir, "ui-preferences.json"), 4_000, 4_000);
		expect(readUiLocale()).toBe(DEFAULT_UI_LOCALE); // 顶层非对象
	});

	it("mtime+size 缓存：文件未变不重读；mtime 变化后重读生效", () => {
		writePreferences("zh-CN", 1_000);
		expect(readUiLocale()).toBe("zh-CN");
		const readsAfterFirst = vi.mocked(fs.readFileSync).mock.calls.length;

		// 未变文件：再读走缓存，readFileSync 调用数不增
		expect(readUiLocale()).toBe("zh-CN");
		expect(vi.mocked(fs.readFileSync).mock.calls.length).toBe(readsAfterFirst);

		// runtime 写盘语义：同路径内容翻转（zh-CN→en-US 等长，size 双键失效）+ mtime 前进
		writePreferences("en-US", 2_000);
		expect(readUiLocale()).toBe("en-US");
		expect(vi.mocked(fs.readFileSync).mock.calls.length).toBe(readsAfterFirst + 1);
	});
});
