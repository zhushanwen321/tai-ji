// workflow-list-injector 单测（injectors 域合并宿主：workflow + subagent 两份工厂配置）
//
// 覆盖面：
// 1. 纯函数：summarizeDescription（截断）+ parseWorkflowMeta（meta 块解析）+
//    formatWorkflowList（B2 注入段格式 + 引导语）+ agent 侧 CA2 字节快照
//    （SUBAGENT_LIST_GUIDE 壳自有文案唯一字节锁）。渲染/解析算法下沉 core 的
//    契约（frontmatter 解析、formatAgentList/formatModelList 渲染）由 core
//    meta-parser / injection-render 测试承载，本文件不重复。
// 2. session 级缓存行为：直测工厂 createResourceListInjector——每例新建工厂
//    实例即得全新缓存闭包（不再 vi.resetModules + 动态 import 逼出模块级单例）。
//    同一工厂两份配置（workflow 内置装配循环 / agent assemble 覆写委托 core
//    discoverAgents）对称覆盖：修一个工厂 bug 两份配置同时红。
//    生产模块单例接线（setupWorkflowListInjector = injector.setup）保留一例冒烟。
// 3. KV-cache 顺序契约：注入段按 name 码点序，重建（两次发现）逐字节一致。
// 4. invalid 具名上报（P5 D4-3）：损坏文件在注入段具名呈现，不静默跳过。
//
// mock 面：shared/resource-discovery 的 discoverResources + getCachedFileContent
//（vi.hoisted 稳定 spy），mock pi.on 捕获 handler 手动触发。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscoveredResource } from "@zhushanwen/subagent-core/shared/resource-discovery.ts";
// 共享 mock 基建（vi.mock 工厂 / mock pi / mock ctx）：helpers/injector-test-mocks.ts
// ——必须先于 barrel import 初始化：barrel 的 re-export 链会触发深路径 mock 工厂，
// 工厂闭包引用本 helpers 的绑定（helpers 文件头「惰性求值」约束）
import { createDiscoveryModuleMock, createLoggerModuleMock, createMockCtx, createMockPi, type CapturedHandlers } from "./helpers/injector-test-mocks.ts";
import {
	discoverAgents,
	formatAgentList,
	formatWorkflowList,
	getHostServices,
	summarizeDescription,
	type AgentEntry,
	type WorkflowEntry,
} from "@zhushanwen/subagent-core";
// 被测工厂 + 生产模块导出（parse/guide/单例接线）
import { createResourceListInjector } from "../resource-list-injector.ts";
import { parseWorkflowMeta, setupWorkflowListInjector, WORKFLOW_LIST_GUIDE } from "../workflow-list-injector";
import { SUBAGENT_LIST_GUIDE } from "../subagent-list-injector";

// ── 稳定 spy（vi.hoisted 保证 resetModules 后引用不变）──
const spies = vi.hoisted(() => ({ discoverResources: vi.fn(), getCachedFileContent: vi.fn() }));

vi.mock("@zhushanwen/subagent-core/shared/resource-discovery.ts", async (importOriginal) =>
	createDiscoveryModuleMock(spies, importOriginal),
);

// 工厂必须写成箭头惰性形式（vi.mock 提升后直接传引用会 TDZ，见 helper 文件头注释）
vi.mock("@zhushanwen/pi-extension-logger", () => createLoggerModuleMock());

// ── 工厂配置（复刻 workflow-list-injector.ts / subagent-list-injector.ts 模块内
//    config；生产模块的 config 接线由下方「生产模块单例接线冒烟」条与
//    injector-chain-order 源码锚点兜底）──

/** workflow 侧：内置装配循环（parse + includeTmp），description 截断内聚 parseWorkflowMeta。 */
function makeWorkflowInjector() {
	return createResourceListInjector<WorkflowEntry>({
		kind: "workflows",
		logTag: "[workflow-list-injector]",
		parse: parseWorkflowMeta,
		format: (workflows, invalids) =>
			formatWorkflowList(workflows, {
				guide: WORKFLOW_LIST_GUIDE,
				...(invalids.length > 0 ? { invalids } : {}),
			}),
		includeTmp: true,
	});
}

/** agent 侧：assemble 覆写（U11 委托 core discoverAgents，parse 不参与）。 */
function makeAgentInjector() {
	return createResourceListInjector<AgentEntry>({
		kind: "agents",
		logTag: "[subagent-list-injector]",
		format: (agents, _invalids) => formatAgentList(agents, { guide: SUBAGENT_LIST_GUIDE }),
		assemble: (workspaceRoot) =>
			discoverAgents(workspaceRoot, getHostServices().discoveryRoots?.()?.agents ?? []),
	});
}

