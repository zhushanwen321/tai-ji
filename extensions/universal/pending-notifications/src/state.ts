/**
 * Pending Notifications State — 数据模型和纯函数。
 *
 * 职责：
 * - PendingEntry: 一个异步操作的完整描述（与 pending:register entry data 对齐）
 * - countActiveFromEntries: register − unregister 差集 = 活跃集合（goal 守卫 /
 *   subagent-workflow 后代判定 / 本包 pending_notifications 工具投影共用）
 * - hasPendingId / isPendingActive: 写侧落盘前置判断（register 去重 / unregister 活跃判定）
 *
 * 设计要点：
 * - 差集规则本体（register 首见去重 + unregister 全局抵消 + id 非法跳过）单点在
 *   @xyz-agent/extension-protocol 的 pending-entries（与 bte 对账同源消费，
 *   ext-simplify-13 E6）；本文件在其上只保留 pending 产品语义：类型归一 /
 *   opts.types / currentSessionId 过滤与写侧判定
 * - session entries 是唯一状态源，本文件无内存状态（历史的内存 registry、session_start
 *   重建、TTL 与 shutdown 机器已删除）——「落盘了什么」与「查询到什么」共用同一份扫描，
 *   结构上不可分歧
 * - 纯函数，不依赖 Pi 运行时（ExtensionAPI/appendEntry），可独立单元测试
 * - 差集刻意不校验 expiresAt（三类型全 process 档，长任务 >1h 仍应视为活跃，
 *   对齐 goal continuation 守卫语义）；历史 session 文件中遗留的带 expiresAt 的
 *   register entry 无需迁移——差集语义不读该键
 */
import { applyPendingDiff, scanPendingEntries } from "@xyz-agent/extension-protocol";

/** 异步操作类型（来源：workflow / subagent / bash 后台任务） */
export type PendingType = "workflow" | "subagent" | "bash";

/** 异步操作终态/过渡状态。active = 仍在运行；其他都视为已结束 */
export type PendingStatus = "active" | "completed" | "failed" | "cancelled" | "expired" | "time_limited" | "aborted";

/** 一个异步操作的完整描述（= pending:register entry 的 data 字段） */
export interface PendingEntry {
	/** 操作唯一标识（workflow runId / subagent id / bash 后台任务 id） */
	id: string;
	/** 操作来源类型 */
	type: PendingType;
	/** 可读名称（workflow name / subagent name） */
	name: string;
	/** 注册时状态（恒为 active） */
	status: PendingStatus;
	/** 注册时间戳 ms */
	registeredAt: number;
	/** 注册时的 sessionId（用于跨 session 残留过滤） */
	sessionId: string;
}

/** countActiveFromEntries 的过滤选项。 */
export interface CountActiveOptions {
	/** 只统计指定类型的活跃 pending；缺省 = 全部类型（subagent + workflow + bash） */
	types?: PendingType[];
	/**
	 * [跨 session 残留过滤] 当前 session id（过滤基准）：传入时按「register entry 的
	 * sessionId ≠ 当前 session → 跳过」过滤——fork 继承的父级注册残留（永久留存于子
	 * session 文件，落盘收口归 core 对账 sweep / bte 对账通道）不进差集计数，守卫不幻
	 * defer。缺省（undefined）= 不过滤（向后兼容：既有调用方零改动行为不变）。
	 * entry 缺 sessionId 字段的旧形态条目视为本 session（归一化兜底语义与
	 * normalizeRegisterEntry 一致），不过滤。
	 */
	currentSessionId?: string;
}

/** countActiveFromEntries 的结果。 */
export interface CountActiveResult {
	count: number;
	ids: string[];
	/** 活跃的完整 entry（含类型/名称，供调用方展示或后续判断） */
	entries: PendingEntry[];
}

/**
 * 从持久化 entries 计算活跃 pending 数（register − unregister 差集）。
 *
 * 只做「有没有活跃 pending」的只读判断，不产生任何写入；TTL 刻意不校验
 * （长任务 subagent >1h 仍应视为活跃，对齐 goal agent-end 的 continuation 守卫语义）。
 * 调用方：goal（agent_end 时判断是否发 continuation）、subagent-workflow
 * （agent_end 时判断子进程是否有活跃后代，决定是否保持进程等 steer 唤醒）、
 * 本包 pending_notifications 工具投影。
 *
 * 跨 session 残留过滤：持有当前 session 概念的调用方应传入 opts.currentSessionId，
 * 使 fork 继承的父级注册残留不进差集（守卫不幻 defer）。
 */
