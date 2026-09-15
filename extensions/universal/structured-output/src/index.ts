/**
 * Structured Output Extension — 条件激活的 schema 校验工具 + hook
 *
 * 装配分岔（D1，U1）：读 PI_WORKFLOW_SCHEMA——
 *   - 有值（workflow 子进程）：注册 workflow 变体（parameters = 权威 schema 本身，
 *     D4 根级 additionalProperties 注入 / P6 非 object 根 {value} 包装 / 注册期
 *     fail-fast 防御都在 createWorkflowToolDefinition 内）+ turn_end 强制 hook
 *   - 无值（日常 pi）：注册日常变体（双参数自报形态，行为不变，G4）
 *
 * Hook 机制（仅 workflow 模式）：
 *   turn_end 时检查模型是否调用了 structured-output 工具。
 *   如果没调 → 通过 pi.sendUserMessage() 注入 steering message 强制调用。
 *   最多重试 2 次，防止无限循环。
 *
 * 失败闸门（仅 workflow 模式，D3/U2）：
 *   tool_execution_end 上计数同签名校验失败，连续 3 次 → terminal：写日志
 *   （stderr + session JSONL 双通道，含恢复指引）后 ctx.abort()（停当前 turn）+
 *   ctx.shutdown() 优雅终止子进程（RPC mode 于 agent_settled 后 exit），并武装
 *   15s 兑底硬退 timer（R3 F-2 bounded teardown：pi 0.84.1 ExtensionAPI 无子进程
 *   信号能力，扩展与子进程同进程，process.exit 是唯一硬杀手段；覆盖 shutdown
 *   请求后 pi 挂死不 settle 的异常态）；同时标记 RetryState.terminal，turn_end
 *   hook 不再 steer。
 *
 * 模块拆分（M4）：实现体分布于 ajv-validator.ts（编译缓存）/
 * schema-guards.ts（形态守卫）/ execute.ts（校验编排）/ tool-definition.ts（工具定义）/
 * workflow-hook.ts（hook + RetryState）/ loop-gate.ts（D3 失败闸门）。
 * 本文件仅剩 entry 装配与 re-export。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { setupLoopGate, LoopGate } from "./loop-gate.js";
import { executeStructuredOutput } from "./execute.js";
import {
	createDailyToolDefinition,
	createWorkflowToolDefinition,
	ENV_SCHEMA,
	SO_SCHEMA_SIZE_WARN_BYTES,
} from "./tool-definition.js";
import { RetryState, setupWorkflowHook } from "./workflow-hook.js";

/** Pi Extension API — properly typed via ExtensionAPI from pi-coding-agent SDK */
type PiAPI = ExtensionAPI;

// re-export 供测试与外部直接调用（import 路径 ../src/index.js 保持稳定）
export {
	executeStructuredOutput,
	createDailyToolDefinition,
	createWorkflowToolDefinition,
	ENV_SCHEMA,
	SO_SCHEMA_SIZE_WARN_BYTES,
	RetryState,
	setupLoopGate,
	LoopGate,
};

// ── Extension entry ────────────────────────────────────────────

export default function structuredOutputExtension(pi: PiAPI): void {
	const schemaEnv = process.env[ENV_SCHEMA];

	if (schemaEnv) {
		// ── Workflow 模式：单参数工具（注册期 fail-fast 防御）+ 强制调用 hook + 失败闸门 ──
		pi.registerTool(createWorkflowToolDefinition(schemaEnv));
		const hookState = setupWorkflowHook(pi, schemaEnv);
		// D3/U2：闸门 terminal（同签名失败 ×3）→ 标记 hook 状态停 steer，写日志后
		// ctx.shutdown() 优雅终止（RPC mode 于 agent_settled 后 exit）。硬闸门在软
		// steer 之上兜底：G2 与模型配合度无关。
		setupLoopGate(pi, { onTerminal: () => hookState.markTerminal() });
	} else {
		// ── 日常模式：双参数自报形态（行为不变，G4）──
		pi.registerTool(createDailyToolDefinition());
	}
}
