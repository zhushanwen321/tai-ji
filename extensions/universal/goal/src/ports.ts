/**
 * Ports — 能力抽象接口
 *
 * D-22: ports 的核心价值是机器可检查的边界（engine/ 禁止 import Pi），
 * 不是"可替换的 adapter"。service 层通过这些接口访问 Pi 能力，
 * adapter 层提供实现（包装 ctx / pi）。
 */

import type { DualWidgetContent } from "@xyz-agent/extension-protocol";

import type { GoalRuntimeState } from "./engine/types";

// ── GoalHistoryEntry（DTO，非 aggregate，D-09）─────────

export interface GoalHistoryEntry {
	goalId: string;
	objective: string;
	/** 成功标准（与 objective 成对存档）。结构化为 string[]。旧 entry 无此字段，向后兼容。 */
	successCriteria?: string[];
	/** widget/history 标题用（fallback objective 截断）。旧 entry 无此字段。 */
	slug?: string;
	status: string;
	elapsedSeconds: number;
	timestamp: number;
}

// ── PersistencePort ──────────────────────────────────

export interface PersistencePort {
	/**
	 * 写入 goal-state entry。无 GC：session entries append-only，每次追加完整 snapshot，
	 * 不轮转、不删旧 entry（重建时只读最新一条，旧 entry 留存）。
	 */
	appendState(state: GoalRuntimeState): void;
	/** 写入 goal-history 归档 entry */
	appendHistory(entry: GoalHistoryEntry): void;
}

// ── ThemeLike ────────────────────────────────────────

/**
 * projection 层的 Theme 抽象。不 import Pi 的 ThemeColor。
 * adapter 层负责把 Pi 的 theme（fg 接收 ThemeColor）适配到此签名（fg 接收 string）。
 */
export interface ThemeLike {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

// ── UiPort ───────────────────────────────────────────

export interface UiPort {
	/**
	 * 设置 widget（双模单调用）。content = { gui, text } 双模 payload / undefined 清除；
	 * 模式分派（RPC→gui 经 marker 通道 / TUI→text 原生文本行）由 protocol setWidgetDual
	 * 单点内化（守卫单点化说明见 extension-protocol core/helpers.ts，adapter 委托 helper）。
	 * hasUI 守卫留在调用方（FR-6.6）。
	 */
	setWidget(name: string, content: DualWidgetContent | undefined): void;
	/** 设置 status bar */
	setStatus(name: string, text: string | undefined): void;
	/** 弹通知 */
	notify(text: string, level: "info" | "warning" | "error"): void;
	/** 是否有 UI（headless 为 false） */
	readonly hasUI: boolean;
	/** 终端主题能力（fg/bold 着色），widget/status 文本行渲染消费（E3 显式声明） */
	readonly theme: ThemeLike;
}

// ── MessagingPort ────────────────────────────────────

export interface MessagingPort {
	/** 发送 custom message（goal-context 等） */
	sendContextMessage(content: string, deliverAs: "steer" | "followUp", customType?: string): void;
	/** 发送 user message（触发 AI 开始工作，FR-8.12） */
	sendUserMessage(content: string, deliverAs: "steer" | "followUp"): void;
}

// ── SessionPort ──────────────────────────────────────

export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface SessionPort {
	getEntries(): SessionEntryLike[];
}
