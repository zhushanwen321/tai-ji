import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { getLogger } from "@zhushanwen/pi-extension-logger";

import { registerPlanCommand } from "./command.js";
import { registerPlanEventHandlers } from "./compact.js";
import { isTaijiHost } from "./tool.js";
import {
  type PlanAbortControllers,
  type PlanResetEpochs,
  type PlanSessionMap,
  PLAN_CONTEXT_CUSTOM_TYPE,
  PLAN_MODE_TOOLS,
  applyPlanEvent,
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
  // reset 世代计数器（D3 连带段归口判别）：进程内存态禁入 entry（纪律①）；
  // 递增点 = resetPlanState 任何调用路径；session_shutdown 内存清理（纪律见 state.ts）
  const resetEpochs: PlanResetEpochs = new Map();

  // Register tool and command
  registerPlanTool(pi, sessions, abortControllers, resetEpochs);
  registerPlanCommand(pi, sessions, abortControllers, resetEpochs);

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

      // E3 按 state 查表恢复（D5/D9④）：挂起交互点（审批 select / 执行方式 form）随 pi
      // 进程消亡。本 hook 跑在 pi 懒重生之后（taiji 冷启动不拉 pi 进程——用户重开 session
      // 发首条消息时 pi 才重生、hook 才跑），此时冷启动扫描已恢复持久态但挂起交互不复存在
      //（上方 delete 已清残留 controller，pi 重生后不可能有存活的挂起）→ 按 state 查表
      // steer 恢复（恢复动作全部在 extension 侧，前端不造失败信号链；旧 entry 无 state 字段
      // 经 reconstructPlanState 的 reviewState 映射后同样落本表，D2 读方①）：
      // - reviewing：按宿主分流（F-W3-1，见分支内注释）；
      // - revising：继续按评论修订并重新提交（P1-1：原实现只覆盖 awaiting，revising
      //   崩溃后审批条恒显假「修订中」且无任何恢复指引）；
      // - dispatching（D5 E3 新支，覆盖现状自认的不可恢复窗口）：崩溃消散的表单即
      //   「无选择解散」极端形态——先走 review_aborted 边落 approved（批准事实保留，
      //   且使重调 complete 的 approve 边合法），再 steer 重调 complete 重新选执行方式。
      //   其余态（planning/approved/终态）不打扰（S16「重开 session 无 E3 重挂打扰」）。
      if (state.state === "reviewing") {
        // F-W3-1 审批条复活拦截（S8①/S2「stop 后不复活」+ D8/S6 恢复语义）：taiji GUI
        // 宿主下 E3 **不自动 steer 重挂**——steer triggerTurn 是无人值守自动重提通道
        // （pi 进程重启 → agent 自动 submit-review → 新 select 挂起 → 审批条复活，
        // 用户停止/搁置的审批在无任何用户输入介入时自己回来）。宿主形态只落
        // resumeHint='resubmit'：renderer degraded 分支（state=reviewing ∧ 无挂起，
        // PlanReviewBar）据此呈现「审批提问已随会话重启失效 + 重新提交审批」按钮，
        // 用户点击（= 用户输入介入）才重提——agent 侧 submit-review 对 reviewing 降级
        // 态的自环重挂照常放行，恢复触发权归用户。独立 pi（TUI）没有 degraded 按钮，
        // 自动重挂是唯一恢复路径（F8 死路防护），steer 保留。
        // 分流判定与 executeSubmitReview 的 E8 宿主分流同源（isTaijiHost + mode rpc）。
        if (!(isTaijiHost() && ctx.mode === "rpc")) {
          // D9④：E3 重挂是唯一「不重新思考」场景——steer 原样回传上轮 selfReview 全文，
          // 豁免只发生在「自审内容」（复用既有结论），不存在绕过「过门义务」的路径
          const carried =
            state.selfReview ?? "(none recorded — write a brief self-review before re-submitting)";
          pi.sendMessage(
            {
              customType: PLAN_CONTEXT_CUSTOM_TYPE,
              content:
                "[PLAN MODE] A previous review request was interrupted (session restarted). " +
                "The registered documents are still waiting for user approval. " +
                "The self-review for this exact document set is already done — carry it back VERBATIM as the selfReview parameter, no need to redo the thinking:\n\n" +
                `<self-review>\n${carried}\n</self-review>\n\n` +
                "Call plan(action='submit-review', selfReview='<the text above>') now to re-hang the review dialog.",
              display: false,
            },
            { deliverAs: "steer", triggerTurn: true },
          );
        }
        // E3 重挂即落 'resubmit' resumeHint + persist（此处原只发 steer 不落盘，renderer
        // 冷启动扫描的 View 恒无 hint、恒渲染通用文案；落盘后才能渲染「会话已重启，
        // 尚未重新提交」分支）。无条件覆盖既有 hint 为有意——「会话已重启」语义
        // 优先成立（P3-9 登记）；清除点 = submit-review 重挂起点（清除点三处之一）。
        // 宿主形态该 hint 即 degraded 分源文案的判定源（无 steer，按钮文案依赖它）。
        state.resumeHint = "resubmit";
        persistPlanState(pi, state);
      } else if (state.state === "revising") {
        pi.sendMessage(
          {
            customType: PLAN_CONTEXT_CUSTOM_TYPE,
            content:
              "[PLAN MODE] A revision round was interrupted (session restarted). The user's revision comments were already injected — continue handling them: rewrite the documents, re-register each revised document via plan(action='register-doc'), then re-submit via plan(action='submit-review', selfReview='<a fresh self-review for the revised documents>').",
            display: false,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
        // revising 恢复不落 resumeHint（'resubmit' 只描述 reviewing 降级等待；revising 由
        // steer triggerTurn 立即开轮接续，恢复期间显示的 revising 是真实进行中）
      } else if (state.state === "dispatching") {
        // review_aborted 边（D1：dispatching --review_aborted--> approved）+ steer 双动作：
        // 转移/落盘先于 steer，恢复后持久态与指示一致；ok:false（坏数据格）不落盘照常 steer
        const moved = applyPlanEvent(state, "review_aborted");
        if (moved.ok) persistPlanState(pi, state);
        pi.sendMessage(
          {
            customType: PLAN_CONTEXT_CUSTOM_TYPE,
            content:
              "[PLAN MODE] The plan was approved and the execution-method choice was interrupted (session restarted). " +
              "The approval stands. Re-initiate the execution-method choice by calling plan(action='complete') now. " +
              "Do not implement any changes before the user picks an execution method.",
            display: false,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
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
    // epoch 表随 abortControllers 同款内存清理（D3——无正确性依赖；注意 session_start
    // 不清该表：清掉已递增的槽会让在途归口的世代比较失真）
    resetEpochs.delete(sessionId);
  });
}
