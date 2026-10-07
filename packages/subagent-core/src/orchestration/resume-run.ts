// src/orchestration/resume-run.ts
//
// [U2]（workflow-run-resume-revision §3.3 D7/D8/D10/D12/D13 + 机制文档 D1-D7）
// resume 编排原语：interrupted 态 run 的断点续跑入口。
//
// 机制主体 = 重放式恢复（机制文档 D1，用户裁决方案 A 同 runId 复活）：脚本从头
// 确定性重跑，已完成调用命中 record 重建的回放缓存毫秒级回话（零 token），控制流
// 自然推进到断点处恢复真实派发。resume 不恢复 JavaScript 执行现场（V8 无此能力）。
//
// 编排序列（D7 锁段内，锁粒度 = 资格校验 → v2 注册条目补写 → run-resumed 落
// record → 活体注册）：
//   1. D7 跨进程文件锁（proper-lockfile 直用，<workflow-state>/<runId>.resume.lock）
//   2. 资格校验：record 严格读取 → fold lifecycle === interrupted → D13 嵌套拒绝
//      → D12 完整性校验 → D10 预算预检
//   3. 恢复计划计数（回放集条数 / 重派集条数——随 run-resumed 帧的 reason 留痕）
//   4. v2 注册条目补写（裁决点 7：先于复活事件，失败干净拒绝）
//   5. run-resumed 转移事件落 record（interrupted → running；复活非终局动作，
//      不经 [D15] 终局编排入口。不合成任何结果——[ADR-0092] 只复用已提交结果，
//      未完成调用由段 6 的确定性重放走到断点后重新派发）
//   6. 重建聚合 + D10/D11 标记 + worker 接管（脚本确定性重放，回放集命中
//      cached replay）+ pending 信号
//
// 边界：壳入口（tool action / 命令 verb）与 D14 args 校验归 U3；本文件是 core
// 编排原语，Deps 复用 LifecycleDeps。record 事件流 → 复活聚合的纯投影重建轴在
// ./resume-run-rebuild.ts（本文件编排面只消费 rebuildRunFromRecord 单点）。
// canonical JSON 工具在 ./canonical-json.ts
// （独立模块：消费方含 pump 的回放比对与 terminal-actions 的 agent-started 入参
// 落账，两侧间已有 pump → terminal-actions 依赖边，工具留在任一侧都会成环）。
//
// 层归属：Engine。IO 面：record 流严格读取（fs 直读——与 run-events.ts journal
// 实装同款「Engine 模块唯一 IO 边」形态）+ proper-lockfile。本模块不读取子代理
// 会话文件（[ADR-0092]：恢复只复用已提交结果，不解析对话日志）。

import { readFileSync } from "node:fs";
import * as lockfile from "proper-lockfile";

import { getLogger } from "../core/logger.ts";
import { toErrorMessage } from "../core/error-message.ts";

import {
  buildWorkflowRecordRegisteredEntryData,
  dispatchRunTrigger,
  interruptRun,
  runEventJournalPathIn,
  runEventJournalPathOf,
} from "./terminal-actions.ts";
import { resolveRunEventJournal } from "../execution/persistence/run-event-journal.ts";
import { RUN_EVENTS_SUFFIX } from "../shared/run-vocabulary.ts";
import { isModelRef, parseModelSelector } from "../shared/model-ref.ts";
import {
  foldRunEventFrames,
  latestModelOverride,
  parseRecordStreamLine,
  type RunEventLineIssue,
  type WorkflowRunEvent,
  type WorkflowRunEventInput,
} from "./run-events.ts";
import { checkWorkflowScriptSyntax, WORKER_IIFE_HOST_DECLARED_NAMES } from "./script-syntax.ts";
import type { LifecycleDeps } from "./models/ports.ts";
import { RunRuntime } from "./models/run-runtime.ts";
import { makeHandlers } from "./lifecycle.ts";
import { WORKFLOW_RECORD_CUSTOM_TYPE } from "./workflow-record-entry.ts";
import { assertResumeArgsMatch } from "./resume-args-guard.ts";
import { rebuildRunFromRecord } from "./resume-run-rebuild.ts";
import { runAccountingFromEvents } from "./run-accounting.ts";

const logger = getLogger("subagents");

/** 毫秒→秒换算（预算预检文案的展示单位）。 */
const MS_PER_SECOND = 1000;

// ══════════════════════════════════════════════════════════════
// §1 资格拒绝 + record 流严格读取（D12 检查①② 的读侧）
// ══════════════════════════════════════════════════════════════

/**
 * resume 资格拒绝（可预期失败——run 不存在 / 非 interrupted / 嵌套脚本 / record
 * 损坏 / 预算耗尽 / 锁被占）。文案含恢复指引（错误 → 权威源 → 重试闭环，机制
 * 文档 §3.1 失败路径样例形态）；调用方（U3 壳入口）原样透出给用户。
 */
export class ResumeRejectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeRejectionError";
  }
}

/**
 * record 流全量严格读取（恢复读面专用）：非法 JSON / 缺信封 / 词表外 type /
 * agent-settled 缺 result 全文 → 拒绝（场景 18 的 resume 侧延伸，D12）。
 *
 * 与 core journal scan 的宽容跳过（活体投影面）刻意分层：活体 fold 不能因单帧
 * 全停，恢复读面不能对损坏装瞎——静默跳过会把「record 被截断/篡改」伪装成
 * 「无此调用」让残缺流上的 resume 继续跑。
 *
 * [§3.2] 单行判据（词表/信封/outcome/agent-settled result）经 core 单源原语
 * parseRecordStreamLine（requireSeq=true）消费——与壳侧 jsonl-run-store.ts 的
 * readRecordStream 共用同一份规则，两侧只剩错误文案与「是否查 seq」两处真差异。
 * 本读面额外承担 seq 断档检测（D12 检查①）：行身份严格 +1 递增（首帧 1 起），
 * 跳号 = 截断/丢失行（core scan 宽容跳过坏行后断档即暴露；末尾半截行由 JSON
 * 解析失败直接拒绝——不依赖断档推断）。
 */
