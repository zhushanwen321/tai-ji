// src/__tests__/startup-config-declaration.test.ts
//
// startupConfig 声明守护测试：断言 package.json `xyz-agent.startupConfig` 声明的
// content 与代码 DEFAULT_CONFIG 常量深相等，防止两侧任一改动未同步（漂移）。
// 机制：runtime 启动序列统一 ensure（extension-startup-config.ts），声明即首建内容。
//
// 运行：cd extensions/universal/subagent-workflow && npx vitest run src/__tests__/startup-config-declaration.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "@zhushanwen/subagent-core/execution/assembly/config.ts";

/** package.json `xyz-agent.startupConfig` 声明条目的最小形状（守护断言用）。 */
interface StartupConfigEntry {
	path: string;
	content: unknown;
}

const pkg = JSON.parse(
	readFileSync(join(fileURLToPath(import.meta.url), "../../../package.json"), "utf-8"),
) as { "xyz-agent"?: { startupConfig?: StartupConfigEntry[] } };

describe("startupConfig 声明守护", () => {
	it("声明 content 与代码 DEFAULT_CONFIG 深相等", () => {
		const entry = pkg["xyz-agent"]?.startupConfig?.find(
			(e: StartupConfigEntry) => e.path === "subagents/config.json",
		);
		expect(entry).toBeDefined();
		expect(entry?.content).toEqual(DEFAULT_CONFIG);
	});
});
