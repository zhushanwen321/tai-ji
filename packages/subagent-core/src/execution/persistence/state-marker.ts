// src/execution/persistence/state-marker.ts
//
// record 绑定 sidecar（`.record-binding`）单一入口 + 收条词汇类型。
//
// [身份换源第二步] 读侧现状：身份域与统计域的读源 = 事件流折叠（record-store.scanFile
// 的 identityFromFoldByFile / receiptStatisticsFromFold / hydrateReviveBaseline）——
// 本文件的 readRecordBinding 只剩写面 merge-or-create 消费（record-store-terminal 的
// persistSettleSnapshot / updateRecordBinding）；binding 写点（spawn 回填 / settle 快照
// / reopen）仍在，写点退场是后续批次。`.state`/`.finalized`/`.cancelled` 收条 sidecar
// 全族已退场（③）——收条由 `record-settled` / `record-round-idle` 事件帧承载，
// StateMarker 只剩内存收条词汇（折叠投影 stateMarkerFromFold 的产物形态）。
//
// GC：session-file-gc 的 sidecar 名单已含本扩展名（孤儿绑定随 TTL 清理；jsonl
// 删除链同步同删——I-16 已销账，GC 领地批次落地）。


import * as fs from "node:fs";

import { getLogger } from "../../core/logger.ts";

import type { AbandonedRoundMark, Epoch, RecordOrigin, TranscriptRef } from "../domain/record-types.ts";

const logger = getLogger("subagents");

/** record 绑定 sidecar 扩展名（UF-1：宿主侧 id→file 映射载体；GC 清理名单与此同源语义）。 */
export const RECORD_BINDING_SIDECAR_EXT = ".record-binding";

// ============================================================
// 类型
// ============================================================

/**
 * 收条 status 值域：现役 idle（轮终/settle 收口——「上一轮收条」而非死亡证明）+
 * 旧终态二态 finalized/cancelled（③ 起写侧不再产出；buildRecord 旧值上行映射分支
 * 的词表位保留——随 U5 读侧兼容收口一并退役）。
 */
export type TerminalState = "idle" | "finalized" | "cancelled";

/**
 * 内存收条词汇（折叠投影 {@link ../record-store-rebuild.stateMarkerFromFold} 的产物
 * 形态——`.state` sidecar 已退场，收条由 `record-settled` / `record-round-idle`
 * 事件帧承载，本类型不再是磁盘格式；现役产物只含 status:"idle" 形态）。
 */
export interface StateMarker {
  status: TerminalState;
  /** 收口 stopReason（值域 StopReason，重建单规则消费）。 */
  reason?: string;
  /** 收条时间（settled.endedAt / 轮终收条事件 ts）。 */
  endedAt?: number;
}


// ============================================================
// record 绑定 sidecar（UF-1：宿主侧 id→file 映射的写读）
// ============================================================

/**
 * 绑定 sidecar 载荷（v1）。字段集 = record-store 磁盘重建 light record 所需的
 * 全部身份域（IdentityHeaderRecon 投影源）+ 对话形态域（round）。
 * undefined 字段经 JSON.stringify 自然缺省（读侧守卫归一）。
 * [modeless 波1] chatMode 字段停写删除（legacy binding 残留键读侧自然忽略——
 * 万物可续语义与旧「缺省归 chat」天然一致，零迁移）。
 */
