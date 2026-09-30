// src/execution/persistence/record-events.ts
//
// W1 [D3]：subagent record 事件文件词表与 fold 单源。
//
// 为什么需要它：record 状态此前写六个介质（子 session jsonl / .state /
// .record-binding / .alive / 主 session 全量快照 entry / manifest+index），无事件
// 流——「事实源介质数 = 1」的 W1 目标要求 record 域有一个与 run 侧
// `<runId>.events.jsonl` 同构的事件文件作为唯一事实源（设计 w1-run-record-
// journal-authority §3.3 D3 候选二裁决：独立事件文件、子 session 只做渲染源）。
//
// 本模块承载（契约层，写点接线归 U2a / 读侧消费归 U3）：
// 1. 六类事件词表（判别键 type）——与设计 D3 映射表逐项对应，每类事件的 doc
//    注释标注「对应现状写点」；
// 2. 行级单调 seq 信封——W2 通知去重键（终态事件身份）的载体（设计目标 4）；
// 3. 事件文件首行头行形态 `{"type":"record-journal","id":...}`——无 .jsonl 后缀
//    代价的补偿（文件自描述；检查点④：session-reader 首行读命中非 session header
//    即忽略，零成本）；
// 4. journal 读写原语（createRecordEventJournal：append 单调分配 seq + scan 坏行
//    宽容跳过）；
// 5. fold 纯函数族（applyRecordEvent 单步 + foldRecordEvents 全量/
//    增量共用——增量 = 以既有 state 为 initial 重入，seq 单调守卫保证幂等）。
//
// 落点裁决（D3）：`<recordsDir>/<sa-id>.events`（与 manifest 同目录同主名，寻址 =
// 注册条目 id 直接定址，无需扫描）。无 .jsonl 后缀的结构性收益：session-reader
// 的 .jsonl 扫描、session-file-gc 的 .jsonl TTL 清理、runtime legacy 目录扫描全部
// 结构性忽略该文件族（「被忽略或被误读」两类风险一次排空）。清理归统一保留
// 通道（D5），session-file-gc 对 *.events 显式忽略（U5）。
//
// tail 增量读取（offset 续读 / 完整行边界 / 坏行宽容）不在本模块——journal-tail.ts
// 是域无关的 tail 原语层，本模块只提供 parseRecordEventFileLine 行解析器注入。

import { join } from "node:path";

import { getLogger } from "../../core/logger.ts";
// [§3.1.3 基座单源] append/scan 实现在 shared/jsonl-event-journal.ts（与 run journal
// 共用同一实现体，差异经策略注入——本文件只提供 record 域策略）。
import { JsonlEventJournal } from "../../shared/jsonl-event-journal.ts";
import type { Epoch, ExecutionMode, ExecutionOutcome, RecordOrigin, StopReason } from "../domain/record-types.ts";
import type { AbandonedRoundMark, TranscriptRef } from "../domain/record-types.ts";

const journalLogger = getLogger("record-event-journal");

// ── 文件形态（D3 落点）────────────────────────────────────────

/** record 事件文件后缀（无 .jsonl——结构性规避三类 .jsonl 扫描器，见模块头注释）。 */
export const RECORD_EVENTS_SUFFIX = ".events";

/**
 * record 事件文件路径：`<recordsDir>/<sa-id>.events`。
 *
 * recordsDir = getSubagentRecordsDir(agentDir, mainCwd)（与 manifest 同目录）；
 * 与 manifest 同主名的对偶关系（<sa-id>.json / <sa-id>.events）是 D3 的显式裁决。
 */
export function recordEventsPath(recordsDir: string, id: string): string {
  assertValidRecordId(id);
  return join(recordsDir, `${id}${RECORD_EVENTS_SUFFIX}`);
}

