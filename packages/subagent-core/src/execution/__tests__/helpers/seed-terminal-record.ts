// src/execution/__tests__/helpers/seed-terminal-record.ts
//
// 终态 record 的事件流播种 fixture（`.state` 收条退场后的替代物）。
//
// 背景：终态收条（为什么停 / 何时停）的权威载体已从 `.state` sidecar 换到 record
// 事件流的 `record-settled` 帧（`<recordsDir>/<id>.events`）。测试要造「磁盘上已是
// 终态的 record」，就得直接写事件文件：头行 + `record-created` + `record-settled`
// 两帧。本 helper 是该形态的唯一 fixture 入口（格式细节单源，避免各测试散落
// fs.writeFileSync 手写帧）。
//
// 关键约束（踩过的坑）：
//   - 头行 type 是 `record-events`（不是 `record-journal`）；
//   - `stopReason` 取 StopReason 值域（`completed` / `interrupted` / `disconnected`
//     等）——写 ClosedReason 与 StopReason 重名的值虽然类型上合法，但语义上「已收口
//     的停因」应取展示值域的显式成员，别把 legacy 死因词当停因用；
//   - 缺 `record-settled` 帧 = 记录仍在途（running），别只写 created 帧就断言终态。

import * as fs from "node:fs";

import type { ExecutionMode, RecordOrigin, StopReason } from "../../domain/record-types.ts";
import { recordEventsPath, toRecordJournalHeader } from "../../persistence/record-events.ts";
import { IDENTITY_CUSTOM_TYPE } from "../../persistence/session-reconstructor.ts";

/** 终态事件流播种载荷（身份域缺省值与 session.jsonl fixture 同款；仅本 helper 消费，故内联不抽象）。 */
type SeedTerminalRecordInput = {
  id: string;
  startedAt: number;
  /** 停因（StopReason 值域）。 */
  stopReason: StopReason;
  /** 终局时间（缺省 = startedAt + 1000，与 session fixture 的末条 ts 同序）。 */
  endedAt?: number;
  agent?: string;
  task?: string;
  slug?: string;
  rootSessionId?: string;
  parentRecordId?: string;
  parentRunId?: string;
  stepIndex?: number;
  depth?: number;
  mode?: ExecutionMode;
  origin?: RecordOrigin;
  model?: string;
  thinkingLevel?: string;
  worktree?: boolean;
  turns?: number;
  totalTokens?: number;
};

/**
 * 播种「created + settled」两帧到 `<recordsDir>/<id>.events`，返回事件文件路径。
 *
 * 写的是冻结形态（非 process.cwd 依赖）——所有字段来自入参，seq = 1 / 2。
 */
function seedTerminalRecord(recordsDir: string, input: SeedTerminalRecordInput): string {
  const endedAt = input.endedAt ?? input.startedAt + 1000;
  const created = {
    type: "record-created",
    seq: 1,
    ts: input.startedAt,
    id: input.id,
    agent: input.agent ?? "worker",
    task: input.task ?? "t",
    slug: input.slug ?? "s",
    origin: input.origin ?? "tool",
    ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
    ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
    rootSessionId: input.rootSessionId ?? "",
    ...(input.parentRecordId !== undefined ? { parentRecordId: input.parentRecordId } : {}),
    depth: input.depth ?? 0,
    mode: input.mode ?? "background",
    startedAt: input.startedAt,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.worktree === true ? { worktree: true } : {}),
  };
  const settled = {
    type: "record-settled",
    seq: 2,
    ts: endedAt,
    stopReason: input.stopReason,
    endedAt,
    turns: input.turns ?? 0,
    totalTokens: input.totalTokens ?? 0,
  };
  const file = recordEventsPath(recordsDir, input.id);
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify(toRecordJournalHeader(input.id))}\n${JSON.stringify(created)}\n${JSON.stringify(settled)}\n`,
    "utf-8",
  );
  return file;
}

/** session.jsonl 里读出的身份域（`subagent-identity` custom entry 的 data 子集）。 */
type SessionIdentity = {
  id: string;
  agent?: string;
  task?: string;
  slug?: string;
  rootSessionId?: string;
  parentRecordId?: string;
  parentRunId?: string;
  stepIndex?: number;
  depth?: number;
  mode?: ExecutionMode;
  origin?: RecordOrigin;
  startedAt: number;
  model?: string;
  thinkingLevel?: string;
  worktree?: boolean;
};

/**
 * 从 session.jsonl 的 `subagent-identity` 首条目读身份域。
 *
 * 找不到 identity 条目 → 抛错（fixture 写错比静默播空身份好排查）。
 */
function readSessionIdentity(sessionFile: string): SessionIdentity {
  for (const line of fs.readFileSync(sessionFile, "utf-8").split("\n")) {
    if (!line.includes(IDENTITY_CUSTOM_TYPE)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // 半写/坏行跳过（与生产读侧宽容语义同向）
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as { type?: unknown; customType?: unknown; data?: unknown };
    if (obj.type !== "custom" || obj.customType !== IDENTITY_CUSTOM_TYPE) continue;
    if (typeof obj.data !== "object" || obj.data === null) continue;
    const data = obj.data as Record<string, unknown>;
    if (typeof data.id !== "string" || typeof data.startedAt !== "number") continue;
    return {
      id: data.id,
      agent: typeof data.agent === "string" ? data.agent : undefined,
      task: typeof data.task === "string" ? data.task : undefined,
      slug: typeof data.slug === "string" ? data.slug : undefined,
      rootSessionId: typeof data.rootSessionId === "string" ? data.rootSessionId : undefined,
      parentRecordId: typeof data.parentRecordId === "string" ? data.parentRecordId : undefined,
      parentRunId: typeof data.parentRunId === "string" ? data.parentRunId : undefined,
      stepIndex: typeof data.stepIndex === "number" ? data.stepIndex : undefined,
      depth: typeof data.depth === "number" ? data.depth : undefined,
      mode: data.mode === "background" ? "background" : undefined,
      origin: data.origin === "workflow" || data.origin === "tool" ? data.origin : undefined,
      startedAt: data.startedAt,
      model: typeof data.model === "string" ? data.model : undefined,
      thinkingLevel: typeof data.thinkingLevel === "string" ? data.thinkingLevel : undefined,
      worktree: data.worktree === true,
    };
  }
  throw new Error(
    `seed-terminal-record: no ${IDENTITY_CUSTOM_TYPE} custom entry with data.id/data.startedAt in ${sessionFile}`,
  );
}

/**
 * 按 sessionFile 播种终态 record（record id 与身份域取自该文件的 identity entry）。
 *
 * 调用点因此保持「给一个 session 文件路径」的形态，不必逐点搬运 id/身份字段——
 * 身份域与 session fixture 天然一致（同 id、同 rootSessionId、同 startedAt）。
 */
export function seedTerminalRecordForSessionFile(
  sessionFile: string,
  recordsDir: string,
  opts: Pick<SeedTerminalRecordInput, "stopReason" | "endedAt" | "turns" | "totalTokens">,
): string {
  const identity = readSessionIdentity(sessionFile);
  return seedTerminalRecord(recordsDir, {
    ...identity,
    stopReason: opts.stopReason,
    ...(opts.endedAt !== undefined ? { endedAt: opts.endedAt } : {}),
    ...(opts.turns !== undefined ? { turns: opts.turns } : {}),
    ...(opts.totalTokens !== undefined ? { totalTokens: opts.totalTokens } : {}),
  });
}
