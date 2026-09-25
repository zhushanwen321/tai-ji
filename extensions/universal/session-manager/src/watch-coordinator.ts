// src/watch-coordinator.ts — watch 桥的 extension 侧编排（notify-once D2/D3/D6/D7③/U4）。
//
// 职责：
//   1. arm：send/create 工具结果成功且 willNotify → pending:register（三键 {id,type:'session',name}，
//      P4 既有 emit 写侧零改动）+ 开表（watch fire-and-forget，不传 timeout——D2/P1）
//   2. watch 应答处理：unregister（reason 原词 emit——pending-notifications 写侧经
//      mapReasonToStatus 族映射落 status，4 个新 reason 的 default 误标防线就在那一跳，
//      本侧不再预映射）+ 默认 record + 两例外（D3）：
//        例外1 cancelled/orphaned → 静默（逐笔即时 unregister，不 record、不动死亡槽）；
//        例外2 死亡新闻槽 (sessionId, deathSeq) 键去重 → 同键首条 record 死亡新闻 + fulfills N，
//             同键后续仅 unregister；
//   3. trailing debounce 50ms 两层攒批（D3 裁决4）：分拣键 (sessionId, reason) 定处理类别，
//      批身份 settleSeq/deathSeq 定 record 边界——跨 session 不合批由分组键自然排除；
//      cancelled/orphaned 不入窗（逐笔即时）；
//   4. session_start 重启收口腿（D7③）：活跃 type 'session' register 重开 watch
//      （入参 = entry id 即 notifyId，P4 三键零改动），每 entry 独立 handler 禁串行 await。
//
// 合批的 record 幂等键 = 批内首个响应的 notifyId（A6 口径：每 notifyId 至多一条、
// fulfills 总数守恒；death 槽同语义——同槽只出一条）。fulfillsN = runtime 直供本批
// 兑现总笔数（同批应答同值，设计 D3 合批段；缺席回退批内应答笔数）。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyPendingDiff,
	isSessionManagerWatchRespondPayload,
	scanPendingEntries,
	type MarkerRpcResult,
	type SessionManagerWatchRespondPayload,
	type SessionManagerWatchReason,
} from "@zhushanwen/extension-protocol";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { buildManagedNotifyContent, type ManagedNotifyDetails } from "./notify-content.ts";
import { recordManagedNotify } from "./notify-ledger.ts";

const logger = getLogger("session-manager");

/** trailing debounce 窗口（D3 裁决4：每次应答到达重置计时；下一 seq 到达即封批） */
const WATCH_FLUSH_DEBOUNCE_MS = 50;

/** 已占的死亡新闻槽（例外2）：键 = (sessionId, deathSeq)。factory 闭包状态
 *  （extension 进程内 session 隔离约定——槽键含 sessionId，跨子会话不串）。 */
function deathSlotKey(sessionId: string, deathSeq: number): string {
	return `${sessionId} ${deathSeq}`;
}

/** 畸形/词表外应答的漂移形态摘要里键清单的截断上限（防大 payload 刷屏留痕） */
const DRIFT_KEY_PREVIEW_LIMIT = 8;

/** 畸形/词表外应答的漂移形态摘要（warn 留痕用，同 non-json 分支的 responseHead
 *  形态——只描述形状不做归因）：对象 → reason 原词 + 键清单（截断防大 payload 刷屏），
 *  非对象 → typeof。 */
function describeRespondDrift(parsed: unknown): string {
	if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
		const rec = parsed as Record<string, unknown>;
		const reason = rec["reason"];
		const reasonPart = typeof reason === "string" ? reason : typeof reason;
		const keys = Object.keys(rec).slice(0, DRIFT_KEY_PREVIEW_LIMIT).join(",");
		return `reason=${reasonPart} keys=[${keys}]`;
	}
	return `typeof=${Array.isArray(parsed) ? "array" : typeof parsed}`;
}