// ── 纯函数测试：静态 import（工厂缓存状态不影响纯函数） ──

describe("summarizeDescription", () => {
	it("短描述原样返回", () => {
		expect(summarizeDescription("短描述")).toBe("短描述");
	});

	it("超长描述在句末标点处断句", () => {
		// 每段约 15 字、含「。」，重复 20 次远超 160 字上限
		const long = "审查循环：多批串行。必填参数。继续。".repeat(20);
		const out = summarizeDescription(long, 160);
		expect(out.length).toBeLessThanOrEqual(161);
		expect(out).toContain("。");
	});

	it("无句末标点时硬截断 + 省略号", () => {
		const long = "x".repeat(300);
		const out = summarizeDescription(long, 160);
		expect(out.length).toBe(161); // 160 + 省略号
		expect(out.endsWith("…")).toBe(true);
	});
});

describe("parseWorkflowMeta", () => {
	it("从 @pi-meta 块解析 name + description", () => {
		const src = `// header comment
/* @pi-meta
name: chain
description: 通用编排：三步链
phases: [a, b]
*/
rest of code`;
		expect(parseWorkflowMeta(src)).toEqual({
			name: "chain",
			description: "通用编排：三步链",
			path: "",
		});
	});

	it("双引号包裹的值也能解析", () => {
		const src = `/* @pi-meta
name: "parallel"
description: "多视角并行"
phases: []
*/`;
		expect(parseWorkflowMeta(src)).toEqual({
			name: "parallel",
			description: "多视角并行",
			path: "",
		});
	});

	it("无 meta 块返回 null", () => {
		expect(parseWorkflowMeta("// no meta here")).toBeNull();
	});

	it("@pi-meta 缺 name 或 description 返回 null", () => {
		expect(parseWorkflowMeta("/* @pi-meta\ndescription: x\nphases: []\n*/")).toBeNull();
		expect(parseWorkflowMeta("/* @pi-meta\nname: x\nphases: []\n*/")).toBeNull();
	});

	it("超长 description 被截断为摘要", () => {
		const longDesc = "详".repeat(300);
		const src = `/* @pi-meta\nname: rfl\ndescription: ${longDesc}\nphases: []\n*/`;
		const r = parseWorkflowMeta(src);
		expect(r).not.toBeNull();
		expect(r!.name).toBe("rfl");
		expect(r!.description.length).toBeLessThanOrEqual(161);
	});

	it("review-fix-loop 风格的 meta（长 description 含关键 args）被合理截断", () => {
		const src = `/* @pi-meta
name: review-fix-loop
description: 审查-修复循环：多批串行（批内并行 review → aggregate → fix → 重审直到 clean）。必填 targetType（git-diff/file/dir/text）+ target。批次由必填参数 batch1..batchN 控制（无默认，至少传一个；agents 为单批简写；如 batch1=fallow-scan batch2=reviewer）。更多细节省略。
phases: [Review, Fix]
*/`;
		const r = parseWorkflowMeta(src);
		expect(r).not.toBeNull();
		expect(r!.name).toBe("review-fix-loop");
		expect(r!.description).toContain("targetType");
		expect(r!.description.length).toBeLessThanOrEqual(161);
	});
});