function readRecordStreamStrict(recordPath: string, runId: string): WorkflowRunEvent[] {
  let content: string;
  try {
    content = readFileSync(recordPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ResumeRejectionError(
        `Resume rejected: no record stream for run ${runId} (no <runId>.record.jsonl found). ` +
          "Recovery: only runs persisted in the record-stream format can be resumed; legacy-format " +
          "runs cannot be resumed — start a new run instead.",
      );
    }
    throw err;
  }
  const events: WorkflowRunEvent[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const reject = (reason: string): ResumeRejectionError =>
      new ResumeRejectionError(
        `Resume rejected: record stream for run ${runId} is corrupted at line ${i + 1} — ${reason}. ` +
          "The record stream is the sole source of truth; a broken line means truncation, tampering, " +
          "or a writer defect. Recovery: inspect the file for external edits; if unrepairable, accept " +
          "that this run cannot be resumed and start a new run. Do NOT hand-delete lines.",
      );
    const result = parseRecordStreamLine(line, { requireSeq: true });
    if (!result.ok) throw reject(describeRunEventLineIssue(result.issue));
    // [D12] 检查①：seq 单调无断档（首帧 1 起、逐行 +1）——跳号 = 丢行/截断
    const seq = result.event.seq;
    if (seq !== events.length + 1) {
      throw reject(`seq gap detected (expected ${events.length + 1}, got ${seq}) — truncated or lost lines`);
    }
    events.push(result.event);
  }
  return events;
}

/** 单行问题 → core 恢复读面的英文文案（壳侧同问题出中文文案——本函数不共享）。 */
function describeRunEventLineIssue(issue: RunEventLineIssue): string {
  switch (issue.kind) {
    case "invalid-json":
      return "invalid JSON (truncated/half-written line)";
    case "not-object":
      return "line is not a JSON object";
    case "type-envelope":
    case "type-outside-vocabulary":
      return `event type ${JSON.stringify(issue.value)} outside the vocabulary`;
    case "ts-envelope":
      return "missing/invalid ts envelope";
    case "seq-envelope":
      return "missing/invalid seq envelope";
    case "outcome-outside-vocabulary":
      return `outcome ${JSON.stringify(issue.value)} outside the vocabulary`;
    case "agent-settled-missing-result":
      return "agent-settled frame carries no result payload (stream tampered or writer defect)";
  }
}

// ══════════════════════════════════════════════════════════════
// §2 恢复计划计数（[ADR-0092]：只复用已提交结果，未完成调用一律重派）
// ══════════════════════════════════════════════════════════════

/** 恢复计划：回放集（有已提交结果）与重派集（未完成调用）的条数。 */
interface ResumePlan { // oe-exempt:20260930:framework:resume plan reporting shape
  replay: number;
  redispatch: number;
}

/**
 * 恢复计划计数：record 事件流 → 回放集条数（有 agent-settled 的 taskIndex）与
 * 重派集条数（有 agent-started 无 agent-settled 的 taskIndex）。
 *
 * [ADR-0092] 恢复只复用已提交结果：未完成调用不合成任何结果、不读取子代理会话
 * 文件，一律由段 6 的确定性重放走到断点后重新派发（有成员绑定则续写同一成员会话、
 * 无则新建）。本计数只服务 run-resumed 帧的 reason 与 debug 日志（排障可见性），
 * 不参与派发决策——续写 / 重开的判定归既有成员复用通道。
 */
function countResumePlan(events: readonly WorkflowRunEvent[]): ResumePlan {
  const started = new Set<number>();
  const settled = new Set<number>();
  for (const event of events) {
    if (event.type === "agent-started") started.add(event.taskIndex);
    else if (event.type === "agent-settled") settled.add(event.taskIndex);
  }
  let redispatch = 0;
  for (const taskIndex of started) if (!settled.has(taskIndex)) redispatch += 1;
  return { replay: settled.size, redispatch };
}

/** 恢复计划摘要（run-resumed 帧 reason 载荷 + debug 日志）。 */
function summarizeResumePlan(plan: ResumePlan): string | undefined {
  if (plan.replay === 0 && plan.redispatch === 0) return undefined;
  return `resume plan: replay=${plan.replay} redispatch=${plan.redispatch}`;
}

// ══════════════════════════════════════════════════════════════
// §3 D10 时间预算活跃段算式
// ══════════════════════════════════════════════════════════════

/**
 * D10 活跃段算式（纯函数，场景 16/21）：跨天/跨 pause 的时间预算按活跃段累计，
 * 搁置天数不计入。
 *
 * 切段规则（设计 D10 采用段原文）：
 * - 边界 = run-settled（终局）/ run-interrupted（中断）/ run-resumed（复活）帧；
 * - 段首 = 首段 run-created.ts / 后续段对应 run-resumed.ts；
 * - 段内活跃 = 段内末条执行事件 ts − 段首 ts（执行事件 = agent/phase 业务事件，
 *   边界帧与 run-created 自身不算——收编帧是崩溃检测时刻的记账，不是执行）；
 *   段内无执行事件计 0（复活后立即再崩的段，搁置零成本）。
 *
 * 返回累计活跃毫秒（含未闭合尾段）——resume 入口写入预算账本；剩余预算 =
 * budget −（累计已耗 +（now − 复活时刻）），消费于入口预检与计时器重排。
 */
export function computeActiveElapsedMs(events: readonly WorkflowRunEvent[]): number {
  let activeMs = 0;
  let segmentStartMs: number | undefined;
  let lastExecutionTs: number | undefined;
  const closeSegment = (): void => {
    if (segmentStartMs !== undefined && lastExecutionTs !== undefined) {
      activeMs += Math.max(0, lastExecutionTs - segmentStartMs);
    }
    segmentStartMs = undefined;
    lastExecutionTs = undefined;
  };
  for (const event of events) {
    switch (event.type) {
      case "run-created":
      case "run-resumed":
        closeSegment();
        segmentStartMs = event.ts;
        continue;
      case "run-interrupted":
      case "run-settled":
        closeSegment();
        continue;
      case "model-override":
        // 宿主覆盖记账帧（subagent-model-switch §6.6①）：非执行事件——不切段、
        // 不推进 lastExecutionTs（记账 ts 不计入活跃段算式，与边界帧同族的正交面）
        continue;
      default:
        lastExecutionTs = Math.max(lastExecutionTs ?? 0, event.ts);
    }
  }
  closeSegment(); // 尾段闭合（流停在无边界帧的形态——防御，interrupted 流通常已闭合）
  return activeMs;
}

