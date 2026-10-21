// 模型目录对照测试：真实 get_detail_param 响应样本（脱敏入库）→ pi 模型目录。
// 断言核心 = D4 验收条款④：consumption_rate 字段透传进模型元数据（仅透传展示）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TraeCatalogError, fetchTraeCatalog } from "../catalog.ts";
import { CATALOG_ENDPOINT, TRAE_GATEWAY_CN } from "../protocol.ts";

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "trae-catalog-sample.json"), "utf8")) as unknown;

const TEST_AUTH = { token: "test-jwt", userId: "u1", machineId: "m1", soloDeviceId: "d1" };

/** fixture 样本形态：4 条目 = 可见带 rate / 不可见 subagent / 不可见内部模型 / 自定义模型无 rate。 */
describe("fetchTraeCatalog（真实目录样本，脱敏入库）", () => {
	it("consumption_rate 透传（验收条款④）：enable+rate → consumptionRate 元数据字段", async () => {
		const models = await fetchTraeCatalog(TEST_AUTH, fixtureFetch());
		const flash = models.find((model) => model.id === "deepseek-v4.1-flash");
		expect(flash?.consumptionRate).toEqual({ enable: true, rate: 0.06 });
	});

	it("无 consumption_rate 条目不写字段（step-5-preview 自定义模型）", async () => {
		const models = await fetchTraeCatalog(TEST_AUTH, fixtureFetch());
		const step = models.find((model) => model.id === "step-5-preview");
		expect(step).toBeDefined();
		expect(step?.consumptionRate).toBeUndefined();
	});

	it("非用户可见条目过滤：不可见（is_invisible_to_user）条目不入目录", async () => {
		const models = await fetchTraeCatalog(TEST_AUTH, fixtureFetch());
		const ids = models.map((model) => model.id);
		expect(ids).toContain("deepseek-v4.1-flash");
		expect(ids).not.toContain("computer_use_subagent");
		expect(ids).not.toContain("seed-code-pro-0430");
	});

	it("完整 pi 模型字段（api/provider/baseUrl/上下文窗口/maxTokens）", async () => {
		const models = await fetchTraeCatalog(TEST_AUTH, fixtureFetch());
		const flash = models.find((model) => model.id === "deepseek-v4.1-flash");
		expect(flash?.api).toBe("wool-trae");
		expect(flash?.provider).toBe("wool-trae");
		expect(flash?.baseUrl).toBe(TRAE_GATEWAY_CN);
		expect(flash?.name).toBe("DeepSeek-V4.1-Flash");
		expect(typeof flash?.contextWindow).toBe("number");
		expect(flash?.contextWindow).toBeGreaterThan(0);
	});

	it("请求组装对照：POST get_detail_param + 7 字段请求体 + Cloud-IDE-JWT 头族", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const models = await fetchTraeCatalog(TEST_AUTH, async (input, init) => {
			capturedUrl = String(input);
			capturedInit = init;
			return fixtureResponse();
		});
		expect(models.length).toBeGreaterThan(0);
		expect(capturedUrl).toBe(`${TRAE_GATEWAY_CN}${CATALOG_ENDPOINT}`);
		const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
		// 空 body = 上游 500（实测）：7 字段齐备
		expect(Object.keys(body).sort()).toEqual(
			["agent_type", "config_names", "current_config_info", "function", "mode_type", "need_prompt", "poly_prompt"].sort(),
		);
		expect(body.function).toBe("solo_work_lite");
		const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBe("Cloud-IDE-JWT test-jwt");
		expect(headers["x-ide-version"]).toBe("0.1.52");
		expect(headers["x-machine-id"]).toBe("m1");
	});

	it("HTTP 500 → TraeCatalogError", async () => {
		const failing = async (): Promise<Response> => new Response("server error", { status: 500 });
		await expect(fetchTraeCatalog(TEST_AUTH, failing)).rejects.toThrow(TraeCatalogError);
	});

	it("响应缺 config_info_list → TraeCatalogError（读侧不信任外部格式）", async () => {
		const malformed = async (): Promise<Response> => new Response(JSON.stringify({ other: 1 }), { status: 200 });
		await expect(fetchTraeCatalog(TEST_AUTH, malformed)).rejects.toThrow(TraeCatalogError);
	});
});

function fixtureResponse(): Response {
	return new Response(JSON.stringify(FIXTURE), { status: 200 });
}

function fixtureFetch(): typeof globalThis.fetch {
	return async () => fixtureResponse();
}
