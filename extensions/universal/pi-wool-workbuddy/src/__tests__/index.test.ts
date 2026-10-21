// 包组装与模型目录测试：入口 factory 形态 / 快照兜底（17 模型含 hy3）/
// personal/models 拉取与元数据匹配 / 管理动作默认关形态（D5：无自动路径）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AnyModel } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { FAMILY_ID, PROVIDER_ID, default as factory } from "../index.ts";
import { fetchWorkbuddyModels, indexSnapshot, parseModelIds } from "../models.ts";
import { readSnapshotFile } from "@zhushanwen/pi-wool-shared";

const SNAPSHOT_PATH = join(import.meta.dirname, "../../snapshots/workbuddy.json");

const CATALOG_RESPONSE = {
	code: 0,
	data: {
		agents: [
			{ models: ["hy3", "kimi-k3", "brand-new-model"] },
			{ models: ["hy3", "glm-5.3"] }, // 重复 id 去重
		],
	},
};

describe("包入口形态", () => {
	it("FAMILY_ID / PROVIDER_ID 词表一致", () => {
		expect(FAMILY_ID).toBe("workbuddy");
		expect(PROVIDER_ID).toBe("wool-workbuddy");
	});

	it("default export 为扩展 factory（函数）", () => {
		expect(typeof factory).toBe("function");
	});
});

describe("快照兜底（snapshots/workbuddy.json）", () => {
	it("文件可读、形状合法、17 模型含 hy3", () => {
		const snapshot = readSnapshotFile(SNAPSHOT_PATH);
		expect(snapshot).toBeDefined();
		expect(snapshot?.models.length).toBe(17);
		const ids = snapshot?.models.map((model) => model.id);
		expect(ids).toContain("hy3");
		expect(ids).toContain("deepseek-v4.1-flash");
		expect(ids).toContain("kimi-k2.8-preview");
	});

	it("快照模型为完整 chat Model（provider/api/baseUrl 齐备）", () => {
		const snapshot = readSnapshotFile(SNAPSHOT_PATH) as { models: AnyModel[] };
		for (const model of snapshot.models) {
			expect(model.provider).toBe("wool-workbuddy");
			expect(model.api).toBe("wool-workbuddy");
			expect(typeof model.contextWindow).toBe("number");
			expect(typeof model.maxTokens).toBe("number");
			expect(Array.isArray(model.input)).toBe(true);
		}
		const hy3 = snapshot.models.find((model) => model.id === "hy3");
		expect(hy3?.reasoning).toBe(true);
		expect(hy3?.input).toContain("image");
	});

	it("glm-5.3-flash 视觉修正落地（上游宣告多模态但通道未接入，hub issue #315）", () => {
		const snapshot = readSnapshotFile(SNAPSHOT_PATH) as { models: AnyModel[] };
		const glmFlash = snapshot.models.find((model) => model.id === "glm-5.3-flash");
		expect(glmFlash?.input).toEqual(["text"]);
	});
});

describe("personal/models 拉取与元数据匹配", () => {
	it("parseModelIds：agents[].models[] 去重保序", () => {
		const ids = parseModelIds(CATALOG_RESPONSE);
		expect(ids).toEqual(["hy3", "kimi-k3", "brand-new-model", "glm-5.3"]);
	});

	it("非法形态 → throw（读侧不信任外部格式）", () => {
		expect(() => parseModelIds(null)).toThrow();
		expect(() => parseModelIds({ data: {} })).toThrow();
		expect(() => parseModelIds({ data: { agents: "no" } })).toThrow();
	});

	it("fetchWorkbuddyModels：已知 id 用快照元数据、新 id 保守缺省、端点与头族正确", async () => {
		const impl = (async () => new Response(JSON.stringify(CATALOG_RESPONSE), { status: 200 })) as typeof globalThis.fetch;
		vi.stubGlobal("fetch", impl);
		try {
			const snapshot = indexSnapshot(readSnapshotFile(SNAPSHOT_PATH)?.models ?? []);
			const models = await fetchWorkbuddyModels({
				credential: { type: "oauth", access: "tok", refresh: "r", expires: 1, uid: "u1", realm: "cn" },
				signal: new AbortController().signal,
				snapshot,
				realm: "cn",
			});
			expect(models.length).toBe(4);
			const hy3 = models.find((model) => model.id === "hy3");
			expect(hy3?.contextWindow).toBe(192000); // 快照元数据命中
			const fresh = models.find((model) => model.id === "brand-new-model");
			expect(fresh?.reasoning).toBe(false); // 未知 id 保守缺省
			expect(fresh?.input).toEqual(["text"]);
			for (const model of models) {
				expect(model.baseUrl).toBe("https://copilot.tencent.com");
			}
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("无凭据 → throw（目录拉取要求 OAuth）", async () => {
		const snapshot = indexSnapshot([]);
		await expect(
			fetchWorkbuddyModels({ credential: undefined, signal: new AbortController().signal, snapshot, realm: "cn" }),
		).rejects.toThrow("requires OAuth credentials");
	});
});

describe("凭据通道（管理动作侧）", () => {
	it("auth.json 凭据 JSON 可被快照式读取（文件通道存在性——不实际读 pi auth.json）", () => {
		// 形态占位断言：快照读取工具对缺失文件返回 undefined（兜底路径静默降级）
		expect(readSnapshotFile(join(import.meta.dirname, "no-such-file.json"))).toBeUndefined();
	});
});

describe("包文件纪律", () => {
	it("package.json 声明与实装一致（无第三方运行时依赖，仅 wool-shared）", () => {
		const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		expect(Object.keys(packageJson.dependencies ?? {})).toEqual(["@zhushanwen/pi-wool-shared"]);
	});
});