// ══════════════════════════════════════════════════════════════
// §5 resumeRun 编排原语
// ══════════════════════════════════════════════════════════════

/**
 * D7 resume 锁参数（对齐 worktree-registry.ts 直用先例的参数族）：stale 30s——
 * 持锁段（资格校验→条目→落 record→活体注册，秒级 IO）远小于窗口，且
 * proper-lockfile 持锁期间每 stale/2 自动 touch mtime（长持有不被夺）；进程崩溃
 * 后锁残留 30s 可被 stale 夺取（待验证检查点 2 已核实实装语义）。
 * [ADR-0122] 获取重试已删（原 retries 2 次/100-400ms）：锁被占 = 另一 resume 在途，
 * 立即显式拒绝（ELOCKED → ResumeRejectionError）而非退避等待。
 */
const RESUME_LOCK_STALE_MS = 30_000;

/** resumeRun 的可调项。 */
export interface ResumeRunOptions { // oe-exempt:20260929:framework:resumeRun public options contract (API surface)
  /** journal 目录锚（缺省 = 模块锚解析——与 dispatch 链 resolveRunEventJournal 同源）。 */
  journalDir?: string;
  /**
   * 调用方期望复用的 args（可选）。传入即与 run-created 事件记录的历史 args 逐字段
   * 深度比对（排除 `_runId`），不一致 / 旧格式截断摘要 → 拒绝（ResumeRejectionError，
   * 文案含差异字段与恢复动作）；缺省 = 沿用历史，不比对。判定单源 = 本包
   * `resume-args-guard.ts`（D14 领域规则；壳只负责把 args 与 journalDir 装配进来）。
   */
  args?: Record<string, unknown>;
  /**
   * 时间预算上界（ms）。生效预算三档回落（单点在 assertResumeEligibility）：
   * 显式提供 = 覆盖；缺省 = 继承最近一条 run-resumed 帧记录的生效值（跨崩溃存续
   * ——上次显式覆盖不会在下次无参 resume 时退回创建预算）；再缺省 = 继承 run-created
   * 帧的创建预算；三处都没有 = 不限时（Budget 缺省语义）。生效值写入重建 spec
   * （错误重试重建时按剩余活跃预算重排计时器）、用于 D10 预算预检、并随本次
   * run-resumed 帧落盘——全链单值，不在别处二次折算。
   */
  budgetTimeMs?: number;
  /**
   * token 预算上界（Budget.isExceeded 的加权口径）。生效预算三档回落与 budgetTimeMs
   * 完全同构（单点在 assertResumeEligibility）：显式提供 = 覆盖；缺省 = 继承最近一条
   * run-resumed 帧记录的生效值（跨崩溃存续）；再缺省 = 继承 run-created 帧的创建
   * 预算；三处都没有 = 不限制（Budget 缺省语义）。生效值写入重建 spec（引擎侧
   * maxTokens 投影与 fresh run 同形）、用于 D10 token 预检（已耗加权 tokens ≥ 上限
   * 即拒绝——帧推导下界口径，下界越界 ⟹ 真实消耗必越界）、并随本次 run-resumed 帧
   * 落盘——全链单值，不在别处二次折算。
   */
  budgetTokens?: number;
  /**
   * 目标模型 canonical ref（`provider/modelId[:thinkingLevel]` 语法，与 run-created.model
   * 同构；subagent-model-switch 决策七）。生效模型三档回落（单点在
   * assertResumeEligibility，与预算双轴同构）：显式提供 = 覆盖；缺省 = 沿用 journal
   * 覆盖记账（model-override 帧折叠，latestModelOverride 单点提取——resume 不带参数
   * 也吃持久化覆盖，2026-10-05 用户裁决核心诉求）；再缺省 = run-created 帧的创建
   * 模型；三处都没有 = 继承主 agent 模型（现状语义）。生效值随本次 run-resumed 帧
   * 落盘（观测面 + 跨崩溃存续）；派发侧消费走宿主覆盖通道（决策六②，U4b 接线），
   * 不改重建 spec 的 run 级模型（决策七不采用①：改 spec 会击穿回放比对）。
   *
   * 显式参数同时落统一覆盖记账（resume-run 锁段内直写 model-override 帧，F1-26
   * 后续项裁决）：语义 = 「setModel 补切 + 无参 resume」两步的合一步构造性等价——
   * 显式参数本身就是用户覆盖意图的一次表达，经同一记账通道落盘（覆盖表唯一意图源
   * 语义保持，不新增第二意图源；不变量 2 由 fold replace-not-stack 构造性满足——
   * resume 时刻的覆盖替换此前值，与补切时序语义一致）。落账后经
   * onResumeModelOverrideCommitted 端口同步宿主投影（F1-18 修复：内存表写值 +
   * 负缓存作废，与 setModel 写点的「落账 + 内存表」双写形态对齐）；派发侧消费经
   * 既有覆盖通道（内存命中直返 → miss 才 journal 折叠回填），零新增消费面。
   */
  model?: string;
  /** 时钟注入（epoch ms）；缺省 Date.now()——run-resumed 帧 ts 与预算算式的确定性测试通道。 */
  now?: () => number;
  /** 宿主标识（run-resumed 帧 host 载荷——跨进程锁裁决的胜出方语境）。 */
  host?: string;
}

