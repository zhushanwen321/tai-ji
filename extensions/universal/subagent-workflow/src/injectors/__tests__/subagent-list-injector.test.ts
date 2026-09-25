// subagent-list-injector 单测
//
// 两类覆盖：
// 1. 纯函数（agent frontmatter 解析直调 core parseResourceMeta / formatAgentList）：
//    P3 正向触发引导语 + 名字约束 + XML 结构 + 转义。发现路径依赖文件系统 +
//    resource-discovery，属集成层（顺序契约经 injector handler 驱动），此处聚焦
//    可快速回归的格式化契约（TC5 回归保护）。
// 2. session 级缓存行为（TC1-TC4）：mock shared/resource-discovery 的 discoverResources
//    （vi.hoisted 稳定 spy + vi.mock 工厂闭包）+ getCachedFileContent 返回 fixture，
//    mock pi.on 捕获三 handler 手动触发；模块级缓存靠 vi.resetModules + 动态 import 重置。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscoveredResource } from "@zhushanwen/subagent-core/shared/resource-discovery.ts";
// 共享 mock 基建（vi.mock 工厂 / mock pi / mock ctx）：helpers/injector-test-mocks.ts
// ——必须先于 barrel import 初始化：barrel 的 re-export 链会触发深路径 mock 工厂，
// 工厂闭包引用本 helpers 的绑定（helpers 文件头「惰性求值」约束）
import { createDiscoveryModuleMock, createLoggerModuleMock, createMockCtx, createMockPi, type CapturedHandlers } from "./helpers/injector-test-mocks.ts";
// C5①：formatAgentList 下沉 core barrel——测试改从 barrel 取实现，guide 用 pi 宿主注入文案；
// frontmatter 解析契约同源 core（parseResourceMeta IF1，原壳侧薄投影已删）
import { formatAgentList, parseResourceMeta } from "@zhushanwen/subagent-core";

// ── 稳定 spy：vi.hoisted 保证 resetModules 后引用不变（vi.mock 工厂闭包捕获同一 fn，
//    故 fresh import 的注入器拿到的 discoverResources === spies.discoverResources，跨
//    resetModules 调用计数连续，mockClear 控制每用例重置） ──
const spies = vi.hoisted(() => ({ discoverResources: vi.fn(), getCachedFileContent: vi.fn() }));

vi.mock("@zhushanwen/subagent-core/shared/resource-discovery.ts", async (importOriginal) =>
	createDiscoveryModuleMock(spies, importOriginal),
);

// 工厂必须写成箭头惰性形式：vi.mock 被提升到 import 之前执行，直接传
// createLoggerModuleMock 引用会在提升位置立即求值 import 绑定 → TDZ ReferenceError
vi.mock("@zhushanwen/pi-extension-logger", () => createLoggerModuleMock());

// ── 纯函数测试：静态 import（模块级缓存状态不影响纯函数；与下方缓存 describe 隔离） ──
import { SUBAGENT_LIST_GUIDE } from "../subagent-list-injector";

describe("agent frontmatter 解析（core parseResourceMeta IF1）", () => {
	it("解析双引号包裹的 name + description", () => {
		const md = `---
name: worker
description: "编码执行者"
---
body`;
		expect(parseResourceMeta(md, "agent")).toMatchObject({
			kind: "agent",
			name: "worker",
			description: "编码执行者",
		});
	});

	it("解析单引号包裹的 name + description", () => {
		const md = `---
name: 'reviewer'
description: '代码审查'
---`;
		expect(parseResourceMeta(md, "agent")).toMatchObject({
			kind: "agent",
			name: "reviewer",
			description: "代码审查",
		});
	});

	it("缺 name 或 description 时返回 null", () => {
		expect(parseResourceMeta("---\nname: worker\n---", "agent")).toBeNull();
		expect(parseResourceMeta("---\ndescription: x\n---", "agent")).toBeNull();
	});

	it("无 frontmatter（不以 --- 开头）返回 null", () => {
		expect(parseResourceMeta("just markdown", "agent")).toBeNull();
	});

	it("frontmatter 未闭合（无结束 ---）返回 null", () => {
		expect(parseResourceMeta("---\nname: worker\ndescription: x", "agent")).toBeNull();
	});
});

