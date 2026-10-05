// src/orchestration/run-registry.ts
//
// Workflow run 注册表（D9-1）——D5 状态机的投影面。
//
// 为什么需要它：现状 run 状态判读只能读进程自写快照（state 文件末行 status），
// 进程死亡后快照永远停在 running（僵尸）——「状态字段不可信、靠 mtime 新鲜度」
// 的启发式时代由此而来。本模块把判读换轨到结构判据：注册表 = record 流 fold 的
// 投影，只消费 D5 事件流（不另立状态存储）——
// - 事件流正常推进（本进程活体持有）→ 活跃（lifecycle 对齐状态机 fold 终帧）；
// - run-settled 已落账 → 终局（outcome/errorCode 从事件与终局投影 manifest 读）；
// - run-interrupted 已落账（[D2] 显式中断转移）或事件流停止（活体集未命中 =
//   host-died 判读）→ interrupted 暂停态，非 terminal——僵尸 running 构造性消除，
//   恢复交互（resume，U2）以 lifecycle=interrupted 为资格判据。
//
// 能力二：中断收编入口（adoptInterruptedRun，[D15] 中断路的生产原语）——崩溃后
// 无活体的 run 经它幂等落 run-interrupted 转移事件（terminal → interruptRun 的
// IllegalTransitionError 让位）+ 中断条目补写。[D9] abandon（interrupted 超放弃窗
// 自动终局化）已整体移除——「数天后回来仍可 resume」的 run 不再被判死，无主 run
// 的磁盘清理归裁决点 7 对账清理（persistence/run-state-evidence 维护轮族）。
//
// 能力边界：终局判法 = record fold 唯一权威（[D1]，无第二判据可分叉）；manifest
// 是派生缓存（加速判定 + 诊断落点）。record 清理执行不落在本模块——已终局 run 的
// 成对裁剪在 persistence/run-state-evidence（与 TTL 同一判定单元）；本模块只负责
// 让 interrupted「无悬挂态」。
//
// 层归属：Engine。依赖 run-events（状态机 + journal）与 terminal-actions（中断/终局
// 编排入口）；零时钟依赖进纯函数（now/windowMs 显式传参）。

import { getLogger } from "../core/logger.ts";
import { readRunTerminalManifest } from "../execution/persistence/manifest-store.ts";
import {
  INITIAL_RUN_LIFECYCLE_STATE,
  foldRunEventFrames,
  type RunErrorCode,
  type RunEventJournal,
  type RunLifecycleState,
  type WorkflowRunEvent,
} from "./run-events.ts";
// [D15] 中断编排入口（run-interrupted 转移事件 + 中断条目补写的统一写点）、
// foldRunEventsToLifecycleState（[D6(b)] 进程内 fold 检查点缓存的唯一读口——
// 收编链的 fold 与 dispatch 链共享同一份全量重放结果，不再独立重折）与
// scanRunEvents（record 读通道——journal 单写者域，证据面一致；ADR-0081 起
// journal 目录支持 per-call 参数注入，缺省仍模块锚）。
import {
  foldRunEventsToLifecycleState,
  interruptRun,
  runEventJournalDirOf,
  scanRunEvents,
} from "./terminal-actions.ts";
import type { WorkflowRecordSettledEntryData } from "./workflow-record-entry.ts";

const logger = getLogger("run-registry");

// ── 投影（D9-1：注册表 = 状态机投影面）──────────────────────

/** 投影判读四相。 */
export type RunRegistryPhase =
  /** 无事件证据且无活体持有——run 从未落账（或 record 已过保留期清理）。 */
  | "missing"
  /** 本进程活体持有（事件流正常推进）——lifecycle 对齐 fold 终帧。 */
  | "active"
  /** 终局（run-settled 已落账）——outcome 见 state.outcome。 */
  | "terminal"
  /** 暂停态（[D2]）：run-interrupted 已落账（显式中断转移，无论活体）或事件流
   *  停止且活体未命中（host-died 投影判读）——非 terminal，可 resume。 */
  | "interrupted";

/** run 注册表投影（单一推导点，无独立状态存储）。 */
export interface RunRegistryProjection { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  runId: string;
  /** D5 两维状态（fold 终帧；missing 时 = INITIAL_RUN_LIFECYCLE_STATE）。 */
  state: RunLifecycleState;
  /** 投影判读（见 {@link RunRegistryPhase}）。 */
  phase: RunRegistryPhase;
  /** 事件流最后活动时刻（record 末帧 ts；空事件流 = undefined）。 */
  lastEventAt?: number;
  /**
   * 终局错误码（terminal 时）：优先取 run-settled 帧载荷（事件流权威），
   * 缺省 = 无结构化码（done/cancelled/time_limited 或旧帧形态）。
   */
  errorCode?: RunErrorCode;
}