/**
 * resume 编排原语（U2 主体）：interrupted 态 run 断点续跑。
 *
 * @throws {@link ResumeRejectionError} 资格拒绝（文案含恢复指引）：
 *   - 锁被占（另一进程/本进程并发 resume 在途——D7，场景 9/15）
 *   - record 流不存在（历史格式 run 或已清理）
 *   - record 流损坏（D12：坏行/seq 断档/settled 缺 result，场景 18）
 *   - fold lifecycle 非 interrupted（终局 run / 从未中断的 run——场景 7/17）
 *   - D13 嵌套词法命中（场景 20）
 *   - D10 预算预检：真实活跃段已耗尽（搁置不计，但已烧的不退——场景 16 的反面）
 *   - v2 注册条目补写失败（裁决点 7：失败干净拒绝——run-resumed 未落，状态无损）
 * @returns runId（同 runId 复活——机制文档方案 A，观测面单实体）
 */
export async function resumeRun(
  runId: string,
  deps: LifecycleDeps,
  options?: ResumeRunOptions,
): Promise<string> {
  const now = options?.now ?? Date.now;
  const recordPath = resolveRecordPath(runId, options?.journalDir);

  // ── 1. D7 跨进程锁（锁段覆盖：资格校验 → v2 条目 → run-resumed 落盘 → 活体注册）──
  // 锁名 = recordPath 剥 RUN_EVENTS_SUFFIX（词表单源）+ `.resume`：两个分支
  // （注入 / 模块锚）的 recordPath 都经 runEventJournalPathIn 拼接，后缀必在，
  // 剥离长度与文件名策略同源——后缀改名时锁名不漂移，跨进程互斥不失效。
  const lockTarget = `${recordPath.slice(0, -RUN_EVENTS_SUFFIX.length)}.resume`;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(lockTarget, {
      realpath: false,
      stale: RESUME_LOCK_STALE_MS,
      retries: 0,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new ResumeRejectionError(
        `Resume rejected: run ${runId} is being resumed by another process ` +
          "(a resume lock is held elsewhere). Recovery: check the other host, or retry after it exits " +
          "(the lock self-clears within 30s if its holder crashed).",
      );
    }
    throw err;
  }
  try {
    return await resumeRunLocked(runId, deps, recordPath, options, now);
  } finally {
    try {
      await release();
    } catch (unlockErr) {
      // 锁被 stale 夺取后 unlock 必然失败且可忽略（worktree-registry 同款语义）
      logger.debug(`resume lock release failed (ignorable): ${toErrorMessage(unlockErr)}`);
    }
  }
}

/**
 * record 流绝对路径（resume 读面与锁文件同目录锚定）。文件名策略单源 =
 * runEventJournalPathIn（`<runId><RUN_EVENTS_SUFFIX>`，与 journal 实写面同源——
 * 后缀改名时读面/锁面跟随，不再自拼字面量）。测试防线（vitest 未注入目录 →
 * runEventJournalPathOf 返回 undefined）下不可寻址 = 锁与读面都不可用，
 * 按「锁不可用即拒绝」保守拒绝（前提 2 降级语义）。
 */
function resolveRecordPath(runId: string, journalDir?: string): string {
  const anchor =
    journalDir !== undefined ? runEventJournalPathIn(journalDir, runId) : runEventJournalPathOf(runId);
  if (anchor === undefined) {
    throw new ResumeRejectionError(
      `Resume rejected: workflow-state directory is not addressable for run ${runId} (no journal dir ` +
        "injected — the resume lock and record read have no anchor). Recovery: this is a test-environment " +
        "misconfiguration; production always resolves a state dir.",
    );
  }
  return anchor;
}

/**
 * 最近一条 `run-resumed` 帧（无 = undefined）。它记录该次复活实际生效的预算，是
 * 「创建后经 resume 变更过的预算」的权威来源（三档回落的中档）。取流尾最近一条
 * 而非「最近一条带字段」：后者会让更晚的「不限时复活」（0/负值不落字段）错误地
 * 回退到更早的覆盖值。`findLast` 属 ES2023 lib（本包 target ES2022）——
 * 从尾向头手写（run-registry 同款）。
 */
function findLatestRunResumed(
  events: readonly WorkflowRunEvent[],
): Extract<WorkflowRunEvent, { type: "run-resumed" }> | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === "run-resumed") return event;
  }
  return undefined;
}

/** resume 读面的 run-created 帧定位（assertResumeEligibility 拆出）：严格读取 +
 * created 在场拒绝。缺席 = run 从未启动或流头部截断。 */
function readResumableStream(
  runId: string,
  recordPath: string,
): { events: WorkflowRunEvent[]; created: Extract<WorkflowRunEvent, { type: "run-created" }> } {
  const events = readRecordStreamStrict(recordPath, runId);
  const created = events.find(
    (e): e is Extract<WorkflowRunEvent, { type: "run-created" }> => e.type === "run-created",
  );
  if (created === undefined) {
    throw new ResumeRejectionError(
      `Resume rejected: record stream for run ${runId} has no run-created frame (the run never started, ` +
        "or the stream is truncated at the head). Recovery: verify the runId, or start a new run.",
    );
  }
  return { events, created };
}

/**
 * 生效预算三档回落（assertResumeEligibility 拆出，单点勿散）：显式 options 覆盖 >
 * 最近一条 run-resumed 帧的生效值（跨崩溃存续——上次显式覆盖不因下次无参 resume
 * 退回创建预算）> run-created 记录的创建预算；三处都没有 = 不限时。本值同时供
 * D10 预检、首次挂表（adoptResumedRun）、rebuildRunFromRecord 的 spec 与本次
 * run-resumed 帧消费——不出现第二处折算。旧格式帧（无字段）自然回落 run-created，
 * 行为不劣化。token 轴与时间轴同构。
 */
function effectiveResumeBudget(
  options: ResumeRunOptions | undefined,
  lastResumed: Extract<WorkflowRunEvent, { type: "run-resumed" }> | undefined,
  created: Extract<WorkflowRunEvent, { type: "run-created" }>,
): { budgetTimeMs: number | undefined; budgetTokens: number | undefined } {
  return {
    budgetTimeMs: options?.budgetTimeMs ?? lastResumed?.budgetTimeMs ?? created.budgetTimeMs,
    budgetTokens: options?.budgetTokens ?? lastResumed?.budgetTokens ?? created.budgetTokens,
  };
}

