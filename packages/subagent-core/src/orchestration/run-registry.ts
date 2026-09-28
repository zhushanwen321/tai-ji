// src/orchestration/run-registry.ts
//
// Workflow run 注册表（D9-1）——D5 状态机的投影面。
//
// 为什么需要它：现状 run 状态判读只能读进程自写快照（state 文件末行 status），
// 进程死亡后快照永远停在 running（僵尸）——「状态字段不可信、靠 mtime 新鲜度」
// 的启发式时代由此而来。本模块把判读换轨到结构判据：注册表 = journal fold 的
// 投影，只消费 D5 事件流（不另立状态存储）——
// - 事件流正常推进（本进程活体持有）→ 活跃（lifecycle 对齐状态机 fold 终帧）；
// - run-settled 已落账 → 终局（outcome/errorCode 从事件与终局投影 manifest 读）；
// - 事件流停止（活体集未命中 = host-died 判据）→ interrupted（待恢复态，非
//   terminal——僵尸 running 构造性消除，恢复交互属运维裁决，本期只保证状态判读
//   正确）。
//
// 能力二：interrupted 放弃窗终局化（D5 转移表 interrupted × abandon-elapsed 行）
// ——超窗（缺省 7 天，env 可调低）后走收编入口（adoptInterruptedRun，W1 [D4]）：
// 幂等追加 run-settled(interrupted, interrupted_abandoned) 终态事件 + 物化 manifest（[W2 D3] outcome 四值裁决），
// journal 随之获清理资格（pruneTerminalRunFiles，file-run-store 单源）。
//
// 能力边界：终局证据三通道（journal 帧 / state 快照 / manifest）的角色与采信
// 顺序见 run-events.ts 文件头「终局证据读序」权威声明，此处不重复展开。journal
// 清理执行不落在本模块——已终局 run 的 state + journal 成对裁剪在
// pruneTerminalRunFiles（file-run-store.ts，与 cap/TTL 同一判定单元）；本模块
// 只负责让 interrupted「无悬挂态」。
//
// 层归属：Engine。依赖 run-events（状态机 + journal）与 manifest-store（终局投影
// 写面）；零时钟依赖进纯函数（now/windowMs 显式传参）。

import { readdir } from "node:fs/promises";

import { getLogger } from "../core/logger.ts";
import { readRunTerminalManifest } from "../execution/persistence/manifest-store.ts";
import {
  INITIAL_RUN_STATE,
  RUN_EVENT_JOURNAL_SUFFIX,
  IllegalTransitionError,
  foldRunEventFrames,
  type RunErrorCode,
  type RunEventJournal,
  type RunOutcome,
  type RunState,
  type WorkflowRunEvent,
} from "./run-events.ts";
// [W1 / D1] 收编追加的终态条目构造（字段集单源在 pump 的 v2 条目接驳段）。
// [W2/V1 D1] 收编追加的记录动作走 settleRunAccounting 终局记录原语（journal 帧 +
// manifest 两件单点）+ (outcome, errorCode) → DoneReason 联合派生单点；
// scan 走 pump 的 scanRunEvents（journal 单写者域——帧落账同域，证据面一致；
// ADR-0081 起 journal 目录支持 per-call 参数注入，缺省仍模块锚）。
import {
  buildWorkflowRecordSettledEntryData,
  runSettledOutcomeToDoneReason,
  runEventJournalDirOf,
  scanRunEvents,
  settleRunAccounting,
} from "./worker-message-pump.ts";

const logger = getLogger("run-registry");

// ── 投影（D9-1：注册表 = 状态机投影面）──────────────────────

/** 投影判读四相。 */
export type RunRegistryPhase =
  /** 无事件证据且无活体持有——run 从未落账（或 journal 已过保留期清理）。 */
  | "missing"
  /** 本进程活体持有（事件流正常推进）——lifecycle 对齐 fold 终帧。 */
  | "active"
  /** 终局（run-settled 已落账）——outcome 见 state.outcome。 */
  | "terminal"
  /** 事件流停止（活体集未命中 = host-died 判据）——待恢复态，非 terminal。 */
  | "interrupted";

