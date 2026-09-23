/**
 * UI 语言（u-locale-channel）读取单点：`<dataDir>/ui-preferences.json` 的 extension 侧
 * 唯一消费实现（需求方 = plan / scheduler 等 extension 的 i18n 层，经本模块 import）。
 *
 * 语言归属原则：跨边界只走数据——renderer 是语言权威，进程只读派生态。文件唯一写方 =
 * runtime `config.setUiLocale` handler → `writeUiPreferences`（tmp + rename 原子写）。
 *
 * @data-owner #39 `ui-preferences.json`（本模块是读缓存，非第二写方；登记行见
 * `docs/architecture/data-source-registry.md`）。runtime 以
 * `TAIJI_AGENT_DATA_DIR = getConfigDir()` 注入 pi 子进程；文件形如
 * `{ v: 1, locale: 'zh-CN' | 'en-US', updatedAt }`。
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** UI 语言两值（与 ui-preferences.json 读写两端守卫测试对齐的字面量词表）。 */
export type UiLocale = "zh-CN" | "en-US";

export const DEFAULT_UI_LOCALE: UiLocale = "en-US";

const UI_PREFERENCES_FILENAME = "ui-preferences.json";

/**
 * 模块级 (filePath, mtimeMs, size) 三键读缓存（先例 = system-prompt 的 mtime+size
 * 双键读缓存；mtime+size 防 APFS 等文件系统 mtime 精度截断）：每次读仍 stat 判变
 * （runtime 写盘后下一轮即生效），文件未变时跳过 readFileSync/JSON.parse。
 */
let localeCache: { filePath: string; mtimeMs: number; size: number; locale: UiLocale } | null = null;

/** 读界面语言（数据目录动态推导，禁硬编码路径）；任何失败回落 en-US 且不出声。 */
export function readUiLocale(): UiLocale {
	const dataDir = process.env.TAIJI_AGENT_DATA_DIR;
	if (!dataDir) return DEFAULT_UI_LOCALE;

	const filePath = join(dataDir, UI_PREFERENCES_FILENAME);
	try {
		const stat = statSync(filePath);
		const cached = localeCache;
		if (
			cached !== null &&
			cached.filePath === filePath &&
			cached.mtimeMs === stat.mtimeMs &&
			cached.size === stat.size
		) {
			return cached.locale;
		}
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
		const locale = parseUiLocale(parsed);
		localeCache = { filePath, mtimeMs: stat.mtimeMs, size: stat.size, locale };
		return locale;
	} catch {
		// 文件缺失 / 不可读 / JSON 损坏均归此路径（设计口径：损坏 = 驱逐缓存 + 回落默认 + 无出声面）
		localeCache = null;
		return DEFAULT_UI_LOCALE;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseUiLocale(raw: unknown): UiLocale {
	if (!isRecord(raw)) return DEFAULT_UI_LOCALE;
	const locale = raw.locale;
	return locale === "zh-CN" || locale === "en-US" ? locale : DEFAULT_UI_LOCALE;
}
