/**
 * Pending Notifications Extension — 跨 extension 的异步操作注册/查询机制。
 *
 * 设计定位：为长耗时异步操作（workflow/subagent/bash 后台任务）提供跨 extension 的
 * 活跃操作注册/查询机制。workflow/subagent/bash 运行时通过 EventBus（pi.events.emit）
 * 广播 register/unregister，本扩展监听这些事件、将状态写入 session entries（pi.appendEntry），
 * 供 LLM 通过 pending_notifications 工具主动查询当前活跃异步操作、通过 collect_results
 * 工具批量阻塞收取结果（result-collect 设计 §3.1③）
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
 * ② base-tool-enhance——bash 派生视图（notify.ts register/unregister 主链 +
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
 * - subagent-core registry-reconcile/reconcile-sweep.ts（对账 sweep 补注销，对账走
 *   appendEntry 权威路径，不经 emit）；
 * - base-tool-enhance pending-reconcile.ts（session_start 对账，同款）。
 *
 * entry 契约（与 goal before-agent-start.ts 对齐，读取端按 e.data.id 算差集）：
 * - pending:register → { id, type, name, registeredAt, sessionId, kind? }
 *   （kind 可选 = managed lifetime 债权标记，session-manager 写侧申报、本 listener
 *   白名单透传落盘——collect_results 缺省等待集排除依据，result-collect 设计 §3.4）
 * - pending:unregister → { id, reason, status }
 *
 * 状态权威源：session entries 是唯一状态——工具派生视图与写侧去重/活跃判断全部对
 * getEntries() 现算（appendEntry 同步入账，pi dist 实证，锚定 pi-semantics
 * PS-29 extensionAPI appendEntry 直委托 appendCustomEntry + PS-17 _appendEntry
 * 同步 push 无 debounce），无内存第二份状态；历史的内存 registry、
 * session_start 重建、TTL 与 shutdown 机器已删除。
 *
 * 监听方式：pi.events.on（Pi 的 EventBus，真实 SDK 为 EventBus.on，非 optional）。
 * workflow 侧通过 deps.eventBus 注入 pi.events（同一总线）。
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	mapReasonToStatus as mapReasonToStatusImpl,
	scanPendingFields,
} from "@zhushanwen/extension-protocol";
import {
	getDeliveryPort,
	type CollectedEntry,
	type CollectSnapshot,
	type DeliveryPortHandle,
} from "@zhushanwen/pi-delivery-port";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { Type } from "typebox";

import {
	computeCollectWaitKeys,
	countActiveFromEntries,
	hasPendingId,
	isPendingActive,
	normalizePendingType,
	type PendingEntry,
	type PendingKind,
	type PendingStatus,
	type PendingType,
} from "./state.ts";
import { renderPendingNotificationsResult } from "./render-result.ts";

// 跨扩展消费 API：goal（continuation 检查）/ subagent-workflow（agent_end 后代判定）
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
 *  让 registerTool 泛型对 TDetails 推断一致，避免 union 细节冲突。summary 是收起态一行摘要
 *  （GUI 收起态与 TUI 折叠态共用，buildPendingNotificationsSummary 产出）。 */
interface PendingToolDetails {
	action: string;
	count: number;
	items?: PendingEntry[];
	summary: string;
}

// ── collect_results（批量收取，result-collect 设计 §3.1③）─────────────

/** 缺省超时（设计 §3.3 量级决策：任务级对象 → 小时量级。非墙钟判死——超时是等待器的
 *  诚实返回：任务不受影响、stillOpen 列出、恢复 push、可续 collect。偏离「任务级缺省
 *  不限时」的原因与论证登记在设计 §3.3，工具描述引导 agent 按预期时长显式传参）。 */
const COLLECT_DEFAULT_TIMEOUT_MS = 3_600_000;

/** collect_results 工具参数 schema */
const CollectResultsParams = Type.Object({
	ids: Type.Optional(Type.Array(Type.String())),
	timeout_ms: Type.Optional(Type.Number()),
});

/** stillOpen 条目：未收取的等待键（note 标记特殊态，如已入 push 管线）。 */
interface StillOpenEntry {
	id: string;
	note?: string;
}

/** errors 条目：未知 id（判定源 = 活跃集 ∪ 投递日志键集 ∪ 曾注册集 的补集），逐条列出不阻断已知子集。 */
interface CollectErrorEntry {
	id: string;
	reason: string;
}

