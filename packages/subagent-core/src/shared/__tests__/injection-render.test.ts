// src/shared/__tests__/injection-render.test.ts
//
// C3-core-render（convergence W3）单元测试：注入渲染面下沉的行为锁定。
// 覆盖 §4.2 W3 门全部条目：
// - 与 pi 现输出逐字节等价（同一组入参，core 输出 === 按 pi-sw injector 现函数
//   模板手工展开的期望串——期望串在本测试内构造，不 import pi-sw）；
// - ModelEntry 守卫（红线 5）：undefined input 不抛且 caps 无 vision /
//   contextWindow undefined 不渲染该元素且无 "undefined" 字样；
// - provider 口径：存在时 provider/id 拼接 + (provider, id) 两段码点序、
//   缺席/空串时裸 id + id 码点序、混合形态归一口径；
// - 分段条目预算（红线 7）：码点序 + 截尾 + 兜底指引行、预算边界（恰好 15/10
//   不截）、先排后截（乱序输入）、models 段无预算完整渲染；
// - guide 宿主注入（渲染源码无内嵌平台文案）；
// - 空态显式（D4-2）：formatEmptyResourceList 形态/转义/去重/空 roots +
//   既有三 format 空列表返空串判据契约不变；
// - summarizeDescription / sortByCodepoint / barrel 逐名探针。
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	formatAgentList,
	formatEmptyResourceList,
	formatModelList,
	formatWorkflowList,
	sortByCodepoint,
	summarizeDescription,
	type AgentEntry,
	type ListFormatOptions,
	type ModelEntry,
	type WorkflowEntry,
} from "../injection-render.ts";
import type {
	AgentEntry as BarrelAgentEntry,
	ModelEntry as BarrelModelEntry,
	WorkflowEntry as BarrelWorkflowEntry,
} from "../../index.ts";
import * as subagentCore from "../../index.ts";

// ============================================================
// fixtures
// ============================================================

const AGENT_GUIDE = "AGENT-GUIDE";
const WORKFLOW_GUIDE = "WORKFLOW-GUIDE";
const MODEL_GUIDE = "MODEL-GUIDE";

const agentOpts: ListFormatOptions = { guide: AGENT_GUIDE };
const workflowOpts: ListFormatOptions = { guide: WORKFLOW_GUIDE };

/** pi 现调用形态的 agent 数据（agent 清单注入投影：已按 name 码点序） */
const piShapedAgents: AgentEntry[] = [
	{
		name: "coder",
		description: 'writes <code> & "quotes"',
		path: "/abs/coder.md",
	},
	{
		name: "reviewer",
		description: "reviews stuff",
		when: "after code changes",
		examples: [
			{ match: "review my diff", action: "delegate to reviewer", positive: true },
			{ match: "write new code", action: "不调用（职责不符）", positive: false },
		],
		path: "/abs/reviewer.md",
	},
];

const piShapedWorkflows: WorkflowEntry[] = [
	{
		name: "review-fix-loop",
		description: "8-dim review & fix loop",
		path: "/abs/review-fix-loop.js",
	},
];

/** pi 现调用形态的 model 数据（toModelEntry 投影：全字段给齐且 provider 非空） */
const piShapedModels: ModelEntry[] = [
	{
		provider: "xai",
		id: "grok",
		name: 'Fast & "cheap"',
		reasoning: false,
		input: [],
		contextWindow: 32000,
	},
	{
		provider: "zai-coding-cn",
		id: "glm-5.3",
		name: "GLM 5.3",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128000,
	},
	{
		provider: "zai-coding-cn",
		id: "glm-5.3-flash",
		name: "GLM 5.3 Flash",
		reasoning: false,
		input: ["text"],
		contextWindow: 64000,
	},
];

/** 批量条目工厂：n01..nNN（同长零填充，码点字典序 = 数值序） */
function genAgents(count: number): AgentEntry[] {
	return Array.from({ length: count }, (_, i) => ({
		name: `n${String(i + 1).padStart(2, "0")}`,
		description: `agent ${i + 1}`,
		path: `/abs/a${i + 1}.md`,
	}));
}

function genWorkflows(count: number): WorkflowEntry[] {
	return Array.from({ length: count }, (_, i) => ({
		name: `w${String(i + 1).padStart(2, "0")}`,
		description: `workflow ${i + 1}`,
		path: `/abs/w${i + 1}.js`,
	}));
}

