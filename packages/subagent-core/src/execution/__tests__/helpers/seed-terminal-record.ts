// src/execution/__tests__/helpers/seed-terminal-record.ts
//
// 终态/在途 record 的事件流播种 fixture（`.state` 收条退场后的替代物）。
//
// 背景：终态收条（为什么停 / 何时停）的权威载体已从 `.state` sidecar 换到 record
// 事件流的 `record-settled` 帧（`<recordsDir>/<id>.events`）。测试要造「磁盘上已是
// 终态的 record」，就得直接写事件文件。本 helper 是该形态的唯一 fixture 入口（格式
// 细节单源，避免各测试散落 fs.writeFileSync 手写帧）。三种形态：
//   - 终局收条：created → [bound →] settled（缺省）；
//   - 轮终收条：created → [bound →] round-started → round-idle（idleRound 入参）；
//   - 在途无收条：created → [bound]（inFlight 入参——统计/收条不投影的负向用例）。
//
// 关键约束（踩过的坑）：
//   - 头行 type 是 `record-events`（不是 `record-journal`）；
//   - `stopReason` 取 StopReason 值域（`completed` / `interrupted` / `disconnected`
//     等）——写 ClosedReason 与 StopReason 重名的值虽然类型上合法，但语义上「已收口
//     的停因」应取展示值域的显式成员，别把 legacy 死因词当停因用；
//   - 无 `record-settled` / 轮终收条帧 = 记录仍在途（running），别只写 created 帧
//     就断言终态；
//   - 无 identity entry 的引擎子文件要被扫描重建，必须带 `boundSessionFile` 帧
//     （磁盘身份反查腿 identityFromFoldByFile 依赖 bound.sessionFile）。

import * as fs from "node:fs";

import type { AbandonedRoundMark, Epoch, ExecutionMode, RecordOrigin, StopReason } from "../../domain/record-types.ts";
import {
  recordEventsPath,
  toRecordEventHeader,
} from "../../persistence/record-events.ts";
import type { RecordEventInput } from "../../persistence/record-events.ts";
import { IDENTITY_CUSTOM_TYPE } from "../../persistence/session-reconstructor.ts";

/** 终态事件流播种载荷（身份域缺省值与 session.jsonl fixture 同款；仅本 helper 消费，故内联不抽象）。 */
type SeedTerminalRecordInput = {
  id: string;
  startedAt: number;
  /**
   * 停因（StopReason 值域）。settled / 轮终收条形态的停因；缺省 "completed"。
   * in-flight 形态（见 {@link inFlight}）不消费本字段。
   */
  stopReason?: StopReason;
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
  /**
   * 追加 `record-bound` 帧（磁盘身份反查腿 `identityFromFoldByFile` 依赖
   * bound.sessionFile）：无 identity entry 的引擎子文件必须带本帧才能被扫描重建
   * （created 身份域 + bound 反查键）。engine 恒 "pi"（fold 身份腿不消费 engine 域）。
   */
  boundSessionFile?: string;
  /**
   * 轮终收条形态（记录停在轮终未终局——`record-settled` 的替代）：帧序 = created →
   * [bound →] round-started → round-idle。stopReason/endedAt 入参被本形态征用为
   * 轮终收条的停因与时间（receiptStatisticsFromFold 的轮终收条语义：round-idle 是
   * 最后一条事件时 its ts 即收条时间）。
   */
  idleRound?: {
    /** 轮序号（round-started 携带）。 */
    round: number;
    /** 轮终收条时间（round-idle ts）。缺省 = startedAt + 1000。 */
    ts?: number;
    /** 轮统计快照（round-idle 载荷；缺省 0）。 */
    turns?: number;
    totalTokens?: number;
    /** 轮被弃置的标记（round-idle 可选载荷）。 */
    lastAbandonedRound?: AbandonedRoundMark | null;
  };
  /**
   * 在途形态（无收条帧）：帧序 = created → [bound]，记录停在轮中/未收口——
   * 「无收条 → 统计不投影」负向用例的播种形态。与 idleRound 互斥（idleRound 优先）。
   */
  inFlight?: boolean;
  /** bound / round-started 帧携带的写权世代（缺省 0）。 */
  epoch?: Epoch;
};

