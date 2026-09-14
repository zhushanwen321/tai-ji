/**
 * AI Classifier 主流程（I4 classifyRisk）
 *
 * 流程：resolveModel → 构造 CallLLMOptions → llm-shared callLLM →
 *       检查结果（ok:false → fallback，stopReason 保留日志区分）→ 解析文本 → ClassifierResult。
 * 所有失败路径返回 fail-closed ask。
 *
 * 关键设计：
 *   - 依赖注入 ClassifierDeps（callLLM 注入，便于测试 mock，不直接 import）
 *   - C1a 收口：LLM 调用走 llm-shared callLLM（内部完成凭证 getApiKeyAndHeaders +
 *     completeSimple + stopReason 归一化：error/aborted → {ok:false,
 *     stopReason 透传}），不再走 production.ts 的 streamSimple
 *   - G3 修正（由 callLLM 承接）：completeSimple 的 EventStream.result() 只 resolve 不 reject，
 *     error/aborted 也 resolve（带 stopReason）。callLLM 已把 error/aborted 归一为 ok:false +
 *     stopReason 独立透传；classifier 消费透传字段保留日志区分（abort 与 error 分开记）
 *   - 外层超时/中止兜底保留：防御 provider 不支持 timeoutMs 时 result() 永挂
 *   - fail-closed：timeout / 抛错 / 解析失败 / 无可用模型 → 一律 ask
 */

import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import type { CallLLMOptions, CallLLMResult } from "@zhushanwen/pi-llm-shared";

import type {
	ClassifierConfig,
	ClassifierResult,
	ToolInvocationContext,
} from "../types.js";
import { parseClassifierResponse } from "./json-parser.js";
import { buildClassifierUserPrompt, CLASSIFIER_SYSTEM_PROMPT } from "./prompt.js";

// ──────────────────────── fail-closed fallback ────────────────────────

/** 秒→毫秒换算系数（用于 timeout 字段转 provider 原生 timeoutMs） */
const MILLIS_PER_SECOND = 1000;

/** classifyRisk 所有失败路径的统一 fallback（fail-closed ask） */
const CLASSIFY_FALLBACK_RESULT: ClassifierResult = {
	outcome: "ask",
	risk_level: "medium",
	reasoning: "classifier unavailable",
	confidence: 0,
};

// ──────────────────────── 依赖注入 ────────────────────────

/**
 * Classifier 的外部依赖（DI 便于测试 mock）。
 *
 * - resolveModel（async）：把 ClassifierConfig.model 解析为 Model<Api>（或 null）。
 *   P3 收口后 model 解析走 llm-shared resolveModel（ctx.modelRegistry 三源合并）。
 * - callLLM：llm-shared 的 LLM 调用封装（内部完成凭证 getApiKeyAndHeaders +
 *   completeSimple + stopReason 归一化）。C1a 收口替代原 streamSimple 注入。
 * - onLog：可选日志回调（调试/审计）
 */
export interface ClassifierDeps {
	resolveModel: (config: ClassifierConfig) => Promise<Model<Api> | null>;
	callLLM: (opts: CallLLMOptions) => Promise<CallLLMResult>;
	onLog?: (msg: string) => void;
}

// ──────────────────────── 辅助：构造 messages ────────────────────────

/** 构造单轮 user message（无 transcript），供 callLLM 的 CallLLMOptions.messages 用 */
function buildMessages(ctx: ToolInvocationContext): Message[] {
	return [
		{
			role: "user",
			content: [{ type: "text", text: buildClassifierUserPrompt(ctx) }],
			timestamp: Date.now(),
		},
	];
}

// ──────────────────────── 外层超时（兜底） ────────────────────────

/**
 * 给 callLLM 的 Promise 叠加外层超时（毫秒）+ abort 信号。
 *
 * 防御 provider 不支持 timeoutMs 时 result() 永挂（callLLM 内部直接 await completeSimple，
 * 无自身 race 兜底）。callLLM 已 catch 内部错误返回 ok:false，理论不 reject，但防御性处理。
 */