function genModels(count: number): ModelEntry[] {
	return Array.from({ length: count }, (_, i) => ({
		provider: "p",
		id: `m${String(i + 1).padStart(2, "0")}`,
		name: `model ${i + 1}`,
	}));
}

// ============================================================
// 与 pi 现输出逐字节等价（pi 现调用形态：数据已排、字段给齐）
// 期望串按 pi-sw injector 现函数模板手工展开（不 import pi-sw）
// ============================================================

describe("byte-exact parity with pi-sw current formatters", () => {
	it("formatAgentList 输出与 pi 现实现逐字节等价（含 when/examples 分支与 XML 转义）", () => {
		const expected =
			"\n\n<available_subagents>\n" +
			"AGENT-GUIDE\n" +
			'  <agent><name>coder</name><description>writes &lt;code&gt; &amp; &quot;quotes&quot;</description><location>/abs/coder.md</location></agent>\n' +
			'  <agent><name>reviewer</name><description>reviews stuff</description><when>after code changes</when>\n' +
			"    <examples>\n" +
			'      - "review my diff" → delegate to reviewer\n' +
			'      - "write new code" → 不调用（职责不符）\n' +
			"    </examples>" +
			"<location>/abs/reviewer.md</location></agent>\n" +
			"</available_subagents>";
		expect(formatAgentList(piShapedAgents, agentOpts)).toBe(expected);
	});

	it("formatWorkflowList 输出与 pi 现实现逐字节等价（含 XML 转义）", () => {
		const expected =
			"\n\n<available_workflows>\n" +
			"WORKFLOW-GUIDE\n" +
			'  <workflow><name>review-fix-loop</name><description>8-dim review &amp; fix loop</description><location>/abs/review-fix-loop.js</location></workflow>\n' +
			"</available_workflows>";
		expect(formatWorkflowList(piShapedWorkflows, workflowOpts)).toBe(expected);
	});

	it("formatModelList 输出与 pi 现实现逐字节等价（(provider, id) 排序 + caps 有无 + 转义）", () => {
		const expected =
			"\n\n<available_provider_models>\n" +
			"MODEL-GUIDE\n" +
			'  <model><id>xai/grok</id><name>Fast &amp; &quot;cheap&quot;</name><contextWindow>32000</contextWindow></model>\n' +
			'  <model><id>zai-coding-cn/glm-5.3</id><name>GLM 5.3</name><caps>reasoning,vision</caps><contextWindow>128000</contextWindow></model>\n' +
			'  <model><id>zai-coding-cn/glm-5.3-flash</id><name>GLM 5.3 Flash</name><contextWindow>64000</contextWindow></model>\n' +
			"</available_provider_models>";
		expect(formatModelList(piShapedModels, { guide: MODEL_GUIDE })).toBe(expected);
	});

	it("空列表三函数均返回空串（不注入）", () => {
		expect(formatAgentList([], agentOpts)).toBe("");
		expect(formatWorkflowList([], workflowOpts)).toBe("");
		expect(formatModelList([], { guide: MODEL_GUIDE })).toBe("");
	});
});

// ============================================================
// ModelEntry 并集守卫（红线 5：除 id/name 外全字段 optional）
// ============================================================

describe("ModelEntry union guards (red-line 5)", () => {
	it("input undefined 不抛且 caps 无 vision（reasoning true → caps 含 reasoning）", () => {
		const entry: ModelEntry = {
			id: "glm",
			name: "GLM",
			reasoning: true,
			// input 缺席；pi 版此处抛 TypeError
		};
		const out = formatModelList([entry], { guide: MODEL_GUIDE });
		expect(out).toContain("<caps>reasoning</caps>");
		expect(out).not.toContain("vision");
	});

	it("input 空数组：无 vision；reasoning false：无 reasoning → 无 caps 段", () => {
		const entry: ModelEntry = {
			id: "glm",
			name: "GLM",
			reasoning: false,
			input: [],
		};
		const out = formatModelList([entry], { guide: MODEL_GUIDE });
		expect(out).not.toContain("<caps>");
		expect(out).not.toContain("vision");
	});

	it("contextWindow undefined：无 <contextWindow> 元素且输出无 'undefined' 字样", () => {
		const entry: ModelEntry = { id: "glm", name: "GLM" };
		const out = formatModelList([entry], { guide: MODEL_GUIDE });
		expect(out).not.toContain("<contextWindow>");
		expect(out).not.toContain("undefined");
		expect(out).toContain("</model>");
	});

	it("contextWindow 为 0 是有效值：渲染 <contextWindow>0</contextWindow>（守卫只挡 undefined）", () => {
		const entry: ModelEntry = { id: "glm", name: "GLM", contextWindow: 0 };
		expect(formatModelList([entry], { guide: MODEL_GUIDE })).toContain(
			"<contextWindow>0</contextWindow>",
		);
	});
});