/** run 注册表投影（单一推导点，无独立状态存储）。 */
export interface RunRegistryProjection {
  runId: string;
  /** D5 两维状态（fold 终帧；missing 时 = INITIAL_RUN_STATE）。 */
  state: RunState;
  /** 投影判读（见 {@link RunRegistryPhase}）。 */
  phase: RunRegistryPhase;
  /** 事件流最后活动时刻（journal 末帧 ts；空事件流 = undefined）。 */
  lastEventAt?: number;
  /**
   * 终局错误码（terminal 时）：优先取 run-settled 帧载荷（事件流权威），
   * 缺省 = 无结构化码（completed/cancelled 或旧帧形态）。
   */
  errorCode?: RunErrorCode;
}

/** 投影的活体判定输入（host-died 判据的互补面——活体集命中即未死）。 */
export interface RunProjectionOptions {
  /**
   * 本进程活体持有的 runId 集合（runs Map 的 key 视图）。缺省 = 空集（跨进程
   * 查询形态：journal fold 停在非 terminal 一律判 interrupted）。
   */
  activeRunIds?: ReadonlySet<string>;
}

/**
 * journal fold：scan 产物逐事件 transition（不传 ctx——run-events.ts fold 契约）。
 *
 * 循环体单源 run-events.ts 的 foldRunEventFrames（与 worker-message-pump.foldRunState
 * 共享同一坏帧失效模式：保守停在最近一致态）；本侧只持注册表域的 warn 文案与 logger。
 */
function foldEvents(events: readonly WorkflowRunEvent[], runId: string): RunState {
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
 * 判读规则（host-died 的投影语义）：
 * - fold terminal → terminal（errorCode 从 run-settled 帧）；
 * - fold 非 terminal + 活体集命中 → active（事件流正常推进）；
 * - fold 非 terminal + 活体集未命中 → interrupted（事件流停止 = 进程死亡判读；
 *   状态字段不可信——快照末行 running 的僵尸在此判读下构造性消失）；
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
      state: INITIAL_RUN_STATE,
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
  return {
    runId,
    state,
    phase: active ? "active" : "interrupted",
    ...(lastEventAt !== undefined ? { lastEventAt } : {}),
  };
}

/** 指定 run 的注册表投影（journal 读面入口——查询/对账消费形态）。 */
export async function projectRunRegistryState(
  journal: RunEventJournal,
  runId: string,
  opts?: RunProjectionOptions,
): Promise<RunRegistryProjection> {
  return projectRunRegistryEvents(await journal.scan(runId), runId, opts);
}

// ── [W1 / D4] 收编入口（「有注册无终态」实体的统一终局化路径）──────────────
//
// 设计 D4：恢复统一为「journal 重放 + 收编」，收编幂等追加终态事件——abandon
// （interrupted 超放弃窗）与壳 loadAll 的 kill-9 重启收编（批 2 接线）走同一
// 入口，证据落点对称消除（此前 abandon 只写 manifest、recoverCrashedRuns 旁路
// 直改 state 快照——两条恢复路径的终局证据落在不同介质）。
//
// 幂等机制（双重启不重复追加的构造性保证）：
// 1. 追加前查三面证据——journal fold 已 terminal / manifest 已在 / 主 session
//    终态条目已存在（hasSettledEntry 注入面）——任一命中即跳过（宁保留不重复：
//    重复追加 run-settled 会破坏「一个 run 恰好一帧」终态不变量）；
// 2. 幂等性由「fold 出的当前态是否已终态」判定——收编产物本身是 run-settled 帧，
//    下次重入被第 1 条拦截，journal 重放不随重启追加增长。