describe("formatAgentList", () => {
	it("空列表返回空串（不注入）", () => {
		expect(formatAgentList([], { guide: SUBAGENT_LIST_GUIDE })).toBe("");
	});

	it("TC1: when + examples 注入（原样渲染 + escapeXml + 缺省兼容）", () => {
		const out = formatAgentList([
			{
				name: "reviewer",
				description: "代码审查",
				path: "/agents/reviewer.md",
				when: "用户要求 review 代码",
				examples: [
					{ match: "帮我 review 这段代码", action: "调用 reviewer 对抗式审查", positive: true },
					{ match: "帮我 review 设计文档", action: "不调用（文档审查应选 doc-reviewer）", positive: false },
				],
			},
			{ name: "legacy", description: "未迁移 agent", path: "/agents/legacy.md" },
		], { guide: SUBAGENT_LIST_GUIDE });
		expect(out).toContain("<when>用户要求 review 代码</when>");
		// 正反原样渲染——negative action 含原因文本（评审 M5：渲染器不硬编码）
		expect(out).toContain('"帮我 review 这段代码" → 调用 reviewer 对抗式审查');
		expect(out).toContain('"帮我 review 设计文档" → 不调用（文档审查应选 doc-reviewer）');
		// escapeXml：match 含 < > 被转义
		const xmlOut = formatAgentList([
			{
				name: "x",
				description: "d",
				path: "/agents/x.md",
				examples: [{ match: "处理 <task> 的 diff", action: "调用 x", positive: true }],
			},
		], { guide: SUBAGENT_LIST_GUIDE });
		expect(xmlOut).toContain("&lt;task&gt;");
		// 缺省兼容：无 when/examples 的 agent 不渲染该段
		const legacyOut = formatAgentList([{ name: "legacy", description: "未迁移 agent", path: "/agents/legacy.md" }], { guide: SUBAGENT_LIST_GUIDE });
		expect(legacyOut).not.toContain("<when>");
		expect(legacyOut).not.toContain("<examples>");
	});

	it("包含 P3 正向触发引导语（何时该 delegate）", () => {
		const out = formatAgentList([{ name: "worker", description: "d", path: "/agents/worker.md" }], { guide: SUBAGENT_LIST_GUIDE });
		expect(out).toContain("PRIORITY");
		expect(out).toContain("3+ files");
		expect(out).toContain("delegate");
		expect(out).toContain("FIRST");
	});

	it("C5① guide 更新：agent 引用改为 <location> 路径形态，动态 agent 指引改为缺省 general-purpose（systemPrompt 参数已不在 schema）", () => {
		const out = formatAgentList([{ name: "worker", description: "d", path: "/agents/worker.md" }], { guide: SUBAGENT_LIST_GUIDE });
		expect(out).toContain("ONLY use agents from this list");
		expect(out).toContain("pass the <location> path (absolute .md path) as the agent param");
		expect(out).toContain("omit agent (a general-purpose agent is used)");
		// 旧句已过期（subagent tool schema 无 systemPrompt 参数，见 subagent-tool-schema.ts）
		expect(out).not.toContain("systemPrompt");
		expect(out).not.toContain("ONLY use agent names from this list");
	});

	it("包含 'Do NOT call list to discover' 引导语", () => {
		const out = formatAgentList([{ name: "worker", description: "d", path: "/agents/worker.md" }], { guide: SUBAGENT_LIST_GUIDE });
		expect(out).toContain("Do NOT call list to discover");
		expect(out).toContain("use list only for running state");
	});

	it("用 <available_subagents> 标签包裹并列出每个 agent", () => {
		const out = formatAgentList([
			{ name: "worker", description: "does work", path: "/agents/worker.md" },
			{ name: "reviewer", description: "reviews code", path: "/agents/reviewer.md" },
		], { guide: SUBAGENT_LIST_GUIDE });
		expect(out).toContain("<available_subagents>");
		expect(out).toContain("</available_subagents>");
		expect(out).toContain("<name>worker</name>");
		expect(out).toContain("<description>does work</description>");
		expect(out).toContain("<name>reviewer</name>");
		expect(out).toContain("<description>reviews code</description>");
		// S1：每项含 <location> 完整路径（agentRef，模型直接引用）
		expect(out).toContain("<location>/agents/worker.md</location>");
		expect(out).toContain("<location>/agents/reviewer.md</location>");
	});

	it("转义 XML 特殊字符", () => {
		const out = formatAgentList([{ name: "a&b<c>", description: "\"q\"", path: "/agents/a&b<c>.md" }], { guide: SUBAGENT_LIST_GUIDE });
		expect(out).toContain("<name>a&amp;b&lt;c&gt;</name>");
		expect(out).toContain("&quot;q&quot;");
	});

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
// session 级缓存行为（TC1-TC4；mock pi/ctx 构造在 helpers/injector-test-mocks.ts）
// ──────────────────────────────────────────────────────────────

/** fixture：单个 worker agent 的 DiscoveredResource。 */
function agentResource(path: string): DiscoveredResource {
	return { path, source: "project-agents", available: true };
}

/** fixture：agent .md frontmatter 内容。 */
function agentMd(name: string, description: string): string {
	return `---\nname: ${name}\ndescription: "${description}"\n---\nbody`;
}

describe("subagent-list-injector session 级缓存", () => {
	let setupSubagentListInjector: typeof import("../subagent-list-injector").setupSubagentListInjector;
	let handlers: CapturedHandlers;

	beforeEach(async () => {
		// resetModules + 动态 import：拿 fresh 模块实例 → 模块级 agentCache 重置为 null
		vi.resetModules();
		spies.discoverResources.mockReset();
		spies.getCachedFileContent.mockReset();
		// 默认空发现（各 TC 按需覆盖）
		spies.discoverResources.mockResolvedValue([]);
		spies.getCachedFileContent.mockReturnValue(null);
		handlers = {};
		const mod = await import("../subagent-list-injector");
		setupSubagentListInjector = mod.setupSubagentListInjector;
		setupSubagentListInjector(createMockPi(handlers));
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

		// session_start 发现+缓存（discoverResources count=1）
		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);

		// session_shutdown 清缓存
		handlers.sessionShutdown!({ type: "session_shutdown", reason: "quit" }, createMockCtx());

		// before_agent_start 读到空缓存 → fallback 重新发现（count=2）+ 重新缓存
		const r1 = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(2);
		expect(r1?.systemPrompt).toContain("<name>worker</name>");

		// 再次 before_agent_start 命中缓存（不再调 discoverResources，count 仍 2）
		const r2 = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(2);
		expect(r2?.systemPrompt).toBe(r1?.systemPrompt);
	});

	it("TC3: 无 session_start 直接 before_agent_start（miss fallback）→ 发现+缓存", async () => {
		spies.discoverResources.mockResolvedValue([agentResource("/ws/.agents/agents/worker.md")]);
		spies.getCachedFileContent.mockReturnValue(agentMd("worker", "编码"));

		// 未触发 session_start，直接两次 before_agent_start
		const r1 = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		const r2 = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());

		// 第一次 fallback 发现+缓存（count=1）；第二次命中缓存（count 仍 1）
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);
		expect(r1?.systemPrompt).toContain("<name>worker</name>");
		expect(r2?.systemPrompt).toBe(r1?.systemPrompt);
	});

	it("TC4: session_start(reload) 覆盖缓存（新资源生效）", async () => {
		// 第一次 session_start(new)：发现 worker
		spies.discoverResources.mockResolvedValue([agentResource("/ws/.agents/agents/worker.md")]);
		spies.getCachedFileContent.mockReturnValue(agentMd("worker", "编码"));
		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(1);

		// 资源变化：discoverResources 改返回 reviewer，getCachedFileContent 改返回 reviewer 内容
		spies.discoverResources.mockResolvedValue([agentResource("/ws/.agents/agents/reviewer.md")]);
		spies.getCachedFileContent.mockReturnValue(agentMd("reviewer", "审查"));

		// session_start(reload) 重新发现覆盖缓存（count=2）
		await handlers.sessionStart!({ type: "session_start", reason: "reload" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(2);

		// before_agent_start 命中新缓存：注入段反映 reviewer（非旧 worker）
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
		// session_start 发现抛错：记日志不阻断，缓存保持 null
		await handlers.sessionStart!({ type: "session_start", reason: "new" }, createMockCtx());

		// before_agent_start 读到 null 缓存 → fallback 重新发现（recover）
		spies.discoverResources.mockResolvedValue([agentResource("/ws/.agents/agents/worker.md")]);
		spies.getCachedFileContent.mockReturnValue(agentMd("worker", "编码"));
		const r = await handlers.beforeAgentStart!({ systemPrompt: "" }, createMockCtx());
		expect(spies.discoverResources).toHaveBeenCalledTimes(2);
		expect(r?.systemPrompt).toContain("<name>worker</name>");
	});
});

// ──────────────────────────────────────────────────────────────
// KV-cache 顺序契约：注入段按 name 码点序，重建（两次发现）逐字节一致。
// 经真实 injector 实例的 handler 驱动（工厂 discover 不再模块导出，顺序契约
// 直接验证注入面——比裸 entries 断言更端到端）。
// ──────────────────────────────────────────────────────────────

/** 从注入段提取 <name> 条目出现序（码点序断言用）。 */
function injectedNames(prompt?: string): string[] {
	return [...(prompt ?? "").matchAll(/<name>(.*?)<\/name>/g)].map((m) => m[1]);
}

describe("agent 注入段顺序契约（KV-cache）", () => {
	let handlers: CapturedHandlers;

	beforeEach(async () => {
		// resetModules + 动态 import：拿 fresh 工厂实例（闭包缓存重置），setup 后经 handler 驱动
		vi.resetModules();
		spies.discoverResources.mockReset();
		spies.getCachedFileContent.mockReset();
		handlers = {};
		const mod = await import("../subagent-list-injector");
		mod.setupSubagentListInjector(createMockPi(handlers));
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
