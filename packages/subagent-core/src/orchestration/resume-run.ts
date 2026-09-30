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
//   3. D8 三档判定：重派集逐 call 按子代理会话文件落盘状态判档（档 1 补收候选）
//   4. v2 注册条目补写（裁决点 7：先于复活事件，失败干净拒绝）
//   5. run-resumed 转移事件落 record（interrupted → running；复活非终局动作，
//      不经 [D15] 终局编排入口）+ 档 1 补收帧落 record（事实入流，D1）
//   6. 重建聚合 + D10/D11 标记 + worker 接管（脚本确定性重放，回放集命中
//      cached replay）+ pending 信号
//
// 边界：壳入口（tool action / 命令 verb）与 D14 args 校验归 U3；本文件是 core
// 编排原语，Deps 复用 LifecycleDeps。canonical JSON 工具在 ./canonical-json.ts
// （独立模块：消费方含 pump 的回放比对与 terminal-actions 的 agent-started 入参
// 落账，两侧间已有 pump → terminal-actions 依赖边，工具留在任一侧都会成环）。
//
// 层归属：Engine。IO 面：record 流严格读取 + 会话文件尾部扫描（fs 直读——与
// run-events.ts journal 实装同款「Engine 模块唯一 IO 边」形态）+ proper-lockfile。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as lockfile from "proper-lockfile";

import { getLogger } from "../core/logger.ts";
import { toErrorMessage } from "../core/error-message.ts";

import {
  buildWorkflowRecordRegisteredEntryData,
  dispatchRunTrigger,
  interruptRun,
  runEventJournalPathOf,
} from "./terminal-actions.ts";
import {
  foldRunEventFrames,
  parseLegacyArgsSummary,
  parseRecordStreamLine,
  type RunEventLineIssue,
  type WorkflowRunEvent,
} from "./run-events.ts";
import { checkWorkflowScriptSyntax, WORKER_IIFE_HOST_DECLARED_NAMES } from "./script-syntax.ts";
import { AgentCall } from "./models/agent-call.ts";
import { Budget } from "./models/budget.ts";
import type { AgentCallOpts, AgentResult, ExecutionTraceNode } from "./models/types.ts";
import { Trace } from "./models/trace.ts";
import { WorkflowRun } from "./models/workflow-run.ts";
import type { LifecycleDeps } from "./models/ports.ts";
import { RunRuntime } from "./models/run-runtime.ts";
import { makeHandlers } from "./lifecycle.ts";
import { forgetRunResumedBudget, noteRunResumedBudget } from "./worker-message-pump.ts";
import { WORKFLOW_RECORD_CUSTOM_TYPE } from "./workflow-record-entry.ts";
import { assertResumeArgsMatch } from "./resume-args-guard.ts";
import { rebuildBudget } from "./run-accounting.ts";

const logger = getLogger("subagents");

/** 毫秒→秒换算（预算预检文案的展示单位）。 */
const MS_PER_SECOND = 1000;

/** canonical JSON 单行解析助手：坏行（半截/非法 JSON）返回 undefined，消费点区分语义。 */
function tryParseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

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
// §2 D8 三档恢复（档位判据 + 档 1 结果补收）
// ══════════════════════════════════════════════════════════════

/** D8 恢复档位：collect = 档 1 补收（零 token）/ continue = 档 2 同会话续写 / restart = 档 3 整跑。 */
export type ResumeTier = "collect" | "continue" | "restart";

/**
 * pi 会话文件尾部形态的 D8 档位判定结果。
 * - collect：末轮 assistant 回复完整落盘（仅结果未回传）——携带提取的补收文本；
 * - continue / restart：无补收（重派，档 2 经成员复用续写通道承接、档 3 新建）。
 */
export interface ResumeTierDecision { // oe-exempt:20260929:framework:tier-decision domain contract per design U2, type-first single-impl
  tier: ResumeTier;
  /** tier === "collect" 时的末轮 assistant 正文（text 块拼接）。 */
  collectedContent?: string;
}