describe("formatWorkflowList", () => {
	it("空列表返回空串（不注入）", () => {
		expect(formatWorkflowList([], { guide: WORKFLOW_LIST_GUIDE })).toBe("");
	});

	it("用 <available_workflows> 标签包裹并列出每个 workflow", () => {
		const out = formatWorkflowList([
			{ name: "chain", description: "三步链", path: "/workflows/chain.js" },
			{ name: "parallel", description: "并行分析", path: "/workflows/parallel.js" },
		], { guide: WORKFLOW_LIST_GUIDE });
		expect(out).toContain("<available_workflows>");
		expect(out).toContain("</available_workflows>");
		expect(out).toContain("<name>chain</name>");
		expect(out).toContain("<description>三步链</description>");
		expect(out).toContain("<name>parallel</name>");
		// S1：每项含 <location> 完整路径（agentRef，模型直接引用）
		expect(out).toContain("<location>/workflows/chain.js</location>");
		expect(out).toContain("<location>/workflows/parallel.js</location>");
	});

	it("CA2 快照等价锚定：骨架 + 条目段逐字节等于 pi 旧本地实现模板（workflow 段 guide 未变）", () => {
		// 条目模板逐字复制自 C5① 前的本地 formatWorkflowList 实现——锚定 core 下沉
		// 未改变渲染字节（workflow 段无 location 变化面，全段逐字节等价）
		const out = formatWorkflowList(
			[{ name: "chain", description: "三步链", path: "/workflows/chain.js" }],
			{ guide: WORKFLOW_LIST_GUIDE },
		);
		// guide 段硬编码（锁文本）：期望值不插值生产常量——改写 WORKFLOW_LIST_GUIDE
		// 即红灯，避免「两侧同源插值」下文案漂移无守卫
		expect(out).toBe(
			`\n\n<available_workflows>\nThe following workflows are available. Do NOT call list to discover available workflows — they are listed below; use list only for running state. All listed workflows run directly via action:run — do NOT use workflow-script generate for any listed workflow. For parameter details, read the <location> script file (script header has @pi-meta parameters + usage). For 2+ independent tasks dispatched together, prefer the \`subagents\` tool — it drives the fan-out workflow for you.\n  <workflow><name>chain</name><description>三步链</description><location>/workflows/chain.js</location></workflow>\n</available_workflows>`,
		);
	});

	it("包含 'Do NOT call list to discover available workflows' 引导语", () => {
		const out = formatWorkflowList([{ name: "chain", description: "d", path: "/workflows/chain.js" }], { guide: WORKFLOW_LIST_GUIDE });
		expect(out).toContain("Do NOT call list to discover available workflows");
		expect(out).toContain("use list only for running state");
	});

	it("引导语通用化：不写死内置 workflow 名，含 info 回收指引", () => {
		const out = formatWorkflowList([{ name: "chain", description: "d", path: "/workflows/chain.js" }], { guide: WORKFLOW_LIST_GUIDE });
		expect(out).toContain("All listed workflows run directly via action:run");
		expect(out).toContain("read the <location> script file");
		// 通用化约束：引导语不点名具体 workflow（名字由 @pi-meta 动态注入，
		// 写死内置名会在新增/移除 workflow 时与列表漂移）
		expect(out).not.toMatch(/review-fix-loop|scatter-gather|map-reduce/);
	});

	it("转义 XML 特殊字符", () => {
		const out = formatWorkflowList([{ name: "a&b", description: "<x>", path: "/workflows/a&b.js" }], { guide: WORKFLOW_LIST_GUIDE });
		expect(out).toContain("<name>a&amp;b</name>");
		expect(out).toContain("&lt;x&gt;");
	});
});

// ── agent 侧 CA2 快照：SUBAGENT_LIST_GUIDE 是壳自有文案，core 测试用假 guide
//    不锁本文案——此处是唯一字节锁（guide 改写即红灯）。渲染骨架与条目模板
//    逐字节面由 core injection-render 的 byte-exact parity 承载。

describe("formatAgentList CA2 快照（agent guide 壳自有文案唯一字节锁）", () => {
	it("CA2 快照等价锚定：骨架 + 条目段逐字节等于 pi 旧本地实现模板（除 location 前缀外零变化）", () => {
		// 条目模板逐字复制自 C5① 前的本地 formatAgentList 实现（escapeXml 同函数），
		// 锚定 core 下沉未改变渲染字节（红线 8：等价豁免仅 location 前缀 + guide 段）
		const agents = [
			{
				name: "reviewer",
				description: "代码审查",
				path: "/OLD-PREFIX/agents/reviewer.md",
				when: "用户要求 review",
			},
			{ name: "worker", description: "does work", path: "/OLD-PREFIX/agents/worker.md" },
		];
		const expectedItems = [
			'  <agent><name>reviewer</name><description>代码审查</description><when>用户要求 review</when><location>/OLD-PREFIX/agents/reviewer.md</location></agent>',
			'  <agent><name>worker</name><description>does work</description><location>/OLD-PREFIX/agents/worker.md</location></agent>',
		];
		const out = formatAgentList(agents, { guide: SUBAGENT_LIST_GUIDE });
		// guide 段硬编码（锁文本）：期望值不插值生产常量——改写 SUBAGENT_LIST_GUIDE
		// 即红灯，避免「两侧同源插值」下文案漂移无守卫
		expect(out).toBe(
			`\n\n<available_subagents>\nThe following subagents are available. PRIORITY: when a task involves reading 3+ files, writing 100+ lines, parallel research, or specialized review, delegate to a matching subagent FIRST instead of doing it yourself — this keeps your context focused on orchestration. Do NOT call list to discover available subagents; use list only for running state. When using the subagent tool, ONLY use agents from this list — pass the <location> path (absolute .md path) as the agent param. If no agent matches your task, omit agent (a general-purpose agent is used) and put all role-specific instructions in the task text.\n${expectedItems.join("\n")}\n</available_subagents>`,
		);

		// location 前缀替换（资产来源迁移：pi-sw 安装目录 → core 包）后其余字节零变化
		const migrated = formatAgentList(
			agents.map((a) => ({ ...a, path: a.path.replace("/OLD-PREFIX/", "/NEW-CORE-PKG/") })),
			{ guide: SUBAGENT_LIST_GUIDE },
		);
		expect(migrated).toBe(out.replaceAll("/OLD-PREFIX/", "/NEW-CORE-PKG/"));
	});
});