/** collect_results 工具的 details 形状（与返回契约同构，结构化消费方）。 */
interface CollectToolDetails {
	collected: CollectedEntry[];
	stillOpen: StillOpenEntry[];
	errors?: CollectErrorEntry[];
}

/** collect_results 工具描述（缺省口径 + lifetime 排除 + managed 全键返回形态 + timeout
 *  缺省值引导显式传参 + 反模式（勿当活性检查用、只关心特定操作勿省略 ids）+
 *  与 pending_notifications 分工声明，result-collect 设计 §3.1③/§3.4 工具描述更新项）。 */
const COLLECT_RESULTS_DESCRIPTION = [
	"Block and batch-collect results of background async operations (workflow / subagent / bash background tasks / managed session claims), instead of receiving one notification per completion.",
	"Returns collected (entries: {id, type, outcome, content, details}), stillOpen (not collected: {id, note?}) and errors (unknown ids, listed individually without blocking the known subset).",
	"ids: target operation ids (as returned when dispatching background tasks). Omitted = every active pending operation of the current session, EXCLUDING managed-session lifetime claims (alive-markers that only settle when the session dies — waiting on them would hang until timeout) and registrations inherited from a forked parent session.",
	"timeout_ms: max wait in milliseconds, default 3600000 (1 hour). Pass a value matched to the expected task duration (e.g. 120000 for short tasks). On timeout the already-arrived results are returned; the rest stay in stillOpen and notify normally (push) when they complete.",
	"A managed-session batched notification matched by any of its keys returns one entry per key of that batch (same payload shared). Collecting an already-collected id again returns its snapshot (no duplicate injection). Interruption (timeout / user abort) returns normally with the arrived subset.",
	"Do NOT use this tool as a liveness or status check — it blocks the current turn until results arrive or timeout_ms elapses. Immediate status queries go to pending_notifications (list).",
	"DO NOT omit ids when you only care about specific operations — the default wait set blocks on every active non-lifetime pending operation of this session at once.",
	"Division of labor: pending_notifications (list) is the immediate status query; collect_results is the blocking wait — use it only when the next step actually needs those results.",
].join("\n");

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
	// entries 是唯一状态源（无内存状态副本）：currentSessionId 是查询派生视图的跨 session
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
			// lifetime 债权标记落盘透传（result-collect 设计 §3.4 kind 读取链写侧落点；
			// 无标记条目形状不变——非 managed 注册零字段增量）
			...(parsed.kind ? { kind: parsed.kind } : {}),
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
		if (parsed.reasonMalformed) {
			debugLog("warn", "listener: pending:unregister reason missing/malformed (emit-side contract breach) → settled no_result", data);
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
			"查询当前活跃的异步操作（workflow/subagent/bash 后台任务与 session（managed session 债权））。action=count 返回数量；action=list 返回列表。",
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
					details: {
						action: "count",
						count: active.length,
						summary: buildPendingNotificationsSummary({ action: "count", count: active.length }),
					},
				};
			}

			// action === "list"
			return {
				content: [{ type: "text" as const, text: formatList(active) }],
				details: {
					action: "list",
					count: active.length,
					items: active,
					summary: buildPendingNotificationsSummary({ action: "list", count: active.length }),
				},
			};
		},

		renderResult(result: unknown, options: { expanded: boolean }, theme: Theme) {
			return renderPendingNotificationsResult(result, options, theme);
		},
	});

	// ── 批量收取 tool（result-collect 设计 §3.1③）─────────────────────
	pi.registerTool({
		name: "collect_results",
		label: "Collect Results",
		description: COLLECT_RESULTS_DESCRIPTION,
		parameters: CollectResultsParams,
		// 任一时刻至多一个在途 collect（设计前提 P2：同批任一工具声明 sequential 即整批
		// 串行）——多在途等待集的跨集判重预案因此不需要。
		executionMode: "sequential",
		execute: async (
			_toolCallId: string,
			params: { ids?: string[]; timeout_ms?: number },
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<{ content: { type: "text"; text: string }[]; details: CollectToolDetails }> =>
			collectResults(params, signal, ctx),
	});

	/** collect_results 执行体（工厂闭包：读 currentSessionId 缺省集过滤基准）。
	 *
	 * 执行序（设计 §3.1③）：等待键集计算 → collectArm（端口同步段登记 + 五态快照）→
	 * 快照合并组装（ready ∪ unregistered-no-entry 进 collected；in-push-pipeline 进
	 * stillOpen 附 note；waiting 留守）→ await 到达/超时/abort 三者先到 → consume +
	 * collectRelease → 返回。AbortSignal 捕获后正常 return（禁抛错路径——pi 契约下抛错
	 * 会把已写 collected 终局的载荷随返回丢失，收取即丢失，设计 §3.1 [abort]）。
	 */
	async function collectResults(
		params: { ids?: string[]; timeout_ms?: number },
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	): Promise<{ content: { type: "text"; text: string }[]; details: CollectToolDetails }> {
		const entries = ctx.sessionManager.getEntries();
		const timeoutMs = params.timeout_ms ?? COLLECT_DEFAULT_TIMEOUT_MS;

		// 等待键集：显式 ids 全量交端口五态判决定态（unknown 态键由快照回流进
		// errors，MF-1-5：未知判定单点在端口——工具侧不再重扫 entries 算「活跃集 ∪
		// 曾注册集」补集）；缺省 = computeCollectWaitKeys（活跃 − lifetime 死亡债权
		// − 跨 session 残留，currentSessionId 空串回退同款）。
		let waitKeys: string[];
		if (params.ids) {
			waitKeys = [...new Set(params.ids)];
		} else {
			waitKeys = computeCollectWaitKeys(entries, currentSessionId);
		}

		// 等待集为空：立即返回，不进入等待、不触端口（设计 §3.1③ 边界语义）。显式
		// ids 全量交端口定态后空集只剩两种形态（空数组 / 缺省集空），均不产 errors。
		if (waitKeys.length === 0) {
			const details: CollectToolDetails = { collected: [], stillOpen: [] };
			debugLog("debug", "collect_results: empty wait set, returning immediately");
			return { content: [{ type: "text" as const, text: formatCollectDetails(details) }], details };
		}

		// 槽缺席降级（base-tool-enhance session_start 装配缺失的异常窗口，生产不可达常态；
		// STANDARDS §11.1 通知类接入点降级非静默吞）：warn 留痕 + 正常返回（不抛错，
		// 错误文本指向恢复动作 = 下次 session_start 重试装配后重试）。
		const port = getDeliveryPort();
		if (!port) {
			logger.warn(
				"[pending-notifications] collect_results: delivery port not bound — collect unavailable (base-tool-enhance session_start 装配缺失)",
				{ waitKeys },
			);
			return {
				content: [
					{
						type: "text" as const,
						text: "collect_results unavailable: delivery port not bound (assembly missing). Retry after the session finishes starting (session_start rebinds the port).",
					},
				],
				details: { collected: [], stillOpen: [] },
			};
		}

		// collectArm：端口同步段登记等待集 + 五态快照（每 key 一条；unknown 态 =
		// 端口未知判定单点回流）。
		const snapshot = port.collectArm(waitKeys);
		const collected: CollectedEntry[] = [];
		const stillOpen: StillOpenEntry[] = [];
		const waitingIds: string[] = [];
		const unknownIds: string[] = [];
		partitionCollectSnapshot(snapshot, { collected, stillOpen, waitingIds, unknownIds });
		const errors: CollectErrorEntry[] = unknownIds.map((id) => ({
			id,
			reason: "unknown id — not an active pending operation and never registered in this session",
		}));

		// 到达等待：事件驱动（onCollectArrival）不轮询；到达/超时/abort 三者先到。
		// 完成判据 = 全部等待键出现在已收取集合（到达即 consume 取走载荷+终局）。
		await awaitCollectArrivals(port, waitingIds, collected, timeoutMs, signal);

		// 终局序列（设计 §3.1③）：consume 取走剩余已到达挂起条目（超时/abort 路径的
		// 部分收取），collectRelease 解散等待集并把未收挂起条目直通内核 flush（边沿
		// 即投——攒批窗已删 §3.3.7③，恢复 push）。空等待路径不会走到这里（提前返回）。
		collected.push(...port.consume());
		port.collectRelease();

		// type/outcome 缺失回填（字段来源见 backfillCollectFields 注释）。
		backfillCollectFields(ctx, collected);

		// 未收取的等待键进 stillOpen（无 note = 单纯未完成，完成时恢复 push）。
		const collectedIds = new Set(collected.map((c) => c.id));
		for (const id of waitingIds) {
			if (!collectedIds.has(id)) stillOpen.push({ id });
		}

		const details: CollectToolDetails = { collected, stillOpen };
		if (errors.length > 0) details.errors = errors;
		debugLog("debug", "collect_results: returning", {
			collected: collected.length,
			stillOpen: stillOpen.length,
			errors: errors.length,
		});
		return { content: [{ type: "text" as const, text: formatCollectDetails(details) }], details };
	}

	/** 快照五态分流（§3.1③）：ready ∪ unregistered-no-entry 进 collected；in-push-pipeline
	 * 进 stillOpen 附 note；waiting 留守；unknown 逐条回流（错误组装在调用方）。 */
	function partitionCollectSnapshot(
		snapshot: CollectSnapshot,
		buckets: {
			collected: CollectedEntry[];
			stillOpen: StillOpenEntry[];
			waitingIds: string[];
			unknownIds: string[];
		},
	): void {
		for (const snap of snapshot) {
			switch (snap.state) {
				case "ready":
				case "unregistered-no-entry":
					// 快照收取：ready = 日志条目已有终局的读侧快照（不写新终局）；
					// unregistered-no-entry = 第四态无载荷有限信息形态（outcome 取注销
					// status、note 说明来源，端口侧组装）。两态的 entry 契约在册。
					buckets.collected.push({ id: snap.id, ...(snap.entry ?? {}) });
					break;
				case "in-push-pipeline":
					// 已过分流点、在 push 管线排队待注入：不收取（收取后再注入 = 双重呈现）
					// 不等待（等其终局 = 等待源与阻塞源互等自锁）——附 note 进 stillOpen。
					buckets.stillOpen.push({
						id: snap.id,
						note: "already queued in the push pipeline — will be delivered as a normal notification after this tool returns",
					});
					break;
				case "waiting":
					buckets.waitingIds.push(snap.id);
					break;
				case "unknown":
					// 未知 id（端口五态判据单点判定）：逐条列出、不阻断已知子集。
					buckets.unknownIds.push(snap.id);
					break;
			}
		}
	}

	/** 到达等待段：等待键为空立即返回；否则 consume+到达判据（全部等待键已收取）/
	 * 超时 / abort 三者先到解除（abort 捕获后正常 return，不抛错——抛错会把已写
	 * collected 终局的载荷随返回丢失，§3.1 [abort]）。 */
	async function awaitCollectArrivals(
		port: DeliveryPortHandle,
		waitingIds: readonly string[],
		collected: CollectedEntry[],
		timeoutMs: number,
		signal: AbortSignal | undefined,
	): Promise<void> {
		if (waitingIds.length === 0) return;
		await new Promise<void>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined = undefined;
			let unsubscribeArrival: () => void = () => {};
			const onAbort = () => finish();
			const finish = () => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				unsubscribeArrival();
				resolve();
			};
			const pullArrived = () => {
				collected.push(...port.consume());
				const collectedIds = new Set(collected.map((c) => c.id));
				if (waitingIds.every((id) => collectedIds.has(id))) finish();
			};
			if (signal?.aborted) {
				finish();
				return;
			}
			timer = setTimeout(finish, timeoutMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			unsubscribeArrival = port.onCollectArrival(pullArrived);
		});
	}

	/** type/outcome 缺失回填（设计 §3.1③ 字段来源表 + §3.3.6 结清权威）：type 与
	 *  pending:register 的 type 对齐；outcome 读注销 entry 的 reason 事实经
	 *  resolveSettlementReason 结清解析（封闭五值 + 词表外 unknown fail-visible，
	 *  protocol scanPendingFields 单点投影），不经 mapReasonToStatus 旧映射——
	 *  no_result/lost 等新写入方 reason 在旧 status 副档恒落 unknown，结清视图才载
	 *  真值。「等待中同步到达」的挂起条目在端口 consume 时点，生产方的注销 entry
	 *  尚未落盘（managed flushBatch 的 deliver 与 unregisterPending 同步段相邻、
	 *  deliver 先行；端口 consume 由到达回调在 deliver 栈内同步触发），outcome 恒取
	 *  空。await 恢复后生产方同步栈已完成（注销 entry 已落盘），按本 session entries
	 *  现算回填；注销不在册的条目保持 undefined（诚实缺省，不虚构终态）。快照收取
	 *  条目（ready / unregistered-no-entry）的 type/outcome 已由端口 collectArm 填充，
	 *  回填只补缺不覆盖。 */
	function backfillCollectFields(ctx: ExtensionContext, collected: CollectedEntry[]): void {
		if (!collected.some((c) => c.outcome === undefined || c.type === undefined)) return;
		const fields = scanPendingFields(ctx.sessionManager.getEntries());
		for (const c of collected) {
			if (c.type === undefined) c.type = fields.registerTypes.get(c.id);
			if (c.outcome === undefined) c.outcome = fields.unregisterSettlements.get(c.id);
		}
	}
}

