// src/execution/persistence/record-store-rebuild.ts
//
// [H4 三轴拆分 / 重建与投影轴] RecordStore 的无状态重建与投影纯函数族：
//   - buildRecord 重建单规则（§3.2.4：identity 基底 + `.state` sidecar 矩阵 → 一律 idle
//     + stopReason 单源）与 light/full 两分支装配（buildFileCacheEntry）；
//   - entry 重建族（collectV2EntryPairs + v2PairToRecord ——登记 §3.3 后只剩当前版本
//     通道：旧形态与未知版本结构性跳过，零幻影）；
//   - 身份解析三级优先级（[W1 / U2b] resolveRecordIdentity：事件文件 fold >
//     binding > manifest——纯函数参考实现 + 测试锚定面；现行生产路径 = v2 实体
//     fold 通道 / v1 实体磁盘重建链，分流依据 W1 D4）；
//   - manifest 读投影（manifestToSubagent / mapManifestStatus）与写投影（terminal /
//     batch / derived / legacyManifestStatusFields——session-reader 兼容契约的单点）；
//   - 内存源投影 recordToSubagent、缓存戳类型与戳校验工具（Stamp / FileCacheEntry 族）。
//
// 变化轴 = 「磁盘/entry/manifest → SubagentRecord 的读侧重建与投影规则」：重建语义
// 演进（单规则调整、投影字段增删、桥接词汇日落）集中在此文件，与写侧原语
// （record-store-terminal / -rounds）和容器编排（record-store.ts）解耦。
//
// 约束（D7 写面收敛）：本文件是纯读/纯投影——不触碰 `.state` / `.alive` / manifest
// 写面（七名写函数零 import 零调用，check-record-write-surface R1 不适用）；
// 有状态扫描（fileCache/dirStamp 编排）留在 record-store.ts，本文件只收无状态部分。

import * as fs from "node:fs";

import { getLogger } from "../../core/logger.ts";

import { getCurrentActivity, getDisplayItems, getEventLog, isLegacyClosedSettled, markReconstructedStatus } from "./execution-record.ts";
import type { RecordBinding, StateMarker } from "./state-marker.ts";
import { readRecordBinding, zcodeAnchorBasePath } from "./state-marker.ts";
import { SUBAGENT_RECORD_CUSTOM_TYPE, classifySubagentRecordEntryData } from "./record-entry.ts";
import type {
  SubagentRecordRegisteredEntryData,
  SubagentRecordSettledEntryData,
} from "./record-entry.ts";
import type { RecordBoundEvent, RecordJournalFoldState } from "./record-events.ts";
import type { ManifestRecord } from "./manifest-store.ts";
// [U7 / §3.2.6 引擎中立锚] transcriptAnchorOf（cold-lookup 导出接口）：record →
// transcript 锚的派生单点（显式 transcriptRef 优先 / zcode engineHandle.sessionRef
// 单源 / pi sessionFile 载体）——markSettled/markResurrected 的锚分派消费它，与
// isAnchorResolvable / Continuation resumeAnchor 同源防三处判据漂移。cold-lookup 对
// record-store 族是 type-only import 的部分照旧，此处运行时引用同源。
import { transcriptAnchorOf } from "../assembly/cold-lookup.ts";
import {
  type IdentityHeaderRecon,
  type ReconstructedRecord,
  readIdentityAnywhere,
  readIdentityHeader,
  readIdentityTail,
  IDENTITY_HEAD_BYTES,
} from "./session-reconstructor.ts";
import type { ClosedReason, ExecutionMode, ExecutionStatus, RecordOrigin, ZcodeTranscriptRef } from "../domain/record-types.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";
import type { SubagentRecord } from "../assembly/types.ts";
import { CLOSED_REASONS as CLOSED_REASON_LIST } from "../domain/record-types.ts";
import { isZcodeTranscriptRef, isValidStopReason } from "../domain/record-model.ts";

const logger = getLogger("subagents");

/**
 * [R4/D6-③ 空串归一] 水合读侧的 model 空串 → 缺席归一（禁空串哨兵纪律覆盖持久化
 * 读写两侧）：写侧（R4 起）record.model 缺席恒为 undefined，但存量磁盘数据与新链
 * 的防御面可能残留 ""（旧写侧「仅满足非可选类型」的 `?? ""` 产物）——空串若复活进
 * record，taskSpecWithModel 对 `""` 仍带键，引擎侧「压掉 defaultModelSelection」
 * 会经空串路径静默回归。四处水合点（entry 投影 / manifest 投影 / 孤儿合并 / binding
 * 守卫）统一归一。
 */
function modelOrUndefined(v: string | undefined): string | undefined {
  return v !== undefined && v.trim() !== "" ? v : undefined;
}

// ============================================================
// 缓存/戳类型（FileCache 族——容器 scanFile/reconstructAll 与本文件投影共享）
// ============================================================

/** 缓存校验戳（mtime+size 双因子——append-only jsonl 必变 size；sidecar 覆盖写必变 mtime）。 */
export interface Stamp {
  mtimeMs: number;
  size: number;
}

/** sidecar 状态矩阵输入（buildLightRecord / getFullRecord 共享）。
 *  [U4a / D3b (a)] alive 维度已随 externalInstance 投影移除——非终态统一兜底 running，
 *  探活读面由 (a′)(a″) 的 findForeignLiveInstance 现查探针承担（不在重建缓存）。 */
export interface SidecarMatrix {
  /** 终态 sidecar（.state 优先，兼容旧 .finalized/.cancelled 归一）。undefined = 未终态化。 */
  state: StateMarker | undefined;
  /** jsonl mtime（light 分支 2 的 endedAt 近似——finalize 后文件不再变化）。 */
  jsonlMtimeMs: number;
  /** 全量重建可得的精确结束时间（最后 entry ts）；light 传 undefined 回落 mtime。 */
  fullEndedAt?: number;
}