function raceResultWithDeadline(
	resultPromise: Promise<CallLLMResult>,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<{ kind: "ok"; result: CallLLMResult } | { kind: "timeout" } | { kind: "aborted" }> {
	type Outcome = { kind: "ok"; result: CallLLMResult } | { kind: "timeout" } | { kind: "aborted" };
	const racers: Promise<Outcome>[] = [
		resultPromise.then(
			(result) => ({ kind: "ok" as const, result }),
			(error) => ({
				kind: "ok" as const,
				result: { ok: false as const, error: toErrorMessage(error) },
			}),
		),
	];

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	if (timeoutMs !== undefined && timeoutMs > 0) {
		racers.push(
			new Promise<Outcome>((resolve) => {
				timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
			}),
		);
	}
	if (signal !== undefined) {
		if (signal.aborted) {
			return Promise.resolve({ kind: "aborted" });
		}
		racers.push(
			new Promise<Outcome>((resolve) => {
				signal.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
			}),
		);
	}

	return Promise.race(racers).finally(() => {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
	});
}

// ──────────────────────── classifyRisk 分步 helper ────────────────────────

/**
 * 构造 CallLLMOptions（timeout 秒→毫秒的换算由调用方完成后传入；
 * signal 透传 callLLM → completeSimple，abort 时 reject 或 resolve(aborted)
 * 都会归一为 ok:false）。
 */
function buildCallOptions(
	model: Model<Api>,
	ctx: ToolInvocationContext,
	config: ClassifierConfig,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): CallLLMOptions {
	return {
		model,
		systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
		messages: buildMessages(ctx),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		...(signal !== undefined ? { signal } : {}),
		// thinkingLevel 直接透传（含 "off"）；llm-shared 内部会把 "off" 映射为不传 reasoning（provider 默认）
		reasoning: config.thinkingLevel,
	};
}

/** 记录 LLM 调用失败日志（G3 语义：abort 与 error 分开记，即使行为上两者都 fallback 无差别）。 */
function logFailedCall(
	result: Extract<CallLLMResult, { ok: false }>,
	onLog?: (msg: string) => void,
): void {
	if (result.stopReason === "aborted") {
		onLog?.(`[pi-permission] classifier: LLM call aborted (stopReason=aborted), returning fallback`);
	} else {
		const stopDetail = result.stopReason !== undefined ? ` (stopReason=${result.stopReason})` : "";
		onLog?.(`[pi-permission] classifier: LLM call failed: ${result.error}${stopDetail}, returning fallback`);
	}
}

/** raceWithDeadline 已收窄的结果形态（timeout/aborted 无 result 字段）。 */
type SettledRace =
	| { kind: "ok"; result: CallLLMResult }
	| { kind: "timeout" }
	| { kind: "aborted" };

/** settleRacedResult 的输出：fallback = fail-closed ask；ok = 继续解析文本。 */
type SettledOutcome =
	| { kind: "fallback"; result: ClassifierResult }
	| { kind: "ok"; result: Extract<CallLLMResult, { ok: true }> };

/**
 * race 结果归一：timeout / aborted / ok:false → fail-closed fallback（保留日志区分），
 * 成功原样透传（调用方收窄后取 content）。
 */
function settleRacedResult(settled: SettledRace, timeoutMs: number | undefined, onLog?: (msg: string) => void): SettledOutcome {
	if (settled.kind === "timeout") {
		onLog?.(`[pi-permission] classifier: timed out after ${timeoutMs}ms`);
		return { kind: "fallback", result: { ...CLASSIFY_FALLBACK_RESULT } };
	}
	if (settled.kind === "aborted") {
		onLog?.(`[pi-permission] classifier: aborted by signal`);
		return { kind: "fallback", result: { ...CLASSIFY_FALLBACK_RESULT } };
	}

	// ok:false → fallback（fail-closed）。stopReason 独立透传字段保留日志区分
	const result = settled.result;
	if (!result.ok) {
		logFailedCall(result, onLog);
		return { kind: "fallback", result: { ...CLASSIFY_FALLBACK_RESULT } };
	}
	return { kind: "ok", result };
}

// ──────────────────────── createClassifier ────────────────────────

/**
 * 创建 classifier 实例（工厂，注入 deps）。
 *
 * 返回 classifyRisk 主函数。
 */
export function createClassifier(deps: ClassifierDeps): {
	classifyRisk: (ctx: ToolInvocationContext, config: ClassifierConfig, signal?: AbortSignal) => Promise<ClassifierResult>;
} {
	const { resolveModel, callLLM, onLog } = deps;

	async function classifyRisk(
		ctx: ToolInvocationContext,
		config: ClassifierConfig,
		signal?: AbortSignal,
	): Promise<ClassifierResult> {
		// 1. 解析模型（llm-shared resolveModel：scoped/ref/available，走 ctx.modelRegistry）；
		//    无可用模型 → fail-closed
		const model = await resolveModel(config);
		if (model === null) {
			onLog?.("[pi-permission] classifier: no model resolved, returning fallback");
			return { ...CLASSIFY_FALLBACK_RESULT };
		}

		// A1 同类成功路径日志（R2 验收前提）：LLM 调用前记录解析到的 model id，
		// 实证 classifier 真实用到 OAuth/配置的模型（而非 fail-closed 降级）。
		onLog?.(`[pi-permission] classifier: using model ${model.id}`);

		// 2. 构造 CallLLMOptions
		const timeoutMs = config.timeout > 0 ? config.timeout * MILLIS_PER_SECOND : undefined;
		const callPromise = callLLM(buildCallOptions(model, ctx, config, timeoutMs, signal));

		// 3. 等待 callLLM + 外层超时/中止兜底（provider 不支持 timeoutMs/signal 时防永挂）
		let settled: SettledRace;
		try {
			settled = await raceResultWithDeadline(callPromise, timeoutMs, signal);
		} catch (error) {
			const message = toErrorMessage(error);
			onLog?.(`[pi-permission] classifier: callLLM race threw: ${message}`);
			return { ...CLASSIFY_FALLBACK_RESULT };
		}

		// 4. timeout / aborted / ok:false → fail-closed fallback；成功 → 收窄透传
		const settledOutcome = settleRacedResult(settled, timeoutMs, onLog);
		if (settledOutcome.kind === "fallback") {
			return settledOutcome.result;
		}

		// 5. 提取文本 → 三层容错解析
		return parseClassifierResponse(settledOutcome.result.content);
	}

	return { classifyRisk };
}
