/**
 * Subagent List Injector（迁移自 unified-hooks + P3/P4 改造；C5① 渲染改接 core）
 *
 * 发现所有可用 subagent（builtin + user + project 各源）并通过 before_agent_start
 * 每 turn 注入 `<available_subagents>` 段（name + description），让模型能选对 agent
 * 名字而非臆造。注入格式对齐 pi 内置 skill 注入（XML 标签）。
 *
 * 改造点：
 * - D7-②（dual-track convergence）：同构骨架（缓存对/唯一写点/三 handler）收敛到
 *   同目录 resource-list-injector.ts 工厂，本文件只保留 agent 侧真差异。
 * - P3：注入段引导语含正向触发引导（何时该 delegate）+ 名字约束（文案见
 *   SUBAGENT_LIST_GUIDE）。
 * - C5①（convergence D-3）：formatAgentList/sortByCodepoint 下沉 core，本文件改调
 *   core barrel（渲染骨架与条目模板逐字节同 pi 旧本地实现——CA2 快照验收前提）；
 *   guide 文案是 pi 宿主注入（core 不内嵌平台文案）。
 * - U11（sink 设计）：装配循环（发现→解析→去重→排序 + warn/error 口径）整体改
 *   消费 core discoverAgents（execution/assembly/agents-assembly，U2/A6）——经工厂 assemble
 *   覆写槽委托，壳侧收缩为「宿主注入根现取 + 委托」，语义等值口径见
 *   agents-assembly.ts 头注（⛔1 探针对照注入 XML diff 为空验收）。
 *
 * 归位原因：injector 是 subagent-workflow 的内聚功能壳——事件接线与数据获取留
 * 在插件层（before_agent_start / modelRegistry），解析/渲染算法消费 core。
 */



import {
	type AgentEntry,
	discoverAgents,
	formatAgentList,
	getHostServices,
} from "@zhushanwen/subagent-core";

import { createResourceListInjector } from "./resource-list-injector.ts";

/**
 * pi 版注入引导文案（C5① guide 参数化——core 渲染函数不内嵌平台文案，宿主注入）。
 *
 * 2026-08 C5 重写依据（pi 现参数面，src/interface/subagent-tool-schema.ts）：
 * 旧句「pass systemPrompt alongside the agent name to create a dynamic agent」
 * 指向的 systemPrompt 参数已不在 subagent tool schema——现 agent 参数 = .md 绝对
 * 路径（<location>），缺省落 general-purpose（继承主 agent 模型与项目上下文），
 * 动态指引经 task 文本 / appendSystemPrompt 参数承载。
 */
export const SUBAGENT_LIST_GUIDE =
	"The following subagents are available. PRIORITY: when a task involves reading 3+ files, writing 100+ lines, parallel research, or specialized review, delegate to a matching subagent FIRST instead of doing it yourself — this keeps your context focused on orchestration. Do NOT call list to discover available subagents; use list only for running state. When using the subagent tool, ONLY use agents from this list — pass the <location> path (absolute .md path) as the agent param. If no agent matches your task, omit agent (a general-purpose agent is used) and put all role-specific instructions in the task text.";

/**
 * agent 清单实例：缓存生命周期 / 三 handler 经工厂骨架；装配循环经 assemble 覆写
 * 委托 core discoverAgents（U11 单源，parse 不参与工厂装配——warn 口径
 * 内聚 core：仅「有 frontmatter 但严格校验未通过」才 warn，README 等无 frontmatter
 * 的 .md 静默跳过）。
 */
const injector = createResourceListInjector<AgentEntry>({
	kind: "agents",
	logTag: "[subagent-list-injector]",
	// agents 段无 invalid 产出面（assemble 路径 invalids 恒空），第二参忽略——
	// 签名对齐工厂 config.format（P5 D4-3 invalid 上报仅 workflow 域接线）。
	format: (agents, _invalids) => formatAgentList(agents, { guide: SUBAGENT_LIST_GUIDE }),
	assemble: (workspaceRoot) =>
		discoverAgents(
			workspaceRoot,
			getHostServices().discoveryRoots?.()?.agents ?? [],
		),
});

/** 注册 session 生命周期 handler，注入 `<available_subagents>` 段（三 handler 语义见工厂）。 */
export const setupSubagentListInjector = injector.setup;