// ============================================================
// provider 口径（本仓补充：并集下 provider 可选）
// ============================================================

describe("provider presence semantics", () => {
	it("provider 存在：<id> 渲染 provider/id 拼接，排序为 (provider, id) 两段码点序", () => {
		// 乱序输入：pi 版 comparator = provider 相同比 id、不同比 provider
		const models: ModelEntry[] = [
			{ provider: "b-provider", id: "a-id", name: "B-A" },
			{ provider: "a-provider", id: "z-id", name: "A-Z" },
			{ provider: "a-provider", id: "b-id", name: "A-B" },
		];
		const out = formatModelList(models, { guide: MODEL_GUIDE });
		const ids = [...out.matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1]);
		expect(ids).toEqual([
			"a-provider/b-id",
			"a-provider/z-id",
			"b-provider/a-id",
		]);
	});

	it("provider 缺席：id 裸渲染 + 排序退化为 id 码点序（zsw 投影形态）", () => {
		const models: ModelEntry[] = [
			{ id: "z-model", name: "Z" },
			{ id: "a-model", name: "A" },
		];
		const out = formatModelList(models, { guide: MODEL_GUIDE });
		const ids = [...out.matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1]);
		expect(ids).toEqual(["a-model", "z-model"]);
	});

	it("provider 空串与缺席等价：裸 id 渲染", () => {
		const models: ModelEntry[] = [
			{ provider: "", id: "x-model", name: "X" },
		];
		const out = formatModelList(models, { guide: MODEL_GUIDE });
		expect(out).toContain("<id>x-model</id>");
		expect(out).not.toContain("/x-model");
	});

	it("混合形态（部分有 provider）：无 provider 条目归一空串排最前，口径确定", () => {
		const models: ModelEntry[] = [
			{ provider: "b", id: "x", name: "BX" },
			{ id: "a", name: "bare-A" },
			{ provider: "a", id: "z", name: "AZ" },
			{ provider: "", id: "c", name: "bare-C" },
		];
		const ids = [
			...formatModelList(models, { guide: MODEL_GUIDE })
				.matchAll(/<id>([^<]+)<\/id>/g),
		].map((m) => m[1]);
		expect(ids).toEqual(["a", "c", "a/z", "b/x"]);
	});
});

// ============================================================
// 分段条目预算（红线 7：码点序 + 截尾 + 兜底指引；内置无豁免；models 永不截）
// ============================================================

