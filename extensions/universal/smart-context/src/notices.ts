/**
 * 通知注入唯一出口（D4①：四类通知 nextTurn 化）。
 *
 * 四类通知（压缩结果 onComplete / onError、阈值提醒、model_select 跨界与降档两条）从
 * `sendUserMessage(deliverAs:'steer'|'followUp')` 改为 `sendMessage(deliverAs:'nextTurn',
 * triggerTurn:false)`——通知作为 custom role 上下文随下一次 prompt 注入（语义登记
 * docs/pi-semantics.json#PS-06，verifiedWith 以该登记为准：`_pendingNextTurnMessages` 常驻至被消费、不自起 run），结构上消除「通知自起 run 抢占用户
 * 消息投递跑道」——故事 C 根因：压缩完成后通知 run 与用户消息同时 prompt()，后到者被 pi 以
 * `Agent is already processing` 拒绝。
 *
 * 语义定性（设计 D4「C-ext-19 合规定性」四类两分）：
 * - 阈值提醒 / model_select 两条 = **提醒语义**（与 scheduler 2026-09-15 销账先例同类：
 *   提醒不承载必须必达的结果）；
 * - 压缩结果 onComplete / onError = **结果语义**，本改造是**存量域内改判而非新建
 *   at-most-once 通道**：原 steer 通道即 at-most-once 且自起 run，nextTurn 化后必达性
 *   （常驻至被消费）与运行面（不自起 run）同时持平或改善；账本化正向要求的完整迁移维持
 *   pi-boundary-reliability 附录 B 挂账不变（设计 §1.3 Out）。
 *
 * 已接受代价（设计 D4 四要素）：阈值提醒不再于 agent 空闲时立即生效，改为随用户下一条消息
 * 注入——pi 内建 overflow/threshold 自动压缩兜底在场，无人在场时上下文可能持续增长。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 通知的 customType（taiji 侧按此识别 system 消息来源；pi TUI display 恒 true）。 */
export const SMART_CONTEXT_NOTICE_CUSTOM_TYPE = "smart-context";

/** 通知来源（进 details.source，排障定位用）。 */
export type SmartContextNoticeSource =
	| "compact-complete"
	| "compact-failed"
	| "threshold-reminder"
	| "model-switch"
	| "model-downshift";

/**
 * 注入一条 smart-context 通知（nextTurn 车道，不自起 run）。
 *
 * `deliverAs:'nextTurn'` 是投递车道（pi 实装分支序：nextTurn 分支先命中，`triggerTurn`
 * 不再参与判定）；`triggerTurn:false` 是意图的显式声明（双写防未来实现分支序漂移）。
 * `display:true` 使通知在对话流可见——分车道语义（D4①）：compact-result 两条（complete/
 * failed）改造前即 display:true 系统消息，可见性保持；阈值提醒/模型跨界/downshift 三条
 * 改造前 display:false 静默（只进 LLM 上下文，不进对话流），随 nextTurn 车道统一转
 * display:true 可见。
 */
export function sendSmartContextNotice(
	pi: Pick<ExtensionAPI, "sendMessage">,
	text: string,
	source: SmartContextNoticeSource,
): void {
	pi.sendMessage(
		{
			customType: SMART_CONTEXT_NOTICE_CUSTOM_TYPE,
			content: text,
			display: true,
			details: { source },
		},
		{ triggerTurn: false, deliverAs: "nextTurn" },
	);
}