// ──────────────────────────────────────────────────────────────
// session 级缓存行为（TC1-TC4 直测工厂；mock pi/ctx 构造在
// helpers/injector-test-mocks.ts）。每例新建工厂实例 = 全新缓存闭包。
// ──────────────────────────────────────────────────────────────

/** fixture：单个 workflow 的 DiscoveredResource。 */
function workflowResource(path: string): DiscoveredResource {
	return { path, source: "project-pi-tmp", available: true };
}

/** fixture：workflow .js @pi-meta 内容。 */
function workflowJs(name: string, description: string): string {
	return `/* @pi-meta\nname: ${name}\ndescription: ${description}\nphases: [a]\n*/\nrest`;
}

/** fixture：单个 agent 的 DiscoveredResource。 */
function agentResource(path: string): DiscoveredResource {
	return { path, source: "project-agents", available: true };
}

/** fixture：agent .md frontmatter 内容。 */
function agentMd(name: string, description: string): string {
	return `---\nname: ${name}\ndescription: "${description}"\n---\nbody`;
}

describe("workflow injector session 级缓存（工厂直测）", () => {
	let handlers: CapturedHandlers;

	beforeEach(() => {
		spies.discoverResources.mockReset();
		spies.getCachedFileContent.mockReset();
		// 默认空发现（各 TC 按需覆盖）
		spies.discoverResources.mockResolvedValue([]);
		spies.getCachedFileContent.mockReturnValue(null);
		handlers = {};
		makeWorkflowInjector().setup(createMockPi(handlers));
	});

	it("TC1: session_start 发现+缓存后，两次 before_agent_start 命中缓存（discoverResources 只调 1 次）", async () => {
		spies.discoverResources.mockResolvedValue([workflowResource("/ws/.pi/workflows/chain.js")]);
		spies.getCachedFileContent.mockReturnValue(workflowJs("chain", "三步链"));

		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);

		const r1 = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		const r2 = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);

		expect(r1?.systemPrompt).toContain("<available_workflows>");
		expect(r1?.systemPrompt).toContain("<name>chain</name>");
		expect(r2?.systemPrompt).toBe(r1?.systemPrompt);
	});

	it("TC2: session_shutdown 清缓存后 before_agent_start miss → fallback 重新发现+缓存", async () => {
		spies.discoverResources.mockResolvedValue([workflowResource("/ws/.pi/workflows/chain.js")]);
		spies.getCachedFileContent.mockReturnValue(workflowJs("chain", "三步链"));

		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);

		handlers.sessionShutdown!({ type: "session_shutdown", reason: "quit" }, createMockCtx());

		const r1 = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(2);
		expect(r1?.systemPrompt).toContain("<name>chain</name>");

		const r2 = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(2);
		expect(r2?.systemPrompt).toBe(r1?.systemPrompt);
	});

	it("TC3: 无 session_start 直接 before_agent_start（miss fallback）→ 发现+缓存", async () => {
		spies.discoverResources.mockResolvedValue([workflowResource("/ws/.pi/workflows/chain.js")]);
		spies.getCachedFileContent.mockReturnValue(workflowJs("chain", "三步链"));

		const r1 = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		const r2 = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());

		expect(spies.discoverResources).toHaveBeenCalledTimes(1);
		expect(r1?.systemPrompt).toContain("<name>chain</name>");
		expect(r2?.systemPrompt).toBe(r1?.systemPrompt);
	});

	it("TC4: session_start(reload) 覆盖缓存（新资源生效）", async () => {
		spies.discoverResources.mockResolvedValue([workflowResource("/ws/.pi/workflows/chain.js")]);
		spies.getCachedFileContent.mockReturnValue(workflowJs("chain", "三步链"));
		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);

		// 资源变化：改返回 parallel
		spies.discoverResources.mockResolvedValue([workflowResource("/ws/.pi/workflows/parallel.js")]);
		spies.getCachedFileContent.mockReturnValue(workflowJs("parallel", "并行分析"));

		await handlers.sessionStart!({ type: "session_start", reason: "reload" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(2);

		const r = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(2);
		expect(r?.systemPrompt).toContain("<name>parallel</name>");
		expect(r?.systemPrompt).not.toContain("chain");
	});

	it("session_start 发现空列表缓存后 before_agent_start 命中（不重扫，注入 D4-2 空态段）", async () => {
		spies.discoverResources.mockResolvedValue([]);
		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);

		const r1 = await handlers.beforeAgentStart!({ systemPrompt: "base" }, createMockCtx());
		const r2 = await handlers.beforeAgentStart!({ systemPrompt: "base" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);
		// 空发现不再整段消失：注入空态段（agent 可区分「功能关闭」与「确实没有」）
		expect(r1?.systemPrompt).toContain("<available_workflows>");
		expect(r1?.systemPrompt).toContain("(none discovered; roots: ");
		// roots 含 workspaceRoot 推导的约定根（findWorkspaceRoot mock 固定 "/ws"）
		expect(r1?.systemPrompt).toContain("/ws/.pi/workflows");
		// 缓存复用：两次注入逐字节一致（KV-cache 契约）
		expect(r2?.systemPrompt).toBe(r1?.systemPrompt);
	});

	it("session_start 发现异常不阻断（fail-safe，缓存保持 null，before_agent_start fallback）", async () => {
		spies.discoverResources.mockRejectedValueOnce(new Error("disk io"));
		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());

		spies.discoverResources.mockResolvedValue([workflowResource("/ws/.pi/workflows/chain.js")]);
		spies.getCachedFileContent.mockReturnValue(workflowJs("chain", "三步链"));
		const r = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(2);
		expect(r?.systemPrompt).toContain("<name>chain</name>");
	});
});

