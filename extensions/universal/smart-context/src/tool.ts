/**
 * compact_context 工具（D6 + §3.5 接口契约）。
 *
 * execute 流程：门控校验（D5 拒绝态）→ 阈值保护（D6）→ ctx.compact() fire-and-forget
 * （R2 实测 2026-08-22：tool execute 内 await ctx.compact() 不可行——AgentSession.compact
 * 开头的 abort() 会中止当前 agent 循环，挂起的 Promise 永不兑现、session 无 toolResult。
 * 故走 §3.2 降级态：execute 立即返回"压缩已启动"，onComplete/onError 后经
 * pi.sendUserMessage 注入结果消息——此时无进行中回合，abort 为 no-op）。
 * 压缩生成由 session_before_compact 接管 handler 完成（工具只触发，不生成）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { guardStaleCtx, isRecord, toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { Type } from "typebox";

import { debugLog } from "./compact-handler.js";
import { buildDegradationHintLine } from "./reminder.js";
import {
	DEGRADATION_HINT_MIN_COMPACTIONS,
	checkToolThresholdGuard,
	countCompactions,
	formatK,
	getCurrentModelId,
	isGatingActive,
	loadSmartContextConfig,
	pickMode,
	type EntryLike,
} from "./pure.js";

/** 工具参数 schema（顶层 Type.Object，OpenAI 兼容红线）。 */
const CompactContextParams = Type.Object(
	{
		custom_instructions: Type.Optional(
			Type.String({
				description:
					"给摘要生成器的指引：哪些信息必须在摘要中保留（如文件修改意图、关键决策、验证结果），哪些可以丢弃（如中间调试过程）",
			}),
		),
	},
	{ additionalProperties: false },
);

/** CompactionResult 的宽松形状（onComplete 回调参数消费字段）。 */
interface CompactionResultLike {
	tokensBefore?: number;
	estimatedTokensAfter?: number;
	usage?: { input?: number; output?: number; cacheRead?: number };
	details?: { engine?: string; mode?: string } & Record<string, unknown>;
}

/** 工具 details（renderResult 数据源，规范：不依赖 content 文本解析）。R2 降级态：启动即返回。 */
export interface CompactContextDetails {
	/** 启动时的模式判定（cross-model 时为配置的压缩模型 ref）。 */
	mode: string;
	compactModel: string;
	compactionCount: number;
	/** 压缩已触发（结果经注入消息送达，不在工具结果里）。 */
	launched: boolean;
	fellBack: boolean;
}

/** 工具描述（§3.5：三条件自查引导）。 */
const TOOL_DESCRIPTION =
	"压缩当前会话上下文（释放早期对话占用的 token；压缩由配置的模型执行，不会切换你的主模型）。" +
	"仅在同时满足以下条件时调用：1) 当前任务的一个阶段已完成并验证（如一批文件改完、测试通过）；" +
	"2) 后续工作不再依赖将被压缩的早期细节；3) 上下文已超过提醒阈值（你会收到 [smart-context 提示]）。" +
	"若任一条件不满足，不要调用。";

/** CompactionResult → 宽松形状的 guard 转换（onComplete 回调参数消费，避免 cast）。 */
function toCompactionResultLike(result: unknown): CompactionResultLike {
	const r: Record<string, unknown> = isRecord(result) ? result : {};
	const usage = isRecord(r.usage) ? r.usage : null;
	const details = isRecord(r.details) ? r.details : null;
	const num = (v: unknown) => (typeof v === "number" ? v : undefined);
	const str = (v: unknown) => (typeof v === "string" ? v : undefined);
	return {
		tokensBefore: num(r.tokensBefore),
		estimatedTokensAfter: num(r.estimatedTokensAfter),
		usage: usage
			? {
				input: num(usage.input),
				output: num(usage.output),
				cacheRead: num(usage.cacheRead),
			}
			: undefined,
		details: details
			? {
				engine: str(details.engine),
				mode: str(details.mode),
			}
			: undefined,
	};
}

/**
 * 注册 compact_context 工具。
 *
 * gatingProbe/usageProbe 为依赖注入（单测 mock 点）：
 * - gatingProbe(ctx) → { active, modelId }（生产实现：现场读配置判定）
 * - usageProbe(ctx) → { tokens, contextWindow }（生产实现：ctx.getContextUsage()）
 */
