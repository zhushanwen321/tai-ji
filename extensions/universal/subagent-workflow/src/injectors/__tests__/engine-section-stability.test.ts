// engine-section-stability.test.ts —— [engine-awareness U4 stability-guard]
//
// 字节稳定守护（设计 docs/design/subagent-engine-awareness-injection.md §3.3 D7 /
// §4 A8 的代码级前置）：engine 段延续注入纪律——确定性渲染、链尾位置，引擎切换只断
// system prompt 尾部 cache 前缀（与 provider models 段变更同判，不新增 cache 破坏面，
// cache-probe 前缀指纹归因兼容）。
//
// 三层覆盖：
// 1. 段渲染确定性：pi / zcode / ghost 三形态多次独立调用逐字节相等（toBe 级）；
// 2. 引擎切换只变尾部：provider models 段前缀不变，变化只发生在 engine 段位置（尾部）；
// 3. 段序守护：engine 段恒位于 provider models 段之后（恒链尾）。双保险实现：
//    a) handler 链模拟——真实导入 setupModelListInjector + 复刻 engine handler
//       （D7-④ 起为 engine-awareness.ts 的 setupEngineAwarenessInjector）的渲染
//       拼装（检测编排部分归 engine-awareness.test.ts），模拟 pi 的
//       before_agent_start 链式叠加语义；
//    b) 源码级结构断言——index.ts 锚定注册序（四个 setup 调用先后），engine-awareness.ts
//       锚定拼装形态。
//
// 源码级断言的脆弱性权衡（刻意为之）：engine handler 的生产实现装配依赖
// ModelConfigService 单例与 sessionState 存取器（getModelConfigService() 在测试环境
// 恒 null，导入后 handler 直接早退），链模拟仍以复刻形态锚定拼装保真；而
// before_agent_start 多 handler 的段序由注册序唯一决定，「注册序」这一事实只存在于
// index.ts 源码中——源码结构断言是唯一能锚定它的方式。重构挪动注册位置导致本断言
// 失败属预期行为（提醒同步更新链模拟与守护锚点），不是误报。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// C5①：formatModelList/ModelEntry 下沉 core barrel（setupModelListInjector 留 injector）
import { formatModelList, type ModelEntry } from "@zhushanwen/subagent-core";
import { MODEL_LIST_GUIDE, setupModelListInjector } from "../model-list-injector.ts";
import type { EnginePort } from "@zhushanwen/subagent-core";
import { clearEngines, registerEngine } from "@zhushanwen/subagent-core/execution/engine/registry.ts";
import {
	buildEngineModelsPromptAppend,
	buildSubagentEngineSection,
} from "@zhushanwen/subagent-core";

// ── 测试数据 ────────────────────────────────────────────

/** pi registry 风格条目（provider models 段数据源；同时充当 ctx.modelRegistry 快照）。 */
const PROVIDER_ENTRIES: ModelEntry[] = [
	{
		provider: "zai-coding-cn",
		id: "glm-5.3",
		name: "GLM 5.3",
		reasoning: true,
		input: ["text"],
		contextWindow: 200_000,
	},
	{
		provider: "minimax-cn",
		id: "MiniMax-M3",
		name: "MiniMax M3",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
	},
];

/** zcode 引擎清单（v2 registry 风格 id）。 */
const ZCODE_MODELS: Array<{ id: string; name?: string }> = [
	{ id: "builtin:bigmodel-coding-plan/GLM-5.3", name: "GLM-5.3" },
	{ id: "builtin:bigmodel-coding-plan/GLM-5.3-Flash" },
];

/** 模拟 pi 核心 system prompt（engine 追加段之外的全部内容）。 */
const BASE = "You are a coding agent.\n\n# System\nCore prompt body.";

/**
 * engine handler 的追加段拼装（与 engine-awareness.ts setupEngineAwarenessInjector
 * 内 handler 同款：状态段 + 清单段、空段剔除、\n\n 连接）。复刻保真由下方「段序守护」
 * describe 的源码锚点断言保证。
 */
function composeEngineAppend(defaultEngine: string | undefined): string {
	return [buildSubagentEngineSection(defaultEngine), buildEngineModelsPromptAppend(defaultEngine)]
		.filter((part) => part !== "")
		.join("\n\n");
}

/** index.ts 尾部追加模板的分隔符（`${event.systemPrompt}\n\n${append}`）。 */
const APPEND_SEPARATOR = "\n\n";

/** 合成一个 turn 的 system prompt 尾部：BASE + provider models 段 + engine 追加段。 */
function composeTurn(defaultEngine: string | undefined): string {
	const providerSection = formatModelList(PROVIDER_ENTRIES, { guide: MODEL_LIST_GUIDE });
	const afterProvider = providerSection === "" ? BASE : BASE + providerSection;
	const append = composeEngineAppend(defaultEngine);
	return append === "" ? afterProvider : `${afterProvider}${APPEND_SEPARATOR}${append}`;
}

