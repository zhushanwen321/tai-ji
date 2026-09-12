// src/interface/subagents.ts
//
// /subagents 命令。薄壳——打开 list overlay（等同原 /subagents list [<id>]）。
//
// 解析：args[0] 直接作可选 <id>（聚焦该 record）。
// RPC 模式（xyz-agent GUI）：解析 cancel/message/start action 直接执行，不打开 TUI。
// message/start 为 GUI 定向消息通道（设计 §3.3.3）：GUI 经 client.prompt 短路
// extension 命令（不经主 agent LLM），TUI 分支不消费这两个 verb（行为零变化）。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { getSubagentService } from "@zhushanwen/subagent-core";
import type { SubagentService } from "@zhushanwen/subagent-core";
import { displayAgentName } from "@zhushanwen/subagent-core";
import { messageHandler, startHandler } from "./subagent-actions.ts";
import { parseSubagentRpcCommand } from "./command-actions.ts";
import type { SubagentRpcAction } from "./command-actions.ts";
import { LIST_LIMIT } from "./list-shared.ts";
import { createSubagentsView } from "./list-view.ts";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

/**
 * subagent-directive custom_message 的 customType。
 *
 * 定向消息留痕载体（设计 §3.3.3）：message/start 成功派发后落主 session 的
 * custom_message entry，一 entry 双消费——
 * 1. 主 agent 上下文（custom_message 进 context，主 agent 下次 turn 可见定向对话）
 * 2. renderer 定向气泡渲染源（§3.3.3a live/reload 双链路，后续 wave 消费）
 * 字段形状是 GUI 契约，改动需与 renderer 侧同步。
 */
export const SUBAGENT_DIRECTIVE_CUSTOM_TYPE = "subagent-directive";

/** subagent-directive entry 的 details 形状（GUI 定向气泡渲染契约）。 */
export interface SubagentDirectiveDetails {
  subagentId: string;
  slug: string;
  /** 消息方向：'user' = 用户 → subagent 定向（当前唯一方向，命名预留双向扩展）。 */
  direction: "user";
}

/**
 * 定向消息留痕：向主 session 落 subagent-directive custom_message entry。
 *
 * 按主 agent streaming 状态分流 sendMessage options。pi 0.84.4 sendCustomMessage
 * 实装（agent-session.js）：isStreaming 且无 deliverAs 时默认 agent.steer()——会把
 * 定向消息注入正在运行的主 agent LLM turn，违反「不经主 agent LLM 直达 subagent」。
 * 故按调用时刻的权威 streaming 状态（ctx.isIdle()，与 sendCustomMessage 内部
 * isStreaming 判据精确互补，含 agent_end 后 retry/continuation 窗口）分流：
 * - streaming（isMainAgentIdle=false）：传 { deliverAs: "nextTurn" }——消息入（g4-allow: 交互注入——GUI 定向消息留痕分流，非结果语义通知）
 *   pi 内存 _pendingNextTurnMessages 队列，下个 turn 注入主 agent 上下文；不打断、
 *   不 steer 当前 turn。注意：该队列不落 entry，留痕延迟到下个 turn
 * - 非 streaming（isMainAgentIdle=true）：不传 options——立即 append entry 留痕
 *   + message_start/end 双发（renderer live 链路即时可见，现状行为）
 * 两者都不传 triggerTurn——不产生新 turn（§3.3.8「留痕 ≠ 处理」的结构性保证）；
 * display:false 使 pi TUI 不渲染该 entry（GUI 侧由 §3.3.3a 定向气泡通路渲染）。
 */
function emitSubagentDirective(
  pi: Pick<ExtensionAPI, "sendMessage">,
  details: SubagentDirectiveDetails,
  text: string,
  isMainAgentIdle: boolean,
): void {
  pi.sendMessage(
    {
      customType: SUBAGENT_DIRECTIVE_CUSTOM_TYPE,
      content: text,
      display: false,
      details,
    },
    isMainAgentIdle ? undefined : { deliverAs: "nextTurn" }, // g4-allow: 交互注入——/subagents GUI 定向消息留痕，非结果语义（C-ext-19 禁令边界，见 emitSubagentDirective JSDoc）
  );
}

