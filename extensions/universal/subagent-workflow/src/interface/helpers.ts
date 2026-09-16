/**
 * Workflow Extension — Interface helpers
 *
 * notifyDone(pi, runId, run, notified) — run 完成时发 completion notification
 * （[u9 账本化] 经 core NotifyLedger 四步生命周期，C-ext-19；未 bind 降级直发）。
 *
 * 层归属：Interface（依赖 Pi SDK + Engine WorkflowRun 模型）。
 *
 * 参考：domain-models.md §D-12。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardStaleCtx, toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

// bounded JSON pretty 序列化（IF13/#19，TC5/ES5）已下沉 core shared
// （u-core-atomic 逐字平移，输出与原本地实现字节一致；本地实现已删）。
// getBoundNotifyLedger：core 通知账本消费入口（bindNotifyLedgerHost 在
// session-lifecycle.ts session_start 装配；未 bind 时降级直发，见 notifyDone 注释）。
import { boundedPrettySerialize, getBoundNotifyLedger } from "@zhushanwen/subagent-core";

// 模块级 logger（与 session-lifecycle.ts / index.ts 同 component 名）
const logger = getLogger("subagents");

import type { WorkflowRun } from "@zhushanwen/subagent-core";
import {
  guiComponent,
  type GuiContext,
  type GuiRenderResult,
  guiResult,
  isGuiCapable,
} from "@zhushanwen/extension-protocol";
import { mapRunIcon, mapRunStatus } from "./gui-mappers.ts";

// ── 常量 ─────────────────────────────────────────────────────

const MAX_RESULT_LENGTH = 8000;

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

/** runId 前 8 字符用于显示（与 buildWorkflowGui 的 label 格式一致）。 */
const RUN_ID_DISPLAY_LENGTH = 8;

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
 * 对齐 notifier 内核降级路径；triggerTurn 单通道，deliverAs 已删——D5 单通道化）。
 *
 * **内存去重**：notifiedRunIds Set 由调用方（factory/extension instance）持有，
 * 同 runId 的重复收口回调在写账前即拦截（跨 session_shutdown 等边界防重复）；
 * 持久层幂等由账本 notifyId 承接（内存窗口挤出 / 重启后的重复仍被 record 拒绝）。
 *
 * @param pi ExtensionAPI（仅降级路径直发用）
 * @param runId run 标识
 * @param run WorkflowRun 聚合根（读 spec.scriptName + state.status + trace + scriptResult）
 * @param notifiedRunIds 去重 Set（调用方持有，scope 到 factory 实例）
 */
export function notifyDone(
  pi: ExtensionAPI,
  runId: string,
  run: WorkflowRun,
  notifiedRunIds: Set<string>,
  ctx?: GuiContext,
): void {
  if (notifiedRunIds.has(runId)) return;
  notifiedRunIds.add(runId);

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
  };

  // GUI 协议：RPC 模式下附加结构化渲染数据
  if (ctx && isGuiCapable(ctx)) {
    const reason = run.state.reason;
    const statusStr = `${run.state.status}${reason ? ` (${reason})` : ""}`;
    // label 对齐 buildWorkflowGui 的格式：name + slug + runId 前 8 字符（I#3）
    const slug = run.spec.slug;
    const label = [name, slug, runId.slice(0, RUN_ID_DISPLAY_LENGTH)]
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

  // [u9 账本化] ledger 在 → ①写账（record false = 同幂等键已在账/已销账——内存
  // 去重窗口挤出或重启恢复后的重复收口，跳过投递）→ ②attemptDeliver（courier
  // 边沿 + isIdle 二次复查，③销账 ④重放在 ledger 内；送达通道经
  // deliveryCustomType 保持 "workflow-result"）。stale ctx 防御由装配层
  // sendDelivery 内置（session-lifecycle.ts bindLedgerHostAndRecover），此处无需
  // 重复包裹。
  const ledger = getBoundNotifyLedger();
  if (ledger) {
    if (!ledger.record(details.notifyId, content, details, { deliveryCustomType: WORKFLOW_RESULT_CUSTOM_TYPE })) {
      return;
    }
    ledger.attemptDeliver();
    return;
  }

  // 降级：ledger 未装配（旧宿主 / 无账本测试）→ fire-once 直发（at-most-once）。
  // triggerTurn 单通道（deliverAs 已删——D5 单通道化：busy 场景的投递时机治理本就
  // 由账本路径承担，降级路径不再依赖 pi 内存队列的 steer 形态）；stale ctx 防御
  // （crash-resilience D1 / ext-guards 审计 §7 blockers#1 收口）：session 替换窗口
  // 触碰 stale pi 命中 assertActive（PS-30）即无人接 rejection 崩 pi（E1 同机制）。
  // stale 静默降级（完成通知不投递，用户可从 session 历史 / 工具结果看到 workflow
  // 结果，判定见 stale-ctx-audit.md §4），非 stale 错误原样上抛（守卫不吞真实 bug）。
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
 * 调用点：index.ts onRunDone 回调内、notifyDone 之后（notifyDone 内部已 add，
 * 此处 track 的 add 是幂等二次添加）。
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