/**
 * per-file 缓存条目（[perf] 两级设计）。
 *
 *   light：头部 identity + sidecar 状态矩阵（列表扫描产出，详情字段缺省）
 *   full ：懒加载的完整重建（getFullRecord 按需补 turns/eventLog/result）。
 *          full === light 是哨兵（「已尝试但无详情可补」，如无 assistant message
 *          的文件），避免重复全文重读；stat 戳变化时随 light 一起重置重试。
 *
 * 校验：jsonl + 终态 sidecar + record 绑定（[UF-1]）的 stat 戳对比（终态戳为该组文件 .state/.finalized/.cancelled 的合并戳，见 state-marker.statStateStamp；[U4a / D3b (a)] alive 戳已随 externalInstance 投影移除——light 态不依赖 .alive，探活读面走现查探针）。任何写操作至少改变一个戳 →
 * 只重建该文件，其余 N-1 个复用缓存（statSync 毫秒级，取代旧的整体失效重扫）。
 */
export interface FileCacheEntry {
  /** tagged union 判别（负缓存条目为 true）。显式声明 false 供 TS narrowing。 */
  negative?: false;
  light: SubagentRecord;
  full: SubagentRecord | undefined;
  jsonl: Stamp;
  /** [UF-1] record 绑定 sidecar 戳（null = 无绑定文件）。 */
  binding: Stamp | null;
  /**
   * 事件文件（`<recordsDir>/<id>.events`）戳（null = 无事件文件/无 id）。
   * 缓存键的第四维：轮终收条写在 jsonl 末次写入**之后**，只比 jsonl 会漏掉收条变化
   * ——索引/缓存命中会端出过期的终态。
   */
  events: Stamp | null;
  /** 最近一次重建时读到的终态 sidecar 内容（校验命中路径复用，不重读文件）。 */
  stateMarker: StateMarker | undefined;
}

/** 负缓存条目：确认无 identity 的文件（损坏/异构）。缓存「没有」这一事实，
 *  避免每轮扫描都全文 fallback 重读（全文读是 fallback 的成本主体）。 */
export interface NegativeFileEntry {
  negative: true;
  jsonl: Stamp;
  /** [UF-1] 绑定戳纳入负缓存：绑定文件后到（run 应答回填点落盘）改变戳，
   *  打破负缓存触发重探测——「先扫描后绑定落盘」时序的恢复能力锚点。 */
  binding: Stamp | null;
}

/** fileCache 值类型：正常条目或负缓存条目。 */
export type FileCacheValue = FileCacheEntry | NegativeFileEntry;

/** scanFile 单文件本轮 stat 戳集合（jsonl + 终态 sidecar（含旧名合并戳）+ record 绑定；
 *  [U4a / D3b (a)] alive 戳退役——light 态不依赖 .alive，省去每文件一次 statSync）。 */
export interface FileStamps {
  jsonl: Stamp;
  binding: Stamp | null;
}

/** sidecar payload 读取结果（索引命中与探测重建两分支共享的读点）。 */
export interface SidecarPayloads {
  /** [UF-1] record 绑定载荷（identity miss 时的身份重建源）。 */
  binding: RecordBinding | undefined;
}

// ============================================================
// 排序与 manifest 状态映射
// ============================================================

/** status → 排序优先级（值小排前）：running < idle。
 *  [U2 两态] 永久会话模型：running（在飞）排前，idle（已收口/等续聊）随后；
 *  旧 closed 终态排序位随终态概念删除折入 idle（closedReason 遗留位区分死因）。 */
const STATUS_PRIORITY: Record<ExecutionStatus, number> = {
  running: 0,
  idle: 1,
};

/** 排序比较器：status priority（running<failed<cancelled<done）+ startedAt desc。 */
export function compareRecords(a: SubagentRecord, b: SubagentRecord): number {
  const pdiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
  if (pdiff !== 0) return pdiff;
  return b.startedAt - a.startedAt; // 新→旧
}

/**
 * manifest status → ExecutionStatus 运行时守卫映射。
 *
 * manifest 写 running/closed/cancelled 三态（ManifestRecord.status union——
 * session-reader 兼容契约，保留），但磁盘文件可能陈旧（含历史 "completed"/"failed"/
 * "error" 值、被外部篡改）。越界值返回 null——manifestToSubagent 据此返回 null，
 * collectRecords 跳过损坏 record 并 console.warn，不因单个坏文件崩溃。
 *
 * [U2 两态迁移] 旧终态三值（closed/completed/failed/cancelled）统一映射 idle；
 * closedReason 兼容位由 manifestToSubagent 投影（桥接不变量：idle ∧ closedReason
 * 有值 ⟺ 旧终态形态）。
 *
 * 提取为纯函数：同时解决 PR#85 反射问题（三元 + `as ExecutionStatus` cast）。
 * [HISTORICAL] SP-1 重构：旧 "completed" → closed，旧 "failed" → closed（L1 统一终态）。
 */
function mapManifestStatus(s: string): ExecutionStatus | null {
  if (s === "closed") return "idle";
  if (s === "completed") return "idle"; // 向后兼容旧 manifest 数据
  if (s === "failed") return "idle";     // 向后兼容旧 manifest 数据
  if (s === "running") return "running";
  if (s === "cancelled") return "idle"; // v4 B-1: manifest cancelled 折入终态（closedReason 信息丢失，manifest 仅诊断辅助）
  return null; // 越界=数据损坏（含历史 "error" 值），返回 null 让调用方跳过
}

/**
 * [U8 / §3.2.8 双写回读] manifest → ExecutionStatus 的读侧单点：executionStatus
 * （两态权威词）在场且合法时**优先**——旧三态 status 只是 session-reader 下行投影，
 * settle 产物（legacy running + executionStatus idle）按权威词读回 idle，闭环
 * 「写侧下行映射不污染读侧占用判定」。executionStatus 缺失/越界（旧 manifest /
 * 外部写入垃圾）回落 mapManifestStatus（legacy status 越界仍返回 null 跳过——
 * 双字段全坏 = 数据损坏，维持既有 skip 语义）。
 */
function manifestStatusToExecution(m: ManifestRecord): ExecutionStatus | null {
  if (m.executionStatus === "idle" || m.executionStatus === "running") return m.executionStatus;
  return mapManifestStatus(m.status);
}

// ============================================================
// entry 重建族（主 session「每 id 末条 subagent-record entry」→ SubagentRecord）
// ============================================================

/** unknown → subagent-record entry 的运行时守卫（taste/no-unsafe-cast：断言前收窄）。 */
function asSubagentRecordEntry(o: unknown): { id: string; data: Record<string, unknown> } | null {
  if (typeof o !== "object" || o === null) return null;
  const obj = o as Record<string, unknown>;
  if (obj.type !== "custom" || obj.customType !== SUBAGENT_RECORD_CUSTOM_TYPE) return null;
  if (typeof obj.data !== "object" || obj.data === null) return null;
  const data = obj.data as Record<string, unknown>;
  return typeof data.id === "string" ? { id: data.id, data } : null;
}

