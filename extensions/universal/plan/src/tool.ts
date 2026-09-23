import * as path from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  firstContentText,
  PLAN_REVIEW_MARKER,
  uiFormInteract,
} from "@zhushanwen/extension-protocol";
import type {
  ChoiceQuestion,
  PlanDocMeta,
  PlanReviewRequest,
  PlanReviewResponse,
} from "@zhushanwen/extension-protocol";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { Type } from "typebox";

import { GOAL_FAILURE_RECOVERY, handlePlanComplete } from "./compact.js";
import type { GoalBridgeOutcome } from "./compact.js";
import { activatePlanMode, resolveSkills } from "./enter.js";
import { detectExecSkills } from "./exec-skills.js";
import type { ExecSkill } from "./exec-skills.js";
import { t } from "./i18n.js";
import { formatReviewComments } from "./prompts.js";
import type { SkillRef } from "./prompts.js";
import type { PlanAbortControllers, PlanSessionMap, PlanState } from "./state.js";
import { PLAN_CONTEXT_CUSTOM_TYPE, freshAbortController, getPlanState, planDocsFingerprint, persistPlanState, resetPlanState } from "./state.js";
import { listTemplates, loadTemplate } from "./templates.js";
import { updatePlanWidget } from "./widget.js";

const logger = getLogger("pi-plan");

// ── Action types ───────────────────────────────────────────────────

export const PLAN_ACTIONS = [
  "enter",
  "select-template",
  "complete",
  "abort",
  "register-doc",
  "submit-review",
] as const;

// PLAN_MODE_TOOLS 已迁至 state.ts（叶模块，避免 enter↔tool 循环依赖）；此处再导出保持兼容
export { PLAN_MODE_TOOLS } from "./state.js";

export type PlanAction = (typeof PLAN_ACTIONS)[number];

export function validateAction(action: string): action is PlanAction {
  return (PLAN_ACTIONS as readonly string[]).includes(action);
}

// ── Details types ──────────────────────────────────────────────────

interface SelectTemplateDetails {
  action: "select-template";
  templateName: string;
}

interface EnterDetails {
  action: "enter";
  requirement: string;
  skills: string[];
}

interface CompleteDetails {
  action: "complete";
  planFilePath: string;
  isolation: string;
  execMode: string;
  /** D2：direct 档 goalInit 的同步结果；compact 档在 onComplete 回调内执行，不进 result */
  goalOutcome?: GoalBridgeOutcome;
}

interface CompleteCancelledDetails {
  action: "complete-cancelled";
  reason: string;
}

interface AbortDetails {
  action: "abort";
}

interface RegisterDocDetails {
  action: "register-doc";
  fileName: string;
  version: number;
}

interface SubmitReviewDetails {
  action: "submit-review";
  /** gui = taiji 形态挂 PLAN_REVIEW_MARKER select；text = 独立 pi 软门（E8） */
  channel: "gui" | "text";
  docsCount: number;
  /**
   * 重提交无变化信号：false = 本次提交与上次 submit-review 之间无任何 register-doc
   * （警告行已追加到 result 文本）。正常提交不携带该字段（缺失 = 无警告）。
   */
  changed?: false;
}

/** 审阅闭环的失败出口（E5/E6/取消）——details 与 content 文本都带恢复动作 */
interface ReviewErrorDetails {
  action: "review-error";
  reason: "no-docs" | "inactive" | "bad-response" | "cancelled";
}

type PlanDetails =
  | EnterDetails
  | SelectTemplateDetails
  | CompleteDetails
  | CompleteCancelledDetails
  | AbortDetails
  | RegisterDocDetails
  | SubmitReviewDetails
  | ReviewErrorDetails;

// ── Helpers ────────────────────────────────────────────────────────

/** Restore the default full tool set after exiting plan mode. */
function restoreFullToolSet(pi: ExtensionAPI): void {
  const allToolNames = pi.getAllTools().map((t: { name: string }) => t.name);
  pi.setActiveTools(allToolNames);
}

/** Relative path from project dir */
function relativePath(fullPath: string, projectDir: string): string {
  if (fullPath.startsWith(projectDir)) {
    return fullPath.slice(projectDir.length + 1);
  }
  return fullPath;
}

/**
 * D9 宿主分流信号：taiji runtime 对托管 pi 恒注入 TAIJI_AGENT_EXT_LOG=1；
 * 独立 pi 无此信号 → submit-review 走 E8 文本软门（不发 marker select——
 * pi TUI 原生渲染 \x00 控制符 title + JSON options 成乱码对话）。
 * 不用 TAIJI_RUNTIME_TOKEN：它在 SPAWN_ENV 出站 deny list 被强制剥除
 * （C-proc-09），pi 子进程 env 里恒不可见，照抄即分流静默失效且诱导实施者
 * 动 deny list 造成安全回归。每次调用时读（不可模块加载时缓存——测试与
 * 运行中 env 都可能变化）。
 *
 * [双语义耦合登记，2026-09-20 R1] 本 env 名义语义是扩展日志开关
 * （extension-logger 见之落盘 INFO，恒注入点 packages/pi-rpc/src/env.ts），本函数
 * 是第二消费方（宿主分流，submit-review / complete / 引导门三处）——若日志开关
 * 走向可配置（值不再是恒 '1'），三处分流同帧静默失效，届时必须拆专用宿主信号
 * env 并纳入恒注入，不得沿用本名。
 */
function isTaijiHost(): boolean {
  return process.env.TAIJI_AGENT_EXT_LOG === "1";
}