/** RPC cancel 执行体（行为等价拆分自 handler，复杂度治理）。 */
async function rpcCancel(
  service: SubagentService,
  recordId: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const ok = service.cancel(recordId);
    ctx.ui.notify(
      ok ? `Cancelled subagent ${recordId}` : `Subagent ${recordId} not found or already finished`,
      ok ? "info" : "warning",
    );
  } catch (err) {
    // service.cancel 内部 assertReady 在 session_shutdown 并发 dispose 时会抛
    const msg = toErrorMessage(err);
    ctx.ui.notify(`Failed to cancel subagent ${recordId}: ${msg}`, "warning");
  }
}

/** RPC message 执行体（行为等价拆分自 handler，复杂度治理）。 */
async function rpcMessage(
  pi: ExtensionAPI,
  service: SubagentService,
  recordId: string,
  text: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  // GUI 定向消息（设计 §3.3.3）：不经主 agent LLM 直达 subagent。
  // one-shot 首条 message 自动升级 chatMode 的机制在 messageHandler 内（勿在此重复）。
  try {
    const result = await messageHandler(service, {
      subagentId: recordId,
      text,
    });
    // 留痕（§3.3.3）：成功派发后才留痕——失败时不留痕，GUI 按 toast 错误重发。
    // ctx.isIdle() 按调用时刻分流（streaming → nextTurn 队列延迟留痕，见
    // emitSubagentDirective JSDoc），保证任何时刻都不 steer 主 agent 当前 turn
    emitSubagentDirective(
      pi,
      { subagentId: result.subagentId, slug: result.slug, direction: "user" },
      text,
      ctx.isIdle(),
    );
    ctx.ui.notify(`Message delivered to subagent ${result.slug} (${result.subagentId})`, "info");
  } catch (err) {
    const msg = toErrorMessage(err);
    ctx.ui.notify(`Failed to message subagent ${recordId}: ${msg}`, "warning");
  }
}

/** RPC start 执行体（行为等价拆分自 handler，复杂度治理）。 */
async function rpcStart(
  pi: ExtensionAPI,
  service: SubagentService,
  slug: string,
  task: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  // GUI 定向新建（设计 §3.3.3）：conversation 固定 true（GUI 定向对话场景需要可续聊）
  try {
    const result = await startHandler(
      service,
      {
        slug,
        task,
        conversation: true,
      },
      // RPC 命令无外层 AbortSignal（GUI 请求生命周期不映射到 subagent 取消——
      // start 是 detached 后台语义，取消走 /subagents cancel）
      undefined,
    );
    emitSubagentDirective(
      pi,
      { subagentId: result.subagentId, slug: result.slug, direction: "user" },
      task,
      ctx.isIdle(),
    );
    ctx.ui.notify(`Started subagent ${result.slug} (${result.subagentId})`, "info");
  } catch (err) {
    const msg = toErrorMessage(err);
    ctx.ui.notify(`Failed to start subagent ${slug}: ${msg}`, "warning");
  }
}

/**
 * RPC 模式（xyz-agent GUI）：解析后的 action 分发执行，不打开 TUI。
 * 行为等价拆分自 handler（fallow 圈复杂度 21 > 15）：三个执行体
 * （cancel/message/start）各自成函数，本函数只做 switch 分发 +
 * usage notify + exhaustiveness 断言。
 */
