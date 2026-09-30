// src/orchestration/terminal-actions.ts
//
// [D15] 终局编排单一入口（workflow-run-resume-revision）+ run 事件投递域（单写者链）。
//
// 两段结构（变化原因分层）：
// - §1 run 事件投递域：dispatchRunTrigger 唯一投递入口（journal 单写者纪律的物理
//   载荷）与 per-run 串行队列、活体态缓存、journal 目录解析、事件派发薄包装
//   （run-created / phase-* / agent-*）——自 worker-message-pump 迁入（pump 薄化为
//   「消息路由 + 重试矩阵」，[D15] 迁移附带投递域同走，保持 pump → 本文件单向依赖，
//   终态编排对投递链的调用不成环）；
// - §2 终局/中断编排入口：五路发起全部改经它——四路强制终局/中断路径（abortRun /
//   terminateRunningRuns / recoverCrashedRuns / startupSweep）+ 第五路正常终局链
//   （finalizeRun 自 worker-message-pump 收尾迁入，不是第六处新增）。入口内部统一
//   「目标态选择（terminal 四值终局 / interrupted 暂停）→ 转移事件落 record → 聚合
//   翻转 → 通知/收尾」；单写者纪律不变（内部仍经 dispatchRunTrigger）。
//
// 边界（[D15]）：resume 复活发起不是终局动作，在 resume-run.ts 锁段内自完成、不经
// 本入口（U2）；resumed run 的后续终局天然走本入口。

import { join } from "node:path";

import { getLogger } from "../core/logger.ts";

import { mapReasonToStatus, PENDING_UNREGISTER_ENTRY_TYPE } from "@zhushanwen/extension-protocol";

import { disposeWorkflowWindowEngineState } from "../execution/engine/routing.ts";
import { writeRunTerminalManifest } from "../execution/persistence/manifest-store.ts";
import { resolvePiWorkflowStateDir } from "../execution/assembly/workflow-state-root.ts";
import { clearMemberReusePool, type MemberReusePoolIo } from "./member-reuse-pool.ts";
import type { LifecycleDeps } from "./models/ports.ts";
import type { RunSpec } from "./models/run-spec.ts";
import type { WorkflowRun } from "./models/workflow-run.ts";
// [P1b-1] run 显式状态机（D5）：transition 纯函数 + record 事件流（run-events.ts
// 为唯一权威实装，本文件是其编排侧消费入口之一——journal 单写者纪律的物理载体）。
import {
  createRunEventJournal,
  doneReasonToRunOutcome,
  finalRunErrorCodeOf,
  foldRunEventFrames,
  IllegalTransitionError,
  INITIAL_RUN_STATE,
  RUN_EVENT_TYPES,
  RUN_EVENT_JOURNAL_SUFFIX,
  transition,
  type RunErrorCode,
  type RunEventJournal,
  type RunOutcome,
  type RunState,
  type TransitionContext,
  type TransitionResult,
  type TransitionTrigger,
  type WorkflowRunEvent,
  type WorkflowRunEventInput,
} from "./run-events.ts";
// [W1 / D1] v2 条目契约（两族小条目）：customType 同 v1（kind 判别），构造器与
// 写点在本文件（见「v2 条目接驳」段）。
import {
  WORKFLOW_RECORD_CUSTOM_TYPE,
  WORKFLOW_RECORD_ENTRY_VERSION,
  type WorkflowRecordRegisteredEntryData,
  type WorkflowRecordSettledEntryData,
} from "./workflow-record-entry.ts";
import type { AgentCall } from "./models/agent-call.ts";
import { canonicalJsonStringify } from "./canonical-json.ts";
import { toErrorMessage } from "../core/error-message.ts";
import { trySettleLegacyClosed } from "../execution/persistence/execution-record.ts";
import type { AgentResult as ExecutionAgentResult, ExecutionRecord } from "../execution/assembly/types.ts";
import type {
  AgentCallOpts,
  AgentResult,
  DoneReason,
  RunStatus,
} from "./models/types.ts";

const logger = getLogger("subagents");
const runEventLogger = getLogger("run-event-dispatch");

import {
  IN_FLIGHT_CALL_CANCELLED_MSG,
} from "./worker-message-pump-constants.ts";

// ══════════════════════════════════════════════════════════════
// §1 run 事件投递域（单写者链，自 worker-message-pump 迁入）
// ══════════════════════════════════════════════════════════════

/** run 事件 journal 词表集合（判别「触发事件是否本身落账」；词表 SSOT 在 run-events.ts）。 */
const JOURNAL_EVENT_TYPES: ReadonlySet<string> = new Set(RUN_EVENT_TYPES);

/** run-created 载荷 argsSummary 的截断上限（行内摘要的体积上限——摘要供展示/
 * 日志读面；args 全文随帧另落 args 字段，设计 §3.1 载荷表 run-created 行「args」）。 */
const RUN_ARGS_SUMMARY_MAX_CHARS = 256;

/** 本进程内 per-run 活体状态缓存（key = runId；terminal 即删）。 */
const liveRunStates = new Map<string, RunState>();

/** per-run 投递队列（串行化 dispatchRunTrigger——并发事件链的活体态读取必须串行，
 *  否则前一链 fold/引导挂起中、后链读到空 Map 各自补投造成状态分叉）。entry =
 *  永不 reject 的尾 promise（前链失败不阻塞后链）；terminal 时随活体态一并回收。 */
const runDispatchQueues = new Map<string, Promise<unknown>>();

function enqueueRunDispatch<T>(runId: string, task: () => Promise<T>): Promise<T> {
  const prev = runDispatchQueues.get(runId) ?? Promise.resolve();
  const next = prev.then(task, task);
  runDispatchQueues.set(runId, next.catch(() => {}));
  return next;
}

/** journal 实例缓存（按目录 keyed）与测试注入点（生产目录 = run store 旁
 *  workflow-state，惰性解析）。keyed 缓存（ADR-0081）：per-call
 *  目录参数化后同进程可并存多个目录的 journal 实例（runtime 启动扫描收编 ≠ pi 壳
 *  模块锚目录），单值缓存会让两目录互相踢缓存——Map 按目录各持一份，单写者纪律
 *  不受影响（同一 run 恒同目录）。 */
const journalCache = new Map<string, RunEventJournal>();
let runEventJournalDirForTest: string | undefined;
let noopJournalWarned = false;

/** 测试钩子：注入 journal 目录 + 清空活体态缓存与终局记录注册表（run-events.test
 *  同款 teardown 纪律；连带清按目录 keyed 的 journal 缓存——换目录注入即换实例）。 */
export function setRunEventJournalDirForTest(dir: string | undefined): void {
  runEventJournalDirForTest = dir;
  journalCache.clear();
  liveRunStates.clear();
  settledRunRecords.clear();
}

/**
 * 测试防线的 no-op journal：scan 恒空、append 零写（vitest 未显式注入目录时启用）。
 * append 仍返回含 seq 的完整事件（内存计数分配——接口契约「返回值 = 落盘事件」
 * 在零写形态下保持形状，调用链不需要感知防线）。
 */
class NoopRunEventJournal implements RunEventJournal {
  private seqCounter = 0;

  async append(_runId: string, event: WorkflowRunEventInput): Promise<WorkflowRunEvent> {
    this.seqCounter += 1;
    return { ...event, seq: this.seqCounter } as WorkflowRunEvent;
  }

  async scan(): Promise<readonly WorkflowRunEvent[]> {
    return [];
  }
}

/** 按目录取（惰性创建）journal 实例（keyed 缓存单点）。 */
function journalForDir(dir: string): RunEventJournal {
  let journal = journalCache.get(dir);
  if (journal === undefined) {
    journal = createRunEventJournal(dir);
    journalCache.set(dir, journal);
  }
  return journal;
}

/**
 * journal 目录解析（ADR-0081 目录参数化）：显式 `journalDir`
 * 优先（runtime 侧收编链注入——调用进程 cwd/env 与落盘目录不相交的形态，目录
 * 即权威）；缺省 = 模块锚三层解析（测试注入 / vitest 防线 / 生产推导），pi 壳
 * 既有调用点零改动。显式目录不受 VITEST 防线拦截（与 setRunEventJournalDirForTest
 * 同信任级——显式注入即显式落点，红线护的是「未注入却落到真实推导路径」）。
 */