describe("per-section entry budget (red-line 7)", () => {
	const NOTICE = "TRUNCATED: run host list command for full inventory";

	it("agents 超预算：按 name 码点序截尾（保留靠前），兜底指引行出现在段末", () => {
		const out = formatAgentList(genAgents(20), {
			guide: AGENT_GUIDE,
			maxEntries: 15,
			truncationNotice: NOTICE,
		});
		for (let i = 1; i <= 15; i++) {
			expect(out).toContain(`n${String(i).padStart(2, "0")}`);
		}
		for (let i = 16; i <= 20; i++) {
			expect(out).not.toContain(`n${String(i).padStart(2, "0")}`);
		}
		// 兜底指引是段内最后一行（闭合标签前）
		const noticeIdx = out.indexOf(NOTICE);
		const closeIdx = out.lastIndexOf("</available_subagents>");
		expect(noticeIdx).toBeGreaterThan(0);
		expect(noticeIdx).toBeLessThan(closeIdx);
		expect(out.slice(noticeIdx + NOTICE.length, closeIdx)).toBe("\n");
	});

	it("乱序输入先排后截：截掉的是码点序尾部而非传入序尾部", () => {
		const reversed = genAgents(20).reverse();
		const out = formatAgentList(reversed, {
			guide: AGENT_GUIDE,
			maxEntries: 15,
		});
		expect(out).toContain("<name>n01</name>");
		expect(out).toContain("<name>n15</name>");
		expect(out).not.toContain("<name>n16</name>");
	});

	it("预算边界：恰好 15 个 agent 传 15 不截、无兜底指引", () => {
		const out = formatAgentList(genAgents(15), {
			guide: AGENT_GUIDE,
			maxEntries: 15,
			truncationNotice: NOTICE,
		});
		expect(out).toContain("<name>n15</name>");
		expect(out).not.toContain(NOTICE);
	});

	it("workflows 预算 10：11 条截 10，边界恰好 10 不截", () => {
		const truncated = formatWorkflowList(genWorkflows(11), {
			guide: WORKFLOW_GUIDE,
			maxEntries: 10,
			truncationNotice: NOTICE,
		});
		expect(truncated).toContain("<name>w10</name>");
		expect(truncated).not.toContain("<name>w11</name>");
		expect(truncated).toContain(NOTICE);

		const exact = formatWorkflowList(genWorkflows(10), {
			guide: WORKFLOW_GUIDE,
			maxEntries: 10,
			truncationNotice: NOTICE,
		});
		expect(exact).toContain("<name>w10</name>");
		expect(exact).not.toContain(NOTICE);
	});

	it("未传 maxEntries 默认全量（pi 现行为）", () => {
		const out = formatAgentList(genAgents(20), agentOpts);
		expect(out).toContain("<name>n20</name>");
	});

	it("截断但未提供 truncationNotice：不追加任何行", () => {
		const out = formatAgentList(genAgents(20), { guide: AGENT_GUIDE, maxEntries: 15 });
		expect(out).toContain("<name>n15</name>");
		expect(out).not.toContain("<name>n16</name>");
		expect(out.endsWith("</available_subagents>")).toBe(true);
	});

	it("models 段无预算参数：25 条完整渲染永不截", () => {
		const out = formatModelList(genModels(25), { guide: MODEL_GUIDE });
		expect(out).toContain("<id>p/m01</id>");
		expect(out).toContain("<id>p/m25</id>");
		expect((out.match(/<model>/g) ?? []).length).toBe(25);
	});
});

// ============================================================
// 空态显式（D4-2 空注入显式化）：零条目时空发现态渲染
// ============================================================

describe("empty-state explicit rendering (D4-2)", () => {
	it("workflows 零条目：渲染 (none discovered; roots: ...) 且外层仍是 <available_workflows> 标签形态（逐字节）", () => {
		const out = formatEmptyResourceList("workflows", [
			"/home/u/.pi/agent/workflows",
			"/ws/.pi/workflows",
		]);
		expect(out).toBe(
			"\n\n<available_workflows>\n" +
				"  (none discovered; roots: /home/u/.pi/agent/workflows, /ws/.pi/workflows)\n" +
				"</available_workflows>",
		);
	});

	it("agents kind：标签映射为 <available_subagents>（两段共用空态形态）", () => {
		const out = formatEmptyResourceList("agents", ["/ws/.agents/agents"]);
		expect(out).toContain("<available_subagents>");
		expect(out).toContain("</available_subagents>");
		expect(out).toContain("(none discovered; roots: /ws/.agents/agents)");
	});

	it("roots 每项 escapeXml（路径含 XML 特殊字符不破坏注入段）", () => {
		const out = formatEmptyResourceList("workflows", ["/a&b<c>/w"]);
		expect(out).toContain("roots: /a&amp;b&lt;c&gt;/w");
	});

	it("重复 roots 保序去重（同 turn 重建字节稳定，KV-cache 契约）", () => {
		const out = formatEmptyResourceList("workflows", ["/r1", "/r2", "/r1"]);
		expect(out).toContain("roots: /r1, /r2)");
		expect(out.match(/\/r1/g)).toHaveLength(1);
	});

	it("空 roots 返回空串（无清单可渲染时不注入，防空括号垃圾）", () => {
		expect(formatEmptyResourceList("workflows", [])).toBe("");
		expect(formatEmptyResourceList("agents", [])).toBe("");
	});

	it("既有三 format 空列表仍返回空串（空态接管在工厂层，判据契约不变）", () => {
		expect(formatAgentList([], agentOpts)).toBe("");
		expect(formatWorkflowList([], workflowOpts)).toBe("");
		expect(formatModelList([], { guide: MODEL_GUIDE })).toBe("");
	});
});