/**
 * record id 白名单：`[\w-]`（字母数字下划线短横线）+ 长度 ≤128。
 *
 * 与 worktree-manager 的本地 SAFE_ID_RE 同式（本模块不 import 它——那会拖入
 * worktree 层依赖边；两处同式漂移由本注释锚定）。record id 生产源 =
 * record-access.ts 的 `sa-${crypto.randomUUID()}`，字符集 ⊆ 白名单；首字符
 * 白名单排除 "."、".." 与隐藏文件形态，防路径穿越。
 */
const RECORD_ID_PATTERN = /^[\w-]{1,128}$/;

function assertValidRecordId(id: string): void {
  if (!RECORD_ID_PATTERN.test(id)) {
    throw new Error(
      `非法 record id ${JSON.stringify(id)}：事件文件名只接受 [A-Za-z0-9_-] 字符集、长度 ≤128 的 id（防路径穿越）。id 应来自 record-access.ts 的 sa-<uuid>；收到非法值时检查调用方的 id 传递链。`,
    );
  }
}

// ── 首行头行形态（D3「无后缀的代价补偿」）─────────────────────

/** 头行 type 判别值（与事件词表的 type 命名空间不相交——头行不是事件）。 */
export const RECORD_EVENTS_HEADER_TYPE = "record-events";

/**
 * 事件文件首行头行：`{"type":"record-journal","id":"..."}`。
 *
 * 作用是纯自描述（文件无 .jsonl 后缀，首行声明「这是 record 事件 journal」）——
 * 不承载状态、不参与 fold；读者侧命中即静默跳过（检查点④：session-reader 首行
 * 读命中非 session header 即忽略）。写侧契约 = 文件创建时写恰一行（append 首写
 * 时落，见 FileRecordEventJournal）。
 */
export interface RecordJournalHeader { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  type: typeof RECORD_EVENTS_HEADER_TYPE;
  /** record id（= 文件主名 sa-id）。 */
  id: string;
}

/** 头行序列化形态（append 首写时落盘的 JSON 单行）。 */
export function toRecordJournalHeader(id: string): RecordJournalHeader {
  return { type: RECORD_EVENTS_HEADER_TYPE, id };
}

/** 值级头行判定（JSON.parse 产物 → 头行形状校验；fold/scan 命中即跳过）。 */
export function isRecordJournalHeader(value: unknown): value is RecordJournalHeader {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as { type?: unknown; id?: unknown };
  return rec.type === RECORD_EVENTS_HEADER_TYPE && typeof rec.id === "string" && rec.id.length > 0;
}

// ── 事件词表（D3 映射表，恰好 6 类）────────────────────────────

/** 事件类型全集（判别键）。恰好 6 个——增删成员须先改设计 D3 映射表再动此词表。 */
export const RECORD_EVENT_TYPES = [
  "record-created",
  "record-bound",
  "record-round-started",
  "record-round-idle",
  "record-settled",
  "record-reopened",
] as const;

export type RecordEventType = (typeof RECORD_EVENT_TYPES)[number];

/**
 * 事件公共信封：行级单调序号 + 墙钟时间戳。
 *
 * seq（1 起严格递增，同一文件内全序）：同一事件的唯一行身份——W2 通知去重键
 * （终态事件身份）的载体 + tail 截断重建后全量重读的 fold 去重依据（seq ≤ 已见
 * 水位的行按重放跳过，见 foldRecordEvents）。ts 对齐 run 侧 EventEnvelope
 * 的投影需求（fold 派生统计/新鲜度判据消费墙钟）。
 */
export interface RecordEventEnvelope {
  seq: number;
  ts: number;
}

/**
 * `record-created`——record 创建落账（事件文件首条事件）。
 *
 * 对应现状写点（D3 表行 1）：register（record-store 写点①）+ v2 注册条目（同点
 * 双写：journal 事件是事实，主 session 注册条目是锚）。
 */