function resolveRunEventJournal(journalDir?: string): { dir: string; journal: RunEventJournal } {
  if (journalDir !== undefined) {
    return { dir: journalDir, journal: journalForDir(journalDir) };
  }
  if (runEventJournalDirForTest !== undefined) {
    return { dir: runEventJournalDirForTest, journal: journalForDir(runEventJournalDirForTest) };
  }
  // 测试防线（「测试禁止触碰真实数据目录」红线）：vitest 环境未显式注入目录时禁写
  // 真实推导路径——落 no-op journal + 一次性 warn 留痕。生产（无 VITEST env）不受
  // 影响；断言 record 流的测试必须显式 setRunEventJournalDirForTest(mkdtemp 目录)。
  if (process.env.VITEST === "true") {
    if (!noopJournalWarned) {
      noopJournalWarned = true;
      runEventLogger.warn(
        "run-event journal disabled: vitest env without setRunEventJournalDirForTest(dir) — " +
          "no-op journal active (prevents writes to the real workflow-state dir)",
      );
    }
    return { dir: "", journal: new NoopRunEventJournal() };
  }
  const dir = resolvePiWorkflowStateDir();
  return { dir, journal: journalForDir(dir) };
}

/** record 流 fold：scan + 逐事件 transition（不传 ctx——run-events.ts fold 契约；
 *  journalDir = dispatch 源携带的 per-call 目录，缺省模块锚）。 */
async function foldRunState(runId: string, journalDir?: string): Promise<RunState> {
  const { journal } = resolveRunEventJournal(journalDir);
  const events = await journal.scan(runId);
  return foldRunEventFrames(events, (err, lastType) => {
    // record 流坏链（历史帧与当前表不兼容）：投影失效模式 = 保守停在最近一致态
    // （warn 留痕不炸链），与 scan 侧坏行容忍同一精神。
    runEventLogger.warn(
      `run-event record fold stopped at a broken frame (runId=${runId}, lastType=${lastType}): ${toErrorMessage(err)}`,
    );
  });
}

/**
 * run record 事件流文件绝对路径（record/manifest 同一解析源：生产推导
 * resolvePiWorkflowStateDir，测试经 setRunEventJournalDirForTest 注入）。
 *
 * [W1 / D1] v2 注册条目的 journalPath 锚点字段经本函数寻址（lifecycle.runWorkflow
 * 写注册条目时消费）——锚点与 record 实写面同源，防条目指向漂移。vitest 无注入
 * 防线（dir=""）下返回 undefined = 锚点不可寻址，调用方据此跳过条目写（禁触真实
 * 数据目录红线，与 no-op journal 同一防线语义）。
 */
export function runEventJournalPathOf(runId: string): string | undefined {
  const { dir } = resolveRunEventJournal();
  if (dir === "") return undefined;
  return join(dir, `${runId}${RUN_EVENT_JOURNAL_SUFFIX}`);
}

/**
 * run record 事件流 / manifest 同目录锚（[W2/V1] 收编原语的 manifest 证据面读点；
 * `journalDir` = per-call 目录（决策 2 收编链注入，缺省模块锚）；测试防线
 * （NoopJournal 形态 dir=""）返回 undefined——零写域不做真目录读）。
 */
export function runEventJournalDirOf(journalDir?: string): string | undefined {
  const { dir } = resolveRunEventJournal(journalDir);
  return dir === "" ? undefined : dir;
}

/** [U4] run record 事件流只读访问器（成员复用绑定 fold 重建的读通道，决策 9 →
 *  [D6] 绑定字段查询辅助）——池侧不自建 journal 实例，防绕过本文件的单写者纪律
 *  与 no-op 测试防线。`journalDir` = per-call 目录（runtime 侧收编扫描注入，缺省
 *  模块锚）。 */
export async function scanRunEvents(runId: string, journalDir?: string): Promise<readonly WorkflowRunEvent[]> {
  const { journal } = resolveRunEventJournal(journalDir);
  return journal.scan(runId);
}

/** [U4 → D6] 成员绑定面的 record 读注入面（生产装配单点——append 通道随
 *  member-pool 词表成员删除，绑定落账归 agent-started 帧由 dispatchAgentCall 链
 *  承载）。 */
export const memberReusePoolIo: MemberReusePoolIo = {
  scanEvents: (runId) => scanRunEvents(runId),
};

/**
 * journal-append 输出对应的事件本体：触发事件属 journal 词表 → 事件本身；控制事件
 * 触发的终局转移 → 合成 run-settled（run-events.ts 输出动作注释约定——当前唯一合法
 * 控制终局 = cancel-requested）。ts 信封在合成时打点（transition 纯函数契约：
 * 时钟归调用侧）；seq 由 journal.append 分配（入参即 input 形态）。
 */
function journalEventOf(trigger: TransitionTrigger, journalDir?: string): WorkflowRunEventInput {
  if (JOURNAL_EVENT_TYPES.has(trigger.type)) {
    return trigger as WorkflowRunEventInput;
  }
  if (trigger.type === "cancel-requested") {
    return {
      type: "run-settled",
      outcome: "cancelled",
      ...(trigger.reason !== undefined ? { reason: trigger.reason } : {}),
      artifactsDir: resolveRunEventJournal(journalDir).dir,
      ts: Date.now(),
    };
  }
  throw new Error(
    `控制事件 ${trigger.type} 的转移输出含 journal-append 但无合成规则` +
      "（当前唯一合法控制终局 = cancel-requested）——修 RUN_TRANSITIONS 该行或 journalEventOf。",
  );
}

/**
 * 终局触发的进程内终局记录投影（appendTransition terminal 落账时 note 进注册表）。
 * run-settled 帧载荷直取（ts 用帧信封打点）；cancel-requested 合成路径 ts 现钟
 * （信封打点归调用侧——与 journalEventOf 的合成打点同一时点语义）。
 */
function settlementRecordOfTrigger(trigger: TransitionTrigger, next: RunState): RunSettlementRecord {
  if (trigger.type === "run-settled") {
    return {
      outcome: trigger.outcome,
      ...(trigger.errorCode !== undefined ? { errorCode: trigger.errorCode } : {}),
      ...(trigger.reason !== undefined ? { reason: trigger.reason } : {}),
      settledAt: trigger.ts,
    };
  }
  return {
    outcome: next.outcome ?? "cancelled",
    ...(trigger.type === "cancel-requested" && trigger.reason !== undefined
      ? { reason: trigger.reason }
      : {}),
    settledAt: Date.now(),
  };
}

async function appendTransition(
  run: RunDispatchSource,
  state: RunState,
  trigger: TransitionTrigger,
  ctx?: TransitionContext,
  journalDir?: string,
): Promise<TransitionResult> {
  const { state: next, outputs } = transition(state, trigger, ctx);
  // 活体态先于 record（内存权威先推进；取证证据随后落盘）。terminal 删条目 =
  // 「终局后停止 append」的第一道守卫（第二道 = 表 terminal × 任意事件 fail-fast）；
  // 投递队列条目同批回收（终局后该 run 无合法后续投递）。[W2/V1] 终局记录同步
  // note 进进程内注册表（isRunSettled / settledRecordOf 的判定与派生源）。
  // interrupted 是暂停态非终局——条目保留（后续 run-resumed/run-settled 仍合法）。
  if (next.lifecycle === "terminal") {
    liveRunStates.delete(run.runId);
    runDispatchQueues.delete(run.runId);
    settledRunRecords.set(run.runId, settlementRecordOfTrigger(trigger, next));
  } else {
    liveRunStates.set(run.runId, next);
  }
  if (outputs.includes("journal-append")) {
    const { journal } = resolveRunEventJournal(journalDir);
    await journal.append(run.runId, journalEventOf(trigger, journalDir));
  }
  // [P1b-2] manifest-write 终局投影：manifest（<runId>.json）落 outcome/errorCode
  //（D5-④ 输出动作统一——执行面收口在本函数，persistTerminalProjection）。
  // run-interrupted/run-resumed 行 outputs 无 manifest-write——中断/复活非终局，
  // 不写派生缓存（[D2] interrupted 非终局 + [D1] manifest 降格派生缓存）。
  if (outputs.includes("manifest-write")) {
    const projectionDir = resolveRunEventJournal(journalDir).dir;
    if (projectionDir === "") {
      // 测试防线（与 no-op journal 同族）：vitest 无注入时禁写真实目录——同步 warn
      // 后跳过，不进入 async 调用（await 边沿会把终局 coda 尾链推出既有测试的
      // flushMicrotasks 固定 tick 窗口，无注入测试的时序须与 P1b-1 基线逐位同构）。
      runEventLogger.warn(
        "run terminal projection skipped: vitest env without setRunEventJournalDirForTest(dir) — " +
          "manifest not written (prevents writes to the real workflow-state dir)",
      );
    } else {
      await persistTerminalProjection(run, next, trigger, projectionDir, journalDir);
    }
  }
  return { state: next, outputs };
}