/** adoptInterruptedRun 的可调项。 */
export interface AdoptInterruptedRunOptions {
  /** 时钟注入（epoch ms）；缺省 Date.now()——终态 ts/settledAt 与宽限窗判定的确定性测试通道。 */
  now?: number;
  /**
   * 追加终态的 outcome；缺省 "interrupted"（[W2 D2/D3] 被动终局的唯一权威表达——
   * 崩溃收编 / abandon / idle 回收三路径写入；W1 过渡口径 "failed" 退役，细分
   * 语境由 errorCode 承载：interrupted_abandoned / idle-evicted）。
   */
  outcome?: RunOutcome;
  /** 终局编码（abandon 场景 = interrupted_abandoned；idle 回收 = idle-evicted；kill-9 即时收编缺省无码）。 */
  errorCode?: RunErrorCode;
  /** 终局 reason 文本（journal run-settled 帧 + 诊断面；缺省无 reason）。 */
  reason?: string;
  /**
   * 事件流静止宽限窗：末帧 ts 距 now 不足窗 → skippedGraceWindow（abandon 的放弃窗
   * 语义）。缺省 0 = 立即收编（kill-9 重启场景——活体集未命中的静止流即收编）。
   */
  graceWindowMs?: number;
  /**
   * journal 目录（ADR-0081 目录参数化）：runtime 侧启动扫描注入
   * ——调用进程 cwd/env 与落盘目录不相交，scanRunEvents / manifest 证据面 /
   * settleRunAccounting dispatch 链按它解析。缺省 = 模块锚
   * （resolvePiWorkflowStateDir 三层解析），pi 壳既有调用点零改动。
   */
  journalDir?: string;
  /** 活跃保护集（本进程活体 runId）——活跃 run 事件流静默不判死，永不收编。 */
  activeRunIds?: ReadonlySet<string>;
  /**
   * 主 session 终态条目证据面（双面证据第二条，D4）：返回 true = 条目已给出
   * 非 interrupted 终态 → 跳过收编追加（覆盖「journal 整文件损坏但终态条目完好」
   * 的极端组合——条目即终局证据，不追加 interrupted 与既有 done 条目构成两记录
   * 面矛盾）。壳批 2 注入条目读面；缺省 = 无条面证据（core 测试/纯 journal 形态）。
   */
  hasSettledEntry?: (runId: string) => boolean | Promise<boolean>;
  /** 终态条目幂等补写通道（收编追加成功后恰调一次；缺省 = 不写——壳注入 appendEntry 面）。 */
  appendSettledEntry?: (entry: ReturnType<typeof buildWorkflowRecordSettledEntryData>) => void;
}

/** adoptInterruptedRun 的判定结果分类。 */
export type AdoptInterruptedRunOutcome =
  /** 已追加 run-settled 并物化 manifest。 */
  | "adopted"
  /** 三面证据任一命中（journal terminal / manifest 在 / 条目在）——幂等跳过。 */
  | "skippedTerminal"
  /** 活跃保护跳过。 */
  | "skippedActive"
  /** 宽限窗未到（graceWindowMs 判定）。 */
  | "skippedGraceWindow"
  /** 坏链 run（fold 停在 created——run-created 帧损坏/缺首帧，run-settled 表外转移）。 */
  | "skippedBrokenChain"
  /** 空 journal（无事件证据——从未落账或已过保留期清理）。 */
  | "skippedMissing";

/** 收编 manifest 证据面目录（模块 journal 同源锚；`journalDir` = per-call 目录
 *  （决策 2——runtime 侧扫描注入，缺省模块锚）；测试防线形态返回 undefined）。 */
function resolveManifestDirForAdopt(journalDir?: string): string | undefined {
  return runEventJournalDirOf(journalDir);
}

/**
 * 单 run 收编：scan → fold → 三面证据 → （宽限窗）→ settleRunAccounting 原语
 * （幂等追加 run-settled + 物化 manifest 两件）→ 终态条目补写回调。
 *
 * [W2/V1 D1] 记录动作统一走终局记录原语：run-settled 写入经 dispatchRunTrigger
 * per-run 串行队列（冷路径同走队列——离线收编无并发竞争成本），scan/manifest
 * 走模块 journal 单写者域（与帧落账同源，证据面一致；journal 目录经 opts.journalDir
 * per-call 注入，ADR-0081——runtime 侧扫描形态，缺省模块锚）；三面证据
 * 前置是原语裁决点的前置防御（跨进程防双帧），表内转移 fail-fast 让位
 *（IllegalTransitionError → skippedTerminal）是进程内第二道幂等。
 * [W2 D3] outcome 缺省 "interrupted"（被动终局唯一权威表达）；条目 reason 经
 * (outcome, errorCode) 联合派生单点（D5 五处统一）。
 *
 * [W2 D3] abandon 注销差集——已接受代价登记（登记不修）：本收编链无注销通道
 * （收编产物 = journal 帧 + manifest 两件 + 可选终态条目，不含 pending:unregister），
 * 收编的是旧 session 的 run 时，旧 session 文件里的 pending:register 残留无直落
 * 写达域（注销条目只能落当前进程的 session 文件——对未注册该 run 的 session 无效）。
 * 已接受代价四要素：量级 = 每个永不重开的旧 session 至多多一行（有界）；后果 =
 * 该 session 的 pending-notifications 活跃列表多一行，仅在该 session 内的 pending
 * 工具查询可见，无跨 session 泄漏；恢复路径 = 宿主 session 重开即 reconcile-sweep
 * 依 journal fold / manifest 终态证据（D6 判据源改接后成立）补注销自愈；重审触发
 * 条件 = W4 终态同步复核时按 sweep 自愈覆盖率（journal 坏链等不可 fold 形态占比）
 * 重审。显式判定 = 可接受——为低频残留给本函数加「跨 session 定位旧 session 文件
 * 并写入」通道，是新增写路径与新的失败情形，收益不成比例（不采用）。
 */