export interface RecordCreatedEvent extends RecordEventEnvelope { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  type: "record-created";
  /** record id（= 文件主名 sa-id）。 */
  id: string;
  agent: string;
  task: string;
  slug: string;
  origin: RecordOrigin;
  /** origin="workflow" 时所属 run id（tool 来源缺省）。 */
  parentRunId?: string;
  /** origin="workflow" 时在 run 内的步骤索引（tool 来源缺省）。 */
  stepIndex?: number;
  /** 根 session id（session 隔离过滤用）。 */
  rootSessionId: string;
  /** 直接父 record id（层级树构建用；顶层缺省）。 */
  parentRecordId?: string;
  /** subagent 递归深度（顶层 = 0）。 */
  depth: number;
  mode: ExecutionMode;
  startedAt: number;
  /**
   * 模型留痕（与 .record-binding 的 model 同源；undefined = 用户未指定模型，
   * 引擎自身缺省解析）。写入点 = 记录创建，故与 created 事件同生。
   */
  model?: string;
  /** 思考档位留痕（同上；undefined = 未指定）。 */
  thinkingLevel?: string;
  /**
   * 创建时启用 worktree 隔离（与 .record-binding 的 worktree 同源；重建面
   * hadWorktree 的恢复源）。undefined/false = 未启用。
   */
  worktree?: boolean;
}

/**
 * `record-bound`——spawn 回填（sessionFile / 引擎身份已知）。
 *
 * 对应现状写点（D3 表行 2）：.record-binding 写点（spawn 回填）。D2 的
 * record-bound manifest 物化（zcode 运行窗口锚定）以本事件为产生点。
 */
export interface RecordBoundEvent extends RecordEventEnvelope { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  type: "record-bound";
  /** 子 session 文件绝对路径。 */
  sessionFile: string;
  /** 实际执行引擎 id（缺省语义 = pi 由写侧归一后落账）。 */
  engine: string;
  /** 引擎自描述定位符（与 manifest / entry 的 engineHandle 同形——sessionRef 整体透传）。 */
  engineHandle: { sessionRef: Record<string, string>; journalPath?: string; poolKey: string };
  /** 绑定生效的 epoch（与 .record-binding 的 epoch 同源）。 */
  epoch: Epoch;
}

/**
 * `record-round-started`——轮开始。
 *
 * 对应现状写点（D3 表行 3）：resumeRound / reopen 后续轮（首轮经 created→bound
 * 隐含，续轮显式落账——record 轮次粒度事件进 journal 是 D5 增量裁决：不进则
 * .state 仍是事实源，事实源介质数降不到 1）。
 */
export interface RecordRoundStartedEvent extends RecordEventEnvelope { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  type: "record-round-started";
  /** 轮序号（递增，写侧计数链）。 */
  round: number;
  epoch: Epoch;
}

/**
 * `record-round-idle`——轮终收条（为什么停 + 轮统计快照）。
 *
 * 对应现状写点（D3 表行 4）：markRoundIdle（.state 写点）。.state 降级为本事件
 * 的落盘物化投影（D2 sidecar 裁决表 .state 行）。
 */
export interface RecordRoundIdleEvent extends RecordEventEnvelope { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  type: "record-round-idle";
  /** 轮终停因（StopReason 值域——「为什么停」的轮粒度权威词）。 */
  stopReason: StopReason;
  /**
   * 轮被弃置的标记（与 .record-binding 的 lastAbandonedRound 同源；undefined = 无此
   * 记录，null = 显式清空）。轮终是它的天然写点。
   */
  lastAbandonedRound?: AbandonedRoundMark | null;
  /** 轮终时点的累计轮数快照（统计终值以 record-settled 为准，本值是过程快照）。 */
  turns: number;
  /** 轮终时点的累计 token 快照（同上）。 */
  totalTokens: number;
  /**
   * 轮终 result 摘要锚（record-settled.resultSummary 同款截断摘要；可选——旧
   * journal 行与空结果轮缺席）。承接 v1 轮终 result 显示信号（U8b：轮终迁移
   * 恰翻 result，是「轮终等待续聊」的展示面）——W1 停写 v1 entry 后轮终粒度的
   * result 断供由本锚补齐（终局全文仍只在 v2 终态条目一次性写，D1）。
   */
  resultSummary?: string;
  /**
   * 轮终失败原因原文（可选——成功轮与旧 journal 行缺席）。失败轮 outcome.reason
   * 的轮粒度结构化承载（投影 error 供源；v1 rec.error 显示信号的 journal 承接，
   * W1 终态同步 F2-2 裁决）。resultSummary 的失败摘要句是兼容形态，本字段是权威。
   */
  error?: string;
}