// ── 事件解析 helper ─────────────────────────────────

interface ParsedRegister {
	id: string;
	type: PendingType;
	name: string;
	kind?: PendingKind;
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
		// lifetime 标记白名单解析（result-collect 设计 §3.4；未知值不透传 = 缺省
		// send 债权语义，与 normalizeRegisterEntry 读取侧白名单同口径防漂移）
		...(d.kind === "lifetime" ? { kind: "lifetime" as const } : {}),
	};
}

interface ParsedUnregister {
	id: string;
	reason: string;
	/** reason 缺失/非 string（emit 方违约的畸形 data）——缺省 no_result 结清时置位，
	 *  调用点 debugLog warn 留痕（[subagent-observability §3.3.11④]）。 */
	reasonMalformed?: boolean;
}

/** 解析 pending:unregister 事件 data（容错缺失/类型错误字段）。
 *  T2 通知由 subagent-workflow 自有通道 bg-notify-render 承担，不经本事件。
 *  [subagent-observability §3.3.11④] reason 缺失/非 string（emit 方漏传的违约
 *  形态）缺省 no_result 不产 completed——无事实可依不产假成功结清，与
 *  resolveSettlementReason / resolveSettlement 缺省方向一致；畸形经调用点
 *  warn 留痕。 */
function parseUnregisterEvent(data: unknown): ParsedUnregister | null {
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string") return null;
	if (typeof d.reason !== "string") {
		return { id: d.id, reason: "no_result", reasonMalformed: true };
	}
	return { id: d.id, reason: d.reason };
}

