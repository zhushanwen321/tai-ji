/**
 * session_before_compact 接管 handler（D1/D11/D12/D13 核心）。
 *
 * 三条压缩路径（agent 工具 / 用户 /compact / 内建 auto）统一经过这里：
 * - 门控未放行 / 熔断 / 生成失败 → 返回空（pi 原生生成兜底，D2/D7）
 * - same-model 模式：完整上下文 + 会话原 system prompt + tools + 末尾追加压缩指令（kv-cache 前缀命中）
 * - cross-model 模式：直接调用包导出的 compact(preparation, 压缩Model, ...)（原生组装零复刻，R4 结论）
 *
 * 输出 CompactionResult.details 携带 {engine:"smart-context", mode, model} 标记（D1 entry 标记）。
 * model = `${model.provider}/${model.id}`（执行压缩的实际模型）——用量页 compaction 归属数据源
 * （usage-page-fixes §3.3 ①）；pi appendCompaction 对 details 逐字透传落盘（pi-semantics PS-28）。
 */

import { buildSessionContext, compact as nativeCompact, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { CompactionResult, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { createLogger } from "@zhushanwen/pi-extension-logger";
import { resolveModel } from "@zhushanwen/pi-llm-shared";
import { readFileSync } from "node:fs";

import { callSameModelCompaction, projectTools } from "./llm.js";
import {
	buildSameModelInstruction,
	buildTranscriptPointer,
	CHECKPOINT_PREAMBLE,
} from "./prompts.js";
import {
	buildReinjectSection,
	collectKeptReadFiles,
	computeFileListsLike,
	estimateShadowedTokens,
	estimateTextTokens,
	formatFileOperationsLike,
	getCurrentModelId,
	isGatingActive,
	isSummaryInflated,
	pickMode,
	pickReinjectFiles,
	type FileOpsLike,
	type SmartContextConfig,
} from "./pure.js";

/** session 级接管状态（session_start 重建闭包，规范 Session 隔离）。 */
export interface TakeoverState {
	/** 接管连续失败计数（D13-3 熔断：≥3 停止接管）。 */
	failStreak: number;
	/** 收缩校验失败已记录的段（firstKeptEntryId 集合，D13-1 同段不重试）。 */
	inflatedSegments: Set<string>;
}

const TAKEOVER_FAILURE_LIMIT = 3;

export function createTakeoverState(): TakeoverState {
	return { failStreak: 0, inflatedSegments: new Set() };
}

/** 统一 logger（@zhushanwen/pi-extension-logger：debug 文件日志 / warn 走 appendEntry 持久化）。 */
const logger = createLogger("smart-context");

/** 开发调试日志（XYZ_AGENT_DEBUG=1 时写文件，默认 no-op；logging-conventions 统一通道）。 */
export function debugLog(message: string): void {
	logger.debug(message);
}

/** 内部降级/失败（事后排查价值，appendEntry 持久化不进 LLM 上下文）。 */
function warnLog(message: string, data?: unknown): void {
	logger.warn(message, data);
}

/** 压缩引擎标记（D1 entry 标记，details 字段直接落 compaction entry）。 */
export interface SmartContextDetails {
	engine: "smart-context";
	mode: "same-model" | "cross-model";
	/** 执行压缩的模型 `${provider}/${modelId}`（用量归属数据源，usage-page-fixes §3.3 ①）。 */
	model: string;
}

/** sessionManager 上会话文件字段/方法的宽松形状（D13-4，消费侧可选链兜底）。 */
interface SessionManagerSessionFileLike {
	getSessionFile?: () => string | undefined;
	sessionFile?: string;
}

/**
 * sessionManager 会话文件访问形状的运行时守卫（D13-4）：
 * 只收窄到对象（字段存在性/类型由消费侧可选链 + ?? 兜底，与原语义一致）。
 */
function isSessionManagerSessionFileLike(sm: unknown): sm is SessionManagerSessionFileLike {
	return typeof sm === "object" && sm !== null;
}

/**
 * session 文件路径（transcript 回查指针用，D13-4）：从 sessionManager 推导。
 * getSessionFile 若不可得则返回空串（指针省略，不失败）。
 */
function getSessionFilePath(ctx: ExtensionContext): string {
	// 经 unknown 再守卫：sessionFile 是 sessionManager 的类型未暴露字段（宽于其声明）
	const sm: unknown = ctx.sessionManager;
	const accessor = isSessionManagerSessionFileLike(sm) ? sm : undefined;
	try {
		return accessor?.getSessionFile?.() ?? accessor?.sessionFile ?? "";
	} catch {
		return "";
	}
}

/** 读文件做重注入（D13-11）：读失败/空内容返回空串（逐文件降级）。 */
function readFileForReinject(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/**
 * 组装 summary 后处理（两模式共用，D13-1/4/9/11 + D11-2）：
 * preamble + 模型摘要 + fileOps 清单 + 文件重注入节 + transcript 指针。
 */
function assembleSummary(
	summaryText: string,
	fileOps: FileOpsLike,
	branchEntries: ReadonlyArray<unknown>,
	firstKeptEntryId: string,
	sessionFilePath: string,
): string {
	const { readFiles, modifiedFiles } = computeFileListsLike(fileOps);
	let summary = `${CHECKPOINT_PREAMBLE}\n\n${summaryText}`;
	summary += formatFileOperationsLike(readFiles, modifiedFiles);

	// D13-11 文件重注入：只读文件取最近 ≤5 个（保留段已有的跳过）
	const keptReads = collectKeptReadFiles(branchEntries, firstKeptEntryId);
	const candidates = pickReinjectFiles(readFiles, keptReads);
	if (candidates.length > 0) {
		const contents = candidates.map((p) => ({ path: p, content: readFileForReinject(p) }));
		summary += buildReinjectSection(contents);
	}

	if (sessionFilePath !== "") {
		summary += buildTranscriptPointer(sessionFilePath);
	}
	return summary;
}

/**
 * same-model 生成（D12）：完整上下文 + 会话原 system prompt + tools + 追加压缩指令。
 * 返回 null = 失败（调用方走 D7 回退）。
 */
async function generateSameMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	event: SessionBeforeCompactEvent,
): Promise<CompactionResult | null> {
	const model = ctx.model;
	if (!model) {
		debugLog("same-mode: no current model");
		return null;
	}
	// AgentMessage[]（含 bash/custom 等扩展消息）→ 标准 Message[]（与主会话请求同源转换，
	// convertToLlm 是 pi host 默认实现——同样的输入产生同样的输出，前缀缓存对齐的前提）
	const fullMessages = convertToLlm(buildSessionContext(event.branchEntries).messages);
	const instructionMessage = {
		role: "user" as const,
		content: [{ type: "text" as const, text: buildSameModelInstruction(event.customInstructions) }],
		timestamp: Date.now(),
	};
	const tools = projectTools(pi.getAllTools());
	const result = await callSameModelCompaction(ctx, {
		model,
		systemPrompt: ctx.getSystemPrompt() ?? "",
		messages: [...fullMessages, instructionMessage],
		tools,
		signal: event.signal,
		sessionId: ctx.sessionManager.getSessionId(),
	});
	if (!result.ok) {
		warnLog("same-mode call failed", { error: result.error });
		return null;
	}
	// D13-2 max-tokens 截断 fail-closed：不完整 checkpoint 不采用
	if (result.stopReason === "length") {
		debugLog("same-mode: summary truncated by max-tokens, rejecting");
		return null;
	}
	if (result.text === "") {
		debugLog("same-mode: empty summary text");
		return null;
	}
	const sessionFile = getSessionFilePath(ctx);
	const summary = assembleSummary(
		result.text,
		event.preparation.fileOps,
		event.branchEntries,
		event.preparation.firstKeptEntryId,
		sessionFile,
	);
	return {
		summary,
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		usage: result.usage as CompactionResult["usage"],
		details: {
			engine: "smart-context",
			mode: "same-model",
			model: `${model.provider}/${model.id}`,
		} satisfies SmartContextDetails,
	};
}

/**
 * cross-model 生成（D12）：调用包导出的原生 compact()，仅替换 model + auth。
 * split-turn 双段合并 / fileOps 追加 / previousSummary 透传全部原生（R4 静态结论，零复刻）。
 * 返回 null = 失败（调用方走 D7 回退）。
 */
async function generateCrossMode(
	ctx: ExtensionContext,
	event: SessionBeforeCompactEvent,
	config: SmartContextConfig,
): Promise<CompactionResult | null> {
	const model = resolveModel(ctx, config.compactModel);
	if (!model) {
		debugLog("cross-mode: compact model not available, falling back");
		return null;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		warnLog("cross-mode auth failed", { error: auth.error });
		return null;
	}
	// ProviderHeaders 值可为 null；nativeCompact 的 headers 参数是 Record<string, string>——
	// 过滤 null 值（运行时清洗而非 cast）
	const headers = auth.headers
		? Object.fromEntries(
			Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		)
		: undefined;
	const result = await nativeCompact(
		event.preparation,
		model,
		auth.apiKey,
		headers,
		event.customInstructions,
		event.signal,
		undefined,
		undefined,
		auth.env,
	);
	// D13-2：原生 compact 内部对截断的处理沿用原生语义；此处补 engine 标记
	return {
		...result,
		details: {
			...(result.details as object | undefined),
			engine: "smart-context",
			mode: "cross-model",
			model: `${model.provider}/${model.id}`,
		} as SmartContextDetails,
	};
}

/**
 * session_before_compact handler 工厂。
 *
 * state 为 session 级闭包（由 src/index.ts 在 session_start 重建后传入）。
 * 返回类型省略标注、由函数体对象字面量推断（{} / {compaction}）——SDK SessionBeforeCompactResult
 * 不在包根导出（仅深层 dist 路径可见），显式标注该名不可 import；推断形状与 SDK 逐字段同形，
 * 注册点 pi.on() 的 ExtensionHandler 泛型按结构兼容校验。
 */
export function createBeforeCompactHandler(
	pi: ExtensionAPI,
	getState: () => TakeoverState,
	loadConfigFn: () => SmartContextConfig,
) {
	return async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		const config = loadConfigFn();
		const currentModelId = getCurrentModelId(ctx.model);

		// D5 门控：禁用/排除 → 空返回（pi 原生生成）
		if (!isGatingActive(config, currentModelId)) return {};
		const state = getState();

		// D13-3 熔断：连续失败 ≥3 → 本 session 停止接管
		if (state.failStreak >= TAKEOVER_FAILURE_LIMIT) {
			debugLog("takeover circuit breaker open, falling back to native");
			return {};
		}
		// D13-1 收缩校验失败段不重试
		if (state.inflatedSegments.has(event.preparation.firstKeptEntryId)) {
			debugLog("segment previously inflated, skipping takeover");
			return {};
		}

		// D12 模式判定（现场热判，切模型/改配置后下次压缩即生效）
		const mode = pickMode(config, currentModelId);

		try {
			const result = mode === "same-model"
				? await generateSameMode(pi, ctx, event)
				: await generateCrossMode(ctx, event, config);

			if (!result) {
				state.failStreak += 1;
				return {}; // D7 回退：pi 原生生成兜底
			}

			// D13-1 收缩校验：摘要 ≥ 被压段 → 拒绝落盘 + 记录该段
			const summaryTokens = estimateTextTokens(result.summary);
			const shadowedTokens = estimateShadowedTokens(event.preparation.messagesToSummarize);
			if (isSummaryInflated(summaryTokens, shadowedTokens)) {
				state.inflatedSegments.add(event.preparation.firstKeptEntryId);
				state.failStreak += 1;
				warnLog("summary inflated, rejecting takeover", { summaryTokens, shadowedTokens });
				return {};
			}

			state.failStreak = 0;
			debugLog(
				`takeover ok: mode=${mode} reason=${event.reason} summaryTokens=${summaryTokens} shadowedTokens=${shadowedTokens}`,
			);
			return { compaction: result };
		} catch (error) {
			state.failStreak += 1;
			warnLog("takeover error, falling back to native", { error: toErrorMessage(error) });
			return {}; // D7 回退
		}
	};
}
