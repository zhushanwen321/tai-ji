/**
 * Workflow Extension — Interface helpers
 *
 * notifyDone(pi, runId, run, notified) — run 完成时发 completion notification
 * （[u9 账本化] 经 core NotifyLedger 四步生命周期，C-ext-19；未 bind 降级直发）。
 *
 * [D7 载荷扩展] 终局必达通知的不变量面：成功含结果摘要与产物指针、失败含
 * errorCode 与证据指针、取消亦通知——载荷 outcome/errorCode/resultSummary/
 * artifactsDir/eventsJournalPath（details 层，content 追加指针段）。
 *
 * 层归属：Interface（依赖 Pi SDK + Engine WorkflowRun 模型）。
 */

import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardStaleCtx, toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

// bounded JSON pretty 序列化（IF13/#19，TC5/ES5）已下沉 core shared
// （u-core-atomic 逐字平移，输出与原本地实现字节一致；本地实现已删）。
// getBoundNotifyLedger：core 通知账本消费入口（bindNotifyLedgerHost 在
// session-lifecycle.ts session_start 装配；未 bind 时降级直发，见 notifyDone 注释）。
import { boundedPrettySerialize, getBoundNotifyLedger } from "@zhushanwen/subagent-core";
import type { DoneReason, WorkflowRun } from "@zhushanwen/subagent-core";

// 模块级 logger（与 session-lifecycle.ts / index.ts 同 component 名）
const logger = getLogger("subagents");

import {
  guiComponent,
  type GuiContext,
  type GuiRenderResult,
  guiResult,
  isGuiCapable,
} from "@zhushanwen/extension-protocol";
import { mapRunIcon, mapRunStatus } from "./gui-mappers.ts";
import { ID_PREVIEW_LENGTH } from "./id-preview.ts";

// ── 常量 ─────────────────────────────────────────────────────

const MAX_RESULT_LENGTH = 8000;

/** [D7] details.resultSummary 的截断上限（成功时的结果短摘要；全文摘要走 content
 *  的 Script Result 段 bounded 8000，载荷字段是消费方可编程读取的短形态）。 */
const MAX_RESULT_SUMMARY_LENGTH = 500;

/** 毫秒/分钟换算（stall 阈值与文案展示共用，禁魔法数）。 */
const MS_PER_MINUTE = 60_000;

/** [D6-2] stall 阈值缺省（分钟）：20 分钟（对齐 zcode 语义）。 */
const WORKFLOW_STALL_THRESHOLD_MINUTES = 20;

/** [D7] run 事件 journal 的文件名形态（core run-events P1a 钉死：`<runId>.events.jsonl`
 *  ——runId 即 generateRunId 的 wf- 前缀产物，渲染名 = 设计 D5 的 wf-<id>.events.jsonl；
 *  core 未从 barrel 导出文件名推导，本地镜像 + 上述锚点注释（漂移信号 = journal
 *  指针失效，core 命名变更时同批改）。 */
const RUN_EVENTS_JOURNAL_SUFFIX = ".events.jsonl";

/** [D7] 事件 journal 文件名（run store 旁，artifactsDir 内）。 */
function runEventsJournalPath(artifactsDir: string, runId: string): string {
  return join(artifactsDir, `${runId}${RUN_EVENTS_JOURNAL_SUFFIX}`);
}

/**
 * notifyDone 账本幂等键前缀（u9 账本化，对齐 C-ext-19）。键形态
 * `wf-done:<runId>`——一个 run 的收口通知只投递一次（写账 → courier 边沿投递 →
 * 回执销账 → 断连/重启经账本重放，幂等键去重不双投递）。前缀惯例承接 collect
 * 时代 `sync-batch:` 的「通道语义前缀 + 天然唯一标识」形态；导出供测试构造
 * 回执 entry 与账本断言复用同键。
 */
export const WORKFLOW_DONE_NOTIFY_ID_PREFIX = "wf-done:";

