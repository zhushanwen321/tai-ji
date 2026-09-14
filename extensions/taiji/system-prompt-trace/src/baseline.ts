/**
 * 跨重启基线的文件系统侧实现（三档口径，见 trace.ts onSessionStart 解析优先级：
 * 档 1 stash 直读 / 档 2 fork 事件 previousSessionFile 直读 / 档 3 getSessionFile() 直读）。
 *
 * readLastPromptFromSessionFile 是三档统一的读取入口：直读 session JSONL
 * （进程内 resume 的 targetSessionFile、fork 的 previousSessionFile、reload / 直启 resume
 * 的 getSessionFile() 目标文件），倒序找最后一条 xyz:system-prompt 留痕 entry。
 *
 * 所有函数不抛错：读失败返回 null——基线丢失的代价只是
 * 下次 resume 多写一条留痕（设计 D2 已接受），不允许影响 agent 主流程。
 */

import { readFileSync } from "node:fs";

import { isRecord } from "@zhushanwen/pi-ext-guards";

import { isSystemPromptTraceEntryData, SYSTEM_PROMPT_CUSTOM_TYPE } from "./types.js";
import type { PromptBaseline } from "./types.js";

/**
 * 解析单行 session JSONL 为留痕 entry data（运行时 guard；任何形状不符 / JSON 损坏返回 null）。
 * pi 落盘形状：{"type":"custom","customType":"xyz:system-prompt","data":{...},...}
 * （session-manager.ts:1122 appendCustomEntry）。
 */
function parseTraceEntryData(line: string): { hash: string; version: number; fullText: string } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	if (parsed["type"] !== "custom" || parsed["customType"] !== SYSTEM_PROMPT_CUSTOM_TYPE) return null;
	const data = parsed["data"];
	if (!isSystemPromptTraceEntryData(data)) return null;
	return { hash: data.hash, version: data.version, fullText: data.fullText };
}

/**
 * 倒序扫描 session JSONL，取最后一条留痕 entry 作基线。
 * 文件缺失 / 全部损坏 / 无留痕 entry（旧 session 先于本 extension）→ null。
 */
export function readLastPromptFromSessionFile(sessionFilePath: string): PromptBaseline | null {
	let content: string;
	try {
		content = readFileSync(sessionFilePath, "utf-8");
	} catch {
		return null;
	}
	const lines = content.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line === "") continue;
		const parsed = parseTraceEntryData(line);
		if (parsed !== null) {
			return { hash: parsed.hash, version: parsed.version, fullText: parsed.fullText };
		}
	}
	return null;
}