/**
 * 重提交无变化警告（E8 机制级兜底）：独立 pi 实测（mimo-v2.5-pro，干净 session × 3）
 * LLM 收到用户修改意见后不 rewrite/re-register 直接重调 submit-review——result 文本
 * 已带的修订闭环指令不足以纠正，升级为确定性检测（docs 快照指纹比对）后逐次警告。
 * 提示词级引导保留：警告行是追加信号，不替换原有闭环指令。
 */
const UNCHANGED_RESUBMIT_WARNING =
  "Note: no documents changed since the last submit-review. " +
  "If the user requested changes, you MUST rewrite the file(s) and re-register each via plan(action='register-doc') BEFORE calling submit-review again.";

/** 警告命中时把警告行追加为 result 文本末行（「追加一行」契约），未命中原文返回 */
function withUnchangedWarning(text: string, unchangedResubmit: boolean): string {
  return unchangedResubmit ? `${text}\n${UNCHANGED_RESUBMIT_WARNING}` : text;
}

/** submit-review details 构造：警告命中时附 changed=false（正常提交字段缺失） */
function submitReviewDetails(channel: "gui" | "text", docsCount: number, unchangedResubmit: boolean): SubmitReviewDetails {
  return unchangedResubmit
    ? { action: "submit-review", channel, docsCount, changed: false }
    : { action: "submit-review", channel, docsCount };
}

// ── renderResult ───────────────────────────────────────────────────

function renderPlanResult(
  result: { content: Array<{ type: string; text?: string }>; details?: PlanDetails },
  _options: unknown,
  theme: Theme,
): Text {
	const details = result.details;
	if (!details) {
		return new Text(firstContentText(result), 0, 0);
	}

  const fg = (token: ThemeColor, text: string) => theme.fg(token, text);
  const NL = "\n";

  switch (details.action) {
    case "enter": {
      const header = fg("success", `✓ 已进入计划模式`) + NL;
      const skillsLine = details.skills.length > 0 ? fg("dim", `  技能: ${details.skills.join(" · ")}`) + NL : "";
      const hint = fg("dim", "  只读规划：读代码、产文档，不改源码");
      return new Text(header + skillsLine + hint, 0, 0);
    }

    case "select-template": {
      const header = fg("success", `✓ ${details.templateName}`) + NL;
      const hint = fg("dim", "→ 按模板章节顺序写 plan.md");
      return new Text(header + hint, 0, 0);
    }

    case "complete": {
      const header = fg("success", `✓ Plan 已批准 → ${details.execMode}`) + NL;
      const body = fg("dim", `  ${details.planFilePath}`) + NL;
      const info = fg("dim", `  isolation: ${details.isolation} · 工具集已恢复`);
      return new Text(header + body + info, 0, 0);
    }

    case "complete-cancelled": {
      const header = fg("warning", `✗ 用户选择: ${details.reason}`) + NL;
      const body = fg("dim", "  继续在 plan mode 中");
      return new Text(header + body, 0, 0);
    }

    case "abort": {
      const header = fg("error", "✗ Plan mode 已退出") + NL;
      const body = fg("dim", "  工具集已恢复");
      return new Text(header + body, 0, 0);
    }

    case "register-doc": {
      const header = fg("success", `✓ ${details.fileName} (v${details.version})`) + NL;
      const hint = fg("dim", "→ 产物已登记 · 全部完成后 plan(submit-review)");
      return new Text(header + hint, 0, 0);
    }

    case "submit-review": {
      const header = fg("success", `✓ 审阅请求已提交（${details.docsCount} 份文档）`) + NL;
      const body = details.channel === "gui"
        ? fg("dim", "  → 等待用户在 GUI 审批条操作")
        : fg("dim", "  → 文档已就绪，等待用户在对话中反馈");
      return new Text(header + body, 0, 0);
    }

    case "review-error": {
      const header = fg("warning", "✗ 审阅请求未提交") + NL;
      const body = fg("dim", `  ${details.reason}`);
      return new Text(header + body, 0, 0);
    }

    // 兜底：旧版本持久化 entry 的 details 形态（如已删除的 list-template）不在
    // 现版 PlanDetails 联合内——switch 落空返回 undefined 会让 pi TUI 渲染循环
    // 对 undefined 调 .render() 直接 TypeError（pi-tui box.js render 无守卫）。
    // 历史会话重开同样要渲染旧 entry，任意历史形态都必须产出组件。
    default:
      return new Text(firstContentText(result), 0, 0);
  }
}

// ── Action executors (one per switch case) ─────────────────────────

/**
 * 把 pi execute 的 turn abort 信号级联到挂起 select 的 controller（对齐同协议
 * 家族 ask-user / scheduler 的 signal 透传）：turn abort（用户 stop / goal 取消 /
 * compaction）时解散挂起的 submit-review / complete 对话框——select resolve
 * undefined 走各处既有的 cancelled 分支，语义与 controllers registry 联动 abort
 * 一致。controller 已 settled 后再 abort 是 no-op；listener 挂在 turn 生命周期
 * 内的 signal 上且 once，无跨 turn 泄漏。
 */
function cascadeTurnAbort(controller: AbortController, signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    // 进入 execute 时 turn 已 abort：直接置 abort 态，select 首行短路 resolve undefined
    controller.abort();
    return;
  }
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
}

/** Execute result envelope (shared shape returned by every action). */
interface ActionResult {
  content: Array<{ type: "text"; text: string }>;
  details: PlanDetails;
}

