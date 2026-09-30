/**
 * Workflow Extension — workflow 域通知生产
 *
 * notifyDone(pi, runId, run, notified) — run 完成时发 completion notification
 * （[u9 账本化] 经 core NotifyLedger 四步生命周期，C-ext-19；未 bind 降级直发）。
 *
 * [D7 载荷扩展] 终局必达通知的不变量面：成功含结果摘要与产物指针、失败含
 * errorCode 与证据指针、取消亦通知——载荷 outcome/errorCode/resultSummary/
 * artifactsDir/eventsJournalPath（details 层，content 追加指针段）。
 *
 * 层归属：workflow 域（与 workflow-events.ts 同层；唯一生产消费方 =
 * workflow-events.ts。原名 interface/helpers.ts，2026-09-24 名实归位——内容自始
 * 是通知生产而非 interface 注册面杂项）。
 *
 * 事件注册面：setupNotifyLedgerCompactionGuard（pi compaction 事件的 ledger
 * 补写守卫——notify 账本的家内事务，随跨域 handler 迁出从 workflow-events.ts
 * 装配 seam 原样搬入；注册时点仍由 setupWorkflowDomain 在原位调用）。
 */

import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { guardStaleCtx, toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

// bounded JSON pretty 序列化（IF13/#19，TC5/ES5）已下沉 core shared
// （u-core-atomic 逐字平移，输出与原本地实现字节一致；本地实现已删）。
// getBoundNotifyLedger：core 通知账本消费入口（bindNotifyLedgerHost 在
// session-lifecycle.ts session_start 装配；未 bind 时降级直发，见 notifyDone 注释）。
import {
  boundedPrettySerialize,
  getBoundNotifyLedger,
  isTerminalDoneReason,
  RUN_EVENTS_SUFFIX,
  type RunOutcome,
} from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
import { runSettledOutcomeToDoneReason, type RunSettlementRecord } from "./jsonl-run-store.ts";

// 模块级 logger（与 session-lifecycle.ts / index.ts 同 component 名）
const logger = getLogger("subagents");

import { WORKFLOW_RESULT_CUSTOM_TYPE } from "@zhushanwen/extension-protocol";

// ── 常量 ─────────────────────────────────────────────────────

const MAX_RESULT_LENGTH = 8000;

/** [D7] details.resultSummary 的截断上限（成功时的结果短摘要；全文摘要走 content
 *  的 Script Result 段 bounded 8000，载荷字段是消费方可编程读取的短形态）。 */
const MAX_RESULT_SUMMARY_LENGTH = 500;

/** 写账失败 error 留痕的 content 摘要截断长度（诊断定位用，非消费契约）。 */
const RECORD_FAIL_CONTENT_PREVIEW_LENGTH = 200;

/**
 * [D7] 事件 journal 文件名（run store 旁，artifactsDir 内）：`<runId>.events.jsonl`
 * （runId 即 generateRunId 的 wf- 前缀产物，渲染名 = 设计 D5 的 wf-<id>.events.jsonl；
 * 后缀经 core barrel 单源 RUN_EVENTS_SUFFIX，core 命名变更时编译期同步）。
 */
function runEventsJournalPath(artifactsDir: string, runId: string): string {
  return join(artifactsDir, `${runId}${RUN_EVENTS_SUFFIX}`);
}

/**
 * notifyDone 账本幂等键前缀（u9 账本化，对齐 C-ext-19）。键形态
 * `wf-done:<runId>`——一个 run 的收口通知只投递一次（写账 → courier 边沿投递 →
 * 回执销账 → 断连/重启经账本重放，幂等键去重不双投递）。前缀惯例承接 collect
 * 时代 `sync-batch:` 的「通道语义前缀 + 天然唯一标识」形态；导出供测试构造
 * 回执 entry 与账本断言复用同键。
 */
export const WORKFLOW_DONE_NOTIFY_ID_PREFIX = "wf-done:";

// workflow 收口通知的送达 customType 经 extension-protocol 单源
// （WORKFLOW_RESULT_CUSTOM_TYPE，与 shared/runtime/core 消费侧同源）：runtime
// event-interpreter 按该类型识别 run 完成并驱动 W18 workflow-record 失效信号
// （session.workflows 增量广播），taiji 完成通知 display 覆写 SSOT
// （COMPLETE_NOTIFY_CUSTOM_TYPES）亦按它收录——不可复用 subagent-bg-notify 通道。
// 等值/单源锁 = src/__tests__/contract.notify-custom-types.test.ts。

/**
 * notifiedRunIds 去重窗口大小。
 *
 * 最近该数量的已通知 runId 可去重，更旧挤出后不再去重——runId 全局唯一
 * （wf-<Date.now>-<rand>），旧 id 重现概率为零，语义无损。
 */
export const MAX_NOTIFIED_RUN_IDS = 1000;

// [D7] run 终局 outcome + DoneReason 派生：经 jsonl-run-store 的联合判别单点
//（[W2/V1 D1 第 7 行] 载荷源换终局记录——outcome/errorCode 帧直取、DoneReason
// 联合派生；原 extractFailureErrorCode 重提取链废弃——它与 core 帧生产链
// finalRunErrorCodeOf 值域本就不同，换源后通知码与 journal 码同源同值）。
// 漂移信号 = journal run-settled 帧出现词表外值时 core 自有用例先红。

/**
 * notifyDone 的 details 结构（通过 pi.sendMessage 透传给前端）。
 *
 * 抽取为显式接口替代裸 Record<string, unknown>。
 * 模块私有（原 export 已删）：无跨文件消费者，测试经 notifyDone 公共入口
 * 观察并内联类型。
 */
interface WorkflowNotifyDetails { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
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
 * （或账本幂等拒绝）后落下。**已知丢失面（如实登记）**：record 抛（reload 窗口
 * appendEntry assertActive 等）= 账本 entry 未写，而 notifyDone 的唯一调用点
 * onRunDone 每终态恰好一次、recoverFromSession 无源可重放——该终局通知**永久丢失**，
 * 仅 error 日志留痕（含 notifyId/content 摘要，供事后手工补偿）；根治需 pending-retry
 * 结构（设计变更，本轮不建，见加固审查报告）。持久层幂等由账本 notifyId 承接
 * （内存窗口挤出 / 重启后的重复仍被 record 拒绝）。
 *
 * @param pi ExtensionAPI（仅降级路径直发用）
 * @param runId run 标识
 * @param run WorkflowRun 聚合根（读 spec.scriptName + trace + scriptResult；status/reason/outcome 载荷源 = 终局记录 settlement——[W2/V1 D1 第 7 行] 换源，不读两态机字段）
 * @param notifiedRunIds 去重 Set（调用方持有，scope 到 factory 实例）
 * @param artifactsDir [D7] 产物目录指针（`<sessionDir>/workflow-state`，onRunDone
 *   桥注入；缺省 undefined = 旧调用兼容，载荷与文案指针段双双省略）
 */
/**
 * notifyDone 构建面（content + details 一次成型）。
 *
 * [W2/V1 D1 第 7 行] 载荷源换源：status 串 / reason / outcome / errorCode 全部
 * 取终局记录（settlement——与 run-settled 帧同源），不再读两态机字段（I2 失效
 * 窗口：活体写点删除后 state.reason 恒 undefined，原 I2 兜底载荷恒退 completed
 * 假成功——显式换源后删除）。trace/scriptResult 仍读聚合（非两态机字段）。
 *
 * content 段顺序：标题行 →（终止性原因非正常完成时）防偷懒收尾指令 →
 * （有 scriptResult 时）Script Result 段 → Agent Trace 段 →（artifactsDir 有时）
 * Artifacts 指针段。
 */
function buildDoneNotifyContent(
  run: WorkflowRun,
  runId: string,
  artifactsDir: string | undefined,
  settlement: RunSettlementRecord,
): { content: string; eventsJournalPath: string | undefined } {
  const traceNodes = run.state.trace.toArray();
  const name = run.spec.scriptName;
  const reason = runSettledOutcomeToDoneReason(settlement.outcome, settlement.errorCode);
  const status = `done (${reason})`;

  // 构建消息内容
  const parts: string[] = [];
  parts.push(`Workflow '${name}' done: ${status}`);

  // 终止性原因（非正常完成）追加防偷懒收尾指令——budget/time 耗尽或 abort 不是任务完成，
  // 模型可能把 "done" 当成功汇报（F3 偷懒完成）。收尾三步骤与 turn-limiter WRAP_UP_MESSAGE 对齐。
  // 判定经 core isTerminalDoneReason 单源（穷举 switch，DoneReason 新增成员 tsc 强制归类），
  // 输入 = 派生 DoneReason（载荷源换源后与原 state.reason 判据逐值等价——细分恢复使
  // 预算/超时终局不误命中/漏命中）。
  if (isTerminalDoneReason(reason)) {
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

  return { content: parts.join("\n"), eventsJournalPath };
}

/**
 * notifyDone 的 details 构建面（baseDetails 成型）。
 *
 * 送达通道保持 "workflow-result"（runtime W18 失效信号 + taiji display 覆写 SSOT
 * 按该类型识别；迁移不改变消息类型与文案字节，只改变投递可靠性机制）。
 */
function buildDoneNotifyDetails(
  run: WorkflowRun,
  runId: string,
  artifactsDir: string | undefined,
  eventsJournalPath: string | undefined,
  settlement: RunSettlementRecord,
): WorkflowNotifyDetails {
  const traceNodes = run.state.trace.toArray();
  const name = run.spec.scriptName;
  const reason = runSettledOutcomeToDoneReason(settlement.outcome, settlement.errorCode);
  const baseDetails: WorkflowNotifyDetails = {
    runId,
    name,
    status: "done",
    reason,
    traceLength: traceNodes.length,
    notifyId: `${WORKFLOW_DONE_NOTIFY_ID_PREFIX}${runId}`,
    // [W2/V1 D1 第 7 行] 终局必达载荷：outcome/errorCode 帧直取（与 run-settled
    // 帧同源——漂移判据 = core run-events 注释的「通知 outcome ≡ 帧 outcome」；
    // 换源后 engine 协议码族与 'unknown' 首次进入通知 errorCode 值域，消费方容忍
    // 已核对：bg-notify-render 不消费 errorCode，真实消费方按扩张值域透传）。
    outcome: settlement.outcome,
  };
  if (settlement.errorCode !== undefined) {
    baseDetails.errorCode = settlement.errorCode;
  }
  if (settlement.outcome === "done" && run.state.scriptResult !== undefined && run.state.scriptResult !== null) {
    baseDetails.resultSummary = boundedPrettySerialize(run.state.scriptResult, MAX_RESULT_SUMMARY_LENGTH);
  }
  if (artifactsDir !== undefined && eventsJournalPath !== undefined) {
    baseDetails.artifactsDir = artifactsDir;
    baseDetails.eventsJournalPath = eventsJournalPath;
  }

  return baseDetails;
}

/**
 * notifyDone 投递面：账本在 → 四步生命周期（写账 / courier 投递 / 销账 / 重放）；
 * 账本未装配 → fire-once 直发降级（stale ctx 静默）。见 notifyDone 主注释。
 */
function deliverDoneNotify(
  pi: ExtensionAPI,
  runId: string,
  notifiedRunIds: Set<string>,
  content: string,
  details: WorkflowNotifyDetails,
): void {
  const ledger = getBoundNotifyLedger();
  if (ledger) {
    // [u9 账本化] ledger 在 → ①写账（record false = 同幂等键已在账/已销账——内存
    // 去重窗口挤出或重启恢复后的重复收口，跳过投递）→ ②attemptDeliver（courier
    // 边沿 + isIdle 二次复查，③销账 ④重放在 ledger 内；送达通道经
    // deliveryCustomType 保持 "workflow-result"）。
    // 内存去重标记在写账**成功后**才落下。**已知丢失面（如实登记）**：record 抛
    // （reload 窗口 appendEntry 命中 assertActive 等）= 账本 entry 未写——onRunDone
    // 每终态恰好一次（无重复收口可重试）、账本无 entry 则 recoverFromSession 无源
    // 可重放，该终局通知**永久丢失**；不提前标记只是给进程内的假想重复收口留重试
    // 通道（防御形态，不改变丢失事实）。留痕与根治面见下方 catch 注释。
    // stale ctx 防御由装配层 sendDelivery 内置（session-lifecycle.ts
    // bindLedgerHostAndRecover），此处无需重复包裹。
    let recorded: boolean;
    try {
      recorded = ledger.record(details.notifyId, content, details, {
        deliveryCustomType: WORKFLOW_RESULT_CUSTOM_TYPE,
      });
    } catch (err) {
      // 写账抛错 = 该终局通知丢失（账面 entry 未写，无重放源）。error 级留痕含
      // notifyId 与 content 摘要，供事后按 run 手工补偿（从 run journal/manifest
      // 读取终态）。根治需 pending-retry 结构（设计变更，本轮不建，见加固审查报告）；
      // 原样上抛保持 finalizeRun 围栏的既有接住链路。
      logger.error(
        "workflow completion notice ledger record failed — this terminal notification is LOST (no ledger entry, no replay source); compensate manually from run artifacts",
        {
          runId,
          notifyId: details.notifyId,
          contentPreview: content.slice(0, RECORD_FAIL_CONTENT_PREVIEW_LENGTH),
          reason: toErrorMessage(err),
        },
      );
      throw err;
    }
    trackNotifiedRunId(notifiedRunIds, runId);
    if (recorded) ledger.attemptDeliver();
    return;
  }

  // 降级：ledger 未装配（旧宿主 / 无账本测试）→ fire-once 直发（at-most-once）。
  // triggerTurn 单通道（deliverAs 已删——u9 偏差裁决，D7 账本化配套：busy 场景的
  // 投递时机治理本就由账本路径承担，降级路径不再依赖 pi 内存队列的 steer 形态）；stale ctx 防御
  // （crash-resilience D1 / ext-guards 审计 §7 blockers#1 收口）：session 替换窗口
  // 触碰 stale pi 命中 assertActive（PS-30）即无人接 rejection 崩 pi（E1 同机制）。
  // stale 静默降级（完成通知不投递，用户可从 session 历史 / 工具结果看到 workflow
  // 结果，判定见 stale-ctx-audit.md §4），非 stale 错误原样上抛（守卫不吞真实 bug）。
  // 去重标记在实际发送**之后**落下：非 stale 瞬态发送失败（同步抛错上抛）后进程内
  // 仍可重试（去重不阻断）；stale 分支由 onStale 补标记保持现语义——stale = 通知对
  // 旧 session 已无意义，不重试。
  guardStaleCtx(
    () => {
      const sent = pi.sendMessage(
        {
          customType: WORKFLOW_RESULT_CUSTOM_TYPE,
          content,
          display: true,
          details,
        },
        { triggerTurn: true },
      );
      trackNotifiedRunId(notifiedRunIds, runId);
      return sent;
    },
    {
      label: "subagent-workflow:notifyDone",
      onStale: (error) => {
        trackNotifiedRunId(notifiedRunIds, runId);
        logger.warn("workflow completion notice delivery skipped (stale ctx)", {
          runId,
          error: toErrorMessage(error),
        });
      },
    },
  );
}

export function notifyDone(
  pi: ExtensionAPI,
  runId: string,
  run: WorkflowRun,
  notifiedRunIds: Set<string>,
  artifactsDir: string | undefined,
  settlement: RunSettlementRecord,
): void {
  if (notifiedRunIds.has(runId)) return;
  const { content, eventsJournalPath } = buildDoneNotifyContent(run, runId, artifactsDir, settlement);
  const details = buildDoneNotifyDetails(run, runId, artifactsDir, eventsJournalPath, settlement);
  deliverDoneNotify(pi, runId, notifiedRunIds, content, details);
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
 * 调用点：notifyDone 内部（写账成功/false 后 + 降级直发受理后）+ workflow-events
 * onRunDone 回调（notifyDone 之后，幂等二次添加）。notifyDone 抛出（reload 窗口
 * record 抛 / 非 stale 发送失败等）时内外都不标记——进程内的重复收口回调不被去重
 * 阻断（防御形态；账本路径抛错的已知丢失面登记见 notifyDone 注释）。
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

// ── notify 域事件注册（跨域 handler 迁入） ────────────────────────────────────

/**
 * compaction 后 notify ledger 补写守卫（注册 pi 的 session compaction 事件）。
 *
 * [U2 P-B4 降级] compaction 对 custom entry 保留行为实装未验证——检测 ledger/ack
 * entry 被 compaction 清除时按内存态补写（notify-ledger compactionCheck；未清除则
 * no-op）。内存态在 compaction 后仍活着，作为补写源；重启后的权威仍是两列 entry
 * 差集（内存不承担销账职责）。
 *
 * 归 notify 域：守卫对象是 NotifyLedger 的账面完整性（getBoundNotifyLedger 的
 * 家内事务），与 workflow 域事件族装配零数据耦合。由 setupWorkflowDomain 在
 * 原注册位置调用（pi.on 注册顺序逐位不变，
 * workflow-events.test.ts 锁定）。
 */
export function setupNotifyLedgerCompactionGuard(pi: ExtensionAPI): void {
  pi.on("session_compact", (_event: SessionCompactEvent, _ctx: ExtensionContext) => {
    try {
      const rewritten = getBoundNotifyLedger()?.compactionCheck() ?? 0;
      if (rewritten > 0) {
        logger.warn(`[subagents] notify ledger entries lost to compaction; rewrote ${rewritten} from memory`);
      }
    } catch (err) {
      logger.warn("[subagents] notify ledger compactionCheck failed", {
        reason: toErrorMessage(err),
      });
    }
  });
}
