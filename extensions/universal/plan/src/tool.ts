import * as fs from "node:fs";
import * as path from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  firstContentText,
  parsePlanReviewResponse,
  PLAN_REVIEW_MARKER,
  truncateSelfReview,
  uiFormInteract,
} from "@zhushanwen/extension-protocol";
import type {
  ChoiceQuestion,
  PlanDocMeta,
  PlanReviewRequest,
} from "@zhushanwen/extension-protocol";
// 执行方式检测单源自 ADR-0074 共享包（plan-mode-audit-remediation 批次 4②b 迁入）
import { detectExecSkills } from "@zhushanwen/pi-exec-skills";
import type { ExecSkill } from "@zhushanwen/pi-exec-skills";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { Type } from "typebox";

import { GOAL_FAILURE_RECOVERY, handlePlanComplete } from "./execution-notice.js";
import type { GoalBridgeOutcome } from "./execution-notice.js";
import { activatePlanMode, resolveSkills } from "./enter.js";
import { t } from "./i18n.js";
import { formatReviewComments } from "./prompts.js";
import type { SkillRef } from "./prompts.js";
import { MAX_SKILL_OPTIONS } from "./prompts.js";
import type { PendingSelect, PlanCtx, PlanState, PlanTerminalState } from "./state.js";
import {
  applyPlanEvent,
  clearRoundFields,
  isTaijiGuiHost,
  PLAN_CONTEXT_CUSTOM_TYPE,
  freshPendingSelect,
  getPlanState,
  planDocsFingerprint,
  persistPlanState,
  resetPlanState,
} from "./state.js";
import { listTemplates } from "./templates.js";
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
  execMode: string;
  /**
   * 执行方式的选定来源（D7②）：'headless' = 无 UI 默认 execute；'no-exec-skills' =
   * 无 plan-exec 技能直通（不挂执行方式表单）；'dialog' = 表单/选择器选定。
   */
  execModeSource?: "headless" | "no-exec-skills" | "dialog";
  /** D2：execute 档 goalInit 的同步结果；skill 档无 goalInit，不进 result */
  goalOutcome?: GoalBridgeOutcome;
}

interface CompleteCancelledDetails {
  action: "complete-cancelled";
  /** 原始构造点原因（choice 空/cancel/timeout 折叠 'cancelled'；channel-error / non-json 等透传） */
  reason: string;
  /** 解散源（D-B1-3 via 侧迁移：与审批 select 的 dissolvedBy 统一为同一来源直传原语值域）——'self' = 入口解散（exitPlanMode 已介入，归口 no-op）；'external' = 外部解散（review_aborted 已落盘） */
  source: "self" | "external";
}

/** later 档结果（D3 连带段）：dispatching --later--> approved 已落盘——用户显式「暂不执行」，不是解散 */
interface CompleteLaterDetails {
  action: "complete-later";
  /** 用户点选的 label（i18n 文案，诊断用） */
  choice: string;
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
}

/** 审阅闭环的失败出口（E5/E6/取消/门拒收）——details 与 content 文本都带恢复动作 */
interface ReviewErrorDetails {
  action: "review-error";
  reason:
    | "no-docs"
    | "inactive"
    /** malformed（E5 垃圾数据）——引导重挂 */
    | "bad-response"
    /** 自审硬门拒收（D9①）：selfReview 缺失/空 */
    | "no-self-review"
    /** 防照抄启发式拒收（D9①）：文档已变而 selfReview 与上次逐字节相同 */
    | "stale-self-review"
    /** FSM 合法性兜底（D1 边表）：事件与现态不构成合法边（如未经审批闸口就 complete） */
    | "out-of-order"
    /** 归口①命令解散：reset 已介入、终态已落盘，归口 no-op */
    | "cancelled"
    /** 归口①外部解散：reviewing --review_aborted--> planning 已落盘 */
    | "review-interrupted";
}

/** dismiss 搁置结果（D3）：reviewing --dismiss--> planning 已落盘，plan 模式保持、进度不变 */
interface ReviewDismissedDetails {
  action: "review-dismissed";
  docsCount: number;
}

type PlanDetails =
  | EnterDetails
  | SelectTemplateDetails
  | CompleteDetails
  | CompleteCancelledDetails
  | CompleteLaterDetails
  | AbortDetails
  | RegisterDocDetails
  | SubmitReviewDetails
  | ReviewDismissedDetails
  | ReviewErrorDetails;

// ── Helpers ────────────────────────────────────────────────────────

/** Restore the default full tool set after exiting plan mode. */
function restoreFullToolSet(pi: ExtensionAPI): void {
  const allToolNames = pi.getAllTools().map((t: { name: string }) => t.name);
  pi.setActiveTools(allToolNames);
}

/**
 * Relative path from project dir。
 * A2 边界修复：裸 `startsWith` 会把兄弟前缀目录（/a/proj-2 ⊂ /a/proj）误判为项目内
 * 路径并错切显示路径——仅「projectDir 后紧随路径分隔符」才认定内部路径，其余（含
 * 全等、前缀不含分隔符边界）原样返回。
 */
function relativePath(fullPath: string, projectDir: string): string {
  if (!fullPath.startsWith(projectDir)) return fullPath;
  if (fullPath.length === projectDir.length) return fullPath;
  if (fullPath[projectDir.length] !== path.sep) return fullPath;
  return fullPath.slice(projectDir.length + path.sep.length);
}

