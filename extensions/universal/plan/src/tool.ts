import * as path from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  firstContentText,
  PLAN_REVIEW_MARKER,
} from "@zhushanwen/extension-protocol";
import type {
  PlanDocMeta,
  PlanReviewRequest,
  PlanReviewResponse,
} from "@zhushanwen/extension-protocol";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { Type } from "typebox";

import { detectGoalCapability, GOAL_FAILURE_RECOVERY, handlePlanComplete } from "./compact.js";
import type { GoalBridgeOutcome } from "./compact.js";
import { formatReviewComments } from "./prompts.js";
import type { PlanAbortControllers, PlanSessionMap, PlanState } from "./state.js";
import { freshAbortController, getPlanState, planDocsFingerprint, persistPlanState, resetPlanState } from "./state.js";
import { listTemplates, loadTemplate } from "./templates.js";
import { updatePlanWidget } from "./widget.js";

const logger = getLogger("pi-plan");

// ── Action types ───────────────────────────────────────────────────

export const PLAN_ACTIONS = [
  "list-template",
  "select-template",
  "complete",
  "abort",
  "register-doc",
  "submit-review",
] as const;

/**
 * 计划态工具白名单（进入计划模式与 session_start 恢复两处共用——bash 在白名单内，
 * 文件写约束来自注入的计划模式提示词，见 pi-ext-021）。
 */
export const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "plan"];

export type PlanAction = (typeof PLAN_ACTIONS)[number];

export function validateAction(action: string): action is PlanAction {
  return (PLAN_ACTIONS as readonly string[]).includes(action);
}

// ── Details types ──────────────────────────────────────────────────

interface ListTemplateDetails {
  action: "list-template";
  templates: Array<{ name: string; path: string }>;
}