/**
 * manifest-write 输出动作的执行面（[P1b-2] D5 终态投影）：
 * manifest = `<workflow-state>/<runId>.json`（「已终局」单源锚定 = outcome 非空，
 * [D1] 后降格为 run-settled 事件的派生缓存——保留清理加速判定与诊断的可寻址落点）。
 *
 * errorCode 取自 run-settled 事件载荷（失败终局的结构化码）；cancel-requested
 * 合成路径无结构化码（缺省）。
 * [D5 诊断引用落账] stderrTeePath（失败终局）取自 record 流最后一帧带该字段的
 * agent-settled（lastStderrTeePathFromRecord——事件流投影，见其注释）。
 *
 * 目录解析复用 journal 同源（resolveRunEventJournal——生产推导
 * resolvePiWorkflowStateDir，测试经 setRunEventJournalDirForTest 注入一次覆盖
 * record/manifest 两面）；vitest 无注入防线（dir=""）下跳过写入并 warn
 * 留痕（禁触真实数据目录红线，与 no-op journal 同一防线语义）。
 *
 * 失败处置 = error 留痕不抛（对齐 record 侧「取证面失败不阻断 coda」：终局
 * coda 的权威推进不因投影 IO 中断；manifest 缺失的下游语义 = 清理判定保守不裁）。
 */
async function persistTerminalProjection(
  run: RunDispatchSource,
  state: RunState,
  trigger: TransitionTrigger,
  dir: string,
  journalDir?: string,
): Promise<void> {
  const outcome = state.outcome;
  if (outcome === undefined) {
    // transition 构造性保证 terminal ⟹ outcome（run-events.ts）；缺省 = 编程错误，
    // 防御性留痕后跳过（不写半截投影）。
    runEventLogger.error(
      `manifest-write output on non-terminal state (runId=${run.runId}) — skipping projection (check RUN_TRANSITIONS terminal rows)`,
    );
    return;
  }
  if (run.spec === undefined) {
    // spec 缺省 = runId 键投递。合法形态 = 终局记录原语的冷路径收编（runId 键投递，
    // workflowName 载荷由调用方从 run-created 帧取后补写 manifest）。不伪造空名落
    // manifest（manifest 是「已终局」锚定，写坏即污染清理资格判定）——debug 留痕
    // 后跳过，manifest 半边由原语承接。
    runEventLogger.debug(
      `run terminal manifest write on a spec-less run dispatch source (runId=${run.runId}) — ` +
        "cold-path adoption dispatch: manifest is written by settleRunAccounting (workflowName from run-created frame)",
    );
    return;
  }
  const errorCode: RunErrorCode | undefined =
    trigger.type === "run-settled" ? trigger.errorCode : undefined;
  // [D5 诊断引用落账 / D2 time_limited 升格连带] failed 与 time_limited 两值终局
  // 才投影取证指针（成功/cancelled 不写——字段语义与 AgentSettledEvent.stderrTeePath
  // 的失败伴随纪律一致）；time_limited 采集保留 = 设计 D2 词表变更登记第 3 条
  // （「超时也可能是引擎卡死，stderr 采集保留」——升格前超时是 failed 终局有
  // 采集，升格不回退证据通道，「脚本慢」与「引擎卡死超时」在 manifest 面可区分）。
  const stderrTeePath =
    outcome === "failed" || outcome === "time_limited"
      ? await lastStderrTeePathFromRecord(run.runId, journalDir)
      : undefined;
  const settledAt = Date.now();
  try {
    await writeRunTerminalManifest(dir, {
      id: run.runId,
      workflowName: run.spec.scriptName,
      outcome,
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(stderrTeePath !== undefined ? { stderrTeePath } : {}),
      settledAt,
    });
  } catch (err) {
    runEventLogger.error(
      `run terminal manifest write failed (runId=${run.runId}): ${toErrorMessage(err)}`,
    );
  }
}

/**
 * [D5 诊断引用落账] manifest 终局诊断引用（stderrTeePath）的取值源：record 流中
 * 最后一帧携带 stderrTeePath 的 agent-settled（事件流投影——D6「权威在事件流」
 * 同款推导纪律：agent 级取证指针已随 agent-settled 落账（dispatchAgentSettled
 * 填充），终局投影从事件流读回，不引入第二写点、不扩 run-settled 载荷）。record
 * 读取失败（IO 异常）降级为 undefined 并 error 留痕——取证引用缺失不阻断终局投影
 * （manifest 的 outcome/errorCode 权威面独立于本字段）。多 call run 下的取值是
 * 「最后一帧带路径」的时序近似而非归因权威：脚本吞掉早先 call 失败后自身错误
 * 终局时，本字段可能指向与终局无关的 call 的 tee（结构性精确不可得——run-settled
 * 载荷无 call 关联键，词表边界见 D5 表）；单 call 失败（主流场景）精确。
 */
async function lastStderrTeePathFromRecord(runId: string, journalDir?: string): Promise<string | undefined> {
  try {
    const { journal } = resolveRunEventJournal(journalDir);
    const events = await journal.scan(runId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === "agent-settled" && event.stderrTeePath !== undefined) {
        return event.stderrTeePath;
      }
    }
    return undefined;
  } catch (err) {
    runEventLogger.error(
      `run terminal manifest stderrTeePath derivation failed (runId=${runId}): ${toErrorMessage(err)}`,
    );
    return undefined;
  }
}

/**
 * dispatchRunTrigger 的投递源投影面：WorkflowRun 聚合根结构满足（runId + spec 公有
 * 字段，存量调用方零改动）。runId 键投递（冷路径收编）只带 runId；spec 缺省形态下
 * terminal 投影无 workflowName 载荷源（persistTerminalProjection 守卫跳过）——
 * manifest 半边由冷路径调用方承接（settleRunAccounting / interruptRun 的
 * workflowName 参数）。
 */
export interface RunDispatchSource { // oe-exempt:20260929:framework:dispatch source contract per design D15
  runId: string;
  /** terminal 投影（manifest workflowName）的载荷源；runId 键投递（冷路径）可缺省。 */
  spec?: RunSpec;
  /**
   * 本投递的 journal 目录锚（ADR-0081 目录参数化）：dispatch 链
   * （fold / 帧落账 / manifest 投影）按它解析 journal 目录。runtime 侧冷路径收编
   * 注入（调用进程 cwd/env 与落盘目录不相交）；缺省 = 模块锚（活体链既有调用点
   * 零改动）。安全性：per-run 投递队列按 runId 串行 + 同一 run 恒同目录——per-call
   * 目录不破坏「事件 record 序 = 调用序」的单写者纪律。
   */
  journalDir?: string;
}

/**
 * run 事件投递唯一入口（单写者纪律：record 流的全部写入经本函数；引擎/worker 不落账，
 * D5「单写者 = 宿主侧唯一编排点」）。裁决 = transition 纯函数；表外转移抛
 * IllegalTransitionError 由调用方分类处置（让位 = 并发终局/中断后的预期迟到事件）。
 * per-run 投递队列串行化（并发事件链的活体态读取竞态防线——事件 record 序 =
 * 调用序）。
 *
 * run-created 无引导补投（Q2 正点接线后的终态）：record 流首帧唯一落点 =
 * {@link dispatchRunCreated}（lifecycle.runWorkflow 宿主派发点调用）。事件到达时
 * fold 出 running（record 无 run-created 帧）⟹ 表外转移 fail-fast——事件在
 * run-created 落账前到达是接线错误，靠引导静默补齐会掩盖时序倒置。
 */
export function dispatchRunTrigger(
  run: RunDispatchSource,
  trigger: TransitionTrigger,
  ctx?: TransitionContext,
): Promise<TransitionResult> {
  return enqueueRunDispatch(run.runId, () => dispatchRunTriggerInner(run, trigger, ctx));
}

async function dispatchRunTriggerInner(
  run: RunDispatchSource,
  trigger: TransitionTrigger,
  ctx?: TransitionContext,
): Promise<TransitionResult> {
  let state = liveRunStates.get(run.runId);
  if (state === undefined) state = await foldRunState(run.runId, run.journalDir);
  return appendTransition(run, state, trigger, ctx, run.journalDir);
}

/** 投递失败的分类留痕：Illegal = 并发终局/中断后的预期迟到事件（M12 同语义，debug）；
 *  其余（IO 等）= error 响亮（record 流是取证面，静默丢失 = 事故不可诊断）。 */
function reportDispatchFailure(runId: string, err: unknown): void {
  if (err instanceof IllegalTransitionError) {
    runEventLogger.debug(
      `run event dispatch yielded (runId=${runId}): ${toErrorMessage(err)}`,
    );
    return;
  }
  runEventLogger.error(
    `run event dispatch failed (runId=${runId}): ${toErrorMessage(err)}`,
  );
}

/**
 * `run-created` 正点发射（record 流首帧，Q2 接线后的终态）。生产调用点唯一 =
 * lifecycle.runWorkflow 宿主派发点；入队先于 worker 启动（enqueueRunDispatch 同步
 * 入队 + 队列执行序 = 入队序——worker 首个 agent() 的 agent-started 帧必然排在
 * created 之后，竞态丢帧结构性消除），落账完成的 await 由调用方持有（「runWorkflow
 * 返回 ⟹ 投影可查」）。载荷 runId/scriptName/args/model 全部同源自 run.spec。
 * 重复调用 = running × run-created 表外转移 fail-fast（IllegalTransitionError），
 * 构造性排除双帧。
 */