/** 入窗待攒批的应答（cancelled/orphaned 例外1 不入窗） */
interface QueuedRespond {
	notifyId: string;
	label: string;
	reason: SessionManagerWatchReason;
	payload: SessionManagerWatchRespondPayload;
}

export interface WatchCoordinatorDeps {
	pi: ExtensionAPI;
	/** 开表通道（index.ts 注入 callSessionManager('watch')——不传 timeout、fire-and-forget） */
	callWatch(ctx: ExtensionContext, notifyId: string): Promise<MarkerRpcResult>;
}

export interface WatchCoordinator {
	/** 工具结果成功后的 arm：register + 开表（顺序固定——C-5 微窗方向 = 查询面先少计不产幽灵） */
	armSessionNotify(ctx: ExtensionContext, notifyId: string, name: string): void;
	/** sessionId → label 缓存回填（create 入参 / list 结果；send 的 name 与文案 label 源） */
	noteLabel(sessionId: string, label: string): void;
	/** 读 label 缓存（缺席回退 sessionId——label 降级路径，见交付偏差登记） */
	labelFor(sessionId: string): string;
	/** session_start 重启收口腿（D7③）：活跃 type 'session' register 逐条重开 watch */
	recoverStaleRegisters(ctx: ExtensionContext): void;
}