export async function adoptInterruptedRun(
  runId: string,
  opts?: AdoptInterruptedRunOptions,
): Promise<AdoptInterruptedRunOutcome> {
  const now = opts?.now ?? Date.now();
  // journal 目录（决策 2 目录参数化）：per-call 显式目录优先，缺省 = 模块锚——
  // scan / manifest 证据面 / settleRunAccounting dispatch 链三处统一按它解析。
  const journalDir = opts?.journalDir;
  const events = await scanRunEvents(runId, journalDir);
  if (events.length === 0) return "skippedMissing";
  if (opts?.activeRunIds?.has(runId)) return "skippedActive";
  const state = foldEvents(events, runId);
  // 三面证据（幂等第一道）：journal fold 面
  if (state.lifecycle === "terminal") return "skippedTerminal";
  // manifest 面（abandon 旧路径写的 manifest / 活体物化但 journal 已被裁的组合）。
  // dir=""（测试 NoopJournal 防线形态）跳过 manifest 证据——帧面已由 scan 空流
  // skippedMissing 承接，与「零写域不做真目录读」红线一致。
  const manifestDir = resolveManifestDirForAdopt(journalDir);
  if (manifestDir !== undefined) {
    const existingManifest = await readRunTerminalManifest(manifestDir, runId);
    if (existingManifest !== null) return "skippedTerminal";
  }
  // 条目面（双面证据第二条——壳注入读面）
  if (opts?.hasSettledEntry !== undefined && (await opts.hasSettledEntry(runId))) {
    return "skippedTerminal";
  }
  // 宽限窗（abandon 放弃窗；缺省 0 = 立即收编）
  const lastEventAt = events[events.length - 1]!.ts;
  if (now - lastEventAt < (opts?.graceWindowMs ?? 0)) return "skippedGraceWindow";
  // 坏链守卫：fold 停在 created（首帧损坏）时 run-settled 表外转移——保守跳过
  if (state.lifecycle === "created") return "skippedBrokenChain";
  // 幂等追加终态事件 + 物化 manifest（原语两件单点；上方三面证据保证仅未终局
  // run 到此；Illegal = 并发收编让位——抢先方已落帧，skippedTerminal 收敛）。
  // workflowName 取 run-created 帧（缺帧回落 runId）。
  const outcome = opts?.outcome ?? "interrupted";
  const created = events.find((e) => e.type === "run-created");
  const workflowName =
    created !== undefined && created.type === "run-created" ? created.workflowName : runId;
  try {
    await settleRunAccounting(
      { runId },
      {
        outcome,
        ...(opts?.errorCode !== undefined ? { errorCode: opts.errorCode } : {}),
        ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
        settledAt: now,
      },
      { workflowName, journalDir },
    );
  } catch (err) {
    if (err instanceof IllegalTransitionError) return "skippedTerminal";
    throw err;
  }
  // 终态条目补写（收编场景无内存聚合——callCount 从 journal ask-settled 帧数
  // 推导；usedTokens 事件流不可得，摘要级 0 诚实缺省）。[W2 D5] reason 经联合
  // 派生单点（interrupted → "failed" 诊断兜底容器，细分语境由帧 errorCode 保留）。
  opts?.appendSettledEntry?.(
    buildWorkflowRecordSettledEntryData({
      runId,
      reason: runSettledOutcomeToDoneReason(outcome, opts?.errorCode),
      outcome,
      ...(opts?.errorCode !== undefined ? { errorCode: opts.errorCode } : {}),
      settledAt: now,
      callCount: events.filter((e) => e.type === "ask-settled").length,
      usedTokens: 0,
    }),
  );
  logger.warn(
    `run registry: interrupted run adopted (runId=${runId}, outcome=${outcome}` +
      `${opts?.errorCode !== undefined ? `, errorCode=${opts.errorCode}` : ""}, ` +
      `lastEventAt=${new Date(lastEventAt).toISOString()}) — run-settled appended, manifest written`,
  );
  return "adopted";
}