describe("agent injector session 级缓存（assemble 路径工厂直测，与 workflow 侧同骨架对称）", () => {
	let handlers: CapturedHandlers;

	beforeEach(() => {
		spies.discoverResources.mockReset();
		spies.getCachedFileContent.mockReset();
		spies.discoverResources.mockResolvedValue([]);
		spies.getCachedFileContent.mockReturnValue(null);
		handlers = {};
		makeAgentInjector().setup(createMockPi(handlers));
	});

	it("TC1: session_start 发现+缓存后，两次 before_agent_start 命中缓存（discoverResources 只调 1 次）", async () => {
		spies.discoverResources.mockResolvedValue([agentResource("/ws/.agents/agents/worker.md")]);
		spies.getCachedFileContent.mockReturnValue(agentMd("worker", "编码执行者"));

		// session_start 触发发现+缓存
		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);

		// 两次 before_agent_start：均读缓存，不再触发 discoverResources
		const r1 = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		const r2 = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);

		// 两次注入段都含 <available_subagents> 且内容一致（同一缓存）
		expect(r1?.systemPrompt).toContain("<available_subagents>");
		expect(r1?.systemPrompt).toContain("<name>worker</name>");
		expect(r2?.systemPrompt).toBe(r1?.systemPrompt);
	});

	it("TC2: session_shutdown 清缓存后 before_agent_start miss → fallback 重新发现+缓存", async () => {
		spies.discoverResources.mockResolvedValue([agentResource("/ws/.agents/agents/worker.md")]);
		spies.getCachedFileContent.mockReturnValue(agentMd("worker", "编码"));

		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);

		handlers.sessionShutdown!({ type: "session_shutdown", reason: "quit" }, createMockCtx());

		const r1 = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(2);
		expect(r1?.systemPrompt).toContain("<name>worker</name>");

		const r2 = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(2);
		expect(r2?.systemPrompt).toBe(r1?.systemPrompt);
	});

	it("TC3: 无 session_start 直接 before_agent_start（miss fallback）→ 发现+缓存", async () => {
		spies.discoverResources.mockResolvedValue([agentResource("/ws/.agents/agents/worker.md")]);
		spies.getCachedFileContent.mockReturnValue(agentMd("worker", "编码"));

		const r1 = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		const r2 = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());

		expect(spies.discoverResources).toHaveBeenCalledTimes(1);
		expect(r1?.systemPrompt).toContain("<name>worker</name>");
		expect(r2?.systemPrompt).toBe(r1?.systemPrompt);
	});

	it("TC4: session_start(reload) 覆盖缓存（新资源生效）", async () => {
		spies.discoverResources.mockResolvedValue([agentResource("/ws/.agents/agents/worker.md")]);
		spies.getCachedFileContent.mockReturnValue(agentMd("worker", "编码"));
		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);

		// 资源变化：改返回 reviewer
		spies.discoverResources.mockResolvedValue([agentResource("/ws/.agents/agents/reviewer.md")]);
		spies.getCachedFileContent.mockReturnValue(agentMd("reviewer", "审查"));

		await handlers.sessionStart!({ type: "session_start", reason: "reload" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(2);

		const r = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(2);
		expect(r?.systemPrompt).toContain("<name>reviewer</name>");
		expect(r?.systemPrompt).not.toContain("worker");
	});

	it("session_start 发现空列表缓存后 before_agent_start 命中（不重扫，注入 D4-2 空态段）", async () => {
		// 空列表是有效缓存态（非 null）：命中后不重扫；空发现经工厂接管渲染空态段
		spies.discoverResources.mockResolvedValue([]);
		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);

		const r1 = await handlers.beforeAgentStart!({ systemPrompt: "base" }, createMockCtx());
		const r2 = await handlers.beforeAgentStart!({ systemPrompt: "base" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);
		// 工厂共用骨架：agents kind 同样空态显式（不再整段消失）
		expect(r1?.systemPrompt).toContain("<available_subagents>");
		expect(r1?.systemPrompt).toContain("(none discovered; roots: ");
		expect(r1?.systemPrompt).toContain("/ws/.agents/agents");
		expect(r2?.systemPrompt).toBe(r1?.systemPrompt);
	});

	it("session_start 发现异常不阻断（fail-safe，缓存保持 null，before_agent_start fallback）", async () => {
		spies.discoverResources.mockRejectedValueOnce(new Error("disk io"));
		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());

		spies.discoverResources.mockResolvedValue([agentResource("/ws/.agents/agents/worker.md")]);
		spies.getCachedFileContent.mockReturnValue(agentMd("worker", "编码"));
		const r = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(2);
		expect(r?.systemPrompt).toContain("<name>worker</name>");
	});
});

