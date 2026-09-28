// src/orchestration/file-run-store.ts
//
// RunStore port 的通用文件实现（D2 设计件——zsw 回接 host-surface 单元）。
//
// 为什么需要它：pi 壳的 JsonlRunStore 深耦合 pi session（appendEntry /
// sessionManager，经 pi SDK 落盘 session JSONL），zcode 侧宿主没有这两个设施，
// 无法复用。RunStore port 早在 ports.ts 定义却只有 pi 一份 Infra 实现——本文件
// 补上「宿主无关」的第二份实现，双宿主的 workflow state 持久化从此同源（消灭
// 失败模式 B：行为不一致各自修）。
//
// 落盘布局：<dataRoot>/workflow-state/<runId>.jsonl（D2 规定，与 pi 壳
// <sessionDir>/workflow-state/<runId>.jsonl 同名分量、锚点不同：pi 锚 session，
// 本实现锚宿主数据根——zcode 宿主无 session dir 概念，daemon 重启后按 dataRoot
// 重水合孤儿 run）。
//
// dataRoot 通道选型：直接走 getHostServices().dataRoot()（core/host-services.ts），
// 不用 getEngineDataDir（engine/common/data-dir.ts）——后者是引擎 journal/隔离池
// 通道，带 TAIJI_AGENT_DATA_DIR env 优先 + warn-once 语义（taiji 宿主注入专用）；
// workflow run 快照是宿主编排状态，语义归属宿主数据根本身，宿主 configureCore
// 注入什么就落什么，不引入第二条 env 覆盖链。

import { readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { getHostServices } from "../core/host-services.ts";
import { getLogger } from "../core/logger.ts";
// [W1/D5 清理规则] record 事件文件族的枚举与 fold 资格判定（统一保留维护轮的
// record 域半边）。方向 orchestration → execution/persistence 为既有先例
// （worker-message-pump → writeRunTerminalManifest）；record-events 不回指
// orchestration，无环。
import {
  createRecordEventJournal,
  foldRecordJournalEvents,
  RECORD_EVENTS_SUFFIX,
  type RecordJournalEvent,
} from "../execution/persistence/record-events.ts";
import type { RunStore } from "./models/ports.ts";
import { WorkflowRun } from "./models/workflow-run.ts";
// journal 后缀与 fold 循环经 run-events 单源消费（本文件只做候选枚举与成对裁剪，
// 不定义后缀词表；fold 终态 = W1 D5 清理资格判据）。
import {
  createRunEventJournal,
  foldRunEventFrames,
  RUN_EVENT_JOURNAL_SUFFIX,
  type RunErrorCode,
  type RunOutcome,
  type WorkflowRunEvent,
} from "./run-events.ts";
// [W2/V1 D6] sweep 判据的 reason 派生单点（帧/manifest (outcome, errorCode) →
// DoneReason——五处统一派生第三处）。方向 orchestration 内部互引（pump 闭包不
// 回指本文件，无环）。
import { runSettledOutcomeToDoneReason } from "./worker-message-pump.ts";
import { SNAPSHOT_VERSION, fromRunSnapshot, toRunSnapshot } from "./run-snapshot.ts";

const logger = getLogger("file-run-store");

/**
 * run 状态目录名（<dataRoot> 下的固定分量）。
 *
 * 单源导出（barrel 上收）：pi 壳 JsonlRunStore / workflow-events 的
 * `<sessionDir>/workflow-state` 布局与 core FileRunStore 的
 * `<dataRoot>/workflow-state` 同名分量——字面量散布时任一侧单独改名即静默
 * 漂移（store 读写错目录 / stall 判定读不到 journal）。
 */
export const STATE_DIR_NAME = "workflow-state";

// ── 磁盘保留（C1 → W1 D5 重写：fold 终态 + 保留窗口，废除 cap）─────
//
// cap=50 数量截断语义已整体退役（数量上限常量 / env 通道名 / 解析函数三件导出
// 一并删除）：cap 按 cwd 共享池计数会把别的 session 保留窗口内的 journal 清掉
// （「窗口内全保留」与「保最新 N 个」互斥，A-8 多 session 分摊互杀）。保留窗口
// 是唯一资格判据（见下方「统一保留通道」段注释）。

/** FileRunStore 构造参数（全部可选；缺省即生产形态）。 */
export interface FileRunStoreOptions {
  /**
   * [F-1 修复] run 状态目录覆盖。缺省 = `<dataRoot>/workflow-state`（zcode 宿主布局，
   * 见 stateDir()）；pi 宿主的读侧装配点（round-supervisor sweep）必须传
   * resolvePiWorkflowStateDir()（execution/workflow-state-root.ts）——pi 宿主 run state
   * 由 JsonlRunStore 落 `<sessionDir>/workflow-state/`，与缺省根不相交。
   */
  stateDir?: string;
}

/** Node fs 错误 code 判定（ENOENT = 路径不存在，并发删除场景；对齐 pi isEnoentError）。 */
function isEnoentError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err &&
    (err as { code?: unknown }).code === "ENOENT";
}