/**
 * `record-settled`——record 终局。
 *
 * 对应现状写点（D3 表行 5）：archive / markSettled / legacy 终态（v2 终态条目同点
 * 双写）。收编（D4）幂等追加的终态事件也是本类型（stopReason=interrupted 族）。
 */
export interface RecordSettledEvent extends RecordEventEnvelope { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  type: "record-settled";
  stopReason: StopReason;
  /** 终局展示形态（completed/failed/cancelled；终态条目 outcome 同源）。 */
  outcome?: ExecutionOutcome;
  /** failed 终局的错误文本。 */
  error?: string;
  endedAt: number;
  /** 统计终值（turns/token 的终局定稿——此后不再变化）。 */
  turns: number;
  totalTokens: number;
  /**
   * result 摘要锚（截断摘要——全文只在主 session v2 终态条目一次性写，事件行
   * 保持小；D3 载荷要点「result 摘要锚」的字面落点）。
   */
  resultSummary?: string;
}

/**
 * `record-reopened`——终态后重开（可续实体回边）。
 *
 * 对应现状写点（D3 表行 6）：markReopened。epoch 递增 + round 归零（与
 * .record-binding 的 epoch 持久化同源——notifyId `id:epoch:round` 防撞维度）。
 */
export interface RecordReopenedEvent extends RecordEventEnvelope { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  type: "record-reopened";
  /** 递增后的新 epoch。 */
  epoch: Epoch;
  /** 归零后的轮计数（恒 0——字段显式承载 D3「round 归零」载荷）。 */
  round: number;
  /**
   * 谱系引用（与 .record-binding 的 transcriptRef 同源——markReopened 是它的写点；
   * undefined = 未落）。
   */
  transcriptRef?: TranscriptRef;
}

/** record 事件判别联合（D3 词表全集，恰好 6 个；判别键 = type）。 */
export type RecordJournalEvent =
  | RecordCreatedEvent
  | RecordBoundEvent
  | RecordRoundStartedEvent
  | RecordRoundIdleEvent
  | RecordSettledEvent
  | RecordReopenedEvent;

/**
 * 写侧入参形态：事件去掉 seq（seq 由 journal 单写者分配——单调性的构造性保证，
 * 调用方无法传错）。DistributiveOmit 使联合逐成员 Omit（保持判别键窄化能力）。
 */
export type RecordJournalEventInput = DistributiveOmit<RecordJournalEvent, "seq">;

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

// ── 行解析（宽容：坏行返回 null，跳过 + 计数归调用方）──────────

const RECORD_EVENT_TYPE_SET: ReadonlySet<string> = new Set(RECORD_EVENT_TYPES);

/**
 * 值级事件行判定：JSON 对象 + type 落词表内 + seq 正整数 + ts 有限数值（信封
 * 全词表必填）。载荷字段不在此校验——解码归消费方（与 run 侧
 * isWorkflowRunEventLine 的最宽共同判定面同哲学：词表外 type / 信封坏值 = 坏行，
 * 载荷形状损坏由 fold/消费方各自的守卫承接）。
 */
export function parseRecordEventLine(value: unknown): RecordJournalEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as { type?: unknown; seq?: unknown; ts?: unknown };
  if (typeof rec.type !== "string" || !RECORD_EVENT_TYPE_SET.has(rec.type)) return null;
  if (typeof rec.seq !== "number" || !Number.isSafeInteger(rec.seq) || rec.seq < 1) return null;
  if (typeof rec.ts !== "number" || !Number.isFinite(rec.ts)) return null;
  return value as RecordJournalEvent;
}