export interface RecordBinding {
  /** schema 版本。消费方按 v 判别解析，不认识的版本跳过而非猜测。 */
  v: 1;
  recordId: string;
  /** 根 Pi session id（session 隔离过滤与归属校验用；initSession 前的异常窗口 undefined）。 */
  rootSessionId?: string;
  /** 直接父 record id（跨层归属校验用；顶层 undefined）。 */
  parentRecordId?: string;
  /** 递归深度（顶层 0）。 */
  depth: number;
  agent: string;
  task: string;
  slug: string;
  /** 执行模式（窄字面量跟随 types.ts ExecutionMode 现值；扩展时随 schema v2）。 */
  mode: "background";
  startedAt: number;
  /** 已完成对话轮数（绑定写时点快照；回填点早于轮终 +1，恢复值可滞后一拍）。 */
  round?: number;
  /**
   * 模型留痕（R4/D6-① 可选化）：undefined = 用户未指定模型（引擎自身缺省解析）。
   * 读侧守卫（normalizeOptionalBindingFields）对存量 binding 的空串残留归一 undefined
   * ——禁空串哨兵纪律覆盖持久化读写两侧。
   */
  model: string | undefined;
  thinkingLevel?: string;
  /** 创建时启用 worktree 隔离（重建面 hadWorktree 恢复源）。 */
  worktree: boolean;
  /**
   * 来源身份（H2 S3 修复：引擎子文件身份面 origin 透传）。undefined（存量 binding）
   * = "tool" 语义，消费方零迁移——engine-CLI 化后子 session 文件无 identity entry，
   * 本 sidecar 是磁盘重建面 origin 过滤（subagents list / TUI overlay）的唯一承载，
   * 漏本字段则收口/重启后 workflow record 逃过投影过滤（Gate B S3 FAIL 根因）。
   */
  origin?: RecordOrigin;
  /**
   * origin="workflow" 时所属 workflow run id；tool 来源恒缺省。W2/W3 run 视图按
   * collectRecordsByParentRunId 从本字段回查本 run 的 record 集。
   */
  parentRunId?: string;
  /**
   * [W0 / D1] origin="workflow" 时在 run 内的步骤索引（与 origin/parentRunId 同族
   * 身份域）。undefined（存量 binding / tool 来源）= 不投影（读侧守卫归一）；
   * identityFromBinding 重建路径据此恢复，漏本字段则重启后 record 无 stepIndex
   * （run 视图关联键静默缺失——同族字段漏投影事故先例 H2 S3）。
   */
  stepIndex?: number;
  /**
   * 终态 usage 快照（[H2 A3]，终态写点 Step3a 随 .state 同步更新 binding）：
   * totalTokens/turns/endedAt 三字段的 record 终值。light 列表面据此恢复 usage
   * （子文件无 identity entry，全量重建面不可用；round 补投影同款先例）。
   * undefined（存量 binding / 非终态写点）= 不投影（读侧守卫归一）。
   */
  totalTokens?: number;
  /** 终态 turn 计数快照（见 totalTokens 注）。 */
  turns?: number;
  /** 终态结束时间快照 ms（精确值，优于 light 路径的 jsonl mtime 近似）。 */
  endedAt?: number;
  /**
   * [永久会话模型 §3.2.3 / u-foundation 类型面] 世代计数（reopen 防撞）：常态
   * undefined（与 0 同义），reopen 时 +1。**随 binding 持久化是硬要求**——防撞
   * 依赖跨重启单调，丢 epoch 会被二次 reopen 击穿（notifyId `id:epoch:round`
   * 防撞维度）。undefined（存量 binding）= epoch 0。
   */
  epoch?: Epoch;
  /**
   * [§3.2.6 / u-foundation 类型面] 对话记录指针（引擎中立判别联合，pi=sessionFile /
   * zcode=sessionId+dbPath）——binding 是锚的持久化承载面之一（内存 record 同名
   * 字段 + 主 session entry engineHandle.sessionRef 为另两面）。undefined（存量
   * binding / spawn 窗口期）= 锚未回填，读侧不参与重建（U6 续聊链接线消费）。
   */
  transcriptRef?: TranscriptRef;
  /**
   * [§3.2.7 / u-foundation 类型面] 放弃轮标记（通知 gate ②判据，单槽，随 binding
   * 持久化）：abort 时置在飞轮 {epoch, round}；reopen（epoch+1）后残留自然失效。
   * null 与 undefined 同义（无标记）。
   */
  lastAbandonedRound?: AbandonedRoundMark | null;
}

/**
 * [U7 / U6-D2 交接] zcode 锚的 sidecar 键基底：`<dbPath>.<sessionId>`。
 *
 * binding/`.alive` 载体族的键 = 「锚基底 + 扩展名」（pi 形态锚基底 = 子 session 文件
 * 路径，天然唯一）；zcode 无文件锚（binding sidecar 键 = pi 文件锚的结构性理由，U6-D2），
 * 等价基底从 transcriptRef 派生——dbPath 是会话库单例路径（zcodeSessionDbPath 单一
 * 来源）、sessionId 是库内会话键，二元组唯一且稳定。sidecar 落 dbPath 同目录
 * （session-db/，与库条目同生命周期域；引擎 TTL sweep 只清库内条目，孤儿 sidecar
 * 残留与 pi 侧孤儿 binding 同族，GC 名单扩展归 GC 领地批次）。
 */