export function dispatchRunCreated(run: WorkflowRun): Promise<TransitionResult> {
  // [W2/V1] 活体态同步 seed（created 基线，条件式）：runWorkflow 返回前
  // liveRunStates 必命中——isRunSettled 的「miss = 已终局」单向判定由此消除创建
  // 窗口假阳性（run 刚启动的窗口不会误判已终局）。
  // 条件式双守卫（防双帧不变量优先）：
  // - liveRunStates 已命中（重复发射/活体推进中）→ 不覆写——队列任务从现态
  //   fold，重复 run-created 保持表外 fail-fast（单终局/单首帧不变量）；
  // - 终局记录注册表已命中（终局后重复发射）→ 不 seed——队列任务 liveRunStates
  //   miss → fold record → terminal × run-created 表外 fail-fast。
  if (!liveRunStates.has(run.runId) && !settledRunRecords.has(run.runId)) {
    liveRunStates.set(run.runId, INITIAL_RUN_STATE);
  }
  return dispatchRunTrigger(run, {
    type: "run-created",
    runId: run.runId,
    workflowName: run.spec.scriptName,
    // [D1] record 单源存储收敛：scriptSource 全文唯一落点 = 本帧（快照已删）——
    // resume 的确定性重放（rebuildRunFromRecord / D13 嵌套检测）依赖此字段
    scriptSource: run.spec.scriptSource,
    // args 全文（设计 §3.1 载荷表 run-created 行「args」）：D14 逐字段深度比对与
    // resume 重放的 $ARGS 恢复依赖完整 args——argsSummary 截断摘要只覆盖小 args
    // 的未截断形态，截断即两处读面退化（比对拒绝 / $ARGS 回落 {}）。
    args: run.spec.args,
    argsSummary: summarizeRunArgs(run.spec.args),
    // scriptPath 锚定（worker 沙箱相对 require 的目录来源）：空值不落字段——
    // 读侧对缺失回落空串（旧格式行），与 model 同款条件式
    ...(run.spec.scriptPath ? { scriptPath: run.spec.scriptPath } : {}),
    ...(run.spec.model !== undefined ? { model: run.spec.model } : {}),
    ts: Date.now(),
  });
}

function summarizeRunArgs(args: Record<string, unknown>): string {
  const serialized = JSON.stringify(args);
  return serialized.length > RUN_ARGS_SUMMARY_MAX_CHARS
    ? `${serialized.slice(0, RUN_ARGS_SUMMARY_MAX_CHARS)}…`
    : serialized;
}

/** `phase-started` 落账（[D3] phase 状态机转移事件；壳侧承接 worker 的 phase()
 * 切换消息——worker-script-builder 模板 postMessage 通道）。 */
export function dispatchPhaseStarted(run: WorkflowRun, phase: string): void {
  void dispatchRunTrigger(run, {
    type: "phase-started",
    phase,
    ts: Date.now(),
  }).catch((err: unknown) => reportDispatchFailure(run.runId, err));
}

/**
 * `phase-settled` 落账（[D3] phase 内全部 call 落定的转移事件；壳侧判定——
 * dispatchAgentSettled 落账链内按 phase 归属聚合判定，见 phaseSettlementTracker）。
 */
export function dispatchPhaseSettled(run: WorkflowRun, phase: string): void {
  void dispatchRunTrigger(run, {
    type: "phase-settled",
    phase,
    ts: Date.now(),
  }).catch((err: unknown) => reportDispatchFailure(run.runId, err));
}

// ── [D3] phase 收束账本（phase-settled 判定的过程内状态）─────────

/**
 * phase 归属 → 已派发/已落定 call 计数的过程内账本（[D3] phase-settled 落账判定）：
 * notePhaseDispatched 记账派发（pump dispatchAgentCall 消费）、settlePhaseLedger
 * 记账落定（pump settlePhaseIfComplete 消费）；某 phase 的全部已派发 call 落定即
 * 清账（消费方据此落 phase-settled 帧）。按 runId 分区（Map<runId, Map<phase,
 * {dispatched, settled}>>），run 级条目在 finalizeRun / interruptRun 经
 * forgetPhaseSettlement 回收——未收束 phase 的条目无人清账（run 终局后不再有
 * call 落定），回收缺失即 runId 键泄漏。进程内过程状态，崩溃即失——phase-settled
 * 的权威重建归 fold 自愈与 resume 重放。
 */
const phaseSettlementTracker = new Map<string, Map<string, { dispatched: number; settled: number }>>();

function phaseEntryOf(runId: string, phase: string): { dispatched: number; settled: number } {
  let byPhase = phaseSettlementTracker.get(runId);
  if (byPhase === undefined) {
    byPhase = new Map();
    phaseSettlementTracker.set(runId, byPhase);
  }
  let entry = byPhase.get(phase);
  if (entry === undefined) {
    entry = { dispatched: 0, settled: 0 };
    byPhase.set(phase, entry);
  }
  return entry;
}

/**
 * [D3] 派发记账半边：显式 phase（非 undefined/空串）才入账——phase-settled 只对
 * 显式 phase 落账，无 phase 归属的 call 不影响任何账本。
 */
export function notePhaseDispatched(runId: string, phase: string | undefined): void {
  if (phase === undefined || phase === "") return;
  phaseEntryOf(runId, phase).dispatched += 1;
}

/**
 * [D3] 落定记账半边：settled 计数 +1，追平 dispatched 即清账（phase 条目删除；
 * run 级 Map 空则连 runId 键删除）并返回 true——消费方据此落 phase-settled 帧
 * （同 phase 重启新一轮由后续派发重建条目）。无条目（未入账的 phase）返回 false。
 */
export function settlePhaseLedger(runId: string, phase: string | undefined): boolean {
  if (phase === undefined || phase === "") return false;
  const byPhase = phaseSettlementTracker.get(runId);
  const entry = byPhase?.get(phase);
  if (entry === undefined) return false;
  entry.settled += 1;
  if (entry.settled < entry.dispatched) return false;
  byPhase?.delete(phase);
  if (byPhase !== undefined && byPhase.size === 0) phaseSettlementTracker.delete(runId);
  return true;
}

/** [D3] 测试清理钩子：清空 phase 收束账本（与 resetMemberReusePoolsForTest 同域）。 */
export function resetPhaseSettlementTrackerForTest(): void {
  phaseSettlementTracker.clear();
}

/**
 * run 级回收（finalizeRun 终局路径 / interruptRun 中断完成路径接线——与
 * clearMemberReusePool 同域终局清理）：删除该 run 的全部 phase 记账条目。条目
 * lazily 重建——interrupted run resume 后的新派发经 notePhaseDispatched 自建，
 * 回收只防 runId 键泄漏、无正确性影响。
 */
export function forgetPhaseSettlement(runId: string): void {
  phaseSettlementTracker.delete(runId);
}

/** `agent-started` 落账（脚本 agent() 调用已派发，[D4] 对齐 pi agent_start；attempt
 *  恒 1——重试在 executeAgentCall 内部递归，attempt 递增随终局帧的 call.attempts
 *  落账）。phase = agent-call 消息携带的剧本归属（[D3] call 归属快照）——
 *  undefined/空串（未标注剧本）时不写字段。memberRecordId = 绑定的子代理 record
 *  id（[D6] 绑定字段化承载——续写帧携带，首派缺省）。opts = resolveAgentOpts
 *  规范化后的完整入参（canonical 序列化随帧落账——设计 §3.1 载荷表 agent-started
 *  行「入参」；resume 重建回放集 call 的 opts 恢复源，detectReplayInputMismatch
 *  的输入一致性比对由此可比）。 */
export function dispatchAgentStarted(
  run: WorkflowRun,
  callId: number,
  agentName: string,
  phase?: string,
  memberRecordId?: string,
  opts?: AgentCallOpts,
): void {
  void dispatchRunTrigger(run, {
    type: "agent-started",
    taskIndex: callId,
    agentName,
    attempt: 1,
    ...(phase ? { phase } : {}),
    ...(memberRecordId !== undefined ? { memberRecordId } : {}),
    ...(opts !== undefined ? { input: canonicalJsonStringify(opts) } : {}),
    ts: Date.now(),
  }).catch((err: unknown) => reportDispatchFailure(run.runId, err));
}

/** `agent-settled` 落账（引擎终态应答：call.result；attempt = call.attempts 终局尝试
 *  序号；signal abort = agent 粒度 cancelled——run 中止连带在途 agent 终止）。
 *  [D5 诊断引用落账] 失败时从 result.stderrTeePath 填充取证文件指针（成功/cancelled
 *  不带）。 */