/**
 * workflow 收口通知的送达 customType。保持与账本化前一致：runtime
 * event-interpreter 按该类型识别 run 完成并驱动 W18 workflow-record 失效信号
 * （session.workflows 增量广播），taiji 完成通知 display 覆写 SSOT
 * （COMPLETE_NOTIFY_CUSTOM_TYPES）亦按它收录——不可复用 subagent-bg-notify 通道。
 */
const WORKFLOW_RESULT_CUSTOM_TYPE = "workflow-result";

/**
 * notifiedRunIds 去重窗口大小。
 *
 * 最近该数量的已通知 runId 可去重，更旧挤出后不再去重——runId 全局唯一
 * （wf-<Date.now>-<rand>），旧 id 重现概率为零，语义无损。
 */
export const MAX_NOTIFIED_RUN_IDS = 1000;

/**
 * [D7] run 终局 outcome 三态（core run-events ALL_RUN_OUTCOMES 词表镜像——barrel
 * 未导出该类型，本地封闭字面量联合 + 上方映射函数注释锚定；漂移信号 = journal
 * run-settled 帧出现词表外值时 core 自有用例先红）。
 */
type RunOutcome = "completed" | "failed" | "cancelled";

/**
 * [D7] DoneReason 六因 → RunOutcome 三态。与 core worker-message-pump 的
 * dispatchFinalRunSettle 同构映射（budget_limited/time_limited 是 run 怎么死的
 * 系统层失败 = failed；aborted 经 cancel-requested 控制事件 = cancelled）。core
 * 不能 import extension（workflow-state-root.ts 头注同款分层约束），双侧注释互指
 * ——漂移信号 = 通知 outcome 与 journal run-settled 帧 outcome 不一致。
 */
function mapDoneReasonToOutcome(reason: DoneReason): RunOutcome {
  switch (reason) {
    case "completed":
      return "completed";
    case "failed":
    case "budget_limited":
    case "time_limited":
    case "invalid_args":
      return "failed";
    case "aborted":
      return "cancelled";
  }
}

/**
 * [D7] 失败终局的结构化码提取：最后一个失败 call 的 failureKind
 * （AgentResult.failureKind，ask 级结构化词表）。与 core 的 run 级 errorCode 分工：
 * journal/manifest 的 run-settled errorCode 由 core dispatchFinalRunSettle 的
 * finalRunErrorCodeOf 单点生产（含 engine 协议码前缀提取，S2 死亡可诊断），本函数
 * 只服务终局通知载荷（取 ask 级 failureKind 单源）；core 不能 import extension
 * （workflow-state-root.ts 头注同款分层约束），通知码与 journal 码的词表同源性由
 * 双侧消费 RunErrorCode/AgentFailureKind 词表保证。无 ask 级失败帧时缺省，载荷
 * errorCode 缺省合法（reason 与 trace 承载诊断）。
 */
function extractFailureErrorCode(run: WorkflowRun): string | undefined {
  let code: string | undefined;
  for (const call of run.state.calls.values()) {
    const result = call.result;
    if (result !== undefined && result.error !== undefined && result.failureKind !== undefined) {
      code = result.failureKind;
    }
  }
  return code;
}

/**
 * notifyDone 的 details 结构（通过 pi.sendMessage 透传给前端）。
 *
 * 抽取为显式接口替代裸 Record<string, unknown>，明确 __gui__ 契约。
 * 模块私有（原 export 已删）：无跨文件消费者，测试经 notifyDone 公共入口
 * 观察并内联类型。
 */