/** 播种载荷 → 事件帧序列（seq 自动 1..n；created 恒首帧）。 */
function buildSeedFrames(input: SeedTerminalRecordInput): RecordEventInput[] {
  const endedAt = input.endedAt ?? input.startedAt + 1000;
  const epoch = input.epoch ?? 0;
  const stopReason = input.stopReason ?? "completed";
  const created: RecordEventInput = {
    type: "record-created",
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
  const bound: RecordEventInput | undefined =
    input.boundSessionFile !== undefined
      ? {
          type: "record-bound",
          ts: input.startedAt,
          sessionFile: input.boundSessionFile,
          engine: "pi",
          engineHandle: { sessionRef: { sessionFile: input.boundSessionFile }, poolKey: "shared" },
          epoch,
        }
      : undefined;
  if (input.idleRound !== undefined) {
    const idleRound: RecordEventInput = {
      type: "record-round-idle",
      ts: input.idleRound.ts ?? input.startedAt + 1000,
      // 轮终累计轮数（[② 读侧换源] ——fold.round 的轮终推进帧）。
      round: input.idleRound.round,
      stopReason,
      turns: input.idleRound.turns ?? 0,
      totalTokens: input.idleRound.totalTokens ?? 0,
      ...(input.idleRound.lastAbandonedRound !== undefined
        ? { lastAbandonedRound: input.idleRound.lastAbandonedRound }
        : {}),
    };
    return [
      created,
      ...(bound !== undefined ? [bound] : []),
      {
        type: "record-round-started",
        ts: input.startedAt,
        // 轮始轮数 = 轮终累计 - 1（markRoundStarted 写「已收口轮数」的生产行为对齐）。
        round: Math.max(input.idleRound.round - 1, 0),
        epoch,
      },
      idleRound,
    ];
  }
  if (input.inFlight === true) {
    return [created, ...(bound !== undefined ? [bound] : [])];
  }
  const settled: RecordEventInput = {
    type: "record-settled",
    ts: endedAt,
    stopReason,
    endedAt,
    turns: input.turns ?? 0,
    totalTokens: input.totalTokens ?? 0,
  };
  return [created, ...(bound !== undefined ? [bound] : []), settled];
}

/**
 * 播种「created + settled」两帧（可选 bound / 轮终收条形态）到 `<recordsDir>/<id>.events`，
 * 返回事件文件路径。写的是冻结形态（非 process.cwd 依赖）——所有字段来自入参，seq 自动 1..n。
 */
export function seedTerminalRecord(recordsDir: string, input: SeedTerminalRecordInput): string {
  const frames = buildSeedFrames(input);
  const file = recordEventsPath(recordsDir, input.id);
  fs.mkdirSync(recordsDir, { recursive: true });
  // seq 按数组序 1..n 落盘（帧构造不含 seq——与 journal 单写者的单调分配同构）。
  const lines = [
    JSON.stringify(toRecordEventHeader(input.id)),
    ...frames.map((frame, i) => JSON.stringify({ ...frame, seq: i + 1 })),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
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
  opts: Pick<SeedTerminalRecordInput, "stopReason" | "endedAt" | "turns" | "totalTokens" | "idleRound" | "epoch" | "boundSessionFile">,
): string {
  const identity = readSessionIdentity(sessionFile);
  return seedTerminalRecord(recordsDir, {
    ...identity,
    ...(opts.stopReason !== undefined ? { stopReason: opts.stopReason } : { stopReason: "completed" }),
    ...(opts.endedAt !== undefined ? { endedAt: opts.endedAt } : {}),
    ...(opts.turns !== undefined ? { turns: opts.turns } : {}),
    ...(opts.totalTokens !== undefined ? { totalTokens: opts.totalTokens } : {}),
    ...(opts.idleRound !== undefined ? { idleRound: opts.idleRound } : {}),
    ...(opts.epoch !== undefined ? { epoch: opts.epoch } : {}),
    ...(opts.boundSessionFile !== undefined ? { boundSessionFile: opts.boundSessionFile } : {}),
  });
}