export function dispatchAgentSettled(run: WorkflowRun, call: AgentCall, aborted: boolean): void {
  const result = call.result;
  if (!result) {
    // [加固] 防御分支出声（原静默 return）：done ⟹ result 契约被破坏（agent-started
    // 已落账而 settled 结果缺失），record 流出现无 agent-settled 尾的悬空 call 序列——warn 留锚点。
    runEventLogger.warn(
      `agent-settled dropped: agent-started journaled but settled result missing ` +
        `(runId=${run.runId}, callId=${call.id}, status=${call.status})`,
    );
    return;
  }
  const outcome: RunOutcome = aborted ? "cancelled" : result.error === undefined ? "done" : "failed";
  const errorCode: RunErrorCode | undefined =
    outcome === "failed" ? (result.failureKind ?? "unknown") : undefined;
  const stderrTeePath = outcome === "failed" ? result.stderrTeePath : undefined;
  void dispatchRunTrigger(run, {
    type: "agent-settled",
    taskIndex: call.id,
    attempt: call.attempts,
    outcome,
    // [D1] record 单源存储收敛：result 全文唯一落点 = 本帧（快照已删）——回放缓存
    // 与 D12 完整性校验依赖此字段；result.sessionFile 兼承载执行树家族链数据源（D16 ③）
    result,
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(stderrTeePath !== undefined ? { stderrTeePath } : {}),
    durationMs: result.durationMs ?? 0,
    ts: Date.now(),
  }).catch((err: unknown) => reportDispatchFailure(run.runId, err));
}

/** `agent-settled`（派发前置失败形态）：resolveAgentOpts 失败 = call 从未 markRunning
 *  （attempt 恒 1、durationMs 0）；errorCode 恒 unknown（自由文本无词表位，诊断文本
 *  在 trace/record 面）。result 全文随帧落账（调用方传入 run 内 errorResult 同源——
 *  [D1] 完整性纪律：agent-settled 帧缺 result 是 record 恢复读面（loadAll / D12）的
 *  拒绝形态，本帧是合法写入方，写面补齐优于读面放宽）。 */
export function dispatchAgentSettledFailed(
  run: WorkflowRun,
  callId: number,
  result: AgentResult,
): void {
  void dispatchRunTrigger(run, {
    type: "agent-settled",
    taskIndex: callId,
    attempt: 1,
    outcome: "failed",
    errorCode: "unknown",
    result,
    durationMs: 0,
    ts: Date.now(),
  }).catch((err: unknown) => reportDispatchFailure(run.runId, err));
}

/** `agent-retrying` 落账（D5 载荷表 retrying 行；重试轨迹从脚本内部状态变为 record
 *  事件——重试不再能掩盖事故）。attempt = 刚失败的尝试序号（退避后序号 +1 再执行）；
 *  backoffMs = 实测退避时长；reason = 失败分类或错误文案摘要。投递点裁决（实施期
 *  登记）：编排层 runner 包装观测点（dispatchAgentCall 的重试尝试开始处），非
 *  executeAgentCall 内部回调。 */
export function dispatchAgentRetrying(
  run: WorkflowRun,
  callId: number,
  failedAttempt: number,
  backoffMs: number,
  reason: string,
): void {
  void dispatchRunTrigger(run, {
    type: "agent-retrying",
    taskIndex: callId,
    attempt: failedAttempt,
    backoffMs,
    reason,
    ts: Date.now(),
  }).catch((err: unknown) => reportDispatchFailure(run.runId, err));
}

// ══════════════════════════════════════════════════════════════
// §2 终局判定与终局记录注册表（单一判源收拢）
// ══════════════════════════════════════════════════════════════

/**
 * 单条终局记录（run-settled 帧载荷的进程内投影）。
 *
 * 字段与 record run-settled 帧同源同构；`reason` 是帧载荷的诊断文本（非
 * DoneReason——DoneReason 由 {@link runSettledOutcomeToDoneReason} 从
 * (outcome, errorCode) 联合派生，五处统一派生源）。
 */
export interface RunSettlementRecord { // oe-exempt:20260929:framework:settlement record domain contract per design D15
  outcome: RunOutcome;
  errorCode?: RunErrorCode;
  reason?: string;
  settledAt: number;
}

/** 进程内终局记录注册表（key = runId；dispatch 链 terminal 落账时 note，随
 *  runs Map 淘汰回收——条目数与终局 run 同生命周期，有界）。 */
const settledRunRecords = new Map<string, RunSettlementRecord>();

/** [W2/V1 D1] 单一判源函数（终局判定）：聚合 done（恢复路径写点 / v1 兼容层
 *  读面，W4 sunset）∨ 进程内终局记录（本进程活体终局——dispatch 链 note）。
 *  本进程未持有且聚合 running 的 run（重水合待收编形态）判未终局——恢复链的
 *  收编候选筛选据此保留。interrupted 暂停态（[D2]）不判终局——可 resume。 */
export function isRunSettled(run: { runId: string; state: { status: RunStatus } }): boolean {
  return run.state.status === "done" || settledRunRecords.has(run.runId);
}

/** 终局记录查询（注册表 miss = 本进程无活体终局记录——恢复域 run 由聚合面判读）。 */
export function settledRecordOf(runId: string): RunSettlementRecord | undefined {
  return settledRunRecords.get(runId);
}

/** 终局记录回收（runs Map 淘汰点调用——注册表条目与内存 run 同生命周期）。 */
export function forgetSettledRecord(runId: string): void {
  settledRunRecords.delete(runId);
}

/**
 * (outcome, errorCode) → DoneReason 的联合判别单点（[W2 D5] 连带取值裁决：
 * 五处 reason 统一本派生源）。budget_limited 恢复同名细分（与帧生产侧
 * finalRunErrorCodeOf 恒等映射互逆——纯 outcome 反推会把预算终局静默折叠成
 * "failed"，通知串与条目 reason 细分丢失，不采用）；time_limited outcome 直返
 * 同名 DoneReason（[D2] 升格后双向恒等）。DoneReason 无 interrupted 成员——
 * [D2] 后 interrupted 已移出 outcome，无该分支。
 */
export function runSettledOutcomeToDoneReason(outcome: RunOutcome, errorCode?: RunErrorCode): DoneReason {
  if (outcome === "failed" && errorCode === "budget_limited") {
    return errorCode;
  }
  switch (outcome) {
    case "done":
      return "completed";
    case "cancelled":
      return "aborted";
    case "time_limited":
      return "time_limited";
    case "failed":
      return "failed";
    default:
      // 词表外防御（判定核单点收敛）：穷尽 switch 无兜底时词表外值漏出
      // undefined，会击穿 RunSettlementEvidence.reason: string 契约（枚举 status /
      // 注销 reason 等消费面直接透传）。运行时可达形态 = 历史 manifest 的
      // outcome=interrupted 族（[D2] 前旧收编链物化，文件名未随 [D1] 迁移故磁盘
      // 可达，经 findRunSettlementEvidence 的 as RunOutcome 强转读入）——统一
      // 折叠 "failed" 诊断兜底容器（W2 D5 先例「interrupted → failed」：中断形态
      // 报 completed 是完成语义误报），消费侧零处理。
      return "failed";
  }
}

// ══════════════════════════════════════════════════════════════
// §3 [D15] 终局/中断编排入口
// ══════════════════════════════════════════════════════════════

/** [SW-DATA-3] store.save 尽力持久化：save 抛错（如 ENOSPC 磁盘满）不阻断状态机推进。
 *  （[D1] 后壳侧 save 为 no-op 契约保留，本函数随 RunStore port 契约保留。） */
async function saveRunBestEffort(
  run: WorkflowRun,
  deps: LifecycleDeps,
  context: string,
): Promise<void> {
  try {
    await deps.store.save(run);
  } catch (err) {
    const m = toErrorMessage(err);
    logger.error(
      `[workflow] store.save failed (${context}, runId=${run.runId}): ${m}. ` +
        "Continuing state-machine finalization (in-memory state already terminal).",
    );
  }
}

/** finalizeRun 的可调项。 */
export interface FinalizeRunOptions { // oe-exempt:20260929:framework:finalize options contract per design D15
  /** store.save 失败日志的上下文标记（OB3 排障定位，如 "handleReturn (done,completed)"）。 */
  context: string;
  /**
   * 是否调 deps.onRunDone（Interface 层完成通知）。缺省 true。
   * terminateRunningRuns 传 false——session 切换/关闭语境下主 agent 已离开本
   * session，注入完成通知只会把消息发给已离开的 session（对齐 session_start
   * 恢复先例：只发 unregister、不发 onRunDone）。
   */
  notifyDone?: boolean;
}