interface WorkflowNotifyDetails {
  runId: string;
  name: string;
  status: string;
  reason: string | undefined;
  traceLength: number;
  /**
   * [u9] 账本幂等键（`wf-done:<runId>`）——回执匹配键（ledger checkReceipts 扫
   * 送达 custom_message entry 的 details.notifyId 判定销账）。携带在 details 不进
   * 文案（G4 字节锁定不受影响）。
   */
  notifyId: string;
  /**
   * [D7] 终局 outcome 三态（completed/failed/cancelled）——脚本层失败
   * （review-failure = outcome:completed + 脚本返回失败结论）与 run 自身怎么死的
   * （outcome:failed）在通知面可区分（D5 终态双维度语义）。
   */
  outcome: RunOutcome;
  /**
   * [D7] 失败时的结构化码（最后失败 ask 的 failureKind；无失败帧的 run 级死法
   * 缺省——见 extractFailureErrorCode）。completed/cancelled 恒缺省。
   */
  errorCode?: string;
  /**
   * [D7] 成功时的结果短摘要（scriptResult bounded 截断；全文走 content 的
   * Script Result 段）。
   */
  resultSummary?: string;
  /**
   * [D7] 产物目录指针：run 持久化产物所在目录绝对路径
   * （`<sessionDir>/workflow-state`——journal/manifest/.state 同目录；调用方经
   * onRunDone 桥注入，旧调用缺省 undefined）。
   */
  artifactsDir?: string;
  /**
   * [D7] 事件 journal 指针（`<artifactsDir>/wf-<runId>.events.jsonl`）——终局
   * 证据的入口载荷（D5-3 诊断引用落账的消费面）。
   */
  eventsJournalPath?: string;
  __gui__?: GuiRenderResult;
}

/**
 * workflow 到达 done 终态时发送完成通知。
 *
 * [u9 账本化] 结果语义通知接 core NotifyLedger 四步生命周期（C-ext-19：持久账本 +
 * notifyId 幂等，替代裸 steer fire-once——relay 瞬断不再丢通知）：
 *   ① 写账：ledger.record(`wf-done:<runId>`) 落盘（幂等键去重，同 run 跨重启
 *      不双投递）→ ② courier 边沿投递（settled 边沿 + isIdle 二次复查 + 120s
 *      看门狗，送达 customType 保持 "workflow-result"）→ ③ 回执销账 → ④ 断连/
 *      重启经 recoverFromSession at-least-once 重放（机制见 notify-ledger.ts）。
 * 账本未装配时（旧宿主 / 无 ledger 测试）降级为 fire-once 直发（at-most-once，
 * 对齐 notifier 内核降级路径；triggerTurn 单通道，deliverAs 已删——u9 偏差裁决，
 * D7 账本化配套）。
 *
 * **内存去重**：notifiedRunIds Set 由调用方（factory/extension instance）持有，
 * 同 runId 的重复收口回调拦截（跨 session_shutdown 等边界防重复）；标记在写账成功
 * （或账本幂等拒绝）后落下——record 抛（reload 窗口 appendEntry assertActive 等）
 * 不标记，异常由 finalizeRun 围栏接住后重复收口可重试，窗口内不永久丢通知；
 * 持久层幂等由账本 notifyId 承接（内存窗口挤出 / 重启后的重复仍被 record 拒绝）。
 *
 * @param pi ExtensionAPI（仅降级路径直发用）
 * @param runId run 标识
 * @param run WorkflowRun 聚合根（读 spec.scriptName + state.status + trace + scriptResult）
 * @param notifiedRunIds 去重 Set（调用方持有，scope 到 factory 实例）
 * @param ctx GuiContext（GUI 协议渲染载荷；可选）
 * @param artifactsDir [D7] 产物目录指针（`<sessionDir>/workflow-state`，onRunDone
 *   桥注入；缺省 undefined = 旧调用兼容，载荷与文案指针段双双省略）
 */