/** 最大公共前缀长度（逐码元比较；用于「分叉点不早于稳定头部」断言）。 */
function commonPrefixLength(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) i++;
	return i;
}

/** 最小 fake 引擎（照 model-prompt.test.ts 同款形态）：仅 listModels 参与注入链。 */
function fakeEngine(id: string, models: Array<{ id: string; name?: string }>): EnginePort {
	return {
		id,
		capabilities: () => ({ conversation: "unsupported", steer: "unsupported", sandbox: "none" }),
		probe: async () => ({ ok: true, engineVersion: "test" }),
		run: async () => {
			throw new Error("not used in this test");
		},
		read: async () => ({ engineId: id, turns: [], source: "outcome-only" }),
		// 每次调用返回新数组实例（模拟 registry 每 turn 现值）——渲染必须与实例无关
		listModels: () => models.map((m) => ({ ...m })),
	};
}

beforeEach(() => {
	clearEngines();
	registerEngine("zcode", () => fakeEngine("zcode", ZCODE_MODELS));
});

afterEach(() => {
	clearEngines();
});

// ── 1. 段渲染确定性（D7）────────────────────────────────

describe("段渲染确定性（D7：同输入恒同输出）", () => {
	it("pi 形态：状态段多次独立调用逐字节相等；清单段恒空串", () => {
		// pi 形态不依赖注册表（直接走缺省分支），registry 中有 zcode 不影响
		const first = buildSubagentEngineSection("pi");
		const second = buildSubagentEngineSection("pi");
		const third = buildSubagentEngineSection("pi");
		expect(first).toBe(second);
		expect(second).toBe(third);
		// 非空自检：确认 toBe 断言真的在比对段内容而非空串
		expect(first).toContain("<current_subagent_engine>");
		expect(buildEngineModelsPromptAppend("pi")).toBe("");
	});

	it("zcode 形态：状态段 + 清单段多次独立调用逐字节相等（listModels 每次返回新数组实例）", () => {
		const s1 = buildSubagentEngineSection("zcode");
		const s2 = buildSubagentEngineSection("zcode");
		const m1 = buildEngineModelsPromptAppend("zcode");
		const m2 = buildEngineModelsPromptAppend("zcode");
		expect(s1).toBe(s2);
		expect(m1).toBe(m2);
		expect(m1).toContain("<available_zcode_models>");
		expect(m1).toContain("<id>builtin:bigmodel-coding-plan/GLM-5.3</id>");
	});

	it("ghost 形态（未注册引擎）：警告段多次独立调用逐字节相等", () => {
		const first = buildSubagentEngineSection("ghost");
		const second = buildSubagentEngineSection("ghost");
		expect(first).toBe(second);
		expect(first).toContain("engine 'ghost' is not registered");
		expect(buildEngineModelsPromptAppend("ghost")).toBe("");
	});

	it("形态间干扰不产生状态残留：zcode → pi → zcode，两次 zcode 输出逐字节相等", () => {
		const before = buildSubagentEngineSection("zcode");
		// 穿插渲染其他形态（含清单段消费 listModels），再回到 zcode
		buildSubagentEngineSection("pi");
		buildEngineModelsPromptAppend("zcode");
		buildSubagentEngineSection("ghost");
		expect(buildSubagentEngineSection("zcode")).toBe(before);
	});

	it("注册表重建（clearEngines + 同 id 同清单重注册）后同形态输出不变", () => {
		const firstSection = buildSubagentEngineSection("zcode");
		const firstAppend = buildEngineModelsPromptAppend("zcode");
		clearEngines();
		registerEngine("zcode", () => fakeEngine("zcode", ZCODE_MODELS));
		expect(buildSubagentEngineSection("zcode")).toBe(firstSection);
		expect(buildEngineModelsPromptAppend("zcode")).toBe(firstAppend);
	});

	it("组合拼装（index.ts 同款：状态段 + 清单段 join）同引擎多次调用逐字节相等", () => {
		for (const engine of ["zcode", "pi", "ghost"]) {
			expect(composeEngineAppend(engine)).toBe(composeEngineAppend(engine));
		}
	});
});

// ── 2. 引擎切换只变尾部（A8 前置）───────────────────────

/**
 * 断言「从 from 切到 to 时变化只发生在尾部 engine 段」：
 *   - provider models 段及其之前的头部逐字节不变（公共前缀 toBe 级断言）；
 *   - 剥离尾部 engine 追加段后两串余部逐字节相等且恰为稳定头部；
 *   - 分叉点不早于稳定头部末尾（差异绝不侵入 provider models 段）；
 *   - 切换后的引擎追加段恰居 prompt 尾部。
 */