export function createWatchCoordinator(deps: WatchCoordinatorDeps): WatchCoordinator {
	const { pi } = deps;
	/** label 缓存（sessionId → label）：正常路径文案 label 的数据源（D9 label 两路径之一）。
	 *  @data-owner #1（data-source-registry.md）：label 数据在扩展进程的只读消费副本，
	 *  权威源仍是 pi sessionName（登记表主表 #1），本缓存无回写；写方 = noteLabel 单点
	 *  回填（create 入参 / list 结果），生命周期随 coordinator 实例（pi 进程级）。 */
	const labels = new Map<string, string>();
	/** 死亡新闻槽 (sessionId, deathSeq) 去重集合（ADR-0074 关键被否④的槽键消解机制）：
	 *  技术簿记 W24-EX-C（data-source-registry.md §4⑧），非 GUI 数据——键单调不重放、
	 *  槽位消费一次即终局，无消费点清理（集合容量 = 进程生命周期内死亡事件数），生命周期
	 *  随 coordinator 实例（pi 进程级）。 */
	const deathSlots = new Set<string>();
	let queue: QueuedRespond[] = [];
	let flushTimer: ReturnType<typeof setTimeout> | undefined;

	function noteLabel(sessionId: string, label: string): void {
		labels.set(sessionId, label);
	}

	function labelFor(sessionId: string): string {
		return labels.get(sessionId) ?? sessionId;
	}

	function registerPending(id: string, name: string): void {
		try {
			pi.events.emit("pending:register", { id, type: "session", name });
		} catch (err) {
			// emit 失败（stale bus）不阻断 arm——watch 照开，应答侧 unregister 幂等兜底；
			// warn 留痕（STANDARDS §11.2 静默丢弃必须登记）
			logger.warn("[session-manager] pending:register emit failed (stale bus?)", {
				id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/** unregister：reason 传 watch 应答原词——写侧（pending-notifications listener）经
	 *  protocol mapReasonToStatus 族映射落 status，新 reason 不落 default 误标。 */
	function unregisterPending(id: string, reason: string): void {
		try {
			pi.events.emit("pending:unregister", { id, reason });
		} catch (err) {
			logger.warn("[session-manager] pending:unregister emit failed (stale bus?)", {
				id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	function armSessionNotify(ctx: ExtensionContext, notifyId: string, name: string): void {
		registerPending(notifyId, name);
		openWatch(ctx, notifyId, name);
	}

	/** 开表：fire-and-forget（D2/P1：不传 timeout 长挂不死；被覆盖的悬 promise 已知无害）。
	 *  每次调用独立 handler——收口腿禁串行 await 链的实现基础（D7③ 编排纪律）。 */
	function openWatch(ctx: ExtensionContext, notifyId: string, label: string): void {
		void deps.callWatch(ctx, notifyId).then(
			(result) => {
				try {
					handleRespond(notifyId, label, result);
				} catch (err) {
					logger.error("[session-manager] watch respond handling failed", {
						notifyId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
			(err: unknown) => {
				logger.warn("[session-manager] watch select rejected", {
					notifyId,
					error: err instanceof Error ? err.message : String(err),
				});
			},
		);
	}

	function handleRespond(notifyId: string, label: string, result: MarkerRpcResult): void {
		if (!result.ok) {
			// cancelled/timeout = 应答未达（session 销毁等 select 侧折叠）——不动 pending，
			// 残留由下次 session_start 收口腿清（D7③ / 附录 C-9 的清理通道）。
			// non-json/channel-error = 应答已到但不可解析 → 折叠 cancelled 清 stale register。
			if (result.reason === "non-json" || result.reason === "channel-error") {
				logger.warn("[session-manager] watch respond unusable — folding cancelled", {
					notifyId,
					reason: result.reason,
				});
				unregisterPending(notifyId, "cancelled");
			}
			return;
		}
		// 读侧不信任外部格式（AGENTS 关键规则 5），null 与畸形/词表外拆开处置：
		//   ① null（旧 runtime 象限，respond null → JSON "null"）是 D6 兼容矩阵的显式
		//      静默豁免——折叠 cancelled 收口、不 warn（非漂移信号，不伪造死亡通知）；
		//   ② 畸形对象 / 词表外 reason / error envelope {error,...}（runtime params 守卫
		//      拒绝态）= 协议漂移信号 → 必须 warn 留痕（同上方 non-json/channel-error
		//      分支形态：notifyId + 漂移形态摘要），再折叠 cancelled 清 stale register。
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.value);
		} catch {
			// unreachable 防御（callMarkerRpc ok:true 已过 JSON 合法性检测）——真到即漂移
			logger.warn(
				"[session-manager] watch respond unparsable — folding cancelled (protocol drift)",
				{ notifyId, drift: "unparsable-json" },
			);
			unregisterPending(notifyId, "cancelled");
			return;
		}
		if (parsed === null) {
			unregisterPending(notifyId, "cancelled");
			return;
		}
		if (!isSessionManagerWatchRespondPayload(parsed)) {
			logger.warn(
				"[session-manager] watch respond malformed/out-of-vocab — folding cancelled (protocol drift)",
				{ notifyId, drift: describeRespondDrift(parsed) },
			);
			unregisterPending(notifyId, "cancelled");
			return;
		}
		const reason = parsed.reason;
		if (reason === "cancelled" || reason === "orphaned") {
			// 例外1：静默（主 abort 销账 / 归属失效 / fail-closed / orphan 吸收态）——
			// 逐笔即时 unregister，不入攒批窗、不 record、不动死亡槽。
			unregisterPending(notifyId, reason);
			return;
		}
		// completed/failed/stopped（结果新闻）与 exited/deleted（死亡新闻）入窗攒批
		queue.push({ notifyId, label, reason, payload: parsed });
		scheduleFlush();
	}

	function scheduleFlush(): void {
		if (flushTimer !== undefined) clearTimeout(flushTimer);
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			flush();
		}, WATCH_FLUSH_DEBOUNCE_MS);
	}

	function flush(): void {
		const items = queue;
		queue = [];
		if (items.length === 0) return;
		// 两层模型（D3）：① 分拣键 (sessionId, reason) 定处理类别；② 批身份 settleSeq/
		// deathSeq 定 record 边界（同批身份才合一条 record——跨轮同 status 合流由 seq
		// 边界排除，防违背 A7）。Map 保序：先到的分拣组先占死亡槽（例外2 的「首条」语义）。
		const sortGroups = new Map<string, QueuedRespond[]>();
		for (const item of items) {
			const sortKey = `${item.payload.sessionId ?? ""} ${item.reason}`;
			const group = sortGroups.get(sortKey);
			if (group) group.push(item);
			else sortGroups.set(sortKey, [item]);
		}
		for (const group of sortGroups.values()) {
			const reason = group[0].reason;
			const isDeath = reason === "exited" || reason === "deleted";
			const batchGroups = new Map<number, QueuedRespond[]>();
			for (const item of group) {
				const seq = (isDeath ? item.payload.deathSeq : item.payload.settleSeq) ?? -1;
				const batch = batchGroups.get(seq);
				if (batch) batch.push(item);
				else batchGroups.set(seq, [item]);
			}
			for (const batch of batchGroups.values()) {
				flushBatch(batch, isDeath);
			}
		}
	}

	function flushBatch(batch: QueuedRespond[], isDeath: boolean): void {
		const first = batch[0];
		const reason = first.reason;
		if (isDeath) {
			// 例外2：死亡新闻槽 (sessionId, deathSeq) 键去重——同键首条 record 死亡新闻，
			// 后续仅 unregister（content 确定性：kind 不再决定文案，消除到达序 nondeterminism；
			// arm→watch 微窗竞态下迟到 watch 不二次发声）。
			const slot = deathSlotKey(
				first.payload.sessionId ?? "",
				first.payload.deathSeq ?? -1,
			);
			if (deathSlots.has(slot)) {
				for (const item of batch) unregisterPending(item.notifyId, reason);
				return;
			}
			deathSlots.add(slot);
		}
		const sessionId = first.payload.sessionId;
		if (sessionId === undefined) {
			// 协议不变量（D-4：非 cancelled 应答恒带 sessionId）的防御分支——违反即降级
			// unregister-only + warn，不产出 (undefined) 文案。
			logger.warn("[session-manager] watch respond missing sessionId — record skipped", {
				notifyId: first.notifyId,
				reason,
			});
			for (const item of batch) unregisterPending(item.notifyId, reason);
			return;
		}
		const fulfills = first.payload.fulfillsN ?? batch.length;
		const content = buildManagedNotifyContent({
			label: first.label,
			sessionId,
			status: reason,
			fulfills,
			sessionFilePath: first.payload.sessionFilePath,
			exitCode: first.payload.exitCode,
			stderrTail: first.payload.stderrTail,
		});
		const details: ManagedNotifyDetails = {
			notifyId: first.notifyId,
			sessionId,
			reason,
			fulfills,
			label: first.label,
		};
		// 默认 record（B-ledger ①）；record false（幂等拒收 / 槽空降级）不改 unregister 语义
		recordManagedNotify(first.notifyId, content, details);
		for (const item of batch) unregisterPending(item.notifyId, reason);
	}

	function recoverStaleRegisters(ctx: ExtensionContext): void {
		let entries: readonly unknown[];
		try {
			entries = ctx.sessionManager.getEntries();
		} catch (err) {
			logger.warn("[session-manager] session_start recovery failed to read entries", {
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		// 活跃判定与 pending-notifications/goal 消费同一 protocol 差集单点（防两份实现漂移）
		const active = applyPendingDiff(scanPendingEntries([...entries]));
		for (const { data } of active) {
			if (data["type"] !== "session") continue;
			const id = data["id"];
			if (typeof id !== "string") continue;
			const rawName = data["name"];
			const name = typeof rawName === "string" && rawName !== "" ? rawName : id;
			// 每 entry 独立 fire-and-forget handler（openWatch 内部各自 .then），无任何
			// await 链——W1 悬置（被 W2 覆盖 / 永不应答）不阻塞后续 entry 的开表（D7③）。
			openWatch(ctx, id, name);
		}
	}

	return { armSessionNotify, noteLabel, labelFor, recoverStaleRegisters };
}