export function notifyDone(
  pi: ExtensionAPI,
  runId: string,
  run: WorkflowRun,
  notifiedRunIds: Set<string>,
  ctx?: GuiContext,
  artifactsDir?: string,
): void {
  if (notifiedRunIds.has(runId)) return;

  const traceNodes = run.state.trace.toArray();
  const name = run.spec.scriptName;
  const status = `${run.state.status}${run.state.reason ? ` (${run.state.reason})` : ""}`;

 // 构建消息内容
  const parts: string[] = [];
  parts.push(`Workflow '${name}' done: ${status}`);

 // 终止性原因（非正常完成）追加防偷懒收尾指令——budget/time 耗尽或 abort 不是任务完成，
 // 模型可能把 "done" 当成功汇报（F3 偷懒完成）。收尾三步骤与 turn-limiter WRAP_UP_MESSAGE 对齐。
  const TERMINAL_REASONS = new Set(["budget_limited", "time_limited", "aborted", "failed", "circular"]);
  if (run.state.reason && TERMINAL_REASONS.has(run.state.reason)) {
    parts.push("");
    parts.push(
      "This is NOT task completion. Summarize what was DONE and VERIFIED, list what remains " +
      "NOT DONE, and give the user the single most important next step.",
    );
  }

  if (run.state.scriptResult !== undefined && run.state.scriptResult !== null) {
    // M10: scriptResult 来自 worker 脚本返回值（用户可控），可能含循环引用导致 JSON.stringify 抛 TypeError
    // IF13(#19)：bounded 序列化（只生成会被保留的前缀；BigInt/循环引用整体回退
    // String(x) 与旧实现整串 catch 同款）——≤8000 与旧全量 pretty 逐字节一致，
    // >8000 与 .slice(0,8000)+标记 逐字节一致（等价测试锚定）
    const truncated = boundedPrettySerialize(run.state.scriptResult, MAX_RESULT_LENGTH);
    parts.push("");
    parts.push("--- Script Result ---");
    parts.push(truncated);
  }

  parts.push("");
  parts.push("--- Agent Trace ---");
  for (const node of traceNodes) {
    parts.push(`[${node.stepIndex}] ${node.agent}: ${node.status}`);
  }

  // [D7] 产物指针段（主 agent 可操作的下一步入口：结果/证据在哪）。artifactsDir
  // 缺省（旧调用兼容）整段省略，content 字节与既有形态一致。
  const eventsJournalPath =
    artifactsDir !== undefined ? runEventsJournalPath(artifactsDir, runId) : undefined;
  if (artifactsDir !== undefined && eventsJournalPath !== undefined) {
    parts.push("");
    parts.push("--- Artifacts ---");
    parts.push(`Artifacts dir: ${artifactsDir}`);
    parts.push(`Events journal: ${eventsJournalPath}`);
  }

  const content = parts.join("\n");

  // 送达通道保持 "workflow-result"（runtime W18 失效信号 + taiji display 覆写 SSOT
  // 按该类型识别；迁移不改变消息类型与文案字节，只改变投递可靠性机制）
  const details: WorkflowNotifyDetails = {
    runId,
    name,
    status: run.state.status,
    reason: run.state.reason,
    traceLength: traceNodes.length,
    notifyId: `${WORKFLOW_DONE_NOTIFY_ID_PREFIX}${runId}`,
    // [D7] 终局必达载荷：outcome 恒有（done ⟹ reason 有值，I2 不变式；防御缺省
    // completed 兜底只在异常形态生效）；errorCode/resultSummary/指针按终局形态。
    outcome: mapDoneReasonToOutcome(run.state.reason ?? "completed"),
  };
  if (run.state.reason === "failed") {
    const errorCode = extractFailureErrorCode(run);
    if (errorCode !== undefined) details.errorCode = errorCode;
  }
  if (run.state.reason === "completed" && run.state.scriptResult !== undefined && run.state.scriptResult !== null) {
    details.resultSummary = boundedPrettySerialize(run.state.scriptResult, MAX_RESULT_SUMMARY_LENGTH);
  }
  if (artifactsDir !== undefined && eventsJournalPath !== undefined) {
    details.artifactsDir = artifactsDir;
    details.eventsJournalPath = eventsJournalPath;
  }

  // GUI 协议：RPC 模式下附加结构化渲染数据
  if (ctx && isGuiCapable(ctx)) {
    const reason = run.state.reason;
    const statusStr = `${run.state.status}${reason ? ` (${reason})` : ""}`;
    // label 对齐 buildWorkflowGui 的格式：name + slug + runId 前 8 字符（I#3）
    const slug = run.spec.slug;
    const label = [name, slug, runId.slice(0, ID_PREVIEW_LENGTH)]
      .filter(Boolean)
      .join(" ");
    details.__gui__ = guiResult(
      guiComponent("list-tree", {
        items: [{
          label,
          status: mapRunStatus(statusStr),
          icon: mapRunIcon(statusStr),
        }],
      }),
    );
  }

  const ledger = getBoundNotifyLedger();
  if (ledger) {
    // [u9 账本化] ledger 在 → ①写账（record false = 同幂等键已在账/已销账——内存
    // 去重窗口挤出或重启恢复后的重复收口，跳过投递）→ ②attemptDeliver（courier
    // 边沿 + isIdle 二次复查，③销账 ④重放在 ledger 内；送达通道经
    // deliveryCustomType 保持 "workflow-result"）。
    // 内存去重标记在写账**成功后**才落下：record 抛（reload 窗口 appendEntry 命中
    // assertActive 等）时不标记——异常由 finalizeRun 围栏接住（不崩），账面 entry 未写，
    // 后续重复收口回调（adoption 快照重发等）可重试写账；提前标记会把「窗口内丢失」
    // 变成永久丢失（去重阻断 + 账本无 entry 不可重放）。stale ctx 防御由装配层
    // sendDelivery 内置（session-lifecycle.ts bindLedgerHostAndRecover），此处无需
    // 重复包裹。
    if (!ledger.record(details.notifyId, content, details, { deliveryCustomType: WORKFLOW_RESULT_CUSTOM_TYPE })) {
      trackNotifiedRunId(notifiedRunIds, runId);
      return;
    }
    trackNotifiedRunId(notifiedRunIds, runId);
    ledger.attemptDeliver();
    return;
  }

  // 降级：ledger 未装配（旧宿主 / 无账本测试）→ fire-once 直发（at-most-once）。
  // triggerTurn 单通道（deliverAs 已删——u9 偏差裁决，D7 账本化配套：busy 场景的
  // 投递时机治理本就由账本路径承担，降级路径不再依赖 pi 内存队列的 steer 形态）；stale ctx 防御
  // （crash-resilience D1 / ext-guards 审计 §7 blockers#1 收口）：session 替换窗口
  // 触碰 stale pi 命中 assertActive（PS-30）即无人接 rejection 崩 pi（E1 同机制）。
  // stale 静默降级（完成通知不投递，用户可从 session 历史 / 工具结果看到 workflow
  // 结果，判定见 stale-ctx-audit.md §4），非 stale 错误原样上抛（守卫不吞真实 bug）。
  trackNotifiedRunId(notifiedRunIds, runId);
  guardStaleCtx(
    () =>
      pi.sendMessage(
        {
          customType: WORKFLOW_RESULT_CUSTOM_TYPE,
          content,
          display: true,
          details,
        },
        { triggerTurn: true },
      ),
    {
      label: "subagent-workflow:notifyDone",
      onStale: (error) =>
        logger.warn("workflow completion notice delivery skipped (stale ctx)", {
          runId,
          error: toErrorMessage(error),
        }),
    },
  );
}