/**
 * 重提交无变化警告（E8 机制级兜底）：独立 pi 实测（干净 session × 3）
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

/** submit-review details 构造（重提交无变化信号只走 result 文本警告行，无 details 字段） */
function submitReviewDetails(channel: "gui" | "text", docsCount: number): SubmitReviewDetails {
  return { action: "submit-review", channel, docsCount };
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
      // D7② 直通明示（无 plan-exec 技能不挂表单）：渲染同样不静默——用户知道为何没弹表单
      const direct = details.execModeSource === "no-exec-skills"
        ? fg("dim", "  无 plan-exec 技能，直接执行（未弹执行方式表单）") + NL
        : "";
      const info = fg("dim", "  工具集已恢复");
      return new Text(header + body + direct + info, 0, 0);
    }

    case "complete-cancelled": {
      // D3 连带段归口判别分源渲染：入口解散（reset 已介入）vs 外部解散（批准事实保留）
      const header = details.source === "self"
        ? fg("error", "✗ Plan mode 已退出") + NL
        : fg("warning", "✗ 执行方式选择已中断") + NL;
      const body = details.source === "self"
        ? fg("dim", "  工具集已恢复")
        : fg("dim", `  ${details.reason} · 计划保持已批准态，可再调 plan(complete)`);
      return new Text(header + body, 0, 0);
    }

    case "complete-later": {
      // later 档（D1 later 边）：用户显式「暂不执行」——不是解散，不进解散文案桶（A9 反向）
      const header = fg("success", `✓ 计划已批准 · 未派发执行`) + NL;
      const body = fg("dim", `  ${details.choice} · 需要时说『执行』或再调 plan(complete)`);
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

    case "review-dismissed": {
      // dismiss（D3）：审阅已搁置，plan 模式保持——渲染区别于失败出口（不是 error）
      const header = fg("success", `✓ 审阅已搁置（${details.docsCount} 份文档保留）`) + NL;
      const body = fg("dim", "  plan 模式保持，进度不变 · 等用户指示");
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

/**
 * 双宿主挂起提问原语（D-B4-2）：宿主判定与挂起登记簿记收进本函数，业务代码零宿主分流
 * ——调用方只提供两宿主各自的提问形态（gui = taiji rpc 宿主走 marker 通道 FormOverlay；
 * tui = 独立 pi / TUI 走原生交互形态），不判定宿主。E8 审批挂起与 complete 执行方式
 * 两处挂起点共用；宿主分流的唯一显式保留点 = index.ts E3 恢复分流（那是宿主行为策略
 * 不是交互形态，设计 D-B4-2 边界）。
 * 挂起 signal 经形态回调入参透出（两宿主形态都挂在同一个 PendingSelect.controller 上，
 * turn abort 级联与 exitPlanMode 解散对两宿主同样可达）。
 */
async function askInteractively<S>(
  ctx: ExtensionContext,
  planCtx: PlanCtx,
  sessionId: string,
  signal: AbortSignal | undefined,
  forms: {
    /** taiji GUI 宿主形态（marker 通道）；入参 = 挂起 signal */
    gui: (pendingSignal: AbortSignal) => Promise<S>;
    /** 独立 pi / TUI 宿主形态；入参 = 挂起 signal */
    tui: (pendingSignal: AbortSignal) => Promise<S>;
  },
): Promise<{ value: S; pending: PendingSelect }> {
  // E10 生命周期钉死：每次发挂起交互前新建 PendingSelect（禁复用已 abort 的——
  // pi 对已 abort signal 短路立即 resolve undefined）
  const pending = freshPendingSelect(planCtx.controllers, sessionId);
  cascadeTurnAbort(pending.controller, signal);
  const form = isTaijiGuiHost(ctx) ? forms.gui : forms.tui;
  const value = await form(pending.controller.signal);
  // 交互已 settled，注册表条目即弃（不留已 settled 的挂起）
  planCtx.controllers.delete(sessionId);
  return { value, pending };
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
  planCtx: PlanCtx,
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

  const { prompt } = activatePlanMode(pi, planCtx.states, sessionId, ctx, {
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
 * - 单次扫描复用（C1 去重）：清单查找与内容读取共用同一次扫描产物（胜者 path
 *   直读——utf-8、失败 null）。
 * - content 全文直达模型可见通道（现状全文放 details 不进模型，选完没骨架——
 *   §2.2 第二处错位收口）；details 不再携带全文（零消费方，避免双份持久化）。
 * - 错名报错带可用名字清单：模型当场从报错自愈，无需任何查询 action（D3）。
 * - --template 直传防御：模板已由用户指定并全文内嵌注入，select-template 是
 *   画蛇添足——报错不带三源清单（直传文件不在清单里，清单会误导改选内置
 *   模板、偏离用户意图）。判定信号 = templateProvided（独立布尔字段，双字段
 *   合并后形态）。
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
  if (state.templateProvided === true) {
    throw new Error("template was provided via --template, write the plan following the file above");
  }
  const templates = listTemplates({ projectRoot: projectDir });
  const winner = templates.find((t) => t.name === templateName);
  if (!winner) {
    throw new Error(`Template not found: ${templateName}. Available: ${templates.map((t) => t.name).join(", ")}`);
  }
  // 胜者内容直读（单次扫描复用——readFileSync utf-8 / 失败 null）
  let content: string | null;
  try {
    content = fs.readFileSync(winner.path, "utf-8");
  } catch {
    content = null;
  }
  if (content === null) {
    throw new Error(`Template not readable: ${winner.path}`);
  }
  // 无生命周期事件（9 事件表无 select-template 员）——不写生命周期态，persist 携带
  // state 现值（生命周期写唯一通道 = applyPlanEvent，本 action 无转移）
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

// ── exit 链单入口（D-B1-1）────────────────────────────────────────

/** exit 触发方：'command' = /plan abort 命令路径；'tool' = plan 工具 abort action 路径 */
export type ExitReason = "command" | "tool";

/** exitPlanMode 的结果（§3.1 终态）：落盘转移结果 + 面向用户的反馈文案 */
export interface ExitResult {
  /** 'exit' 转移是否 ok（false = 非活跃格幂等退出——状态值未写；坏格 isActive 清洗例外除外） */
  moved: boolean;
  /** 面向用户的反馈文案：成功 = 退出确认（tool 路作 result 文本、command 路作 notify 内容）；ok:false = warn 纠偏文案 */
  message: string;
  /** notify 级别：成功 info；ok:false warn（两通道统一 warn 纠偏，D-B1-1 行为变更声明） */
  level: "info" | "warning";
}

/** ok:false 分派文案（按格分家，A9 错误即纠偏指令）：idle 常态格 vs 终态格 */
const EXIT_IDLE_MESSAGE = "No active plan mode.";
const EXIT_INACTIVE_MESSAGE =
  "Plan mode is not active (it already completed or exited) — nothing to abort. " +
  "Do not implement any changes; wait for further user instructions.";

/**
 * exit 链唯一入口（D-B1-1）：/plan abort（handleAbort）与 plan 工具 abort action
 * （executeAbort）双路收敛于此，动作清单由入口统一编排（顺序是结构的一部分）：
 * ① 解散全部挂起 select（markDissolved('self') 一次打标 + controller.abort()——E10
 *   因果链：abort 触发的 select 解析是微任务，等待处归口必在本函数同步段之后运行，
 *   打标先行保证归口读到 'self'）；
 * ② 转移 + 落盘：单守卫 = transition('exit') 合法性（非活跃格全谱：终态格 + idle 删边
 *   后均 ok:false）——ok:false 跳过状态值写入（completed 终态记录不被 exited 覆写）；
 *   坏数据格例外（isActive=true 的终态/idle 残留）：仍落一条清洗 entry——isActive=false
 *   投影复位是用户级恢复通道（免覆写与投影清洗正交可分），state 值按当前态分派
 *   （终态残留取当前终态值不变、idle 残留落 'exited'，resetPlanState 既有 terminal
 *   参数直接承载）；
 * ③ widget 更新 ④ 工具集恢复（单份实现；ok:false 时同样执行——幂等恢复，已恢复则 no-op）
 * ⑤ 反馈文案。
 * 守卫极性统一「ok:false → warn + 幂等退出」：退出是用户显式意图，非活跃态下退出
 * 即目标态；①③④⑤照常（解散残余挂起正是消灭「卡在等待应答」形态的动作）。
 * ① 的承载 = PlanCtx.dissolveAll（D-B4-3 单 ctx 对象方法——批次 1 的内联遍历打标
 * 在本批随 ctx 载体落地改调它）。
 */
export function exitPlanMode(
  pi: ExtensionAPI,
  planCtx: PlanCtx,
  sessionId: string,
  ctx: ExtensionContext,
  state: PlanState,
  reason: ExitReason,
): ExitResult {
  // ① 解散挂起（含 markDissolved）：来源随闭包直达等待处（D-B1-2 直传，旧世代计数机制退役）
  planCtx.dissolveAll("self");

  // ② 转移 + 落盘（ok:false 跳过状态值写入；坏格 isActive=true 清洗例外）
  const moved = applyPlanEvent(state, "exit");
  let updatedState = state;
  if (moved.ok) {
    updatedState = resetPlanState(pi, planCtx.states, sessionId, ctx, "exited");
  } else if (state.isActive) {
    // 坏数据格清洗例外：终态残留（completed/exited）取当前终态值不变；idle 残留落
    // 'exited'（abort 是用户显式退出意图，exited 是本次动作的真实记录）——活跃态
    // 在此不可达（exit 边合法不会 ok:false），三元兜底仅满足类型收窄
    const current = state.state;
    const terminal: PlanTerminalState = current === "completed" || current === "exited" ? current : "exited";
    updatedState = resetPlanState(pi, planCtx.states, sessionId, ctx, terminal);
  }

  // ③ widget 更新 ④ 工具集恢复（幂等：已恢复则 no-op）
  updatePlanWidget(ctx, updatedState);
  restoreFullToolSet(pi);

  // ⑤ 反馈
  if (!moved.ok) {
    return { moved: false, message: state.state === "idle" ? EXIT_IDLE_MESSAGE : EXIT_INACTIVE_MESSAGE, level: "warning" };
  }
  return {
    moved: true,
    message: reason === "tool" ? "Plan mode aborted. Full tool access restored." : "Plan mode aborted.",
    level: "info",
  };
}

function executeAbort(
  pi: ExtensionAPI,
  planCtx: PlanCtx,
  sessionId: string,
  ctx: ExtensionContext,
  state: PlanState,
): ActionResult {
  // 单入口接管（D-B1-1）：动作清单（解散/转移落盘/widget/工具集恢复）全在 exitPlanMode
  // 内；本函数只负责把 ExitResult 投影为 tool result 形态（纠偏文案复用 reason='inactive'
  // 出口——错误即纠偏指令，A9）
  const result = exitPlanMode(pi, planCtx, sessionId, ctx, state, "tool");
  if (!result.moved) {
    return reviewErrorResult("inactive", result.message);
  }
  return {
    content: [{ type: "text" as const, text: result.message }],
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
  // 无生命周期事件（9 事件表无 register-doc 员）——不写生命周期态，persist 携带
  // state 现值（生命周期写唯一通道 = applyPlanEvent，本 action 无转移）
  persistPlanState(pi, state);

  return {
    content: [{ type: "text" as const, text: `Registered ${fileName} (v${version})` }],
    details: { action: "register-doc", fileName, version },
  };
}

/**
 * PlanReviewResponse 值域守卫与解析已接 canonical（consumers.md ①：本地守卫删除迁移）——
 * `@zhushanwen/extension-protocol` 的 `parsePlanReviewResponse`（unknown-decision / malformed
 * 双分源降级）。运行时守卫 TS 穷尽性管不到，值域单一权威不得在消费侧镜像。
 */

/** E5/E6/取消共用错误 result 构造（content 文本即恢复动作） */
function reviewErrorResult(reason: ReviewErrorDetails["reason"], recovery: string): ActionResult {
  return {
    content: [{ type: "text" as const, text: recovery }],
    details: { action: "review-error", reason },
  };
}

/**
 * submit-review（D5/E6/E8/E10/D9/D3）：
 * - E6 双守卫：isActive=false → 错误不挂 select；docs 空 → 错误提示先 register-doc。
 * - D9① 自审硬门（无豁免）：每次 submit-review 必带非空 selfReview（含修订后重挂；E3 重挂
 *   复用既有结论但过门义务不豁免）+ 防照抄启发式（逐字节陈旧拒收，gate 判定先于一切写入、
 *   拒收不更新任何快照——拒收后重试仍触发）。
 * - 挂起前落 state='reviewing'（transition 'submit'）+ selfReview（写侧 4KB 截断）+ docs
 *   快照指纹 + resumeHint 清除（重挂起点）——同一记录点，text/gui 两分支共用。
 * - 宿主分流：taiji rpc 宿主（TAIJI_AGENT_EXT_LOG=1 且 mode==='rpc'）发
 *   PLAN_REVIEW_MARKER select；其余形态（独立 pi / env 泄漏的非 rpc）返回 E8 文本软门。
 * - select 挂 signal（E10），resolve 后：echo 判定先于 parse → canonical 值域解析
 *   （unknown-decision / malformed 双分源）→ 按 decision 消费（approve/revise/dismiss）；
 *   choice===undefined 走归口①（D-B1-2：dissolvedBy 直传判别）。
 */
/** submit-review 挂起提问的形态应答（D-B4-2 原语消费面）：select = marker 通道应答；text-gate = E8 软门（不挂交互） */
type SubmitReviewAskResult =
  | { kind: "select"; choice: string | undefined; payload: string }
  | { kind: "text-gate" };

async function executeSubmitReview(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PlanState,
  planCtx: PlanCtx,
  sessionId: string,
  projectDir: string,
  signal: AbortSignal | undefined,
  params: Record<string, unknown>,
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

  // D9① 自审硬门（结构保证层：存在性非空必填，无豁免）：缺失/空 → tool result 错误纠偏
  //（不 throw）——提示词是引导不是闸门（F10 教训），门语义三层边界见设计 D9
  const selfReview = typeof params.selfReview === "string" ? params.selfReview.trim() : "";
  if (selfReview === "") {
    return reviewErrorResult(
      "no-self-review",
      "submit-review requires a non-empty selfReview. First do a self-review: (1) check every requirement item is covered, (2) audit assumptions ([UNVERIFIED] cleared or explicitly listed), (3) check chapter completeness against the template, (4) verify the acceptance scenarios are truly executable. Fix any document issues found DURING the self-review first, then call plan(action='submit-review', selfReview='<your self-review conclusions>') again.",
    );
  }

  const fingerprint = planDocsFingerprint(state.docs);
  // D9① 防照抄启发式（启发式层：逐字节陈旧拒收，微改文本即绕过不假装能验证思想）：
  // 文档已变（指纹与上次快照不同）而 selfReview 与上次提交值逐字节相同 → 拒收。比较按
  // 写侧截断口径（超长输入截断后比，防截断缝隙绕过）。gate 判定先于一切写入、拒收不更新
  // 任何快照（拒收后重试仍触发——契约测试锁定）；E3 重挂（指纹未变 + 同值）不触本门。
  const boundedSelfReview = truncateSelfReview(selfReview);
  const docsChangedSinceLastSubmit =
    state.lastSubmitReviewDocsFingerprint !== undefined &&
    state.lastSubmitReviewDocsFingerprint !== fingerprint;
  if (docsChangedSinceLastSubmit && state.selfReview !== undefined && boundedSelfReview === state.selfReview) {
    return reviewErrorResult(
      "stale-self-review",
      "The documents have changed since the last submit-review, but selfReview is byte-identical to the previous submission. You MUST redo the self-review against the NEW document versions (re-read the revised files first). Fix any issues found, then call plan(action='submit-review', selfReview='<the new self-review>') again.",
    );
  }

  // 重提交无变化检测：指纹与上次快照相同 ⇔ 上次 submit-review 后无任何 register-doc。
  // 快照缺失 = 无既往提交（首次 / reset 后新轮次 / 旧版 entry 重挂），不警告。
  const unchangedResubmit =
    state.lastSubmitReviewDocsFingerprint !== undefined &&
    state.lastSubmitReviewDocsFingerprint === fingerprint;

  // 状态写走 transition()（D1 'submit' 边：planning|revising → reviewing）。reviewing 重挂
  //（E3 恢复 / D8「重新提交审批」按钮）走 reviewing --submit--> reviewing 自环（D-B1-8
  // 补边——自环前后落盘产物等价：state 值不变、照常落盘重挂；resumeHint 清除与快照更新
  // 同点）。其余 ok:false = FSM 合法性兜底，不落盘直接纠偏
  const moved = applyPlanEvent(state, "submit");
  if (!moved.ok) {
    return reviewErrorResult(
      "out-of-order",
      `The plan is in state '${state.state}' and cannot be submitted for review (it is past the review stage). ` +
      `To execute, call plan(action='complete') to choose an execution method. ` +
      `To start a fresh planning round, call plan(action='abort') first, then plan(action='enter'). ` +
      `Do not implement any changes the user has not approved.`,
    );
  }

  // 挂起 select 前落盘（单一记录点）：state（reviewing）+ selfReview（E3 回传源 + 防照抄
  // 比较基线——单字段双角色，同值同写点无分歧路径）+ 指纹快照（text/gui 两检测分支共用）+
  // per-round 字段清除（D4 单函数出口——不变量：resumeHint 只描述当前降级等待的原因，
  // 此处即将挂起真审批，残留 'resubmit' 会渲染上一轮「会话已重启」文案，C-U2 同型残留）；
  // selfReview / 指纹紧随置位本轮新值（delete→set 属性终态与原仅清 resumeHint 等价）
  clearRoundFields(state);
  state.selfReview = boundedSelfReview;
  state.lastSubmitReviewDocsFingerprint = fingerprint;
  persistPlanState(pi, state);

  // 双宿主挂起提问（D-B4-2 原语：宿主判定收进 askInteractively，此处零分流）——
  // taiji GUI 宿主：PLAN_REVIEW_MARKER marker 通道 select（payload 惰性构造，软门路不构造）；
  // 独立 pi / TUI 宿主：E8 文本软门（不发 marker select——env 信号只证明 taiji runtime
  // 在上游，mode 非 rpc（env 泄漏到独立 pi TUI / json / print）时宿主没有 marker 路由，
  // pi TUI 会把 \x00 title + JSON options 渲染成乱码对话），审批退化为自然语言软门，
  // 不挂交互。软门路的 PendingSelect 登记、settle、清理由原语瞬时完成（无交互挂起窗口）
  const { value: ask, pending } = await askInteractively(ctx, planCtx, sessionId, signal, {
    gui: async (pendingSignal): Promise<SubmitReviewAskResult> => {
      // selfReview 随 payload 投影（D9③：截断点 = payload 构造单点，透传层不截）
      const payload = JSON.stringify({ docs: state.docs, selfReview: boundedSelfReview } satisfies PlanReviewRequest);
      const choice = await ctx.ui.select(PLAN_REVIEW_MARKER, [payload], { signal: pendingSignal });
      return { kind: "select", choice, payload };
    },
    tui: async (): Promise<SubmitReviewAskResult> => ({ kind: "text-gate" }),
  });

  if (ask.kind === "text-gate") {
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
      details: submitReviewDetails("text", state.docs.length),
    };
  }
  const { choice, payload } = ask;

  if (choice === undefined) {
    // 归口①（审批 select 无选择解散，两归口点之一）：解散来源直传判别（D-B1-2）——
    // exitPlanMode 入口解散时 markDissolved('self') 已随闭包打标（同步先于 abort、
    // 归口在微任务侧运行时必已置位）→ 命令解散，reset 终态已由入口落盘 → 归口 no-op
    // 不落盘；非 'self'（undefined——turn abort 级联 / TUI 手动取消不经入口不打标）→
    // 外部解散。读-转移-落盘同一同步临界段（getPlanState 现值读取，禁闭包快照跨 await
    // 复用）；状态机守卫（transition 合法性，终态上 ok:false 不落盘）保留为结构兜底
    if (pending.dissolvedBy === "self") {
      // 文案按判别分源（A9 教训：文案是行为触发面）
      return reviewErrorResult(
        "cancelled",
        "Plan mode has been exited and the full tool set is restored. This is NOT an approval. Do not implement any changes. Briefly tell the user you have stopped, then wait for further user instructions.",
      );
    }
    // 外部解散：reviewing --review_aborted--> planning。取消 ≠ 批准（A9 收紧）：禁止实施、
    // 等用户指示（重挂由用户触发——D8 按钮 / 提示词纪律，不再引导 agent 自动重挂）
    const current = getPlanState(planCtx.states, sessionId, ctx);
    const aborted = applyPlanEvent(current, "review_aborted");
    if (aborted.ok) persistPlanState(pi, current);
    return reviewErrorResult(
      "review-interrupted",
      "The review was interrupted — plan mode is still active (planning). This is NOT an approval. Do not implement any changes. Wait for the user's instructions; when they ask to re-submit, call plan(action='submit-review', selfReview='...') again.",
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

  // canonical 值域解析（consumers.md ①：本地守卫删迁移，值域单一权威不镜像）：JSON 解析
  // 与形状/值域守卫分离，unknown-decision 与 malformed 双分源降级（文案语义相反）
  let parsed: unknown;
  try {
    parsed = JSON.parse(choice);
  } catch (error) {
    // E5：解析失败 → logger.warn + 提示 agent 重挂审批；
    // 不把可能损坏的数据按任何 decision 注入对话（垃圾数据不进流）
    logger.warn("plan: submit-review select response parse failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return reviewErrorResult(
      "bad-response",
      "The review response could not be parsed. No action was taken — call plan(action='submit-review', selfReview='...') again to re-hang the review for the user.",
    );
  }
  const envelope = parsePlanReviewResponse(parsed);
  if (!envelope.ok) {
    // unknown-decision（已知形状、未知值域）与 malformed 同款 bad-response 出口（条目 7
    // 降级：独立 version-mismatch 报错删除）——原子发版（Q-4）下「新扩展 + 旧宿主」不可达，
    // 唯一窗口 = dev-link 版本错开，该窗口恢复动作 = dev-link 重新对齐版本后重试。
    // warn 留痕版本错配信号：生产环境出现 = 错配组合真实可达的反证，重审本条删除
    //（候选替代 = 恢复独立 version-mismatch 不引导重挂出口）。
    if (envelope.code === "unknown-decision") {
      logger.warn(
        "plan: submit-review response decision out of domain (possible host/extension version mismatch — re-align versions via dev-link, then retry)",
        { decision: envelope.decision },
      );
    } else {
      // malformed（E5 垃圾数据判据）：形状不合法按解析失败同款处理，引导重挂
      logger.warn("plan: submit-review select response shape invalid (malformed)");
    }
    return reviewErrorResult(
      "bad-response",
      "The review response does not match the PlanReviewResponse shape. No action was taken — call plan(action='submit-review', selfReview='...') again to re-hang the review for the user.",
    );
  }
  const response = envelope.response;

  switch (response.decision) {
    case "approve":
      // approve → 走 complete 流程（执行方式 select 同样挂 signal）；approve 边
      //（reviewing --approve--> dispatching，D5）由 executeComplete 入口的 transition 承载
      return await executeComplete(pi, ctx, {}, state, planCtx, sessionId, projectDir, signal);

    case "dismiss": {
      // D3 搁置（协议级 dismiss 决策，取代「忽略 = 杀 turn」）：reviewing --dismiss--> planning
      // 落盘——被搁置的审批不复活（F1/F2/F3 构造性消除）；非破坏动作（不杀 turn、不丢状态），
      // 不需要确认 Popover（F16 守卫倒挂随之消解）。
      // 非归口分支的交错安全：select settle → 消费 continuation 先于下一消息 handler 执行
      //（D3 实施注释级钉死），闭包 state 此处即现值；ok:false 时不落盘（兜底）
      const movedDismiss = applyPlanEvent(state, "dismiss");
      if (movedDismiss.ok) persistPlanState(pi, state);
      return {
        content: [{
          type: "text" as const,
          text: "The user set this review aside (dismissed). Plan mode stays active and the documents and progress are unchanged. Briefly tell the user the review was set aside and ask what they want next (continue refining / wait for instructions). Do not implement any changes.",
        }],
        details: { action: "review-dismissed", docsCount: state.docs.length },
      };
    }

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
      // 状态写走 transition()（D1 'revise' 边：reviewing → revising）；交错安全同 dismiss 分支注释
      const movedRevise = applyPlanEvent(state, "revise");
      if (movedRevise.ok) persistPlanState(pi, state);
      return {
        content: [{
          type: "text" as const,
          text: withUnchangedWarning(
            `User requested revision with ${response.comments.length} comment(s) — injected into the conversation. Handle the comments, re-register revised documents, then re-submit for review (with a fresh selfReview for the revised documents).`,
            unchangedResubmit,
          ),
        }],
        details: submitReviewDetails("gui", state.docs.length),
      };
    }

    default: {
      // 判别联合穷尽性守卫：parsePlanReviewResponse 已收窄 decision 值域，此处不可达；
      // 编码期新增 decision 漏改 switch 会被 never 断言在编译期拦截
      const unreachable: never = response;
      throw new Error(`plan: unhandled review decision: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * 执行方式选项（2026-09-21 用户裁决重排）：选项集 = 检测到的 plan-exec skills
 * （root 序前 2 个，label `用技能「name」执行`）+ 普通执行（execute 档——经
 * deliverExecutionNotice 整合 goal 桥与 auto-parallel subagent 委派指导）+ 暂不执行
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

/** Build execution options: up to MAX_SKILL_OPTIONS detected plan-exec skills + execute + not-now.
 *  （上限常量 SSOT 在 prompts.ts——PHASE_D 散文与这里同源；导出供对齐测试消费。） */
export function buildExecOptions(execSkills: ExecSkill[]): ExecOption[] {
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
 * 「暂不执行」档的 mode 值（选项集内的固定成员，label 经 i18n；选中即 later 边——
 * dispatching --later--> approved，留在 plan mode）。
 */
const LATER_MODE = "later";

/**
 * 执行方式选择的 outcome（D3 连带段）——**显式 `via: 'later' | 'dissolved'` 枚举**，
 * 五构造点各自声明、归口点直读判别，**不从 result/details 反推**：choice 被压平进
 * details.reason 后两构造函数产出同形 reason，字面按「reason 非空」判会把 channel-error
 * （reason 非空且 ≈ 'cancelled'）误入 later 桶（A9 反向误分类）。
 * 五构造点：① LATER_MODE（用户显式「暂不执行」→ via 'later'，是明确选择不是解散）；
 * ② choice 空 / ③ uiFormInteract cancel / ④ timeout / ⑤ channel-error、non-json 等非 ok
 * 其余 reason → 均 via 'dissolved'（无选择解散，归口点执行 review_aborted 转移义务）。
 * mode 分支的 `pickedBy`（D7②）：'headless' = 无 UI 默认 execute；'no-exec-skills' =
 * 无 plan-exec 技能直通（不挂表单）；'dialog' = 表单/选择器选定。
 */
type CompleteChoiceOutcome =
  | { kind: "mode"; chosenMode: string; skillEntryPath?: string; pickedBy: "headless" | "no-exec-skills" | "dialog" }
  | { kind: "cancelled"; via: "later"; chosenLabel: string }
  | {
      kind: "cancelled";
      via: "dissolved";
      /** 构造点原始原因（②③④ 折叠 'cancelled'；⑤ 透传 form.reason） */
      reason: string;
      /** 通道失败补充说明（构造点⑤携带，归口文案拼接） */
      message?: string;
      /**
       * 解散来源（D-B1-3 via 侧迁移：与审批 select 的 dissolvedBy 统一为同一来源直传
       * 原语，值域 self|external——挂起 settle 后从 PendingSelect 槽位一次性读定，
       * 非 'self' 即外部；归口按 by 分派，不再持有挂起句柄反查）
       */
      by: "self" | "external";
    };

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
/** 双宿主形态的统一应答（D-B4-2 原语消费面）：answered = 拿到 label（空/缺省 = 无选择）；channel-failure = GUI 通道非 ok */
type ChoiceAskResult =
  | { kind: "answered"; label: string | undefined }
  | { kind: "channel-failure"; reason: string; message?: string };

async function resolveCompleteChoice(
  ctx: ExtensionContext,
  planCtx: PlanCtx,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<CompleteChoiceOutcome> {
  if (!ctx.hasUI) {
    return { kind: "mode", chosenMode: "execute", pickedBy: "headless" };
  }

  // complete 时现扫 plan-exec skill（无缓存，技能热装可见；检测自带降级规格，
  // 最坏 = skill 选项空集，绝不炸本流程）。选项构造时一次解析，skillEntryPath 随 outcome 流转
  const execSkills = detectExecSkills({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() });
  // D7②（设计 §3.1 终态 6 / S4）：无 plan-exec 技能**不挂执行方式表单**——「确认执行」
  // 按钮语义自洽，approve 直通 execute 走完执行派发链（goal 桥/直执 steer）；「暂不执行」
  // 需求由「不点确认执行 / 搁置」覆盖。恒两项死表单（F6 用户可感形态）构造性消除。
  if (execSkills.length === 0) {
    return { kind: "mode", chosenMode: "execute", pickedBy: "no-exec-skills" };
  }
  const execOptions = buildExecOptions(execSkills);

  // 双宿主挂起提问（D-B4-2 原语：宿主判定收进 askInteractively，此处零分流）——
  // taiji GUI 宿主：uiFormInteract 单 choice 问题（FormOverlay 单视图）；独立 pi / TUI
  // 宿主：pi 原生 plain select。headless 与无技能直通两路是宿主策略/业务直通（非交互
  // 形态分派），留在原语之前。E10：执行方式 select 与 submit-review 审批 select 同为
  // 挂起点（原语统一挂 signal）——approve 后的挂起窗口内用户点 PlanModeBar 退出
  //（确认 Popover 后）必须可达（abort → resolve undefined → cancelled）
  const { value: ask, pending } = await askInteractively(ctx, planCtx, sessionId, signal, {
    gui: async (pendingSignal): Promise<ChoiceAskResult> => {
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
        { signal: pendingSignal },
      );
      if (!form.ok) {
        // 构造点③（cancel）与④（timeout）：库层以 signal.aborted 判 cancelled，GUI 用户取消
        // resolve undefined 与超时不可区分——两构造点分开声明、同折 reason 'cancelled'
        const reason = form.reason === "cancelled" || form.reason === "timeout" ? "cancelled" : form.reason;
        return { kind: "channel-failure", reason, message: form.message };
      }
      return { kind: "answered", label: form.answers[questionHeader] };
    },
    tui: async (pendingSignal): Promise<ChoiceAskResult> => {
      const labels = execOptions.map((opt) => opt.label);
      return { kind: "answered", label: await ctx.ui.select(t("exec.question"), labels, { signal: pendingSignal }) };
    },
  });

  // 构造点⑤（channel-error / non-json 等非 ok 其余 reason）：via 'dissolved'
  //（交互通道故障折叠，不炸 turn 也不默认执行）
  if (ask.kind === "channel-failure") {
    return {
      kind: "cancelled",
      via: "dissolved",
      reason: ask.reason,
      message: ask.message,
      by: pending.dissolvedBy ?? "external",
    };
  }
  // 构造点②（choice 空）：无选择解散 → via 'dissolved'
  if (!ask.label) {
    return { kind: "cancelled", via: "dissolved", reason: "cancelled", by: pending.dissolvedBy ?? "external" };
  }
  const chosenLabel = ask.label;
  const option = execOptions.find((opt) => opt.label === chosenLabel);
  if (!option) {
    // 选项集与 labels 同源构造，选中的 label 必在集内——找不到即编码 bug，fail-fast
    throw new Error(`plan: unknown execution choice label: ${chosenLabel}`);
  }
  // 构造点①（LATER_MODE）：用户显式「暂不执行」→ via 'later'（明确选择，不是解散）
  if (option.mode === LATER_MODE) {
    return { kind: "cancelled", via: "later", chosenLabel };
  }
  return { kind: "mode", chosenMode: option.mode, skillEntryPath: option.skillEntryPath, pickedBy: "dialog" };
}

/**
 * complete 的 result 正文：goalInit 同步完成，追加 goal 结果行（D2）。
 * D7② 直通（no-exec-skills）明示一行——工具结果文案不得静默吞掉「没弹表单」的事实。
 */
function completeResultText(
  displayPath: string,
  goalOutcome: GoalBridgeOutcome | undefined,
  execModeSource: "headless" | "no-exec-skills" | "dialog",
): string {
  const base = `Plan approved. File: ${displayPath}`;
  const directLine =
    execModeSource === "no-exec-skills"
      ? `\nNo plan-exec skill was detected — executed directly (no execution-method dialog).`
      : "";
  if (goalOutcome === undefined) return base + directLine;
  return goalOutcome.started
    ? `${base}${directLine}\nGoal tracking started via /goal.`
    : `${base}${directLine}\nGoal tracking was not started (${goalOutcome.reason}). ${GOAL_FAILURE_RECOVERY[goalOutcome.reason]}`;
}

/**
 * complete action（D5/D3 连带段）：approve 边入 dispatching → 选档 → 归口② / exec_chosen 终局。
 * 双入口共用：① submit-review 的 approve 决策消费（reviewing --approve--> dispatching）；
 * ② agent 再调 complete 重新选择执行方式（approved --approve--> dispatching，事件命名裁决
 * consumers.md §三B）。
 */
async function executeComplete(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: Record<string, unknown>,
  state: PlanState,
  planCtx: PlanCtx,
  sessionId: string,
  projectDir: string,
  signal: AbortSignal | undefined,
): Promise<ActionResult> {
  // E6 同族状态门（退出/终局后任何动作都不该发生）
  if (!state.isActive) {
    return reviewErrorResult(
      "inactive",
      "Plan mode is not active (it already completed or exited) — nothing to complete. No plan has been approved for execution here — do not implement any changes. Briefly tell the user, then wait for further user instructions.",
    );
  }
  // 状态写走 transition()（D1）：'approve' 双入口同边。D5：审批消费后、执行方式表单挂起前
  // 落盘 dispatching（取代「先清 reviewState」——挂起期间 derivePhase(dispatching)='approved'
  // 映射「③审阅确认·已完成」，阶段不倒退，F5 不复活；崩溃后 E3 按 state 查表可恢复）
  const movedApprove = applyPlanEvent(state, "approve");
  if (!movedApprove.ok) {
    // FSM 合法性兜底：未经审批闸口（planning/revising 等）不进执行方式选择——纠偏指回
    // submit-review（ok:false 不落盘、不执行副作用；执行前的用户审批闸口是结构性保证）
    return reviewErrorResult(
      "out-of-order",
      `The plan is in state '${state.state}' and has not been approved — do NOT execute anything. ` +
      `Present the plan for review first: when all documents are done, call plan(action='submit-review', selfReview='<your self-review>') and wait for the user's approval.`,
    );
  }
  persistPlanState(pi, state);

  const choice = await resolveCompleteChoice(ctx, planCtx, sessionId, signal);
  if (choice.kind === "cancelled") {
    // 归口②（两归口点之二）：via 判别**先于**解散源判别（later 是显式选择，
    // 不涉解散源判别）。读-转移-落盘同一同步临界段（禁闭包快照跨 await 复用）
    const current = getPlanState(planCtx.states, sessionId, ctx);
    if (choice.via === "later") {
      // later 边（D1）：dispatching --later--> approved——用户显式「暂不执行」是明确选择，
      // **不是解散**，不得进 review_aborted/外部解散文案桶（否则 A9 反向重演）。
      const movedLater = applyPlanEvent(current, "later");
      // ok:false（fresh-read 后已非 dispatching，如 exitPlanMode 交错已落 exited）不落盘
      //（终态上不落盘 = 归口点双保险），走与下方 exec_chosen ok:false 同型的中性
      // state-changed 出口——此时复用 APPROVED 成功文案会与真实状态相反，误导 agent 下一步
      if (!movedLater.ok) {
        return reviewErrorResult(
          "out-of-order",
          "The plan state changed while the execution-method prompt was pending — nothing was dispatched and no changes were made. Check the current plan state with the user before proceeding.",
        );
      }
      persistPlanState(pi, current);
      return {
        content: [{
          type: "text" as const,
          text: `User chose: ${choice.chosenLabel}. The plan is APPROVED but NOT dispatched for execution — do not implement any changes yet. Stay available: when the user wants to execute (e.g. says "execute"), call plan(action='complete') again to choose an execution method.`,
        }],
        details: { action: "complete-later", choice: choice.chosenLabel },
      };
    }
    const detail = choice.message ? ` (${choice.message})` : "";
    if (choice.by === "self") {
      // 入口解散（exitPlanMode 打 'self' 标，reset 终态已由入口落盘）→ 归口 no-op，不落盘
      //（D-B1-3：via 侧迁移后与审批 select 同源判别——outcome 携带直传来源）
      return {
        content: [{
          type: "text" as const,
          text: "Plan mode has been exited while the execution-method prompt was pending, and the full tool set is restored. The plan has NOT been dispatched for execution — do not implement any changes. Briefly tell the user you have stopped, then wait for further user instructions.",
        }],
        details: { action: "complete-cancelled", reason: choice.reason, source: "self" },
      };
    }
    // 外部解散（turn abort 级联 / 表单取消 / 超时 / 通道故障折叠）：
    // dispatching --review_aborted--> approved（批准事实保留——不把「已批准」打回规划期，F5 不复活）
    const movedDissolve = applyPlanEvent(current, "review_aborted");
    if (movedDissolve.ok) persistPlanState(pi, current);
    return {
      content: [{
        type: "text" as const,
        text: `The execution-method choice was interrupted (${choice.reason}${detail}). Plan mode stays active and the plan remains APPROVED. The plan has NOT been dispatched — do not implement any changes. Wait for the user's instructions; when they want to execute, call plan(action='complete') again to choose an execution method.`,
      }],
      details: { action: "complete-cancelled", reason: choice.reason, source: "external" },
    };
  }
  const chosenMode = choice.chosenMode;

  // D6：原「persist final phase (complete)」为死状态落盘（P1 实证不可观测），
  // phase 删除后该 persist 与上一条 entry 完全重复，随死状态一并移除——
  // 最终态由下方 resetPlanState 的终态 entry 权威记录。
  const planFilePath = state.planFilePath;

  // exec_chosen（D1）：dispatching --exec_chosen--> completed（选定执行方式并派发，终态）。
  // 副作用内联在转移成功后；ok:false（reset 介入等异常格）→ 不派发不落盘的降级出口
  const movedExec = applyPlanEvent(state, "exec_chosen");
  if (!movedExec.ok) {
    return reviewErrorResult(
      "out-of-order",
      "The plan state changed while the execution-method prompt was pending — nothing was dispatched and no changes were made. Check the current plan state with the user before proceeding.",
    );
  }

  // Restore full tool set
  restoreFullToolSet(pi);

  // Execute completion handler (steer/goalInit delivery)
  const goalOutcome = handlePlanComplete(pi, ctx, state, chosenMode, choice.skillEntryPath);

  // 终局 reset（D3 连带段）：terminal 传 'completed'——防 reset 覆写 completed 终态
  const updatedState = resetPlanState(pi, planCtx.states, sessionId, ctx, "completed");
  updatePlanWidget(ctx, updatedState);

  const displayPath = relativePath(planFilePath, projectDir);
  return {
    content: [{ type: "text" as const, text: completeResultText(displayPath, goalOutcome, choice.pickedBy) }],
    details: {
      action: "complete",
      planFilePath: displayPath,
      execMode: chosenMode,
      execModeSource: choice.pickedBy,
      goalOutcome,
    },
  };
}

// ── Register tool ──────────────────────────────────────────────────

export function registerPlanTool(
  pi: ExtensionAPI,
  planCtx: PlanCtx,
): void {
  pi.registerTool({
    name: "plan",
    label: "Plan Mode",
    // 串行声明（D-B1-4）：全部 action 就地突变共享 PlanState，声明串行消除并行交错类
    //（A1 死锁机理的调度半边）。pi 0.84.4 声明粒度是工具级——同批任一 sequential 工具
    // 使整批工具顺序执行。pi 实装锚点：dist/core/extensions/types.d.ts:363-370（0.84.4，
    // executionMode 是 per-tool 声明，"sequential" = this tool must execute one at a time
    // with other tool calls）+ @earendil-works/pi-agent-core dist/agent-loop.js:287-288
    //（0.84.4，hasSequentialToolCall = toolCalls.some(...) 命中即整批走
    // executeToolCallsSequential）。单行回退通道 = 移除本声明即回默认并行。
    executionMode: "sequential",
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
      selfReview: Type.Optional(
        Type.String({
          description:
            "Your self-review conclusions (REQUIRED for submit-review, no exceptions — including re-submissions after revisions). " +
            "Before submitting: check every requirement item is covered, audit assumptions ([UNVERIFIED] cleared or explicitly listed), " +
            "check chapter completeness against the template, and verify the acceptance scenarios are executable. " +
            "Fix document issues found during self-review first, then pass the conclusions here.",
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
      "- submit-review — all documents done, request user review (selfReview is REQUIRED: your self-review conclusions first)\n" +
      "- complete — user approved plan, choose the execution method and exit plan mode\n" +
      "- abort — cancel plan mode\n" +
      "\n" +
      "Use the bash tool for ALL document content: writing files, updating chapters (e.g. cat heredoc).\n" +
      "\n" +
      "## End-to-end workflow example\n" +
      "1. plan(action='enter', requirement='add dark mode') — you (the agent) enter plan mode\n" +
      "2. Explore codebase (read, grep, bash) — brainstorming\n" +
      "3. Write each document, then plan(action='register-doc', fileName='...') for it\n" +
      "4. Self-review (coverage / assumptions / completeness / acceptance), fix issues, then\n" +
      "   plan(action='submit-review', selfReview='<your self-review conclusions>') — user reviews in the review UI or conversation\n" +
      "5. Address revision comments (rewrite + re-register), redo the self-review for the revised documents, re-submit until approved\n" +
      "6. plan(action='complete') — choose the execution method and exit plan mode\n" +
      "\n" +
      "When the user asks to re-submit the plan review (e.g. a re-submit notice), call plan(action='submit-review', selfReview='...') immediately — carry back your previous self-review verbatim when the documents are unchanged.\n" +
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
      const state = getPlanState(planCtx.states, sessionId, ctx);
      const projectDir = ctx.cwd;

      switch (action) {
        case "enter":
          return executeEnter(pi, params, state, planCtx, sessionId, ctx);

        case "select-template":
          return executeSelectTemplate(pi, params, state, projectDir);

        case "register-doc":
          return executeRegisterDoc(pi, params, state);

        case "submit-review":
          return await executeSubmitReview(pi, ctx, state, planCtx, sessionId, projectDir, signal, params);

        case "complete":
          return await executeComplete(pi, ctx, params, state, planCtx, sessionId, projectDir, signal);

        case "abort":
          return executeAbort(pi, planCtx, sessionId, ctx, state);
      }
    },
  });
}


