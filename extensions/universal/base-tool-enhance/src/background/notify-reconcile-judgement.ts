/**
 * 补投判据纯函数（bg-task-notify-durability 设计 §5 U1）——送达痕迹提取与补投标记
 * entry 的读写形态约定。
 *
 * 两个纯函数族（无 I/O、无 pi 依赖，形态穷举单测覆盖）：
 *  ① collectDeliveredTaskIds：从会话 entries 提取「已送达完成通知的 taskId 集合」。
 *     送达痕迹 = 会话文件里的完成通知消息本身（custom_message，customType =
 *     background-bash）——正常投递经 pi.sendMessage 落盘的形态；fork 副本随 session
 *     文件复制同形态带走，天然命中（fork 窄窗口的跨会话重复已由设计决策 5 独立限定）。
 *     判定通道两条，任一命中即算：details.taskId（结构化字段）/ content 文本含
 *     bt- 形态 token（缺 details 的旧消息——details 载荷是后加的，历史消息只有 content）。
 *  ② 补投标记（幂等锚）：customType = background-bash:reconciled 的 plain custom
 *     entry（pi.appendEntry 同步入账），data = {taskId, reconciledAt}。不进 LLM 上下文
 *     （与 NotifyLedger 同款通道纪律：账务走 appendEntry，送达消息走 sendMessage）。
 *
 * 非目标（设计否决记录防回潮）：纯痕迹反查判重不成立（送达消息落盘异步于投递返回，
 * 双派发的第二次对账在窗口内查不到痕迹必现双投）——补投标记是唯一能在同激活内收敛的
 * 锚点，两族函数必须配合使用（见 pending-reconcile.ts 判据三条件）。
 */

import { BACKGROUND_BASH_CUSTOM_TYPE } from "./notify.ts";

/**
 * 补投标记 entry 的 customType 落盘字符串（形态约定 SSOT，设计决策 1）。
 * plain custom entry（appendEntry 通道），与送达消息的 background-bash 通道刻意区分。
 */
export const RECONCILED_MARKER_CUSTOM_TYPE = "background-bash:reconciled";

/** 补投标记 entry 的 data 落盘形态（设计决策 1：{taskId, reconciledAt}）。 */
export interface ReconciledMarkerData {
	taskId: string;
	/** 补投发起时刻（epoch 毫秒；观测字段，判据不消费）。 */
	reconciledAt: number;
}

/** 构造补投标记 data（写侧唯一入口——落盘形态演进只改此处与 collect 读侧）。 */
export function buildReconciledMarkerData(taskId: string, reconciledAt: number): ReconciledMarkerData {
	return { taskId, reconciledAt };
}

/**
 * content 中 bt- 形态 taskId 的提取模式（spawn-background generateTaskId 生成规则：
 * bt-<epoch ms>-<base36 固定长随机段>）。按生成形态锚定而非任意 bt- 前缀串，避免把
 * 普通英文词（如 "btw-"）误判为任务 id。设计原文「content 含 taskId」的宽松语义：
 * 尾部输出摘要里如出现其他任务 id 也会算送达痕迹——方向保守（漏补投优于重复投）。
 */
const CONTENT_TASK_ID_PATTERN = /\bbt-\d+-[0-9a-z]+\b/g;

/**
 * 从会话 entries 提取已送达完成通知的 taskId 集合（判据通道①：送达痕迹）。
 *
 * 五形态语义（设计 §5 U1 形态清单）：正常消息（details + content 双通道命中）、
 * fork 副本（同形态命中）、缺 details 旧消息（仅 content 命中）、非 bash 通知
 * （customType 不同，不命中）、killed 无痕迹任务（无消息 entry，天然不在集合）。
 *
 * 容错对齐 protocol pending-entries 扫描同款纪律：null/非对象元素跳过；content 兼容
 * string 与 TextContent[] 两种落盘形态（pi appendCustomMessageEntry 接受两者）。
 */
export function collectDeliveredTaskIds(entries: readonly unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		if (entry.customType !== BACKGROUND_BASH_CUSTOM_TYPE) continue;
		const taskId = stringField(entry.details, "taskId");
		if (taskId !== undefined) ids.add(taskId);
		const content = entry.content;
		if (typeof content === "string") {
			collectTaskIdsFromText(content, ids);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				const text = stringField(block, "text");
				if (text !== undefined) collectTaskIdsFromText(text, ids);
			}
		}
	}
	return ids;
}

/**
 * 从会话 entries 提取已补投（标记 entry 在）的 taskId 集合（判据通道②：补投标记）。
 * data 形态防御：缺 taskId / 非字符串的脏标记 entry 跳过（不因单条脏数据报废判据）。
 */
export function collectReconciledTaskIds(entries: readonly unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		if (entry.customType !== RECONCILED_MARKER_CUSTOM_TYPE) continue;
		const taskId = stringField(entry.data, "taskId");
		if (taskId !== undefined) ids.add(taskId);
	}
	return ids;
}

/** unknown 值上指定键的 string 字段（非对象/缺键/非字符串一律 undefined）。 */
function stringField(value: unknown, key: string): string | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" ? field : undefined;
}

function collectTaskIdsFromText(text: string, ids: Set<string>): void {
	for (const match of text.matchAll(CONTENT_TASK_ID_PATTERN)) {
		ids.add(match[0]);
	}
}