/**
 * 文件行解析器（journal-tail / scan 共用）：空行静默跳过、头行静默跳过（合法
 * 存在，非坏行——计数语义见 readEventTail 的 skippedLines 注释）、坏行（JSON
 * 解析失败 / 词表外 / 信封坏值）返回 undefined 交调用方计数。
 */
export function parseRecordEventFileLine(line: string): RecordJournalEvent | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (isRecordJournalHeader(parsed)) return undefined;
  return parseRecordEventLine(parsed) ?? undefined;
}

// ── fold 纯函数族（全量 / 增量共用单源）────────────────────────

/**
 * fold 投影（事件流 → record 当前态）。
 *
 * 消费方：U2a 收编判据（有注册无终态）、U3 运行投影、U5 清理资格（fold 终态）。
 * settled 不是吸收位——reopened / round-started 清除 settled（可续实体回边），
 * 「当前是否终态」= settled !== undefined。
 */
export interface RecordJournalFoldState { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /** 身份域（首条 record-created 落账；undefined = 文件缺创建帧——残文件/全坏行形态）。 */
  identity: RecordCreatedEvent | undefined;
  /** 引擎绑定（record-bound 落账；zcode 运行窗口锚定的数据源）。 */
  bound: RecordBoundEvent | undefined;
  /** 当前轮计数（round-started 携带 / reopened 归零；undefined = 无轮事件）。 */
  round: number | undefined;
  /** 当前 epoch（bound / round-started / reopened 携带；undefined = 恒 0 语义）。 */
  epoch: Epoch | undefined;
  /** 最近一次轮终收条（stopReason + 轮统计快照）。 */
  roundIdle: RecordRoundIdleEvent | undefined;
  /** 当前终态（record-settled 落账、reopened/round-started 清除；undefined = 未终态）。 */
  settled: RecordSettledEvent | undefined;
  /** 最近一次重开帧（record-reopened 落账；transcriptRef / epoch·round 归零的折叠载体）。 */
  reopened: RecordReopenedEvent | undefined;
  /** fold 水位：已接受事件的最高 seq（增量续读/截断重读的去重依据）。 */
  lastSeq: number;
  /** 已接受的最后一条事件（空文件/全坏行 = undefined）。 */
  lastEvent: RecordJournalEvent | undefined;
}

/** fold 初始态（全量 fold 起点；增量 fold 以既有 state 传入）。 */
export const INITIAL_RECORD_EVENT_FOLD_STATE: RecordJournalFoldState = {
  identity: undefined,
  bound: undefined,
  round: undefined,
  epoch: undefined,
  roundIdle: undefined,
  settled: undefined,
  reopened: undefined,
  lastSeq: 0,
  lastEvent: undefined,
};

/**
 * 单步应用（纯函数，不可变更新）。
 *
 * seq 守卫不在此层——apply 假定调用方已去重（foldRecordEvents 统一把关；
 * U1/U3 直接复用 fold 入口而非手写 apply 循环，守卫单点）。
 */
export function applyRecordEvent(
  state: RecordJournalFoldState,
  event: RecordJournalEvent,
): RecordJournalFoldState {
  switch (event.type) {
    case "record-created":
      return { ...state, identity: event, lastSeq: event.seq, lastEvent: event };
    case "record-bound":
      return { ...state, bound: event, epoch: event.epoch, lastSeq: event.seq, lastEvent: event };
    case "record-round-started":
      // 轮始 = 离开终态（可续实体从终态回边续跑的时序锚）
      return {
        ...state,
        round: event.round,
        epoch: event.epoch,
        settled: undefined,
        lastSeq: event.seq,
        lastEvent: event,
      };
    case "record-round-idle":
      return { ...state, roundIdle: event, lastSeq: event.seq, lastEvent: event };
    case "record-settled":
      return { ...state, settled: event, lastSeq: event.seq, lastEvent: event };
    case "record-reopened":
      return {
        ...state,
        reopened: event,
        epoch: event.epoch,
        round: event.round,
        settled: undefined,
        lastSeq: event.seq,
        lastEvent: event,
      };
  }
}

