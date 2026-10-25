/**
 * startupConfig 声明守护测试：断言 package.json `taiji.startupConfig` 声明的 content
 * 与代码 DEFAULT_RETRY_RULES_EXT_CONFIG 常量深相等，防止两侧任一改动未同步（漂移）。
 * 机制：runtime 启动序列统一 ensure（extension-startup-config.ts），声明即首建内容。
 * 范式：network-proxy / smart-context 同名测试。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_RETRY_RULES_EXT_CONFIG } from "../config.ts";

/** package.json `taiji.startupConfig` 声明条目的最小形状（守护断言用）。 */
interface StartupConfigEntry { // oe-exempt:20261026:framework:声明守护测试的最小形状锚（测试常驻资产，非临时期限类目可承载）

	path: string;
	content: unknown;
}

const pkg = JSON.parse(
	readFileSync(join(fileURLToPath(import.meta.url), "../../../package.json"), "utf-8"),
) as { "taiji"?: { startupConfig?: StartupConfigEntry[] } };

describe("startupConfig 声明守护", () => {
	it("声明 content 与代码 DEFAULT_RETRY_RULES_EXT_CONFIG 深相等", () => {
		const entry = pkg["taiji"]?.startupConfig?.find(
			(e: StartupConfigEntry) => e.path === "config/retry-rules-ext-config.json",
		);
		expect(entry).toBeDefined();
		expect(entry?.content).toEqual(DEFAULT_RETRY_RULES_EXT_CONFIG);
	});

	it("默认声明为空规则集（P2 降级契约：默认无行为变化——判定不生效，pi 原生词表兜底）", () => {
		expect(DEFAULT_RETRY_RULES_EXT_CONFIG.effectiveRules).toHaveLength(0);
		expect(DEFAULT_RETRY_RULES_EXT_CONFIG.customRules).toHaveLength(0);
	});
});