describe("生产模块单例接线冒烟", () => {
	it("setupWorkflowListInjector（模块级单例 = injector.setup）注册的 handler 端到端可驱动", async () => {
		// 其余缓存用例已改直测工厂（新实例即新缓存闭包）；本条锚定生产模块的模块级
		// 单例接线（config 复刻漂移的兜底信号）仍可用。本 describe 独占模块单例，
		// 无跨用例缓存污染。
		spies.discoverResources.mockReset();
		spies.getCachedFileContent.mockReset();
		spies.discoverResources.mockResolvedValue([workflowResource("/ws/.pi/workflows/chain.js")]);
		spies.getCachedFileContent.mockReturnValue(workflowJs("chain", "三步链"));

		const handlers: CapturedHandlers = {};
		setupWorkflowListInjector(createMockPi(handlers));

		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		const r = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		expect(r?.systemPrompt).toContain("<available_workflows>");
		expect(r?.systemPrompt).toContain("<name>chain</name>");
	});
});

// ──────────────────────────────────────────────────────────────
// KV-cache 顺序契约：注入段按 name 码点序，重建（两次发现）逐字节一致。
// 经真实 injector 实例的 handler 驱动（顺序契约直接验证注入面——比裸 entries
// 断言更端到端）。workflow 走内置装配循环、agent 走 assemble 委托，两路径同守。
// ──────────────────────────────────────────────────────────────

/** 从注入段提取 <name> 条目出现序（码点序断言用）。 */
function injectedNames(prompt?: string): string[] {
	return [...(prompt ?? "").matchAll(/<name>(.*?)<\/name>/g)].map((m) => m[1]);
}