/**
 * 档 1 提取边界（pi 0.84.4 实装锚点 pi-ai dist/types.d.ts:304-309，登记
 * PS-53）：assistant message.content 恒为 blocks 数组（TextContent |
 * ThinkingContent | ToolCall——text 块携带文本）；string 形态属 UserMessage
 * （content: string | (TextContent | ImageContent)[]），此处 string 分支为
 * 防御宽面（正常 assistant 流不命中）。
 * 提取口径 = type==='text' 块的 text 拼接（'' join）——与 session-reader
 * result-action「取 subagent 最终正文」同款口径（跨包无依赖边，口径一致性由
 * 两侧测试锁定）。thinking / toolCall / tool_result 块排除（推理噪音与工具协议
 * 帧不是正文）。无可提取文本 = undefined（调用方按档 2 处置）。
 */
export function extractAssistantTextContent(content: unknown): string | undefined {
  if (typeof content === "string") return content.length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  let text = "";
  for (const block of content) {
    const b = block !== null && typeof block === "object" ? (block as { type?: unknown; text?: unknown }) : undefined;
    if (b?.type === "text" && typeof b.text === "string") text += b.text;
  }
  return text.length > 0 ? text : undefined;
}

/**
 * 会话文件读取注入面（D8 判定的 IO 边）：默认实装 readFileSync；测试注入替换
 * 内容（档位判定的纯逻辑测试无需真实文件）。
 */
export type MemberSessionReader = (sessionFile: string) => string;

const defaultSessionReader: MemberSessionReader = (p) => readFileSync(p, "utf8");

/**
 * D8 档位判定（纯逻辑）：给定子代理会话文件内容，按「崩溃瞬间落盘状态」降档。
 *
 * 判据链（设计 §3.1 恢复三档图）：
 * - 尾部（跳过末尾非 message 元数据行）最后一条 message 是完整 assistant 且带
 *   可提取正文 → collect（档 1：回复完整落盘仅结果未回传，补收零 token）；
 * - 其余（末尾悬空 user prompt / toolResult / 半截行 / 纯工具调用 assistant /
 *   无 message）→ continue（档 2：请求未完成，同会话续写——pi 实装语义（待验证
 *   检查点 1 已核实，0.84.4 agent-session.js:892：prompt 路径新增 user 消息、
 *   不调 agent.continue()）= 悬空 prompt 原样留在上下文 + 新增续跑指令（两个
 *   连续 user 轮），不重发原文；上下文已在（cacheRead 低价），与设计档 2
 *   「只重花最后一次生成」效益吻合）。
 */
export function classifyResumeTierFromContent(content: string): ResumeTierDecision {
  const lines = content.split("\n");
  // 从尾向前找最后一条 message 行（跳过空行与 custom 元数据尾行——pi 会话尾部
  // 的 subagent-identity 等 custom 条目 parentId=null 非对话流节点，对齐
  // session-reader buildTreeView 的 leafId 判定形态）
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const parsed = tryParseJson(line);
    // 尾部半截行（活跃写入中断）：请求未完成 → 档 2
    if (parsed === undefined) return { tier: "continue" };
    if (typeof parsed !== "object" || parsed === null) continue;
    const rec = parsed as { type?: unknown; message?: { role?: unknown; content?: unknown } };
    if (rec.type !== "message" || typeof rec.message !== "object" || rec.message === null) {
      continue; // 元数据行（session/custom/compaction/label）继续向前找
    }
    if (rec.message.role === "assistant") {
      const text = extractAssistantTextContent(rec.message.content);
      // 纯工具调用轮（无 text 块）= 引擎在工具循环中崩溃，回复未完成 → 档 2
      return text !== undefined ? { tier: "collect", collectedContent: text } : { tier: "continue" };
    }
    // user（悬空 prompt）/ toolResult（工具结果后引擎死亡）→ 档 2
    return { tier: "continue" };
  }
  // 无任何 message（仅 header）：会话在但从未有回复 → 档 2（续写从既有上下文起步）
  return { tier: "continue" };
}

/** D8 档位判定（IO 包装）：读会话文件 → 纯逻辑判定；文件不存在/不可读 → 档 3。 */
export function classifyResumeTier(
  sessionFile: string | undefined,
  readSession: MemberSessionReader = defaultSessionReader,
): ResumeTierDecision {
  if (sessionFile === undefined || sessionFile === "") return { tier: "restart" };
  try {
    return classifyResumeTierFromContent(readSession(sessionFile));
  } catch {
    return { tier: "restart" };
  }
}

