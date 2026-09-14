import { describe, expect, it } from "vitest";

import {
	DEFAULT_SMART_CONTEXT_CONFIG,
	buildReinjectSection,
	checkToolThresholdGuard,
	computeFileListsLike,
	estimateShadowedTokens,
	estimateTextTokens,
	findCrossedThresholds,
	formatFileOperationsLike,
	formatK,
	getCurrentModelId,
	isGatingActive,
	isSummaryInflated,
	normalizeSmartContextConfig,
	pickMode,
	pickReinjectFiles,
} from "../pure.js";

describe("normalizeSmartContextConfig", () => {
	it("非对象输入回退默认值", () => {
		const c = normalizeSmartContextConfig(null);
		expect(c).toEqual(DEFAULT_SMART_CONTEXT_CONFIG);
		expect(c.reminderThresholds).toEqual([200_000, 400_000, 600_000]);
	});

	it("阈值过滤非正数并升序、截 3 档；空数组回退默认", () => {
		const c = normalizeSmartContextConfig({ reminderThresholds: [300_000, 100_000, -5, "x", 200_000, 999_000] });
		expect(c.reminderThresholds).toEqual([100_000, 200_000, 300_000]);

		const c2 = normalizeSmartContextConfig({ reminderThresholds: [] });
		expect(c2.reminderThresholds).toEqual([200_000, 400_000, 600_000]);
	});

	it("excludedModels 只留含 / 的字符串条目并去重（精准匹配要求完整 provider/modelId）", () => {
		const c = normalizeSmartContextConfig({
			excludedModels: ["deepseek/deepseek-chat", "deepseek", "deepseek/deepseek-chat", 42],
		});
		expect(c.excludedModels).toEqual(["deepseek/deepseek-chat"]);
	});

	it("compactModel 非法形态回退空 ref", () => {
		const c = normalizeSmartContextConfig({ compactModel: { type: "regex", pattern: "x" } });
		expect(c.compactModel).toEqual({ type: "ref", ref: "" });
	});
});

describe("门控与模式判定（D5/D12）", () => {
	it("getCurrentModelId 拼接 provider/modelId，缺失返回空串", () => {
		expect(getCurrentModelId({ provider: "zai", id: "glm" })).toBe("zai/glm");
		expect(getCurrentModelId(undefined)).toBe("");
	});

	it("isGatingActive：enabled 且未命中排除才放行", () => {
		const config = normalizeSmartContextConfig({ enabled: true, excludedModels: ["deepseek/deepseek-chat"] });
		expect(isGatingActive(config, "zai/glm")).toBe(true);
		expect(isGatingActive(config, "deepseek/deepseek-chat")).toBe(false);
		// provider 前缀不算命中（精准匹配）
		expect(isGatingActive(config, "deepseek/other-model")).toBe(true);
		const disabled = normalizeSmartContextConfig({ enabled: false });
		expect(isGatingActive(disabled, "zai/glm")).toBe(false);
		expect(isGatingActive(config, "")).toBe(false);
	});

	it("pickMode：ref 等于当前模型或未配置 → same-model", () => {
		const unset = normalizeSmartContextConfig({ compactModel: { type: "ref", ref: "" } });
		expect(pickMode(unset, "zai/glm")).toBe("same-model");

		const same = normalizeSmartContextConfig({ compactModel: { type: "ref", ref: "zai/glm" } });
		expect(pickMode(same, "zai/glm")).toBe("same-model");

		const cross = normalizeSmartContextConfig({ compactModel: { type: "ref", ref: "xiaomi/mimo" } });
		expect(pickMode(cross, "zai/glm")).toBe("cross-model");
	});
});

