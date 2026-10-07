// src/execution/persistence/run-state-evidence.ts
//
// run 状态的终局证据判定核 + 磁盘保留期维护（workflow-run-store-convergence
// 设计 U3+U4：自 orchestration/file-run-store.ts 拆解迁移，行为零变化）。
//
// 为什么在这里：终局证据查询与保留期清理是持久化域的读侧与维护职责，与
// record-store.ts / record-events.ts 同域；store 写身份退役后本模块不再持有
// store 之名——journal（<runId>.record.jsonl）与 manifest（<runId>.json）是
// 判定与清理的事实源，state 快照文件只作为磁盘足迹的一部分被成对清理、
// 不参与判定。
//
// 依赖方向：record 事件文件族的枚举与 fold 资格判定消费同域 record-events；
// run 事件词表与 fold 经 orchestration/run-events 单源消费（本文件只做候选
// 枚举与成对裁剪，不定义后缀词表；fold 终态 = W1 D5 清理资格判据）；
// reason 派生单点在 orchestration/terminal-actions
// （runSettledOutcomeToDoneReason——sweep 判据的 reason 派生单点，
// 帧/manifest (outcome, errorCode) → DoneReason 五处统一派生）。

import { readFileSync, statSync, unlinkSync } from "node:fs";

import { writeAtomicFileSync } from "../../shared/atomic-write.ts";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { getLogger } from "../../core/logger.ts";
import type {
  RecordEvent,
} from "./record-events.ts";
import {
  createRecordEventStream,
  foldRecordEvents,
  RECORD_EVENTS_SUFFIX,
} from "./record-events.ts";
import { RUN_EVENTS_SUFFIX, type RunErrorCode, type RunOutcome } from "../../shared/run-vocabulary.ts";
import { createRunEventJournal } from "./run-event-journal.ts";
import type { WorkflowRunEvent } from "../../orchestration/run-events.ts";
import { runSettledOutcomeToDoneReason } from "../../shared/run-vocabulary.ts";

const logger = getLogger("run-state-evidence");

/** Node fs 错误 code 判定（ENOENT = 路径不存在，并发删除场景；对齐 pi isEnoentError）。 */
function isEnoentError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err &&
    (err as { code?: unknown }).code === "ENOENT";
}

// ── 磁盘保留原语（C1 → W1 D5 重写：fold 终态 + 保留窗口）──────────
//
// retention 语义单源（候选枚举 / fold 终态资格 / 保留窗口 / 任何失败不抛），日志与
// 错误字符串化经 deps 注入（宿主各自的 logger tag / error 工具保持自治，行为差异
// 仅 log tag 文案）。

/** pruneTerminalRunFiles / runRetentionMaintenanceRound 的宿主注入依赖（日志与错误字符串化——tag 前缀由注入方决定）。 */
export interface PruneStateDeps { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /** warn 通道（readdir / unlink 失败留证；清理是旁路维护，失败不抛） */
  warn: (msg: string) => void;
  /** debug 通道（成功裁剪与候选枚举记录） */
  debug: (msg: string) => void;
  /** error → 可读字符串（core 侧 err.message 兜底 String，宿主可用自有 error 工具） */
  toMsg: (err: unknown) => string;
}

// ── 统一保留通道（W1 D5：fold 终态 + 保留窗口，废除 cap）──────────
//
// W1 D5 清理规则落地（替代 [Q2] 的 manifest 资格 + cap + mtime TTL 三限）：
// ① 资格判据 = fold 投影为终态（journal 内 run-settled 帧驱动 fold 到 terminal，
//    含收编产生的 interrupted——收编入口幂等追加终态事件后即获资格）∧ 终态时间
//    超窗（终态时间 = journal 内终态事件时间戳；防御兜底 = 末条事件时间戳）。
//    manifest 不再参与资格判定（读序 3 降级为「journal 被裁后的终局投影」与
//    abandon 终局化载体），结构性不在候选——永不随裁（孤儿判定依赖）；
// ② 判据②（无终态事件 ∧ 注册超窗 ∧ mtime 超阈值）默认不启用：阈值未实测校准前
//    只走判据①。其镜像代价（崩溃后永不重开的会话 journal 滞留）经维护轮候选数
//    日志监控——持续增长 = 启用判据②校准的反向触发信号（设计 D5 显式声明）；
// ③ 清理对象按 run 粒度成对删 state 文件 + journal（<runId>.record.jsonl，存在才
//    删）；record 域同判据清 <sa-id>.events 事件文件（manifest 不触碰，其独立
//    30 天 TTL 归 session-file-gc，孤儿判定窗口不漂移）；
// ④ 任何失败不抛（辅助清理降级不拖垮主链）：readdir 失败静默放弃本轮该域，单
//    run 判定失败按「不可判定 → 跳过」降级（宁保留不误裁——误裁活跃 run 是不可
//    恢复事故方向），单文件 unlink 失败 warn 留证后继续。
//
// 保留窗口常量与 env 通道沿用 [P1b-2] 引入、[Q2] 单源化的 TAIJI_SUBAGENT_STATE_TTL_MS
// （两宿主共用同一缺省保留期与测试期调低通道；W1 起为 run+record 两域统一窗口）。

/** 保留窗口缺省值 = 2_592_000_000ms（30 天；W1 D5：run+record 两域统一保留窗口，窗口内全保留）。 */
const DEFAULT_STATE_TTL_MS = 2_592_000_000;

/**
 * 保留窗口 env 通道（测试期调低用）：
 * - 未设/空 → 缺省 {@link DEFAULT_STATE_TTL_MS}（默认开）；
 * - 有限正数 → 窗口 = env 值（测试期调低通道）；
 * - 非法值（非有限数/≤0）→ undefined = 不按窗裁（显式 opt-out，「意图不明不动
 *   磁盘」哲学；窗口是唯一资格判据，opt-out 即整轮不裁，仅保留候选数监控）。
 */