export function zcodeAnchorBasePath(ref: { sessionId: string; dbPath: string }): string {
  return `${ref.dbPath}.${ref.sessionId}`;
}

/**
 * 写 record 绑定 sidecar（原子写：独占创建 tmp → rename 覆盖目标）。
 *
 * 大多数调用点（spawn 回填点 / settle 快照）是 best-effort 记账面：I/O 失败只 warn
 * 不抛——绑定缺失只影响跨重启恢复能力，不得影响当前进程的派发推进。失败经返回值
 * 上报调用方自行分派处置（markReopened 是硬要求例外——epoch 随 binding 持久化，
 * 写失败必须拒绝重开，见 record-store-terminal.markReopenedImpl）。
 *
 * @param sessionFile 锚基底路径：pi = 子 session.jsonl 绝对路径（绑定目标 =
 *        `<sessionFile>.record-binding`）；zcode = {@link zcodeAnchorBasePath} 派生基底
 *        （U7 settle 快照收编——扩展名拼接同构，读写两侧共用本函数）。
 * @returns true = 已落盘；false = 写失败（错误已 warn 留痕，处置归调用方）。
 */
export function writeRecordBinding(sessionFile: string, binding: RecordBinding): boolean {
  const target = `${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`;
  // tmp 名带 pid：多进程共享 sessionsDir 时互不覆盖；wx 独占创建防同进程残留碰撞。
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(binding), { encoding: "utf-8", flag: "wx" });
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_e) {
      void _e; // tmp 清理失败不追加处理（同为目标目录 IO 故障域）
    }
    logger.warn("[subagents] record binding write failed (best-effort bookkeeping; failure reported to caller)", {
      detail: {
        sessionFile,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return false;
  }
}

/**
 * [u-foundation] binding 载荷的 transcriptRef 运行时守卫（未知 JSON 不裸收；
 * engine 判别 + 引擎专有字段 string 校验，与 record-store isEngineHandleShape
 * 同款形态）。
 */
function isTranscriptRefShape(v: unknown): v is TranscriptRef {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (r.engine === "pi") return typeof r.sessionFile === "string";
  if (r.engine === "zcode") return typeof r.sessionId === "string" && typeof r.dbPath === "string";
  return false;
}

/**
 * [u-foundation] binding 载荷的 lastAbandonedRound 运行时守卫（单槽标记：
 * {epoch: number, round: number}；null 视为合法「无标记」形态——与 undefined
 * 同义，见 RecordBinding.lastAbandonedRound 注释）。
 */
function isAbandonedRoundMarkShape(v: unknown): v is AbandonedRoundMark {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r.epoch === "number" && typeof r.round === "number";
}

/**
 * 读 record 绑定 sidecar。
 *
 * 返回 undefined：文件缺失 / JSON 损坏 / 版本不识别 / 关键身份域缺失或类型非法
 * （recordId/agent/task/mode/startedAt 是重建 light record 的最低要求，残缺载荷
 * 拒绝重建——与 rebuildEntryRecord 的损坏 entry 跳过语义同向，不把损坏残留误判成
 * 可恢复身份）。可选域（rootSessionId/parentRecordId/round/thinkingLevel）类型非法
 * 时归一 undefined，不影响整体判读。
 *
 * @param sessionFile 锚基底路径（pi = 子 session.jsonl；zcode = zcodeAnchorBasePath
 *        派生基底，见 writeRecordBinding 注释——读写同构）。
 */
export function readRecordBinding(sessionFile: string): RecordBinding | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(`${sessionFile}${RECORD_BINDING_SIDECAR_EXT}`, "utf-8");
  } catch {
    return undefined; // sidecar 不存在（正常——未回填 sessionFile 的 record 无绑定）
  }
  let parsed: Partial<RecordBinding>;
  try {
    parsed = JSON.parse(raw) as Partial<RecordBinding>;
  } catch {
    return undefined;
  }
  const identity = projectValidatedIdentityFields(parsed);
  if (identity === undefined) {
    return undefined;
  }
  const optional = normalizeOptionalBindingFields(parsed);
  return {
    v: 1,
    ...identity,
    rootSessionId: optional.rootSessionId,
    parentRecordId: optional.parentRecordId,
    depth: optional.depth,
    slug: optional.slug,
    round: optional.round,
    model: optional.model,
    thinkingLevel: optional.thinkingLevel,
    worktree: parsed.worktree === true,
    origin: optional.origin,
    parentRunId: optional.parentRunId,
    stepIndex: optional.stepIndex,
    totalTokens: optional.totalTokens,
    turns: optional.turns,
    endedAt: optional.endedAt,
    epoch: optional.epoch,
    transcriptRef: optional.transcriptRef,
    lastAbandonedRound: optional.lastAbandonedRound,
  };
}

