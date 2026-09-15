/**
 * cw-tool extension — 把 `cw` CLI 的只读命令面包成单个 pi 工具（cw_query）。
 *
 * cw 2.0 适配（Phase 2-B）：1.x 的 4 个 role-restricted 工具（cw_planning / cw_wave /
 * cw_dev / cw_review）与 5 个编排 agent 随 1.x 命令面退役——cw 2.0 把编排智能收进
 * 引擎（`cw run` runner 派 designer/developer/独立 reviewer + 账本 gate 强校验），
 * 「层主不能自审」由账本层硬保证（review submit 必须 --role reviewer），不再需要
 * 工具白名单承载。保留的薄层价值：给「agent 查 cw 状态」一个结构化工具入口——
 * 只读 action 物理不可越权（写命令不在工具面），参数面按 2.0 修正（--unit / --root /
 * --json）。runner 用法教学归 cw-cli skill（SSOT），本包 skill（pi-cw）只做 pi 环境的
 * runner 实操指南。
 *
 * 本文件只做工具注册（schema + execute 适配）；核心逻辑在 cw-runner.ts，spawn 抽象
 * 在 cw-spawn.ts。cw 引擎改动不在此处理。
 */
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

import { type CwSpawner, defaultCwSpawner } from "./cw-spawn.ts";
import { type CwDetails, type CwToolOptions, CW_ACTIONS, executeCwAction } from "./cw-runner.ts";

/** cw_query：cw 2.0 只读查询透传。写命令经 bash 调 cw（用法见 cw-cli skill）。 */
const TOOL_NAME = "cw_query";

// ── 工具构造 ────────────────────────────────────────────────────

/**
 * 构造 cw_query 工具。execute 内联闭包适配 SDK 全签名（toolCallId/params/signal/
 * onUpdate/ctx），转调纯逻辑 executeCwAction（白名单 + 参数校验 + spawn + 解析）。
 *
 * 错误经 execute 返回（details.ok=false + content 文本），不抛异常。
 */
function buildQueryTool(spawner: CwSpawner): ToolDefinition<typeof parameters, CwDetails> {
	const parameters = Type.Object({
		action: StringEnum(CW_ACTIONS, {
			description:
				"要执行的 cw 只读查询。写命令（create / evidence submit / review submit / verify / run）不在本工具面，经 bash 调 cw，用法见 cw-cli skill。",
		}),
		unitId: Type.Optional(
			Type.String({
				description:
					"unit id → --unit。仅 status（单 unit 详情）与 report（单 unit 证据链）支持；省略 = 全局视图。与 rootId 互斥。",
			}),
		),
		rootId: Type.Optional(
			Type.String({
				description:
					"子树根 unit id → --root。仅 report（子树汇总）支持。与 unitId 互斥。",
			}),
		),
		json: Type.Optional(
			Type.Boolean({
				description:
					"结构化输出 → --json。仅 status / frontier 支持（cw 2.0 规格锁定）；tree / report 为人可读视图。",
			}),
		),
	});
	type Params = Static<typeof parameters>;

	return {
		name: TOOL_NAME,
		label: "CW Query",
		description: `查询 cw 编码流程状态（只读透传 cw 2.0）。

允许的 action：
- status：单元状态。无 unitId = 每 unit 一行概览；带 unitId = 单 unit 详情（spec hash / verdicts / verifyRuns）。
- frontier：就绪集合（按维度分组的可推进节点，含转人工出口）。
- tree：分解树（parentId 缩进渲染）。
- report：证据链汇总。unitId 单 unit / rootId 子树 / 均省略 = 全账本。

参数：action / unitId（→ --unit，仅 status・report）/ rootId（→ --root，仅 report，与 unitId 互斥）/ json（→ --json，仅 status・frontier）。

本工具只读——推进流程（建 unit、交证据、跑 runner）经 bash 调 cw 命令，用法以 cw-cli skill 为权威源。返回 details.ok 区分成功/失败；成功时 details.stdout 为 cw 原始输出，stdout 可解析为 JSON 时 details.data 为解析结果。`,
		executionMode: "sequential",
		parameters,
		async execute(
			_toolCallId: string,
			params: Params,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<CwDetails> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<CwDetails>> {
			if (signal?.aborted) {
				const aborted: CwDetails = {
					ok: false,
					action: params.action,
					error: "aborted by signal",
				};
				return { content: [{ type: "text", text: `[${TOOL_NAME}] aborted` }], details: aborted };
			}

			const opts: CwToolOptions = {
				unitId: params.unitId,
				rootId: params.rootId,
				json: params.json,
			};

			const details = await executeCwAction(
				params.action,
				CW_ACTIONS,
				TOOL_NAME,
				opts,
				spawner,
				ctx.cwd,
				signal,
			);

			const text = details.ok
				? details.stdout
				: `[${TOOL_NAME}] ${params.action} 失败: ${details.error}`;
			return { content: [{ type: "text", text }], details };
		},
	};
}

// ── 扩展入口 ────────────────────────────────────────────────────

/**
 * cw-tool extension 工厂。注册 cw_query（只读查询工具）。
 *
 * 无状态（cw 状态在 cw 引擎内，本扩展不持有 session 级状态），无需 session_start 重建。
 */
export default function cwToolExtension(pi: ExtensionAPI): void {
	pi.registerTool(buildQueryTool(defaultCwSpawner));
}

// ── 导出（npm 外部 API 面）──────────────────────────────────

export { executeCwAction, buildCwArgs, rejectDisallowedAction, rejectInvalidQueryOptions } from "./cw-runner.ts";
export type { CwAction, CwDetails, CwToolOptions } from "./cw-runner.ts";
export type { CwSpawner, CwSpawnResult } from "./cw-spawn.ts";
export { defaultCwSpawner } from "./cw-spawn.ts";
export { buildQueryTool, CW_ACTIONS, TOOL_NAME };