/**
 * fold 入口（全量 / 增量共用）：事件序列 → 当前态。
 *
 * 幂等语义（验收①「词表 fold 幂等（含 seq 重放）」的承载）：
 * - 全量重放同一序列产出逐字段相等 state（纯函数自然成立）；
 * - seq ≤ 既有水位的事件行按重放跳过（onSkipped 出声）——tail 截断/重建后的
 *   幂等全量重读（D6 原语）靠它构造性去重，重读不产生重复应用；
 * - seq 跳号（gap）宽容放行——单写者 append-only 下 gap 仅在外部编辑时出现，
 *   宽容跳过语义不炸投影（与 run 侧 foldRunEventFrames 的坏帧行为同一精神）。
 */
export function foldRecordEvents(
  events: readonly RecordJournalEvent[],
  initial: RecordJournalFoldState = INITIAL_RECORD_EVENT_FOLD_STATE,
  onSkipped?: (event: RecordJournalEvent, why: "seq-regression") => void,
): RecordJournalFoldState {
  let state = initial;
  for (const event of events) {
    if (event.seq <= state.lastSeq) {
      onSkipped?.(event, "seq-regression");
      continue;
    }
    state = applyRecordEvent(state, event);
  }
  return state;
}

// ── journal 读写原语（append 单调分配 seq / scan 宽容解析）──────

/**
 * record 事件 journal 接口形态。
 *
 * 单写者约束（对齐 run 侧 RunEventJournal 纪律）：append 的唯一合法调用方 =
 * RecordStore 状态迁移点（U2a 接线）——record 域事件经 store 落账，引擎与读侧
 * 不直接写。seq 分配权在 journal 实装内（文件末水位 + 1），构造性单调。
 */
export interface RecordEventJournal { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /**
   * 追加一条事件（JSONL 单行；文件不存在时先落头行）。id 显式传参——文件定位
   * 不依赖事件形态。返回落盘的完整事件（含分配的 seq），调用方据此同步构造
   * v2 终态条目 / 物化投影（同一事件的单点载荷源）。
   */
  append(id: string, event: RecordJournalEventInput): Promise<RecordJournalEvent>;
  /**
   * 顺序扫描全部事件（写入序；头行与坏行跳过——坏行计数 warn 留证）。
   * 文件不存在 = 空 journal（record 未落账 / 已过保留期清理）。
   */
  scan(id: string): Promise<readonly RecordJournalEvent[]>;
}

/**
 * 创建文件形态的 record 事件 journal（唯一创建入口）。
 *
 * 实装体 = shared 泛型基座（JsonlEventJournal，与 run journal 单源）；本函数只提供
 * record 域策略：路径（含 id 白名单校验）、首行头行、行校验器（seq 必填）、warn 标签。
 *
 * @param recordsDir manifest 同款目录（getSubagentRecordsDir 产物；测试传
 *        mkdtemp 临时目录）。
 */
export function createRecordEventJournal(recordsDir: string): RecordEventJournal {
  return new JsonlEventJournal<RecordJournalEventInput, RecordJournalEvent>(recordsDir, {
    pathFor: (id) => recordEventsPath(recordsDir, id),
    headerFor: (id) => toRecordJournalHeader(id),
    isHeader: isRecordJournalHeader,
    parseLine: (value) => parseRecordEventLine(value) ?? undefined,
    withSeq: (event, seq) => ({ ...event, seq }) as RecordJournalEvent,
    scanWarn: (filePath, skipped) => `record-event journal scan：跳过 ${skipped} 个坏行（文件=${filePath}）`,
    warn: (message, detail) => journalLogger.warn(message, detail),
  });
}
