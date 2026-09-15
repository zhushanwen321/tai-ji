// workflow-list-injector 单测
//
// 两类覆盖（与 subagent-list-injector.test.ts 对称）：
// 1. 纯函数：summarizeDescription（截断）+ parseWorkflowMeta（meta 块解析）+
//    formatWorkflowList（B2 注入段格式 + 引导语）。discoverAllWorkflows 依赖文件系统
//    + resource-discovery，属集成层，此处聚焦可快速回归的格式化契约（TC5 回归保护）。
// 2. session 级缓存行为（TC1-TC4）：与 subagent 对称，mock shared/resource-discovery
//    的 discoverResources + getCachedFileContent，mock pi.on 捕获三 handler 手动触发；
//    模块级缓存靠 vi.resetModules + 动态 import 重置。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscoveredResource } from "@zhushanwen/subagent-core/shared/resource-discovery.ts";
// 共享 mock 基建（vi.mock 工厂 / mock pi / mock ctx）：helpers/injector-test-mocks.ts
// ——必须先于 barrel import 初始化：barrel 的 re-export 链会触发深路径 mock 工厂，
// 工厂闭包引用本 helpers 的绑定（helpers 文件头「惰性求值」约束）
import { createDiscoveryModuleMock, createLoggerModuleMock, createMockCtx, createMockPi, type CapturedHandlers } from "./helpers/injector-test-mocks.ts";
// C5①：formatWorkflowList/summarizeDescription 下沉 core barrel——测试改从 barrel 取实现
import { formatWorkflowList, summarizeDescription } from "@zhushanwen/subagent-core";

// ── 稳定 spy（vi.hoisted 保证 resetModules 后引用不变，见 subagent 测试同款注释） ──
const spies = vi.hoisted(() => ({ discoverResources: vi.fn(), getCachedFileContent: vi.fn() }));

vi.mock("@zhushanwen/subagent-core/shared/resource-discovery.ts", () => createDiscoveryModuleMock(spies));

// 工厂必须写成箭头惰性形式（vi.mock 提升后直接传引用会 TDZ，见 helper 文件头注释）
vi.mock("@zhushanwen/pi-extension-logger", () => createLoggerModuleMock());

// ── 纯函数测试：静态 import（模块级缓存状态不影响纯函数） ──
import { parseWorkflowMeta, WORKFLOW_LIST_GUIDE } from "../workflow-list-injector";

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
		expect(out).toBe(
			`\n\n<available_workflows>\n${WORKFLOW_LIST_GUIDE}\n  <workflow><name>chain</name><description>三步链</description><location>/workflows/chain.js</location></workflow>\n</available_workflows>`,
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

// ──────────────────────────────────────────────────────────────
// session 级缓存行为（TC1-TC4，与 subagent 对称；mock pi/ctx 构造在
// helpers/injector-test-mocks.ts）
// ──────────────────────────────────────────────────────────────

/** fixture：单个 workflow 的 DiscoveredResource。 */
function workflowResource(path: string): DiscoveredResource {
	return { path, source: "project-pi-tmp", available: true };
}

/** fixture：workflow .js @pi-meta 内容。 */
function workflowJs(name: string, description: string): string {
	return `/* @pi-meta\nname: ${name}\ndescription: ${description}\nphases: [a]\n*/\nrest`;
}

describe("workflow-list-injector session 级缓存", () => {
	let setupWorkflowListInjector: typeof import("../workflow-list-injector").setupWorkflowListInjector;
	let handlers: CapturedHandlers;

	beforeEach(async () => {
		// resetModules + 动态 import：拿 fresh 模块实例 → 模块级 workflowCache 重置为 null
		vi.resetModules();
		spies.discoverResources.mockReset();
		spies.getCachedFileContent.mockReset();
		spies.discoverResources.mockResolvedValue([]);
		spies.getCachedFileContent.mockReturnValue(null);
		handlers = {};
		const mod = await import("../workflow-list-injector");
		setupWorkflowListInjector = mod.setupWorkflowListInjector;
		setupWorkflowListInjector(createMockPi(handlers));
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

	it("session_start 发现空列表缓存后 before_agent_start 命中（不重扫，不注入）", async () => {
		spies.discoverResources.mockResolvedValue([]);
		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);

		const r1 = await handlers.beforeAgentStart!({ systemPrompt: "base" }, createMockCtx());
		const r2 = await handlers.beforeAgentStart!({ systemPrompt: "base" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);
		expect(r1).toBeUndefined();
		expect(r2).toBeUndefined();
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

// ──────────────────────────────────────────────────────────────
// KV-cache 顺序契约：输出按 name 码点序，重建（两次发现）逐字节一致
// ──────────────────────────────────────────────────────────────

describe("discoverAllWorkflows 顺序契约（KV-cache）", () => {
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

		const { discoverAllWorkflows } = await import("../workflow-list-injector");
		const workflows = await discoverAllWorkflows("/ws");
		expect(workflows.map((w) => w.name)).toEqual(["alpha", "chain", "zeta"]);
	});

	it("重建（两次发现顺序不同）输出与渲染结果逐字节一致", async () => {
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

		const { discoverAllWorkflows } = await import("../workflow-list-injector");
		const first = await discoverAllWorkflows("/ws");
		const second = await discoverAllWorkflows("/ws");
		expect(second).toEqual(first);
		expect(formatWorkflowList(second, { guide: WORKFLOW_LIST_GUIDE })).toBe(
			formatWorkflowList(first, { guide: WORKFLOW_LIST_GUIDE }),
		);
	});
});
