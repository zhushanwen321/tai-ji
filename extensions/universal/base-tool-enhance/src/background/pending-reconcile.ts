/**
 * session_start pending 对账（M3，§3.5 接入细则第 4 条——pending 收尾的统一兜底）。
 *
 * 职责：对「session entries 差集显示 active、但任务已终态」的 bt- 任务补写
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
 * 差集判据单点（ext-simplify-13）：collectActivePendingIds（protocol
 * pending-entries 模块，与 pending-notifications 守卫判据同源）+ bt- 前缀过滤；
 * 本地差集副本已删除。task_id 前缀亦消费 protocol 契约常量
 * BACKGROUND_TASK_ID_PREFIX（§2.3，区别于 subagent-workflow 的 bg-/run-）。
 *
 * 终态判据：registry state ∈ {exited, orphaned}，或（state=running/killing 且
 * kill(pid,0) 判死：收殓/写盘失败遗留的 running 条目按事实终态处理）。
 * 不改 registry——终态写入归收殓侧（runtime reaper）/轮询器（单点归属），对账只清
 * pending 侧。
 *
 * 执行链（index.ts session_start 链内）：收殓下沉 runtime 后（u-bte-remove）本链
 * 仅剩对账——「对账见 running+pid 活则不动作，下一 session_start 兜底」的幂等
 * 语义覆盖孤儿终态由 runtime 异步写入的时序窗口。
 */

import {
	BACKGROUND_TASK_ID_PREFIX,
	collectActivePendingIds,
} from "@xyz-agent/extension-protocol";
import { isPidAlive } from "@xyz-agent/extension-protocol/background-task";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { toPendingReason } from "./notify.ts";
import { getRegistryPath, readRegistry } from "./registry.ts";
import { isActiveState, isTerminalState, type RegistryEntry } from "./types.ts";

const logger = getLogger("base-tool-enhance");

/**
 * 对账依赖的最小 pi 面（结构兼容 ExtensionAPI 的子集；测试注入不造完整 pi）。
 */
export interface ReconcilePi {
	appendEntry(customType: string, data?: unknown): void;
}

/** 对账结果（日志 + 测试断言面）。 */
export interface ReconcileResult {
	/** 补写 pending:unregister entry 的任务数。 */
	reconciled: number;
	/** 差集 active 但判据不满足（活任务 / registry 无条目）而保守跳过的 task_id。 */
	skipped: string[];
}

/**
 * 对账主体（同步：readRegistry / kill(pid,0) / appendEntry 均同步，session_start
 * 链内毫秒级完成）。每个僵尸任务 appendEntry 一次（唯一权威写路径）。
 */
export function reconcilePendingEntries(
	pi: ReconcilePi,
	dataDir: string,
	sessionId: string,
	entries: unknown[],
): ReconcileResult {
	const result: ReconcileResult = { reconciled: 0, skipped: [] };
	const unsettled = collectActivePendingIds(entries, { idPrefix: BACKGROUND_TASK_ID_PREFIX });
	if (unsettled.size === 0) return result;

	const registry = readRegistry(getRegistryPath(dataDir, sessionId));
	for (const id of unsettled) {
		const entry = registry.get(id);
		if (entry === undefined) {
			// registry 无条目：终态无从判定（LRU 淘汰的终态条目其 unregister entry 应已
			// 落盘，差集里还出现 = spawn 后 registry 写失败等罕见路径）——保守不动作，
			// pending-notifications 已无任何 TTL 清理，差集残留由 next-session 对账重查收口
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
			pi.appendEntry("pending:unregister", { id, reason: pendingReason, status: pendingReason });
		} catch (err) {
			logger.warn("reconcile appendEntry failed; retry on next session_start", {
				detail: { id, err: err instanceof Error ? err.message : String(err) },
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
 * 收尾 reason/status 映射：
 *  - exited：按条目 reason/exitCode 走 toPendingReason（与 exit 边沿 emit 同一映射，
 *    两路径写出的 entry 语义一致）；reason 缺失按 pending mapReasonToStatus 的
 *    default=completed 语义处理（防御分支，正常路径 finalize 必写 reason）
 *  - orphaned / running+判死：cancelled（任务非自身成败地终止/消失）
 */
function settledPendingReason(entry: RegistryEntry): "completed" | "failed" | "time_limited" | "cancelled" {
	if (entry.state === "exited" && entry.reason !== undefined) {
		return toPendingReason(entry.reason, entry.exitCode ?? null);
	}
	return "cancelled";
}
