/**
 * Pi /goal Extension — 工厂入口（重构后架构）
 *
 * 注册 command / events，全部委托 adapters 层。
 * goalInit slot 内部调 service.createGoal（FR-4.1）。
 *
 * 架构（D-21 双路径 + Ports/Adapters）：
 * - engine/：零 Pi 依赖的纯状态机（goal/budget/types）
 * - ports.ts：机器可检查的能力边界
 * - adapters/ports.ts：Pi → ServicePorts 桥接（单一构造点）
 * - service.ts：事件入口协调器（applyEvent）
 * - adapters/：Pi 桥接（command-adapter / event-handlers / ports）
 * - projection/：渲染（widget / prompts）
 *
 * FR-4.2/D-16：ctx 必填，移除 lastCtx 模块级可变状态。
 * FR-6.4：移除 hasPendingInjection。
 * FR-6.7：移除 pendingPause（ESC 改用 ctx.signal.aborted 守卫，在各 event handler）。
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { handleGoalCommand } from "./adapters/command-adapter";
import { handleAgentEnd } from "./adapters/event-handlers/agent-end";
import { handleBeforeAgentStart } from "./adapters/event-handlers/before-agent-start";
import { handleMessageEnd } from "./adapters/event-handlers/message-end";
import { handleSessionShutdown } from "./adapters/event-handlers/session-shutdown";
import { handleSessionStart } from "./adapters/event-handlers/session-start";
import { handleTurnEnd } from "./adapters/event-handlers/turn-end";
import { registerGoalControlTool } from "./adapters/goal-control-adapter";
import { buildPorts } from "./adapters/ports";
import { createGoal } from "./service";
import { createGoalSession, type GoalSession } from "./session";

// ── Extension Factory ─────────────────────────────────

export default function goalExtension(pi: ExtensionAPI) {
	const session: GoalSession = createGoalSession();

	// ── Command: /goal ────────────────────────────────

	pi.registerCommand("goal", {
		description:
			"Goal-driven mode: /goal <objective> [--tokens N] | /goal resume | /goal pause | /goal clear | /goal update <new-objective> [--criteria <text>] | /goal status | /goal history",
		handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
			await handleGoalCommand(pi, session, args, ctx);
		},
		getArgumentCompletions(prefix: string) {
			// 只补全一级静态子命令；update 后跟自由文本（目标描述），其他自由文本作为新目标，均不补全
			const parts = prefix.trimStart().split(/\s+/).filter(Boolean);
			if (parts.length > 1) return null;
			const trimmed = (parts[0] ?? "").toLowerCase();
			const opts = [
				{ label: "status", value: "status", description: "查看当前 goal 状态" },
				{ label: "resume", value: "resume", description: "恢复暂停/阻塞的 goal" },
				{ label: "pause", value: "pause", description: "暂停活跃的 goal" },
				{ label: "clear", value: "clear", description: "强制清除当前 goal" },
				{ label: "history", value: "history", description: "查看历史 goal" },
				{ label: "update", value: "update ", description: "重设目标（reshape）" },
			];
			return trimmed === "" ? opts : opts.filter((o) => o.label.startsWith(trimmed));
		},
	});

	// ── Tool: goal_control（complete / report_blocked，#3 替代已删 goal_manager）──

	registerGoalControlTool(pi, session);

	// ── Events（全部委托 adapters/event-handlers）────────

	pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
		return handleBeforeAgentStart(pi, session, ctx);
	});

	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		await handleTurnEnd(pi, session, ctx);
	});

	pi.on("message_end", async (event: MessageEndEvent, ctx: ExtensionContext) => {
		await handleMessageEnd(session, ctx, event);
	});

	pi.on("agent_end", async (_event, ctx: ExtensionContext) => {
		await handleAgentEnd(pi, session, ctx);
	});

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		await handleSessionStart(pi, session, ctx);
	});

	// MF-R2-1 根修：session_shutdown 在 runner invalidate 之前触发（此刻 pi/ctx
	// 仍可用），取消待发的退避 continuation timer——覆盖 reload / new / resume /
	// fork / quit 全部失效路径，旧 timer 不再携 stale ctx 闭包存活到到期
	pi.on("session_shutdown", async (_event, _ctx: ExtensionContext) => {
		await handleSessionShutdown(session);
	});

	// ── Message Renderers ──────────────────────────────

	const goalMessageTypes = ["goal-context", "goal-context-exceeded"];
	for (const customType of goalMessageTypes) {
		pi.registerMessageRenderer(
			customType,
			(message, _options, theme) => {
				const prefix =
					message.customType === "goal-context-exceeded"
						? theme.fg("error", "[GOAL Budget] ")
						: theme.fg("accent", "[GOAL] ");
				const content =
					typeof message.content === "string" ? message.content : JSON.stringify(message.content);
				return new Text(prefix + theme.fg("dim", content), 0, 0);
			},
		);
	}

	// ── External API: goalInit slot（FR-4 双轨消除）──────────

	/**
	 * 允许其他扩展（plan）通过 goalInit slot 编程式初始化 goal。
	 * 内部调 service.createGoal（FR-4.1——与 goal_control create 走同一创建逻辑）。
	 *
	 * FR-4.2/D-16: ctx 必填（消除 lastCtx 模块级可变状态）。
	 * ports 构造复用 adapters/ports.buildPorts（DRY：单一 ports 构造点）。
	 *
	 * 通道形态（C-ext-06 globalThis slot 惯例）：裸函数直挂——plan 侧使用点以 typeof 守卫
	 * 读取 `globalThis[Symbol.for("@zhushanwen/pi-goal.goalInit")]`（plan/src/compact.ts）。
	 * 不挂 pi API 对象：pi 0.84.4 为每个扩展创建独立 ExtensionAPI，挂 pi 对象的字段
	 * 跨扩展不可见（设计 docs/design/goal-bridge-cross-extension.md §2.3）。
	 *
	 * @param objective 目标描述
	 * @param budget 预算配置，传 undefined 用默认值
	 * @param ctx **必填**——调用方的 ExtensionContext。省略会返回 false（创建失败）。
	 * @param slug 可选短标识（仅 widget 标题 + history 用，不注入 prompt）
	 * @returns true 创建成功；false 已有 active goal 或 ctx 缺失
	 */
	const goalInitFn: GoalInitFn = (
		objective: string,
		budget: GoalInitBudget | undefined,
		ctx: ExtensionContext,
		slug?: string,
		successCriteria?: string[],
	): boolean => {
		if (!ctx) return false;
		return createGoal(session, objective, budget ?? {}, buildPorts(pi, ctx), slug, successCriteria);
	};
	Reflect.set(globalThis, GOAL_INIT_SLOT_KEY, goalInitFn);
}

