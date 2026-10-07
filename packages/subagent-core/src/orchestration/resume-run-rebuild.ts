// src/orchestration/resume-run-rebuild.ts
//
// [U2]（workflow-run-resume-revision）resume 恢复链的重建轴：record 事件流 →
// 复活聚合 WorkflowRun 的纯投影重建（消费方 = resume-run.ts adoptResumedRun，
// 编排面与重建面按轴分层——同 record-store 三轴拆分先例）。

import { getLogger } from "../core/logger.ts";

import { AgentCall } from "./models/agent-call.ts";
import type { AgentCallOpts, AgentResult, ExecutionTraceNode } from "./models/types.ts";
import { Trace } from "./models/trace.ts";
import { WorkflowRun } from "./models/workflow-run.ts";
import { parseLegacyArgsSummary, type WorkflowRunEvent } from "./run-events.ts";
import { rebuildBudget } from "./run-accounting.ts";

const logger = getLogger("subagents");

/**
 * record 事件流 → 复活聚合重建（对齐壳侧 foldRecordStreamToRun 的 fold 语义，
 * core 侧独立实装——该函数未导出且属壳 Infra 层；两侧行为等价由 resume 测试
 * 与壳 record-mode 测试共同锁定）。
 *
 * 回放集 = 有 agent-settled 帧的 taskIndex——done + result 全文（[ADR-0092]：结果只来自已提交，
 * 恢复链不合成补收帧）；
 * 重派集（有 started 无 settled）不建条目：worker 重跑脚本到断点处重新发
 * agent-call(callId=N) → dispatchAgentCall miss → 真实派发（D8 档 2/3 经成员
 * 复用通道续写/新建）。budget 双轴按生效值恢复（时间预算挂计时器重排、token
 * 预算挂引擎 maxTokens 投影）；args 从 run-created 帧的 args 全文恢复（设计 §3.1
 * 载荷表，旧格式帧回落 argsSummary 尽力恢复——见 parseArgsSummary）。
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

export function rebuildRunFromRecord(
  runId: string,
  created: Extract<WorkflowRunEvent, { type: "run-created" }>,
  events: readonly WorkflowRunEvent[],
  budgetTimeMs?: number,
  budgetTokens?: number,
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
    // token 预算单源（与时间轴同构）：生效值随 spec 落定，引擎侧 maxTokens 投影
    // （createRunningRun / worker-host budget 注入读 spec.budgetTokens）与 fresh
    // run 同形。undefined/<=0 不落字段 = 不限制
    ...(budgetTokens !== undefined && budgetTokens > 0 ? { budgetTokens } : {}),
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
      // fresh run 的 Budget 同源（lifecycle.createRunningRun：maxTokens=spec.budgetTokens、
      // maxTimeMs=spec.budgetTimeMs）——复活聚合形状与新建一致，避免展示/消费面按
      // maxTimeMs/maxTokens 判定时双形态。
      // [§2.1b] 计数不再归零：帧推导（agent-settled.result.usage 同一加权口径）重建
      // 已耗 tokens/cost/callCount——下界近似（中间失败尝试不在事件流，见
      // run-accounting.ts 头注）。
      budget: rebuildBudget(undefined, events, budgetTimeMs, budgetTokens),
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
