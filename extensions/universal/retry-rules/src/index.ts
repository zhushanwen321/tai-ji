/**
 * Retryable Error Rules Extension（subagent-observability §3.3.12 / W6，探针实证路径一）。
 *
 * 机制：pi 无「重试决策」extension 钩子（auto_retry 是 session 内部事件，不进 extension
 * 事件族），但 `message_end` 官方钩子可原地替换已定稿消息（MessageEndEventResult.message，
 * types.d.ts:1078-1081「replacement must keep the original message role」）。本扩展对
 * stopReason=error 的 assistant 消息按重试规则判定，命中 retryable 规则时在 errorMessage
 * 末尾追加 `[taiji-retry:` 锚标记（追加式非替换式——原文完整保留，pi 会话记录持久化形态
 * 无信息丢失），使 pi-ai 的 isRetryableAssistantError 原生词表命中（`rate.?limit`/`429`/
 * `too many requests`），从而触发 pi 原生重试全链路（auto_retry 事件族 + 指数退避 + 失败
 * 尝试从模型上下文剔除，探针双组对照实证：改写组全链路触发、对照组直接终局）。
 *
 * 判定管线两层序与双匹配通道见 rules.ts（SSOT = packages/shared/src/retry-rules.ts）；
 * 配置热重载见 config.ts（mtime+size 读时刷新，下一轮判定即生效）。
 *
 * 停用通道：无独立开关——停用复用 pi 原生 retry 配置（enabled=false / maxRetries=0），
 * pi 重试决策点在 errorMessage 词表判定之前先检查该门（agent-session.js:787 实装核实），
 * 停用后改写不触发任何重试，自然回落失败如实分类（档 A）。
 *
 * 接线：mandatory-extensions.json 登 infrastructure（structured-output 同链）——infrastructure
 * 包恒载进主进程与孙进程扩展白名单（pi-host resolveGrandchildExtensionPaths argv 通道），
 * 零新增接线机制。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadRetryRulesConfig } from "./config.js";
import { appendRetryMarker, evaluateRetryRules } from "./rules.js";

type PiAPI = ExtensionAPI;

/** message_end 事件中本扩展消费的消息字段面（AgentMessage 判定所需的窄视图）。 */
interface AssistantErrorMessage { // oe-exempt:20261024:test:message_end 改写入参的结构化窄面（pi 消息子集），单消费点 rewriteMessageForRetry；真实第二变体 = pi 消息形态演化，暂内联
	role: string;
	stopReason?: string;
	errorMessage?: string;
}

// re-export 供测试与外部直接调用（import 路径 ../src/index.js 保持稳定）
export { appendRetryMarker, evaluateRetryRules } from "./rules.js";
export {
	DEFAULT_RETRY_RULES_EXT_CONFIG,
	isDangerousRetryPattern,
	loadRetryRulesConfig,
	validateRetryRuleFields,
} from "./config.js";

/**
 * 对单条已定稿消息执行重试判定；命中 retryable 规则返回改写消息（追加标记），否则 undefined。
 * 泛型守恒：入参 T 透传到返回 message（spread + errorMessage 覆盖，其余字段原样）——
 * 钩子处传入 pi 的 AgentMessage 即返回 AgentMessage 形态（MessageEndEventResult 契约：
 * replacement 须保持原消息 role），独立导出（纯函数形态）供单测覆盖。
 */
export function rewriteMessageForRetry<T extends AssistantErrorMessage>(message: T): { message: T } | undefined {
	if (message.role !== "assistant" || message.stopReason !== "error") return undefined;
	if (typeof message.errorMessage !== "string" || message.errorMessage === "") return undefined;
	const config = loadRetryRulesConfig();
	const decision = evaluateRetryRules(message.errorMessage, config.effectiveRules);
	if (decision.action !== "rewrite") return undefined;
	return { message: { ...message, errorMessage: appendRetryMarker(message.errorMessage) } };
}

// ── Extension entry ────────────────────────────────────────────

export default function retryRulesExtension(pi: PiAPI): void {
	pi.on("message_end", (event) => {
		return rewriteMessageForRetry(event.message);
	});
}
