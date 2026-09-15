/**
 * 生产装配层（W5 集成层）。
 *
 * P3 收口：classifier 的 model 解析改走 llm-shared resolveModel（三源合并含 OAuth/env/auth.json），
 * 废弃自读 models.json。'auto' 由 permission 本地处理：直接取 ctx.modelRegistry.getAvailable()[0]
 * （不经过 llm-shared 的非精确 selector），与下方 createProductionClassifier JSDoc 一致。
 *
 * C1a 收口：classifier 的 LLM 调用改走 llm-shared callLLM（凭证 getApiKeyAndHeaders +
 * completeSimple + stopReason 归一化都在 callLLM 内部完成），删除 getApiProvider +
 * streamSimple（@ts-ignore 随之消除）。
 *
 *  - createProductionClassifier(ctx)：装配 ClassifierDeps（resolveModel 注入走 ctx.modelRegistry，
 *    callLLM 注入闭包捕获 ctx）。
 *  - createPipelineDeps(approvalCtx, ctx)：装配完整 CheckPermissionDeps。
 *
 * 设计：createProductionClassifier 接受 ExtensionContext（model 解析 + 凭证都绑 ctx.modelRegistry），
 * 每次调用创建独立 classifier（无模块级单例——modelRegistry 绑 ctx，单例跨 ctx 不安全，
 * 见 CL-classifier-singleton；createClassifier 是纯对象装配无成本）。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { callLLM, resolveModel as resolveModelShared, type ModelSelector } from "@zhushanwen/pi-llm-shared";

import { type ApprovalContext, requestUserApproval } from "./approval.js";

const logger = getLogger("pi-permission");
import { analyzeBashStructure } from "./ast/index.js";
import { createClassifier } from "./classifier/index.js";
import type { CheckPermissionDeps } from "./pipeline.js";
import { getDefaultRules, matchRulesForArgv } from "./rules/index.js";

// ──────────────────────── toSelector（仅 ref 精确指定） ────────────────────────

/**
 * 把 ClassifierConfig.model 字符串映射为 llm-shared ModelSelector。
 *
 * llm-shared 只支持 ref 精确指定；permission 的 "auto" 在 resolveModel 注入层自行处理，
 * 不通过 ModelSelector 表达。
 */
export function toSelector(modelSpec: string): ModelSelector {
	return { type: "ref", ref: modelSpec };
}

// ──────────────────────── createProductionClassifier ────────────────────────

/**
 * 创建生产环境 AI Classifier。
 *
 * resolveModel 注入：
 *  - config.model === "auto"：直接取 ctx.modelRegistry.getAvailable()[0]（permission 本地
 *    向后兼容行为，不经过 llm-shared 的非精确 selector）。
 *  - 其余：toSelector(config.model) → resolveModelShared(ctx, selector)（仅 ref 精确匹配）。
 *  - model 仍 null → 返回 null（fail-closed）。
 *
 * callLLM 注入（C1a）：闭包捕获 ctx，把 llm-shared callLLM 绑定为 classifier 的 LLM 调用。
 * 凭证获取（getApiKeyAndHeaders）在 callLLM 内部完成（C1a 收口后不再在 resolveModel 层预检）。
 */
export function createProductionClassifier(ctx: ExtensionContext): {
	classifyRisk: ReturnType<typeof createClassifier>["classifyRisk"];
} {
	return createClassifier({
		resolveModel: async (config) => {
			if (config.model === "auto") {
				const available = ctx.modelRegistry.getAvailable();
				return available.length > 0 ? available[0] : null;
			}
			return resolveModelShared(ctx, toSelector(config.model));
		},
		callLLM: (opts) => callLLM(ctx, opts),
		onLog: (msg: string) => logger.warn(msg),
	});
}

// ──────────────────────── createPipelineDeps ────────────────────────

/**
 * 装配生产环境 CheckPermissionDeps。
 *
 * @param approvalCtx 从 ExtensionContext 提取的审批 UI 上下文（mode + ui.*）
 * @param ctx Pi ExtensionContext（model 解析 + 凭证走 ctx.modelRegistry）
 * @returns CheckPermissionDeps（AST + rules + classifier + approval 全部装配真实实现）
 *
 * 注：每次调用创建独立 classifier（CL-classifier-singleton：modelRegistry 绑 ctx，模块级
 * 单例会绑定首调 ctx 对后续 session 不安全；createClassifier 是纯对象装配无成本）。
 * approvalCtx 每次 tool_call 闭包捕获（保证 mode 切换后下次 tool_call 用新 mode）。
 */
export function createPipelineDeps(approvalCtx: ApprovalContext, ctx: ExtensionContext): CheckPermissionDeps {
	return {
		analyzeBashStructure,
		matchRulesForArgv,
		getDefaultRules,
		classifier: createProductionClassifier(ctx),
		isHeadless: () => approvalCtx.mode !== "tui" && approvalCtx.mode !== "rpc",
		requestUserApproval: (req, invokeCtx, signal) => requestUserApproval(req, invokeCtx, signal, approvalCtx),
	};
}