// ── 快照形状 / 序列化 / 重水合 ────────────────────────────────
//
// 投影与版本衔接语义收敛于 ./run-snapshot.ts 单源 codec（下沉收口 D4/U8）：
// 本 store 只保留 IO 策略（append-only + 从尾向头取最后有效行）。版本衔接的
// 宿主侧职责（D4 裁决②③，见 parseLine）：「缺 v 宽容读」预处理与「版本不
// 匹配 warn 可见性」在此实现——不内聚进 codec，保 pi 侧「v1 存量静默跳过」
// 语义不被宽容化误读。

// ── 磁盘保留原语（C1 → W1 D5 重写：fold 终态 + 保留窗口）──────────
//
// retention 语义单源（候选枚举 / fold 终态资格 / 保留窗口 / 任何失败不抛），日志与
// 错误字符串化经 deps 注入（宿主各自的 logger tag / error 工具保持自治，行为差异
// 仅 log tag 文案）。

/** pruneTerminalRunFiles / runRetentionMaintenanceRound 的宿主注入依赖（日志与错误字符串化——tag 前缀由注入方决定）。 */
export interface PruneStateDeps {
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
// ③ 清理对象按 run 粒度成对删 state 文件 + journal（<runId>.events.jsonl，存在才
//    删）；record 域同判据清 <sa-id>.events 事件文件（manifest 不触碰，其独立
//    30 天 TTL 归 session-file-gc，孤儿判定窗口不漂移）；
// ④ 任何失败不抛（辅助清理降级不拖垮主链）：readdir 失败静默放弃本轮该域，单
//    run 判定失败按「不可判定 → 跳过」降级（宁保留不误裁——误裁活跃 run 是不可
//    恢复事故方向），单文件 unlink 失败 warn 留证后继续。
//
// 保留窗口常量与 env 通道沿用 [P1b-2] 引入、[Q2] 单源化的 TAIJI_SUBAGENT_STATE_TTL_MS
// （两宿主共用同一缺省保留期与测试期调低通道；W1 起为 run+record 两域统一窗口）。

/** 保留窗口缺省值 = 2_592_000_000ms（30 天；W1 D5：run+record 两域统一保留窗口，窗口内全保留）。 */
export const DEFAULT_STATE_TTL_MS = 2_592_000_000;

/**
 * 保留窗口 env 通道（测试期调低用）：
 * - 未设/空 → 缺省 {@link DEFAULT_STATE_TTL_MS}（默认开）；
 * - 有限正数 → 窗口 = env 值（测试期调低通道）；
 * - 非法值（非有限数/≤0）→ undefined = 不按窗裁（显式 opt-out，「意图不明不动
 *   磁盘」哲学；窗口是唯一资格判据，opt-out 即整轮不裁，仅保留候选数监控）。
 */
export const STATE_TTL_MS_ENV = "TAIJI_SUBAGENT_STATE_TTL_MS";

/** 解析保留窗口；env 未设/空 → 缺省，显式非法/≤0 → undefined（不按窗裁）。 */
export function resolveStateTtlMs(): number | undefined {
  const raw = process.env[STATE_TTL_MS_ENV];
  if (raw === undefined || raw === "") return DEFAULT_STATE_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/** pruneTerminalRunFiles 的可调项。 */
export interface PruneTerminalRunFilesOptions {
  /** 保留窗口（ms）；undefined = 不按窗裁（opt-out）。缺省经 {@link resolveStateTtlMs}。 */
  ttlMs?: number;
}

/** pruneTerminalRunFiles 的执行结果（宿主日志/健康面用）。 */
export interface PruneTerminalRunFilesResult {
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
interface RunRetentionAssessment {
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
  const state = foldRunEventFrames(events, (err, lastType) => {
    // 坏帧（历史帧与当前转移表不兼容）保守停在最近一致态——fold 非终态即不获资格
    deps.debug(
      `state retention: broken frame ignored in ${runId} (lastType=${lastType}): ${deps.toMsg(err)}`,
    );
  });
  let settledAt: number | undefined;
  let registeredAt: number | undefined;
  let lastEventTs: number | undefined;
  for (const event of events) {
    if (event.type === "run-created") registeredAt ??= event.ts;
    if (event.type === "run-settled") settledAt = event.ts;
    lastEventTs = event.ts;
  }
  const terminal = state.lifecycle === "terminal";
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
  const journalFull = join(stateDir, `${runId}${RUN_EVENT_JOURNAL_SUFFIX}`);
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
  // state 文件候选：wf-*.jsonl 且排除 journal（<runId>.events.jsonl——附属，不单独候选）
  const stateNames = names.filter(
    (n) => n.startsWith("wf-") && n.endsWith(".jsonl") && !n.endsWith(RUN_EVENT_JOURNAL_SUFFIX),
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
export interface PruneTerminalRecordEventFilesResult {
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

  const journal = createRecordEventJournal(recordsDir);
  const now = Date.now();
  const windowForCandidates = retentionMs ?? DEFAULT_STATE_TTL_MS;
  for (const name of eventNames) {
    const id = name.slice(0, -RECORD_EVENTS_SUFFIX.length);
    let events: readonly RecordJournalEvent[];
    try {
      events = await journal.scan(id);
    } catch (err) {
      // 非法文件名（assertValidRecordId）/ 读失败 = 不可判定 → 跳过（宁保留不误裁）
      deps.debug(`state retention: record events scan failed, skipped ${name}: ${deps.toMsg(err)}`);
      continue;
    }
    const fold = foldRecordJournalEvents(events);
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
export interface RetentionMaintenanceInput {
  /** run 域状态目录（workflow-state——state 快照 + journal 成对清理）；undefined = 跳过 run 域。 */
  stateDir?: string;
  /** record 事件文件目录（records——仅清 *.events，manifest 不触碰）；undefined = 跳过 record 域。 */
  recordsDir?: string;
}

/** 维护轮可调项。 */
export interface RetentionMaintenanceOptions {
  /** 保留窗口（ms）；undefined = 经 {@link resolveStateTtlMs}（缺省 30 天 + env 调低通道）。 */
  retentionMs?: number;
}

/** 维护轮执行结果（两域计数面）。 */
export interface RetentionMaintenanceResult {
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

// ── FileRunStore ────────────────────────────────────────────

/**
 * RunStore port 的宿主无关文件实现（port 见 models/ports.ts）。
 *
 * - save：append-only 全量快照行（崩溃时旧快照仍在，loadAll 取最后一条有效行恢复
 *   到最后一致状态）。W1 写通道语义收敛后不再自带节流（快照 = journal fold 的
 *   物化投影，写点收敛归 pump 物化时机，见 save 注释）。
 * - loadAll：扫 <dataRoot>/workflow-state/*.jsonl，每文件从尾向头取第一条形状
 *   有效的快照行；损坏行（JSON.parse 失败 / 形状校验不过 / 版本不匹配）跳过并
 *   warn——单行损坏不拖垮整个 run 的恢复（与 pi 壳 kill-9 恢复同容忍度）。
 *   目录读错分通道（idle-gc 退役 §3.1 规格 2）：ENOENT = 空集正常态；EACCES/EIO
 *   等真 IO 故障上抛（recoverCrashedRuns 的 @throws 契约本就要求 loadAll 失败
 *   上抛宿主裁决——此前 EACCES 被裸 catch 吞成空集是偏离契约的吞错）。
 *   版本衔接（快照 codec 归 run-snapshot.ts 单源，D4）：存量无 v 行按当前版本
 *   宽容读、写入恒补 v、v 不匹配跳过 + warn（三裁决明细见 parseLine 注释）。
 * - stateFilePath：纯路径计算（<状态目录>/<runId>.jsonl），不建目录。状态目录 =
 *   构造注入的 stateDir 覆盖，或缺省 <dataRoot>/workflow-state（pi 宿主读侧装配点
 *   必须传 resolvePiWorkflowStateDir()——见 FileRunStoreOptions.stateDir 与
 *   execution/workflow-state-root.ts 的同源布局论证）。
 *
 * 未 configureCore 即 save/loadAll 会抛 core_host_not_configured（dataRoot 端口
 * 语义，host-services.ts §3.4）——宿主壳必须在初始化最早期注入。
 */
export class FileRunStore implements RunStore {
  /** run 状态目录绝对路径（显式覆盖优先——pi 宿主读侧装配点；缺省 dataRoot 每次现取
   *  ——宿主覆盖配置即刻生效，对齐 data-dir.ts「不缓存路径防测试/宿主切换读到旧值」
   *  先例）。 */
  private stateDir(): string {
    return this.stateDirOverride ?? join(getHostServices().dataRoot(), STATE_DIR_NAME);
  }

  /** 显式状态目录覆盖（构造注入；见 FileRunStoreOptions.stateDir）。 */
  private readonly stateDirOverride: string | undefined;

  constructor(opts?: FileRunStoreOptions) {
    this.stateDirOverride = opts?.stateDir;
  }

  stateFilePath(runId: string): string {
    return join(this.stateDir(), `${runId}.jsonl`);
  }

  /**
   * 快照落盘（append-only 全量行）。W1 写通道语义收敛后本 store 不再自带节流
   * （节流模块已随写通道退役删除）：快照降级为 journal fold 的物化投影，
   * 写点收敛到「journal 追加后的统一物化步」（pump 物化时机归 U1）——节流层
   * 与物化时机收敛重复保险，且物化点稀疏化后节流窗口无保护对象。
   */
  async save(run: WorkflowRun): Promise<void> {
    // mkdir recursive 每次 save 前执行：幂等零成本（目录已存在时仅一次 stat），
    // 且免「构造时预建」——构造时建会在宿主尚未 configureCore 的窗口抛错。
    await mkdir(this.stateDir(), { recursive: true });
    // toRunSnapshot 补 v 字段（D4 裁决②写入侧）；live strip 已随 [H2 W3] live 字段删除退役
    const line = JSON.stringify(toRunSnapshot(run));
    await appendFile(this.stateFilePath(run.runId), line + "\n", "utf8");
  }

  async loadAll(): Promise<WorkflowRun[]> {
    let files: string[];
    try {
      files = await readdir(this.stateDir());
    } catch (err) {
      if (!isEnoentError(err)) {
        // 读错分通道（idle-gc 退役 §3.1 规格 2）：EACCES/EIO 等真 IO 故障上抛给
        // 扫描层（枚举/启动扫描 error 留痕承接）——静默折叠成空集会让持续 IO
        // 故障伪装成「0 个 run 的成功扫描」。
        throw err;
      }
      // 目录不存在 = 从未持久化过（首启/干净环境），空集是正常态不是错误。
      return [];
    }

    const runs: WorkflowRun[] = [];
    for (const file of files) {
      // journal（<runId>.events.jsonl）同为 .jsonl 后缀但是事件流附属文件——不排除
      // 会进逐行 parseLine，事件行全部按损坏快照行逐条 warn（噪音洪泛）。排除先例：
      // pruneTerminalRunFiles 的 stateNames 过滤同款。
      if (!file.endsWith(".jsonl") || file.endsWith(RUN_EVENT_JOURNAL_SUFFIX)) continue;
      const run = await this.loadLatestValidLine(join(this.stateDir(), file), file);
      if (run) runs.push(run);
    }
    return runs;
  }

  /**
   * [W2/V1 D6 判据源改接] 按 runId 同步查 run 的终态证据（注册对账 sweep 的
   * workflow 收口判据）——journal run-settled 帧 ∨ manifest 终局面，两态机持久化
   * 快照字段退役为判据源（活体写点删除后 v2 run 的 state 快照永停 running，旧
   * findStateByIdSync 判据对全部 v2 run 永判 active = sweep 结构性静默失效）。
   *
   * 同步形态：sweep 在 session_start 同步链内运行（runReconcileSweep 同步契约），
   * 不能 await——对单 runId 做同步文件读（对齐 sweep 自身的 sync fs 读先例；
   * journal 行逐行 JSON.parse + run-settled 尾向扫描，manifest 同步读）。
   *
   * 判定矩阵（[W2 D6] 逐形态锚定保守侧——误注销活跃 run 是事故方向，不可逆）：
   * - journal 与 manifest 均不存在（ENOENT）→ missing（「已归档/不存在视同终态」
   *   ——run 从未落账或已被保留期清理，注册是死亡窗口残留）；
   * - journal 尾向存在 run-settled 帧（append-only 单写者：帧在盘 = 终局已记录，
   *   行级独立 JSON 不受早先坏行影响）→ terminal + reason（帧 (outcome, errorCode)
   *   经 runSettledOutcomeToDoneReason 联合派生——[W2 D5] sweep 补注销 reason 统一
   *   派生源第三处；budget_limited/time_limited 细分保留）；
   * - journal 无帧但 manifest 在盘（活体物化后 journal 被裁的组合）→ terminal +
   *   reason（manifest outcome 派生；无码细分退化为 outcome 兜底）；
   * - journal 存在但无 run-settled 帧（run 真未终局，含坏链首帧形态）→ running
   *   （保守按活跃，不补注销——对齐 adoptInterruptedRun skippedBrokenChain 纪律）；
   * - journal 读错误（非 ENOENT IO 故障）→ running + warn 留证（「IO 故障 ≠ 不存在」
   *   的保守侧纪律，宁挂账不误注销）。
   */
  findSettlementEvidenceSync(runId: string): { kind: "running" } | { kind: "terminal"; reason: string } | { kind: "missing" } {
    const journalPath = join(this.stateDir(), `${runId}${RUN_EVENT_JOURNAL_SUFFIX}`);
    let settled: Extract<WorkflowRunEvent, { type: "run-settled" }> | undefined;
    let journalMissing = false;
    try {
      const content = readFileSync(journalPath, "utf8");
      const lines = content.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!.trim();
        if (line === "") continue; // 尾部空行静默跳过
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // 坏行（截断行）继续向前——append-only 下帧行独立有效
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
      if (!isEnoentError(err)) {
        // 非 ENOENT 读错误（EACCES/EIO 等）≠ 文件不存在——保守侧按活跃挂账
        //（宁挂账不误注销），warn 留证防 IO 故障伪装成 missing。
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[file-run-store] findSettlementEvidenceSync journal read failed, treating as running (stay registered): ${journalPath}: ${msg}`,
        );
        return { kind: "running" };
      }
      journalMissing = true;
    }
    if (settled !== undefined) {
      return {
        kind: "terminal",
        reason: runSettledOutcomeToDoneReason(settled.outcome, settled.errorCode),
      };
    }
    // journal 无帧：manifest 终局面（prune 资格单源锚定的第二证据通道）
    const manifestPath = join(this.stateDir(), `${runId}.json`);
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        const outcome = (parsed as { outcome?: unknown }).outcome;
        const errorCode = (parsed as { errorCode?: unknown }).errorCode;
        if (typeof outcome === "string") {
          return {
            kind: "terminal",
            reason: runSettledOutcomeToDoneReason(
              outcome as RunOutcome,
              typeof errorCode === "string" ? (errorCode as RunErrorCode) : undefined,
            ),
          };
        }
      }
    } catch (err) {
      if (!isEnoentError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[file-run-store] findSettlementEvidenceSync manifest read failed, treating as running (stay registered): ${manifestPath}: ${msg}`,
        );
        return { kind: "running" };
      }
    }
    // 两证据面均缺：journal 存在但无帧 = 真未终局（保守活跃）；journal 也缺 =
    // missing（从未落账/已清理——视同终态补注销）。
    if (journalMissing) return { kind: "missing" };
    return { kind: "running" };
  }

  /** 单文件从尾向头取第一条有效快照行；整文件无有效行返回 undefined（warn）。 */
  private async loadLatestValidLine(absPath: string, display: string): Promise<WorkflowRun | undefined> {
    let content: string;
    try {
      content = await readFile(absPath, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[file-run-store] skip unreadable state file ${display}: ${msg}`);
      return undefined;
    }

    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line === "") continue; // 尾部空行（末行 \n 产物）静默跳过
      const run = this.parseLine(line, display, i);
      if (run) return run;
      // 损坏行 warn 后继续向前找——最后一条「有效」行可能早于文件尾部（半行写入崩溃）
    }
    logger.warn(`[file-run-store] no valid snapshot line in ${display} (empty or all corrupted)`);
    return undefined;
  }

  /**
   * 单行解析 + 版本衔接预处理（D4 裁决②③，宿主侧职责）+ 形状校验；损坏
   * warn 并返回 undefined。
   *
   * - 缺 v 字段（core 存量行）→ 就地补当前版本再进 codec（「缺版本 = 当前
   *   版本」宽容读，不做自动迁移——写回时经 toRunSnapshot 自然补 v 完成渐进
   *   收敛）；预处理留在 store 层而非 codec，保 pi 侧「v1 存量静默跳过」语义
   *   不被宽容化误读（D4 裁决②归属裁决）。
   * - v 存在但不匹配（未知更高版本/降级写入）→ 跳过 + warn（补可见性，对齐
   *   pi 静默跳过语义；字符串版本无大小序，不引入比较逻辑——D4 裁决③）。
   *   此处版本判断仅为 warn 可见性，数据防线仍是 codec 内 guard（双保险，
   *   pi 切换 codec 后共享同一防线）。
   */
  private parseLine(line: string, display: string, lineNo: number): WorkflowRun | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[file-run-store] skip corrupted line ${display}:${lineNo}: ${msg}`);
      return undefined;
    }
    if (parsed !== null && typeof parsed === "object") {
      const rec = parsed as { v?: unknown };
      if (rec.v === undefined) {
        rec.v = SNAPSHOT_VERSION;
      } else if (rec.v !== SNAPSHOT_VERSION) {
        logger.warn(
          `[file-run-store] skip snapshot with unsupported version ${display}:${lineNo}: v=${JSON.stringify(rec.v)} (this build only reads v=${JSON.stringify(SNAPSHOT_VERSION)}; the run line is skipped). To recover: upgrade @zhushanwen/subagent-core, or migrate/delete this state file if its runs are no longer needed`,
        );
        return undefined;
      }
    }
    const run = fromRunSnapshot(parsed);
    if (run === undefined) {
      logger.warn(`[file-run-store] skip malformed snapshot ${display}:${lineNo} (shape validation failed)`);
      return undefined;
    }
    return run;
  }
}
