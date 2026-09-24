/**
 * session_start pending 对账 + 完成通知补投（M3 §3.5 接入细则第 4 条 +
 * bg-task-notify-durability 设计 §5 U2/U3）。
 *
 * 职责一（既有）：对「session entries 差集显示 active、但任务已终态」的 bt- 任务补写
 * pending:unregister entry。覆盖三类 otherwise 悬空场景（设计原文）：
 *  ① 进程 graceful 退出收殓时 pi API 已不可用，unregister 没写成 entry；
 *  ② 强杀后收殓侧只改 registry（标 orphaned），碰不了 session 文件；
 *  ③ fork 后任务完成通知写进新 session，旧 session 文件的 register 成僵尸。
 *
 * 收尾写法（权威路径）：直接 pi.appendEntry("pending:unregister", {id, reason,
 * status})——**appendEntry 即唯一权威路径**：appendEntry 同步入账（pi dist 实证）
 * 且不依赖 listener 存活，差集消费方 goal 从持久化 entries 算差集
 * （agent-end.ts getEntries()），对守卫直接生效，无不一致窗口。（尽力补 emit 的
 * 第二写路径已随 ext-simplify-13 删除：pending unregister listener 的落盘前置
 * isPendingActive 对 entries 现算——其内存 registry/rebuild 已随 ext-simplify-12
 * 删除——而对账 appendEntry 同步入账先于 emit 执行，emit 到达时该 id 必已注销
 * = 恒 no-op 死路径。）
 *
 * 职责二（补投，设计决策 1/2）：对「registry 严格终态（非 killed）∧ 会话 entries
 * 无送达痕迹 ∧ 无补投标记」的后台任务，合并成一条消息补投完成通知，resolve 后
 * 同步写补投标记 entry 保幂等。覆盖的失效面 = 主路径单次投递丢失（进程死亡收殓、
 * 投递 throw、投递被接受但未落盘即崩溃）。**补投是 registry 全集的独立遍历，不挂
 * pending 差集循环**（决策 2）：差集候选 = pending:register 还挂着的任务，而失效
 * 形态「poller 边沿 unregister 已写、sendMessage 才 throw」下差集为空，挂靠即永久
 * 漏补。补投**不代写 pending:unregister**——收尾保持差集循环唯一写点（避免绕过
 * listener 的 isPendingActive 幂等门落冗余 entry）。
 *
 * 差集判据单点（ext-simplify-13）：collectActivePendingIds（protocol
 * pending-entries 模块，与 pending-notifications 守卫判据同源）+ bt- 前缀过滤；
 * 本地差集副本已删除。task_id 前缀亦消费 protocol 契约常量
 * BACKGROUND_TASK_ID_PREFIX（§2.3，区别于 subagent-workflow 的 bg-/run-）。
 *
 * 补投终态判据（决策 2）：protocol isTerminalState 严格终态（exited/orphaned）——
 * **显式不用下方 isTerminalByRegistry 宽判据**（宽判据含 running/killing 且 pid 判死，
 * 会把 killing 遗留——kill 已发令、poller 终态化前进程死亡，实为被杀任务——误判为
 * 可补投）；且 state=exited 时 reason≠killed（killed 是 reason 枚举值而非独立
 * state，state 级过滤排不掉，必须 reason 级显式排除——kill 的发起方当次交互已同步
 * 获知结果，补投是重复刺激）。killing/running+判死遗留不补投（保守正确，退化现状）。
 *
 * 补投幂等三配套（决策 1，缺一被双派发反例击穿）：
 *  ① await sendMessage——见 ReconcilePi.sendMessage 注释的实装适配登记；
 *  ② 进程内 in-flight 单飞守卫（模块级 Set 按 taskId 键控）：同一次激活是
 *     startup+resume 双派发，第二路对账落在第一路补投的 await 窗口内，若不挡会
 *     再调 sendMessage（此刻 agent 循环进行中，消息不落盘）且三判据仍全命中
 *     （标记未写、痕迹未落盘）——按 taskId 键控天然消解同进程 session 替换时旧
 *     会话 in-flight 误挡新会话的窗口。跳过粒度仅补投扫描，差集循环照常执行。
 *     摘除绑定 sendMessage settle（finally），不绑「激活结束」；纯内存跨激活无
 *     状态，进程死亡自然清零；
 *  ③ resolve 后同步 appendEntry 补投标记——同步入账使后续任何对账立即收敛。
 *
 * 执行链（index.ts session_start 链内）：收殓下沉 runtime 后（u-bte-remove）本链
 * 仅剩对账 + 补投——「对账见 running+pid 活则不动作，下一 session_start 兜底」的
 * 幂等语义覆盖孤儿终态由 runtime 异步写入的时序窗口。补投先于差集收尾（先通知后
 * 清观察面），差集收尾无条件执行（幂等语义不依赖补投成败，两者无隐藏耦合）。
 */