/**
 * 身份必填域守卫 + 投影（recordId/agent/task/mode/startedAt 是重建 light record
 * 的最低要求，残缺载荷拒绝重建）。守卫表达式自 readRecordBinding 原样搬移：短路
 * 求值顺序与判读结果逐字节等价（C-data-20 解析权威）；校验通过后在本函数内完成
 * 必填域收窄投影（抽成纯布尔守卫会丢失调用方的 TS 属性收窄）。
 */
function projectValidatedIdentityFields(
  parsed: Partial<RecordBinding>,
): Pick<RecordBinding, "recordId" | "agent" | "task" | "mode" | "startedAt"> | undefined {
  if (
    parsed.v !== 1 ||
    typeof parsed.recordId !== "string" ||
    parsed.recordId === "" ||
    typeof parsed.agent !== "string" ||
    typeof parsed.task !== "string" ||
    (parsed.mode !== "background") ||
    typeof parsed.startedAt !== "number"
  ) {
    return undefined;
  }
  return {
    recordId: parsed.recordId,
    agent: parsed.agent,
    task: parsed.task,
    mode: parsed.mode,
    startedAt: parsed.startedAt,
  };
}

/**
 * 可选域类型守卫归一（非法/缺省 → 各自缺省值，不影响整体判读）。守卫表达式自
 * readRecordBinding 原样搬移，逐字段等价。[metrics-gate cyclo 偿还] 逐字段三元守卫
 * （原单函数 cyclomatic 18）归一为下方同类守卫 helper（表驱动降）——每字段仍是一元
 * 表达式，判读结果与求值顺序逐字节等价（行为保持：纯提取，无判据变化）。
 */
function normalizeOptionalBindingFields(
  parsed: Partial<RecordBinding>,
): Pick<
  RecordBinding,
  | "rootSessionId"
  | "parentRecordId"
  | "depth"
  | "slug"
  | "round"
  | "model"
  | "thinkingLevel"
  | "origin"
  | "parentRunId"
  | "stepIndex"
  | "totalTokens"
  | "turns"
  | "endedAt"
  | "epoch"
  | "transcriptRef"
  | "lastAbandonedRound"