/**
 * [D15] 终局编排入口（terminal 四值终局目标态；五步 coda 的唯一定义点）：
 * releaseRuntime（显式）→ run-settled 状态机落账（settleRunAccounting 原语）→
 * closeOutInFlightCalls → save（best-effort）→ pending:unregister 直落 appendEntry
 * → onRunDone → 窗口实例 dispose。
 *
 * 五路发起面：abortRun（lifecycle）/ terminateRunningRuns（lifecycle，D11 分叉归
 * U2）/ 正常终局链（handleReturn 等消息面终态路径）/ recoverCrashedRuns 与
 * startupSweep 的终局分支（本入口的 interruptRun 承载中断目标态）。
 *
 * 让位语义（原 M12 两态机让位门的六态机承接形态）：并发 abort/terminate 抢先
 * 终局化后，本路径的终局触发命中 terminal × 终局事件表外转移 fail-fast
 * （IllegalTransitionError）——抢先方已兑现 unregister/onRunDone，本路径 coda
 * 终止（返回 false），重复注销/重复通知构造性排除。
 *
 * [W2/V1 D1 执行面裁决] 通知（onRunDone 链）仅本活体路径执行——收编冷路径经
 * interruptRun 落账、零通知副作用且冷路径入口 options 面无通知通道，构造性排除
 * 「通知收条冷路径误发」。
 *
 * @returns 是否本路径完成终局（false = 已被并发终局化让位，后续步骤未执行）
 */
export async function finalizeRun(
  run: WorkflowRun,
  deps: LifecycleDeps,
  doneReason: DoneReason,
  options: FinalizeRunOptions,
): Promise<boolean> {
  // [W2/V1 D1] runtime 释放显式化（原两态机 transition 内联的 releaseRuntime，
  // cleanup before mutate / A4——独立调用幂等，runtime undefined 时 no-op）。
  run.releaseRuntime();
  // [U4 → D6] 成员绑定收尾（先于 run-settled 帧投递——terminal × 任意事件是表外
  // 转移 fail-fast；[D6] 后无 clear 事件可发，仅内存绑定释放）。失败围栏：
  // IllegalTransitionError 让位 debug（并发终局竞窗 / 无 journal 注入的测试形态），
  // 其余 error 留痕不阻断终局 coda（对齐 SW-DATA-3）。
  try {
    await clearMemberReusePool(run.runId, memberReusePoolIo);
  } catch (err) {
    if (!(err instanceof IllegalTransitionError)) {
      logger.error(
        `[workflow] member reuse pool clear failed (runId=${run.runId}, reason=${doneReason}): ${toErrorMessage(err)}`,
      );
    }
  }
  // [D3] phase 收束账本回收（与 MemberReusePool 清理同域终局清理）：未收束 phase
  // 的条目在本路径后无人清账，delete 防 runId 键泄漏；幂等（让位路径由并发终局方
  // 的同款调用回收），条目 lazily 重建无正确性影响（见 forgetPhaseSettlement）。
  forgetPhaseSettlement(run.runId);
  // [P1b-1] run-settled 事件落账先于 closeOut/save（事件流先于投影面）：
  // 终局帧经 settleRunAccounting 原语（record 帧 + manifest 派生缓存两件，经
  // dispatchRunTrigger per-run 单写者队列）。让位 = IllegalTransitionError（并发
  // 终局的表外 fail-fast，M12 语义）→ coda 终止；其余失败（record IO）error
  // 留痕后 coda 继续（对齐 SW-DATA-3），settlement 缺省由 doneReason 合成（派生
  // 链降级输入，帧意图语义不变）。
  let settlement: RunSettlementRecord;
  try {
    settlement = await dispatchFinalRunSettle(run, doneReason);
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      deps.log?.("debug", "workflow:terminal-actions", "finalize skipped: run already terminal", {
        runId: run.runId,
        doneReason,
        context: options.context,
      });
      return false;
    }
    settlement = composeFinalSettlement(run, doneReason);
    logger.error(
      `[workflow] run-settled record dispatch failed (runId=${run.runId}, reason=${doneReason}): ${toErrorMessage(err)}`,
    );
  }
  closeOutInFlightCalls(run);
  // [W1 / D1] v2 终态条目：record run-settled 帧 + manifest 物化之后的条目半边
  // ——「物化时机与终态条目写点对齐」的接驳点。载荷源 = settlement（帧同源）；
  // 独立围栏：条目失败不阻断 save/unregister/onRunDone。
  appendWorkflowRecordSettledEntry(run, deps, settlement, options.context);
  await saveRunBestEffort(run, deps, options.context);
  deps.log?.("debug", "workflow:terminal-actions", "run finalized", {
    runId: run.runId,
    reason: runSettledOutcomeToDoneReason(settlement.outcome, settlement.errorCode),
    context: options.context,
  });
  // [reload-closeout D4] pending:unregister 直落权威面：直接 appendEntry 落盘
  // （session JSONL 唯一权威）。[OR-4] 独立围栏（不共用 try——直落抛错不得跳过
  // onRunDone）。
  const unregisterReason = runSettledOutcomeToDoneReason(settlement.outcome, settlement.errorCode);
  try {
    deps.appendEntry?.(PENDING_UNREGISTER_ENTRY_TYPE, {
      id: run.runId,
      reason: unregisterReason,
      status: mapReasonToStatus(unregisterReason),
    });
  } catch (err) {
    const m = toErrorMessage(err);
    logger.error(
      `[workflow] pending:unregister appendEntry failed (${options.context}, ` +
        `runId=${run.runId}, reason=${unregisterReason}): ${m}`,
    );
  }
  // [OR-4][B-4] onRunDone 独立围栏（与直落拆分——直落抛错不得吞掉完成回调）
  if (options.notifyDone !== false) {
    try {
      deps.onRunDone?.(run);
    } catch (err) {
      const m = toErrorMessage(err);
      logger.error(`[workflow] onRunDone failed (${options.context}): ${m}`);
    }
  }
  // [U2 pi-workflow-run-resource-model] 五步序列末尾：窗口实例遍历 dispose。时序
  // 红线：必须在 closeOutInFlightCalls **之后**——在途调用先收敛、后释放引擎实例。
  await disposeWorkflowWindowEngineState(run.runId, doneReason, options.context);
  return true;
}

/**
 * [D15] 中断编排入口（interrupted 暂停目标态；D2 中断转移的统一写点）：落
 * run-interrupted 转移事件（running/settling → interrupted）→ 在途 call 观测面
 * 收口 → 中断条目补写通道。**零终局副作用**——不写 manifest 派生缓存、不发终局
 * 通知、不落 pending:unregister 终态注销（中断可 resume，注销语义归宿主恢复链
 * 的 hooks 通道）。
 *
 * 五路发起面中的中断路（recoverCrashedRuns 崩溃收编 / startupSweep 启动扫描
 * [U1B] / U2 的 terminate 对 resume 来源 run 分叉）全部经本入口——「谁在什么条件
 * 下把 run 推向中断」可在一处审计。
 *
 * 幂等两道：调用方三面证据前置（收编路径——journal fold terminal / manifest 在 /
 * 终态条目在）+ 表内转移 fail-fast 让位（interrupted × run-interrupted /
 * terminal × run-interrupted 表外 IllegalTransitionError）。
 *
 * @returns 是否本路径完成中断转移（false = 让位——fold 已 terminal 或已 interrupted）
 */
