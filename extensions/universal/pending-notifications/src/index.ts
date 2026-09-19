/**
 * Pending Notifications Extension — 跨 extension 的异步操作注册/查询机制。
 *
 * 设计定位：为长耗时异步操作（workflow/subagent/bash 后台任务）提供跨 extension 的
 * 活跃操作注册/查询机制。workflow/subagent/bash 运行时通过 EventBus（pi.events.emit）
 * 广播 register/unregister，本扩展监听这些事件、将状态写入 session entries（pi.appendEntry），
 * 供 LLM 通过 pending_notifications 工具主动查询当前活跃异步操作
 * （goal 不在 before_agent_start 注入等待消息——避免双信息源，pending 感知由 LLM 自行查询）。
 *
 * 文件职责：
 * - state.ts:    PendingEntry + 差集/写侧判断纯函数（countActiveFromEntries /
 *                hasPendingId / isPendingActive）
 * - index.ts（本文件）: 工厂入口（EventBus 写侧监听 + session 基准 + 查询 tool）
 *
 * 事件契约（emit 端三组，与 extension-dependencies.json 本包条目 reason 同口径：
 * ① subagent-core——notify-host.ts（register + record 终态化 unregister——finalizeRun
 *   直落后的残留发射面，观测通道 = sweep reconciled WARN）/ orchestration/lifecycle.ts
 *   （register 主链）；
 * ② base-tool-enhance——bash 投影（notify.ts register/unregister 主链 +
 *   process-exit-guard.ts 退出边沿尽力补 emit（pending-reconcile 对账走 appendEntry
 *   权威路径，不经 emit））；
 * ③ subagent-workflow——仅崩溃恢复时 emit pending:unregister（session-lifecycle.ts
 *   recoverCrashedRuns 回调））：
 * - emit("pending:register", { id, type, name })
 * - emit("pending:unregister", { id, reason })
 *
 * 直落写方（不经本事件、直接 appendEntry 权威落盘——listener 的 isPendingActive
 * 现算幂等门对两族写方统一生效，重复注销被自然拦截）：
 * - subagent-core worker-message-pump.ts finalizeRun（reload-closeout D4：workflow
 *   run 终态注销直落，emit 发射点已删——reload 转换窗/factory 顺序窗内 emit 丢失
 *   即注销 entry 永缺位）；
 * - subagent-core round-supervisor/reconcile-sweep.ts（对账 sweep 补注销，对账走
 *   appendEntry 权威路径，不经 emit）；
 * - base-tool-enhance pending-reconcile.ts（session_start 对账，同款）。
 *
 * entry 契约（与 goal before-agent-start.ts 对齐，读取端按 e.data.id 算差集）：
 * - pending:register → { id, type, name, registeredAt, sessionId }
 * - pending:unregister → { id, reason, status }
 *
 * 状态权威源：session entries 是唯一状态——工具投影与写侧去重/活跃判断全部对
 * getEntries() 现算（appendEntry 同步入账，pi dist 实证），无内存第二份状态；
 * 历史的内存 registry、session_start 重建、TTL 与 shutdown 机器已删除。
 *
 * 监听方式：pi.events.on（Pi 的 EventBus，真实 SDK 为 EventBus.on，非 optional）。
 * workflow 侧通过 deps.eventBus 注入 pi.events（同一总线）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mapReasonToStatus as mapReasonToStatusImpl } from "@zhushanwen/extension-protocol";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { Type } from "typebox";

import {
	countActiveFromEntries,
	hasPendingId,
	isPendingActive,
	normalizePendingType,
	type PendingEntry,
	type PendingStatus,
	type PendingType,
} from "./state.ts";

// 跨扩展消费 API：goal（continuation 守卫）/ subagent-workflow（agent_end 后代判定）
// 直接 import 本包导出的 countActiveFromEntries，避免各自复制差集逻辑。导出面只保留
// 唯一消费函数 + 其签名所需类型（entries 是唯一状态源，包内不再导出状态机 API）。
export {
	countActiveFromEntries,
	type CountActiveOptions,
	type CountActiveResult,
	type PendingEntry,
	type PendingType,
} from "./state.ts";

const logger = getLogger("pending-notifications");

/** 工具参数 schema */
const PendingNotificationsParams = Type.Object({
	action: Type.Union([
		Type.Literal("count"),
		Type.Literal("list"),
	]),
});

/** pending_notifications 工具的 details 形状。两个分支共用同一结构（items 缺省时 undefined），
 *  让 registerTool 泛型对 TDetails 推断一致，避免 union 细节冲突。 */
interface PendingToolDetails {
	action: string;
	count: number;
	items?: PendingEntry[];
}