> {
  return {
    rootSessionId: strOrUndefined(parsed.rootSessionId),
    parentRecordId: strOrUndefined(parsed.parentRecordId),
    depth: numOr(parsed.depth, 0),
    slug: strOr(parsed.slug, ""),
    round: numOrUndefined(parsed.round),
    // [R4/D6-③] model 空串归一缺席：undefined/缺省/""（存量 binding 空串残留）→
    // undefined = 用户未指定——空串若复活进 record，「压掉 defaultModelSelection」
    // 经 taskSpec 空串带键路径静默回归（禁空串哨兵，持久化读写两侧纪律）。
    model: modelOrUndefined(parsed.model),
    thinkingLevel: strOrUndefined(parsed.thinkingLevel),
    // 来源身份两字段（H2 S3）：字面量守卫归一（非法/缺省 → undefined = "tool" 语义），
    // 对齐 record-store.readEntryOriginFields 主 entry 重建侧的同名守卫。
    origin: originOrUndefined(parsed.origin),
    parentRunId: strOrUndefined(parsed.parentRunId),
    // [W0 / D1] 步骤索引：number 守卫（非法/缺省 → undefined = 不投影，存量 binding
    // 零迁移）；normalize 白名单含本键是 updateRecordBinding read-modify-write
    // round-trip 不丢字段的结构性保证（读出保留 → spread 合并 → 重写带回）。
    stepIndex: numOrUndefined(parsed.stepIndex),
    // 终态 usage 快照三字段（H2 A3）：number 守卫（非法/缺省 → undefined = 不投影）。
    totalTokens: numOrUndefined(parsed.totalTokens),
    turns: numOrUndefined(parsed.turns),
    endedAt: numOrUndefined(parsed.endedAt),
    // [u-foundation] 永久会话模型三字段：number / shape 守卫（非法/缺省 → undefined
    // = 不投影，存量 binding 零迁移；lastAbandonedRound 的 null 是合法「无标记」）。
    epoch: numOrUndefined(parsed.epoch),
    transcriptRef: transcriptRefOrUndefined(parsed.transcriptRef),
    lastAbandonedRound: abandonedRoundOrUndefined(parsed.lastAbandonedRound),
  };
}

// ── 同类守卫归一 helper 族（[metrics-gate cyclo 偿还] 表驱动降）─────────────────
// 行为保持依据：每 helper 即原 normalizeOptionalBindingFields 对应字段的一元三元
// 守卫原样提取（判据 / 缺省值 / 求值结果逐字节等价）；参数静态类型沿用 RecordBinding
// 字段声明（载荷实为 JSON.parse 产物，运行时任意——typeof/shape 守卫照常拦截）。

/** string 守卫（非法/缺省 → undefined）。 */
function strOrUndefined(v: string | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * model 空串归一缺席（R4/D6-③，禁空串哨兵）：string 守卫 + trim 判空——undefined/
 * 缺省/"" 一律归 undefined（= 用户未指定模型）。slug 仍走 strOr（"" 是其合法缺省域），
 * model 的缺省域自 R4 起收敛为 undefined。
 */
function modelOrUndefined(v: string | undefined): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** number 守卫（非法/缺省 → undefined）。 */
function numOrUndefined(v: number | undefined): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** number 守卫 + 显式缺省值（depth 0 / slug "" 等非 undefined 缺省域）。 */
function numOr(v: number | undefined, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}

/** string 守卫 + 显式缺省值（slug "" 等非 undefined 缺省域；model 已改归一缺席，R4/D6-③）。 */
function strOr(v: string | undefined, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/** 来源身份字面量守卫（非法/缺省 → undefined = "tool" 语义，H2 S3）。 */
function originOrUndefined(v: RecordOrigin | undefined): RecordOrigin | undefined {
  return v === "workflow" || v === "tool" ? v : undefined;
}

/** transcriptRef shape 守卫（非法/缺省 → undefined = 不投影，u-foundation）。 */
function transcriptRefOrUndefined(v: TranscriptRef | undefined): TranscriptRef | undefined {
  return isTranscriptRefShape(v) ? v : undefined;
}

/** 放弃轮标记守卫（null 是合法「无标记」；非法/缺省 → undefined，§3.2.7 单槽）。 */
function abandonedRoundOrUndefined(
  v: AbandonedRoundMark | null | undefined,
): AbandonedRoundMark | null | undefined {
  if (v === null) return null;
  return isAbandonedRoundMarkShape(v) ? v : undefined;
}

/**
 * merge 更新 record 绑定 sidecar（[H2 A3] 终态写点专用）：读现有 binding → 合并
 * patch → 原子重写。现有 binding 缺失/损坏时**跳过不造新**（updateRecordBinding 不
 * 承担身份创建职责——binding 缺失 = 回填点也未跑过的异常窗口，用部分字段造 binding
 * 会产出残缺身份；writeRecordBinding 才是创建入口）。best-effort 语义同写侧。
 */
export function updateRecordBinding(sessionFile: string, patch: Partial<RecordBinding>): void {
  const existing = readRecordBinding(sessionFile);
  if (existing === undefined) return;
  writeRecordBinding(sessionFile, { ...existing, ...patch });
}