/**
 * enter（plan-mode-agent-enter U1）：agent 自动进入 plan 模式，无需用户确认。
 * plan 模式是只读子集（只读代码、产文档、不改源码），进入它不是危险操作，
 * 故不设确认闸门——进入事实由 GUI PlanModeBar 显形（投影链广播 isActive=true），
 * 用户随时可经 PlanModeBar 退出。进入核心复用 activatePlanMode（与 slash 命令同源）；
 * plan 模式提示词经 tool result content 直返（对本次调用的直接响应，同轮即见，
 * 不走对话流消息注入/steer 排队——slash 入口才经 sendMessage 注入）。已在 plan
 * 模式时幂等返回，不重复进入。
 */
function executeEnter(
  pi: ExtensionAPI,
  params: Record<string, unknown>,
  state: PlanState,
  sessions: PlanSessionMap,
  sessionId: string,
  ctx: ExtensionContext,
): ActionResult {
  if (state.isActive) {
    return {
      content: [{
        type: "text" as const,
        text: "Already in plan mode. Continue: write each deliverable into the plan directory, register it via plan(action='register-doc'), then call plan(action='submit-review') when all are done.",
      }],
      details: { action: "enter", requirement: state.requirement, skills: state.skills },
    };
  }

  const requirement = typeof params.requirement === "string" ? params.requirement.trim() : "";
  // skills 可选（数组逐项 string 白名单）；缺失/空 = 不挂载技能走模板流程
  const requestedSkills = Array.isArray(params.skills)
    ? params.skills.filter((s): s is string => typeof s === "string")
    : [];
  let resolved: SkillRef[] = [];
  if (requestedSkills.length > 0) {
    const resolution = resolveSkills(pi, requestedSkills);
    if (!resolution.ok) {
      // 未知技能名 = 使用错误（同 executeSelectTemplate 错名先例 throw，带可用清单自愈）
      throw new Error(
        `Unknown skill(s): ${resolution.missing.join(", ")}. Available skills: ${resolution.available.join(", ") || "(none)"}. ` +
        `Retry plan(action='enter') with valid skill names or omit the skills parameter.`,
      );
    }
    resolved = resolution.resolved;
  }

  const { prompt } = activatePlanMode(pi, sessions, sessionId, ctx, {
    requirement,
    skills: resolved,
    projectDir: ctx.cwd,
  });
  return {
    content: [{ type: "text" as const, text: prompt }],
    details: { action: "enter", requirement, skills: resolved.map((s) => s.name) },
  };
}

/**
 * select-template（D7）：三源合并视图解析 + content 携带胜者文件全文。
 * - 合并视图与注入段同源：两轨都以 ctx.cwd 为 projectRoot 调 listTemplates
 *   （注入段经 PlanPromptInput.projectRoot 由命令层显式传入，不从 planFilePath
 *   逆推层级）——模型看到什么清单就能选中什么（含用户级/项目级投放）。
 * - content 全文直达模型可见通道（现状全文放 details 不进模型，选完没骨架——
 *   §2.2 第二处错位收口）；details 不再携带全文（零消费方，避免双份持久化）。
 * - 错名报错带可用名字清单：模型当场从报错自愈，无需任何查询 action（D3）。
 * - --template 直传防御：模板已由用户指定并全文内嵌注入，select-template 是
 *   画蛇添足——报错不带三源清单（直传文件不在清单里，清单会误导改选内置
 *   模板、偏离用户意图）。
 */
function executeSelectTemplate(
  pi: ExtensionAPI,
  params: Record<string, unknown>,
  state: PlanState,
  projectDir: string,
): ActionResult {
  const templateName = params.templateName as string;
  if (!templateName) {
    throw new Error("templateName is required for select-template");
  }
  if (state.templateProvidedPath !== undefined) {
    throw new Error("template was provided via --template, write the plan following the file above");
  }
  const templates = listTemplates({ projectRoot: projectDir });
  const winner = templates.find((t) => t.name === templateName);
  if (!winner) {
    throw new Error(`Template not found: ${templateName}. Available: ${templates.map((t) => t.name).join(", ")}`);
  }
  const content = loadTemplate(templateName, { projectRoot: projectDir });
  if (content === null) {
    throw new Error(`Template not readable: ${winner.path}`);
  }
  state.templateName = templateName;
  persistPlanState(pi, state);
  return {
    content: [{
      type: "text" as const,
      text: `Template selected: ${templateName} (${winner.path}). Write the plan following the template's chapter structure below.\n\n<template>\n${content}\n</template>`,
    }],
    details: { action: "select-template", templateName },
  };
}

function executeAbort(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
  sessionId: string,
  ctx: ExtensionContext,
): ActionResult {
  const updatedState = resetPlanState(pi, sessions, sessionId, ctx);
  updatePlanWidget(ctx, updatedState);
  restoreFullToolSet(pi);
  return {
    content: [{ type: "text" as const, text: "Plan mode aborted. Full tool access restored." }],
    details: { action: "abort" },
  };
}

/**
 * register-doc（D10 保留独立 action）：登记单份产物文档。同 fileName 重登 =
 * version+1 原位覆盖（drawer tab 顺序不跳动）。absPath 由 extension 从 plan
 * 目录推导（产物写盘位置本身是纪律的一部分，不信任 LLM 申报的路径）。
 * isActive=false 时的守卫与 submit-review 同风格——前置条件不满足用 tool result
 * 错误（错误即纠偏指令），不用 throw（throw 留给参数缺失类编程错误）。
 */