/**
 * 模块级 EventBus 监听器 unsubscribe 函数列表。
 *
 * [W4 注释修正] 原 rationale（"EventBus 进程级单例 + reload 累积 N 组监听器"）在
 * pi 0.84.1 不成立：pi.events.on 的返回值是 runtime.trackEventBusSubscription 跟踪的
 * unsubscribe（loader.js:338-341），runtime.invalidate() 时自动全部退订——session 替换
 * （dispose）与 /reload（invalidate 先于重新 load）都触发；且 session 替换会创建全新
 * ResourceLoader → 全新 eventBus（agent-session-services.js:63-68），旧 bus 整体废弃。
 *
 * 下方的工厂入口手工清理因此是双重冗余（无害）：pi 已自动清理 tracked 订阅。
 * 保留是防御性兜底（不依赖 pi 内部清理时机，卸载幂等）。
 */
let unsubscribers: Array<() => void> = [];

/** 扩展入口 */
export default function pendingNotificationsExtension(pi: ExtensionAPI): void {
	// ── 清理上一轮 reload 的 EventBus 监听器（H2 防泄漏） ─────
	for (const unsub of unsubscribers) {
		try {
			unsub();
		} catch (err) {
			// unsubscribe 失败不阻断初始化（监听器可能已被 EventBus 内部清理）
			logger.debug("unsubscribe failed during cleanup", { error: String(err) });
		}
	}
	unsubscribers = [];

	// ── 闭包内状态 ─────
	// entries 是唯一状态源（无内存状态副本）：currentSessionId 是查询投影的跨 session
	// 过滤基准；sessionManager 是 listener 写侧前置判断的 entries 读取通道（EventBus
	// 回调无 ctx 参数，经 session_start 缓存持有）。
	let currentSessionId: string = "";
	let sessionManager: ExtensionContext["sessionManager"] | undefined;

	// listener 前置判断读 entries：未 session_start 前视为空（前置判断放行落盘，
	// 与历史空状态口径一致）；getEntries 为纯数组读（pi dist 实证），无失败路径。
	function currentEntries(): unknown[] {
		return sessionManager?.getEntries() ?? [];
	}

	// 安全写入 session entry：忽略 stale context 等不可恢复错误（如 subagent 子进程
	// session replacement 后 listener 仍触发）。返回是否成功。
	function safeAppendEntry(customType: string, data: unknown): boolean {
		try {
			pi.appendEntry(customType, data);
			return true;
		} catch {
			// stale context 或 session 已关闭时，静默丢弃。entry 不是关键业务数据，
			// 丢失不会破坏主流程。
			return false;
		}
	}

	// debug 日志：环境变量 TAIJI_AGENT_DEBUG=1 时经共享 logger 写文件日志（默认 no-op）。
	// 不写入 session entry（pending:log）——session entries 是 append-only 无法 GC，
	// debug 日志会让长 session 的 entries 线性膨胀，而 goal before-agent-start
	// 每 turn 全量扫描 getEntries()。状态数据（pending:register/unregister）仍写 entry。
	const debugEnabled = process.env.TAIJI_AGENT_DEBUG === "1";
	function debugLog(level: string, message: string, data?: unknown): void {
		if (!debugEnabled) return;
		logger.debug(`${level}: ${message}`, data ?? "");
	}

	// ── EventBus 监听：pending:register ─────────────────────
	unsubscribers.push(pi.events.on("pending:register", (data: unknown) => {
		debugLog("debug", "listener: pending:register received", data);
		const parsed = parseRegisterEvent(data);
		if (!parsed) {
			debugLog("warn", "listener: pending:register parse failed", data);
			return;
		}

		debugLog("debug", "listener: pending:register parsed", parsed);

		// 重复注册忽略（U6）：entries 已有该 id 的 register entry（无论注销与否）即
		// 跳过——写侧判断与落盘同源（同一份 entries），无第二份状态可分歧。
		if (hasPendingId(currentEntries(), parsed.id)) {
			debugLog("debug", "listener: pending:register ignored (duplicate)", { id: parsed.id });
			return;
		}

		// 写入侧无条件省略 expiresAt：三类型全 process 档（无 TTL 概念），读取侧
		// 同样不读该键，两侧共同兑现豁免。
		safeAppendEntry("pending:register", {
			id: parsed.id,
			type: parsed.type,
			name: parsed.name,
			registeredAt: Date.now(),
			sessionId: currentSessionId,
		});

		debugLog("debug", "listener: pending:register appended", { id: parsed.id });
	}));

	// ── EventBus 监听：pending:unregister ───────────────────
	unsubscribers.push(pi.events.on("pending:unregister", (data: unknown) => {
		debugLog("debug", "listener: pending:unregister received", data);
		const parsed = parseUnregisterEvent(data);
		if (!parsed) {
			debugLog("warn", "listener: pending:unregister parse failed", data);
			return;
		}

		debugLog("debug", "listener: pending:unregister parsed", parsed);

		// 未知/已注销 id 忽略（U8）：对 entries 现算（有 register 且无任何 unregister
		// 才落盘）——bte 对账已直接落盘的注销在此同样生效，任一发送方重复 unregister
		// 被本前置判断拦截，天然不重复落盘。
		const status = mapReasonToStatus(parsed.reason);
		if (!isPendingActive(currentEntries(), parsed.id)) {
			debugLog("debug", "listener: pending:unregister ignored (unknown id)", { id: parsed.id });
			return;
		}

		safeAppendEntry("pending:unregister", {
			id: parsed.id,
			reason: parsed.reason,
			status,
		});

		debugLog("debug", "listener: pending:unregister appended", { id: parsed.id });
	}));

	// ── session_start：仅记录当前 session（entries 现算，无状态重建） ─────
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		sessionManager = ctx.sessionManager;
		currentSessionId = ctx.sessionManager.getSessionId();
	});

	// ── 查询 tool ─────────────────────────────────────────
	pi.registerTool({
		name: "pending_notifications",
		label: "Pending Notifications",
		description:
			"查询当前活跃的异步操作（workflow/subagent/bash 后台任务）。action=count 返回数量；action=list 返回列表。状态由 EventBus + session entries 维护，无需手动注册。",
		parameters: PendingNotificationsParams,
		execute: async (_toolCallId: string, params: { action: "count" | "list" }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<{ content: { type: "text"; text: string }[]; details: PendingToolDetails }> => {
			// entries 现算（单一权威源）：与 goal/subagent-workflow 同一原语。跨 session
			// 残留（fork 继承的父级注册）按 currentSessionId 过滤；为空串（session_start
			// 未到）时不过滤——宁放行不误逐。
			const active = countActiveFromEntries(
				ctx.sessionManager.getEntries(),
				currentSessionId ? { currentSessionId } : undefined,
			).entries;

			debugLog("debug", `tool ${params.action} requested`, { action: params.action, activeCount: active.length });

			if (params.action === "count") {
				return {
					content: [{ type: "text" as const, text: `${active.length} pending operation(s)` }],
					details: { action: "count", count: active.length },
				};
			}

			// action === "list"
			return {
				content: [{ type: "text" as const, text: formatList(active) }],
				details: { action: "list", count: active.length, items: active },
			};
		},
	});
}