function expectOnlyTailDiffers(from: string | undefined, to: string | undefined): void {
	const stableHead = BASE + formatModelList(PROVIDER_ENTRIES, { guide: MODEL_LIST_GUIDE });
	const before = composeTurn(from);
	const after = composeTurn(to);
	const beforeAppend = composeEngineAppend(from);
	const afterAppend = composeEngineAppend(to);

	expect(before).not.toBe(after);
	expect(before.startsWith(stableHead)).toBe(true);
	expect(after.startsWith(stableHead)).toBe(true);
	expect(before.slice(0, before.length - beforeAppend.length - APPEND_SEPARATOR.length)).toBe(
		stableHead,
	);
	expect(after.slice(0, after.length - afterAppend.length - APPEND_SEPARATOR.length)).toBe(
		stableHead,
	);
	expect(commonPrefixLength(before, after)).toBeGreaterThanOrEqual(stableHead.length);
	expect(after.endsWith(afterAppend)).toBe(true);
}

describe("引擎切换只变尾部（A8 前置：变化只断尾部 cache 前缀）", () => {
	it("zcode → pi：provider models 段前缀不变，变化只发生在 engine 段（尾部）", () => {
		expectOnlyTailDiffers("zcode", "pi");
	});

	it("pi → zcode（反向切换）：同款只变尾部", () => {
		expectOnlyTailDiffers("pi", "zcode");
	});

	it("zcode → ghost（配置手误形态）：G4 降级段同样只替换尾部，不破坏前缀", () => {
		expectOnlyTailDiffers("zcode", "ghost");
	});
});

// ── 3. 段序守护：engine 段恒链尾 ────────────────────────

/** 链模拟用 handler 形态（参数收窄到运行时实际消费的字段）。 */
type ChainHandler = (event: { systemPrompt: string }, ctx: unknown) => unknown;

/** fake ExtensionAPI：捕获 pi.on 注册的 handler（保持注册序）。 */
function capturePi(): { handlers: ChainHandler[]; api: ExtensionAPI } {
	const handlers: ChainHandler[] = [];
	const api = {
		on: (_event: string, handler: (...args: unknown[]) => unknown) => {
			// on 的 mock 签名参数为 unknown[]，收窄到两参形态（pi 调用约定恒两参）
			handlers.push(((event: unknown, ctx: unknown) => handler(event, ctx)) as ChainHandler);
		},
	} as unknown as ExtensionAPI;
	return { handlers, api };
}

/** 模拟 pi 的 before_agent_start 串联语义：按注册序执行，前序返回的 systemPrompt 作为后序输入。 */
async function runHandlerChain(handlers: ChainHandler[], initialPrompt: string): Promise<string> {
	let prompt = initialPrompt;
	const ctx = { modelRegistry: { getAvailable: () => PROVIDER_ENTRIES } };
	for (const handler of handlers) {
		const result: unknown = await handler({ systemPrompt: prompt }, ctx);
		// 运行时收窄：handler 返回 { systemPrompt: string } 时替换链上 prompt，否则保持
		if (typeof result === "object" && result !== null && "systemPrompt" in result) {
			const sp: unknown = (result as { systemPrompt: unknown }).systemPrompt;
			if (typeof sp === "string") prompt = sp;
		}
	}
	return prompt;
}

