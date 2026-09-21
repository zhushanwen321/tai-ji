import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { getLogger } from "@zhushanwen/pi-extension-logger";

import { registerPlanCommand } from "./command.js";
import { registerPlanEventHandlers } from "./compact.js";
import {
  type PlanAbortControllers,
  type PlanSessionMap,
  PLAN_CONTEXT_CUSTOM_TYPE,
  PLAN_MODE_TOOLS,
  persistPlanState,
  reconstructPlanState,
} from "./state.js";
import { registerPlanTool } from "./tool.js";
import { updatePlanWidget } from "./widget.js";

const logger = getLogger("pi-plan");

/**
 * D9 引导文案（约 60 token）：仅在 taiji 宿主注入。plan 模式是只读子集（读代码、产
 * 文档、不改源码），进入它不是危险操作——agent 可在合适时机**自行进入**（plan-mode-
 * agent-enter U1 后 enter 是 tool action，无需用户确认；用户随时可经 PlanModeBar 退出）。
 */
const PLAN_MODE_SUGGESTION_PROMPT =
  "\n\n" +
  "When the user's request involves large-scale refactoring, cross-module changes, or other high-risk modifications, " +
  "proactively enter plan mode yourself by calling plan(action='enter', requirement='<the task>', skills=[...relevant skills]). " +
  "Plan mode is read-only for source code: you explore and write plan documents, then the user reviews before implementation. " +
  "Do not ask for permission to enter — entering plan mode is safe and reversible (the user can exit anytime).";

export default function planExtension(pi: ExtensionAPI) {
  // Per-session state cache — keyed by sessionId
  const sessions: PlanSessionMap = new Map();
  // 挂起 select 的 per-session AbortController（E10：submit-review 审批 + complete
  // 执行方式选择两处共用注册表；发挂起 select 前 fresh，settled/重建/关闭即弃）
  const abortControllers: PlanAbortControllers = new Map();

  // Register tool and command
  registerPlanTool(pi, sessions, abortControllers);
  registerPlanCommand(pi, sessions, abortControllers);

  // Register compact/tree event handlers
  registerPlanEventHandlers(pi, sessions);

  // Reconstruct state on session start
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = reconstructPlanState(ctx);
    sessions.set(sessionId, state);
    // session 重建即弃旧 controller：挂起 select 只存在于 tool execute 进行中的
    // turn，pi 重生后不可能有存活的 select；残留的已 abort controller 禁止复用
    // （发起新挂起 select 会 fresh 新建，此处删除是防御性清理）
    abortControllers.delete(sessionId);
    updatePlanWidget(ctx, state);
    // If plan mode was active, re-restrict tools to the plan-mode set (includes bash — file-write constraints come from the injected plan mode prompt)
    if (state.isActive) {
      pi.setActiveTools(PLAN_MODE_TOOLS);

      // E3：审批 select 挂起期间 session 关闭/崩溃 → select 随 pi 进程消亡。
      // 本 hook 跑在 pi 懒重生之后（taiji 冷启动不拉 pi 进程——用户重开 session
      // 发首条消息时 pi 才重生、hook 才跑），此时冷启动扫描已恢复 reviewState=
      // awaiting 但挂起 select 不复存在（上方 delete 已清残留 controller，pi 重生
      // 后不可能有存活的 select）→ steer 提醒 agent 重调 submit-review 重新挂起
      // （恢复动作全部在 extension 侧，前端不造失败信号链）。
      if (state.reviewState === "awaiting") {
        pi.sendMessage(
          {
            customType: PLAN_CONTEXT_CUSTOM_TYPE,
            content:
              "[PLAN MODE] A previous review request was interrupted (session restarted). " +
              "The registered documents are still waiting for user approval. " +
              "Call plan(action='submit-review') now to re-hang the review dialog.",
            display: false,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
        // E3 重挂即落 'resubmit' 源标记 + persist（§3.4 降级两源：此处原只发 steer 不
        // 落盘，renderer 冷启动扫描的 View 恒无 source、恒渲染通用文案；落盘后才能
        // 渲染「会话已重启，尚未重新提交」分支）
        state.reviewStateSource = "resubmit";
        persistPlanState(pi, state);
      }
    }
  });

  // D9：AI 主动建议（轻量引导），仅 taiji 形态注入。
  // 信号用 TAIJI_AGENT_EXT_LOG 而非 TAIJI_RUNTIME_TOKEN——后者在 SPAWN_ENV 出站
  // deny list 被强制剥除（C-proc-09），pi 子进程 env 里恒不可见，照抄即引导
  // 静默失效且诱导实施者动 deny list 造成安全回归；前者由 taiji runtime 对托管
  // pi 恒注入（rpc-client buildPiOutboundEnv）。独立 pi（信号缺失）不注入——
  // universal 包语义不变。
  pi.on("before_agent_start", (event: BeforeAgentStartEvent): BeforeAgentStartEventResult | undefined => {
    if (process.env.TAIJI_AGENT_EXT_LOG !== "1") return undefined;
    // Never block the agent loop（system-prompt extension 同款先例）
    try {
      return { systemPrompt: event.systemPrompt + PLAN_MODE_SUGGESTION_PROMPT };
    } catch (error) {
      const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      // 注入失败只损失一句引导，不值得中断 agent loop——先走 extension-logger 落盘
      // （~/.pi/agent/logs/ 文件通道，诊断可见）；logger 自身抛错才降级 stderr
      // （system-prompt logHookFailure 同款形态：logger 首选、stderr 内层兜底）
      try {
        logger.warn("plan: before_agent_start injection failed", { error: msg });
      } catch (nestedErr) {
        try {
          process.stderr.write(`[pi-plan] before_agent_start injection log also failed: ${String(nestedErr)}\n`);
        } catch (finalErr) {
          // 完全静默：两层兜底都失败时无处可写
          void finalErr;
        }
      }
      return undefined;
    }
  });

  // Clean up on session end
  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    sessions.delete(sessionId);
    abortControllers.delete(sessionId);
  });
}
