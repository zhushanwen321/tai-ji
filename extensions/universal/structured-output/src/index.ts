/**
 * Structured Output Extension — 条件激活的 schema 校验工具 + hook
 *
 * 装配分岔（D1，U1）：读 PI_WORKFLOW_SCHEMA——
 *   - 有值（workflow 子进程）：注册 workflow 变体（parameters = 权威 schema 本身，
 *     D4 根级 additionalProperties 注入 / P6 非 object 根 {value} 包装 / 注册期
 *     fail-fast 防御都在 createWorkflowToolDefinition 内）+ 双闸门合一 hook
 *   - 无值（日常 pi）：注册日常变体（双参数自报形态，行为不变，G4）
 *
 * Hook 机制（仅 workflow 模式，D2 单状态机单 listener）：
 *   turn_end 时检查模型是否调用了 structured-output 工具，没调/失败则 steer 注入
 *   重试提醒（软闸门，最多重试 2 次）。同一状态机（WorkflowGate）上的硬杀闸门在
 *   同签名校验失败达 3 次时 terminal：写日志（stderr + session JSONL 双通道，含恢复
 *   指引）后 ctx.abort() + ctx.shutdown() 优雅终止子进程 + 15s 兜底硬退 timer——
 *   terminal 后软闸门不再 steer（同一份 terminal 事实，无跨对象接线；G2 与模型
 *   配合度无关）。装配与 listener 明细见 workflow-hook.setupWorkflowHook。
 *
 * 模块拆分（M4 + D2 合一）：实现体分布于 ajv-validator.ts（编译缓存）/
 * schema-guards.ts（形态守卫）/ execute.ts（校验编排）/ tool-definition.ts（工具定义）/
 * workflow-hook.ts（唯一装配入口 + steer 文案）/ loop-gate.ts（合一状态机 +
 * 错误签名归一化 + terminal 副作用链）。本文件仅剩 entry 装配与 re-export。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { WorkflowGate } from "./loop-gate.js";
import { executeStructuredOutput } from "./execute.js";
import {
	createDailyToolDefinition,
	createWorkflowToolDefinition,
	ENV_SCHEMA,
	SO_SCHEMA_SIZE_WARN_BYTES,
} from "./tool-definition.js";
import { setupWorkflowHook } from "./workflow-hook.js";

/** Pi Extension API — properly typed via ExtensionAPI from pi-coding-agent SDK */
type PiAPI = ExtensionAPI;

// re-export 供测试与外部直接调用（import 路径 ../src/index.js 保持稳定）
export {
	executeStructuredOutput,
	createDailyToolDefinition,
	createWorkflowToolDefinition,
	ENV_SCHEMA,
	SO_SCHEMA_SIZE_WARN_BYTES,
	WorkflowGate,
};

// ── Extension entry ────────────────────────────────────────────

export default function structuredOutputExtension(pi: PiAPI): void {
	const schemaEnv = process.env[ENV_SCHEMA];

	if (schemaEnv) {
		// ── Workflow 模式：单参数工具（注册期 fail-fast 防御）+ 双闸门合一 hook ──
		// D2：软 steer 与硬杀由同一 WorkflowGate 状态机承载（单状态机单 listener），
		// terminal 单字段单写，硬杀不需要向 steer 侧做任何回调同步。
		pi.registerTool(createWorkflowToolDefinition(schemaEnv));
		setupWorkflowHook(pi, schemaEnv);
	} else {
		// ── 日常模式：双参数自报形态（行为不变，G4）──
		pi.registerTool(createDailyToolDefinition());
	}
}
