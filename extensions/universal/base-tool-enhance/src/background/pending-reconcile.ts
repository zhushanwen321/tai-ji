/**
 * session_start pending 对账 + 收殓终态通知补投（M3 §3.5 接入细则第 4 条 +
 * unified-delivery D3 裁决 1 / §5 波 3，设计 .tmp/tech-design/unified-delivery.md）。
 *
 * 职责一（既有）：对「session entries 差集显示 active、但任务已终态」的 bt- 任务补写
 * pending:unregister entry。覆盖三类 otherwise 悬空场景：
 *  ① 进程 graceful 退出收殓时 pi API 已不可用，unregister 没写成 entry；
 *  ② 强杀后收殓侧只改 registry（标 orphaned），碰不了 session 文件；
 *  ③ fork 后任务完成通知写进新 session，旧 session 文件的 register 成僵尸。
 *
 * 收尾写法（权威路径）：直接 pi.appendEntry("pending:unregister", {id, reason,
 * status})——**appendEntry 即唯一权威路径**：appendEntry 同步入账（pi dist 实证）
 * 且不依赖 listener 存活，差集消费方 goal 从持久化 entries 算差集
 * （agent-end.ts getEntries()），对守卫直接生效，无不一致窗口。（尽力补 emit 的
 * 第二写路径已随 ext-simplify-13 删除：pending unregister listener 的落盘前置
 * isPendingActive 对 entries 现算，而对账 appendEntry 同步入账先于 emit 执行，emit
 * 到达时该 id 必已注销 = 恒 no-op 死路径。）
 *
 * 职责二（收殓终态通知补投，D3 裁决 1）：对「registry 终态 = 收殓（exited
 * process-exit / orphaned）∧ 会话 entries 无送达痕迹」的后台任务，逐任务经
 * port.deliver 补投终态通知（id = taskId 幂等键、terminated 措辞、无业务 details）。
 * 收殓终态无 outbox 条目（收殓时 pi API 不可用不投递），port 的差集重放无从覆盖——
 * 本路径是收殓终态通知的唯一生产者。真实终态（natural/timeout）与投递 throw 形态
 * 已随波 3 退役出补投：主路径入账后丢失由 port 的 outbox 差集重放覆盖（受理前落盘
 * + details-id 凭据未命中即差集）。
 *
 * 幂等体系（随载体换 port 收敛）：旧「补投标记 entry + in-flight 单飞守卫」退役——
 * 防双投由 port 幂等接管（deliver 幂等预检 + 内核三级判重 + outbox/ack 终态列）：
 * 同激活双派发的第二路 deliver 同 id 被 port 吞（swallowed）；已送达任务由送达痕迹
 * 判据阻断（通知消息的 details.taskId / content bt- token 在 entries）。旧 marker
 * 「标记在而消息丢」的残余失败域随之修复：marker 不再是判据，丢失的消息按痕迹判据
 * 重投。port 缺席（装配异常窗口）= 跳过 + warn：补投有自愈通道（判据仍命中，下一
 * session_start 幂等重投），不做无幂等保护的直发兜底（双派发窗口双投）。
 *
 * 差集判据单点（ext-simplify-13）：collectActivePendingIds（protocol
 * pending-entries 模块，与 pending-notifications 守卫判据同源）+ bt- 前缀过滤；
 * 送达痕迹提取单点 = notify-reconcile-judgement.ts collectDeliveredTaskIds。
 * task_id 前缀亦消费 protocol 契约常量 BACKGROUND_TASK_ID_PREFIX（§2.3，区别于
 * subagent-workflow 的 bg-/run-）。
 *
 * 执行链（index.ts session_start 链内）：收殓下沉 runtime 后（u-bte-remove）本链
 * 仅剩对账 + 收殓补投——「对账见 running+pid 活则不动作，下一 session_start 兜底」
 * 的幂等语义覆盖孤儿终态由 runtime 异步写入的时序窗口。补投先于差集收尾（先通知后
 * 清观察面），差集收尾无条件执行（幂等语义不依赖补投成败，两者无隐藏耦合）。
 */

import {
	BACKGROUND_TASK_ID_PREFIX,
	collectActivePendingIds,
	mapReasonToStatus,
} from "@zhushanwen/extension-protocol";
import { isPidAlive } from "@zhushanwen/extension-protocol/background-task";
import { getDeliveryPort } from "@zhushanwen/pi-delivery-port";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { collectDeliveredTaskIds } from "./notify-reconcile-judgement.ts";
import {
	BACKGROUND_BASH_CUSTOM_TYPE,
	buildTerminatedNotificationLine,
	toPendingReason,
} from "./notify.ts";
import { getRegistryPath, readRegistry } from "./registry.ts";
import { isActiveState, isTerminalState, type RegistryEntry } from "./types.ts";

const logger = getLogger("base-tool-enhance");

/**
 * 对账依赖的最小 pi 面（结构兼容 ExtensionAPI 的子集；测试注入不造完整 pi）。
 * 投递面已随波 3 换 port（ReconcileDeliver），本接口只剩 appendEntry 权威写路径。
 */
export interface ReconcilePi {
	appendEntry(customType: string, data?: unknown): void;
}