export async function interruptRun(
  runId: string,
  opts?: {
    /** 中断来源标记（crashed / terminated / startup-sweep——RunErrorCode 中断族成员）。 */
    errorCode?: RunErrorCode;
    /** 中断原因摘要（自由文本诊断面）。 */
    reason?: string;
    /** journal 目录（ADR-0081 目录参数化——runtime 侧收编链注入；缺省 = 模块锚）。 */
    journalDir?: string;
    /** 中断条目 scriptName 载荷（冷路径 runId 键投递无 spec——调用方从 run-created 帧取后传入；缺省条目免写）。 */
    workflowName?: string;
    /** 中断条目幂等补写通道（中断转移成功后恰调一次；缺省 = 不写——壳注入 appendEntry 面）。 */
    appendInterruptedEntry?: (entry: WorkflowRecordSettledEntryData) => void;
    /** 时钟注入（epoch ms）；缺省 Date.now()——转移 ts 与条目 settledAt 的确定性测试通道。 */
    now?: number;
  },
): Promise<boolean> {
  const now = opts?.now ?? Date.now();
  try {
    await dispatchRunTrigger({ runId, ...(opts?.journalDir !== undefined ? { journalDir: opts.journalDir } : {}) }, {
      type: "run-interrupted",
      ...(opts?.errorCode !== undefined ? { errorCode: opts.errorCode } : {}),
      ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
      ts: now,
    });
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      // 让位：fold 已 terminal（并发终局抢先——终局方已兑现全部 coda）或已
      // interrupted（重复收编让位——幂等第二道）。
      runEventLogger.debug(
        `interruptRun yielded (runId=${runId}): ${toErrorMessage(err)}`,
      );
      return false;
    }
    throw err;
  }
  // [D3] phase 收束账本回收（中断完成路径——中断无终局 coda，此处是该路径的
  // 唯一回收点；resume 后新派发经 notePhaseDispatched lazily 重建，回收只防泄漏）。
  forgetPhaseSettlement(runId);
  // 中断条目补写（收编场景无内存聚合——callCount 从 record agent-settled 帧数
  // 推导；usedTokens 事件流不可得，摘要级 0 诚实缺省）。status 'interrupted' =
  // 暂停态收敛词（非终局——与 settled 终态条目的 'done' 判别，runtime 读侧三态
  // 投影的消费面）；outcome 缺省（中断非终局，细分语境由 errorCode 承载）。
  if (opts?.appendInterruptedEntry !== undefined) {
    let callCount = 0;
    try {
      const events = await scanRunEvents(runId, opts.journalDir);
      callCount = events.filter((e) => e.type === "agent-settled").length;
    } catch (err) {
      runEventLogger.warn(
        `interruptRun entry callCount derivation failed (runId=${runId}): ${toErrorMessage(err)}`,
      );
    }
    // 独立围栏（镜像 appendWorkflowRecordSettledEntry 的 [OR-4] 同款纪律）：
    // 条目失败不吞调用方的收尾链——terminateRunningRuns 的 closeOut/releaseRuntime/
    // dispose 与 recoverCrashedRuns 的 meta.interruptedAt 置位都在本回调之后，
    // 宿主回调本体（resolveCurrentPi().appendEntry）在 reload/替换窗口会抛。
    // record 转移事件此刻已落盘（事实源无损），缺的只是投影锚条目。
    try {
      opts.appendInterruptedEntry(
        buildWorkflowRecordInterruptedEntryData({
          runId,
          workflowName: opts.workflowName,
          errorCode: opts.errorCode,
          interruptedAt: now,
          callCount,
          usedTokens: 0,
        }),
      );
    } catch (err) {
      runEventLogger.error(
        `[workflow] workflow-record interrupted entry append failed (runId=${runId}): ${toErrorMessage(err)} — ` +
          "the run-interrupted journal frame is already durable; only the entry (projection anchor) is missing. " +
          "Recovery: reopen or reload the session to rebuild the projection; re-interrupting is idempotent " +
          "(a repeated interrupt yields without appending a second frame).",
      );
    }
  }
  return true;
}

/**
 * 活体终局的合成记录（dispatchFinalRunSettle 的帧构造输入与其 IO 故障窗口的
 * settlement 降级合成共用单点）：DoneReason 六因 → (outcome, errorCode, reason)
 * 按 D5 映射表（[D2] time_limited 直判 outcome）；aborted 走 cancel-requested
 * 合成（outcome=cancelled、无码）。
 */
function composeFinalSettlement(run: WorkflowRun, doneReason: DoneReason): RunSettlementRecord {
  if (doneReason === "aborted") {
    return {
      outcome: "cancelled",
      ...(run.state.error !== undefined ? { reason: run.state.error } : {}),
      settledAt: Date.now(),
    };
  }
  const outcome = doneReasonToRunOutcome(doneReason);
  const errorCode = finalRunErrorCodeOf(run, doneReason);
  return {
    outcome,
    ...(errorCode !== undefined ? { errorCode } : {}),
    reason: run.state.error ?? doneReason,
    settledAt: Date.now(),
  };
}

/**
 * [D15] 终局记录原语（journal 帧 + manifest 派生缓存两件一次齐全；唯一生产
 * 调用方是同文件 dispatchFinalRunSettle——finalizeRun 的落账半边。interruptRun
 * 的中断路径不走本原语：中断是暂停态收敛词，落 run-interrupted 帧 + interrupted
 * 投影条目，非 run-settled 终局落账）：
 * - 帧落账统一经 dispatchRunTrigger per-run 串行队列（单写者纪律；冷路径同走
 *   队列——离线收编无并发竞争成本）；
 * - manifest 半边：spec 携带形态（活体）由 dispatch 链 outputs 执行
 *   （persistTerminalProjection）；runId 键投递（冷路径收编）由本原语补写
 *   （workflowName 载荷从 run-created 帧取，调用方传入）。
 * - journal 目录（ADR-0081 目录参数化）：opts.journalDir 显式传入时 artifactsDir /
 *   manifest / dispatch 链 fold 全按它解析；缺省 = 模块锚。
 *
 * 幂等两道：调用方三面证据前置（收编路径）+ 表内转移 fail-fast 让位
 *（terminal × run-settled 表外 IllegalTransitionError——进程内/跨进程双终局
 * 竞窗的后到方，调用方分类处置）。
 *
 * [W2/V1 D1 执行面裁决] 本原语零通知副作用——转移表 run-settled 行 outputs 的
 * notify 标签执行体 = 活体 finalizeRun coda 的 onRunDone 链（不经原语）。
 */
export async function settleRunAccounting(
  run: RunDispatchSource,
  record: RunSettlementRecord,
  opts?: {
    /** manifest workflowName 载荷（冷路径 runId 键投递无 spec——从 run-created 帧取后传入；缺省不补写）。 */
    workflowName?: string;
    /** journal 目录（决策 2 目录参数化——收编链 artifactsDir / manifest / dispatch
     *  链按它解析；缺省 = 模块锚，pi 壳既有调用点零改动）。 */
    journalDir?: string;
  },
): Promise<void> {
  // journalDir 合入投递源（dispatch 链 fold / 帧落账 / manifest 投影统一按它解析）
  const source: RunDispatchSource =
    opts?.journalDir !== undefined ? { ...run, journalDir: opts.journalDir } : run;
  await dispatchRunTrigger(source, {
    type: "run-settled",
    outcome: record.outcome,
    ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
    artifactsDir: resolveRunEventJournal(opts?.journalDir).dir,
    ts: record.settledAt,
  });
  if (run.spec === undefined && opts?.workflowName !== undefined) {
    // 冷路径 manifest 补写（persistTerminalProjection 对 spec 缺省形态跳过后由
    // 本原语承接；失败 = error 留痕不抛——manifest 是派生缓存面，帧已在 record，
    // 对齐「取证面失败不阻断终局 coda」纪律）。
    const dir = resolveRunEventJournal(opts?.journalDir).dir;
    if (dir === "") return; // 测试防线（NoopRunEventJournal 形态）——与帧零写同域
    try {
      await writeRunTerminalManifest(dir, {
        id: run.runId,
        workflowName: opts.workflowName,
        outcome: record.outcome,
        ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
        settledAt: record.settledAt,
      });
    } catch (err) {
      logger.error(
        `[workflow] cold-path adoption manifest write failed (runId=${run.runId}): ${toErrorMessage(err)}`,
      );
    }
  }
}

/** finalizeRun 的终局事件投递（活体便捷入口）：aborted → cancel-requested 控制
 *  事件（合成落账见 journalEventOf，outcome=cancelled）；其余 → settleRunAccounting
 *  原语（[D2] 映射表：time_limited 直判 outcome、budget_limited = failed + 同名
 *  终局码）。返回终局记录（RunSettlementRecord）——finalizeRun coda 的派生源。 */
async function dispatchFinalRunSettle(run: WorkflowRun, doneReason: DoneReason): Promise<RunSettlementRecord> {
  const record = composeFinalSettlement(run, doneReason);
  if (doneReason === "aborted") {
    await dispatchRunTrigger(run, {
      type: "cancel-requested",
      reason: run.state.error,
    });
    return record;
  }
  await settleRunAccounting(run, record);
  return record;
}

/**
 * [OR-8] run 到达终态时，把 calls Map 残留的 in-flight call（status !== "done"）
 * 收口为取消终态（不删除条目——保留调用痕迹）。
 *
 * 收口语义（trace/call 状态枚举封闭，无 "cancelled" 态）：AgentCall 补齐
 * pending→running→done 状态机，result 以 IN_FLIGHT_CALL_CANCELLED_MSG 承载取消
 * 原因；trace 节点置 failed + 固定取消文案 + completedAt。调用点约定：终局/
 * 中断转移成功后、save 之前——先收口再落盘，内存态与持久化在同一时点收敛。
 * 返回被收口的 callId 数组（升序）供调用方记日志。
 */