import {
	BACKGROUND_TASK_ID_PREFIX,
	collectActivePendingIds,
	mapReasonToStatus,
} from "@zhushanwen/extension-protocol";
import { isPidAlive } from "@zhushanwen/extension-protocol/background-task";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import {
	buildReconciledMarkerData,
	collectDeliveredTaskIds,
	collectReconciledTaskIds,
	RECONCILED_MARKER_CUSTOM_TYPE,
} from "./notify-reconcile-judgement.ts";
import {
	BACKGROUND_BASH_CUSTOM_TYPE,
	buildNotificationContent,
	buildNotifyDetails,
	buildTerminatedNotificationLine,
	toPendingReason,
} from "./notify.ts";
import { getRegistryPath, readRegistry } from "./registry.ts";
import { isActiveState, isTerminalState, type RegistryEntry } from "./types.ts";

const logger = getLogger("base-tool-enhance");

/**
 * 对账依赖的最小 pi 面（结构兼容 ExtensionAPI 的子集；测试注入不造完整 pi）。
 *
 * sendMessage 返回类型 `void | Promise<void>` 是 pi 0.84.4 实装的适配登记
 * （bg-task-notify-durability 实装核实）：ExtensionAPI.sendMessage 的类型声明与
 * loader.js:296 / agent-session.js:2004 两级桥接均不返回 promise（bindCore 包装层
 * 以 .catch 吞 rejection 转 runner emitError），真实 pi 注入时恒返回 undefined——
 * 「await resolve 即已落盘」在实装通道上拿不到。await 两者皆合法：
 *  - 同步 throw（assertActive 失败 / 旧 bus）在调用点抛出，可捕；
 *  - Promise rejection（若未来 pi 透传 / 测试 mock）可 await 捕获；
 *  - 实装下 await undefined 立即通过，标记写入退到「调用返回后」——落盘时序核实
 *    （message_end 落盘先于 LLM 循环）使残余失败域收窄为 agent 循环 start 阶段
 *    失败（主形态 = 双派发穿透，由 in-flight 守卫挡在 sendMessage 之前），残余
 *    由设计决策 6 止损路径包络（下次激活重试语义保持）。
 */
