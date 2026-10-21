// index.test.ts — 扩展装配层测试（替换 u-foundation 的占位测试文件）。
//
// 覆盖：default export 的 ExtensionFactory 形态、provider 注册词表、oauth/管理命令/
// refreshModels 装配面、包内快照兜底的可读性。pi 契约深度行为由 wool-shared 的
// scaffold 测试与 P5 真机探针承接。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSnapshotFile } from "@zhushanwen/pi-wool-shared";

import piWoolQoder, { FAMILY_ID, PROVIDER_ID } from "../index.ts";

/** ExtensionAPI 最小替身（装配面断言用；不跑真实 pi 生命周期）。 */
function fakePi() {
	const providers: { name: string; config: Record<string, unknown> }[] = [];
	const commands: string[] = [];
	const events: string[] = [];
	return {
		providers,
		commands,
		events,
		api: {
			on: (event: string) => {
				events.push(event);
			},
			registerProvider: (name: string, config: Record<string, unknown>) => {
				providers.push({ name, config });
			},
			registerCommand: (name: string) => {
				commands.push(name);
			},
			appendEntry: () => {},
		},
	};
}

describe("扩展装配", () => {
	it("词表：family=qoder / provider=wool-qoder", () => {
		expect(FAMILY_ID).toBe("qoder");
		expect(PROVIDER_ID).toBe("wool-qoder");
	});

	it("default export 为 ExtensionFactory：注册 wool-qoder provider + wool-qoder 管理命令 + session_start 监听", () => {
		expect(typeof piWoolQoder).toBe("function");
		const pi = fakePi();
		piWoolQoder(pi.api as never);
		expect(pi.providers.length).toBe(1);
		const { name, config } = pi.providers[0]!;
		expect(name).toBe("wool-qoder");
		// pi composer 硬校验项（P6 发现）：api + baseUrl。
		expect(config.api).toBe("wool-qoder");
		expect(config.baseUrl).toContain("gateway.qoder.com.cn");
		// oauth 三钩子与 refreshModels（动态目录 provider）装配在位。
		expect(typeof (config.oauth as Record<string, unknown>)?.login).toBe("function");
		expect(typeof (config.oauth as Record<string, unknown>)?.refreshToken).toBe("function");
		expect(typeof (config.oauth as Record<string, unknown>)?.getApiKey).toBe("function");
		expect(typeof config.refreshModels).toBe("function");
		expect(typeof config.streamSimple).toBe("function");
		// 管理命令（taiji 管理专用会话通道）。
		expect(pi.commands).toContain("wool-qoder");
		// 两个 session_start listener（scaffold 凭据解析器 + 管理通道 registry 捕获）。
		expect(pi.events.filter((event) => event === "session_start").length).toBe(2);
	});

	it("workspace 依赖 @zhushanwen/pi-wool-shared 可解析", async () => {
		const shared = await import("@zhushanwen/pi-wool-shared");
		expect(typeof shared.createAssistantStream).toBe("function");
		expect(typeof shared.registerWoolManageCommand).toBe("function");
	});
});

describe("包内快照兜底（D4 第三层：首装离线回落）", () => {
	it("snapshots/qoder.json 可解析且含测试模型 Qwen3.8-Flash", () => {
		const snapshot = readSnapshotFile(join(import.meta.dirname, "..", "..", "snapshots", "qoder.json"));
		expect(snapshot).toBeDefined();
		expect(snapshot?.family).toBe("qoder");
		const ids = snapshot?.models.map((model) => model.id) ?? [];
		expect(ids).toContain("qfmodel");
		// 三处同型：快照模型必须带 provider/api（pi fetchModels 契约）。
		for (const model of snapshot?.models ?? []) {
			expect(model.provider).toBe("wool-qoder");
			expect(model.api).toBe("wool-qoder");
		}
	});

	it("快照文件被 package.json files 白名单覆盖（发布产物自包含）", () => {
		const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { files: string[] };
		// files 覆盖 src/** 与 index.ts；snapshots 需显式在列（快照兜底资产不进发布件 = 静默失效）。
		expect(packageJson.files.some((pattern) => pattern.includes("snapshots"))).toBe(true);
	});
});