describe("workflow 注入段顺序契约（KV-cache）", () => {
	let handlers: CapturedHandlers;

	beforeEach(() => {
		spies.discoverResources.mockReset();
		spies.getCachedFileContent.mockReset();
		handlers = {};
		makeWorkflowInjector().setup(createMockPi(handlers));
	});

	it("输出按 name 码点序排序，与发现层返回顺序（readdir 枚举序）无关", async () => {
		const byPath: Record<string, string> = {
			"/ws/.pi/workflows/zeta.js": workflowJs("zeta", "z"),
			"/ws/.pi/workflows/chain.js": workflowJs("chain", "c"),
			"/ws/.pi/workflows/alpha.js": workflowJs("alpha", "a"),
		};
		spies.discoverResources.mockResolvedValue([
			workflowResource("/ws/.pi/workflows/zeta.js"),
			workflowResource("/ws/.pi/workflows/chain.js"),
			workflowResource("/ws/.pi/workflows/alpha.js"),
		]);
		spies.getCachedFileContent.mockImplementation((p: string) => byPath[p] ?? null);

		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		const r = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		// P5 D4-3：无损坏文件时 invalids 恒空——条目段无 invalid 行
		expect(r?.systemPrompt).not.toContain("<invalid>");
		expect(injectedNames(r?.systemPrompt)).toEqual(["alpha", "chain", "zeta"]);
	});

	it("重建（两次发现顺序不同）注入段逐字节一致", async () => {
		const byPath: Record<string, string> = {
			"/ws/.pi/workflows/b.js": workflowJs("beta", "b"),
			"/ws/.pi/workflows/a.js": workflowJs("alpha", "a"),
		};
		spies.discoverResources
			.mockResolvedValueOnce([
				workflowResource("/ws/.pi/workflows/b.js"),
				workflowResource("/ws/.pi/workflows/a.js"),
			])
			.mockResolvedValueOnce([
				workflowResource("/ws/.pi/workflows/a.js"),
				workflowResource("/ws/.pi/workflows/b.js"),
			]);
		spies.getCachedFileContent.mockImplementation((p: string) => byPath[p] ?? null);

		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		const first = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());

		// 重建：shutdown 清缓存 → reload 重新发现（第二次发现顺序漂移）→ 渲染
		handlers.sessionShutdown!({ type: "session_shutdown", reason: "quit" }, createMockCtx());
		await handlers.sessionStart!({ type: "session_start", reason: "reload" }, createMockCtx());
		const second = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());

		// 注入段（渲染产物）逐字节一致——强于原 entries 全等 + 渲染等价双断言
		expect(second?.systemPrompt).toBe(first?.systemPrompt);
	});
});

describe("agent 注入段顺序契约（KV-cache，assemble 路径）", () => {
	let handlers: CapturedHandlers;

	beforeEach(() => {
		spies.discoverResources.mockReset();
		spies.getCachedFileContent.mockReset();
		handlers = {};
		makeAgentInjector().setup(createMockPi(handlers));
	});

	it("输出按 name 码点序排序，与发现层返回顺序（readdir 枚举序）无关", async () => {
		const byPath: Record<string, string> = {
			"/ws/.agents/agents/zeta.md": agentMd("zeta", "z"),
			"/ws/.agents/agents/worker.md": agentMd("worker", "w"),
			"/ws/.agents/agents/alpha.md": agentMd("alpha", "a"),
		};
		// 刻意以非字母序返回（模拟 readdir 无契约枚举序）
		spies.discoverResources.mockResolvedValue([
			agentResource("/ws/.agents/agents/zeta.md"),
			agentResource("/ws/.agents/agents/worker.md"),
			agentResource("/ws/.agents/agents/alpha.md"),
		]);
		spies.getCachedFileContent.mockImplementation((p: string) => byPath[p] ?? null);

		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		const r = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		// P5 D4-3：agents 走 assemble 路径（core discoverAgents），invalids 恒空——注入段无 invalid 行
		expect(r?.systemPrompt).not.toContain("<invalid>");
		expect(injectedNames(r?.systemPrompt)).toEqual(["alpha", "worker", "zeta"]);
	});

	it("重建（两次发现顺序不同）注入段逐字节一致——目录不变时 session_start/fallback/resume 任意重建等价", async () => {
		const byPath: Record<string, string> = {
			"/ws/.agents/agents/b.md": agentMd("beta", "b"),
			"/ws/.agents/agents/a.md": agentMd("alpha", "a"),
		};
		// 两次发现返回顺序不同（模拟跨进程 readdir 漂移）
		spies.discoverResources
			.mockResolvedValueOnce([
				agentResource("/ws/.agents/agents/b.md"),
				agentResource("/ws/.agents/agents/a.md"),
			])
			.mockResolvedValueOnce([
				agentResource("/ws/.agents/agents/a.md"),
				agentResource("/ws/.agents/agents/b.md"),
			]);
		spies.getCachedFileContent.mockImplementation((p: string) => byPath[p] ?? null);

		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		const first = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());

		// 重建：shutdown 清缓存 → reload 重新发现（第二次发现顺序漂移）→ 渲染
		handlers.sessionShutdown!({ type: "session_shutdown", reason: "quit" }, createMockCtx());
		await handlers.sessionStart!({ type: "session_start", reason: "reload" }, createMockCtx());
		const second = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());

		// 注入段（渲染产物）逐字节一致——强于原 entries 全等 + 渲染等价双断言
		expect(second?.systemPrompt).toBe(first?.systemPrompt);
	});
});

