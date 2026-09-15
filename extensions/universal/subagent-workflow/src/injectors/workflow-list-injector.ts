/**
 * Workflow List Injector（B2 / P1；C5① 渲染改接 core）
 *
 * 发现所有可用 workflow（.js/.mjs）并通过 before_agent_start 每 turn 注入
 * `<available_workflows>` 段（name + description），与 subagent 注入段对称。
 *
 * 背景：此前只有 `<available_subagents>`，自定义 workflow 只能靠 list 发现，
 * 与 subagent 不对称。补全后模型可直接 `run` 已列出的 workflow，无需先 list。
 *
 * 实现要点：
 * - D7-②（dual-track convergence）：同构骨架（缓存对/唯一写点/三 handler）收敛到
 *   同目录 resource-list-injector.ts 工厂，本文件只保留 workflow 侧真差异：
 * - parseWorkflowMeta：.js @pi-meta 块 → WorkflowEntry（m2 收敛改调 shared/meta-parser
 *   parseResourceMeta，仅认 @pi-meta 新格式；description 截断用 core summarizeDescription
 *   ——builtin 的 review-fix-loop 描述超长，全量注入每 turn 会膨胀 prompt）
 * - includeTmp：发现覆盖 .pi/workflows/.tmp/（workflow-script generate 的产物）
 * - C5①（convergence D-3）：formatWorkflowList/summarizeDescription/sortByCodepoint
 *   下沉 core，本文件经 barrel 消费（渲染骨架与条目模板逐字节同 pi 旧本地实现——
 *   CA2 快照验收前提）；guide 文案是 pi 宿主注入（core 不内嵌平台文案）
 */



import {
	formatWorkflowList,
	parseResourceMeta,
	summarizeDescription,
	type WorkflowEntry,
} from "@zhushanwen/subagent-core";

import { createResourceListInjector } from "./resource-list-injector.ts";

/**
 * pi 版注入引导文案（C5① guide 参数化——core 渲染函数不内嵌平台文案，宿主注入；
 * 文案与改造前本地实现逐字一致——workflow 段 guide 无过期问题）。
 *
 * 引导语与具体 workflow 解耦：不写死内置名（列表本身已含全部 workflow，名字/描述
 * 每 turn 由 @pi-meta 动态注入），只给通用路由指引 + read location 参数指针。
 */
export const WORKFLOW_LIST_GUIDE =
	"The following workflows are available. Do NOT call list to discover available workflows — they are listed below; use list only for running state. All listed workflows run directly via action:run — do NOT use workflow-script generate for any listed workflow. For parameter details, read the <location> script file (script header has @pi-meta parameters + usage).";

/**
 * 解析 workflow .js 文件的 meta（name + description），经 IF1 parseResourceMeta。
 * 投影到 WorkflowEntry {name, description(summarized)} 注入用。
 */
export function parseWorkflowMeta(content: string): WorkflowEntry | null {
	const meta = parseResourceMeta(content, "workflow");
	if (!meta || meta.kind !== "workflow") return null;
	// path 由工厂 discover 从 DiscoveredResource.path 填充
	return { name: meta.name, description: summarizeDescription(meta.description), path: "" };
}

/** workflow 清单实例：缓存生命周期 / 发现 / 三 handler 全部经工厂骨架。 */
const injector = createResourceListInjector<WorkflowEntry>({
	kind: "workflows",
	logTag: "[workflow-list-injector]",
	parse: parseWorkflowMeta,
	format: (workflows) => formatWorkflowList(workflows, { guide: WORKFLOW_LIST_GUIDE }),
	includeTmp: true,
});

/** 用统一资源发现发现所有可用 workflow（includeTmp 覆盖 generate 产物；骨架与排序契约见工厂）。 */
export const discoverAllWorkflows = injector.discover;

/** 注册 session 生命周期 handler，注入 `<available_workflows>` 段（与 subagent 注入 handler 链式）。 */
export const setupWorkflowListInjector = injector.setup;