describe("段序守护：engine 段恒链尾（D7）", () => {
	it("handler 链模拟：按 index.ts 注册序执行后，engine 段位于 provider models 段之后且居尾", async () => {
		const { handlers, api } = capturePi();
		// 真实导入 model list injector（provider models 段的生产渲染路径）
		setupModelListInjector(api);
		// 复刻 engine handler（engine-awareness.ts setupEngineAwarenessInjector）的渲染
		// 拼装部分（检测编排部分归 engine-awareness.test.ts）
		const defaultEngine = "zcode";
		handlers.push((event) => {
			const append = composeEngineAppend(defaultEngine);
			return { systemPrompt: `${event.systemPrompt}${APPEND_SEPARATOR}${append}` };
		});

		const prompt = await runHandlerChain(handlers, BASE);

		const providerIdx = prompt.indexOf("<available_provider_models>");
		const statusIdx = prompt.indexOf("<current_subagent_engine>");
		const zcodeListIdx = prompt.indexOf("<available_zcode_models>");
		expect(providerIdx).toBeGreaterThanOrEqual(0);
		// 段序硬约束：engine 状态段与引擎清单段都在 provider models 段之后
		expect(statusIdx).toBeGreaterThan(providerIdx);
		expect(zcodeListIdx).toBeGreaterThan(providerIdx);
		// 恒链尾：engine 追加段是 prompt 的最后内容
		expect(prompt.endsWith(`${APPEND_SEPARATOR}${composeEngineAppend(defaultEngine)}`)).toBe(true);
		// model list handler 注入形态锚定（BASE + injection 无分隔，生产 handler 同款）
		expect(prompt.startsWith(BASE + formatModelList(PROVIDER_ENTRIES, { guide: MODEL_LIST_GUIDE }))).toBe(true);
	});

	it("对照：注册序颠倒（engine 先、model list 后）时段序断言必失败——守护有判别力", async () => {
		const { handlers, api } = capturePi();
		const defaultEngine = "zcode";
		handlers.push((event) => {
			const append = composeEngineAppend(defaultEngine);
			return { systemPrompt: `${event.systemPrompt}${APPEND_SEPARATOR}${append}` };
		});
		setupModelListInjector(api);

		const prompt = await runHandlerChain(handlers, BASE);

		// 颠倒后 engine 段跑到 provider models 段之前——证明上一条 it 的断言非平凡
		const providerIdx = prompt.indexOf("<available_provider_models>");
		const statusIdx = prompt.indexOf("<current_subagent_engine>");
		expect(statusIdx).toBeGreaterThanOrEqual(0);
		expect(statusIdx).toBeLessThan(providerIdx);
	});

	it("源码级守护：engine handler 注册序在 model list injector 之后（段序由注册序唯一决定）", () => {
		const src = readFileSync(fileURLToPath(new URL("../../index.ts", import.meta.url)), "utf8");
		const eaSrc = readFileSync(fileURLToPath(new URL("../engine-awareness.ts", import.meta.url)), "utf8");
		const lineOf = (needle: string): number => {
			const idx = src.indexOf(needle);
			if (idx < 0) throw new Error(`index.ts 中未找到守护锚点：${needle}`);
			return src.slice(0, idx).split("\n").length;
		};

		// 注册序：subagents → workflows → provider models → engine handler（链尾，D7）。
		// D7-④：index.ts 不再有直接 pi.on("before_agent_start") 注册——四段注入全部经
		// setup* 函数（engine 段经 setupEngineAwarenessInjector）。「零直接注册」断言让
		// 「链尾」语义精确成立；未来若新增直接注册需人工复核段序。
		expect(src.split('pi.on("before_agent_start"')).toHaveLength(1);
		const lineSubagents = lineOf("setupSubagentListInjector(pi);");
		const lineWorkflows = lineOf("setupWorkflowListInjector(pi);");
		const lineModels = lineOf("setupModelListInjector(pi);");
		const lineEngineSetup = lineOf("setupEngineAwarenessInjector(pi,");
		expect(lineSubagents).toBeLessThan(lineWorkflows);
		expect(lineWorkflows).toBeLessThan(lineModels);
		expect(lineModels).toBeLessThan(lineEngineSetup);

		// engine handler 的唯一注册点在 engine-awareness.ts（setupEngineAwarenessInjector
		// 内恰一处 pi.on("before_agent_start")）。
		expect(eaSrc.split('pi.on("before_agent_start"')).toHaveLength(2);

		// engine handler 内渲染调用序：状态段在清单段之前（append 内段序：状态段 → 清单段）。
		// 两个调用在 engine-awareness.ts 中位于同一行（数组字面量），行号无法区分先后——
		// 用字符偏移断言
		const offsetStatusCall = eaSrc.indexOf("buildSubagentEngineSection(defaultEngine)");
		const offsetModelsCall = eaSrc.indexOf("buildEngineModelsPromptAppend(defaultEngine)");
		if (offsetStatusCall < 0 || offsetModelsCall < 0) {
			throw new Error("engine-awareness.ts 中未找到 engine 段渲染调用锚点");
		}
		expect(offsetStatusCall).toBeGreaterThan(eaSrc.indexOf('pi.on("before_agent_start"'));
		expect(offsetStatusCall).toBeLessThan(offsetModelsCall);

		// 链模拟复刻保真锚点：append 拼装形态（空段剔除 + \n\n 连接 + 尾部追加模板）。
		// 这些锚点保证 composeEngineAppend 与生产拼装（engine-awareness.ts）的一致性——
		// 生产形态变化会先在这里红，提醒同步更新本文件全部复刻点。
		expect(eaSrc).toContain('[buildSubagentEngineSection(defaultEngine), buildEngineModelsPromptAppend(defaultEngine)]');
		expect(eaSrc).toContain('.filter((part) => part !== "")');
		expect(eaSrc).toContain('.join("\\n\\n")');
		expect(eaSrc).toContain("${event.systemPrompt}\\n\\n${append}");
	});
});