/** 投影的活体判定输入（host-died 判据的互补面——活体集命中即未死）。 */
export interface RunProjectionOptions { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /**
   * 本进程活体持有的 runId 集合（runs Map 的 key 视图）。缺省 = 空集（跨进程
   * 查询形态：record fold 停在非 terminal 一律判 interrupted）。
   */
  activeRunIds?: ReadonlySet<string>;
}

/**
 * record 流 fold：scan 产物逐事件 transition（不传 ctx——run-events.ts fold 契约）。
 *
 * 循环体单源 run-events.ts 的 foldRunEventFrames（与 terminal-actions 的 fold
 * 读口共享同一坏帧失效模式：保守停在最近一致态）；本侧只持注册表域的 warn 文案
 * 与 logger。消费面 = projectRunRegistryEvents（纯投影函数，任意 journal 源的
 * 查询/对账形态，不经进程内缓存）；收编链（adoptInterruptedRun）的 fold 不走
 * 本函数——经 terminal-actions 共享读口（[D6(b)] 检查点缓存）。
 */
function foldEvents(events: readonly WorkflowRunEvent[], runId: string): RunLifecycleState {
  return foldRunEventFrames(events, (err, lastType) => {
    logger.warn(
      `run registry fold stopped at a broken frame (runId=${runId}, lastType=${lastType}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
}

/**
 * 事件流 → 注册表投影（纯函数，单一推导点）。
 *
 * 判读规则（[D2] interrupted 暂停态与投影相对齐）：
 * - fold terminal → terminal（errorCode 从 run-settled 帧）；
 * - fold interrupted（状态机暂停态——run-interrupted 帧已落）→ interrupted（显式
 *   转移即中断，与活体无关——收编后、resume 前的窗口投影恒暂停态）；
 * - fold running/settling + 活体集命中 → active（事件流正常推进）；
 * - fold running/settling + 活体集未命中 → interrupted（事件流停止 = 进程死亡
 *   判读；状态字段不可信——快照末行 running 的僵尸在此判读下构造性消失）；
 * - 空事件流 + 活体集命中 → active（run-created 落账前的创建窗口）；
 * - 空事件流 + 未命中 → missing（无事件证据——从未落账，或已过保留期清理且
 *   消费方应回落 manifest 终局面）。
 */
export function projectRunRegistryEvents(
  events: readonly WorkflowRunEvent[],
  runId: string,
  opts?: RunProjectionOptions,
): RunRegistryProjection {
  const active = opts?.activeRunIds?.has(runId) ?? false;
  const lastEventAt = events.length > 0 ? events[events.length - 1]!.ts : undefined;
  if (events.length === 0) {
    return {
      runId,
      state: INITIAL_RUN_LIFECYCLE_STATE,
      phase: active ? "active" : "missing",
      ...(lastEventAt !== undefined ? { lastEventAt } : {}),
    };
  }
  const state = foldEvents(events, runId);
  if (state.lifecycle === "terminal") {
    // 从尾向头取末条 run-settled（单终局不变量下至多一帧；findLast 的 ES2023 lib
    // 依赖不引入——反向循环等价且无 lib 约束）
    let settledEvent: Extract<WorkflowRunEvent, { type: "run-settled" }> | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "run-settled") {
        settledEvent = e;
        break;
      }
    }
    const errorCode = settledEvent?.errorCode;
    return {
      runId,
      state,
      phase: "terminal",
      ...(lastEventAt !== undefined ? { lastEventAt } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
    };
  }
  // [D2] 状态机 interrupted 态（显式中断转移）与 host-died 判读同落暂停相——
  // 两层语义一致（「执行中断、无活体」，可 resume）。
  const phase = state.lifecycle === "interrupted" || !active ? "interrupted" : "active";
  return {
    runId,
    state,
    phase,
    ...(lastEventAt !== undefined ? { lastEventAt } : {}),
  };
}

/** 指定 run 的注册表投影（record 读面入口——查询/对账消费形态）。 */
export async function projectRunRegistryState(
  journal: RunEventJournal,
  runId: string,
  opts?: RunProjectionOptions,
): Promise<RunRegistryProjection> {
  return projectRunRegistryEvents(await journal.scan(runId), runId, opts);
}

// ── [D15] 中断收编入口（「有注册无终局」实体的统一中断转移路径）──────────
//
// [D15] 中断路的生产原语：崩溃收编（recoverCrashedRuns 逐 run）与启动扫描
//（startupSweep，u1b 接线）经它幂等落 run-interrupted 转移事件。
//
// 幂等机制（双重启不重复追加的构造性保证）：
// 1. 追加前查三面证据——record fold 已 terminal / manifest 已在 / 主 session
//    终态或中断条目已存在（hasSettledEntry 注入面）——任一命中即跳过（宁保留不
//    重复：重复追加 run-interrupted 是 interrupted × run-interrupted 表外转移，
//    fail-fast 让位语义的调用方前置防御）；
// 2. 幂等性由「fold 出的当前态是否已中断/终局」判定——收编产物本身是
//    run-interrupted 帧，下次重入被第 1 条或表外 fail-fast 拦截，record 重放不
//    随重启追加增长。

/** adoptInterruptedRun 的可调项。 */
export interface AdoptInterruptedRunOptions { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  /** 时钟注入（epoch ms）；缺省 Date.now()——转移 ts 的确定性测试通道。 */
  now?: number;
  /** 中断来源标记（RunErrorCode 中断族：crashed / terminated / startup-sweep）。 */
  errorCode?: RunErrorCode;
  /** 中断 reason 文本（run-interrupted 帧载荷 + 诊断面；缺省无 reason）。 */
  reason?: string;
  /**
   * journal 目录（ADR-0081 目录参数化）：runtime 侧启动扫描注入
   * ——调用进程 cwd/env 与落盘目录不相交，scanRunEvents / manifest 证据面 /
   * interruptRun dispatch 链按它解析。缺省 = 模块锚，pi 壳既有调用点零改动。
   */
  journalDir?: string;
  /** 活跃保护集（本进程活体 runId）——活跃 run 事件流静默不判死，永不收编。 */
  activeRunIds?: ReadonlySet<string>;
  /**
   * session 条目证据面：返回 true = 条目已给出终态或中断收敛 → 跳过收编追加
   * （覆盖「record 流整文件损坏但条目完好」的极端组合——条目即收敛证据，不追加
   * 与既有条目构成两记录面矛盾）。壳注入条目读面；缺省 = 无条面证据（core 测试/
   * 纯 record 形态）。
   */
  hasSettledEntry?: (runId: string) => boolean | Promise<boolean>;
  /** 中断条目幂等补写通道（中断转移成功后恰调一次；缺省 = 不写——壳注入 appendEntry 面）。 */
  appendInterruptedEntry?: (entry: WorkflowRecordSettledEntryData) => void;
}

/** adoptInterruptedRun 的判定结果分类。 */
export type AdoptInterruptedRunOutcome =
  /** 已追加 run-interrupted 转移事件（+ 可选中断条目）。 */
  | "adopted"
  /** 三面证据任一命中（record terminal / manifest 在 / 条目在）——幂等跳过。 */
  | "skippedTerminal"
  /** 活跃保护跳过。 */
  | "skippedActive"
  /** 坏链 run（fold 停在 created——run-created 帧损坏/缺首帧，run-interrupted 表外转移）。 */
  | "skippedBrokenChain"
  /** 空 record 流（无事件证据——从未落账或已过保留期清理）。 */
  | "skippedMissing";

/** 收编 manifest 证据面目录（模块 journal 同源锚；`journalDir` = per-call 目录
 *  （决策 2——runtime 侧扫描注入，缺省模块锚）；测试防线形态返回 undefined）。 */
function resolveManifestDirForAdopt(journalDir?: string): string | undefined {
  return runEventJournalDirOf(journalDir);
}

/**
 * 单 run 中断收编：scan → fold → 三面证据 → （宽限窗）→ interruptRun 入口
 * （幂等追加 run-interrupted + 可选中断条目）。
 *
 * [D15] 记录动作统一走中断编排入口：run-interrupted 写入经 dispatchRunTrigger
 * per-run 串行队列（冷路径同走队列——离线收编无并发竞争成本），scan/manifest
 * 走模块 journal 单写者域（与帧落账同源，证据面一致）；三面证据前置是入口裁决点
 * 的前置防御（跨进程防双帧），表内转移 fail-fast 让位（IllegalTransitionError →
 * skippedTerminal）是进程内第二道幂等。中断条目（status 'interrupted'）构造与
 * callCount 推导归 interruptRun 入口内聚——本函数只透传补写通道与载荷源。
 */
/**
 * [adoptInterruptedRun 拆分] 收编前置裁决（三面证据 + 坏链守卫）：
 * 返回 skipped* 让位理由；null = 前置全过、继续收编。lastEventAt 一并返回
 * （收编成功日志的静止锚点），前置不通过时为 undefined。
 */
async function precheckAdoption(
  runId: string,
  events: readonly WorkflowRunEvent[],
  state: ReturnType<typeof foldEvents>,
  opts: AdoptInterruptedRunOptions | undefined,
  journalDir: string | undefined,
): Promise<{ skipped: AdoptInterruptedRunOutcome; lastEventAt?: undefined } | { skipped: null; lastEventAt: number }> {
  // 三面证据（幂等第一道）：record fold 面（terminal 或已 interrupted 均跳过——
  // 重复收编让位）
  if (state.lifecycle === "terminal" || state.lifecycle === "interrupted") {
    return { skipped: "skippedTerminal" };
  }
  // manifest 面（活体物化但 record 已被裁的组合）。dir=""（测试 NoopJournal 防线
  // 形态）跳过 manifest 证据——帧面已由 scan 空流 skippedMissing 承接，与「零写域
  // 不做真目录读」红线一致。
  const manifestDir = resolveManifestDirForAdopt(journalDir);
  if (manifestDir !== undefined) {
    const existingManifest = await readRunTerminalManifest(manifestDir, runId);
    if (existingManifest !== null) return { skipped: "skippedTerminal" };
  }
  // 条目面（双面证据第二条——壳注入读面）
  if (opts?.hasSettledEntry !== undefined && (await opts.hasSettledEntry(runId))) {
    return { skipped: "skippedTerminal" };
  }
  // 坏链守卫：fold 停在 created（首帧损坏）时 run-interrupted 表外转移——保守跳过
  if (state.lifecycle === "created") return { skipped: "skippedBrokenChain" };
  return { skipped: null, lastEventAt: events[events.length - 1]!.ts };
}

export async function adoptInterruptedRun(
  runId: string,
  opts?: AdoptInterruptedRunOptions,
): Promise<AdoptInterruptedRunOutcome> {
  const now = opts?.now ?? Date.now();
  // journal 目录（决策 2 目录参数化）：per-call 显式目录优先，缺省 = 模块锚——
  // scan / manifest 证据面 / interruptRun dispatch 链三处统一按它解析。
  const journalDir = opts?.journalDir;
  const events = await scanRunEvents(runId, journalDir);
  if (events.length === 0) return "skippedMissing";
  if (opts?.activeRunIds?.has(runId)) return "skippedActive";
  // [D6(b) 唯一读口] fold 经 terminal-actions 共享读口（进程内检查点缓存）：
  // 收编链的全量重放结果进缓存，紧随的 interruptRun dispatch 链命中缓存直接
  // transition——同一次收编内同 runId 不再重折第二遍。
  const state = foldRunEventsToLifecycleState(runId, events);
  const precheck = await precheckAdoption(runId, events, state, opts, journalDir);
  if (precheck.skipped !== null) return precheck.skipped;
  // 幂等追加中断转移事件（[D15] 入口；workflowName 取 run-created 帧——中断条目
  // 的 scriptName 载荷，缺帧回落 runId）。Illegal = 并发收编/终局让位——抢先方已
  // 落帧，skippedTerminal 收敛。
  const created = events.find((e) => e.type === "run-created");
  const workflowName =
    created !== undefined && created.type === "run-created" ? created.workflowName : runId;
  const adopted = await interruptRun(runId, {
    errorCode: opts?.errorCode,
    reason: opts?.reason,
    journalDir,
    workflowName,
    appendInterruptedEntry: opts?.appendInterruptedEntry,
    now,
  });
  if (!adopted) return "skippedTerminal";
  logger.warn(
    `run registry: interrupted run adopted (runId=${runId}` +
      `${opts?.errorCode !== undefined ? `, errorCode=${opts.errorCode}` : ""}, ` +
      `lastEventAt=${new Date(precheck.lastEventAt).toISOString()}) — run-interrupted appended`,
  );
  return "adopted";
}

// ── [D9] abandon 全链移除 ─────────────────────────────────────
//
// abandonElapsedInterruptedRuns（interrupted 超放弃窗自动终局化）及其常量与 env
// 通道已整体删除（workflow-run-resume-revision D9）：7 天自动终局化会把「数天后
// 回来仍可 resume」的 run 判死，与裁决点 7「数据跟随 session 生命周期」正面冲突；
// 移除后 interrupted 的进入方收敛为两类——崩溃收编（recoverCrashedRuns 与
// startupSweep，经 D15 中断路）与 terminate 被动失联（D11，U2 接线）。词表成员
// interrupted_abandoned / idle-evicted 保留为只读历史帧解析成员（解析词表纪律，
// 无新写入方）。无主 run 的磁盘清理归裁决点 7 对账清理（persistence/
// run-state-evidence 维护轮族，引用集三代解析 + 宽限窗登记）。