/**
 * port.deliver 的结构最小面（与 @zhushanwen/pi-delivery-port 的
 * DeliveryPortHandle.deliver 结构兼容——调用方传 getDeliveryPort()!.deliver 直接
 * 赋值合法；本模块不 import port 包运行时对象，缺省值单点在 reconcilePendingEntries
 * 参数缺省表达式）。
 */
export type ReconcileDeliver = (envelope: {
	/** 幂等键（收殓补投恒 = taskId）。 */
	id?: string;
	/** 期望注入时机（收殓补投恒 steer 档——session_start 时 agent 空闲即起轮）。 */
	timing?: "steer" | "followUp";
	payload: {
		kind: "custom";
		customType: string;
		content: string;
		display: boolean;
		details?: unknown;
	};
}) =>
	| { kind: "accepted"; id: string }
	| { kind: "swallowed"; reason: string }
	| { kind: "rejected"; reason: string };

/** 对账结果（日志 + 测试断言面）。 */
export interface ReconcileResult {
	/** 补写 pending:unregister entry 的任务数。 */
	reconciled: number;
	/** 差集 active 但判据不满足（活任务 / registry 无条目）而保守跳过的 task_id。 */
	skipped: string[];
	/** 收殓终态通知经 port.deliver 补投受理（accepted）的 task_id。 */
	redelivered: string[];
}

/**
 * 对账主体（session_start 维护链入口）。收殓补投先于差集收尾；差集收尾无条件执行。
 * 每个僵尸任务 appendEntry 一次（唯一权威写路径）。
 *
 * deliver 缺省取进程级槽当前实例（session_start 已装配 port——index.ts 装配点先于
 * 本链执行）；显式传参供测试注入。
 */
export async function reconcilePendingEntries(
	pi: ReconcilePi,
	dataDir: string,
	sessionId: string,
	entries: unknown[],
	deliver: ReconcileDeliver | undefined = getDeliveryPort()?.deliver,
): Promise<ReconcileResult> {
	const result: ReconcileResult = { reconciled: 0, skipped: [], redelivered: [] };

	// ① 收殓终态通知补投（先通知后清观察面；幂等由 port 承管，同步无 await）
	deliverReapNotifications(deliver, dataDir, sessionId, entries, result);

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
 * 收殓终态通知补投（D3 裁决 1：registry 全集独立遍历，不挂 pending 差集循环——差集
 * 候选 = pending:register 还挂着的任务，而收殓形态「exit 边沿 unregister 已写、
 * 通知从未投出」下差集为空，挂靠即永久漏补）。逐任务经 port.deliver（幂等键 = taskId）：
 * accepted 计入 redelivered；swallowed = port 幂等命中（同 id 已在途/已终局）正常
 * 收敛；rejected = 未受理（outbox 未落）warn 留痕——判据仍命中，下一 session_start
 * 幂等重投。
 */
function deliverReapNotifications(
	deliver: ReconcileDeliver | undefined,
	dataDir: string,
	sessionId: string,
	entries: unknown[],
	result: ReconcileResult,
): void {
	if (deliver === undefined) {
		// port 缺席（装配异常 / 版本混装窗口）：跳过 + warn（修复信号）。补投有自愈
		// 通道（判据仍命中，下一 session_start 重投），不做无幂等保护的直发兜底。
		logger.warn("pending reconcile reap-notify skipped: delivery port absent (assembly anomaly?); retried next session_start");
		return;
	}
	const registry = readRegistry(getRegistryPath(dataDir, sessionId));
	if (registry.size === 0) return;

	const delivered = collectDeliveredTaskIds(entries);
	for (const entry of registry.values()) {
		if (!isReapNotifyCandidate(entry, delivered)) continue;
		const receipt = deliver({
			id: entry.taskId,
			timing: "steer",
			payload: {
				kind: "custom",
				customType: BACKGROUND_BASH_CUSTOM_TYPE,
				content: buildTerminatedNotificationLine(entry),
				display: true,
			},
		});
		if (receipt.kind === "accepted") {
			result.redelivered.push(entry.taskId);
		} else if (receipt.kind === "rejected") {
			logger.warn("pending reconcile reap-notify rejected by delivery port; retried next session_start", {
				detail: { taskId: entry.taskId, reason: receipt.reason },
			});
		}
	}
}

/**
 * 收殓补投候选判据：终态 = 收殓（orphaned，或 exited 且成因 = process-exit）∧ 送达
 * 痕迹未命中。
 *
 *  - 真实终态（exited natural/timeout）不是候选：主路径已入账（outbox），丢失由 port
 *    差集重放覆盖（波 3 补投退役，D3 裁决 1）。
 *  - killed 由「exited 分支只认 process-exit」结构性排除（killed 是 exited 的 reason
 *    枚举值——kill 发令方当次交互已同步获知结果，补投是重复刺激，老能力映射 #10
 *    result 类 silent）。
 *  - killing/running+判死遗留不是候选（非严格终态；退化现状，由 unregister 收尾兜底）。
 */
function isReapNotifyCandidate(entry: RegistryEntry, delivered: Set<string>): boolean {
	const isReaped =
		entry.state === "orphaned" || (entry.state === "exited" && entry.reason === "process-exit");
	if (!isReaped) return false;
	// 送达痕迹在（主路径/历史补投的通知消息在 entries）→ 不再投
	if (delivered.has(entry.taskId)) return false;
	return true;
}
