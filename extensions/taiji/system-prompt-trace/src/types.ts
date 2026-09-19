/**
 * 共享类型、常量与 reason 映射。
 *
 * 留痕 entry 是 custom 类型（不进 LLM context，零模型侧影响，设计 D2），
 * 数据形状见 SystemPromptTraceEntryData。
 */

import { isRecord } from "@zhushanwen/pi-ext-guards";
import type { SessionStartEvent } from "@earendil-works/pi-coding-agent";

/** 留痕 entry 的 customType（taiji: 前缀 = taiji 自定义命名空间）。 */
export const SYSTEM_PROMPT_CUSTOM_TYPE = "taiji:system-prompt";

/**
 * 模式回落事实 env 名（字面量镜像 `packages/shared/src/constants.ts` 的
 * `PRESET_FALLBACK_ENV_KEYS`）。
 *
 * extension 独立发布体系不依赖 `@taiji/shared`，只能按字面量镜像——单侧改名即静默断链
 * （消息见 write 产出的 `presetFallback` 字段消失）。写入方 =
 * `packages/runtime/src/services/session/launch-params.ts` 的 `buildPresetFallbackEnv`。
 */
export const PRESET_FALLBACK_ENV_KEYS = {
	FROM: "TAIJI_PRESET_FALLBACK_FROM",
	TO: "TAIJI_PRESET_FALLBACK_TO",
} as const;

/**
 * 模式回落事实（F1b，设计 `.tmp/tech-design/mode-system-composer-density.md` §7.5 E4
 * 的 trace 披露面）。
 *
 * 语义 = 本次 pi 进程启动时，sidecar 里的模式定义已不可得，runtime 已回落
 * `builtin:full` 启动（工具面从模式的受限面弹回全工具）——记录在 trace entry 里，
 * 事后审计从 `taiji:system-prompt` 即可得知「提示词为何变了」。
 */
export interface PresetFallbackFact {
	/** 原（悬空）模式 id。 */
	from: string;
	/** 回落目标模式 id（现行恒 `builtin:full`）。 */
	to: string;
}

/**
 * 从进程 env 读取模式回落事实（wiring 侧唯一 env 读取点；trace.ts 逻辑经 DI 消费）。
 *
 * - FROM 非空 → 返回 `{ from, to }`（TO 缺失时给空串——形状稳定，不抛错）；
 * - FROM 缺失 / 空串 → undefined（未回落，或未注入；空串是 runtime 的「显式清除」
 *   语义，见 `buildPresetFallbackEnv`）。
 *
 * 不抛错：env 是外部输入，任何形态异常都退化为「无回落事实」，不阻断留痕。
 */
export function readPresetFallbackFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): PresetFallbackFact | undefined {
	const from = env[PRESET_FALLBACK_ENV_KEYS.FROM];
	if (typeof from !== "string" || from === "") return undefined;
	const to = env[PRESET_FALLBACK_ENV_KEYS.TO];
	return { from, to: typeof to === "string" ? to : "" };
}

/** 落盘 reason 枚举（initial/resume/change，对齐 DSH request/header 语义，设计 D2）。 */
export type TraceReason = "initial" | "resume" | "change";

/** appendEntry("taiji:system-prompt", data) 的 data 形状（设计 §5 单元 1）。 */
export interface SystemPromptTraceEntryData {
	/** session 内单调递增（首条 1；有基线时续接基线版本 +1）。 */
	version: number;
	/** sha256(fullText) 十六进制——hash 对比去重与跨重启基线的依据。 */
	hash: string;
	reason: TraceReason;
	/** 完整 system prompt（每条 ~12KB，hash 去重后典型 session 只写 1-3 次，设计 D2 权衡）。 */
	fullText: string;
	/** fullText.length（UTF-16 码元数）。 */
	charCount: number;
	/** 与上一版的行级 diff 摘要；首条留痕（无 parent）时缺省。 */
	parentVersionDiffSummary?: string;
	/**
	 * 模式回落事实（F1b，E4 trace 披露面）：本次 pi 进程以「模式已删除 → 回落
	 * builtin:full」启动时出现；未回落（正常启动）时**字段不出现**——既有 entry
	 * 形状向后兼容。见 `PresetFallbackFact`。
	 */
	presetFallback?: PresetFallbackFact;
}

/** 跨重启恢复的 hash 基线（三档解析统一产自 session JSONL 留痕 entry 直读）。 */
export interface PromptBaseline {
	hash: string;
	version: number;
	/** 留痕 entry 直读恒有值（可生成 diff 摘要）。 */
	fullText?: string;
}

/**
 * session_before_switch → session_start 之间传递的直读基线。
 * 必须是模块级单例对象而非闭包变量：switchSession 会 teardown 并重建 extension runtime
 * （pi agent-session-runtime.ts teardownCurrent → createRuntime 重新调用 factory），
 * 闭包状态不跨 runtime 存活，只有模块缓存（extensions/loader.ts extensionCache）在进程内延续。
 */
export interface SwitchStash {
	pending: PromptBaseline | null;
}

/** 留痕 entry data 的运行时 guard（读 JSONL / 测试断言复用）。 */
export function isSystemPromptTraceEntryData(value: unknown): value is SystemPromptTraceEntryData {
	if (!isRecord(value)) return false;
	const version = value["version"];
	const hash = value["hash"];
	const reason = value["reason"];
	const fullText = value["fullText"];
	const charCount = value["charCount"];
	// 可选字段（F1b）：存在时须为 { from: string, to: string }；缺失合法（向后兼容）
	const presetFallback = value["presetFallback"];
	if (presetFallback !== undefined) {
		if (!isRecord(presetFallback)) return false;
		if (typeof presetFallback["from"] !== "string" || typeof presetFallback["to"] !== "string") return false;
	}
	return (
		typeof version === "number" &&
		Number.isFinite(version) &&
		typeof hash === "string" &&
		(reason === "initial" || reason === "resume" || reason === "change") &&
		typeof fullText === "string" &&
		typeof charCount === "number"
	);
}

/**
 * 无基线时 SessionStartEvent.reason → 落盘 reason 的映射（A11）。
 *
 * - startup / new → initial（新 session 首建快照）
 * - resume → resume（重开快照）
 * - fork / reload → resume（设计 D2 v5 定案）：fork 基线取源文件最后留痕（previousSessionFile，
 *   缺失/未落盘/读取失败 → null 走本映射兜底）；reload 是同 session 的 extension 运行时重建——
 *   两者语义上都是「重开」而非「首建」。
 *
 * 注意：基线恢复且 hash 未变 → 不写（去重）；需写时（hash 已变）恒为 resume，不走本映射
 * （见 trace.ts onTurnStart）。
 */
export function mapReasonForFirstWrite(reason: SessionStartEvent["reason"]): TraceReason {
	switch (reason) {
		case "startup":
		case "new":
			return "initial";
		case "resume":
		case "fork":
		case "reload":
			return "resume";
	}
}