/**
 * [登记 §3.3] 主 session 全文 → 每 id 的 v2 条目对（registered / settled，后写覆盖）。
 *
 * v 门内联（classifySubagentRecordEntryData 单源）：非当前版本 / 未知 kind 的行跳过
 * 而非猜测——v1 全量快照形态已随兼容层删除，旧形态不进任何解析路径（零幻影）。
 * 快过滤与 collectV2EntryState 同款（customType 子串）。
 */
export interface V2EntryPair {
  registered?: SubagentRecordRegisteredEntryData;
  settled?: SubagentRecordSettledEntryData;
}

export function collectV2EntryPairs(content: string): Map<string, V2EntryPair> {
  const byId = new Map<string, V2EntryPair>();
  for (const line of content.split("\n")) {
    if (!line.includes(SUBAGENT_RECORD_CUSTOM_TYPE)) continue; // 快过滤：绝大多数行不是本类型
    let entry: { id: string; data: Record<string, unknown> } | null = null;
    try {
      entry = asSubagentRecordEntry(JSON.parse(line));
    } catch (err) {
      // 截断/异构行跳过（主文件末行可能正被写入）——行级 best-effort，debug 留痕
      logger.debug("[subagents] v2 entry scan: skip unparsable line", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    if (entry === null) continue;
    const verdict = classifySubagentRecordEntryData(entry.data);
    if (!verdict.ok) {
      logger.debug("[subagents] v2 entry scan: skip non-current subagent-record entry", {
        id: entry.id,
        reason: verdict.reason,
      });
      continue;
    }
    const pair = byId.get(entry.id) ?? {};
    if (verdict.entry.kind === "registered") pair.registered = verdict.entry;
    else pair.settled = verdict.entry;
    byId.set(entry.id, pair);
  }
  return byId;
}

/**
 * [登记 §3.3] v2 条目对 → SubagentRecord（entry 面重建）。
 *
 * 身份域取注册条目（缺注册条目的终态行不成实体——身份无所出，返回 null）；终局域取
 * 终态条目；运行态记录（无终态条目）的引擎域回落 journal 的 bound 事件（条目契约
 * 不承载 engine/sessionFile）。
 *
 * 缺省纪律：v2 条目契约不承载的字段（patchFile / worktree / round / closedReason /
 * batchFinalized / 详情域）一律缺席——与 runtime 投影 projectV2Subagent 同口径，
 * 这些字段的权威源在 manifest 与子 session 文件。
 */
export function v2PairToRecord(
  id: string,
  pair: V2EntryPair,
  bound?: RecordBoundEvent,
): SubagentRecord | null {
  const registered = pair.registered;
  if (registered === undefined) return null;
  // 损坏身份域（agent / task / startedAt 缺失或类型漂移）→ 拒绝重建（零幻影）：
  // 分类只认 v/kind（形态合法 ≠ 载荷可用），字段级守卫与旧 v1 重建路径同款——
  // 消费方（scanLastRecordEntries / 纠偏判定）据此跳过并 warn 留痕。
  if (
    typeof registered.agent !== "string" ||
    typeof registered.task !== "string" ||
    typeof registered.startedAt !== "number"
  ) {
    return null;
  }
  const settled = pair.settled;
  const engine = settled?.engine ?? bound?.engine;
  const engineHandle = settled?.engineHandle ?? bound?.engineHandle;
  const sessionFile = settled?.sessionFile
    ?? (bound !== undefined && bound.sessionFile !== "" ? bound.sessionFile : undefined);
  return {
    id,
    agent: registered.agent,
    task: registered.task,
    slug: registered.slug,
    status: settled !== undefined ? "idle" : "running",
    ...(settled?.stopReason !== undefined ? { stopReason: settled.stopReason } : {}),
    ...(settled?.outcome !== undefined ? { outcome: settled.outcome } : {}),
    mode: "background",
    startedAt: registered.startedAt,
    rootSessionId: registered.rootSessionId,
    parentRecordId: registered.parentRecordId,
    depth: registered.depth,
    origin: registered.origin,
    parentRunId: registered.parentRunId,
    stepIndex: registered.stepIndex,
    endedAt: settled?.endedAt,
    turns: settled?.turns ?? 0,
    totalTokens: settled?.totalTokens ?? 0,
    model: modelOrUndefined(settled?.model),
    thinkingLevel: settled?.thinkingLevel,
    eventLog: [],
    displayItems: [],
    result: settled?.result,
    error: settled?.error,
    sessionFile,
    ...(engine !== undefined ? { engine } : {}),
    ...(engineHandle !== undefined ? { engineHandle } : {}),
  };
}



/**
 * [U7 / §3.2.6] record 的 zcode 锚（cold-lookup transcriptAnchorOf 派生单点的 zcode
 * 筛选形态——显式 transcriptRef 优先 / engineHandle.sessionRef 单源）。pi record 恒
 * undefined（sessionFile 载体在，锚分派的 pi 腿优先）。
 */
export function zcodeRefOf(record: ExecutionRecord): ZcodeTranscriptRef | undefined {
  const anchor = transcriptAnchorOf(record);
  return anchor !== undefined && isZcodeTranscriptRef(anchor) ? anchor : undefined;
}

/** engineHandle entry 值的运行时 guard（未知 JSON 不裸收；形状与 runtime 读侧
 *  subagent-engine-history 的 extractRecordEngineHandle 守卫语义对齐：poolKey
 *  必有非空 string + sessionRef 值全 string 才收，journalPath 可选 string）。 */
export function isEngineHandleShape(
  v: unknown,
): v is { sessionRef: Record<string, string>; journalPath?: string; poolKey: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const h = v as Record<string, unknown>;
  if (typeof h.poolKey !== "string" || h.poolKey.length === 0) return false;
  if (typeof h.sessionRef !== "object" || h.sessionRef === null || Array.isArray(h.sessionRef)) {
    return false;
  }
  for (const value of Object.values(h.sessionRef as Record<string, unknown>)) {
    if (typeof value !== "string") return false;
  }
  if (h.journalPath !== undefined && typeof h.journalPath !== "string") return false;
  return true;
}


// ============================================================
// 戳工具与 sidecar 读取
// ============================================================

/** stat 戳（不存在 → null）。 */
export function statStamp(p: string): Stamp | null {
  try {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

export function sameStamp(a: Stamp, b: Stamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** ClosedReason 合法值集合（sidecar 内容校验用：外部损坏/手写垃圾内容 → disconnected）。
 * SSOT = types.ts CLOSED_REASONS 可写终态原因清单，此处仅建 Set 索引（避免第二份字面量清单漂移）。 */
const CLOSED_REASONS: ReadonlySet<string> = new Set(CLOSED_REASON_LIST);

/** sidecar 内容是否为合法的 ClosedReason 字面量（disconnected 只作兜底产出，不接受写入）。 */
export function isValidClosedReason(value: string | undefined): value is ClosedReason {
  return value !== undefined && CLOSED_REASONS.has(value);
}

export function sameNullableStamp(a: Stamp | null, b: Stamp | null): boolean {
  if (a === null || b === null) return a === b;
  return sameStamp(a, b);
}

/** 缓存条目与本轮 stat 戳全同（jsonl + 终态 sidecar + record 绑定，null 语义对齐）→ 零读取复用。 */
export function isFreshCache(cached: FileCacheValue, stamps: FileStamps, events: Stamp | null): boolean {
  if (!sameStamp(cached.jsonl, stamps.jsonl) || !sameNullableStamp(cached.binding, stamps.binding)) {
    return false;
  }
  // 负缓存无 id → 无事件文件可对账（只比 jsonl）。
  return cached.negative === true ? true : sameNullableStamp(cached.events, events);
}

/**
 * identity 三级定位——头部 64KB（首轮会话，~34%）→ 尾部 64KB（续聊场景最后一轮
 * session_start 追加，~65%）→ 全文 fallback（~0.2%）。均不解析 message entries。
 * size ≤ 头部读取上限时 head 读到的即全文，tail/anywhere 只会重复读同一份内容——
 * 直接判负（head miss = 全文无 identity），省去同内容两连读。
 */
export function detectIdentity(file: string, size: number): IdentityHeaderRecon | undefined {
  return size <= IDENTITY_HEAD_BYTES
    ? readIdentityHeader(file)
    : readIdentityHeader(file) ?? readIdentityTail(file) ?? readIdentityAnywhere(file);
}

/**
 * sidecar payload 读取（读顺序：终态 marker → record 绑定）。
 * 两者都是活态数据，调用方沿用每轮重读语义；终态 marker 静态数据仅在戳非空时读
 * （文件小，成本可忽略）。
 */
export function readSidecarPayloads(file: string, stamps: FileStamps): SidecarPayloads {
  return {
    binding: stamps.binding !== null ? readRecordBinding(file) : undefined,
  };
}

/**
 * 折叠状态 → 终态收条（`.state` sidecar 退场的桥，① 读侧换源的落点）。
 *
 * 语义与 `readStateMarker` 读出的新格式同形（status=idle + reason + endedAt）：
 *   - `record-settled` 在场 → 终局收条（endedAt 用事件自带时间）；
 *   - 否则 `record-round-idle` **且它是最后一条事件** → 轮终收条（endedAt 用该事件
 *     时间；记录停在轮终未终局）；
 *   - 其余 → undefined（无收条 = 在途中断，与 sidecar 缺席同语义）。
 *
 * 「轮终收条须是最后一条事件」不是细节而是必需：续轮记录（round-idle 之后又
 * round-started）若仍按上一条 round-idle 投影，会把上一轮的停因当成当前停因写进
 * 运行中的记录——与 journal 投影侧「轮始清残留死因」同一条语义（`lastEvent` 判定）。
 *
 * 纯函数：不做旧格式上行映射（那是 sidecar 存量兼容面，随 sidecar 一起退场）。
 */
export function stateMarkerFromFold(fold: RecordJournalFoldState | undefined): StateMarker | undefined {
  if (fold === undefined) return undefined;
  if (fold.settled !== undefined) {
    return { status: "idle", reason: fold.settled.stopReason, endedAt: fold.settled.endedAt };
  }
  if (fold.roundIdle !== undefined && fold.lastEvent === fold.roundIdle) {
    return { status: "idle", reason: fold.roundIdle.stopReason, endedAt: fold.roundIdle.ts };
  }
  return undefined;
}

// ============================================================
// 身份基底 → light/full 缓存条目 → 重建单规则
// ============================================================

/**
 * [UF-1] record 绑定载荷 → light 身份基底（IdentityHeaderRecon 同形投影）。
 * 绑定缺失/损坏返回 undefined（调用方落负缓存，不把损坏残留误判成身份）。
 * forkDepth/model_change/thinking_level_change 等头部途经信息绑定期不存在：
 * forkDepth 恒 undefined、model/thinkingLevel 取绑定快照值。
 */
export function identityFromBinding(binding: RecordBinding | undefined, file: string): IdentityHeaderRecon | undefined {
  if (binding === undefined) return undefined;
  return {
    id: binding.recordId,
    agent: binding.agent,
    mode: binding.mode,
    task: binding.task,
    slug: binding.slug,
    startedAt: binding.startedAt,
    rootSessionId: binding.rootSessionId,
    parentRecordId: binding.parentRecordId,
    depth: binding.depth,
    forkDepth: undefined,
    // [modeless 波1] chatMode 读侧丢弃（旧 binding 残留键自然忽略）。
    worktree: binding.worktree,
    // [H2 S3] 来源域透传：漏本两行则引擎子文件身份面（binding sidecar）重建丢
    // origin，归档/重启后 workflow record 逃过 D1 投影过滤（Gate B S3 FAIL 根因）。
    // binding 读侧（readRecordBinding）已字面量守卫归一，此处直传。
    // [W0 / D1] stepIndex 同族直传：identity entry 缺失时（非 pi 引擎 / extension
    // 重启）binding 是身份源——漏投影则重启后 record 无 stepIndex（run 视图关联键
    // 静默缺失，无编译红无测试红的降级，同族先例 H2 S3）。
    origin: binding.origin,
    parentRunId: binding.parentRunId,
    stepIndex: binding.stepIndex,
    model: binding.model,
    thinkingLevel: binding.thinkingLevel,
    sessionFile: file,
  };
}

// ============================================================
// [W1 / U2b] 身份解析三级优先级（事件文件 fold > binding > manifest）
// ============================================================

/** 身份解析命中源（优先级可观察面——排障对账与测试锚定）。 */
export type RecordIdentitySource = "journal-fold" | "binding" | "manifest";

/**
 * 恢复路径解析出的 record 身份域（设计 D2 binding 行裁决：事件文件 fold >
 * binding 兜底（旧数据兼容）> manifest；字段集 = D3 record-created 载荷同集）。
 *
 * 消费现状（如实登记）：本三级裁决是纯函数参考实现 + 测试锚定面
 * （record-store-rebuild-v-gate.test.ts），现行生产路径不经本函数——v2 实体走
 * fold 通道（record-store 收编/投影直接消费 fold.identity），v1 实体走磁盘重建链
 * （identity entry > binding > manifest 的内联组装），分流依据设计 D4（收编定界
 * 按注册条目形态分流）。三级源由调用方各自读好传入（本函数纯函数无 IO），高级源
 * 在场即整体胜出（冲突字段取高级源值——单写者下冲突仅见于数据损坏，不引入
 * 字段级合并的第二种语义）；高级源缺失/身份域损坏逐级降级；三源皆缺 →
 * undefined（调用方按无身份处理）。后续调身份优先级（如 W2 接线）时先立接线
 * 设计裁决，再让生产路径消费本单点。
 *
 * model/thinkingLevel/sessionFile 不在身份域（fold 的 record-created 不携带，
 * 绑定/引擎域属 bound 事件与 sidecar 面）——组装 IdentityHeaderRecon 基底由
 * 调用方补齐，本类型只承载三级裁决共有的身份字段。
 */
export interface ResolvedRecordIdentity {
  id: string;
  agent: string;
  task: string;
  slug: string;
  mode: ExecutionMode;
  startedAt: number;
  rootSessionId: string | undefined;
  parentRecordId: string | undefined;
  depth: number;
  origin: RecordOrigin | undefined;
  parentRunId: string | undefined;
  stepIndex: number | undefined;
  /** 命中源（三级优先级判定的结果面）。 */
  source: RecordIdentitySource;
}

/** journal 行级解析只校验事件信封（type/seq/ts），身份域载荷解码归本消费方——
 *  必需标量形状不满足视为 fold 身份不可用，降级下一级（与 identityFromBinding
 *  「损坏残留不误判成身份」同向）。 */

/** unknown → string | undefined（JSON 值安全读取；entryStr 同形，身份解析节局部）。 */
function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** unknown → number | undefined（JSON 值安全读取；entryNum 同形）。 */
function optNum(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function identityFromFoldSource(fold: RecordJournalFoldState | undefined): ResolvedRecordIdentity | undefined {
  const identity = fold?.identity;
  if (identity === undefined) return undefined; // 残文件/全坏行形态（record-events 注释）
  if (
    typeof identity.id !== "string" ||
    typeof identity.agent !== "string" ||
    typeof identity.task !== "string" ||
    typeof identity.slug !== "string" ||
    typeof identity.startedAt !== "number" ||
    typeof identity.depth !== "number" ||
    identity.mode !== "background"
  ) {
    logger.debug("[subagents] identity resolve: corrupt record-created identity, falling back", {
      id: identity.id,
    });
    return undefined;
  }
  return {
    id: identity.id,
    agent: identity.agent,
    task: identity.task,
    slug: identity.slug,
    mode: identity.mode,
    startedAt: identity.startedAt,
    // optional 身份域经安全读取（entryStr/entryNum 同款——JSON 值不裸收）
    rootSessionId: optStr(identity.rootSessionId),
    parentRecordId: optStr(identity.parentRecordId),
    depth: identity.depth,
    origin: identity.origin === "workflow" || identity.origin === "tool" ? identity.origin : undefined,
    parentRunId: optStr(identity.parentRunId),
    stepIndex: optNum(identity.stepIndex),
    source: "journal-fold",
  };
}

/** binding 源投影：字段直传（readRecordBinding 读侧已字面量守卫归一，
 *  identityFromBinding 直传同款信任面）。 */
function identityFromBindingSource(binding: RecordBinding | undefined): ResolvedRecordIdentity | undefined {
  if (binding === undefined) return undefined;
  return {
    id: binding.recordId,
    agent: binding.agent,
    task: binding.task,
    slug: binding.slug,
    mode: binding.mode,
    startedAt: binding.startedAt,
    rootSessionId: binding.rootSessionId,
    parentRecordId: binding.parentRecordId,
    depth: binding.depth,
    origin: binding.origin,
    parentRunId: binding.parentRunId,
    stepIndex: binding.stepIndex,
    source: "binding",
  };
}

/** manifest 源投影（兜底层）：投影语义对齐 manifestToSubagent——task/slug 缺失
 *  兜底空串、mode 恒 background、depth 恒 0、rootSessionId 空串归 undefined、
 *  parentRecordId 不采信（manifestToSubagent 同款）、无来源域字段。 */
function identityFromManifestSource(m: ManifestRecord | undefined): ResolvedRecordIdentity | undefined {
  if (m === undefined) return undefined;
  return {
    id: m.id,
    agent: m.agentName,
    task: m.task ?? "",
    slug: m.slug ?? "",
    mode: "background",
    startedAt: m.createdAt,
    rootSessionId: m.rootSessionId || undefined,
    parentRecordId: undefined,
    depth: 0,
    origin: undefined,
    parentRunId: undefined,
    stepIndex: undefined,
    source: "manifest",
  };
}

/**
 * 恢复路径身份解析（三级优先级参考实现，设计 D2：事件文件 fold > binding > manifest）。
 * 现状：仅测试锚定（生产路径分流见 {@link ResolvedRecordIdentity} 注释的如实登记）。
 * 纯函数：三级源由调用方读好传入；高级源在场即整体胜出（冲突时高级源字段胜出），
 * 缺失/损坏逐级降级，三源皆缺 → undefined。
 */
export function resolveRecordIdentity(
  fold: RecordJournalFoldState | undefined,
  binding: RecordBinding | undefined,
  manifest: ManifestRecord | undefined,
): ResolvedRecordIdentity | undefined {
  return identityFromFoldSource(fold) ?? identityFromBindingSource(binding) ?? identityFromManifestSource(manifest);
}

/** identity 基底 + sidecar 状态矩阵 → 缓存条目（索引命中与探测重建两分支的公共装配点）。 */
export function buildFileCacheEntry(
  base: IdentityHeaderRecon,
  file: string,
  stamps: FileStamps,
  payloads: SidecarPayloads,
  state: StateMarker | undefined,
  events: Stamp | null,
): FileCacheEntry {
  return {
    light: buildRecord(base, {
      state,
      jsonlMtimeMs: stamps.jsonl.mtimeMs,
    }),
    full: undefined,
    jsonl: stamps.jsonl,
    binding: stamps.binding,
    events,
    stateMarker: state,
  };
}

/** identity 基底（头部 light 或全量 recon）+ `.state` 收口矩阵 → SubagentRecord（§3.2.4 重建单规则）。
 *  [R4/D6-③] base 直查路径同批归一（存量索引 "" 条目）：索引命中分支把 `...hit` 展开为
 *  IdentityHeaderRecon 直入本函数，R4 升级前旧写侧落盘的 `model:""` 条目（loadIndex 守卫
 *  接受 "" 合法 string）经此水合——与 entry/manifest/孤儿合并三水合点同批 modelOrUndefined。 */
export function buildRecord(
  base: IdentityHeaderRecon | ReconstructedRecord,
  m: SidecarMatrix,
): SubagentRecord {
  let rec: SubagentRecord;
  if ("turns" in base) {
    // 全量：turnCount/totalTokens/model/eventLog/displayItems/result/error 齐全。
    rec = {
      id: base.id,
      agent: base.agent,
      slug: base.slug,
      status: "running", // 占位，下方矩阵覆盖
      mode: base.mode,
      startedAt: base.startedAt,
      rootSessionId: base.rootSessionId,
      parentRecordId: base.parentRecordId,
      depth: base.depth,
      // [H2 S3] 来源域落位（identity 面已守卫归一）：缺省 undefined = "tool" 语义。
      // [W0 / D1] stepIndex 同族落位（[W0 / D1] run 视图关联键）。
      origin: base.origin,
      parentRunId: base.parentRunId,
      stepIndex: base.stepIndex,
      endedAt: undefined,
      turns: base.turnCount,
      totalTokens: base.totalTokens,
      model: modelOrUndefined(base.model),
      thinkingLevel: base.thinkingLevel,
      task: base.task,
      currentActivity: undefined,
      eventLog: base.eventLog,
      displayItems: getDisplayItems(base),
      result: base.result,
      error: base.error,
      sessionFile: base.sessionFile,
      worktree: base.worktree,
    };
  } else {
    // light：详情字段缺省（turns=0/eventLog=[]/result=undefined），getFullRecord 懒补。
    rec = {
      id: base.id,
      agent: base.agent,
      slug: base.slug,
      status: "running", // 占位，下方矩阵覆盖
      mode: base.mode,
      startedAt: base.startedAt,
      rootSessionId: base.rootSessionId,
      parentRecordId: base.parentRecordId,
      depth: base.depth,
      // [H2 S3] 来源域落位（同全量分支）+ [W0 / D1] stepIndex 同族落位。
      origin: base.origin,
      parentRunId: base.parentRunId,
      stepIndex: base.stepIndex,
      endedAt: undefined,
      turns: 0,
      totalTokens: 0,
      model: modelOrUndefined(base.model),
      thinkingLevel: base.thinkingLevel,
      task: base.task,
      currentActivity: undefined,
      eventLog: [],
      displayItems: [],
      result: undefined,
      error: undefined,
      sessionFile: base.sessionFile,
      worktree: base.worktree,
    };
  }

  // ── [U3 / §3.2.4] 重建单规则：重建一律得 idle，stopReason 取自 `.state`
  //（无则 interrupted-by-restart）。崩溃恢复不再区分「终态不可逆 / 纳管可保留 /
  //  直断 gc」——不存在不可逆终态；崩溃后 running 只在轮次在飞时有意义，必然空闲。
  markReconstructedStatus(rec, "idle");
  if (m.state !== undefined && m.state.status === "idle") {
    // 新格式收条（markSettled 写面）：stopReason = 收口 reason（值域 StopReason；
    // 非法/缺失 → interrupted-by-restart——「死因不可考 = 被打断」同族兜底）。
    // closedReason 不写（桥接不变量新侧：settle 产出的 idle 无旧终态遗留位，
    // live ≡ reload 与内存 markSettled 形态构造性一致）；endedAt 不投影（内存
    // settle 非终态不写 endedAt——收条时间留给 binding 快照面，U7 统计口径消费）。
    const reason = m.state.reason?.trim();
    rec.stopReason = isValidStopReason(reason) ? reason : "interrupted-by-restart";
  } else if (m.state !== undefined && m.state.status === "cancelled") {
    // 旧值上行映射（§3.2.4：cancelled → interrupted）：closedReason 保留
    // "cancelled"（U2 桥接判据 idle ∧ closedReason 有值 → legacy closed/cancelled
    // 投影，旧 session-reader 兼容面）；stopReason 切新词表。
    rec.closedReason = "cancelled";
    rec.stopReason = "interrupted";
    rec.error = "cancelled by user";
    // endedAt 用 sidecar 携带的精确值（原 tombstone.endedAt）；缺失（旧写侧恒携带，
    // 兼容手写残留）回落全量末 entry ts / light mtime。
    rec.endedAt = m.state.endedAt ?? m.fullEndedAt ?? m.jsonlMtimeMs;
  } else if (m.state !== undefined) {
    // 旧值上行映射（finalized → idle + stopReason=reason）：closedReason 优先用
    // sidecar 内容携带的真实原因（[v8.5 A2] doFinalizeRecord Step3 写入）。空内容
    // （旧格式空文件 / 未携 reason 的外部写入）→ disconnected 兜底：死因不可考，
    // 但「正常结束过」信号仍在；非枚举值（外部损坏/手写垃圾内容）同 treated as
    // unknown → disconnected。**旧版读新值的回滚降级链**（§3.2.4 双向兼容②）：
    // 未知 status 在 readNewStateMarker 落 {status:"finalized"} 无 reason → 本分支
    // disconnected ∈ 旧版可重连集，回滚方向良性。
    const reason = m.state.reason?.trim();
    rec.closedReason = isValidClosedReason(reason) ? (reason as ClosedReason) : "disconnected";
    rec.stopReason = rec.closedReason;
    // 全量路径用最后 entry ts（精确）；light 路径用 jsonl mtime 近似（finalize 后
    // 文件不再变化，误差 <1s），避免重建后耗时随墙钟无限增长。
    rec.endedAt = m.fullEndedAt ?? m.jsonlMtimeMs;
  } else {
    // 无 sidecar：在途中断（崩溃）或尚未收口（§3.2.4「文件不存在」行）——
    // interrupted-by-restart 展示值（G2：为什么停；U6 起参与 isOccupied 判定）。
    // closedReason 不写（无终态遗留位 → legacy 投影 running「活跃会话」）、endedAt
    // 不写（非终态）。
    rec.stopReason = "interrupted-by-restart";
  }
  return rec;
}

// ============================================================
// manifest 投影族（读侧 manifestToSubagent + 写侧 terminal/batch/derived）
// ============================================================

/** 终态 manifest 投影（markFinalized/markCancelled 共用；对齐 writeManifestBestEffort
 *  现状投影——status 统一 closed，closedReason 随投影携带）。
 *  [U4c / G2 词汇双写] executionStatus（ExecutionStatus 两态）随终态写面双写——
 *  旧 status 三态是 session-reader 直读的投影字段（永久保留），新字段是内部权威
 *  词汇的写面过渡锚（D5 词汇全景①③并存）。[U2 两态] 内部权威词汇无 closed——
 *  终态化后的 executionStatus = idle（closedReason 遗留位区分死因）。
 *  [U8 / B-restart] engine/engineHandle 域随终态投影下行（zcode 终态 record 的
 *  manifest 兜底锚，与 derived/batch 投影同域）。 */
export function terminalManifestRecord(record: ExecutionRecord): ManifestRecord {
  return {
    id: record.id,
    rootSessionId: record.rootSessionId ?? "",
    parentRecordId: record.parentRecordId,
    agentName: record.agent,
    status: "closed",
    executionStatus: "idle",
    closedReason: record.closedReason,
    createdAt: record.startedAt,
    completedAt: record.endedAt ?? Date.now(),
    sessionFile: record.sessionFile,
    task: record.task,
    slug: record.slug,
    model: record.model,
    engine: record.engine,
    engineHandle: record.engineHandle,
  };
}

/**
 * [U2 两态桥接 + U8 / §3.2.8] 旧 status 三态（session-reader 兼容契约）的派生单点。
 * 判定序（先命中先出）：
 *   1. idle ∧ closedReason 有值（桥接不变量「旧 closed 终态」读形态——workflow D7
 *      例外族与监督器放弃仍产出）→ cancelled（reason='cancelled'）/ closed 二分；
 *   2. 其余（running / 轮间 idle（markSettled 无 closedReason）/ close 收口落账
 *      record）→ running
 *      （session-reader 视角的活跃成员，§3.2.8 行为变化声明：可续聊 record =
 *      活跃会话——settle/轮终后 stopReason=interrupted/completed/failed 的 record
 *      也投 running，
 *      「为什么停」经 executionStatus + 下游 stopReason 通道表达，不翻旧终态：
 *      settle 的 record 仍可 message 续聊，投 closed 会让旧版把它当已完成分区成员，
 *      message 复活后再翻回 running = 状态反复横跳，比恒 running 更漂移）。
 *      [u-arch] 原收起位 → closed 第一分支随收起概念删除退役
 *      （close 收口落账 record 投 running——对外两态下旧 reader 的 closed 分区
 *      语义不再被本仓维护为 close 专属，§3.4 方案 A 裁决）。
 * derivedManifestRecord 唯一消费（[collect 退役] batchManifestRecord 投影随批写侧删除）。
 */
function legacyManifestStatusFields(
  rec: SubagentRecord,
): Pick<ManifestRecord, "status"> {
  // [W2/V3 D5 桥接判据收敛] 旧「closed 终态」读判定 ⟺ isLegacyClosedSettled（唯一权威谓词）。
  const legacySettled = isLegacyClosedSettled(rec);
  return {
    status: legacySettled
      ? (rec.closedReason === "cancelled" ? "cancelled" : "closed")
      : "running",
  };
}

/**
 * [U4c / G1+G2] 状态派生 manifest 投影（rebuildIndexes / 反查 miss 惰性通道 /
 * markSettled 收口点 / markArchived 归档点共用）。
 * 数据源 = SubagentRecord 投影（identity entry/binding + `.state` sidecar 矩阵，
 * D1「.state 权威 + entry 尽力」）——词汇双写同终态写面。
 * [U2 两态桥接] 旧 status 三态派生收口 legacyManifestStatusFields 单点：
 * markSettled 的轮间 idle（无 closedReason）与 markSettledOut 的收口落账 record
 * 如实投影 legacy "running"（session-reader 视角的活跃成员，§3.2.8 下行映射）。
 * [U8 / B-restart] engine/engineHandle 域下行（zcode record 重启可见性兜底——
 * manifest 源投影据此恢复引擎身份与锚）。
 */
export function derivedManifestRecord(rec: SubagentRecord): ManifestRecord {
  return {
    id: rec.id,
    rootSessionId: rec.rootSessionId ?? "",
    parentRecordId: rec.parentRecordId,
    agentName: rec.agent,
    ...legacyManifestStatusFields(rec),
    executionStatus: rec.status,
    closedReason: rec.closedReason,
    createdAt: rec.startedAt,
    completedAt: rec.endedAt,
    sessionFile: rec.sessionFile,
    task: rec.task,
    slug: rec.slug,
    model: rec.model,
    engine: rec.engine,
    engineHandle: rec.engineHandle,
  };
}

/** FR-8: ManifestRecord → SubagentRecord（manifest 源投影）。
 *  task/slug 从 manifest 真实值投影（配合 writeManifest 补字段），缺失兜底空串；
 *  model 经空串归一缺席（R4/D6-③——undefined = 用户未指定，禁空串哨兵）。
 *  status 越界（mapManifestStatus 返回 null）时返回 null，由 collectRecords 跳过。
 *  [M2 Gate B] closedReason 投影（枚举守卫，同 mapManifestStatus 的越界容错口径）：
 *  旧 manifest 无此字段 / 损坏值 → undefined。缺失曾让 manifest 源快照在
 *  endedMessageGuard 丢失三分流依据（user-close/cancelled 误入 reconnectable 分支）。
 *  [U8 / §3.2.8 双写回读] executionStatus（两态权威词）在场且合法时优先——旧三态
 *  status 只是 session-reader 下行投影，settle 产物（legacy running + idle）按
 *  权威词读回 idle；旧 manifest（无 executionStatus）回落 mapManifestStatus。
 *  [U8] engine 域回读（manifest 持久化锚的读侧半边）：zcode manifest 孤儿恢复引擎身份（engineHandle 经 isEngineHandleShape
 *  守卫，未知 JSON 不裸收）。 */
export function manifestToSubagent(m: ManifestRecord): SubagentRecord | null {
  const status = manifestStatusToExecution(m);
  if (status === null) return null;
  return {
    id: m.id,
    agent: m.agentName,
    task: m.task ?? "",
    slug: m.slug ?? "",
    status,
    closedReason: isValidClosedReason(m.closedReason) ? m.closedReason : undefined,
    mode: "background" as const,
    startedAt: m.createdAt,
    rootSessionId: m.rootSessionId || undefined,
    parentRecordId: undefined,
    depth: 0,
    endedAt: m.completedAt,
    turns: 0,
    totalTokens: 0,
    // [R4/D6-③] 空串归一缺席（manifest 旧数据的 "" 兜底产物不再复活）。
    model: modelOrUndefined(m.model),
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    result: undefined,
    error: undefined, // closed 统一终态，不再按 status 区分 error 字段
    sessionFile: m.sessionFile,
    engine: m.engine,
    engineHandle: isEngineHandleShape(m.engineHandle) ? m.engineHandle : undefined,
  };
}

// ============================================================
// 内存源投影与孤儿 merge
// ============================================================

/** ExecutionRecord → SubagentRecord（内存源投影）。 */
export function recordToSubagent(r: ExecutionRecord): SubagentRecord {
  return {
    id: r.id,
    agent: r.agent,
    status: r.status,
    closedReason: r.closedReason,
    // [U2 additive] 展示维度随投影持久化（register/archive/reportRecordTransition
    // 全部写点均经本投影 → toSubagentRecordEntry）；undefined 自然缺省，旧 entry 零迁移。
    stopReason: r.stopReason,
    mode: r.mode,
    slug: r.slug,
    startedAt: r.startedAt,
    rootSessionId: r.rootSessionId,
    parentRecordId: r.parentRecordId,
    depth: r.depth,
    endedAt: r.endedAt,
    turns: r.turnCount,
    totalTokens: r.totalTokens,
    model: r.model,
    thinkingLevel: r.thinkingLevel,
    task: r.task,
    currentActivity: getCurrentActivity(r),
    eventLog: getEventLog(r),
    displayItems: getDisplayItems(r),
    result: r.result,
    error: r.error,
    sessionFile: r.sessionFile,
    round: r.round,
    // [modeless 波1] chatMode 投影随字段消亡删除（renderer isDone 判据改走
    // idle+result 形态，GUI 链波 4 处理）：
    // 完成态 one-shot 永远显示 waiting。单测 schema 断言曾因内存对象保留 undefined
    // 键名而未拦截（真实 JSONL 丢 undefined 值），故 schema 测试改为序列化后断言。
    // [review round2] worktree 隔离标志：内存源有 handle 或跨重启重建带 hadWorktree 均为 true。
    worktree: r.worktreeHandle !== undefined || r.hadWorktree === true,
    engine: r.engine,
    // U2：engineHandle 经 entry 持久化（register/archive 双写点均经本投影），无则 undefined 自然省略
    engineHandle: r.engineHandle,
    // [U5 修复 U2 披露的投影缺口] batchFinalized 随本投影持久化（register entry /
    // archive entry 双写点均经本投影）。[modeless 波3] collectMode 投影随字段消亡删除。
    // undefined 经 JSON.stringify 自然缺省，旧 entry 零迁移。
    batchFinalized: r.batchFinalized,
    // [H2 W1] 来源身份两字段随本投影持久化（register/archive/reportRecordTransition
    // 全部写点均经本投影 → toSubagentRecordEntry）。漏投影则 entry 无 origin，重启后
    // 重建链拿不到来源、D1 投影过滤全失效（同型先例：H1 U5 缺字段事故）。
    // [W0 / D1] stepIndex 同族随投影持久化——漏投影则 entry 恒无 stepIndex（run 视图
    // 关联键静默缺失）。undefined 经 JSON.stringify 自然缺省，存量 record 序列化字节
    // 不变（零迁移）。
    origin: r.origin,
    parentRunId: r.parentRunId,
    stepIndex: r.stepIndex,
  };
}

// ============================================================
// revive 统计基线水合（读侧半边——binding 快照 → 内存 record 基线）
// ============================================================

/**
 * [U7 / §3.2.7] revive 统计基线水合：binding 快照（settle 写点权威终值）→ 内存
 * record 基线。max 合并防御调用方传入已带统计的形态（水合只增不减——防归零
 * 覆盖的语义本体）；lastAbandonedRound / transcriptRef 仅缺省回填（非空不覆盖，
 * 调用方冷查水合值优先）。
 */
export function hydrateReviveBaseline(record: ExecutionRecord, zcodeAnchor: ZcodeTranscriptRef | undefined): void {
  const binding =
    record.sessionFile !== undefined
      ? readRecordBinding(record.sessionFile)
      : zcodeAnchor !== undefined
        ? readRecordBinding(zcodeAnchorBasePath(zcodeAnchor))
        : undefined;
  if (binding === undefined) return;
  if (binding.turns !== undefined) record.turnCount = Math.max(record.turnCount, binding.turns);
  if (binding.totalTokens !== undefined) record.totalTokens = Math.max(record.totalTokens, binding.totalTokens);
  if (binding.round !== undefined) record.round = Math.max(record.round ?? 0, binding.round);
  if (binding.epoch !== undefined) record.epoch = Math.max(record.epoch ?? 0, binding.epoch);
  if (record.lastAbandonedRound == null && binding.lastAbandonedRound != null) {
    record.lastAbandonedRound = binding.lastAbandonedRound;
  }
  if (record.transcriptRef === undefined && binding.transcriptRef !== undefined) {
    record.transcriptRef = binding.transcriptRef;
  }
}
