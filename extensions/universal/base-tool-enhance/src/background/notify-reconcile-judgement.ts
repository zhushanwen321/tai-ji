/**
 * 收殓终态补投的送达痕迹提取（unified-delivery D3 裁决 1：对账路径 = 收殓终态通知
 * 的唯一生产者，pending-reconcile.ts 消费）——纯函数，无 I/O、无 pi 依赖。
 *
 * collectDeliveredTaskIds：从会话 entries 提取「已送达完成通知的 taskId 集合」。
 * 送达痕迹 = 会话文件里的完成通知消息本身（custom_message，customType =
 * background-bash）——主路径经 port.deliver 注入落盘的形态（波 3 前直发/补投的历史
 * 消息同形态，判据通吃）；fork 副本随 session 文件复制同形态带走，天然命中。
 * 判定通道两条，任一命中即算：details.taskId（结构化字段）/ content 文本含
 * bt- 形态 token（缺 details 的旧消息——details 载荷是后加的，历史消息只有 content）。
 *
 * 非目标（防回潮）：补投幂等不在此处承载——防双投由 port 幂等体系接管（deliver
 * 幂等预检 + 内核三级判重 + outbox/ack 终态列，见 pending-reconcile.ts 文件头）；
 * 本函数只回答「这个任务的通知是否已经出现在会话里」。
 */

import { BACKGROUND_BASH_CUSTOM_TYPE } from "./notify.ts";

/**
 * content 中 bt- 形态 taskId 的提取模式（spawn-background generateTaskId 生成规则：
 * bt-<epoch ms>-<base36 固定长随机段>）。按生成形态锚定而非任意 bt- 前缀串，避免把
 * 普通英文词（如 "btw-"）误判为任务 id。设计原文「content 含 taskId」的宽松语义：
 * 尾部输出摘要里如出现其他任务 id 也会算送达痕迹——方向保守（漏补投优于重复投）。
 */
const CONTENT_TASK_ID_PATTERN = /\bbt-\d+-[0-9a-z]+\b/g;

/**
 * 从会话 entries 提取已送达完成通知的 taskId 集合。
 *
 * 五形态语义：正常消息（details + content 双通道命中）、fork 副本（同形态命中）、
 * 缺 details 旧消息（仅 content 命中）、非 bash 通知（customType 不同，不命中）、
 * killed 无痕迹任务（无消息 entry，天然不在集合）。
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