function executeRegisterDoc(
  pi: ExtensionAPI,
  params: Record<string, unknown>,
  state: PlanState,
): ActionResult {
  if (!state.isActive) {
    return {
      content: [{
        type: "text" as const,
        text: "Plan mode is not active — there is nothing to register. Start a plan with /plan <requirement> first.",
      }],
      details: { action: "review-error", reason: "inactive" },
    };
  }

  const fileName = typeof params.fileName === "string" ? params.fileName.trim() : "";
  if (!fileName) {
    throw new Error("fileName is required for register-doc (e.g. plan(action='register-doc', fileName='design.md'))");
  }
  // 穿越守卫：fileName 必须是 plan 目录内的纯文件名（absPath = join(planDir, fileName)，
  // 放开分隔符/'..' 可把 plan 目录外任意可读文件挂进用户审阅界面——PlanDocsPanel 文档
  // tab 按 absPath 直读渲染）。参数形态错误 throw 带纠正样例（同上方缺参分支风格）。
  if (fileName.includes("/") || fileName.includes("\\") || fileName === "." || fileName === "..") {
    throw new Error(
      "fileName must be a plain file name inside the plan directory — path separators and '.'/'..' segments are not allowed (e.g. plan(action='register-doc', fileName='design.md'))",
    );
  }
  const sourceSkill = typeof params.sourceSkill === "string" ? params.sourceSkill.trim() : "";

  const existing = state.docs.find((d) => d.fileName === fileName);
  const version = existing ? existing.version + 1 : 1;
  const meta: PlanDocMeta = {
    fileName,
    absPath: path.join(path.dirname(state.planFilePath), fileName),
    sourceSkill,
    version,
  };

  if (existing) {
    // 原位置覆盖：drawer 文档 tab 按产出顺序展示，重登记不改变顺序
    state.docs.splice(state.docs.indexOf(existing), 1, meta);
  } else {
    state.docs.push(meta);
  }
  persistPlanState(pi, state);

  return {
    content: [{ type: "text" as const, text: `Registered ${fileName} (v${version})` }],
    details: { action: "register-doc", fileName, version },
  };
}

/**
 * PlanReviewResponse 形状守卫（E5 的垃圾数据判据）：
 * parse 成功但形状不合法同样按解析失败处理——垃圾数据不进对话流。
 */
export function isPlanReviewResponse(value: unknown): value is PlanReviewResponse {
  if (typeof value !== "object" || value === null || !("decision" in value)) return false;
  const decision = value.decision;
  if (decision === "approve") return true;
  if (decision === "revise") {
    if (!("comments" in value) || !Array.isArray(value.comments)) return false;
    return value.comments.every((c) => {
      if (typeof c !== "object" || c === null) return false;
      if (!("quote" in c) || !("comment" in c)) return false;
      return typeof c.quote === "string" && typeof c.comment === "string";
    });
  }
  return false;
}

/** parse + 形状守卫合一：任一失败 throw（E5 捕获点统一） */
export function parsePlanReviewResponse(raw: string): PlanReviewResponse {
  const value: unknown = JSON.parse(raw);
  if (!isPlanReviewResponse(value)) {
    throw new Error("select response does not match PlanReviewResponse shape");
  }
  return value;
}

/** E5/E6/取消共用错误 result 构造（content 文本即恢复动作） */
function reviewErrorResult(reason: ReviewErrorDetails["reason"], recovery: string): ActionResult {
  return {
    content: [{ type: "text" as const, text: recovery }],
    details: { action: "review-error", reason },
  };
}

/**
 * submit-review（D5/E6/E8/E10）：
 * - E6 双守卫：isActive=false → 错误不挂 select；docs 空 → 错误提示先 register-doc。
 * - 挂起前落 reviewState='awaiting'（崩溃恢复 E3 依赖此持久态）+ docs 快照指纹
 *   （重提交无变化检测基线，text/gui 两分支共用；快照缺失 = 无既往提交不警告）。
 * - 宿主分流：taiji（TAIJI_AGENT_EXT_LOG=1）发 PLAN_REVIEW_MARKER select；
 *   独立 pi 返回 E8 文本软门。
 * - select 挂 signal（E10），resolve 后 E5 解析守卫，再按 decision 消费。
 */