/** D8 判定的 per-call 结果（重派集成员逐个判档）。 */
interface TierPlanEntry { // oe-exempt:20260929:framework:tier plan entry domain contract per design U2
  taskIndex: number;
  agentName: string;
  /** 该 call 最后 agent-started 帧的 attempt（补收帧载荷）。 */
  lastAttempt: number;
  /** 子代理会话文件（同名 agent 最近 settled 帧的 result.sessionFile；无则档 3）。 */
  sessionFile: string | undefined;
  decision: ResumeTierDecision;
}

/**
 * 重派集 D8 判档：record 事件流 → 每个「有 started 无 settled」的 call 判档。
 *
 * 会话文件供源 = 同名 agentName 最近 agent-settled 帧的 result.sessionFile
 * （[D6] 绑定语义：同名 agent() 绑定同一子代理身份续写同一会话文件；路径随
 * result 全文落 record，无需跨层查 ExecutionRecord）。该 agent 从未有落定调用
 * （首次派发即崩）→ undefined（档 3 判据）。
 */
function planResumeTiers(
  events: readonly WorkflowRunEvent[],
  readSession: MemberSessionReader,
): TierPlanEntry[] {
  const nameByTask = new Map<number, string>();
  const lastAttemptByTask = new Map<number, number>();
  const settledTasks = new Set<number>();
  for (const event of events) {
    if (event.type === "agent-started") {
      nameByTask.set(event.taskIndex, event.agentName);
      lastAttemptByTask.set(event.taskIndex, event.attempt);
    } else if (event.type === "agent-settled") {
      settledTasks.add(event.taskIndex);
    }
  }
  // 同名 agent 最近 settled 帧的 sessionFile（倒序扫描，首个命中即最近）
  const lastSessionByAgent = new Map<string, string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== "agent-settled") continue;
    const name = nameByTask.get(event.taskIndex);
    if (name !== undefined && !lastSessionByAgent.has(name) && event.result?.sessionFile !== undefined) {
      lastSessionByAgent.set(name, event.result.sessionFile);
    }
  }
  const plan: TierPlanEntry[] = [];
  for (const [taskIndex, agentName] of nameByTask) {
    if (settledTasks.has(taskIndex)) continue; // 回放集，不判档
    const sessionFile = lastSessionByAgent.get(agentName);
    plan.push({
      taskIndex,
      agentName,
      lastAttempt: lastAttemptByTask.get(taskIndex) ?? 1,
      sessionFile,
      decision: classifyResumeTier(sessionFile, readSession),
    });
  }
  return plan;
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
 * 后锁残留 30s 可被 stale 夺取（待验证检查点 2 已核实实装语义）。重试短（2 次
 * / 100ms 起步）：锁被占 = 另一 resume 在途，语义是快速明确拒绝而非等待。
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
  /** 时钟注入（epoch ms）；缺省 Date.now()——run-resumed 帧 ts 与预算算式的确定性测试通道。 */
  now?: () => number;
  /** D8 会话文件读取注入（缺省 readFileSync）。 */
  readMemberSession?: MemberSessionReader;
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
  const lockTarget = `${recordPath.slice(0, -".record.jsonl".length)}.resume`;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(lockTarget, {
      realpath: false,
      stale: RESUME_LOCK_STALE_MS,
      retries: { retries: 2, factor: 2, minTimeout: 100, maxTimeout: 400 },
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
 * record 流绝对路径（resume 读面与锁文件同目录锚定）。测试防线（vitest 未注入
 * 目录 → runEventJournalPathOf 返回 undefined）下不可寻址 = 锁与读面都不可用，
 * 按「锁不可用即拒绝」保守拒绝（前提 2 降级语义）。
 */
function resolveRecordPath(runId: string, journalDir?: string): string {
  const anchor = journalDir !== undefined ? join(journalDir, `${runId}.record.jsonl`) : runEventJournalPathOf(runId);
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

/**
 * [resumeRunLocked 拆分] 资格校验（段 2）：run-created 帧 / interrupted 生命周期 /
 * D10 预算预检（场景 16：搁置不计，活跃已耗不退）。任一不过即拒绝（异常即返回值）。
 *
 * 预算预检与返回的 budgetTimeMs 均为「生效预算」（三档回落单点，见下方解析）——
 * 继承形态下原预算已耗尽同样拒绝，不把复活窗变成绕过预算的通道。
 */
function assertResumeEligibility(
  runId: string,
  recordPath: string,
  options: ResumeRunOptions | undefined,
): { events: WorkflowRunEvent[]; created: Extract<WorkflowRunEvent, { type: "run-created" }>; activeElapsedMs: number; budgetTimeMs: number | undefined } {
  const events = readRecordStreamStrict(recordPath, runId);
  const created = events.find(
    (e): e is Extract<WorkflowRunEvent, { type: "run-created" }> => e.type === "run-created",
  );
  const reject = (message: string): ResumeRejectionError => new ResumeRejectionError(message);
  if (created === undefined) {
    throw reject(
      `Resume rejected: record stream for run ${runId} has no run-created frame (the run never started, ` +
        "or the stream is truncated at the head). Recovery: verify the runId, or start a new run.",
    );
  }
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
  // 生效预算三档回落（单点，勿散）：显式 options 覆盖 > 最近一条 run-resumed 帧的
  // 生效值（跨崩溃存续——上次显式覆盖不因下次无参 resume 退回创建预算）> run-created
  // 记录的创建预算；三处都没有 = 不限时。本值同时供 D10 预检、首次挂表
  // （adoptResumedRun）、rebuildRunFromRecord 的 spec 与本次 run-resumed 帧消费——
  // 不出现第二处折算。旧格式帧（无字段）自然回落 run-created，行为不劣化。
  const lastResumed = findLatestRunResumed(events);
  const budgetTimeMs = options?.budgetTimeMs ?? lastResumed?.budgetTimeMs ?? created.budgetTimeMs;
  const activeElapsedMs = computeActiveElapsedMs(events);
  if (budgetTimeMs !== undefined && budgetTimeMs > 0 && activeElapsedMs >= budgetTimeMs) {
    throw reject(
      `Resume rejected: run ${runId} has exhausted its time budget (${Math.round(activeElapsedMs / MS_PER_SECOND)}s ` +
        `active of ${Math.round(budgetTimeMs / MS_PER_SECOND)}s — suspended time is not counted, spent active ` +
        "time is). Recovery: start a new run, or rerun with a larger budgetTimeMs.",
    );
  }
  return { events, created, activeElapsedMs, budgetTimeMs };
}

/**
 * [resumeRunLocked 拆分] 档 1 补收帧（段 5 尾，running × agent-settled 合法自环
 * ——补收事实入流，D1；幂等性：「run-resumed 落盘后、补收帧落盘前」崩溃 → 下次
 * resume 重判档 1 重新补收，会话文件仍在即幂等；时间窗内 record 无 settled 帧
 * 该 call 归重派集，无错档）。返回补收条数。
 */
async function dispatchTierCollectFrames(
  runId: string,
  tierPlan: readonly TierPlanEntry[],
  dispatchSource: { runId: string; journalDir?: string },
  now: () => number,
): Promise<number> {
  let collectCount = 0;
  for (const entry of tierPlan) {
    if (entry.decision.tier !== "collect" || entry.decision.collectedContent === undefined) continue;
    await dispatchRunTrigger(dispatchSource, {
      type: "agent-settled",
      taskIndex: entry.taskIndex,
      attempt: entry.lastAttempt,
      outcome: "done",
      durationMs: 0,
      result: {
        content: entry.decision.collectedContent,
        durationMs: 0,
        ...(entry.sessionFile !== undefined ? { sessionFile: entry.sessionFile } : {}),
      },
      ts: now(),
    });
    collectCount += 1;
    logger.warn(
      `[workflow] resume tier-1 collect: call #${entry.taskIndex} ("${entry.agentName}") result ` +
        `recovered from member session file without token spend (runId=${runId})`,
    );
  }
  return collectCount;
}

/**
 * [resumeRunLocked 拆分] 段 6：重建聚合 + D10 预算标记 + worker 接管 + pending 信号。
 * 补收帧落盘后重读全量流重建（帧的 seq 由 journal.append 分配——重读拿权威序）。
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
    resumedAt: number;
    collectCount: number;
    tierSummary: string | undefined;
  },
  now: () => number,
): void {
  noteRunResumedBudget(runId, summary.activeElapsedMs, summary.resumedAt);
  // 生效预算（summary.budgetTimeMs 与首次挂表同源）随 spec 落定——重试重建面读
  // run.spec.budgetTimeMs，本处不另算一遍
  const run = rebuildRunFromRecord(
    runId,
    created,
    readRecordStreamStrict(recordPath, runId),
    summary.budgetTimeMs,
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
      replayCalls: summary.events.filter((e) => e.type === "agent-settled").length + summary.collectCount,
      collectedCalls: summary.collectCount,
      rescheduledBudgetMs: remainingBudgetMs,
      tierSummary: summary.tierSummary,
    });
  } catch (err) {
    logger.error(
      `[workflow] resume post-adoption signal failed (runId=${runId}): ${toErrorMessage(err)} — ` +
        "the run itself is adopted and running; only the notification/log was lost",
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
  const { events, created, activeElapsedMs, budgetTimeMs } = assertResumeEligibility(runId, recordPath, options);

  // ── 2b. 派发前语法闸（第 4 道检查的 resume 侧）──
  // run-created 里的 scriptSource 是权威脚本文本；不可编译（顶层重声明宿主预声明名）
  // 时 Worker 启动后必然异步语法错 → 被重试矩阵吃满 MAX_WORKER_RETRIES 次才失败。
  // 此处先于段 4/5/6 的一切写动作拒绝（干净拒绝：run-resumed 未落、v2 条目未补、
  // run 仍 interrupted）。record 的脚本文本不可改 → 该 run 无法 resume，恢复动作 =
  // 修脚本后重派新 run（文案已含指引）。空脚本文本跳过（旧格式 record 无全文）。
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

  // ── 3. D8 三档判定（重派集判档；档 1 补收候选）──
  const tierPlan = planResumeTiers(events, options?.readMemberSession ?? defaultSessionReader);
  const tierSummary = summarizeTiers(tierPlan);

  // ── 4. v2 注册条目补写（裁决点 7：锁段内、先于复活事件，失败干净拒绝）──
  appendResumeRegisteredEntry(runId, deps, created, recordPath);

  // ── 5. run-resumed 落 record（interrupted → running）+ 档 1 补收帧 ──
  const dispatchSource = { runId, ...(options?.journalDir !== undefined ? { journalDir: options.journalDir } : {}) };
  const resumedAt = now();
  try {
    await dispatchRunTrigger(dispatchSource, {
      type: "run-resumed",
      ...(tierSummary !== undefined ? { reason: tierSummary } : {}),
      ...(options?.host !== undefined ? { host: options.host } : {}),
      // 本次复活实际生效的预算随帧落盘（跨崩溃存续的数据面）：仅 > 0 落字段——
      // 未设/0/负值不落（与 run-created 同款条件式），读取面按「最近一条
      // run-resumed 的字段 ?? run-created 的字段」回落
      ...(budgetTimeMs !== undefined && budgetTimeMs > 0 ? { budgetTimeMs } : {}),
      ts: resumedAt,
    });
  } catch (err) {
    // 让位（表外转移）仅在流被并发篡改时可达（锁段内无并发写者）——资格异常上抛，
    // 状态无损（run-resumed 未落，run 仍 interrupted 可重试）
    throw new ResumeRejectionError(
      `Resume rejected: run ${runId} could not record its resume transition: ${toErrorMessage(err)}. ` +
        "Recovery: re-check the run status; if the record stream was modified concurrently, inspect it " +
        "before retrying the resume.",
    );
  }
  const collectCount = await dispatchTierCollectFrames(runId, tierPlan, dispatchSource, now);

  // ── 6. 重建聚合 + D10 预算标记 + worker 接管 + pending 信号 ──
  // 补偿围栏：段 4/5 的失败都是干净拒绝（run-resumed 未落、状态无损），但本段在
  // run-resumed 帧 + 档 1 补收帧已落盘之后执行——接管失败若无补偿，record 流
  // fold=running 而进程内无活体无注册：run 可被 GUI/枚举发现却永不推进，且再次
  // resume 被资格校验以「actively running needs no resume」误拒（与实情相反）。
  // 回滚 = 清 D10 预算账目 + interruptRun 落 run-interrupted（running → interrupted
  // 表内合法转移、幂等），run 回到可重试 resume 的暂停态；回滚自身失败（journal IO
  // error）仅 error 留痕——兜底收敛 = 下次 session_start 的 recoverCrashedRuns 收编。
  // 原异常照常上抛（调用方报错给用户）。
  try {
    adoptResumedRun(runId, deps, created, recordPath, {
      events, activeElapsedMs, budgetTimeMs, resumedAt, collectCount, tierSummary,
    }, now);
  } catch (err) {
    // 回滚清账（D10）：noteRunResumedBudget 在段 6 首行写入（workerHost.start 之前）
    // ——接管失败即无活体消费该账目，残留会让后续按 runId 的预算折算读到已废弃的
    // 复活时刻；record 流是权威源，下次成功 resume 会重写覆盖。interruptRun 失败
    // （record 滞留 running 的僵尸形态）同样无活体，清账无条件先行。
    forgetRunResumedBudget(runId);
    try {
      await interruptRun(runId, {
        errorCode: "crashed",
        reason: `resume adoption failed: ${toErrorMessage(err)}`,
        ...(options?.journalDir !== undefined ? { journalDir: options.journalDir } : {}),
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
    throw err;
  }
  return runId;
}

/**
 * v2 注册条目补写（裁决点 7「resume 接管向发起 session 补写 v2 注册条目」）：
 * 锁段内、先于 run-resumed 落 record——失败干净拒绝（run-resumed 未落，run 保持
 * interrupted 无损）。幂等性：同 session 重复 resume 会重复追加条目——多一条引用
 * 无害（引用集判「任一存活 session 引用即保留」，重复条目不改变归属判定）。
 * journalPath 锚点 = recordPath 同源（防 journalDir 显式注入形态下锚点漂移到模块锚）。
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
    startedAt: created.ts,
    journalPath: recordPath,
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

/** D8 判档摘要（run-resumed 帧 reason 载荷 + 日志）：按档位聚合计数。 */
function summarizeTiers(plan: readonly TierPlanEntry[]): string | undefined {
  if (plan.length === 0) return undefined;
  const counts = new Map<ResumeTier, number>();
  for (const e of plan) counts.set(e.decision.tier, (counts.get(e.decision.tier) ?? 0) + 1);
  const label: Record<ResumeTier, string> = { collect: "collect(tier-1)", continue: "continue(tier-2)", restart: "restart(tier-3)" };
  return `resume dispatch plan: ${[...counts].map(([t, n]) => `${n} ${label[t]}`).join(", ")}`;
}

/**
 * record 事件流 → 复活聚合重建（对齐壳侧 foldRecordStreamToRun 的 fold 语义，
 * core 侧独立实装——该函数未导出且属壳 Infra 层；两侧行为等价由 resume 测试
 * 与壳 record-mode 测试共同锁定）。
 *
 * 回放集 = 有 agent-settled 帧的 taskIndex（含档 1 补收帧）——done + result 全文；
 * 重派集（有 started 无 settled）不建条目：worker 重跑脚本到断点处重新发
 * agent-call(callId=N) → dispatchAgentCall miss → 真实派发（D8 档 2/3 经成员
 * 复用通道续写/新建）。budget 按恢复语义最小形态（record 流不承载预算）；args
 * 从 run-created 帧的 args 全文恢复（设计 §3.1 载荷表，旧格式帧回落 argsSummary
 * 尽力恢复——见 parseArgsSummary）。
 */
/** call 重建中间形态（Trace 先建——traceNode 回链 D-10 引用共享；重派集成员不建 node——dispatchAgentCall 重派时 trace.append 自然落位，重建悬空节点只会与重派 append 重复）。 */
type CallDraft = { agentName: string; phase?: string; startedAtIso: string; attempts: number; result?: AgentResult; settledTs?: number; opts?: AgentCallOpts };

/** [rebuildRunFromRecord 拆分] 事件流 → call 重建中间形态（per taskIndex 聚合 started/settled 两帧）。 */
function collectCallDrafts(runId: string, events: readonly WorkflowRunEvent[]): Map<number, CallDraft> {
  const drafts = new Map<number, CallDraft>();
  for (const event of events) {
    if (event.type === "agent-started") {
      if (!drafts.has(event.taskIndex)) {
        drafts.set(event.taskIndex, {
          agentName: event.agentName,
          ...(event.phase !== undefined ? { phase: event.phase } : {}),
          startedAtIso: new Date(event.ts).toISOString(),
          attempts: event.attempt,
          ...(event.input !== undefined ? { opts: parseAgentInput(event.input) } : {}),
        });
      }
    } else if (event.type === "agent-settled") {
      applySettledFrameToDraft(runId, drafts, event);
    }
  }
  return drafts;
}

/** [collectCallDrafts 拆分] agent-settled 帧归并（settled 无 started 的残形态按 fold 自愈占位行处理）。 */
function applySettledFrameToDraft(
  runId: string,
  drafts: Map<number, CallDraft>,
  event: Extract<WorkflowRunEvent, { type: "agent-settled" }>,
): void {
  const existing = drafts.get(event.taskIndex);
  if (existing === undefined) {
    // [D12 宽松面留痕] settled 无 started 的残形态按 fold 自愈占位行处理
    // （不拒绝——对齐 run-events fold 兜底语义；严格拒绝面限坏行/seq 断档/
    // settled 缺 result 三项）。warn 出声：行级合法但配对异常 = 流被外部
    // 篡改或写入器 bug 的观测线索，静默会让该形态不可诊断。
    logger.warn(
      `[workflow] resume: agent-settled frame for call #${event.taskIndex} has no matching ` +
        `agent-started frame (runId=${runId}) — rebuilding as placeholder row "(unknown)" ` +
        "(fold self-heal semantics, not rejected)",
    );
  }
  const base: CallDraft =
    existing ?? { agentName: "(unknown)", startedAtIso: new Date(event.ts).toISOString(), attempts: event.attempt };
  base.attempts = event.attempt;
  base.result = event.result;
  base.settledTs = event.ts;
  drafts.set(event.taskIndex, base);
}

/** [rebuildRunFromRecord 拆分] 中间形态 → trace 节点（result.error 定 failed/completed 状态位）。 */
function draftsToTraceNodes(drafts: Map<number, CallDraft>): ExecutionTraceNode[] {
  return [...drafts.entries()].map(([taskIndex, d]) => ({
    stepIndex: taskIndex,
    agent: d.agentName,
    task: "",
    model: "",
    status: d.result?.error !== undefined ? "failed" : "completed",
    ...(d.phase !== undefined ? { phase: d.phase } : {}),
    startedAt: d.startedAtIso,
    ...(d.result !== undefined ? { result: d.result } : {}),
    ...(d.result?.error !== undefined ? { error: d.result.error } : {}),
    ...(d.settledTs !== undefined ? { completedAt: new Date(d.settledTs).toISOString() } : {}),
  }));
}

/** [rebuildRunFromRecord 拆分] 中间形态 → 回放集 AgentCall（done 终态直接构造）。 */
function draftsToReplayCalls(
  drafts: Map<number, CallDraft>,
  sharedNodes: Map<number, ExecutionTraceNode>,
  nodes: ExecutionTraceNode[],
): Map<number, AgentCall> {
  const calls = new Map<number, AgentCall>();
  for (const [taskIndex, d] of drafts) {
    // 重派集成员（result 缺省）不建条目：worker 重放脚本到断点处重新发
    // agent-call(callId=N) → dispatchAgentCall miss → 真实派发（D8 档 2/3 经
    // 成员复用通道续写/新建）。回放集直接构造 done 终态（bypass markRunning/
    // markDone 状态机守卫——重建已知良好持久态的既定先例）。
    if (d.result === undefined) continue;
    const linked = sharedNodes.get(taskIndex) ?? nodes.find((n) => n.stepIndex === taskIndex)!;
    // opts 恢复（[U13]）：agent-started 帧的入参全文（canonical 序列化，写点 =
    // dispatchAgentStarted）parse 回对象——detectReplayInputMismatch 的比对由此
    // 可比（worker 重放脚本重发同 callId 消息时，cached.opts 与本次 opts 走同一
    // canonical 哈希比对，非确定性漂移可检出）。旧格式帧无 input 载荷 → 落占位
    // {prompt:""}（比对跳过维持——结构性无可比数据面）。
    const call = new AgentCall(taskIndex, d.opts ?? { prompt: "" }, linked);
    call.attempts = d.attempts;
    call.status = "done";
    call.result = d.result;
    if (d.result.sessionFile !== undefined) call.sessionFile = d.result.sessionFile;
    if (d.result.sessionId !== undefined) call.sessionId = d.result.sessionId;
    calls.set(taskIndex, call);
  }
  return calls;
}

function rebuildRunFromRecord(
  runId: string,
  created: Extract<WorkflowRunEvent, { type: "run-created" }>,
  events: readonly WorkflowRunEvent[],
  budgetTimeMs?: number,
): WorkflowRun {
  const spec = {
    scriptSource: created.scriptSource ?? "",
    args: created.args ?? parseArgsSummary(created.argsSummary),
    scriptName: created.workflowName,
    // 锚定恢复：scriptPath 与 scriptSource/args 同为 run-created 帧恢复面（worker
    // 沙箱 eval 模式无 __dirname，模板脚本靠它定位 _shared 族共享件）；旧格式帧
    // 缺失回落空串，由模板脚本内建 fail-fast 拒绝（壳侧 foldRecordStreamToRun
    // 同款恢复，两侧行为等价由测试锁定）
    scriptPath: created.scriptPath ?? "",
    // 时间预算单源：调用方传入的「生效预算」（resume 显式覆盖，或继承 run-created
    // 帧的创建预算——assertResumeEligibility 单一折算点）。spec 带预算后 pump 的
    // 复活预算账本分支可达：错误重试重建按剩余活跃预算重排计时器（搁置不计），
    // 引擎侧 run.state.budget.maxTimeMs 投影与 fresh run 同形。undefined/<=0 不落
    // 字段 = 不限时（旧格式帧无该字段且未显式传 time 时与现状一致，不劣化）
    ...(budgetTimeMs !== undefined && budgetTimeMs > 0 ? { budgetTimeMs } : {}),
    ...(created.model !== undefined ? { model: created.model } : {}),
  };
  const drafts = collectCallDrafts(runId, events);
  const nodes = draftsToTraceNodes(drafts);
  const trace = Trace.fromArray(nodes);
  const sharedNodes = new Map(trace.toArray().map((n) => [n.stepIndex, n]));
  const calls = draftsToReplayCalls(drafts, sharedNodes, nodes);
  return WorkflowRun.reconstruct(
    runId,
    spec,
    {
      status: "running",
      // fresh run 的 Budget 同源（lifecycle.createRunningRun：maxTimeMs=spec.budgetTimeMs）
      // ——复活聚合形状与新建一致，避免展示/消费面按 maxTimeMs 判定时双形态。
      // [§2.1b] 计数不再归零：帧推导（agent-settled.result.usage 同一加权口径）重建
      // 已耗 tokens/cost/callCount——下界近似（中间失败尝试不在事件流，见
      // run-accounting.ts 头注）。
      budget: rebuildBudget(undefined, events, budgetTimeMs),
      calls,
      trace,
      errorLogs: [],
    },
    { startedAt: new Date(created.ts).toISOString() },
  );
}

/**
 * agent-started 帧 input 载荷 → AgentCallOpts 恢复（[U13]）。写点是
 * canonicalJsonStringify（dispatchAgentStarted），JSON.parse 往返后对象值级
 * 等于原 resolved.opts——回放比对两侧再走同一 canonical 哈希，形态对称成立。
 * 不可解析/非对象形态 = 流被篡改或写入器 bug：warn 留痕回落占位 opts（比对
 * 跳过——宁跳过不误报，对齐 detectReplayInputMismatch 的保守侧纪律）。
 */
function parseAgentInput(input: string): AgentCallOpts | undefined {
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as AgentCallOpts;
    }
  } catch (err) {
    // parse 异常细节记 debug（原始错误只在此可见）；warn 与非对象形态共用函数尾出口
    logger.debug("[workflow] resume: agent-started input JSON.parse failed", err);
  }
  logger.warn("[workflow] resume: agent-started input payload is not parseable opts — replay input check falls back to placeholder skip");
  return undefined;
}

/**
 * argsSummary → args 尽力恢复（旧格式帧回落通道）：现行写入面 run-created 帧
 * 携带 args 全文（rebuildRunFromRecord 优先消费）；本函数只服务旧格式帧（无
 * args 字段——设计 §3.1 载荷表落地前落盘的流）。未截断摘要可完整恢复；截断/
 * 不可解析回落空对象 + warn（旧格式流的 $ARGS 语义限制，留痕可诊断）。
 */
function parseArgsSummary(argsSummary: string | undefined): Record<string, unknown> {
  // [§3.2] 恢复规则单源（parseLegacyArgsSummary，与壳 jsonl-run-store 的旧格式回落
  // 同一实现）；本包装只补 core 侧日志文案。
  const { args, issue } = parseLegacyArgsSummary(argsSummary);
  if (issue === "truncated-summary") {
    logger.warn(
      "[workflow] resume: legacy run-created frame carries only a truncated argsSummary — $ARGS restored as {} " +
        "(legacy record stream predates the full-args payload; rerun with a fresh run if the script needs exact args)",
    );
  } else if (issue === "not-parseable" || issue === "not-object") {
    logger.warn("[workflow] resume: run-created argsSummary is not parseable JSON — $ARGS restored as {}");
  }
  return args;
}