async function executeRpcAction(
  pi: ExtensionAPI,
  service: SubagentService,
  parsed: SubagentRpcAction,
  ctx: ExtensionCommandContext,
): Promise<void> {
  switch (parsed.action) {
    case "cancel":
      await rpcCancel(service, parsed.recordId, ctx);
      return;
    case "cancel-missing-id":
      ctx.ui.notify("Usage: /subagents cancel <id>", "warning");
      return;
    case "message":
      await rpcMessage(pi, service, parsed.recordId, parsed.text, ctx);
      return;
    case "message-missing-args":
      // 错误可操作：指明缺什么 + 完整 usage（全局规则 16）
      ctx.ui.notify(
        parsed.missing === "recordId"
          ? "Usage: /subagents message <recordId> <text> — recordId is missing"
          : "Usage: /subagents message <recordId> <text> — text is missing",
        "warning",
      );
      return;
    case "start":
      await rpcStart(pi, service, parsed.slug, parsed.task, ctx);
      return;
    case "start-missing-args":
      ctx.ui.notify(
        parsed.missing === "slug"
          ? "Usage: /subagents start <slug> <task> — slug is missing"
          : "Usage: /subagents start <slug> <task> — task is missing",
        "warning",
      );
      return;
    case "noop":
      // 无 action 或未知 action：GUI 端已屏蔽此 command 入口，此处兜底
      ctx.ui.notify("View subagents in the sidebar Agents tab", "info");
      return;
    default: {
      // exhaustiveness 断言：未来新增 action verb 忘加 case 时 tsc 报错
      const _exhaustive: never = parsed;
      throw new Error(`Unhandled subagent RPC action: ${String(_exhaustive)}`);
    }
  }
}

/** 注册 /subagents 命令（= list overlay）。 */
export function registerSubagentsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("subagents", {
    description: "Subagents: /subagents [<id>] | /subagents cancel <id>",
    getArgumentCompletions(prefix: string) {
      const trimmed = prefix.trimStart();
      const parts = trimmed.split(/\s+/).filter(Boolean);

      // 第一级：cancel 动词（带尾随空格，选中后继续补 record id）
      if (parts.length <= 1) {
        return [
          { label: "cancel", value: "cancel ", description: "Cancel a running subagent" },
        ].filter((opt) => opt.label.startsWith(trimmed.toLowerCase()));
      }

      // 第二级：cancel 后补全当前 session 的 record id
      if (parts[0] === "cancel") {
        try {
          const service = getSubagentService();
          if (!service) return null;
          // collectRecords 合并内存(running) + 磁盘重建 record，按 rootSessionId 过滤。
          // cancel 只对 running 有效，但全部列出便于用户辨认（终态 record 会被 service 拒绝）。
          const records = service.queries.collectRecords(LIST_LIMIT);
          if (records.length === 0) return null;
          return records.map((r) => ({
            label: r.id,
            value: r.id,
            description: `${displayAgentName(r.agent)} [${r.status}]`,
          }));
        } catch {
          // 拿不到运行时数据（service disposed 等）→ 静默降级，补全失败不影响 command
          return null;
        }
      }
      return null;
    },
    handler: async (argsStr: string, ctx: ExtensionCommandContext) => {
      const service = getSubagentService();
      if (!service) {
        ctx.ui.notify("subagents execution runtime not ready (session not started)", "error");
        return;
      }

      // ── RPC 模式（xyz-agent GUI）：解析 action 直接执行，不打开 TUI ──
      // hasUI 在 TUI 和 RPC 都为 true，不能用于区分；用 ctx.mode === "rpc" 判定 GUI 通道。
      if (ctx.mode === "rpc") {
        await executeRpcAction(pi, service, parseSubagentRpcCommand(argsStr), ctx);
        return;
      }

      // ── print/json 模式（headless）：不可交互 ──
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/subagents requires interactive mode", "error");
        return;
      }

      // ── TUI 模式：打开 list overlay（原逻辑不变）──
      const args = argsStr.trim().split(/\s+/).filter(Boolean);
      await createSubagentsView(service, ctx.ui.theme, ctx, args[0]);
    },
  });
}