// ──────────────────────────────────────────────────────────────
// invalid 具名上报（P5 D4-3）：三处原静默点（available=false 占位 / meta 解析
// 失败 / 读失败）收敛为 invalids 收集，注入段具名呈现，损坏文件不再静默跳过。
// ──────────────────────────────────────────────────────────────

describe("workflow-list-injector invalid 具名上报（P5 D4-3）", () => {
	let handlers: CapturedHandlers;

	beforeEach(() => {
		spies.discoverResources.mockReset();
		spies.getCachedFileContent.mockReset();
		spies.discoverResources.mockResolvedValue([]);
		spies.getCachedFileContent.mockReturnValue(null);
		handlers = {};
		makeWorkflowInjector().setup(createMockPi(handlers));
	});

	it("available=false 占位（manifest 声明路径缺失）→ invalid 具名（reason 来自发现层）", async () => {
		spies.discoverResources.mockResolvedValue([
			{
				path: "/npm/pkg/missing.js",
				source: "npm",
				available: false,
				reason: "manifest declared path not found",
			},
		]);

		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		const r = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());

		expect(r?.systemPrompt).toContain(
			"<invalid><path>/npm/pkg/missing.js</path><reason>manifest declared path not found</reason></invalid>",
		);
	});

	it("meta 解析失败（parse null）→ 具名 invalid 与正常条目同段（损坏不静默、可用不丢失）", async () => {
		spies.discoverResources.mockResolvedValue([
			workflowResource("/ws/.pi/workflows/broken.js"),
			workflowResource("/ws/.pi/workflows/good.js"),
		]);
		spies.getCachedFileContent.mockImplementation((p: string) =>
			p.endsWith("broken.js") ? "// no @pi-meta block" : workflowJs("good", "正常"),
		);

		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		const r = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());

		expect(r?.systemPrompt).toContain(
			"<invalid><path>/ws/.pi/workflows/broken.js</path><reason>no valid resource metadata</reason></invalid>",
		);
		expect(r?.systemPrompt).toContain("<name>good</name>");
	});

	it("读失败（content 抛错）→ reason = 错误消息具名上报", async () => {
		spies.discoverResources.mockResolvedValue([workflowResource("/ws/.pi/workflows/io.js")]);
		spies.getCachedFileContent.mockImplementation((p: string) => {
			if (p.endsWith("io.js")) throw new Error("EACCES: permission denied");
			return null;
		});

		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		const r = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());

		expect(r?.systemPrompt).toContain("<path>/ws/.pi/workflows/io.js</path>");
		expect(r?.systemPrompt).toContain("EACCES: permission denied");
	});

	it("全部损坏（条目为零 + invalid 非空）→ 空态段 + invalid 行同段（roots 自救 + 具名上报衔接）", async () => {
		spies.discoverResources.mockResolvedValue([workflowResource("/ws/.pi/workflows/broken.js")]);
		spies.getCachedFileContent.mockReturnValue("// no @pi-meta block");

		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		const r = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());

		expect(r?.systemPrompt).toContain("<available_workflows>");
		expect(r?.systemPrompt).toContain("(none discovered; roots: ");
		expect(r?.systemPrompt).toContain(
			"<invalid><path>/ws/.pi/workflows/broken.js</path><reason>no valid resource metadata</reason></invalid>",
		);
	});

	it("session_shutdown 清缓存后 invalid 状态一并清空（重新发现，无跨 session 泄漏）", async () => {
		spies.discoverResources.mockResolvedValue([workflowResource("/ws/.pi/workflows/broken.js")]);
		spies.getCachedFileContent.mockReturnValue("// no @pi-meta block");
		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());

		handlers.sessionShutdown!({ type: "session_shutdown", reason: "quit" }, createMockCtx());
		spies.discoverResources.mockResolvedValue([]);
		const r = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());

		// 重新发现后无损坏文件 → 回纯空态段（无 invalid 行残留）
		expect(r?.systemPrompt).toContain("(none discovered; roots: ");
		expect(r?.systemPrompt).not.toContain("<invalid>");
	});
});