/** 将事件 reason 映射为 pending:unregister entry 的 status 字段（落盘契约组成部分）。
 *  权威单点在 protocol pending-entries（ext-simplify-17 D10）——本函数是对 protocol
 *  导出的类型收窄包装（PendingStatus 枚举留在本包，protocol 不引 extension 侧类型），
 *  既有调用点零改动；bte 对账写侧同引 protocol 单点，两侧映射不再可能漂移。
 *  词表演化背景（U5 / §3.2.5 通知词表对齐）见 protocol 实现处 JSDoc；unknown 缺省
 *  成员两侧词表同批收录，收窄赋值成立无需断言。 */
function mapReasonToStatus(reason: string): PendingStatus {
	return mapReasonToStatusImpl(reason);
}

/** 格式化 active 列表为可读文本 */
function formatList(active: PendingEntry[]): string {
	if (active.length === 0) return "No pending operations";
	const lines = active.map((op) => `- [${op.type}] ${op.name} (id=${op.id})`);
	return `${active.length} pending operation(s):\n${lines.join("\n")}`;
}

/** 收起态一行摘要：count → "N pending operations"；list → "N entries listed"；零值统一
 *  "No pending operations"（与 content 文案的零值口径一致）。 */
export function buildPendingNotificationsSummary(details: {
	action: string;
	count: number;
}): string {
	if (details.count === 0) return "No pending operations";
	return details.action === "count"
		? `${details.count} pending operations`
		: `${details.count} entries listed`;
}

/** collect_results 结果的可读文本（content 通道：载荷 content 随文本到达 agent，
 *  details 承载结构化同构副本供程序消费）。 */
function formatCollectDetails(details: CollectToolDetails): string {
	const lines = [
		`collect_results: ${details.collected.length} collected, ${details.stillOpen.length} still open${
			details.errors ? `, ${details.errors.length} unknown id(s)` : ""
		}`,
	];
	for (const c of details.collected) {
		const typeTag = c.type ? `[${c.type}] ` : "";
		const outcomeTag = c.outcome ? ` (${c.outcome})` : "";
		const body = c.content ? `: ${c.content}` : "";
		const noteTag = c.note ? ` — ${c.note}` : "";
		lines.push(`- collected ${typeTag}${c.id}${outcomeTag}${body}${noteTag}`);
	}
	for (const s of details.stillOpen) {
		lines.push(`- still open: ${s.id}${s.note ? ` (${s.note})` : ""}`);
	}
	for (const e of details.errors ?? []) {
		lines.push(`- unknown id: ${e.id} — ${e.reason}`);
	}
	return lines.join("\n");
}
