/**
 * Workflow Extension — Interface helpers
 *
 * notifyDone(pi, runId, run, notified) — run 完成时发 completion notification。
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
import { boundedPrettySerialize } from "@zhushanwen/subagent-core";

// 模块级 logger（与 session-lifecycle.ts / index.ts 同 component 名）
const logger = getLogger("subagents");

import type { WorkflowRun } from "@zhushanwen/subagent-core";
import {
  guiComponent,
  type GuiContext,
  type GuiRenderResult,
  guiResult,
  isGuiCapable,
} from "@taiji/extension-protocol";
import { mapRunIcon, mapRunStatus } from "./gui-mappers.ts";

// ── 常量 ─────────────────────────────────────────────────────

const MAX_RESULT_LENGTH = 8000;

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
  __gui__?: GuiRenderResult;
}

/**
 * workflow 到达 done 终态时发送完成通知。
 *
 * 通过 pi.sendMessage 注入结果消息（含 __gui__ 结构化渲染数据），
 * triggerTurn:true 唤醒 parent agent 处理结果。
 *
 * **去重**：notifiedRunIds Set 由调用方（factory/extension instance）持有，
 * 同一 runId 只通知一次（跨 session_shutdown 等边界防重复）。
 *
 * @param pi ExtensionAPI（调 sendMessage）
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

 // deliverAs:"steer" + triggerTurn:true —— workflow 完成作为 steering 消息注入（g4-allow: 存量待迁移——结果语义通知，账本化迁移登记 pi-boundary-reliability 附录 B 待办）
 // 并立即唤醒 parent agent 处理结果（与 subagent 的 followUp+triggerTurn 对称）
  const details: WorkflowNotifyDetails = {
    runId,
    name,
    status: run.state.status,
    reason: run.state.reason,
    traceLength: traceNodes.length,
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

  // stale ctx 防御（crash-resilience D1 / ext-guards 审计 §7 blockers#1 收口）：
  // notifyDone 经 index.ts onRunDone 在 workflow 完成链路异步触发，不在 pi emit() 的
  // try/catch 内、无自有 try/catch——session 替换窗口触碰 stale pi 命中 assertActive
  // （PS-30）即无人接 rejection 崩 pi（E1 同机制）。stale 静默降级（完成通知不投递，
  // 用户可从 session 历史 / 工具结果看到 workflow 结果，判定见 stale-ctx-audit.md §4），
  // 非 stale 错误原样上抛（守卫不吞真实 bug）。
  guardStaleCtx(
    () =>
      pi.sendMessage(
        {
          customType: "workflow-result",
          content,
          display: true,
          details,
        },
        { triggerTurn: true, deliverAs: "steer" }, // g4-allow: 存量待迁移——workflow 完成通知属结果语义，迁移切片复用 U2 账本设施（附录 B 待办）
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
 *   被挤出窗口的旧 id 再经 notifyDone 会重新发送（runId 全局唯一，旧 id
 *   重现概率为零，该边界由 W3TC12 单测钉死）。
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