// ============================================================
// invalid 具名上报（D4-3 / P5）：损坏 workflow 不静默跳过
// ============================================================

describe("invalid named reporting (D4-3/P5)", () => {
	const invalids = [
		{ path: "/ws/.pi/workflows/broken.js", reason: "no valid resource metadata" },
	];

	it("非空条目 + invalids：条目行后、闭合标签前渲染 invalid 元素（逐字节）", () => {
		const out = formatWorkflowList(
			[{ name: "chain", description: "三步链", path: "/abs/chain.js" }],
			{ guide: WORKFLOW_GUIDE, invalids },
		);
		expect(out).toBe(
			"\n\n<available_workflows>\n" +
				`${WORKFLOW_GUIDE}\n` +
				"  <workflow><name>chain</name><description>三步链</description><location>/abs/chain.js</location></workflow>\n" +
				"  <invalid><path>/ws/.pi/workflows/broken.js</path><reason>no valid resource metadata</reason></invalid>\n" +
				"</available_workflows>",
		);
	});

	it("invalid path/reason 逐字段 escapeXml（错误消息含特殊字符不破坏注入段）", () => {
		const out = formatWorkflowList(
			[{ name: "chain", description: "d", path: "/abs/chain.js" }],
			{
				guide: WORKFLOW_GUIDE,
				invalids: [{ path: "/a&b<c>.js", reason: 'EACCES: "permission" & denied' }],
			},
		);
		expect(out).toContain(
			"<invalid><path>/a&amp;b&lt;c&gt;.js</path><reason>EACCES: &quot;permission&quot; &amp; denied</reason></invalid>",
		);
	});

	it("不传 invalids / 空数组：输出与既有形态逐字节一致（CA2 锚定面零影响）", () => {
		const entries = [{ name: "chain", description: "d", path: "/abs/chain.js" }];
		const baseline = formatWorkflowList(entries, workflowOpts);
		expect(formatWorkflowList(entries, { guide: WORKFLOW_GUIDE })).toBe(baseline);
		expect(formatWorkflowList(entries, { guide: WORKFLOW_GUIDE, invalids: [] })).toBe(baseline);
	});

	it("空列表 + invalids 非空仍返回空串（invalid 随空态段渲染的分流契约）", () => {
		expect(formatWorkflowList([], { guide: WORKFLOW_GUIDE, invalids })).toBe("");
	});

	it("formatEmptyResourceList invalids：空态行后追加具名上报行（逐字节）", () => {
		const out = formatEmptyResourceList("workflows", ["/ws/.pi/workflows"], invalids);
		expect(out).toBe(
			"\n\n<available_workflows>\n" +
				"  (none discovered; roots: /ws/.pi/workflows)\n" +
				"  <invalid><path>/ws/.pi/workflows/broken.js</path><reason>no valid resource metadata</reason></invalid>\n" +
				"</available_workflows>",
		);
	});

	it("formatEmptyResourceList 无 invalids 缺省参数：输出与既有形态逐字节一致", () => {
		expect(formatEmptyResourceList("workflows", ["/r"])).toBe(
			formatEmptyResourceList("workflows", ["/r"], []),
		);
	});
});

// ============================================================
// 码点序契约（禁 localeCompare——跨环境字节一致）
// ============================================================

describe("codepoint ordering", () => {
	it("formatAgentList 按 name 码点序（大写码点小于小写：A < a < b）", () => {
		const agents: AgentEntry[] = [
			{ name: "b", description: "d", path: "/b.md" },
			{ name: "A", description: "d", path: "/A.md" },
			{ name: "a", description: "d", path: "/a.md" },
		];
		const names = [
			...formatAgentList(agents, agentOpts).matchAll(/<name>([^<]+)<\/name>/g),
		].map((m) => m[1]);
		expect(names).toEqual(["A", "a", "b"]);
	});

	it("sortByCodepoint 非变异：入参数组不动，返回排序副本", () => {
		const input = ["b", "A", "a"];
		const sorted = sortByCodepoint(input, (s) => s);
		expect(sorted).toEqual(["A", "a", "b"]);
		expect(input).toEqual(["b", "A", "a"]);
	});
});

// ============================================================
// guide 宿主注入（core 渲染源码无内嵌平台文案）
// ============================================================

