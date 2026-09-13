import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { detectGoalCapability, GOAL_FAILURE_RECOVERY, handlePlanComplete } from "./compact.js";
import type { GoalBridgeOutcome } from "./compact.js";
import type { PlanSessionMap, PlanState } from "./state.js";
import { getPlanState, persistPlanState, resetPlanState } from "./state.js";
import { listTemplates, loadTemplate } from "./templates.js";
import { updatePlanWidget } from "./widget.js";

// ── Action types ───────────────────────────────────────────────────

export const PLAN_ACTIONS = [
  "list-template",
  "select-template",
  "complete",
  "abort",
] as const;

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
  phase: string;
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

type PlanDetails =
  | ListTemplateDetails
  | SelectTemplateDetails
  | CompleteDetails
  | CompleteCancelledDetails
  | AbortDetails;

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

// ── renderResult ───────────────────────────────────────────────────

function renderPlanResult(
  result: { content: Array<{ type: string; text?: string }>; details?: PlanDetails },
  _options: unknown,
  theme: Theme,
): Text {
  const details = result.details;
  if (!details) {
    const text = result.content[0];
    return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
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
      const body = fg("dim", `  brainstorming → ${details.phase}`) + NL;
      const hint = fg("dim", "→ 按模板章节顺序写 plan.md");
      return new Text(header + body + hint, 0, 0);
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
  state.phase = "writing";
  persistPlanState(pi, state);
  return {
    content: [{ type: "text" as const, text: `Template selected: ${templateName}` }],
    details: { action: "select-template", templateName, content, phase: state.phase },
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
function buildExecOptions(pi: ExtensionAPI): string[] {
  const modeLabels = EXEC_MODE_OPTIONS
    .filter((opt) => opt.mode !== "goal" || detectGoalCapability(pi))
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
async function resolveCompleteChoice(ctx: ExtensionContext, pi: ExtensionAPI): Promise<CompleteChoiceOutcome> {
  const execOptions = buildExecOptions(pi);

  if (typeof ctx.ui.select !== "function") {
    return { kind: "mode", chosenMode: "single-agent" };
  }
  const choice = await ctx.ui.select("Plan is ready. Choose execution method:", execOptions);
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

/** complete action: prompt for execution mode, persist final phase, restore tools, reset state. */
async function executeComplete(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: Record<string, unknown>,
  state: PlanState,
  sessions: PlanSessionMap,
  sessionId: string,
  projectDir: string,
): Promise<ActionResult> {
  const choice = await resolveCompleteChoice(ctx, pi);
  if (choice.kind === "cancelled") {
    return choice.result;
  }
  const chosenMode = choice.chosenMode;

  // Persist final phase before cleanup
  const planFilePath = state.planFilePath;
  const isolation = (params.isolation as string) ?? "direct";
  state.phase = "complete";
  persistPlanState(pi, state);

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
): void {
  pi.registerTool({
    name: "plan",
    label: "Plan Mode",
    description:
      "Manages plan mode lifecycle (template selection, state transitions, completion). " +
      "NOT for writing plan content — write plan.md via the bash tool (e.g. cat heredoc). " +
      "Actions: list-template, select-template, complete, abort.",
    parameters: Type.Object({
      action: StringEnum(PLAN_ACTIONS, { description: "Action to perform" }),
      templateName: Type.Optional(Type.String({ description: "Template name (for select-template)" })),
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
      "- complete — user approved plan, exit plan mode\n" +
      "- abort — cancel plan mode\n" +
      "\n" +
      "Use the bash tool for ALL plan content: writing plan.md, updating plan chapters (e.g. cat heredoc).\n" +
      "\n" +
      "## End-to-end workflow example\n" +
      "1. /plan 'add dark mode' — user enters plan mode\n" +
      "2. AI explores codebase (read, grep, bash) — brainstorming\n" +
      "3. plan(action='list-template') → user picks → plan(action='select-template', templateName='...')\n" +
      "4. bash: cat > \"$PLAN_FILE\" <<'EOF' ... EOF — write plan content\n" +
      "5. User reviews → plan(action='complete', isolation='compact') — exit plan mode\n" +
      "\n" +
      "❌ plan(action='complete') to 'write the plan' — WRONG, write plan.md via the bash tool\n" +
      "✅ plan(action='complete') AFTER plan.md is written AND user approves",
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

        case "complete":
          return await executeComplete(pi, ctx, params, state, sessions, sessionId, projectDir);

        case "abort":
          return executeAbort(pi, sessions, sessionId, ctx);
      }
    },
  });
}