interface SelectTemplateDetails {
  action: "select-template";
  templateName: string;
  content: string;
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
  | ListTemplateDetails
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

/** Compact template list for TUI display. Two-column, max 5 lines. */
function formatTemplateList(templates: Array<{ name: string }>): string {
  const names = templates.map((t) => t.name);
  if (names.length === 0) return "No templates available.";

  const MAX_DISPLAY = 8;
  const HALF = 2;
  const truncated = names.length > MAX_DISPLAY;
  const display = names.slice(0, MAX_DISPLAY);

  // Two-column layout
  const half = Math.ceil(display.length / HALF);
  const col1 = display.slice(0, half);
  const col2 = display.slice(half);
  const lines: string[] = [];
  for (let i = 0; i < half; i++) {
    const right = col2[i] ? `    ${half + i + 1} ${col2[i]}` : "";
    lines.push(`  ${i + 1} ${col1[i] ?? ""}` + right);
  }

  if (truncated) lines.push(`  ... ${names.length - MAX_DISPLAY} more`);
  return lines.join("\n");
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
    case "list-template": {
      const header = fg("accent", `${details.templates.length} 个模板可用`) + NL;
      const body = formatTemplateList(details.templates) + NL;
      const hint = fg("dim", "→ plan(select-template, templateName='xxx')");
      return new Text(header + body + hint, 0, 0);
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
  }
}

// ── Action executors (one per switch case) ─────────────────────────

/** Execute result envelope (shared shape returned by every action). */
interface ActionResult {
  content: Array<{ type: "text"; text: string }>;
  details: PlanDetails;
}

function executeListTemplate(): ActionResult {
  const templates = listTemplates();
  return {
    content: [{ type: "text" as const, text: `${templates.length} templates available` }],
    details: { action: "list-template", templates },
  };
}

function executeSelectTemplate(
  pi: ExtensionAPI,
  params: Record<string, unknown>,
  state: PlanState,
): ActionResult {
  const templateName = params.templateName as string;
  if (!templateName) {
    throw new Error("templateName is required for select-template");
  }
  const content = loadTemplate(templateName);
  if (!content) {
    throw new Error(`Template not found: ${templateName}`);
  }
  state.templateName = templateName;
  persistPlanState(pi, state);
  return {
    content: [{ type: "text" as const, text: `Template selected: ${templateName}` }],
    details: { action: "select-template", templateName, content },
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
  if (decision === "revise" || decision === "explain") {
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
 * - select 挂 signal（E10），resolve 后 E5 解析守卫，再按三 decision 消费。
 */
async function executeSubmitReview(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PlanState,
  sessions: PlanSessionMap,
  sessionId: string,
  projectDir: string,
  controllers: PlanAbortControllers,
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

  // 挂起 select 前落 awaiting：select 挂起期间 entry 已持久（崩溃恢复后冷启动扫描
  // 恢复 awaiting，session_start hook 据此 steer 重挂——E3）。指纹快照同点更新：
  // 单一记录点，text/gui 两检测分支共用（快照 = 「上次 submit-review 时的 docs」）
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
      return await executeComplete(pi, ctx, {}, state, sessions, sessionId, projectDir, controllers);

    case "revise": {
      // 显式 deliverAs: 'steer' 必须传——pi 的 sendUserMessage 在 isStreaming 时
      // 无 deliverAs 直接 throw；有 deliverAs 时 steer 排队至下一次 LLM 调用
      pi.sendUserMessage(formatReviewComments("revise", response.comments), { deliverAs: "steer" });
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

    case "explain": {
      // 同款注入但不改 reviewState（保持 awaiting）：前端显示降级态
      // 「等待 agent 重新提交审批」，重挂靠 D2 提示词纪律驱动
      pi.sendUserMessage(formatReviewComments("explain", response.comments), { deliverAs: "steer" });
      return {
        content: [{
          type: "text" as const,
          text: withUnchangedWarning(
            `User requested further explanation with ${response.comments.length} comment(s) — injected into the conversation. Answer them, then call plan(action='submit-review') again to re-hang the review.`,
            unchangedResubmit,
          ),
        }],
        details: submitReviewDetails("gui", state.docs.length, unchangedResubmit),
      };
    }
  }
}

/**
 * 执行方式对话框的 label→mode 映射表（发现 8）——SDK `ui.select(title, options: string[])`
 * 只收字符串数组，无法传结构化选项，故用本地查表而非文案反查。
 */
const EXEC_MODE_OPTIONS: Array<{ label: string; mode: string }> = [
  { label: "Subagent-driven execution", mode: "subagent" },
  { label: "Goal-driven execution (/goal)", mode: "goal" },
  { label: "Single-agent (current session)", mode: "single-agent" },
];

/** 对话框尾部的两个"留在 plan mode"选项（complete-cancelled 路径） */
const CANCEL_OPTIONS = ["Modify the plan first", "Save for later"];

/** Build execution options filtered by available capabilities. */
function buildExecOptions(): string[] {
  const modeLabels = EXEC_MODE_OPTIONS
    .filter((opt) => opt.mode !== "goal" || detectGoalCapability())
    .map((opt) => opt.label);
  return [...modeLabels, ...CANCEL_OPTIONS];
}

/** Map the user's execution-method choice (dialog label) to the chosenMode string. */
function chosenModeFromChoice(choice: string): string {
  return EXEC_MODE_OPTIONS.find((opt) => opt.label === choice)?.mode ?? "single-agent";
}

/** Outcome of the complete-action execution-method prompt. */
type CompleteChoiceOutcome =
  | { kind: "cancelled"; result: ActionResult }
  | { kind: "mode"; chosenMode: string };

/**
 * Prompt the user for an execution method (no-op selection when headless).
 * Cancel / "Modify the plan first" / "Save for later" → cancelled with a
 * complete-cancelled result; otherwise the mapped chosenMode.
 */
async function resolveCompleteChoice(
  ctx: ExtensionContext,
  controllers: PlanAbortControllers,
  sessionId: string,
): Promise<CompleteChoiceOutcome> {
  const execOptions = buildExecOptions();

  if (typeof ctx.ui.select !== "function") {
    return { kind: "mode", chosenMode: "single-agent" };
  }
  // E10：执行方式 select 与 submit-review 审批 select 同为挂起点，同样挂 signal——
  // approve 后的挂起窗口内用户点横幅退出必须可达（abort → resolve undefined → cancelled）
  const controller = freshAbortController(controllers, sessionId);
  const choice = await ctx.ui.select("Plan is ready. Choose execution method:", execOptions, { signal: controller.signal });
  controllers.delete(sessionId);

  if (!choice || choice === "Modify the plan first" || choice === "Save for later") {
    return {
      kind: "cancelled",
      result: {
        content: [
          { type: "text" as const, text: `User chose: ${choice ?? "cancelled"}. Staying in plan mode.` },
        ],
        details: { action: "complete-cancelled", reason: choice ?? "cancelled" },
      },
    };
  }
  return { kind: "mode", chosenMode: chosenModeFromChoice(choice) };
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
    ? `${base}\nGoal execution started via /goal.`
    : `${base}\nGoal execution was not started (${goalOutcome.reason}). ${GOAL_FAILURE_RECOVERY[goalOutcome.reason]}`;
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
): Promise<ActionResult> {
  const choice = await resolveCompleteChoice(ctx, controllers, sessionId);
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
  const goalOutcome = handlePlanComplete(pi, ctx, state, isolation, chosenMode);

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
      "Manages plan mode lifecycle (template selection, document registration, review, state transitions). " +
      "NOT for writing document content — write documents via the bash tool (e.g. cat heredoc). " +
      "Actions: list-template, select-template, register-doc, submit-review, complete, abort.",
    parameters: Type.Object({
      action: StringEnum(PLAN_ACTIONS, { description: "Action to perform" }),
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
      "## When to use this tool vs the bash tool\n" +
      "Use 'plan' tool ONLY for plan mode state management:\n" +
      "- list-template / select-template — template operations\n" +
      "- register-doc — register a produced document (call after writing each deliverable; re-call after revisions to bump its version)\n" +
      "- submit-review — all documents done, request user review\n" +
      "- complete — user approved plan, exit plan mode\n" +
      "- abort — cancel plan mode\n" +
      "\n" +
      "Use the bash tool for ALL document content: writing files, updating chapters (e.g. cat heredoc).\n" +
      "\n" +
      "## End-to-end workflow example\n" +
      "1. /plan 'add dark mode' — user enters plan mode\n" +
      "2. AI explores codebase (read, grep, bash) — brainstorming\n" +
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
      _signal: AbortSignal | undefined,
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
        case "list-template":
          return executeListTemplate();

        case "select-template":
          return executeSelectTemplate(pi, params, state);

        case "register-doc":
          return executeRegisterDoc(pi, params, state);

        case "submit-review":
          return await executeSubmitReview(pi, ctx, state, sessions, sessionId, projectDir, controllers);

        case "complete":
          return await executeComplete(pi, ctx, params, state, sessions, sessionId, projectDir, controllers);

        case "abort":
          return executeAbort(pi, sessions, sessionId, ctx);
      }
    },
  });
}