export const STATE_TTL_MS_ENV = "TAIJI_SUBAGENT_STATE_TTL_MS";

/** 解析保留窗口；env 未设/空 → 缺省，显式非法/≤0 → undefined（不按窗裁）。 */
function resolveStateTtlMs(): number | undefined {
  const raw = process.env[STATE_TTL_MS_ENV];
  if (raw === undefined || raw === "") return DEFAULT_STATE_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/** pruneTerminalRunFiles 的可调项。 */
export interface PruneTerminalRunFilesOptions { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /** 保留窗口（ms）；undefined = 不按窗裁（opt-out）。缺省经 {@link resolveStateTtlMs}。 */
  ttlMs?: number;
}

/** pruneTerminalRunFiles 的执行结果（宿主日志/健康面用）。 */
export interface PruneTerminalRunFilesResult { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /** 扫描到的 state 文件数（glob 命中、排除 journal）。 */
  scanned: number;
  /** fold 投影为终态的 run 数（无论是否超窗——资格计数）。 */
  eligible: number;
  /** 本次裁剪的 run 数（state 文件计数；journal 同删不计入）。 */
  pruned: number;
  /**
   * 判据②反向锚点候选数：无终态 ∧ 注册超窗的 run 数（D5——持续为 0 = 判据②
   * 关闭期无代价，持续增长 = 启用判据②校准的反向触发信号）。
   */
  nonTerminalBeyondWindow: number;
}

/** 单 run 保留判定（fold 投影 + 时间锚提取；判据①资格与判据②候选的公共输入）。 */
interface RunRetentionAssessment { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  runId: string;
  /** fold 投影是否终态（含收编产生的 interrupted——终态事件在 journal 内）。 */
  terminal: boolean;
  /** 终态时间（run-settled 帧 ts；防御兜底 = 末条事件 ts）。非终态 = undefined。 */
  terminalAt: number | undefined;
  /**
   * 注册时间（run-created 帧 ts；journal 缺创建帧的存量形态兜底 = state 文件
   * mtime——判据②候选计数的锚）。
   */
  registeredAt: number;
}

/**
 * 单 run 保留判定（D5 判据①的 fold 单源锚定）：scan journal → fold 终态 →
 * 提取终态/注册时间锚。
 *
 * journal 读失败 / fold 停在非终态 = 不获清理资格（宁保留不误裁：误裁活跃 run 是
 * 不可恢复事故方向；崩溃/损坏 journal 的滞留代价由候选数日志监控，见 D5 判据②）。
 * 判定失败返回 undefined（不可判定 → 跳过该 run，不阻断本轮）。
 */
async function assessRunRetention(
  stateDir: string,
  runId: string,
  stateFull: string,
  deps: PruneStateDeps,
): Promise<RunRetentionAssessment | undefined> {
  let events: readonly WorkflowRunEvent[];
  try {
    events = await createRunEventJournal(stateDir).scan(runId);
  } catch (err) {
    // journal 读失败（EACCES/EIO 等，非 ENOENT——ENOENT 是合法空流）= 不可判定
    deps.debug(`state retention: journal scan failed, skipped ${runId}: ${deps.toMsg(err)}`);
    return undefined;
  }
  let settledAt: number | undefined;
  let registeredAt: number | undefined;
  let lastEventTs: number | undefined;
  for (const event of events) {
    if (event.type === "run-created") registeredAt ??= event.ts;
    if (event.type === "run-settled") settledAt = event.ts;
    lastEventTs = event.ts;
  }
  // [D1 Class B] 终态判据直接读帧（不再经编排层 fold）：不变量 = terminal ⟺ 存在
  // run-settled 帧（终态必经该帧写入，转移表构造性保证）。本层只做证据判读，不引入
  // 状态机语义——这正是拆边要的方向。
  const terminal = settledAt !== undefined;
  // 终态时间 = journal 内终态事件时间戳（run-settled 帧 ts）；「收编无终态事件者
  // 取末条事件时间戳」——经转移表构造性不可达（terminal 必经 run-settled 帧），
  // 留防御兜底防未来词表演进破坏该不变量
  const terminalAt = settledAt ?? (terminal ? lastEventTs : undefined);
  if (registeredAt === undefined) {
    // journal 缺创建帧（存量形态 / 手工构造）→ state 文件 mtime 兜底注册时间
    try {
      registeredAt = (await stat(stateFull)).mtimeMs;
    } catch (err) {
      deps.debug(`state retention: stat failed, skipped ${stateFull}: ${deps.toMsg(err)}`);
      return undefined;
    }
  }
  return { runId, terminal, terminalAt, registeredAt };
}

/** 单 run 磁盘足迹成对删（state + journal，存在才删）。返回 state 文件是否删除成功。 */
async function deleteRunFootprint(
  stateDir: string,
  runId: string,
  deps: PruneStateDeps,
): Promise<boolean> {
  const stateFull = join(stateDir, `${runId}.jsonl`);
  const journalFull = join(stateDir, `${runId}${RUN_EVENTS_SUFFIX}`);
  let prunedState = false;
  for (const full of [stateFull, journalFull]) {
    try {
      await unlink(full);
      prunedState ||= full === stateFull;
    } catch (err) {
      if (isEnoentError(err)) continue; // 并发删除已达成目标 / journal 本就不存在
      deps.warn(`state retention: failed to delete ${full}: ${deps.toMsg(err)}`);
    }
  }
  return prunedState;
}

/**
 * 把 state 目录内「fold 终态且超窗」的 run 磁盘足迹（state + journal）裁剪掉
 * （W1 D5 生产单源——资格语义见上方「统一保留通道」段落注释）。
 *
 * retention 纪律（候选枚举 / fold 终态资格 / 保留窗口 / 任何失败不抛）+ 成对删
 * （state + journal）+ manifest 永不随裁。窗口解析（env 通道）缺省经
 * {@link resolveStateTtlMs}——窗口是唯一资格判据。
 * 统一维护轮（runRetentionMaintenanceRound）与直接调用方共用同一实装。
 *
 * [D1 后射程（workflow-run-resume-revision 裁决点 7）] pi 壳域 run 的唯一磁盘清理
 * 通道 = 对账清理（reapOrphanRuns：引用判据 + 宽限窗 + 全部件删除）——本函数的
 * 保留窗是无引用判据的盲删除，对本域 run 启用即绕过引用保护（裁决点 7 明文废弃
 * 方向）。判据换源 record 流后本函数的现行形态因此保持**结构性不触新格式 run**：
 * 候选锚定 state 快照族（新格式无快照件——不进候选），journal 后缀 filter 排除
 * record 流。record 流的「终态 + 超窗」删除资格不落本通道，其清理随对账清理的
 * 无主判定走（有主 run 的 record 流保留是设计内行为——resume 依赖全文）。
 */
export async function pruneTerminalRunFiles(
  stateDir: string,
  options: PruneTerminalRunFilesOptions,
  deps: PruneStateDeps,
): Promise<PruneTerminalRunFilesResult> {
  return pruneTerminalRunFootprint(stateDir, options.ttlMs ?? resolveStateTtlMs(), deps);
}

/**
 * run 域保留清理实装（pruneTerminalRunFiles 的单源体，统一维护轮同点消费）：
 * 枚举 state 文件候选 → 逐 run fold 判定 → 终态 ∧ 超窗者成对删（state + journal）。
 * retentionMs undefined（opt-out）= 整轮不裁（窗口是唯一资格判据），仅保留候选计数。
 * 候选锚定与 record 流排除的裁决性理由见 pruneTerminalRunFiles 注释（[D1 后射程]
 * 段）——新格式 run（唯一件 = record 流）结构性不进候选，清理由对账清理通道承接。
 */
async function pruneTerminalRunFootprint(
  stateDir: string,
  retentionMs: number | undefined,
  deps: PruneStateDeps,
): Promise<PruneTerminalRunFilesResult> {
  const result: PruneTerminalRunFilesResult = {
    scanned: 0,
    eligible: 0,
    pruned: 0,
    nonTerminalBeyondWindow: 0,
  };
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch (err) {
    if (!isEnoentError(err)) {
      deps.warn(`state retention: readdir ${stateDir} failed: ${deps.toMsg(err)}`);
    }
    return result;
  }
  // state 文件候选：wf-*.jsonl 且排除 journal（<runId>.record.jsonl）——record 流
  // 不作候选是裁决点 7 引用保护的构成部分（唯一清理通道 = 对账清理），非实现疏漏；
  // 裁决性理由见 pruneTerminalRunFiles 注释 [D1 后射程] 段
  const stateNames = names.filter(
    (n) => n.startsWith("wf-") && n.endsWith(".jsonl") && !n.endsWith(RUN_EVENTS_SUFFIX),
  );
  result.scanned = stateNames.length;

  const now = Date.now();
  // 候选计数锚：判据②监控不随清理 opt-out 失明（默认窗兜底，仅用于日志面）
  const windowForCandidates = retentionMs ?? DEFAULT_STATE_TTL_MS;
  for (const name of stateNames) {
    const runId = name.slice(0, -".jsonl".length);
    const assessment = await assessRunRetention(stateDir, runId, join(stateDir, name), deps);
    if (assessment === undefined) continue;
    if (assessment.terminal) {
      result.eligible += 1;
      if (
        retentionMs !== undefined &&
        assessment.terminalAt !== undefined &&
        now - assessment.terminalAt > retentionMs
      ) {
        if (await deleteRunFootprint(stateDir, runId, deps)) result.pruned += 1;
        deps.debug(`state retention: pruned terminal run files for ${runId} (state + journal)`);
      }
    } else if (now - assessment.registeredAt > windowForCandidates) {
      result.nonTerminalBeyondWindow += 1;
    }
  }
  return result;
}

/** record 域保留清理结果（与 run 域同构的计数面）。 */
export interface PruneTerminalRecordEventFilesResult { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /** 扫描到的 *.events 事件文件数。 */
  scanned: number;
  /** fold 投影为终态（record-settled 在流内且未被回边清除）的 record 数。 */
  eligible: number;
  /** 本次裁剪的事件文件数。 */
  pruned: number;
  /** 判据②反向锚点候选数（无终态 ∧ 注册超窗——与 run 域同义）。 */
  nonTerminalBeyondWindow: number;
}

/**
 * record 域保留清理（W1 D5：record 事件文件与 run journal 同判据——fold 终态 +
 * 窗口）。运行中/非终态永不清（settled 被 reopened/round-started 清除 = 回边续跑，
 * 保护语义与 fold 投影单源）；manifest（<sa-id>.json）不触碰——其独立 30 天 TTL
 * 归 session-file-gc（孤儿判定窗口与现状不漂移，设计 D2/D5）。
 */
async function pruneTerminalRecordEventFiles(
  recordsDir: string,
  retentionMs: number | undefined,
  deps: PruneStateDeps,
): Promise<PruneTerminalRecordEventFilesResult> {
  const result: PruneTerminalRecordEventFilesResult = {
    scanned: 0,
    eligible: 0,
    pruned: 0,
    nonTerminalBeyondWindow: 0,
  };
  let names: string[];
  try {
    names = await readdir(recordsDir);
  } catch (err) {
    if (!isEnoentError(err)) {
      deps.warn(`state retention: readdir ${recordsDir} failed: ${deps.toMsg(err)}`);
    }
    return result;
  }
  const eventNames = names.filter((n) => n.endsWith(RECORD_EVENTS_SUFFIX));
  result.scanned = eventNames.length;

  const journal = createRecordEventStream(recordsDir);
  const now = Date.now();
  const windowForCandidates = retentionMs ?? DEFAULT_STATE_TTL_MS;
  for (const name of eventNames) {
    const id = name.slice(0, -RECORD_EVENTS_SUFFIX.length);
    let events: readonly RecordEvent[];
    try {
      events = await journal.scan(id);
    } catch (err) {
      // 非法文件名（assertValidRecordId）/ 读失败 = 不可判定 → 跳过（宁保留不误裁）
      deps.debug(`state retention: record events scan failed, skipped ${name}: ${deps.toMsg(err)}`);
      continue;
    }
    const fold = foldRecordEvents(events);
    if (fold.settled !== undefined) {
      result.eligible += 1;
      if (retentionMs !== undefined && now - fold.settled.ts > retentionMs) {
        try {
          await unlink(join(recordsDir, name));
          result.pruned += 1;
          deps.debug(`state retention: pruned terminal record events for ${id}`);
        } catch (err) {
          if (!isEnoentError(err)) {
            deps.warn(`state retention: failed to delete ${join(recordsDir, name)}: ${deps.toMsg(err)}`);
          }
        }
      }
    } else if (now - (fold.identity?.ts ?? mtimeMsOf(join(recordsDir, name))) > windowForCandidates) {
      result.nonTerminalBeyondWindow += 1;
    }
  }
  return result;
}

/** stat mtime（失败返回 NaN——与「永不超窗」比较恒 false，保守不计候选）。 */
function mtimeMsOf(full: string): number {
  try {
    return statSync(full).mtimeMs;
  } catch {
    return Number.NaN;
  }
}

// ── 统一保留维护轮（W1 D5 执行者——run + record 两域同轮幂等扫描）──

/** 维护轮输入（两域目录锚点，各自可选——undefined = 本轮跳过该域）。
 *
 * 为什么可选：三触发点各只天然持有一个域的精确目录锚（壳 run 首写持
 * `<sessionDir>/workflow-state`、core record 首写持 recordsDir、session_start 兜底
 * 双域）——强制两域必传会逼出「core 侧反推 pi sessionDir」或「壳侧反推 record
 * enc 段」两类推导漂移面。每域至少有一个持锚触发点，覆盖面由三触发点并集保证
 * （幂等整轮，任一触发点缺一域只影响冗余度不影响覆盖）。 */
export interface RetentionMaintenanceInput { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /** run 域状态目录（workflow-state——state 快照 + journal 成对清理）；undefined = 跳过 run 域。 */
  stateDir?: string;
  /** record 事件文件目录（records——仅清 *.events，manifest 不触碰）；undefined = 跳过 record 域。 */
  recordsDir?: string;
}

/** 维护轮可调项。 */
export interface RetentionMaintenanceOptions { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /** 保留窗口（ms）；undefined = 经 {@link resolveStateTtlMs}（缺省 30 天 + env 调低通道）。 */
  retentionMs?: number;
}

/** 维护轮执行结果（两域计数面）。 */
export interface RetentionMaintenanceResult { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  run: PruneTerminalRunFilesResult;
  record: PruneTerminalRecordEventFilesResult;
}

/** 维护轮缺省日志依赖（core logger facade——宿主未注入 deps 时兜底）。 */
function defaultRetentionDeps(): PruneStateDeps {
  return {
    warn: (msg) => logger.warn(msg),
    debug: (msg) => logger.debug(msg),
    toMsg: (err) => (err instanceof Error ? err.message : String(err)),
  };
}

/**
 * 统一保留维护轮（W1 D5 的执行者，修复「有判据无执行者」缺口）：一个幂等整轮
 * 扫描，run journal prune 与 record 事件文件 prune 同轮完成 + 候选数日志。
 *
 * 三触发点（新 run 首写 / 新 record 事件文件首写 / session_start 兜底）都消费本
 * 入口（接线归 U7）——record-only 会话（只跑 subagents()）经 record 触发与
 * session_start 兜底覆盖，磁盘不无界累积。幂等：重复触发重入无害（已清文件
 * ENOENT 静默，判据以盘上事实为准）。
 *
 * 任何失败不抛（辅助维护降级）：单域整轮失败 warn 留证后另一域照常执行。
 * 候选数日志 = 判据②反向锚点（D5）：「无终态 ∧ 注册超窗」计数持续为 0 = 判据②
 * 关闭期无代价；持续增长 = 启用判据②校准的反向触发信号（磁盘占用实测超配额
 * 同触发）。
 */
export async function runRetentionMaintenanceRound(
  input: RetentionMaintenanceInput,
  options: RetentionMaintenanceOptions = {},
  deps: PruneStateDeps = defaultRetentionDeps(),
): Promise<RetentionMaintenanceResult> {
  const retentionMs = options.retentionMs ?? resolveStateTtlMs();
  let run: PruneTerminalRunFilesResult = {
    scanned: 0,
    eligible: 0,
    pruned: 0,
    nonTerminalBeyondWindow: 0,
  };
  if (input.stateDir !== undefined) {
    try {
      run = await pruneTerminalRunFootprint(input.stateDir, retentionMs, deps);
    } catch (err) {
      deps.warn(`state retention: run-domain maintenance round failed: ${deps.toMsg(err)}`);
    }
  }
  let record: PruneTerminalRecordEventFilesResult = {
    scanned: 0,
    eligible: 0,
    pruned: 0,
    nonTerminalBeyondWindow: 0,
  };
  if (input.recordsDir !== undefined) {
    try {
      record = await pruneTerminalRecordEventFiles(input.recordsDir, retentionMs, deps);
    } catch (err) {
      deps.warn(`state retention: record-domain maintenance round failed: ${deps.toMsg(err)}`);
    }
  }
  deps.debug(
    `state retention: maintenance round done (retentionMs=${retentionMs ?? "opt-out"}): ` +
      `run{scanned=${run.scanned}, terminal=${run.eligible}, pruned=${run.pruned}, candidates=${run.nonTerminalBeyondWindow}}, ` +
      `record{scanned=${record.scanned}, terminal=${record.eligible}, pruned=${record.pruned}, candidates=${record.nonTerminalBeyondWindow}}`,
  );
  const candidates = run.nonTerminalBeyondWindow + record.nonTerminalBeyondWindow;
  if (candidates > 0) {
    deps.warn(
      `state retention: ${candidates} non-terminal journal(s) registered beyond the retention window ` +
        `(run=${run.nonTerminalBeyondWindow}, record=${record.nonTerminalBeyondWindow}) — criterion-② candidates; ` +
        `sustained growth is the signal to calibrate and enable criterion ② (design D5)`,
    );
  }
  return { run, record };
}

// ── run 终局证据判定核（枚举改接与对账 sweep 的共用判定逻辑）──────────

/**
 * run 终局证据三态（判定核 {@link findRunSettlementEvidence} 的返回形状；
 * terminal 携带 reason——经 runSettledOutcomeToDoneReason 联合派生的 DoneReason）。
 */
export type RunSettlementEvidence =
  | { kind: "running" }
  | { kind: "terminal"; reason: string }
  | { kind: "missing" };

/**
 * 按 runId 同步查 run 的终局证据——journal run-settled 帧 ∨ manifest 终局面的
 * 三态判定核。枚举改接（启动扫描，pi-host-run-store.ts）与对账 sweep 判据
 * （sweep-binding）共用同一份判定逻辑（设计 §3.3 决策 2：抽取共用而非各写一份
 * 尾向扫描——两份尾扫 = 新的一对并存实现，正是该设计要消灭的形态）。同步形态：
 * sweep 在 session_start 同步链内运行（runReconcileSweep 同步契约），不能
 * await——对单 runId 做同步文件读（对齐 sweep 自身的 sync fs 读先例；journal
 * 行逐行 JSON.parse + run-settled 尾向扫描，manifest 同步读）。
 *
 * 判定矩阵（[W2 D6] 逐形态锚定保守侧——误注销活跃 run 是事故方向，不可逆）：
 * - journal 与 manifest 均不存在（ENOENT）→ missing（「已归档/不存在视同终态」
 *   ——run 从未落账或已被保留期清理，注册是死亡窗口残留）；
 * - journal 尾向存在 run-settled 帧（append-only 单写者：帧在盘 = 终局已记录，
 *   行级独立 JSON 不受早先坏行影响）→ terminal + reason（帧 (outcome, errorCode)
 *   经 runSettledOutcomeToDoneReason 联合派生——[W2 D5] sweep 补注销 reason 统一
 *   派生源第三处；budget_limited/time_limited 细分保留）；
 * - journal 无帧但 manifest 在盘（record 流缺场 + manifest 残局——现行写入面下
 *   record 流不被保留期裁剪（prune 候选排除，裁决点 7）、对账清理五件全删不留
 *   manifest，该组合只剩外部删除 / 清理部分失败残局两类来源）→ terminal +
 *   reason（manifest outcome 派生；无码细分退化为 outcome 兜底）；
 * - journal 存在但无 run-settled 帧（run 真未终局，含坏链首帧形态）→ running
 *   （保守按活跃，不补注销——对齐 adoptInterruptedRun skippedBrokenChain 纪律）；
 * - journal / manifest 读错误（非 ENOENT IO 故障）→ running + warn 留证
 *   （「IO 故障 ≠ 不存在」的保守侧纪律，宁挂账不误注销）。
 */
/** journal 尾扫四态（[findRunSettlementEvidence 拆分] 的返回契约）。 */
type JournalScan =
  | { kind: "frame"; settled: Extract<WorkflowRunEvent, { type: "run-settled" }> }
  | { kind: "noFrame" } // 读成功、无 run-settled 帧（真未终局）
  | { kind: "fileMissing" } // ENOENT（从未落账/已清理）
  | { kind: "ioError" }; // 非 ENOENT 读错误（保守挂账）

/** [findRunSettlementEvidence 拆分] journal 尾扫：自尾向头找最近一条 run-settled 帧
 * （坏行继续向前——append-only 下帧行独立有效；尾部空行静默跳过）。 */
function scanJournalLastSettledFrame(recordPath: string): JournalScan {
  let settled: Extract<WorkflowRunEvent, { type: "run-settled" }> | undefined;
  try {
    const content = readFileSync(recordPath, "utf8");
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (line === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        typeof parsed === "object" && parsed !== null &&
        (parsed as { type?: unknown }).type === "run-settled"
      ) {
        settled = parsed as Extract<WorkflowRunEvent, { type: "run-settled" }>;
        break;
      }
    }
  } catch (err) {
    if (isEnoentError(err)) return { kind: "fileMissing" };
    return { kind: "ioError" };
  }
  return settled !== undefined ? { kind: "frame", settled } : { kind: "noFrame" };
}