/**
 * 把 runId 纳入 notifiedRunIds 去重窗口，超 cap 时删最旧（契约 W3C2）。
 *
 * 职责拆分：**去重判定**留在 notifyDone 的 has 读（本体零改动），
 * 本函数只持**有界化**职责——返回 void，不引入双重去重判定语义。
 *
 * 语义：
 * - 幂等 add：Set.add 对已存在元素不改变其迭代位置（重复 track 同一 id，
 *   其「最旧」地位不变）。
 * - FIFO 有界：Set 迭代序=插入序，超 cap 时删迭代器首元素=最旧。
 *   被挤出窗口的旧 id 再经 notifyDone：内存层放行后由账本 notifyId 幂等兜底
 *   （[u9] record 同键拒绝——生产环境账本已 bind 时不会重发；无账本降级环境
 *   才会重新直发，runId 全局唯一，旧 id 重现概率为零，该边界由 W3TC12 单测
 *   在降级形态下钉死）。
 *
 * 调用点：notifyDone 内部（写账成功/false 后）+ workflow-events onRunDone 回调
 * （notifyDone 之后，幂等二次添加）。notifyDone 抛出（reload 窗口 record 抛等）时
 * 内外都不标记——去重不阻断，重复收口可重试写账（见 notifyDone 账本分支注释）。
 *
 * @param notifiedRunIds 去重 Set（调用方持有，scope 到 factory 实例）
 * @param runId run 标识
 * @param cap 窗口大小（默认 MAX_NOTIFIED_RUN_IDS）
 */