export function closeOutInFlightCalls(run: WorkflowRun): number[] {
  const inFlight: number[] = [];
  for (const [callId, call] of run.state.calls) {
    if (call.status !== "done") inFlight.push(callId);
  }
  const completedAt = new Date().toISOString();
  for (const callId of inFlight) {
    const call = run.state.calls.get(callId);
    if (!call) continue; // 防御：迭代后被删（正常路径不可达）
    if (call.status === "pending") call.markRunning();
    if (call.status === "running") {
      call.markDone({ content: "", error: IN_FLIGHT_CALL_CANCELLED_MSG });
    }
    run.state.trace.update(callId, {
      status: "failed",
      result: { content: "", error: IN_FLIGHT_CALL_CANCELLED_MSG },
      error: IN_FLIGHT_CALL_CANCELLED_MSG,
      completedAt,
    });
  }
  return inFlight.sort((a, b) => a - b);
}

// ── v2 条目接驳（两条小条目的 core 写点与构造器单源）──────────
//
// 主 session 的 run 侧条目从「v1 全量快照」收敛为「注册 + 终态两条 v2 小条目」：
// 运行态数据活在 record 流（事实源），条目只是锚。写点归属：
// - 注册条目 = lifecycle.runWorkflow（run-created record 落账成功后）；
// - 终态条目 = finalizeRun 终局 coda（terminal 终局——[D2] settled 终态条目仅
//   terminal 时写）；中断条目 = interruptRun（status 'interrupted' 暂停态收敛词，
//   [D2] 宿主投影裁决②——schema 契约单源在 workflow-record-entry.ts）。

/** v2 终态条目摘要的 scriptResult 截断上限（条目要小，全文不进主 session 行）。 */
const SCRIPT_RESULT_SUMMARY_MAX_CHARS = 200;

/**
 * v2 注册条目构造（纯函数）。slug 缺省回落 scriptName（u0 契约注释的字面语义）；
 * startedAt/journalPath 由调用方传入（诞生点时钟 + runEventJournalPathOf 锚点）。
 * （构造器本体自 worker-message-pump 迁入——条目写点收敛 [D15] 入口文件。）
 */
export function buildWorkflowRecordRegisteredEntryData(params: {
  runId: string;
  scriptName: string;
  slug?: string;
  startedAt: number;
  journalPath: string;
}): WorkflowRecordRegisteredEntryData {
  return {
    v: WORKFLOW_RECORD_ENTRY_VERSION,
    kind: "registered",
    runId: params.runId,
    workflowName: params.scriptName,
    scriptName: params.scriptName,
    slug: params.slug ?? params.scriptName,
    startedAt: params.startedAt,
    journalPath: params.journalPath,
  };
}

/**
 * v2 终态条目构造（纯函数，terminal 终局形态——status 恒 'done'）。outcome/
 * errorCode/reason 与 dispatchFinalRunSettle 的 run-settled 帧同源；摘要三字段
 * （callCount/usedTokens/scriptResult 概要）取终局时点快照。
 */
export function buildWorkflowRecordSettledEntryData(params: {
  runId: string;
  reason: DoneReason;
  outcome: RunOutcome;
  errorCode?: RunErrorCode;
  settledAt: number;
  callCount: number;
  usedTokens: number;
  scriptResultSummary?: string;
}): WorkflowRecordSettledEntryData {
  return {
    v: WORKFLOW_RECORD_ENTRY_VERSION,
    kind: "settled",
    runId: params.runId,
    status: "done",
    reason: params.reason,
    outcome: params.outcome,
    ...(params.errorCode !== undefined ? { errorCode: params.errorCode } : {}),
    settledAt: params.settledAt,
    callCount: params.callCount,
    usedTokens: params.usedTokens,
    ...(params.scriptResultSummary !== undefined ? { scriptResultSummary: params.scriptResultSummary } : {}),
  };
}

/**
 * [D2] 中断条目构造（纯函数，interrupted 暂停形态——status 'interrupted'）：
 * outcome/reason 缺省（中断非终局——DoneReason 无中断值，细分语境由 errorCode
 * 承载：来源标记 crashed/terminated/startup-sweep）。schema 契约单源 =
 * workflow-record-entry.ts（WorkflowRecordSettledEntryData.status 扩值）。
 */
export function buildWorkflowRecordInterruptedEntryData(params: {
  runId: string;
  /** scriptName 载荷（冷路径从 run-created 帧取；缺省条目不写字段）。 */
  workflowName?: string;
  errorCode?: RunErrorCode;
  interruptedAt: number;
  callCount: number;
  usedTokens: number;
}): WorkflowRecordSettledEntryData {
  return {
    v: WORKFLOW_RECORD_ENTRY_VERSION,
    kind: "settled",
    runId: params.runId,
    status: "interrupted",
    ...(params.workflowName !== undefined ? { workflowName: params.workflowName } : {}),
    ...(params.errorCode !== undefined ? { errorCode: params.errorCode } : {}),
    settledAt: params.interruptedAt,
    callCount: params.callCount,
    usedTokens: params.usedTokens,
  };
}

/** scriptResult（unknown）→ 条目摘要文本：JSON 序列化截断；不可序列化/缺省 = 缺省。 */
function summarizeScriptResult(scriptResult: unknown): string | undefined {
  if (scriptResult === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(scriptResult);
  } catch {
    return undefined;
  }
  if (serialized === undefined) return undefined;
  return serialized.length > SCRIPT_RESULT_SUMMARY_MAX_CHARS
    ? `${serialized.slice(0, SCRIPT_RESULT_SUMMARY_MAX_CHARS)}…`
    : serialized;
}

/**
 * v2 注册条目写点（lifecycle.runWorkflow 调用；journalPath 锚点不可寻址时跳过）。
 * best-effort 围栏：appendEntry 失败留痕不阻断 run 启动主链（条目是投影锚，
 * record 事实已在——与 SW-DATA-3 同族的「落盘面尽力」语义）。
 */
export function appendWorkflowRecordRegisteredEntry(run: WorkflowRun, deps: LifecycleDeps): void {
  const journalPath = runEventJournalPathOf(run.runId);
  if (journalPath === undefined) {
    runEventLogger.warn(
      "workflow-record registered entry skipped: journal path not addressable " +
        "(vitest env without setRunEventJournalDirForTest — entry anchor would dangle)",
    );
    return;
  }
  const startedAtMs = Date.parse(run.meta.startedAt);
  const entry = buildWorkflowRecordRegisteredEntryData({
    runId: run.runId,
    scriptName: run.spec.scriptName,
    ...(run.spec.slug !== undefined ? { slug: run.spec.slug } : {}),
    startedAt: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
    journalPath,
  });
  try {
    deps.appendEntry?.(WORKFLOW_RECORD_CUSTOM_TYPE, entry);
  } catch (err) {
    runEventLogger.error(
      `[workflow] workflow-record registered entry append failed (runId=${run.runId}): ${toErrorMessage(err)}`,
    );
  }
}

/**
 * v2 终态条目写点（finalizeRun 终局 coda 内调用，terminal 终局专属——[D2] settled
 * 终态条目仅 terminal 时写，中断形态条目走 interruptRun 的
 * buildWorkflowRecordInterruptedEntryData）。载荷源 = settlement（帧同源）；
 * best-effort 围栏（条目失败不吞后续步骤）。
 */
function appendWorkflowRecordSettledEntry(
  run: WorkflowRun,
  deps: LifecycleDeps,
  settlement: RunSettlementRecord,
  context: string,
): void {
  const scriptResultSummary = summarizeScriptResult(run.state.scriptResult);
  const entry = buildWorkflowRecordSettledEntryData({
    runId: run.runId,
    reason: runSettledOutcomeToDoneReason(settlement.outcome, settlement.errorCode),
    outcome: settlement.outcome,
    ...(settlement.errorCode !== undefined ? { errorCode: settlement.errorCode } : {}),
    settledAt: settlement.settledAt,
    callCount: run.state.calls.size,
    usedTokens: run.state.budget.usedTokens,
    ...(scriptResultSummary !== undefined ? { scriptResultSummary } : {}),
  });
  try {
    deps.appendEntry?.(WORKFLOW_RECORD_CUSTOM_TYPE, entry);
  } catch (err) {
    runEventLogger.error(
      `[workflow] workflow-record settled entry append failed (${context}, runId=${run.runId}): ${toErrorMessage(err)}`,
    );
  }
}

// ── settle 链收口（execution service 直写点删除后的单点，P1b-1） ─────────────

/** settleWorkflowRecord 的既有写入面注入（finalizeRecord 归 RecordLifecycle 显式接口，
 *  经调用方闭包回指）。 */
export interface WorkflowRecordSettleExec { // oe-exempt:20260929:framework:record settle exec contract per design D15
  finalizeRecord: (result: ExecutionAgentResult, closedReason: "gc" | "cancelled") => Promise<void>;
}

export async function settleWorkflowRecord(
  record: ExecutionRecord,
  result: ExecutionAgentResult,
  closedReason: "gc" | "cancelled",
  exec: WorkflowRecordSettleExec,
): Promise<void> {
  if (trySettleLegacyClosed(record, closedReason)) {
    await exec.finalizeRecord(result, closedReason);
  }
}