export function countActiveFromEntries(
	entries: unknown[],
	opts?: CountActiveOptions,
): CountActiveResult {
	// 差集本体（首见去重 + 抵消 + id 非法跳过，S-10 容错在内）单点委托 protocol；
	// 本层只叠加 pending 产品过滤（normalize / types / currentSessionId，见 filterActiveRegisters）
	const active = filterActiveRegisters(applyPendingDiff(scanPendingEntries(entries)), opts);

	return {
		count: active.length,
		ids: active.map((e) => e.id),
		entries: active,
	};
}

/**
 * 写侧前置判断①：entries 中是否已存在该 id 的 register entry（无论注销与否）。
 * register listener 落盘前去重用（U6 重复注册忽略）；id 全局唯一（时间戳+随机）
 * 前提下无假阴性窗口。
 */
export function hasPendingId(entries: unknown[], id: string): boolean {
	return scanPendingEntries(entries).registerEntries.some(({ data }) => data.id === id);
}

/**
 * 写侧前置判断②：id 是否活跃（有 register 且无任何 unregister）。
 * unregister listener 落盘前判断用（U8 未知/已注销 id 忽略）；bte 对账直接
 * appendEntry 的注销与事件落盘的注销在同一份 entries 上生效（构造性一致，
 * 收尾尽力补 emit 天然幂等）。
 */
export function isPendingActive(entries: unknown[], id: string): boolean {
	const { registerEntries, unregisteredIds } = scanPendingEntries(entries);
	if (unregisteredIds.has(id)) return false;
	return registerEntries.some(({ data }) => data.id === id);
}

/** pending 特有过滤层：normalize 归一 + opts.types 过滤 + 跨 session 残留过滤。
 *  差集本体（首见去重 / 抵消 / id 非法跳过）已由 protocol applyPendingDiff 单点
 *  完成——本函数不做任何差集判定，只消费其活跃结果。 */
function filterActiveRegisters(
	activeRegisters: Array<{ data: Record<string, unknown> }>,
	opts?: CountActiveOptions,
): PendingEntry[] {
	const active: PendingEntry[] = [];
	for (const { data } of activeRegisters) {
		const entry = normalizeRegisterEntry(data, "");
		if (opts?.types && !opts.types.includes(entry.type)) continue;
		// 跨 session 残留跳过（基准 = opts.currentSessionId）。判据读原始 data.sessionId
		// 而非归一化值：entry 缺 sessionId 的旧形态条目（归一化兜底为 ""）视为本
		// session——不过滤，与 normalizeRegisterEntry 的容错语义对齐（守卫漏计的危害
		// 方向是幻 defer，宁放行不误杀活跃计数）。
		if (
			opts?.currentSessionId !== undefined &&
			typeof data.sessionId === "string" &&
			data.sessionId !== opts.currentSessionId
		) {
			continue;
		}
		active.push(entry);
	}
	return active;
}

/**
 * type 归一化：subagent/bash 原样保留，其余（含缺失/未知值）归 workflow。
 * state.ts 与 index.ts 两处归一化共用本函数，防止「写入侧直通、读取侧归并」漂移。
 *
 * [偏好显式化] 缺失/未知 type 默认归 workflow = 宁挂账不失明：未知类型照常进差集
 * （守卫不因类型畸形失明），收口通道按类型分流——workflow / 畸形条目由 core 注册
 * 对账 sweep 收口（查 WorkflowRun store：终态 ∪ state 文件不存在 → 补注销）；bash 无
 * record/store 可查——注册随进程退出注销，进程死亡窗口的丢失无补发通道，属显式
 * 边界（每孤儿 bash 注册至多 1 条静态虚报，熔断限损）。
 */
export function normalizePendingType(raw: unknown): PendingType {
	if (raw === "subagent") return "subagent";
	if (raw === "bash") return "bash";
	return "workflow";
}

/** 从 entry data 归一化为 PendingEntry（补默认值，容错缺失字段）。
 *  id 的 string 合法性已由差集层（applyPendingDiff）判定，此处直接窄化。 */
function normalizeRegisterEntry(data: Record<string, unknown>, currentSessionId: string): PendingEntry {
	const registeredAt = typeof data.registeredAt === "number" ? data.registeredAt : Date.now();
	return {
		id: data.id as string,
		type: normalizePendingType(data.type),
		name: typeof data.name === "string" ? data.name : (data.id as string),
		status: "active",
		registeredAt,
		sessionId: typeof data.sessionId === "string" ? data.sessionId : currentSessionId,
	};
}
