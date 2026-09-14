/**
 * Ports 桥接 — Pi → ServicePorts 适配（adapters 层）
 *
 * 单一 ports 构造点（DRY）：command-adapter / goal-control-adapter / event-handlers / index 共用。
 *
 * - persistence: pi.appendEntry 映射到 appendState / appendHistory（type 字符串区分）
 * - ui: ctx.ui 的 setWidget/setStatus/notify + hasUI + theme（fg/bold 适配 ThemeLike）
 * - messaging: pi.sendMessage 映射到 sendContextMessage / sendUserMessage
 * - session: ctx.sessionManager.getEntries
 *
 * port/ctx 双通道惯例：port 对象仅用于传入 service/session 的实参；
 * handler 自用的 UI/日志直呼 ctx（如 ctx.ui.notify、ctx.ui.setWidget）。
 */

import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { setWidgetDual } from "@xyz-agent/extension-protocol";
import type { GuiContext } from "@xyz-agent/extension-protocol";

import { ENTRY_TYPE, HISTORY_ENTRY_TYPE } from "../persistence";
import type { MessagingPort, PersistencePort, SessionPort, UiPort } from "../ports";
import type { ServicePorts } from "../service";

/**
 * 把 Pi 的 pi / ctx 适配为 ServicePorts。
 *
 * persistence 的 appendState 用 ENTRY_TYPE，appendHistory 用 HISTORY_ENTRY_TYPE，
 * 与 serializeState / makeHistoryEntry 的输出对齐（session.ts reconstructGoalState 据此识别）。
 */
export function buildPorts(pi: ExtensionAPI, ctx: ExtensionContext): ServicePorts {
	const persistence: PersistencePort = {
		// appendState：每次追加完整 state snapshot（serializeState 输出），无轮转/无上限。
		// entries 无界增长是已知限制——长期 session 持续累积，根治需 persistence 层
		// 轮转/delta 存储（独立工作项，超出本架构修正 wave 范围）。
		appendState: (state): void => {
			pi.appendEntry(ENTRY_TYPE, state);
		},
		appendHistory: (entry): void => {
			pi.appendEntry(HISTORY_ENTRY_TYPE, entry);
		},
	};

	const uiPort: UiPort = {
		setWidget(name, content): void {
			// 双模 payload 委托 protocol setWidgetDual：推送/清屏 × GUI/TUI 的模式分派
			// 由 helper 单点内化（守卫单点化说明见 extension-protocol helpers.ts），
			// 本 adapter 不再自持 isGui 判定/守卫注释。
			//
			// 断言根因：pi ExtensionUIContext.custom 是泛型方法（返回 Promise<T>），
			// 与 GuiContext.ui.custom 的具体返回类型静态不兼容，但 mode/hasUI/ui 其余
			// 成员形状一致（ExtensionMode 与 GuiContext.mode union 完全相同）——
			// 单层直接断言可过 tsc（setWidgetDual 只读 mode 与 ui.setWidget，custom 不参与）。
			setWidgetDual(ctx as GuiContext, name, content);
		},
		setStatus(name: string, text: string | undefined): void {
			ctx.ui.setStatus(name, text);
		},
		notify(text: string, level: "info" | "warning" | "error"): void {
			ctx.ui.notify(text, level);
		},
		get hasUI(): boolean {
			return Boolean(ctx.hasUI);
		},
		// ThemeLike 适配：透传 ctx.ui.theme 的 fg/bold。
		// Theme.fg 只接受 ThemeColor 字面量 union（SDK 契约）；projection 层保证传入 union 内字面量，
		// string → ThemeColor 是宽到窄单步断言（无需 unknown 中转）。
		theme: {
			fg(color: string, text: string): string {
				return ctx.ui.theme.fg(color as ThemeColor, text);
			},
			bold(text: string): string {
				return ctx.ui.theme.bold(text);
			},
		},
	};

	const messaging: MessagingPort = {
		sendContextMessage: (content, deliverAs, customType): void => {
			pi.sendMessage(
				{
					customType: customType ?? "goal-context",
					content,
					display: false,
				},
				{ deliverAs },
			);
		},
		sendUserMessage: (content, deliverAs): void => {
			pi.sendUserMessage(content, { deliverAs });
		},
	};

	const session: SessionPort = {
		getEntries: () => ctx.sessionManager.getEntries(),
	};

	return { persistence, ui: uiPort, messaging, session };
}
