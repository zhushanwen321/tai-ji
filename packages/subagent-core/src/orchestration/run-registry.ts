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
// ——超窗（缺省 7 天，env 可调低）后经状态机裁决走 host-died → abandon-elapsed
// 两步转移，写 manifest（outcome:failed + errorCode:interrupted_abandoned），
// journal 随之获清理资格（pruneTerminalRunFiles，file-run-store 单源）。
//
// 能力边界（D5 权威性分层）：journal 清理执行不落在本模块——已终局 run 的
// state + journal 成对裁剪在 pruneTerminalRunFiles（file-run-store.ts，与 cap/TTL
// 同一判定单元）；本模块只负责让 interrupted 「无悬挂态」。
//
// 层归属：Engine。依赖 run-events（状态机 + journal）与 manifest-store（终局投影
// 写面）；零时钟依赖进纯函数（now/windowMs 显式传参）。

import { readdir } from "node:fs/promises";

import { getLogger } from "../core/logger.ts";
import {
  readRunTerminalManifest,
  writeRunTerminalManifest,
} from "../execution/persistence/manifest-store.ts";
import {
  INITIAL_RUN_STATE,
  createRunEventJournal,
  transition,
  type RunErrorCode,
  type RunEventJournal,
  type RunState,
  type WorkflowRunEvent,
} from "./run-events.ts";

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
 * 与 worker-message-pump.foldRunState 同构（scan + 逐帧 transition + 坏帧 warn
 * 保守停）：受 Q2 领地边界约束（pump 唯一触碰区 = 引导补投删除区）未单源化，
 * 后续清理轮收口为共享实现。
 */
function foldEvents(events: readonly WorkflowRunEvent[], runId: string): RunState {
  let state = INITIAL_RUN_STATE;
  for (const event of events) {
    try {
      state = transition(state, event).state;
    } catch (err) {
      // journal 坏链（历史帧与当前表不兼容）：投影失效模式 = 保守停在最近一致态
      // （warn 留痕不炸投影），与 pump fold / scan 坏行容忍同一精神。
      logger.warn(
        `run registry fold stopped at a broken frame (runId=${runId}, lastType=${event.type}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      break;
    }
  }
  return state;
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

/** abandonElapsedInterruptedRuns 的可调项（全部可选——缺省即生产形态）。 */
export interface AbandonElapsedInterruptedRunsOptions {
  /** journal 读面；缺省 createRunEventJournal(dir)。测试注入 mkdtemp 目录形态。 */
  journal?: RunEventJournal;
  /** 终局投影 manifest 写入目录；缺省 = dir（journal/manifest/state 同目录布局）。 */
  manifestDir?: string;
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
 * 每 run 的状态机路径（全部经 transition 裁决，表外 fail-fast）：
 * 1. fold journal → 最后已知活体态（如 running）；
 * 2. 投影判定 host-died（活体集未命中）→ `host-died` 控制事件 → interrupted
 *   （outputs = registry-project，无 journal 追加——控制事件不落 journal）；
 * 3. `abandon-elapsed` → terminal(failed)（outputs = manifest-write +
 *   journal-cleanup-eligible）；
 * 4. 执行 manifest-write：writeRunTerminalManifest（outcome:failed +
 *   errorCode:interrupted_abandoned + workflowName 取 run-created 帧）。
 *   journal-cleanup-eligible 由 pruneTerminalRunFiles 的资格判定自然兑现
 *   （manifest outcome 非空即获资格），无需单独执行。
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
  const journal = opts?.journal ?? createRunEventJournal(dir);
  const manifestDir = opts?.manifestDir ?? dir;
  const now = opts?.now ?? Date.now();
  const abandonWindowMs = opts?.abandonWindowMs ?? resolveRunAbandonWindowMs();
  const activeRunIds = opts?.activeRunIds;
  if (abandonWindowMs === undefined) return result; // 显式 opt-out：不终局化

  const JOURNAL_SUFFIX = ".events.jsonl";
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`run registry abandon: readdir ${dir} failed: ${
        err instanceof Error ? err.message : String(err)
      }`);
    }
    return result; // ENOENT = 从未有任何 run 落账，正常空态
  }
  const journalRunIds = names
    .filter((n) => n.endsWith(JOURNAL_SUFFIX))
    .map((n) => n.slice(0, -JOURNAL_SUFFIX.length));
  result.scanned = journalRunIds.length;

  for (const runId of journalRunIds) {
    try {
      const events = await journal.scan(runId);
      if (events.length === 0) {
        result.skippedOther += 1; // 空 journal：无事件证据（missing），无从终局化
        continue;
      }
      const active = activeRunIds?.has(runId) ?? false;
      if (active) {
        result.skippedActive += 1;
        continue;
      }
      // 已终局跳过（D5 规则①单源锚定，幂等关键）：abandon 不落 journal 帧
      // （manifest-write 是唯一终局证据），重扫时 fold 仍停在 interrupted——
      // 已终局判定必须并读 manifest，否则每轮重复终局化写 manifest（幂等破坏）。
      // 坏链 fold 停在 created 但 manifest 已在的存量 run 同样在此保护。
      const existing = await readRunTerminalManifest(manifestDir, runId);
      let state = foldEvents(events, runId);
      if (state.lifecycle === "terminal" || existing !== null) {
        result.skippedTerminal += 1;
        continue;
      }
      // 投影判定 host-died（活体集未命中 + 事件流停止）→ interrupted
      state = transition(state, { type: "host-died" }).state;
      // 放弃窗判定锚 = 事件流最后活动时刻（事件自带 ts 信封——mtime 启发式退役后
      // 的时间判据唯一来源）
      const lastEventAt = events[events.length - 1]!.ts;
      if (now - lastEventAt < abandonWindowMs) {
        result.skippedOther += 1; // interrupted 但放弃窗未到——待恢复期
        continue;
      }
      // abandon-elapsed → terminal(failed)；输出动作 manifest-write 执行（
      // journal-cleanup-eligible 由 prune 资格判定读 manifest 自然兑现）
      const terminal = transition(state, { type: "abandon-elapsed" }).state;
      const created = events.find((e) => e.type === "run-created");
      const workflowName =
        created !== undefined && created.type === "run-created" ? created.workflowName : runId;
      await writeRunTerminalManifest(manifestDir, {
        id: runId,
        workflowName,
        outcome: terminal.outcome ?? "failed",
        errorCode: "interrupted_abandoned",
        settledAt: now,
      });
      result.abandoned += 1;
      logger.warn(
        `run registry: interrupted run abandoned after grace window (runId=${runId}, ` +
          `lastEventAt=${new Date(lastEventAt).toISOString()}, windowMs=${abandonWindowMs}) — ` +
          "manifest written with outcome=failed errorCode=interrupted_abandoned; journal is now cleanup-eligible",
      );
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