// ── interrupted 放弃窗终局化（D5 转移表 interrupted × abandon-elapsed 行）──

/** 放弃窗缺省值：7 天 = 604_800_000ms（D5 设计字面——任务级长跑 run 的保守放弃界）。 */
export const DEFAULT_RUN_ABANDON_WINDOW_MS = 604_800_000;

/**
 * 放弃窗 env 通道（测试期调低用；TAIJI_ 前缀理由对齐 STATE_TTL_MS_ENV——pi 进程
 * 内读的配置 env，桌面 spawn 链 ENV_WHITELIST_PREFIXES 只放行 TAIJI_ 等）：
 * - 未设/空 → 缺省 {@link DEFAULT_RUN_ABANDON_WINDOW_MS}；
 * - 有限正数 → 窗口 = env 值（测试期调低通道）；
 * - 非法值（非有限数/≤0）→ undefined = 不终局化（显式 opt-out，对齐 cap/TTL
 *   通道「意图不明不动磁盘」哲学）。
 */
export const RUN_ABANDON_WINDOW_MS_ENV = "TAIJI_WORKFLOW_RUN_ABANDON_WINDOW_MS";

/** 解析放弃窗；env 未设/空 → 缺省 7 天，显式非法/≤0 → undefined（不终局化）。 */
export function resolveRunAbandonWindowMs(): number | undefined {
  const raw = process.env[RUN_ABANDON_WINDOW_MS_ENV];
  if (raw === undefined || raw === "") return DEFAULT_RUN_ABANDON_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/** abandonElapsedInterruptedRuns 的可调项（全部可选——缺省即生产形态）。
 *  [W2/V1] journal/manifestDir 注入成员删除：收编记录动作统一走终局记录原语
 *  （模块 journal 单写者域），证据面与帧落账同源——注入面 = setRunEventJournalDirForTest
 *  （pump 测试钩子），目录参数只服务扫描候选列举。 */
export interface AbandonElapsedInterruptedRunsOptions {
  /** 时钟注入（epoch ms）；缺省 Date.now()——放弃窗判定的确定性测试通道。 */
  now?: number;
  /** 放弃窗（ms）；缺省 {@link resolveRunAbandonWindowMs}。 */
  abandonWindowMs?: number;
  /** 活跃保护集（本进程活体 runId）——活跃 run 事件流静默不判死，永不放弃。 */
  activeRunIds?: ReadonlySet<string>;
}

/** abandonElapsedInterruptedRuns 的执行结果（宿主日志/健康面用）。 */
export interface AbandonElapsedInterruptedRunsResult {
  /** 扫描的 journal 数（目录内 *.events.jsonl）。 */
  scanned: number;
  /** 本次终局化的 run 数（manifest 写入成功计数）。 */
  abandoned: number;
  /** 活跃保护跳过数。 */
  skippedActive: number;
  /** 已终局跳过数。 */
  skippedTerminal: number;
  /** 其余跳过（missing / 放弃窗未到 / 状态机拒绝的坏链 run）。 */
  skippedOther: number;
}

/**
 * 扫描 journal 目录，把「interrupted 且事件流停止超放弃窗」的 run 终局化
 * （D5 清理规则③：interrupted 超放弃窗由投影终局化，无悬挂态）。
 *
 * [W1 / D4] 每 run 的终局化改走收编入口（adoptInterruptedRun）：
 * 1. fold journal → 最后已知活体态（如 running）；
 * 2. 三面证据幂等检查（journal terminal / manifest / 终态条目——任一命中跳过）；
 * 3. 活跃保护 + 放弃窗判定（事件流最后活动时刻 ts——mtime 启发式退役后的时间
 *   判据唯一来源）；
 * 4. 幂等追加 run-settled(interrupted, interrupted_abandoned) 终态事件 + 物化
 *   manifest（outcome 非空 = prune 资格单源锚定，pruneTerminalRunFiles 按此
 *   资格判定自然兑现清理，无需单独的状态机输出动作）。
 *
 * 触发时机归调用方（生产接线：pi 宿主新 run 首写的 retention 维护轮，与
 * pruneTerminalRunFiles 同点）——本函数自身无副作用时钟，幂等可重入（已终局
 * run 命中 skippedTerminal）。
 *
 * 失败处置（辅助维护面降级，对齐 recoverCrashedRuns「单 run 失败不中断其余」）：
 * manifest 写失败 warn 留痕后继续下一个 run；坏链 run 的状态机拒绝同样跳过留痕。
 * 活跃 run 一律不放弃（事件流静默 ≠ 死亡，ADR-0047 同源纪律——放弃窗只作用于
 * 已失去活体持有的 run）。
 */
/** 单 run 的 abandon 判定结果分类（主循环计数归集用）。 */
type AbandonSingleRunOutcome = "abandoned" | "skippedActive" | "skippedTerminal" | "skippedOther";

/** abandonSingleRun 的执行上下文（主循环解析一次的常量面 + 活体集）。 */
interface AbandonSingleRunCtx {
  now: number;
  abandonWindowMs: number;
  activeRunIds?: ReadonlySet<string>;
}

/** 选项缺省解析集中点（主流程零缺省分支）。abandonWindowMs 由调用方先做 opt-out
 * 判定（undefined = 不终局化）后传入，此处收窄为必传。 */
function resolveAbandonOptions(
  opts: AbandonElapsedInterruptedRunsOptions | undefined,
  abandonWindowMs: number,
): AbandonSingleRunCtx {
  return {
    now: opts?.now ?? Date.now(),
    abandonWindowMs,
    activeRunIds: opts?.activeRunIds,
  };
}

/** readdir → journal runId 列表；目录不存在 / 读取失败（已 warn）返回 null = 空态。 */
async function listJournalRunIds(dir: string): Promise<string[] | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`run registry abandon: readdir ${dir} failed: ${
        err instanceof Error ? err.message : String(err)
      }`);
    }
    return null; // ENOENT = 从未有任何 run 落账，正常空态
  }
  return names
    .filter((n) => n.endsWith(RUN_EVENT_JOURNAL_SUFFIX))
    .map((n) => n.slice(0, -RUN_EVENT_JOURNAL_SUFFIX.length));
}

