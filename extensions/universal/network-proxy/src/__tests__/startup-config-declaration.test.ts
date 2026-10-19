/**
 * startupConfig 声明守护测试：断言 package.json `taiji.startupConfig` 声明的 content
 * 与代码 DEFAULT_NETWORK_PROXY_CONFIG 常量深相等，防止两侧任一改动未同步（漂移）。
 * 机制：runtime 启动序列统一 ensure（extension-startup-config.ts），声明即首建内容。
 * 范式：smart-context 同名测试。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_NETWORK_PROXY_CONFIG } from "../config.ts";

/** package.json `taiji.startupConfig` 声明条目的最小形状（守护断言用）。 */
interface StartupConfigEntry { // oe-exempt:20261019:framework:声明守护测试的最小形状锚（测试常驻资产，非临时期限类目可承载）

	path: string;
	content: unknown;
}

const pkg = JSON.parse(
	readFileSync(join(fileURLToPath(import.meta.url), "../../../package.json"), "utf-8"),
) as { "taiji"?: { startupConfig?: StartupConfigEntry[] } };

describe("startupConfig 声明守护", () => {
	it("声明 content 与代码 DEFAULT_NETWORK_PROXY_CONFIG 深相等", () => {
		const entry = pkg["taiji"]?.startupConfig?.find(
			(e: StartupConfigEntry) => e.path === "config/network-proxy-ext-config.json",
		);
		expect(entry).toBeDefined();
		expect(entry?.content).toEqual(DEFAULT_NETWORK_PROXY_CONFIG);
	});

	it("默认声明为禁用态（P2 降级契约：默认无行为变化）", () => {
		expect(DEFAULT_NETWORK_PROXY_CONFIG.enabled).toBe(false);
	});
});