/** [findRunSettlementEvidence 拆分] manifest 终局面（残局防御）。undefined = 无
 * manifest / 无 outcome / ENOENT——交回调用方兜底；非 ENOENT 读错误原样上抛（保守挂账）。 */
function readManifestSettlement(
  manifestPath: string,
): { reason: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    if (isEnoentError(err)) return undefined;
    throw err;
  }
  if (typeof parsed === "object" && parsed !== null) {
    const outcome = (parsed as { outcome?: unknown }).outcome;
    const errorCode = (parsed as { errorCode?: unknown }).errorCode;
    if (typeof outcome === "string") {
      return {
        reason: runSettledOutcomeToDoneReason(
          outcome as RunOutcome,
          typeof errorCode === "string" ? (errorCode as RunErrorCode) : undefined,
        ),
      };
    }
  }
  return undefined;
}

export function findRunSettlementEvidence(stateDir: string, runId: string): RunSettlementEvidence {
  const recordPath = join(stateDir, `${runId}${RUN_EVENTS_SUFFIX}`);
  const journal = scanJournalLastSettledFrame(recordPath);
  if (journal.kind === "ioError") {
    // 非 ENOENT 读错误（EACCES/EIO 等）≠ 文件不存在——保守侧按活跃挂账
    //（宁挂账不误注销），warn 留证防 IO 故障伪装成 missing。
    logger.warn(
      `[run-state-evidence] findRunSettlementEvidence journal read failed, treating as running (stay registered): ${recordPath}`,
    );
    return { kind: "running" };
  }
  if (journal.kind === "frame") {
    return {
      kind: "terminal",
      reason: runSettledOutcomeToDoneReason(journal.settled.outcome, journal.settled.errorCode),
    };
  }
  // journal 无帧：manifest 终局面（残局防御——现行写入面下 record 流不被保留期
  // 裁剪、对账清理五件全删，正常无此组合；见上方判定矩阵该行注释）
  const manifestPath = join(stateDir, `${runId}.json`);
  try {
    const fromManifest = readManifestSettlement(manifestPath);
    if (fromManifest !== undefined) return { kind: "terminal", reason: fromManifest.reason };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[run-state-evidence] findRunSettlementEvidence manifest read failed, treating as running (stay registered): ${manifestPath}: ${msg}`,
    );
    return { kind: "running" };
  }
  // 两证据面均缺：journal 存在但无帧 = 真未终局（保守活跃）；journal 也缺 =
  // missing（从未落账/已清理——视同终态补注销）。
  if (journal.kind === "fileMissing") return { kind: "missing" };
  return { kind: "running" };
}


// ── 裁决点 7：孤儿 run 对账清理（无主 run 的唯一磁盘清理通道）──────────
//
// 语义（用户裁决 2026-09-28，workflow-run-resume-revision 裁决点 7）：run 数据
// 生命周期跟随 session 归属——任一存活 session 的注册引用指向该 runId 则保留；
// 全部引用 session 已删 → 清理三件（record 流 + manifest 派生缓存 + 历史遗留
// 旧双源文件——旧两件按 [D1] 处置不读不写不主动删，「无引用回收时顺带删除是
// 既有清理通道的自然结果，非新增删除动作」；顺带删同 runId `.resume.lock`）。
//
// 实现落点：维护轮族扩展（本文件——prune/maintenance 同族，[D9] abandon 移除后
// 无主 run 的唯一磁盘清理通道），复用三触发点（新 run 首写 / record 首写 /
// session_start 兜底——经壳侧 session-lifecycle 装配）；存活 session 引用集采集
// = 壳侧注入面（collectAliveRunReferences，core 不 import pi SDK）；不复用
// createPiHostRunEnumeration（run 维度枚举 ≠ session 维度引用集采集，且维护轮
// 不应依赖 pi 布局的 agentDir 活源）。
//
// 引用集三代形态（都解析——只认 v2 会把存量 run 首轮误判无主并不可逆删除）：
// v2 注册条目（当前主形态）/ v1 全量快照条目 / pre-W17 link 指针。

/** 对账清理的宿主注入依赖（引用集采集面 + 日志）。 */
export interface OrphanRunReapDeps { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /**
   * 存活 session 引用集采集（壳侧注入面——全池 session 文件流式扫描，秒级～
   * 十秒级）：返回「全部存活 session 的注册引用并集」runId 集合。调用一次，
   * 结果复用于本轮全部判定（宽限窗判定不做增量）。
   */
  collectAliveRunReferences: () => Promise<ReadonlySet<string>>;
  /** warn 通道（登记 IO 失败留证；清理是旁路维护，失败不抛）。 */
  warn: (msg: string) => void;
  /** debug 通道（登记/删除过程记录）。 */
  debug: (msg: string) => void;
  /** error → 可读字符串。 */
  toMsg: (err: unknown) => string;
}

/** 对账清理可调项。 */
export interface OrphanRunReapOptions { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /**
   * 宽限窗（ms）：删除条件 = 登记距今 ≥ 宽限窗 ∧ 三件最大 mtime 距扫描 ≥ 宽限窗
   * （与门防活跃误删）∧ 当轮仍无引用。缺省 {@link resolveOrphanRunGraceWindowMs}
   * （7 天，env 可调 / 测试调零）。
   */
  graceWindowMs?: number;
  /** 时钟注入（epoch ms）；缺省 Date.now——宽限窗判定的确定性测试通道。 */
  now?: number;
}

/** 宽限窗缺省值 = 7 天（裁决点 7「删除安全（首版宽限）」——首判无主后仍留观察期）。 */
const DEFAULT_ORPHAN_RUN_GRACE_WINDOW_MS = 604_800_000;

/** 宽限窗 env 通道（测试期调零用；TAIJI_ 前缀理由对齐 STATE_TTL_MS_ENV——pi 进程内读的配置 env）。 */
export const ORPHAN_RUN_GRACE_WINDOW_MS_ENV = "TAIJI_WORKFLOW_ORPHAN_RUN_GRACE_WINDOW_MS";

/** 解析宽限窗；env 未设/空 → 缺省 7 天；显式 0/正数 → env 值（调零 = 测试即删通道）。 */
function resolveOrphanRunGraceWindowMs(): number {
  const raw = process.env[ORPHAN_RUN_GRACE_WINDOW_MS_ENV];
  if (raw === undefined || raw === "") return DEFAULT_ORPHAN_RUN_GRACE_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_ORPHAN_RUN_GRACE_WINDOW_MS;
  return parsed;
}

/** 首判无主登记状态文件名（<stateDir>/orphan-run-reap.json——原子写，损坏按空重登记）。 */
const ORPHAN_REAP_REGISTRY_FILE = "orphan-run-reap.json";

/** 登记状态：runId → 首判无主时刻（epoch ms）。并发丢更新显式接受不设锁（低频维护轮 + 宁保留方向）。 */
type OrphanReapRegistry = Record<string, number>;

/**
 * 读登记状态（损坏按空重登记——宁保留方向：登记丢失只会延后删除，不会提前）。
 *
 * ENOENT 静默返回空表（首轮无登记的正常空态——不存在 ≠ 损坏）；其余读失败 /
 * 损坏 JSON / 非登记表结构 warn 留证后按空表返回——持续损坏 = 宽限窗反复重起
 * 的循环，无 warn 则该循环不可见（观测面）。
 */
function readOrphanReapRegistry(
  stateDir: string,
  deps: Pick<OrphanRunReapDeps, "warn" | "toMsg">,
): OrphanReapRegistry {
  const fullPath = join(stateDir, ORPHAN_REAP_REGISTRY_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fullPath, "utf8"));
  } catch (err) {
    if (isEnoentError(err)) return {}; // 首轮无登记——正常空态，静默
    warnCorruptOrphanReapRegistry(fullPath, deps.warn, deps.toMsg(err));
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) {
    // 合法 JSON 但非登记表结构（原始值/数组）——后果与损坏 JSON 同路（空表重
    // 登记 + 宽限窗重起），同走 warn 观测面
    warnCorruptOrphanReapRegistry(
      fullPath,
      deps.warn,
      `unexpected registry shape (parsed ${Array.isArray(parsed) ? "array" : typeof parsed})`,
    );
    return {};
  }
  const out: OrphanReapRegistry = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** 损坏登记的观测面 warn（单点文案：文件路径 + 空重登记语义 + 恢复指引）。 */
function warnCorruptOrphanReapRegistry(
  fullPath: string,
  warn: (msg: string) => void,
  detail: string,
): void {
  warn(
    `orphan reap: registry read failed or corrupted, re-registering from empty ` +
      `(registered runs restart their grace windows — keep-not-delete; deletion is deferred, never advanced): ` +
      `${fullPath}: ${detail}. If this recurs, check disk and filesystem health; the file is safe to ` +
      `delete — the next reconcile round rebuilds it.`,
  );
}

/** 三件（record 流 + manifest + 旧双源）+ .resume.lock 的存在性探测（mtime 取最大——与门输入）。 */
function runFootprintMaxMtime(stateDir: string, runId: string): { exists: boolean; maxMtime: number } {
  const candidates = [
    `${runId}${RUN_EVENTS_SUFFIX}`,
    `${runId}.json`,
    `${runId}.jsonl`, // 历史遗留旧 state 快照（[D1] 不读不写不主动删——无主回收顺带删）
    `${runId}.events.jsonl`, // 历史遗留旧 journal（同上）
    `${runId}.resume.lock`, // 顺带删（裁决点 7：孤儿 run 清理顺带清残锁）
  ];
  let exists = false;
  let maxMtime = 0;
  for (const name of candidates) {
    try {
      const st = statSync(join(stateDir, name));
      exists = true;
      if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
    } catch {
      // 不存在（ENOENT 属探测控制流）——继续探测其余件
      continue;
    }
  }
  return { exists, maxMtime };
}

/** 成对删 run 磁盘足迹（三件 + 残锁，存在才删——ENOENT 静默）。 */
function deleteOrphanRunFootprint(stateDir: string, runId: string): number {
  const names = [
    `${runId}${RUN_EVENTS_SUFFIX}`,
    `${runId}.json`,
    `${runId}.jsonl`,
    `${runId}.events.jsonl`,
    `${runId}.resume.lock`,
  ];
  let deleted = 0;
  for (const name of names) {
    try {
      unlinkSync(join(stateDir, name));
      deleted += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return deleted;
}

/** 对账清理执行结果（宿主日志/健康面用）。 */
export interface OrphanRunReapResult { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /** 扫描的 run 候选数（record 流 + 旧 journal 文件族并集的 runId 数）。 */
  scanned: number;
  /** 存活引用保护跳过数。 */
  skippedReferenced: number;
  /** 宽限窗未到跳过数（新登记或早于窗）。 */
  skippedGraceWindow: number;
  /** 本次删除的 run 数。 */
  reaped: number;
}

/**
 * 裁决点 7 对账清理：无主 run 的唯一磁盘清理通道（维护轮族扩展，幂等可重入）。
 *
 * 判定链（每轮全量）：
 * 1. 枚举 stateDir 的 runId 候选（record 流后缀 + 旧 journal 后缀的文件族并集——
 *    含历史遗留形态；manifest 单独在场不成候选：无 record 流与旧 journal 的孤儿
 *    manifest 是终局投影残留，prune 资格链已覆盖）；
 * 2. 引用集三代解析（collectAliveRunReferences 注入——壳侧全池 session 文件扫描，
 *    v2 注册条目 ∪ v1 快照条目 ∪ pre-W17 link 指针的并集，解析归壳侧注入面）；
 * 3. 引用命中 → 跳过（保护——任一存活 session 引用即保留）；引用未命中 → 登记
 *    首判无主时刻（幂等：已登记保持首判时刻，宽限锚不随重扫漂移——「不采用锚
 *    mtime」的裁决：仅被 v1/link 引用的存量 run 创建于数周前，首轮判无主即删
 *    的话宽限保护为零）；
 * 4. 删除条件（与门）：登记距今 ≥ 宽限窗 ∧ 三件最大 mtime 距扫描 ≥ 宽限窗 ∧
 *    当轮仍无引用 → 删三件 + 残锁 + 清登记条目。
 *
 * 失败处置：单 run 判定/删除失败按「不可判定 → 跳过」降级（宁保留不误删——
 * 误删活跃 run 是不可恢复事故方向），warn 留证；登记 IO 失败整轮降级跳过
 * （无登记不删——防宽限锚丢失后首轮即删）。
 */
/** [reapOrphanRuns 拆分] 候选枚举（record 流 + 旧 journal 文件族并集，去前缀得 runId 集）。 */
function collectOrphanCandidateRunIds(names: readonly string[]): Set<string> {
  const runIds = new Set<string>();
  for (const name of names) {
    for (const suffix of [RUN_EVENTS_SUFFIX, ".events.jsonl"]) {
      if (name.endsWith(suffix)) {
        runIds.add(name.slice(0, -suffix.length));
        break;
      }
    }
  }
  return runIds;
}

/**
 * [reapOrphanRuns 拆分] 单 run 收编判定与删除（异常上抛交调用方降级——宁保留）。
 * 返回值 = 登记表是否被本次触碰（引用清登记 / 首判登记 / 删除清登记）。
 */
function reapSingleOrphanRun(
  stateDir: string,
  runId: string,
  ctx: {
    referenced: ReadonlySet<string>;
    registry: OrphanReapRegistry;
    now: number;
    graceWindowMs: number;
  },
  deps: OrphanRunReapDeps,
  result: OrphanRunReapResult,
): boolean {
  if (ctx.referenced.has(runId)) {
    // 引用保护命中——清登记（引用恢复的 run 不再处于无主观察期）
    const hadEntry = ctx.registry[runId] !== undefined;
    if (hadEntry) delete ctx.registry[runId];
    result.skippedReferenced += 1;
    return hadEntry;
  }
  // 无主判定（登记锚 = 首判时刻，非 mtime）
  let registryDirty = false;
  const firstSeen = ctx.registry[runId] ?? ctx.now;
  if (ctx.registry[runId] === undefined) {
    ctx.registry[runId] = ctx.now;
    registryDirty = true;
  }
  const footprint = runFootprintMaxMtime(stateDir, runId);
  if (!footprint.exists) return registryDirty; // 候选文件在本轮扫描后被并发清走
  // 与门：首判距 now ≥ 窗 ∧ 三件最大 mtime 距 now ≥ 窗
  if (ctx.now - firstSeen < ctx.graceWindowMs || ctx.now - footprint.maxMtime < ctx.graceWindowMs) {
    result.skippedGraceWindow += 1;
    return registryDirty;
  }
  // 删除（三件 + 残锁 + 登记条目）
  const deleted = deleteOrphanRunFootprint(stateDir, runId);
  delete ctx.registry[runId];
  result.reaped += 1;
  deps.debug(
    `orphan reap: removed ${deleted} file(s) for unreferenced run ${runId} (grace window ${ctx.graceWindowMs}ms elapsed)`,
  );
  return true;
}

export async function reapOrphanRuns(
  input: { stateDir?: string },
  deps: OrphanRunReapDeps,
  options: OrphanRunReapOptions = {},
): Promise<OrphanRunReapResult> {
  const result: OrphanRunReapResult = {
    scanned: 0,
    skippedReferenced: 0,
    skippedGraceWindow: 0,
    reaped: 0,
  };
  if (input.stateDir === undefined) return result;
  const stateDir = input.stateDir;
  const now = options.now ?? Date.now();
  const graceWindowMs = options.graceWindowMs ?? resolveOrphanRunGraceWindowMs();

  // 候选枚举（record 流 + 旧 journal 文件族并集）
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch (err) {
    if (!isEnoentError(err)) {
      deps.warn(`orphan reap: readdir ${stateDir} failed: ${deps.toMsg(err)}`);
    }
    return result; // ENOENT = 从未落盘，正常空态
  }
  const runIds = collectOrphanCandidateRunIds(names);
  result.scanned = runIds.size;

  // 引用集采集（壳侧注入面——三代解析归注入实现）
  let referenced: ReadonlySet<string>;
  try {
    referenced = await deps.collectAliveRunReferences();
  } catch (err) {
    // 采集失败 = 引用状态不可知 → 整轮跳过（宁保留）
    deps.warn(`orphan reap: alive reference collection failed, round skipped: ${deps.toMsg(err)}`);
    return result;
  }

  // 登记状态读（IO 失败整轮降级——无登记不删，防宽限锚丢失后首轮即删）
  let registry: OrphanReapRegistry;
  try {
    registry = readOrphanReapRegistry(stateDir, deps);
  } catch (err) {
    deps.warn(`orphan reap: registry read failed, round skipped: ${deps.toMsg(err)}`);
    return result;
  }
  let registryDirty = false;

  for (const runId of runIds) {
    try {
      registryDirty = reapSingleOrphanRun(stateDir, runId, { referenced, registry, now, graceWindowMs }, deps, result) || registryDirty;
    } catch (err) {
      // 单 run 失败不中断整轮（宁保留）
      result.skippedGraceWindow += 1;
      deps.warn(`orphan reap: skipped run ${runId}: ${deps.toMsg(err)}`);
    }
  }

  // 登记落盘（原子写——shared writeAtomicFileSync 单源：统一 tmp 约定可被
  // listStaleTmpFiles/cleanupStaleTmpFiles 识别清扫、失败路径尽力清理残留 tmp；
  // 有变更才写）
  if (registryDirty) {
    try {
      writeAtomicFileSync(join(stateDir, ORPHAN_REAP_REGISTRY_FILE), JSON.stringify(registry));
    } catch (err) {
      deps.warn(`orphan reap: registry write failed (re-registration next round): ${deps.toMsg(err)}`);
    }
  }
  return result;
}