/**
 * 单 run 的 abandon 判定链（[W1 / D4] 改走收编入口 adoptInterruptedRun）：放弃窗
 * 判定 + 收编参数（[W2 D3] outcome=interrupted + errorCode=interrupted_abandoned
 * ——被动终局权威表达，细分语境由码承载）。分类结果由主循环计数；journal/manifest
 * IO 异常上抛，主循环统一 warn 留痕后继续。
 */
async function abandonSingleRun(runId: string, ctx: AbandonSingleRunCtx): Promise<AbandonSingleRunOutcome> {
  const adopted = await adoptInterruptedRun(runId, {
    now: ctx.now,
    outcome: "interrupted",
    errorCode: "interrupted_abandoned",
    reason: "interrupted run abandoned after grace window",
    graceWindowMs: ctx.abandonWindowMs,
    activeRunIds: ctx.activeRunIds,
  });
  switch (adopted) {
    case "adopted":
      return "abandoned";
    case "skippedActive":
      return "skippedActive";
    case "skippedTerminal":
      return "skippedTerminal";
    // missing（空 journal）/ broken-chain（坏链）/ grace-window（放弃窗未到）
    // 三类在 abandon 计数口径下同归 skippedOther
    default:
      return "skippedOther";
  }
}

export async function abandonElapsedInterruptedRuns(
  dir: string,
  opts?: AbandonElapsedInterruptedRunsOptions,
): Promise<AbandonElapsedInterruptedRunsResult> {
  const result: AbandonElapsedInterruptedRunsResult = {
    scanned: 0,
    abandoned: 0,
    skippedActive: 0,
    skippedTerminal: 0,
    skippedOther: 0,
  };
  const abandonWindowMs = opts?.abandonWindowMs ?? resolveRunAbandonWindowMs();
  if (abandonWindowMs === undefined) return result; // 显式 opt-out：不终局化
  const ctx = resolveAbandonOptions(opts, abandonWindowMs);

  const journalRunIds = await listJournalRunIds(dir);
  if (journalRunIds === null) return result;
  result.scanned = journalRunIds.length;

  for (const runId of journalRunIds) {
    try {
      // outcome 分类名与 result 计数字段名同构，直接索引计数
      result[await abandonSingleRun(runId, ctx)] += 1;
    } catch (err) {
      // 单 run 失败不中断整轮（含状态机拒绝——坏链 run 保守跳过，下轮重判）
      result.skippedOther += 1;
      logger.warn(
        `run registry abandon: skipped run ${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return result;
}