export interface ReconcilePi {
	appendEntry(customType: string, data?: unknown): void;
	sendMessage(
		message: { customType: string; content: string; display: boolean; details?: unknown },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void | Promise<void>;
}

/** 对账结果（日志 + 测试断言面）。 */
export interface ReconcileResult {
	/** 补写 pending:unregister entry 的任务数。 */
	reconciled: number;
	/** 差集 active 但判据不满足（活任务 / registry 无条目）而保守跳过的 task_id。 */
	skipped: string[];
	/** 补投消息已成功送达（sendMessage settle 通过，同步 throw 与 await reject 均不计入）的 task_id——实装桥接层丢 promise，不等于 pi 侧已落盘，见 ReconcilePi.sendMessage 注释。 */
	redelivered: string[];
}

/**
 * 补投 in-flight 单飞守卫（决策 1 配套②）：模块级按 taskId 键控。双派发的两路
 * handler 共享同一模块实例（factory 二调形态），模块级状态对它们可见。
 */
const inflightRedeliveries = new Set<string>();

/** 测试专用：清空 in-flight 守卫（跨测试文件残留清理）。 */
export function resetRedeliveryInFlightForTest(): void {
	inflightRedeliveries.clear();
}

/**
 * 对账主体（session_start 维护链入口）。补投（可能 await sendMessage）先于差集
 * 收尾；差集收尾无条件执行。每个僵尸任务 appendEntry 一次（唯一权威写路径）。
 */
export async function reconcilePendingEntries(
	pi: ReconcilePi,
	dataDir: string,
	sessionId: string,
	entries: unknown[],
): Promise<ReconcileResult> {
	const result: ReconcileResult = { reconciled: 0, skipped: [], redelivered: [] };

	// ① 补投扫描（独立遍历 registry 全集，先通知后清观察面）
	await redeliverMissingNotifications(pi, dataDir, sessionId, entries, result);

	// ② 既有 pending 差集循环（无条件执行；unregister 收尾的唯一写点）
	const unsettled = collectActivePendingIds(entries, { idPrefix: BACKGROUND_TASK_ID_PREFIX });
	if (unsettled.size === 0) return result;

	const registry = readRegistry(getRegistryPath(dataDir, sessionId));
	for (const id of unsettled) {
		const entry = registry.get(id);
		if (entry === undefined) {
			// registry 无条目：终态无从判定（LRU 淘汰的终态条目其 unregister entry 应已
			// 落盘，差集里还出现 = spawn 后 registry 写失败等罕见路径）——保守不动作，
			// pending-notifications 已无任何 TTL 清理，差集残留由 next-session 对账重查收口。
			// warn 是设计决策 6 的 LRU 淘汰重审触发观测落点（含 taskId；此前该形态零日志）
			logger.warn(
				"pending reconcile: registry has no entry for a pending bt- id (LRU-evicted or spawn-write failure); unregister stays pending",
				{ detail: { taskId: id } },
			);
			result.skipped.push(id);
			continue;
		}
		if (!isTerminalByRegistry(entry)) {
			// D12 活任务（running/killing 且 pid 活）：任务跨 session 替换续存，不收尾
			result.skipped.push(id);
			continue;
		}
		const pendingReason = settledPendingReason(entry);
		try {
			// status 经 protocol mapReasonToStatus 单点映射（ext-simplify-17 D10）：与
			// pending-notifications unregister listener 同一函数——原 status === reason 的
			// identity 假设在非 identity reason（budget_limited→failed 等）上会静默漂移
			pi.appendEntry("pending:unregister", {
				id,
				reason: pendingReason,
				status: mapReasonToStatus(pendingReason),
			});
		} catch (err) {
			logger.warn("reconcile appendEntry failed; retry on next session_start", {
				detail: { id, err: toErrorMessage(err) },
			});
			continue;
		}
		result.reconciled++;
	}
	if (result.reconciled > 0) {
		logger.debug("pending reconcile settled zombie registers", {
			detail: { reconciled: result.reconciled, skipped: result.skipped.length },
		});
	}
	return result;
}

/** 终态判据（§3.5 接入细则 4 原文）：registry 终态，或 active 状态但 pid 已判死。 */
function isTerminalByRegistry(entry: RegistryEntry): boolean {
	if (isTerminalState(entry.state)) return true;
	return isActiveState(entry.state) && !isPidAlive(entry.pid);
}

/**
 * 收尾 reason 映射（reason→status 的第二跳在写点经 protocol mapReasonToStatus 单点）：
 *  - exited：按条目 reason/exitCode 走 toPendingReason（与 exit 边沿 emit 同一映射，
 *    两路径写出的 entry 语义一致）；reason 缺失按 cancelled 处理（防御分支，正常路径
 *    finalize 必写 reason）
 *  - orphaned / running+判死：cancelled（任务非自身成败地终止/消失）
 */
function settledPendingReason(entry: RegistryEntry): "completed" | "failed" | "time_limited" | "cancelled" {
	if (entry.state === "exited" && entry.reason !== undefined) {
		return toPendingReason(entry.reason, entry.exitCode ?? null);
	}
	return "cancelled";
}

/**
 * 补投扫描（决策 2：registry 全集独立遍历）。候选 = 严格终态 ∧ 非 killed ∧ 双锚
 * （送达痕迹 / 补投标记）皆无 ∧ 不在 in-flight。命中者合并为一条消息投递（对齐
 * NotifyLedger 同批合并先例，避免 N 个任务驱动 N 个 LLM turn 排队），resolve 后
 * 逐任务同步写补投标记。任一环节失败（同步 throw / await reject / 标记写失败）：
 * warn 日志（含 taskId 与失败类别），不写标记，下次 session_start 重试。
 */
async function redeliverMissingNotifications(
	pi: ReconcilePi,
	dataDir: string,
	sessionId: string,
	entries: unknown[],
	result: ReconcileResult,
): Promise<void> {
	const registry = readRegistry(getRegistryPath(dataDir, sessionId));
	if (registry.size === 0) return;

	const delivered = collectDeliveredTaskIds(entries);
	const reconciled = collectReconciledTaskIds(entries);

	const candidates: RegistryEntry[] = [];
	for (const entry of registry.values()) {
		if (!isRedeliveryCandidate(entry, delivered, reconciled)) continue;
		if (inflightRedeliveries.has(entry.taskId)) {
			// 同激活第二路对账（双派发）落在第一路补投的 await 窗口内——跳过该任务的
			// 补投（差集循环不受影响）。debug 是设计决策 6 in-flight 残留边界的观测落点
			logger.debug("background task notify redelivery in-flight; skipping duplicate reconcile pass", {
				detail: { taskId: entry.taskId },
			});
			continue;
		}
		candidates.push(entry);
	}
	if (candidates.length === 0) return;

	const message = buildRedeliveryMessage(candidates);
	const taskIds = candidates.map((entry) => entry.taskId);
	for (const id of taskIds) inflightRedeliveries.add(id);
	try {
		// 决策 1 配套①：同步 throw 与 await reject 分开捕——失败类别进 warn 日志，
		// 两类统一不写标记（下次激活重试；判据三条件仍命中才会再投）
		let sent: void | Promise<void>;
		try {
			sent = pi.sendMessage(
				{ customType: BACKGROUND_BASH_CUSTOM_TYPE, content: message.content, display: true, ...(message.details !== undefined ? { details: message.details } : {}) },
				{ deliverAs: "steer", triggerTurn: true },
			);
		} catch (err) {
			logger.warn("background task notify redelivery sendMessage threw synchronously; no marker written, retry on next session_start", {
				detail: { taskIds, err: toErrorMessage(err) },
			});
			return;
		}
		try {
			await sent;
		} catch (err) {
			logger.warn("background task notify redelivery sendMessage rejected; no marker written, retry on next session_start", {
				detail: { taskIds, err: toErrorMessage(err) },
			});
			return;
		}
		// 配套③：resolve 后同步写标记（appendEntry 同步入账）——后续任何对账立即收敛。
		// 逐任务独立 try/catch：单条标记写失败只跳过该任务的重试收尾（下次激活重投；
		// 若消息实际已落盘则痕迹命中判重，不会重复——仅「消息真丢了」才重投，语义正确）
		for (const entry of candidates) {
			try {
				pi.appendEntry(RECONCILED_MARKER_CUSTOM_TYPE, buildReconciledMarkerData(entry.taskId, Date.now()));
			} catch (err) {
				logger.warn("background task notify reconciled marker appendEntry failed; redelivery may repeat on next session_start", {
					detail: { taskId: entry.taskId, err: toErrorMessage(err) },
				});
			}
		}
		result.redelivered.push(...taskIds);
	} finally {
		// 摘除绑定 sendMessage settle（resolve/reject/同步 throw 皆经此），非「激活结束」；
		// 摘除记 debug（决策 6 in-flight 残留边界的配对观测）
		for (const id of taskIds) {
			inflightRedeliveries.delete(id);
			logger.debug("background task notify redelivery settled; in-flight guard released", {
				detail: { taskId: id },
			});
		}
	}
}

/**
 * 补投候选判据（决策 1/2 的三条件 + killed reason 级排除）。判据不查 in-flight
 * （守卫是执行面关注点，独立于候选语义），调用方负责。
 */
function isRedeliveryCandidate(entry: RegistryEntry, delivered: Set<string>, reconciled: Set<string>): boolean {
	// 严格终态：protocol isTerminalState（exited/orphaned）——不用 isTerminalByRegistry
	// 宽判据（含 running/killing+pid 判死，killing 遗留实为被杀任务，误判即违背
	// killed 不补投设计意图）
	if (!isTerminalState(entry.state)) return false;
	// killed 是 exited 的 reason 枚举值而非独立 state，state 级过滤排不掉——reason 级
	// 显式排除（bash_kill 发令方当次交互已同步获知结果，补投是重复刺激）
	if (entry.state === "exited" && entry.reason === "killed") return false;
	// 双锚判重：送达痕迹在（正常送达/历史补投的消息在）/ 补投标记在——任一命中不再投
	if (delivered.has(entry.taskId)) return false;
	if (reconciled.has(entry.taskId)) return false;
	return true;
}

/**
 * 补投消息组装（设计 §3.1 三分支，决策 4）：
 *  - 单任务且真实终态（exited natural/timeout）：与正常投递同款结构化消息（同
 *    details 载荷，renderer SystemNotice 结构化渲染正常工作）；
 *  - 单任务收殓终态（process-exit/orphaned）或多任务合并：整条无 details（details
 *    载荷只描述单任务，混合/复数场景携带任一任务的 details 会产生「结构化行只讲
 *    一个任务、其余沉入降级文本」的错位形态），纯文本行逐任务列终态行——exited
 *    真终态行复用 buildNotificationContent 的 content 文本（禁止把 exit 0 正常完成
 *    套 terminated 措辞谎报），收殓终态行用 terminated 措辞。
 */
function buildRedeliveryMessage(candidates: RegistryEntry[]): { content: string; details?: unknown } {
	const single = candidates.length === 1 ? candidates[0] : undefined;
	if (single !== undefined && isGenuineExit(single)) {
		return {
			content: buildNotificationContent(single),
			details: buildNotifyDetails(single),
		};
	}
	const content = candidates
		.map((entry) => (isGenuineExit(entry) ? buildNotificationContent(entry) : buildTerminatedNotificationLine(entry)))
		.join("\n");
	return { content };
}

/** 真实终态：exited 且成因是自然退出/超时（process-exit 是收殓终止，不算）。 */
function isGenuineExit(entry: RegistryEntry): boolean {
	return entry.state === "exited" && (entry.reason === "natural" || entry.reason === "timeout");
}
