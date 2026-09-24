/**
 * session JSONL 写入器（mock pi 以「pi-plan 扩展现版行为」身份落 plan-state 快照）。
 *
 * 纪律边界（AGENTS.md 关键规则 #6）：「禁止任何代码在 pi 首次 flush 前创建/触碰 session
 * 文件」约束的是 **taiji runtime/扩展侧** 与真实 pi 的会话文件竞争；本写入器是 mock pi
 * （扮演 pi 本人）的持久化通路，等价于真实 pi-plan 扩展 `persistPlanState` 的
 * `pi.appendEntry("plan-state", ...)`——只在 mock 收到 `switch_session` 显式附着目标
 * sessionPath 之后写入，且自测/复现一律使用 tmp session 文件。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { planStateEntry } from './frames.mjs';

/** 追加一条 plan-state 快照 entry（append-only 末条生效语义与扩展一致）。 */
export function appendPlanStateEntry(sessionPath, data) {
  if (!sessionPath) throw new Error('mock-pi: session-writer: no sessionPath (send switch_session first)');
  mkdirSync(dirname(sessionPath), { recursive: true });
  const entry = planStateEntry(data);
  appendFileSync(sessionPath, `${JSON.stringify(entry)}\n`);
  return entry;
}

/** 追加任意 entry（消息 entry 等——复现剧本的对话流留痕）。 */
export function appendRawEntry(sessionPath, entry) {
  if (!sessionPath) throw new Error('mock-pi: session-writer: no sessionPath (send switch_session first)');
  mkdirSync(dirname(sessionPath), { recursive: true });
  appendFileSync(sessionPath, `${JSON.stringify(entry)}\n`);
}