/**
 * 生效模型三档回落（assertResumeEligibility 拆出，与 effectiveResumeBudget 同构单点
 * ——subagent-model-switch 决策七）：显式 options.model > journal 覆盖记账
 * （model-override 帧，latestModelOverride 折叠——结构化 {provider, modelId} 在本
 * 单点拼 canonical ref `${provider}/${modelId}`，parseModelSelector 语法 provider
 * 不含 `/`，无损可逆）> run-created 记录的创建模型；三处都没有 = undefined（继承
 * 主 agent 模型，现状语义）。本值同时供 run-resumed 帧落盘——不出现第二处折算。
 */
function effectiveResumeModel(
  options: ResumeRunOptions | undefined,
  events: readonly WorkflowRunEvent[],
  created: Extract<WorkflowRunEvent, { type: "run-created" }>,
): string | undefined {
  const override = latestModelOverride(events);
  const overrideRef =
    override !== undefined && override.model.provider !== "" && override.model.modelId !== ""
      ? `${override.model.provider}/${override.model.modelId}`
      : undefined;
  return options?.model ?? overrideRef ?? created.model;
}

/**
 * D10 预算预检（assertResumeEligibility 拆出；场景 16：搁置不计，活跃已耗不退）。
 * 时间轴：已耗活跃时长 ≥ 上限即拒绝。token 轴（与时间轴对齐）：已耗口径 =
 * runAccountingFromEvents 单源（agent-settled.result.usage 同一加权折算，下界近似
 * ——中间失败尝试不在事件流）。用下界做拒绝判据方向安全：下界 ≥ 上限 ⟹ 真实消耗
 * （活体逐尝试累计）必 ≥ 上限，不产生误拒；下界未越界时放行，复活后由重建
 * Budget.isExceeded 正常路径守卫。返回已耗活跃时长（返回值装配消费）。
 */
function assertBudgetNotExhausted(
  runId: string,
  events: readonly WorkflowRunEvent[],
  budgetTimeMs: number | undefined,
  budgetTokens: number | undefined,
): number {
  const activeElapsedMs = computeActiveElapsedMs(events);
  if (budgetTimeMs !== undefined && budgetTimeMs > 0 && activeElapsedMs >= budgetTimeMs) {
    throw new ResumeRejectionError(
      `Resume rejected: run ${runId} has exhausted its time budget (${Math.round(activeElapsedMs / MS_PER_SECOND)}s ` +
        `active of ${Math.round(budgetTimeMs / MS_PER_SECOND)}s — suspended time is not counted, spent active ` +
        "time is). Recovery: start a new run, or rerun with a larger budgetTimeMs.",
    );
  }
  if (budgetTokens !== undefined && budgetTokens > 0) {
    const usedTokens = runAccountingFromEvents(events).usedTokens;
    if (usedTokens >= budgetTokens) {
      throw new ResumeRejectionError(
        `Resume rejected: run ${runId} has exhausted its token budget ` +
          `(${Math.round(usedTokens)} weighted tokens used of ${Math.round(budgetTokens)} — the count is the ` +
          "frame-derived lower bound, so the true spend is at least this high). Recovery: start a new run, " +
          "or rerun with a larger budgetTokens.",
      );
    }
  }
  return activeElapsedMs;
}

/**
 * [resumeRunLocked 拆分] 资格校验（段 2）：run-created 帧 / interrupted 生命周期 /
 * D10 预算预检（场景 16：搁置不计，活跃已耗不退）。任一不过即拒绝（异常即返回值）。
 *
 * 预算预检与返回的 budgetTimeMs 均为「生效预算」（三档回落单点，见 effectiveResumeBudget
 * 解析）——继承形态下原预算已耗尽同样拒绝，不把复活窗变成绕过预算的通道。
 */
function assertResumeEligibility(
  runId: string,
  recordPath: string,
  options: ResumeRunOptions | undefined,
): { events: WorkflowRunEvent[]; created: Extract<WorkflowRunEvent, { type: "run-created" }>; activeElapsedMs: number; budgetTimeMs: number | undefined; budgetTokens: number | undefined; model: string | undefined } {
  const reject = (message: string): ResumeRejectionError => new ResumeRejectionError(message);
  const { events, created } = readResumableStream(runId, recordPath);
  // [§2.5 D14] args 一致性判定（fail-fast 于任何副作用之前）：数据源 = 上面已读到的
  // run-created 事件（无需壳再读文件，也不需要新的端口原语）；absent 不在此拒绝
  //（资格判据归下方权威文案）。
  if (options?.args !== undefined) {
    assertResumeArgsMatch(runId, options.args, created, reject);
  }
  // fold 坏帧保守停摆（严格读取已保证行级合法；表外转移序的篡改流在此显形——
  // fold 停在中途态且不达 interrupted 即拒绝）
  const foldState = foldRunEventFrames(events, () => {});
  if (foldState.lifecycle === "terminal") {
    throw reject(
      `Resume rejected: run ${runId} is already settled (${foldState.outcome ?? "unknown"} outcome) — ` +
        "only interrupted runs can be resumed. Recovery: start a new run for a fresh result.",
    );
  }
  if (foldState.lifecycle !== "interrupted") {
    throw reject(
      `Resume rejected: run ${runId} is in lifecycle state '${foldState.lifecycle}', not 'interrupted' — ` +
        "only interrupted runs can be resumed (an actively running run needs no resume; a crashed run must " +
        "be adopted first). Recovery: re-check the run status, or wait for crash adoption to move it to " +
        "interrupted before resuming.",
    );
  }
  const lastResumed = findLatestRunResumed(events);
  const { budgetTimeMs, budgetTokens } = effectiveResumeBudget(options, lastResumed, created);
  const activeElapsedMs = assertBudgetNotExhausted(runId, events, budgetTimeMs, budgetTokens);
  // 生效模型（三档回落单点，与预算双轴同构——决策七「资格校验与生效值解析单点」）
  const model = effectiveResumeModel(options, events, created);
  return { events, created, activeElapsedMs, budgetTimeMs, budgetTokens, model };
}