async function executeSubmitReview(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PlanState,
  sessions: PlanSessionMap,
  sessionId: string,
  projectDir: string,
  controllers: PlanAbortControllers,
  signal: AbortSignal | undefined,
): Promise<ActionResult> {
  // E6 双守卫：状态门优先于内容门（退出后任何动作都不该发生）。
  // 文本语义按 A9 真机事故收紧：旧文「Wrap up the current task directly」被 LLM
  // 误读为「已批准，开始实施」——未激活 ≠ 批准，必须显式禁止实施并指向等待用户。
  if (!state.isActive) {
    return reviewErrorResult(
      "inactive",
      "Plan mode is not active (it already exited, or no plan was started). No plan has been approved — do not implement any changes. Briefly tell the user that plan mode is no longer active, then wait for further user instructions.",
    );
  }
  if (state.docs.length === 0) {
    return reviewErrorResult(
      "no-docs",
      "No documents registered yet. Call plan(action='register-doc', fileName='...') for each deliverable document first, then call submit-review again.",
    );
  }

  // 重提交无变化检测：指纹与上次快照相同 ⇔ 上次 submit-review 后无任何 register-doc。
  // 快照缺失 = 无既往提交（首次 / reset 后新轮次 / 旧版 entry 重挂），不警告。
  const fingerprint = planDocsFingerprint(state.docs);
  const unchangedResubmit =
    state.lastSubmitReviewDocsFingerprint !== undefined &&
    state.lastSubmitReviewDocsFingerprint === fingerprint;

  // 挂起 select 前落 awaiting：select 挂起期间 entry 已持久（崩溃恢复 E3 依赖此持久态）。
  // 指纹快照同点更新：单一记录点，text/gui 两检测分支共用（快照 = 「上次 submit-review
  // 时的 docs」）。重挂起新 pending 前清上一轮 source——不变量 = source 只描述当前降级
  // 等待的原因，此处即将挂起真审批，降级等待尚未发生（残留 'resubmit' 会在降级态渲染
  // 上一轮「会话已重启」文案，与 C-U2 同型残留）
  delete state.reviewStateSource;
  state.reviewState = "awaiting";
  state.lastSubmitReviewDocsFingerprint = fingerprint;
  persistPlanState(pi, state);

  // E8 宿主分流：独立 pi 无 marker 路由，pi TUI 会把 \x00 title + JSON options
  // 渲染成乱码对话——不发 select，审批退化为自然语言软门
  if (!isTaijiHost()) {
    return {
      content: [{
        type: "text" as const,
        text: withUnchangedWarning(
          `Documents are ready for review (${state.docs.length} registered). ` +
          `Tell the user the documents are ready and ask them to give feedback directly in the conversation. ` +
          `When they request changes: rewrite the file for each comment, then re-register it via plan(action='register-doc') (version bumps so the UI refreshes) — after ALL comments are addressed, call plan(action='submit-review') again. ` +
          `When the user is satisfied, they confirm and you call plan(action='complete').`,
          unchangedResubmit,
        ),
      }],
      details: submitReviewDetails("text", state.docs.length, unchangedResubmit),
    };
  }

  // E10 生命周期钉死：每次发挂起 select 新建 controller（禁复用已 abort 的——
  // pi 对已 abort signal 短路立即 resolve undefined）
  const controller = freshAbortController(controllers, sessionId);
  cascadeTurnAbort(controller, signal);
  const payload = JSON.stringify({ docs: state.docs } satisfies PlanReviewRequest);
  const choice = await ctx.ui.select(PLAN_REVIEW_MARKER, [payload], { signal: controller.signal });
  // select 已 settled，controller 即弃（注册表不留已 settled 的 controller）
  controllers.delete(sessionId);

  if (choice === undefined) {
    // 取消分支覆盖两条路径：abort 联动（/plan abort，resetPlanState 已由命令
    // handler 执行，本分支正常返回让 turn 结束）与 TUI 手动取消（reviewState
    // 保持 awaiting）。语义按 A9 真机事故收紧：旧文「dismissed → 重挂」被 LLM
    // 当成批准信号，重挂撞 inactive 守卫后开始实施源码改动——取消 ≠ 批准，
    // 禁止重挂、禁止实施，停止审批循环等用户指示。
    return reviewErrorResult(
      "cancelled",
      "The review was cancelled — the user dismissed the approval dialog or exited plan mode. This is NOT an approval. Do not implement any changes. Stop the review loop: briefly tell the user you have stopped, then wait for further user instructions.",
    );
  }

  // echo 检测（同 uiFormInteract 先例 extension-protocol ui-form/helpers）：旧 taiji
  // 宿主不识别 PLAN_REVIEW_MARKER 时 select 降级普通单选项，用户点选回显 payload 本身。
  // 收包与发送 payload 逐字节相等 = 确定性识别该不支持组合；判定必须先于 parse
  //（payload 是合法 JSON，parse 会成功但形状守卫必败）——否则 bad-response 分支引导
  // 重挂 → 宿主同样回显 → 重复弹错循环。命中返回升级指引，不引导重挂。
  if (choice === payload) {
    logger.warn("plan: submit-review select echoed the request payload (host does not understand PLAN_REVIEW_MARKER)");
    return reviewErrorResult(
      "bad-response",
      "The taiji host does not understand the plan review marker (taiji is older than this extension). " +
      "Do NOT call submit-review again — the review dialog will fail the same way. " +
      "Tell the user to upgrade taiji (or pin the plan extension version) and wait for their instructions.",
    );
  }

  let response: PlanReviewResponse;
  try {
    response = parsePlanReviewResponse(choice);
  } catch (error) {
    // E5：解析失败 / 形状不合法 → logger.warn + 提示 agent 重挂审批；
    // 不把可能损坏的数据按任何 decision 注入对话（垃圾数据不进流）
    logger.warn("plan: submit-review select response parse failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return reviewErrorResult(
      "bad-response",
      "The review response could not be parsed. No action was taken — call plan(action='submit-review') again to re-hang the review for the user.",
    );
  }

  switch (response.decision) {
    case "approve":
      // approve → 走现状 complete 流程（执行方式 select 同样挂 signal）
      return await executeComplete(pi, ctx, {}, state, sessions, sessionId, projectDir, controllers, signal);

    case "revise": {
      // custom message 形态注入：streaming 时显式
      // deliverAs:'steer' 排队至下一次 LLM 调用（pi 实装锚点：dist/core/agent-session.js
      // :859-868（0.84.4）——isStreaming 分支 steer 走 :868 _queueSteer；sendMessage 缺省
      // deliverAs 同为 steer，显式传保持排队语义自明）；非 streaming 由 triggerTurn:true 开轮
      pi.sendMessage(
        {
          customType: PLAN_CONTEXT_CUSTOM_TYPE,
          content: formatReviewComments(response.comments),
          display: false,
        },
        { deliverAs: "steer", triggerTurn: true },
      );
      state.reviewState = "revising";
      persistPlanState(pi, state);
      return {
        content: [{
          type: "text" as const,
          text: withUnchangedWarning(
            `User requested revision with ${response.comments.length} comment(s) — injected into the conversation. Handle the comments, re-register revised documents, then re-submit for review.`,
            unchangedResubmit,
          ),
        }],
        details: submitReviewDetails("gui", state.docs.length, unchangedResubmit),
      };
    }

    default: {
      // 判别联合穷尽性守卫：isPlanReviewResponse 已收窄 decision 值域，此处不可达；
      // 编码期新增 decision 漏改 switch 会被 never 断言在编译期拦截
      const unreachable: never = response;
      throw new Error(`plan: unhandled review decision: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * 执行方式选项（2026-09-21 用户裁决重排）：选项集 = 检测到的 plan-exec skills
 * （root 序前 2 个，label `用技能「name」执行`）+ 普通执行（execute 档——compact 侧
 * 整合 goal 桥与 auto-parallel subagent，见 deliverExecutionNotice）+ 暂不执行
 * （留在 plan mode）。四段固定结构，UI 文案经 i18n（ui-preferences locale 通道）。
 * 动态构造：skill 项随 complete 时检测产出，label→mode 映射随选项集携带
 * （`skill:<name>` 动态项不进静态表）。
 */
interface ExecOption {
  label: string;
  mode: string;
  description?: string;
  /** skill 档携带（skill 入口文件路径，标准形态 SKILL.md / 散 .md 形态文件本身；CompleteChoiceOutcome 数据通路 → steer 文案 read 该路径） */
  skillEntryPath?: string;
}

/** skill 选项上限（用户裁决：第一/第二两个 skill 排位；检测再多不进选项） */
const MAX_SKILL_OPTIONS = 2;

/** Build execution options: up to 2 detected plan-exec skills + execute + not-now. */
function buildExecOptions(execSkills: ExecSkill[]): ExecOption[] {
  const options: ExecOption[] = execSkills.slice(0, MAX_SKILL_OPTIONS).map((skill) => ({
    label: t("exec.viaSkill", { name: skill.name }),
    mode: `skill:${skill.name}`,
    description: skill.description ?? t("exec.viaSkillDesc", { name: skill.name }),
    skillEntryPath: skill.skillEntryPath,
  }));
  options.push({
    label: t("exec.execute"),
    mode: "execute",
    description: t("exec.executeDesc"),
  });
  options.push({
    label: t("exec.later"),
    mode: "later",
    description: t("exec.laterDesc"),
  });
  return options;
}

/**
 * 「暂不执行」档的 mode 值（选项集内的固定成员，label 经 i18n；选中即 complete-cancelled，
 * 留在 plan mode——原 CANCEL_OPTIONS 英文双选项的收敛形态）。
 */
const LATER_MODE = "later";

/** Outcome of the complete-action execution-method prompt. */
type CompleteChoiceOutcome =
  | { kind: "cancelled"; result: ActionResult }
  | { kind: "mode"; chosenMode: string; skillEntryPath?: string };

/** complete-cancelled result（用户选暂不执行 / 通道取消，reason = 点选 label 或 cancelled） */
function cancelledByUserResult(choice: string | undefined): ActionResult {
  // 文案按取消来源分情境（状态审查 P2-3）：choice 非空 = 用户在选项里主动点「暂不执行」，
  // 留在 plan mode 是用户意图；choice 空 = select 被 abort 联动解散（用户点了 PlanModeBar
  // 退出 / turn 中止）——此时 plan mode 已退出，旧文「Staying in plan mode」与已 reset 的
  // 状态双向矛盾（LLM 按 plan mode 行事，后续每个 plan 调用吃 inactive 错误才自纠）
  const text =
    choice === undefined
      ? "Plan mode was exited while the execution-method prompt was pending. The plan has NOT been dispatched for execution — do not implement any changes. Briefly tell the user you have stopped, then wait for further user instructions."
      : `User chose: ${choice}. Staying in plan mode. The plan has NOT been dispatched for execution.`;
  return {
    content: [{ type: "text" as const, text }],
    details: { action: "complete-cancelled", reason: choice ?? "cancelled" },
  };
}

/** 通道失败折叠 result（D4 四态折叠表）：不 throw 炸 turn、也不默认执行，注明失败态留 plan mode */
function cancelledByChannelResult(reason: string, message?: string): ActionResult {
  const detail = message ? ` (${message})` : "";
  return {
    content: [
      {
        type: "text" as const,
        text: `Interaction channel failed: ${reason}${detail}. Staying in plan mode — call plan(action='complete') again once the host/connection is fixed.`,
      },
    ],
    details: { action: "complete-cancelled", reason },
  };
}

/**
 * Prompt the user for an execution method（D4 三路分流 + 2026-09-21 选项集重排）：
 * 1. `!ctx.hasUI`（print/json headless，noOp UI）→ 默认 execute，不进任何 select——
 *    替换失效的 `typeof ctx.ui.select` 软门（noOp 的 select 是返回 undefined 的函数，
 *    函数存在性不可判形态，pi runner.js 实码）；
 * 2. taiji rpc 宿主（TAIJI_AGENT_EXT_LOG=1 且 mode==='rpc'）→ uiFormInteract 单
 *    choice 问题（FormOverlay 单视图）；mode 收紧 rpc = helper 的 RPC-only 契约 +
 *    TUI 保留原生 select（D8）——env 异常置位的 TUI 落回第 3 路而非 throw；
 * 3. else（TUI / 独立 pi）→ pi 原生 plain select。
 * 四态折叠：cancelled/timeout → cancelled result；channel-error/non-json → 同折
 * cancelled result + 通道失败说明（plan 是流程对话，通道故障不炸 turn 也不默认执行）。
 * UI 文案（question/header/选项 label）经 i18n；answers key = header（协议 fallback
 * 规则 key = header ?? question），header 与读取同源 t() 生成，本地化不破坏取值。
 */
async function resolveCompleteChoice(
  ctx: ExtensionContext,
  controllers: PlanAbortControllers,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<CompleteChoiceOutcome> {
  if (!ctx.hasUI) {
    return { kind: "mode", chosenMode: "execute" };
  }

  // complete 时现扫 plan-exec skill（无缓存，技能热装可见；检测自带降级规格，
  // 最坏 = skill 选项空集，绝不炸本流程）。选项构造时一次解析，skillEntryPath 随 outcome 流转
  const execSkills = detectExecSkills({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() });
  const execOptions = buildExecOptions(execSkills);

  // E10：执行方式 select 与 submit-review 审批 select 同为挂起点，同样挂 signal——
  // approve 后的挂起窗口内用户点 PlanModeBar 退出（确认 Popover 后）必须可达（abort → resolve undefined → cancelled）
  const controller = freshAbortController(controllers, sessionId);
  cascadeTurnAbort(controller, signal);

  let chosenLabel: string | undefined;
  if (isTaijiHost() && ctx.mode === "rpc") {
    const questionHeader = t("exec.header");
    const question: ChoiceQuestion = {
      type: "choice",
      header: questionHeader,
      question: t("exec.question"),
      options: execOptions.map((opt) => ({ label: opt.label, description: opt.description })),
      allowOther: false,
    };
    // 收窄传参面：只投影 helper 需要的 GuiContext 成员（pi ExtensionContext.ui.custom 的
    // 泛型组件工厂签名比 GuiContext 的宽松形状窄，整 ctx 直传类型不兼容）。
    // select 必须 .bind(ctx.ui)（对齐 ask-user / scheduler 同协议形态）：callMarkerRpc 先
    // 解构再裸调用，this 依赖 pi 实装 select 为箭头闭包——显式 bind 消除该隐式依赖
    // （pi 实装锚点：dist/modes/rpc/rpc-mode.js:84（0.84.4）——select 为箭头函数闭包）。
    const form = await uiFormInteract(
      { mode: ctx.mode, hasUI: ctx.hasUI, ui: { select: ctx.ui.select.bind(ctx.ui) } },
      [question],
      { signal: controller.signal },
    );
    controllers.delete(sessionId);
    if (!form.ok) {
      if (form.reason === "cancelled" || form.reason === "timeout") {
        return { kind: "cancelled", result: cancelledByUserResult(undefined) };
      }
      return { kind: "cancelled", result: cancelledByChannelResult(form.reason, form.message) };
    }
    chosenLabel = form.answers[questionHeader];
  } else {
    const labels = execOptions.map((opt) => opt.label);
    chosenLabel = await ctx.ui.select(t("exec.question"), labels, { signal: controller.signal });
    controllers.delete(sessionId);
  }

  if (!chosenLabel) {
    return { kind: "cancelled", result: cancelledByUserResult(undefined) };
  }
  const option = execOptions.find((opt) => opt.label === chosenLabel);
  if (!option) {
    // 选项集与 labels 同源构造，选中的 label 必在集内——找不到即编码 bug，fail-fast
    throw new Error(`plan: unknown execution choice label: ${chosenLabel}`);
  }
  if (option.mode === LATER_MODE) {
    return { kind: "cancelled", result: cancelledByUserResult(chosenLabel) };
  }
  return { kind: "mode", chosenMode: option.mode, skillEntryPath: option.skillEntryPath };
}

/**
 * complete 的 result 正文：direct 档 goalInit 同步完成，追加 goal 结果行（D2）；
 * compact 档 goalInit 在 onComplete 回调内执行、result 已返回，不携带（通道差异
 * 为设计 §6.2 D2 登记的终态）。
 */
function completeResultText(displayPath: string, goalOutcome: GoalBridgeOutcome | undefined): string {
  const base = `Plan approved. File: ${displayPath}`;
  if (goalOutcome === undefined) return base;
  return goalOutcome.started
    ? `${base}\nGoal tracking started via /goal.`
    : `${base}\nGoal tracking was not started (${goalOutcome.reason}). ${GOAL_FAILURE_RECOVERY[goalOutcome.reason]}`;
}

/** complete action: prompt for execution mode, restore tools, reset state. */
async function executeComplete(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: Record<string, unknown>,
  state: PlanState,
  sessions: PlanSessionMap,
  sessionId: string,
  projectDir: string,
  controllers: PlanAbortControllers,
  signal: AbortSignal | undefined,
): Promise<ActionResult> {
  // approve 已消费挂起审批，执行方式选择挂起前清 reviewState 并落盘（状态审查 P2-3）：
  // 否则「awaiting 无挂起」窗口会让右区误导渲染降级态「等待 agent 重新提交审批」
  // （实际在等执行方式选择）。清后审批条 shouldRender=false 即消失，右区只剩 form。
  delete state.reviewState;
  delete state.reviewStateSource;
  persistPlanState(pi, state);

  const choice = await resolveCompleteChoice(ctx, controllers, sessionId, signal);
  if (choice.kind === "cancelled") {
    return choice.result;
  }
  const chosenMode = choice.chosenMode;

  // D6：原「persist final phase (complete)」为死状态落盘（P1 实证不可观测），
  // phase 删除后该 persist 与上一条 entry 完全重复，随死状态一并移除——
  // 最终态由下方 resetPlanState 的 isActive=false entry 权威记录。
  const planFilePath = state.planFilePath;
  const isolation = (params.isolation as string) ?? "direct";

  // Restore full tool set
  restoreFullToolSet(pi);

  // Execute completion handler (compact setup + steer/goalInit delivery)
  const goalOutcome = handlePlanComplete(pi, ctx, state, isolation, chosenMode, choice.skillEntryPath);

  // Reset state and clear widget — same as abort
  const updatedState = resetPlanState(pi, sessions, sessionId, ctx);
  updatePlanWidget(ctx, updatedState);

  const displayPath = relativePath(planFilePath, projectDir);
  return {
    content: [{ type: "text" as const, text: completeResultText(displayPath, goalOutcome) }],
    details: { action: "complete", planFilePath: displayPath, isolation, execMode: chosenMode, goalOutcome },
  };
}

// ── Register tool ──────────────────────────────────────────────────

export function registerPlanTool(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
  controllers: PlanAbortControllers,
): void {
  pi.registerTool({
    name: "plan",
    label: "Plan Mode",
    description:
      "Manages plan mode lifecycle (enter, template selection, document registration, review, state transitions). " +
      "NOT for writing document content — write documents via the bash tool (e.g. cat heredoc). " +
      "Actions: enter, select-template, register-doc, submit-review, complete, abort.",
    parameters: Type.Object({
      action: StringEnum(PLAN_ACTIONS, { description: "Action to perform" }),
      requirement: Type.Optional(Type.String({ description: "Plan requirement / task description (for enter)" })),
      skills: Type.Optional(Type.Array(Type.String(), { description: "Skill names to mount (for enter; omit to use the template-discovery flow)" })),
      templateName: Type.Optional(Type.String({ description: "Template name (for select-template)" })),
      fileName: Type.Optional(Type.String({ description: "Document file name to register (for register-doc, e.g. 'design.md')" })),
      sourceSkill: Type.Optional(Type.String({ description: "Name of the mounted skill that produced this document (for register-doc; omit in template flow)" })),
      isolation: Type.Optional(
        StringEnum(["compact", "direct"], {
          description: "Isolation mode for plan execution (for complete action)",
        }),
      ),
    }),
    promptSnippet:
      "## Entering plan mode\n" +
      "For large-scale refactoring, cross-module changes, or other high-risk work, proactively enter plan mode yourself: " +
      "plan(action='enter', requirement='<what the user wants>', skills=[...]). Plan mode is read-only for source code — " +
      "you read code and write plan documents, then the user reviews before any implementation. No user confirmation is needed to enter.\n" +
      "\n" +
      "## When to use this tool vs the bash tool\n" +
      "Use 'plan' tool ONLY for plan mode state management:\n" +
      "- enter — enter plan mode (self-service; requirement + optional skills)\n" +
      "- select-template — template selection\n" +
      "- register-doc — register a produced document (call after writing each deliverable; re-call after revisions to bump its version)\n" +
      "- submit-review — all documents done, request user review\n" +
      "- complete — user approved plan, exit plan mode\n" +
      "- abort — cancel plan mode\n" +
      "\n" +
      "Use the bash tool for ALL document content: writing files, updating chapters (e.g. cat heredoc).\n" +
      "\n" +
      "## End-to-end workflow example\n" +
      "1. plan(action='enter', requirement='add dark mode') — you (the agent) enter plan mode\n" +
      "2. Explore codebase (read, grep, bash) — brainstorming\n" +
      "3. Write each document, then plan(action='register-doc', fileName='...') for it\n" +
      "4. plan(action='submit-review') — user reviews in the review UI or conversation\n" +
      "5. Address revision comments (rewrite + re-register), re-submit until approved\n" +
      "6. plan(action='complete', isolation='compact') — exit plan mode\n" +
      "\n" +
      "❌ plan(action='complete') to 'write the plan' — WRONG, write documents via the bash tool\n" +
      "✅ plan(action='complete') AFTER documents are written AND user approves",
    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: PlanDetails },
      options: unknown,
      theme: Theme,
    ): Text {
      return renderPlanResult(result, options, theme);
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: PlanDetails }> {
      const action = params.action as string;
      if (!validateAction(action)) {
        throw new Error(`Unknown plan action: ${action}. Valid actions: ${PLAN_ACTIONS.join(", ")}`);
      }

      const sessionId = ctx.sessionManager.getSessionId();
      const state = getPlanState(sessions, sessionId, ctx);
      const projectDir = ctx.cwd;

      switch (action) {
        case "enter":
          return executeEnter(pi, params, state, sessions, sessionId, ctx);

        case "select-template":
          return executeSelectTemplate(pi, params, state, projectDir);

        case "register-doc":
          return executeRegisterDoc(pi, params, state);

        case "submit-review":
          return await executeSubmitReview(pi, ctx, state, sessions, sessionId, projectDir, controllers, signal);

        case "complete":
          return await executeComplete(pi, ctx, params, state, sessions, sessionId, projectDir, controllers, signal);

        case "abort":
          return executeAbort(pi, sessions, sessionId, ctx);
      }
    },
  });
}


