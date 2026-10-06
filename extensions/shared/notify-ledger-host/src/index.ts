// src/index.ts — pi 扩展侧 NotifyLedgerHost 适配器工厂（shared 库，非 pi extension）。
//
// 职责单一：把 pi 扩展运行时（ExtensionAPI/ExtensionContext）的五个端口接线成
// @zhushanwen/subagent-core 的 NotifyLedgerHost（notify-once 账本的宿主端口，接口
// 权威源在 subagent-core src/execution/notify/notify-ledger.ts）。此前 subagent-workflow
//（session-lifecycle.ts）与 session-manager（notify-ledger.ts）各持一份同构 host 字面量
//（同一槽的两处装配方，host 接口一致才能互换消费）——本工厂收敛该机制的单点实现，
// 两包按各自 component/logger 参数化装配，行为逐字段等价。
//
// 依赖方向：本包是「知 pi 又知 subagent-core」的适配层——subagent-core 刻意零 pi
// 依赖（跨宿主 core），pi→host 的适配只能住在 extension 层共享库（本包）。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { guardStaleCtx, toErrorMessage } from "@zhushanwen/pi-ext-guards";
import type { NotifyLedgerHost } from "@zhushanwen/subagent-core";

/**
 * stale 降级 warn 通道的最小结构面（@zhushanwen/pi-extension-logger 的
 * ExtensionLogger 结构性满足；收敛为本地窄口避免为 logger 类型引入依赖）。
 */
export interface NotifyLedgerHostLogger { // oe-exempt:20260930:framework:SDK 包的 logger 端口契约（消费方注入，结构化端口先立）
	warn(msg: string, data?: unknown): void;
}

/** 工厂选项：两装配方（subagent-workflow / session-manager）的观测差异参数化。 */
export interface CreatePiNotifyLedgerHostOptions { // oe-exempt:20260930:framework:SDK 工厂参数契约——两消费包以不同 options 实例化
	/**
	 * guardStaleCtx 观测标签的组件前缀：label = `${component}:sendDelivery`
	 *（建议 "包目录名:场景" 形态，对齐 ext-guards GuardStaleCtxOptions.label 约定）。
	 */
	component: string;
	/**
	 * stale 降级 warn 走调用方组件 logger（日志通道 / appendEntry 留痕归因随
	 * 调用方不变——工厂不自带 logger，防归因串包）。
	 */
	logger: NotifyLedgerHostLogger;
	/**
	 * stale warn 消息前缀（缺省 ""）。调用方既有文案带组件前缀的传对应形态
	 *（如 "[session-manager] "），无前缀的省略——warn 文案逐字节保持装配前形态。
	 */
	staleWarnPrefix?: string;
}

/**
 * 装配 pi 扩展侧的 NotifyLedgerHost（五个端口的原样接线 + 送达 stale 防御）。
 *
 * 送达语义（两装配方共用的既有设计，收敛于此为单一权威注释）：
 * - **单通道送达（D5）**：sendDelivery 唯一形态 = `pi.sendMessage(message,
 *   { triggerTurn: true })`（唤醒主 agent turn）；courier 已在发送前二次复查
 *   isIdle，多通道投递选项已删。
 * - **stale ctx 防御**：delivery 经 settled 边沿 / 恢复重放异步触发，
 *   可能落在 session 替换窗口——触碰 stale pi 命中 assertActive（PS-30）即无人
 *   接 rejection。stale 静默降级（本条通知不投递，attemptDeliver 按已受理标
 *   sentAt——session 替换后通知对旧 session 已无意义）+ warn 归因；非 stale
 *   错误原样上抛，由 ledger attemptDeliver 既有 catch 走 settleRejected 留账
 *   重试语义。
 */
export function createPiNotifyLedgerHost(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: CreatePiNotifyLedgerHostOptions,
): NotifyLedgerHost {
	const prefix = options.staleWarnPrefix ?? "";
	/** 两送达口的同形守卫包裹（label / stale 文案 / 发送体三处差异参数化）。 */
	const guardedSend = (label: string, staleMessage: string, send: () => void): void => {
		guardStaleCtx(send, {
			label: `${options.component}:${label}`,
			onStale: (error) => options.logger.warn(`${prefix}${staleMessage}`, { error: toErrorMessage(error) }),
		});
	};
	const host: NotifyLedgerHost = {
		appendLedgerEntry: (customType, data) => {
			pi.appendEntry(customType, data);
		},
		readSessionEntries: () => ctx.sessionManager.getEntries(),
		isIdle: () => ctx.isIdle(),
		onAgentSettled: (handler) => {
			pi.on("agent_settled", handler);
		},
		sendDelivery: (message) =>
			guardedSend("sendDelivery", "notify delivery skipped (stale ctx)", () =>
				pi.sendMessage(message, { triggerTurn: true }),
			),
	};
	return host;
}