/**
 * [resumeRunLocked 拆分] 段 2b 派发前语法闸（第 4 道检查的 resume 侧）：run-created
 * 里的 scriptSource 是权威脚本文本；不可编译（顶层重声明宿主预声明名）时 Worker 启动
 * 后必然异步语法错（失败上抛，分类与行号丢失）。先于段 4/5/6 的一切写动作拒绝（干净
 * 拒绝：run-resumed 未落、v2 条目未补、run 仍 interrupted）。record 的脚本文本不可改
 * → 该 run 无法 resume，恢复动作 = 修脚本后重派新 run（文案已含指引）。空脚本文本
 * 跳过（旧格式 record 无全文）。
 */
function assertResumeScriptCompilable(
  runId: string,
  created: Extract<WorkflowRunEvent, { type: "run-created" }>,
): void {
  const scriptSyntaxError = created.scriptSource !== undefined && created.scriptSource.trim() !== ""
    ? checkWorkflowScriptSyntax(created.scriptSource)
    : undefined;
  if (scriptSyntaxError !== undefined) {
    throw new ResumeRejectionError(
      `Resume rejected: run ${runId} carries a workflow script that cannot compile (${scriptSyntaxError}). ` +
        `Recovery: the script source is stored in the run record and cannot be edited — fix the script ` +
        `(a script-level declaration must not reuse a name the worker pre-declares: ` +
        `${WORKER_IIFE_HOST_DECLARED_NAMES.join(", ")}) and start a new run.`,
    );
  }
}

/**
 * [resumeRunLocked 拆分] 段 2c 显式 model 参数的格式闸：malformed ref 落进覆盖记账
 * 会毒化后续派发（覆盖是派发期模型输入源），入口 fail-fast。先于段 4/5/6 一切写动作
 * ——干净拒绝，状态无损。
 */
function assertResumeModelRefWellFormed(runId: string, options: ResumeRunOptions | undefined): void {
  if (options?.model !== undefined && !isModelRef(options.model)) {
    throw new ResumeRejectionError(
      `Resume rejected: run ${runId} resume model '${options.model}' is not a valid canonical ref. ` +
        "Correct syntax: 'provider/modelId' or 'provider/modelId:thinkingLevel'. " +
        "Recovery: retry the resume with a well-formed model ref.",
    );
  }
}


/**
 * [resumeRunLocked 拆分] 段 6：重建聚合 + D10 预算标记 + worker 接管 + pending 信号。
 * 按 record 流全量重读重建（事件 seq 由 journal.append 分配——重读拿权威序）。
 */
function adoptResumedRun(
  runId: string,
  deps: LifecycleDeps,
  created: Extract<WorkflowRunEvent, { type: "run-created" }>,
  recordPath: string,
  summary: {
    events: readonly WorkflowRunEvent[];
    activeElapsedMs: number;
    budgetTimeMs: number | undefined;
    budgetTokens: number | undefined;
    resumedAt: number;
    plan: ResumePlan;
  },
  now: () => number,
): void {
  // 生效预算（summary.budgetTimeMs/budgetTokens 与首次挂表同源）随 spec 落定。
  // [ADR-0122] 原进程内 D10 预算账本（noteRunResumedBudget）随重试矩阵删除——
  // 账本唯一读方是已删的 rebuild 重试路径；resume 挂表用本函数下方局部折算。
  const run = rebuildRunFromRecord(
    runId,
    created,
    readRecordStreamStrict(recordPath, runId),
    summary.budgetTimeMs,
    summary.budgetTokens,
  );
  const handlers = makeHandlers(run, deps);
  // 剩余预算（D10）：budget −（累计活跃已耗 + 本段已跑）——搁置不计
  const remainingBudgetMs = summary.budgetTimeMs && summary.budgetTimeMs > 0
    ? Math.max(0, summary.budgetTimeMs - summary.activeElapsedMs - (now() - summary.resumedAt))
    : undefined;
  const timeBudgetTimer = remainingBudgetMs && remainingBudgetMs > 0 && deps.scheduleTimeBudget
    ? deps.scheduleTimeBudget(runId, remainingBudgetMs)
    : undefined;
  const worker = deps.workerHost.start(run.spec, run.spec.args, handlers);
  run.assignRuntime(new RunRuntime(worker, new AbortController(), timeBudgetTimer));
  deps.runs.set(runId, run);
  // RunStore port 契约保形（D1 后壳侧 save 为 no-op——core 调用点不改）
  deps.store.save(run).catch((err: unknown) => {
    logger.error(`[workflow] store.save failed (resumeRun): ${toErrorMessage(err)}`);
  });
  // pending-notifications 信号（runWorkflow 启动同款）：复活 = 该 run 对当前
  // session 重新可见的进行中任务（run-resumed 转移表行「通知语义归 resume 编排」的落点）
  // [OR-4 同款独立围栏] 此处接管（deps.runs.set）已成功——通知/日志是辅助面，
  // 失败不得把已复活的 run 判死回滚（record 停在 running 是此刻的事实）。宿主
  // eventBus 经 resolveCurrentPi() 现读，reload/替换窗口会抛。
  try {
    deps.eventBus?.emit("pending:register", { id: runId, type: "workflow", name: run.spec.slug || run.spec.scriptName || runId });
    deps.log?.("debug", "workflow:resume-run", "run resumed", {
      runId,
      replayCalls: summary.plan.replay,
      redispatchedCalls: summary.plan.redispatch,
      rescheduledBudgetMs: remainingBudgetMs,
    });
  } catch (err) {
    logger.error(
      `[workflow] resume post-adoption signal failed (runId=${runId}): ${toErrorMessage(err)} — ` +
        "the run itself is adopted and running; only the notification/log was lost",
    );
  }
}

/** options.journalDir → dispatch 源 / interrupt 参数的条件 spread 段（absent 不带键）。 */
function journalDirSpread(
  options: ResumeRunOptions | undefined,
): { journalDir: string } | Record<string, never> {
  return options?.journalDir !== undefined ? { journalDir: options.journalDir } : {};
}