export function trackNotifiedRunId(
  notifiedRunIds: Set<string>,
  runId: string,
  cap: number = MAX_NOTIFIED_RUN_IDS,
): void {
  notifiedRunIds.add(runId);
  while (notifiedRunIds.size > cap) {
    const oldest = notifiedRunIds.values().next().value;
    if (oldest === undefined) break;
    notifiedRunIds.delete(oldest);
  }
}

/**
 * [D6-2] stall informational 通知：run 长时间无进展时告诉主 agent「仍在运行、
 * 无需干预、不自动终止」——「还在等 provider」与「死了」分开表达（对齐
 * ADR-0047「静默 ≠ 卡死」）。
 *
 * 与 notifyDone（终局必达）的通道差异是有意为之：
 * - **informational 语义**：不进 NotifyLedger（账本 = 必达 + triggerTurn 唤醒，
 *   at-least-once 重放——stall 是可丢失的进展提示，进账本会把「提示」升格为
 *   「必达打断」）；不传 triggerTurn（消息展示不唤醒主 agent turn）。
 * - **送达通道为新 customType "workflow-stall"**：不复用 "workflow-result"——
 *   runtime event-interpreter 按后者识别 run 完成驱动 W18 失效信号，stall 走
 *   同通道会被误判为终局。
 * - **恰好一次**由调用方承载（stallNotifiedRunIds Set，本函数不做去重——
 *   与 notifyDone 的 notifiedRunIds 同型分工）。
 *
 * stale ctx 防御与 notifyDone 降级路径同款（guardStaleCtx：stale 静默降级 +
 * warn 留痕；非 stale 错误原样上抛——调用方 tick 循环有兜底 catch）。
 *
 * @param pi ExtensionAPI（发送面）
 * @param runId run 标识
 * @param name 脚本名（文案）
 * @param stalledMs 已无进展的毫秒数（文案展示分钟）
 * @param lastProgressAt 最近进展时间戳 epoch ms（details 诊断面）
 */
export function notifyStall(
  pi: ExtensionAPI,
  runId: string,
  name: string,
  stalledMs: number,
  lastProgressAt: number,
): void {
  const stalledMinutes = Math.max(1, Math.round(stalledMs / MS_PER_MINUTE));
  const content =
    `Workflow '${name}' (${runId}) has shown no progress for about ${stalledMinutes} minutes. ` +
    "It is still running - no action is needed, and it will NOT be terminated automatically. " +
    'Inspect it via the workflow tool (action:"status") if you want details.';
  guardStaleCtx(
    () =>
      pi.sendMessage({
        customType: WORKFLOW_STALL_CUSTOM_TYPE,
        content,
        display: true,
        details: {
          runId,
          name,
          stalledMs,
          lastProgressAt,
          thresholdMs: WORKFLOW_STALL_THRESHOLD_MS,
        },
      }),
    {
      label: "subagent-workflow:notifyStall",
      onStale: (error) =>
        logger.warn("workflow stall notice delivery skipped (stale ctx)", {
          runId,
          error: toErrorMessage(error),
        }),
    },
  );
}

/** [D6-2] stall 阈值缺省：20 分钟（对齐 zcode 语义）。 */
export const WORKFLOW_STALL_THRESHOLD_MS = WORKFLOW_STALL_THRESHOLD_MINUTES * MS_PER_MINUTE;

/** [D6-2] stall 通知的送达 customType（新通道值——W18 失效信号互斥，见 notifyStall）。 */
export const WORKFLOW_STALL_CUSTOM_TYPE = "workflow-stall";
