// src/read-fallback.ts
//
// read 的 ②级降级：宿主 event journal 文件重放（W7，impl-plan §2.7「session-
// reconstructor 保持 core，pi 包经协议 read 拿会话视图」的引擎侧承接）。
//
// journal 文件由宿主侧 EngineClient 的事件 journal 写入（core journal-wiring：
// handle.data.journalPath 回填是运行期落盘路径权威）。本模块读该 JSONL 文件、
// 逐行解析 AgentEvent、经 SDK journal-replay 纯投影还原 SessionView。文件缺失 /
// 不可解析 / 无事件 → undefined（调用方落 ③级 outcome-only）。
//
// ①级 pi 原生读取（session-reconstructor）按 §2.7 保持 core 不随迁（deviations
// 登记：过渡期 core 侧 session-view-service 链路持有原生读取；引擎包 read 的
// ①级接通与录制格式权威归 W10 conformance）。

import { readFileSync } from "node:fs";

import { getLogger } from "@zhushanwen/subagent-engine-sdk";

import { toErrorMessage } from "./error-message.ts";

const logger = getLogger("pi-engine/read-fallback");

import {
  eventsToSessionView,
  sessionIdFromHandle,
  type AgentEvent,
  type SessionView,
} from "@zhushanwen/subagent-engine-sdk";

import type { EngineHandle } from "./port-types.ts";

/**
 * 从 handle 自描述的 journalPath 重放会话视图。
 *
 * @returns undefined = journalPath 缺失 / 文件不存在 / 无有效事件（降级链落 ③级）
 */
export function replayJournalToSessionView(handle: EngineHandle, engineId: string): SessionView | undefined {
  const journalPath = handle.data.journalPath;
  if (journalPath === undefined || journalPath === "") return undefined;
  let raw: string;
  try {
    raw = readFileSync(journalPath, "utf8");
  } catch {
    return undefined;
  }
  const events: AgentEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const obj: unknown = JSON.parse(trimmed);
      // 行形态防御：裸事件（{type:...}）或包装事件（{event:{type:...}}）两种都收
      const candidate =
        typeof obj === "object" && obj !== null && "event" in (obj as Record<string, unknown>)
          ? (obj as { event: unknown }).event
          : obj;
      if (isAgentEvent(candidate)) events.push(candidate);
    } catch (err) {
      // 单行损坏不中断重放（append-only journal 的中断写入是已知形态）——debug 留痕
      logger.debug(`[read-fallback] skip corrupt journal line: ${toErrorMessage(err)}`);
    }
  }
  if (events.length === 0) return undefined;
  const sessionId = sessionIdFromHandle(handle.data);
  return eventsToSessionView(events, engineId, sessionId);
}

/**
 * AgentEvent 运行时 guard（type 字段白名单收窄）。
 *
 * activity 刻意不在白名单：纯活性信号不进任何持久/重放面（core journal-wiring 豁免
 * append，正常 journal 不含 activity 行）——即使旧宿主落盘的 journal 混入借用期
 * message_end 形态外的 activity 行，被过滤 = no-op 安全（reducer 对其本就 no-op）。
 */
function isAgentEvent(x: unknown): x is AgentEvent {
  if (typeof x !== "object" || x === null || !("type" in x)) return false;
  const t = (x as Record<string, unknown>).type;
  return (
    t === "tool_start" || t === "tool_end" || t === "text_delta" || t === "thinking_delta" ||
    t === "turn_end" || t === "message_end" || t === "compaction" || t === "error"
  );
}