describe("guide host injection", () => {
	it("自定义 guide 原样出现在段首第二行", () => {
		const out = formatAgentList(
			[{ name: "x", description: "d", path: "/x.md" }],
			{ guide: "host-provided-guide" },
		);
		// 输出以 "\n\n<available_subagents>" 开头：split 后 [0]="" [1]="" [2]=tag [3]=guide
		expect(out.split("\n")[3]).toBe("host-provided-guide");
	});

	it("渲染源码无内嵌英文平台 guide 文案（pi guide 特征片段 grep 全 0）", () => {
		const srcDir = path.dirname(fileURLToPath(import.meta.url));
		const renderSource = fs.readFileSync(
			path.join(srcDir, "../injection-render.ts"),
			"utf8",
		);
		const xmlInjectionSource = fs.readFileSync(
			path.join(srcDir, "../xml-injection.ts"),
			"utf8",
		);
		// 三个 pi guide 的特征片段 + 共同开头 "The following "
		const piGuideFragments = [
			"The following ",
			"pass systemPrompt alongside",
			"Do NOT call list",
			"use list only for running state",
			"PRIORITY: when a task involves",
			"run directly via action:run",
			"Do NOT switch the main conversation model",
			"/model command",
		];
		for (const fragment of piGuideFragments) {
			expect(renderSource.includes(fragment), `injection-render.ts 内嵌: ${fragment}`).toBe(false);
			expect(xmlInjectionSource.includes(fragment), `xml-injection.ts 内嵌: ${fragment}`).toBe(false);
		}
	});
});

// ============================================================
// summarizeDescription（随 WorkflowEntry 链下沉，zsw 同口径）
// ============================================================

describe("summarizeDescription", () => {
	it("短文本 trim 后原样返回", () => {
		expect(summarizeDescription("  hello world  ")).toBe("hello world");
	});

	it("恰好 maxLen 原样（不截不加省略号）", () => {
		const text = "a".repeat(160);
		expect(summarizeDescription(text)).toBe(text);
	});

	it("超长无断点：硬截断 + 省略号", () => {
		const text = "a".repeat(200);
		expect(summarizeDescription(text)).toBe(`${"a".repeat(160)}…`);
	});

	it("句号断句：maxLen 内最后的句末标点处断（含标点）", () => {
		// maxLen=10：slice 内位置 9 的句号 >= 10*0.4=4，采用
		expect(summarizeDescription("abc def g。qrs tail", 10)).toBe("abc def g。");
	});

	it("英文句点断句：'. ' 位置 >= 阈值时采用（slice(0, boundary+1)，含点不含尾随空格）", () => {
		// maxLen=10：'. ' 的 "." 在位置 5 >= 4，采用 → slice(0, 6) = "hello."
		expect(summarizeDescription("hello. worldxxxx", 10)).toBe("hello.");
	});

	it("断点过靠前不采用：硬截断 + 省略号", () => {
		// maxLen=20，阈值 8；位置 2 的句号 < 8，不采用
		expect(summarizeDescription("ab。cdefghijklmnopqrstuv", 20)).toBe(
			"ab。cdefghijklmnopqrs…",
		);
	});
});

// ============================================================
// barrel 逐名探针（红线 9：新增导出必须进 barrel，逐名列出）
// ============================================================

describe("barrel exports probe", () => {
	it("值导出逐名可达（typeof function）", () => {
		const valueExports = [
			"formatAgentList",
			"formatEmptyResourceList",
			"formatWorkflowList",
			"formatModelList",
			"sortByCodepoint",
			"summarizeDescription",
			"escapeXml",
			"renderXmlSection",
			"discoverResources",
			"findWorkspaceRoot",
			"getCachedFileContent",
			"getCachedParsed",
			"parseResourceMeta",
		] as const;
		const barrel = subagentCore as Record<string, unknown>;
		for (const name of valueExports) {
			expect(typeof barrel[name], `barrel 缺值导出: ${name}`).toBe("function");
		}
	});

	it("类型导出经 barrel 可引用（typecheck 即探针）", () => {
		const agent: BarrelAgentEntry = { name: "n", description: "d", path: "/p" };
		const workflow: BarrelWorkflowEntry = { name: "n", description: "d", path: "/p" };
		const model: BarrelModelEntry = { id: "i", name: "n" };
		expect(agent.name).toBe("n");
		expect(workflow.name).toBe("n");
		expect(model.id).toBe("i");
	});
});
