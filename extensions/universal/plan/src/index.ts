import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { registerPlanCommand } from "./command.js";
import { registerPlanEventHandlers } from "./compact.js";
import {
  PLAN_CONTEXT_CUSTOM_TYPE,
  PLAN_MODE_TOOLS,
  applyPlanEvent,
  createPlanCtx,
  isTaijiGuiHost,
  persistPlanState,
  reconstructPlanState,
} from "./state.js";
import { registerPlanTool } from "./tool.js";
import { updatePlanWidget } from "./widget.js";

export default function planExtension(pi: ExtensionAPI) {
  // 单 ctx 对象（D-B4-3）：states（per-session 生命周期态缓存）+ controllers（挂起
  // select 注册表——E10：submit-review 审批 + complete 执行方式选择两处共用；值 =
  // PendingSelect 含解散来源槽位，D-B1-2；发挂起 select 前 fresh，settled/重建/关闭
  // 即弃）两表收敛 + dissolveAll 解散方法（exitPlanMode 入口经它打 'self' 标）
  const planCtx = createPlanCtx();

  // Register tool and command
  registerPlanTool(pi, planCtx);
  registerPlanCommand(pi, planCtx);

  // Register compact/tree event handlers
  registerPlanEventHandlers(pi, planCtx.states);

  // Reconstruct state on session start
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = reconstructPlanState(ctx);
    planCtx.states.set(sessionId, state);
    // session 重建即弃旧 controller：挂起 select 只存在于 tool execute 进行中的
    // turn，pi 重生后不可能有存活的 select；残留的已 abort controller 禁止复用
    // （发起新挂起 select 会 fresh 新建，此处删除是防御性清理）
    planCtx.controllers.delete(sessionId);
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
        // 分流判定与 executeSubmitReview 的 E8 宿主分流同源（isTaijiGuiHost，D-B1-7）。
        if (!isTaijiGuiHost(ctx)) {
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
        // 优先成立（P3-9 登记）；清除 = submit-review 重挂起点（clearRoundFields 单函数
        // 出口，D4）。宿主形态该 hint 即 degraded 分源文案的判定源（无 steer，按钮文案依赖它）。
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

  // Clean up on session end
  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    planCtx.states.delete(sessionId);
    planCtx.controllers.delete(sessionId);
  });
}