// ── 事件解析 helper ─────────────────────────────────

interface ParsedRegister {
	id: string;
	type: PendingType;
	name: string;
}

/** 解析 pending:register 事件 data（容错缺失/类型错误字段） */
function parseRegisterEvent(data: unknown): ParsedRegister | null {
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string") return null;
	return {
		id: d.id,
		// bash 类型直通（归一化映射与 state.ts 读取侧共用同一函数，防两侧漂移）
		type: normalizePendingType(d.type),
		name: typeof d.name === "string" ? d.name : d.id,
	};
}

interface ParsedUnregister {
	id: string;
	reason: string;
}

/** 解析 pending:unregister 事件 data（容错缺失/类型错误字段）。
 *  T2 通知由 subagent-workflow 自有通道 bg-notify-render 承担，不经本事件。 */
function parseUnregisterEvent(data: unknown): ParsedUnregister | null {
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string") return null;
	return {
		id: d.id,
		reason: typeof d.reason === "string" ? d.reason : "completed",
	};
}

/** 将事件 reason 映射为 pending:unregister entry 的 status 字段（落盘契约组成部分）。
 *  权威单点在 protocol pending-entries（ext-simplify-17 D10）——本函数是对 protocol
 *  导出的类型收窄包装（PendingStatus 枚举留在本包，protocol 不引 extension 侧类型），
 *  既有调用点零改动；bte 对账写侧同引 protocol 单点，两侧映射不再可能漂移。
 *  词表演化背景（U5 / §3.2.5 通知词表对齐）见 protocol 实现处 JSDoc。 */
function mapReasonToStatus(reason: string): PendingStatus {
	return mapReasonToStatusImpl(reason) as PendingStatus;
}

/** 格式化 active 列表为可读文本 */
function formatList(active: PendingEntry[]): string {
	if (active.length === 0) return "No pending operations";
	const lines = active.map((op) => `- [${op.type}] ${op.name} (id=${op.id})`);
	return `${active.length} pending operation(s):\n${lines.join("\n")}`;
}