describe("阈值检查（D3/D6）", () => {
	it("findCrossedThresholds：null tokens 容错为空（R7）；已 fired 排除", () => {
		const tiers = [5_000, 10_000, 15_000];
		expect(findCrossedThresholds(tiers, null, new Set())).toEqual([]);
		expect(findCrossedThresholds(tiers, 11_000, new Set([5_000]))).toEqual([10_000]);
		expect(findCrossedThresholds(tiers, 99_000, new Set())).toEqual(tiers);
	});

	it("checkToolThresholdGuard：低于最低档拒绝并带用量数据；null 拒绝", () => {
		const tiers = [200_000, 400_000, 600_000];
		const guardMessage = checkToolThresholdGuard(tiers, 38_000);
		expect(guardMessage).toMatch(/38K/);
		expect(guardMessage).toMatch(/200K/);
		expect(checkToolThresholdGuard(tiers, 250_000)).toBeNull();
		expect(checkToolThresholdGuard(tiers, null)).toMatch(/用量未知/);
	});
});

describe("摘要后处理纯函数（D11/D13）", () => {
	it("formatK 整数/小数", () => {
		expect(formatK(200_000)).toBe("200K");
		expect(formatK(215_000)).toBe("215K");
	});

	it("isSummaryInflated + estimateTextTokens（chars/4）", () => {
		expect(estimateTextTokens("abcd")).toBe(1);
		expect(isSummaryInflated(500, 400)).toBe(true);
		expect(isSummaryInflated(300, 400)).toBe(false);
	});

	it("computeFileListsLike：只读 = read − modified；排序", () => {
		const { readFiles, modifiedFiles } = computeFileListsLike({
			read: new Set(["b.ts", "a.ts", "c.ts"]),
			written: new Set(["c.ts"]),
			edited: new Set(["d.ts"]),
		});
		expect(readFiles).toEqual(["a.ts", "b.ts"]);
		expect(modifiedFiles).toEqual(["c.ts", "d.ts"]);
	});

	it("formatFileOperationsLike 对齐 pi XML tags 格式", () => {
		expect(formatFileOperationsLike(["a.ts"], ["b.ts"])).toBe(
			"\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>",
		);
		expect(formatFileOperationsLike([], [])).toBe("");
	});

	it("pickReinjectFiles：跳过保留段已读，取最近 ≤5（尾部）", () => {
		const reads = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"];
		expect(pickReinjectFiles(reads, new Set(["f2"]))).toEqual(["f3", "f4", "f5", "f6", "f7"]);
	});

	it("buildReinjectSection：空内容跳过、超预算截停", () => {
		expect(buildReinjectSection([{ path: "a", content: "" }])).toBe("");
		const long = "x".repeat(6_000);
		const section = buildReinjectSection([{ path: "a", content: long }]);
		expect(section).toContain("### a");
		expect(section).toContain("[... truncated]");
	});
});

describe("estimateShadowedTokens 口径契约（D2：与 pi estimateTokens 同源）", () => {
	// 合法 AssistantMessage 形状的 fixture（block 数组 content，禁止 as 硬塞 string content——
	// estimateTokens 对 string content 计 0，口径用例会静默失去判别力；设计 §8.3）。
	// 不 import 名义类型：const 泛型保留 block 字面量形状，由 estimateShadowedTokens
	// 参数类型（Parameters<typeof estimateTokens>[0]）在调用点结构校验。
	function makeAssistantMessage<const C extends readonly unknown[]>(content: C) {
		return {
			role: "assistant" as const,
			content,
			api: "openai-completions",
			provider: "zai",
			model: "glm",
			usage: {
				input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 0,
		};
	}

	it("仅含 toolCall 块（arguments 大 JSON）→ > 0（旧 chars/4 口径漏计为 0）", () => {
		const tokens = estimateShadowedTokens([
			makeAssistantMessage([{ type: "toolCall", id: "c1", name: "edit", arguments: { content: "x".repeat(2_400) } }]),
		]);
		expect(tokens).toBeGreaterThan(0);
	});

	it("仅含 thinking 块 → > 0（旧 chars/4 口径漏计为 0）", () => {
		const tokens = estimateShadowedTokens([
			makeAssistantMessage([{ type: "thinking", thinking: "t".repeat(1_600) }]),
		]);
		expect(tokens).toBeGreaterThan(0);
	});
});

// [HISTORICAL] subagent 识别（R6）用例已随本地实现删除移除——现行谓词收敛于
// ext-guards isSubagentProcess（ext-simplify-17 D4），三态与「宁缺勿污」钉值见
// extensions/shared/ext-guards/src/__tests__/predicates.test.ts。