/** run-resumed reason 条件 spread 段（planSummary 缺席不落键；journalDirSpread 同形态）。 */
function reasonSpread(planSummary: string | undefined): { reason: string } | Record<string, never> {
  return planSummary !== undefined ? { reason: planSummary } : {};
}

/** run-resumed host 条件 spread 段（options/host 缺席不落键）。 */
function hostSpread(options: ResumeRunOptions | undefined): { host: string } | Record<string, never> {
  return options?.host !== undefined ? { host: options.host } : {};
}

/** run-resumed budgetTimeMs 条件 spread 段（未设/0/负值不落——与 run-created 同款条件式）。 */
function budgetTimeMsSpread(budgetTimeMs: number | undefined): { budgetTimeMs: number } | Record<string, never> {
  return budgetTimeMs !== undefined && budgetTimeMs > 0 ? { budgetTimeMs } : {};
}

/** run-resumed budgetTokens 条件 spread 段（未设/0/负值不落——与 run-created 同款条件式）。 */
function budgetTokensSpread(budgetTokens: number | undefined): { budgetTokens: number } | Record<string, never> {
  return budgetTokens !== undefined && budgetTokens > 0 ? { budgetTokens } : {};
}

/** run-resumed model 条件 spread 段（缺省/空串不落 = 未指定且无覆盖记账的复活与现状同形）。 */
function resumedModelSpread(model: string | undefined): { model: string } | Record<string, never> {
  return model !== undefined && model !== "" ? { model } : {};
}

/**
 * 段 5 run-resumed 帧载荷组装（resumeRunLocked 拆出）：各条件 spread 段——reason /
 * host 缺席不落键；本次复活实际生效的预算随帧落盘（跨崩溃存续的数据面）仅 > 0 落
 * 字段——未设/0/负值不落（与 run-created 同款条件式），读取面按「最近一条
 * run-resumed 的字段 ?? run-created 的字段」回落。生效模型同款落盘（三档回落
 * 落定值，canonical ref；缺省不落 = 未指定且无覆盖记账的复活与现状同形）。
 */
function buildRunResumedPayload(
  options: ResumeRunOptions | undefined,
  planSummary: string | undefined,
  budgetTimeMs: number | undefined,
  budgetTokens: number | undefined,
  model: string | undefined,
  resumedAt: number,
): Extract<WorkflowRunEventInput, { type: "run-resumed" }> {
  return {
    type: "run-resumed",
    ...reasonSpread(planSummary),
    ...hostSpread(options),
    ...budgetTimeMsSpread(budgetTimeMs),
    ...budgetTokensSpread(budgetTokens),
    ...resumedModelSpread(model),
    ts: resumedAt,
  };
}

/**
 * 段 6 接管失败的回滚围栏（resumeRunLocked 拆出）：补偿语义见调用点注释——清 D10
 * 预算账目 + interruptRun 落 run-interrupted（running → interrupted 表内合法转移、
 * 幂等）；回滚自身失败（journal IO error）仅 error 留痕。原异常由调用方上抛。
 */
async function rollbackFailedAdoption(
  runId: string,
  options: ResumeRunOptions | undefined,
  created: Extract<WorkflowRunEvent, { type: "run-created" }>,
  err: unknown,
): Promise<void> {
  try {
    await interruptRun(runId, {
      errorCode: "crashed",
      reason: `resume adoption failed: ${toErrorMessage(err)}`,
      ...journalDirSpread(options),
      workflowName: created.workflowName,
    });
    logger.error(
      `[workflow] resume adoption failed, run rolled back to interrupted (runId=${runId}): ${toErrorMessage(err)}`,
    );
  } catch (rollbackErr) {
    logger.error(
      `[workflow] resume rollback to interrupted failed (runId=${runId}): ${toErrorMessage(rollbackErr)} — ` +
        "record stays folded as running with no live worker. Recovery: the next session_start crash " +
        "adoption (recoverCrashedRuns) will re-interrupt this run; inspect the record stream manually " +
        "if adoption keeps failing.",
    );
  }
}