export function registerCompactContextTool(
	pi: ExtensionAPI,
	deps?: {
		gatingProbe?: (ctx: ExtensionContext) => { active: boolean; modelId: string };
		usageProbe?: (ctx: ExtensionContext) => { tokens: number | null; contextWindow: number };
		getEntries?: (ctx: ExtensionContext) => ReadonlyArray<EntryLike>;
		/**
		 * G1 代际检测（crash-resilience D1）：compact 是 fire-and-forget——onComplete/onError
		 * 回调在压缩 LLM 调用期间异步触发，用户此间切换/重载 session 后回调持有的 pi 已
		 * stale（E1 实锤崩溃点）。index.ts 注入模块级代数比对闭包，前置检查 + 错误分诊
		 * 双保险；缺省时守卫退化为纯文案兜底分诊（PS-30 门禁守文案）。
		 */
		isCtxStale?: () => boolean;
	},
): void {
	const probeGating =
		deps?.gatingProbe ??
		((ctx: ExtensionContext) => {
			const config = loadSmartContextConfig();
			const modelId = getCurrentModelId(ctx.model);
			return { active: isGatingActive(config, modelId), modelId };
		});
	const probeUsage =
		deps?.usageProbe ??
		((ctx: ExtensionContext) => {
			const usage = ctx.getContextUsage();
			return {
				tokens: usage?.tokens ?? null,
				contextWindow: usage?.contextWindow ?? 0,
			};
		});
	const getEntries =
		deps?.getEntries ??
		((ctx: ExtensionContext) => ctx.sessionManager.getEntries() as ReadonlyArray<EntryLike>);

	pi.registerTool({
		name: "compact_context",
		label: "compact_context",
		description: TOOL_DESCRIPTION,
		parameters: CompactContextParams,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			// D5 门控现场校验（配置热改即时生效，不依赖注册时机）
			const gating = probeGating(ctx);
			const config = loadSmartContextConfig();
			if (!gating.active) {
				const reason = config.enabled
					? `当前模型 ${gating.modelId} 已配置为排除（smart-context excludedModels），压缩工具不可用。可在 xyz-agent 设置页或 smart-context-ext-config skill 中调整。`
					: `smart-context 已禁用。可在 xyz-agent 设置页开启，或经 smart-context-ext-config skill 修改配置。`;
				throw new Error(reason);
			}

			// D6 阈值保护（含 null 分支）
			const usage = probeUsage(ctx);
			const guardMessage = checkToolThresholdGuard(config.reminderThresholds, usage.tokens);
			if (guardMessage !== null) {
				throw new Error(guardMessage);
			}

			const compactionCount = countCompactions(getEntries(ctx));

			// R2 降级态：fire-and-forget。工具立即返回"已启动"；压缩完成后（此时无进行中
			// 回合，compact 内部的 abort 为 no-op）经 sendUserMessage 注入结果（steer：
			// 下一个 LLM 调用前投递，agent 立即看到结果）
			const mode = pickMode(config, gating.modelId);
			ctx.compact({
				customInstructions:
					typeof params.custom_instructions === "string" && params.custom_instructions.trim() !== ""
						? params.custom_instructions
						: undefined,
				// E1 实锤崩溃点（9/3 pi-crash log）：两个回调由 compact 的内部 Promise 链异步
				// 调用，不在 pi runner emit() 的 try/catch 内——session 替换窗口（GUI 切
				// session/新建/重载高频触发）下 pi.sendUserMessage 命中 stale ctx 同步抛错即
				// 杀死 pi 进程。守卫 stale 静默降级（结果不投递，用户可重试 /compact），非
				// stale 错误原样上抛（守卫不吞真实 bug）。
				onComplete: (r: unknown) => {
					guardStaleCtx(() => {
						const result = toCompactionResultLike(r);
						const resultMode = result.details?.mode ?? "native-fallback";
						const fellBack = resultMode === "native-fallback";
						if (fellBack) debugLog("compact_context: takeover fell back to native generation");
						const cacheRead = result.usage?.cacheRead;
						const cost = result.usage
							? `${formatK(result.usage.input ?? 0)} input${cacheRead ? `（其中缓存命中 ${formatK(cacheRead)}）` : ""} + ${formatK(result.usage.output ?? 0)} output`
							: "未知";
						const showHint = compactionCount + 1 >= DEGRADATION_HINT_MIN_COMPACTIONS;
						const lines = [
							`[smart-context] 压缩完成。模式：${resultMode}${fellBack ? "（压缩模型不可用，已回退当前模型——请检查配置：xyz-agent 设置页或 smart-context-ext-config skill）" : ""}。`,
							`压缩前 ${formatK(result.tokensBefore ?? 0)} tokens → 压缩后约 ${formatK(result.estimatedTokensAfter ?? 0)} tokens；摘要生成成本：${cost}。`,
							showHint ? buildDegradationHintLine() : "",
						].filter((l) => l !== "");
						pi.sendUserMessage(lines.join("\n"), { deliverAs: "steer" });
					}, {
						isCtxStale: deps?.isCtxStale,
						label: "smart-context:compact-onComplete",
						onStale: (error) => debugLog(`compact result delivery skipped (stale ctx): ${toErrorMessage(error)}`),
					});
				},
				onError: (err: Error) => {
					// 压缩本身的失败信息先落日志（守卫体外——stale 降级时该观测保留）
					debugLog(`compact_context error: ${err.message}`);
					guardStaleCtx(() => {
						pi.sendUserMessage(
							`[smart-context] 压缩失败：${err.message}。上下文未变化，可稍后重试（若反复失败，检查 smart-context 配置或使用 /compact）。`,
							{ deliverAs: "steer" },
						);
					}, {
						isCtxStale: deps?.isCtxStale,
						label: "smart-context:compact-onError",
						onStale: (error) => debugLog(`compact failure notice delivery skipped (stale ctx): ${toErrorMessage(error)}`),
					});
				},
			});

			return {
				content: [
					{
						type: "text",
						text: `压缩已启动（${mode === "same-model" ? "same-model 模式，KV 缓存优化" : `cross-model 模式，使用 ${config.compactModel.ref}`}）。压缩完成后你会收到一条结果消息；期间可以继续其他工作，但引用早期上下文的操作请等结果消息到达。`,
					},
				],
				details: {
					mode,
					compactModel: mode === "cross-model" ? config.compactModel.ref : gating.modelId,
					fellBack: false,
					compactionCount: compactionCount + 1,
					launched: true,
				} satisfies CompactContextDetails,
			};
		},
	});
}