// ── Cross-extension API 类型（单一 source of truth，API-1）──────────

/**
 * goalInit 跨扩展通道的 globalThis slot key（C-ext-06「包名.角色」全限定命名）。
 *
 * ⚠️ 必须与 `extensions/universal/plan/src/compact.ts` 的字符串字面量完全一致——
 * 两侧不共享运行时模块（plan 对 goal 是 optional peer），靠同一字符串拿到同一 slot。
 * 改名必须两侧同步。
 */
export const GOAL_INIT_SLOT_KEY = Symbol.for("@zhushanwen/pi-goal.goalInit");

/**
 * goalInit slot 的预算配置形状。
 *
 * 跨扩展（plan）通过 goalInit slot 编程式初始化 goal 时使用。
 * 与 `BudgetConfig` 的差异：本类型只暴露外部可设的可选字段，且全部 optional。
 */
export interface GoalInitBudget {
	tokenBudget?: number;
}

/**
 * goalInit slot 的规范函数签名（API-1：单一 source of truth）。
 *
 * 跨扩展消费者应 import 本类型而非重复声明 inline alias，避免签名 drift：
 * ```ts
 * import type { GoalInitFn } from "@zhushanwen/pi-goal";
 * const fn = Reflect.get(globalThis, Symbol.for("@zhushanwen/pi-goal.goalInit"));
 * const goalInit = typeof fn === "function" ? (fn as GoalInitFn) : undefined;
 * ```
 *
 * @param objective 目标描述
 * @param budget 预算配置，传 undefined 用默认值
 * @param ctx **必填**——调用方的 ExtensionContext。省略会返回 false（创建失败）。
 * @param slug 可选短标识（仅 widget 标题 + history 用，不注入 prompt）
 * @returns true 创建成功；false 已有 active goal 或 ctx 缺失
 */
export type GoalInitFn = (
	objective: string,
	budget: GoalInitBudget | undefined,
	ctx: ExtensionContext,
	slug?: string,
	successCriteria?: string[],
) => boolean;