/** 锁段内的编排主体（resumeRun 持锁后执行；锁释放归调用方 finally）。 */
async function resumeRunLocked(
  runId: string,
  deps: LifecycleDeps,
  recordPath: string,
  options: ResumeRunOptions | undefined,
  now: () => number,
): Promise<string> {
  // ── 2. 资格校验 ──
  const { events, created, activeElapsedMs, budgetTimeMs, budgetTokens, model } = assertResumeEligibility(runId, recordPath, options);

  // ── 2b. 派发前语法闸（第 4 道检查的 resume 侧）──
  assertResumeScriptCompilable(runId, created);
  // ── 2c. 显式 model 参数的格式闸（先于段 4/5/6 一切写动作——干净拒绝，状态无损）──
  assertResumeModelRefWellFormed(runId, options);

  // ── 3. 恢复计划计数（[ADR-0092]：已提交结果回放 / 未完成调用重派）──
  const plan = countResumePlan(events);
  const planSummary = summarizeResumePlan(plan);

  // ── 4. v2 注册条目补写（裁决点 7：锁段内、先于复活事件，失败干净拒绝）──
  appendResumeRegisteredEntry(runId, deps, created, recordPath);

  // ── 5. run-resumed 落 record（interrupted → running；不合成任何结果）──
  const dispatchSource = { runId, ...journalDirSpread(options) };
  const resumedAt = now();
  try {
    await dispatchRunTrigger(dispatchSource, buildRunResumedPayload(options, planSummary, budgetTimeMs, budgetTokens, model, resumedAt));
  } catch (err) {
    // 让位（表外转移）仅在流被并发篡改时可达（锁段内无并发写者）——资格异常上抛，
    // 状态无损（run-resumed 未落，run 仍 interrupted 可重试）
    throw new ResumeRejectionError(
      `Resume rejected: run ${runId} could not record its resume transition: ${toErrorMessage(err)}. ` +
        "Recovery: re-check the run status; if the record stream was modified concurrently, inspect it " +
        "before retrying the resume.",
    );
  }

  // ── 6. 重建聚合 + D10 预算标记 + worker 接管 + pending 信号 ──
  // 补偿围栏：段 4/5 的失败都是干净拒绝（run-resumed 未落、状态无损），但本段在
  // run-resumed 帧 + 档 1 补收帧已落盘之后执行——接管失败若无补偿，record 流
  // fold=running 而进程内无活体无注册：run 可被 GUI/枚举发现却永不推进，且再次
  // resume 被资格校验以「actively running needs no resume」误拒（与实情相反）。
  // 回滚（rollbackFailedAdoption）= 清 D10 预算账目 + interruptRun 落
  // run-interrupted（running → interrupted 表内合法转移、幂等），run 回到可重试
  // resume 的暂停态；回滚自身失败（journal IO error）仅 error 留痕——兜底收敛 =
  // 下次 session_start 的 recoverCrashedRuns 收编。原异常照常上抛（调用方报错给用户）。
  try {
    // 显式 model 参数 → 统一覆盖记账（F1-26 后续项裁决——「补切 + 无参 resume」的
    // 合一步：显式参数即用户覆盖意图表达，经同一 model-override 通道落盘，派发侧
    // 经既有 rebuildRunOverride 通道消费）。写序 = run-resumed 转移之后、接管之前；
    // 失败走接管失败同款回滚围栏（run 回 interrupted 可重试——覆盖未落 = 意图未
    // 受理，带半截覆盖的 running 态才是坏状态）。落账后同步宿主投影（F1-18 修复
    // ——内存表 + 负缓存，appendResumeModelOverride 内单点；投影回调 throw 同走
    // 本回滚围栏：journal 帧已落但宿主投影未同步 = 重派消费面不可信，与接管失败
    // 同级处置）。
    if (options?.model !== undefined) {
      await appendResumeModelOverride(runId, deps, options.model, now(), options?.journalDir);
    }
    adoptResumedRun(runId, deps, created, recordPath, {
      events, activeElapsedMs, budgetTimeMs, budgetTokens, resumedAt, plan,
    }, now);
  } catch (err) {
    await rollbackFailedAdoption(runId, options, created, err);
    throw err;
  }
  return runId;
}

/**
 * resume 显式 model 参数的统一覆盖记账直写（F1-26 后续项；journal append 第三合法
 * 写点——登记见 RunEventJournal.append 单写者约束）。canonical ref 在锁段内格式闸
 * 已验（resumeRunLocked 段 2b），此处只做拆装落账；`[:thinkingLevel]` 后缀随
 * parseModelSelector 拆出进记账 thinkingLevel（与 setModel 编排的 ModelOverride
 * 形状同构）。失败语义 = 接管失败同款回滚围栏（调用点 try 域内）。
 */
async function appendResumeModelOverride(
  runId: string,
  deps: LifecycleDeps,
  modelRef: string,
  ts: number,
  journalDir: string | undefined,
): Promise<void> {
  const parsed = parseModelSelector(modelRef);
  const { journal } = resolveRunEventJournal(journalDir);
  await journal.append(runId, {
    type: "model-override",
    model: { provider: parsed.provider, modelId: parsed.id },
    ...(parsed.thinkingLevel !== undefined ? { thinkingLevel: parsed.thinkingLevel } : {}),
    ts,
  });
  // [F1-18 修复] 落账后同步宿主投影（端口注入，LifecycleDeps 承载——orchestration
  // 不 import execution，接缝与 workflowAgentDispatch 同形态）。journal 帧落盘使
  // 宿主两个派生投影 stale：覆盖记账内存表（若该 run 曾有覆盖，内存命中旧值遮蔽
  // 本次意图）+ workflow 域重建负缓存（「已扫无覆盖」登记为假，短路 journal 重扫）。
  // 回调 throw（如 service 缺席）走调用点回滚围栏——run 回 interrupted 可重试，
  // journal 帧已落（重试 resume 重复追加同值帧，latest-wins 幂等无害）。
  deps.onResumeModelOverrideCommitted?.(runId, {
    provider: parsed.provider,
    modelId: parsed.id,
    ...(parsed.thinkingLevel !== undefined ? { thinkingLevel: parsed.thinkingLevel } : {}),
    ts,
  });
}

/**
 * v2 注册条目补写（裁决点 7「resume 接管向发起 session 补写 v2 注册条目」）：
 * 锁段内、先于 run-resumed 落 record——失败干净拒绝（run-resumed 未落，run 保持
 * interrupted 无损）。幂等性：同 session 重复 resume 会重复追加条目——多一条引用
 * 无害（引用集判「任一存活 session 引用即保留」，重复条目不改变归属判定）。
 * recordPath 锚点 = recordPath 同源（防 journalDir 显式注入形态下锚点漂移到模块锚）。
 */
function appendResumeRegisteredEntry(
  runId: string,
  deps: LifecycleDeps,
  created: Extract<WorkflowRunEvent, { type: "run-created" }>,
  recordPath: string,
): void {
  const entry = buildWorkflowRecordRegisteredEntryData({
    runId,
    scriptName: created.workflowName,
    // scriptPath 与 scriptName 同源取自 run-created 帧（写侧 dispatchRunCreated
    // 条件式恒带）；旧格式帧缺载荷时回落空串（读侧与投影链按缺省处理）。不可写死
    // 空串：同 id 后到的 resume 条目在 events-projection 的 last-writer-wins 下
    // 会遮蔽原始注册条目，GUI 全路径退化短名。
    scriptPath: created.scriptPath ?? "",
    startedAt: created.ts,
    recordPath: recordPath,
  });
  try {
    deps.appendEntry?.(WORKFLOW_RECORD_CUSTOM_TYPE, entry);
  } catch (err) {
    throw new ResumeRejectionError(
      `Resume rejected: could not register run ${runId} with the current session ` +
        `(appendEntry failed: ${toErrorMessage(err)}) — the resume was aborted before any state change. ` +
        "Recovery: retry the resume once the session is writable.",
    );
  }
}
