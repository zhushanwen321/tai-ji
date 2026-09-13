import * as fs from "node:fs";
import { basename } from "node:path";

import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionBeforeTreeEvent } from "@earendil-works/pi-coding-agent";
import { guardStaleCtx, toErrorMessage } from "@zhushanwen/pi-ext-guards";
import type { GoalInitFn } from "@zhushanwen/pi-goal";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import type { PlanSessionMap, PlanState } from "./state.js";
import { getPlanState } from "./state.js";

const logger = getLogger("pi-plan");

export function registerPlanEventHandlers(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
): void {
  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getPlanState(sessions, sessionId, ctx);
    if (!state.isActive) return {};

    const prep = event.preparation;

    // Read plan file content for recovery after compact
    const planContent = readPlanFileSafe(state.planFilePath);

    // handler 已有 isActive 门——能走到这里的 plan 必然进行中（D6：phase 删除，原 phase="complete" 分支为死状态）
    const progressNote = "\nPlan was in progress — review and continue.";

    return {
      compaction: {
        summary:
          `Plan mode active. Plan file: ${state.planFilePath}\n\n` +
          `## Plan Content\n${planContent}\n\n` +
          `Requirement: ${state.requirement}` +
          progressNote,
        firstKeptEntryId: prep?.firstKeptEntryId,
        tokensBefore: prep?.tokensBefore,
      },
    };
  });

  pi.on("session_before_tree", async (_event: SessionBeforeTreeEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getPlanState(sessions, sessionId, ctx);
    if (!state.isActive) return {};

    const planContent = readPlanFileSafe(state.planFilePath);

    return {
      summary: {
        summary:
          `Plan mode active. Plan file: ${state.planFilePath}\n\n` +
          `## Plan Content\n${planContent}\n\n` +
          `Read the plan file and execute the implementation.`,
      },
    };
  });
}

/** Read plan file: ok=false 是显式信号（GoalBridgeOutcome 的 plan-unreadable 出口消费），消除哨兵字符串比较 */
type PlanFileContent = { ok: true; content: string } | { ok: false };

function readPlanFile(planFilePath: string): PlanFileContent {
  try {
    return { ok: true, content: fs.readFileSync(planFilePath, "utf-8") };
  } catch {
    return { ok: false };
  }
}

/** Read plan file, return content or human-readable marker (for prompt embedding) */
function readPlanFileSafe(planFilePath: string): string {
  const result = readPlanFile(planFilePath);
  return result.ok ? result.content : "(plan file could not be read)";
}

/**
 * goal 桥的单一断言点：goal 扩展挂在 pi.__goalInit 上的编程式接口（发现 7——
 * 此前 detectGoalCapability / tryGoalInit 两处 inline `pi as ExtensionAPI & { __goalInit? }`）。
 */
function getGoalInit(pi: ExtensionAPI): GoalInitFn | undefined {
  const api = pi as ExtensionAPI & { __goalInit?: GoalInitFn };
  return typeof api.__goalInit === "function" ? api.__goalInit : undefined;
}

/** Detect whether goal extension is available via its programming interface */
export function detectGoalCapability(pi: ExtensionAPI): boolean {
  return getGoalInit(pi) !== undefined;
}

/**
 * 从 plan 文件路径推导 goal slug（kebab-case；无有效字符时 fallback）。
 * 仅 widget 标题 + history 展示用，不注入 prompt。
 */
function buildPlanSlug(planFilePath: string): string {
  const stem = basename(planFilePath)
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "plan-execution";
}

/** step preview 条数上限（1 条总述 + 3 条 preview，合计 ≤4 条，满足 goal schema maxItems:8） */
const PREVIEW_COUNT = 3;
/** 单条 preview 最大长度（超出部分截断，以 "..." 结尾） */
const PREVIEW_MAX_CHARS = 80;
const ELLIPSIS = "...";

/** 折叠换行为空格：goal 侧 handler 拒绝含 \r\n 的条目 */
function toSingleLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

function truncatePreview(text: string): string {
  if (text.length <= PREVIEW_MAX_CHARS) return text;
  return text.slice(0, PREVIEW_MAX_CHARS - ELLIPSIS.length) + ELLIPSIS;
}

/**
 * 从 plan 步骤构造可检查的 successCriteria（plan 完成 = 所有步骤执行并验证）。
 * goal 的 complete 判定会对照本字段逐条做证据审计。
 *
 * 形态固定：1 条总述 `All N steps of <basename> executed and verified`
 * + 前 PREVIEW_COUNT 条 step preview（编号前缀、单条截断 ≤PREVIEW_MAX_CHARS），
 * 合计 ≤4 条（goal schema maxItems:8），每条单行不含 \r\n。
 */
export function buildPlanSuccessCriteria(planFilePath: string, tasks: string[]): string[] {
  const planName = toSingleLine(basename(planFilePath).replace(/\.md$/i, ""));
  const items = [`All ${tasks.length} steps of ${planName} executed and verified`];
  const previews = tasks
    .slice(0, PREVIEW_COUNT)
    .map((step, i) => truncatePreview(toSingleLine(`${i + 1}. ${step}`)));
  items.push(...previews);
  return items;
}

// ── goal 桥 outcome（D2：失败显式化）───────────────────────────────

/** goalInit 失败原因——五值与 tryGoalInit 的 5 个失败出口一一对应（设计 §6.2 D2）。 */
export type GoalBridgeFailureReason =
  | "goal-unavailable" // goal 未加载（正常交互下对话框不会出现 goal 档，防御保留）
  | "plan-unreadable" // plan 文件读取失败
  | "no-steps" // plan 内容提取到 0 条步骤
  | "init-refused" // goalInit 返回 false（已有 active goal / ctx 缺失）
  | "internal-error"; // goalInit 抛出意外异常（catch 出口）

/** tryGoalInit 的结构化结果：失败分支携带 reason（+ internal-error 的异常文本）。 */
export type GoalBridgeOutcome =
  | { started: true }
  | { started: false; reason: GoalBridgeFailureReason; detail?: string };

/** 每个 reason 指向一个具体恢复动作（不做纯日志字符串，设计 §4.2）。 */
export const GOAL_FAILURE_RECOVERY: Record<GoalBridgeFailureReason, string> = {
  "goal-unavailable": "The goal extension is not loaded — choose another execution method.",
  "plan-unreadable": "Check that the plan file exists and is readable, then call plan(action='complete') again.",
  "no-steps": "Add numbered steps under a '## Implementation Steps' section in the plan file, then call plan(action='complete') again.",
  "init-refused": "An active goal already exists — run /goal clear first, or continue with the existing goal.",
  "internal-error": "goalInit threw an unexpected exception (details in the warning notification and logs) — falling back to step-by-step execution.",
};

/** Try to initialize goal via programming interface; never throws (catch 出口 → internal-error). */
function tryGoalInit(pi: ExtensionAPI, planFilePath: string, ctx: ExtensionContext): GoalBridgeOutcome {
  try {
    const goalInit = getGoalInit(pi);
    if (!goalInit) return { started: false, reason: "goal-unavailable" };

    const planFile = readPlanFile(planFilePath);
    if (!planFile.ok) return { started: false, reason: "plan-unreadable" };

    const objective = `Execute plan: ${planFilePath}`;
    const tasks = extractPlanSteps(planFile.content);
    if (tasks.length === 0) return { started: false, reason: "no-steps" };

    const started = goalInit(
      objective,
      undefined,
      ctx,
      buildPlanSlug(planFilePath),
      buildPlanSuccessCriteria(planFilePath, tasks),
    );
    return started
      ? { started: true }
      : { started: false, reason: "init-refused" };
  } catch (error) {
    logger.warn("plan: goalInit threw unexpectedly", { error: toErrorMessage(error) });
    return { started: false, reason: "internal-error", detail: toErrorMessage(error) };
  }
}

/** Extract numbered steps from plan markdown */
export function extractPlanSteps(planContent: string): string[] {
  const steps: string[] = [];
  let inStepsSection = false;

  for (const line of planContent.split("\n")) {
    // Detect steps section headers
    if (/^##\s*(实现步骤|实施步骤|Implementation|Steps)/i.test(line)) {
      inStepsSection = true;
      continue;
    }
    // Exit on next ## header
    if (inStepsSection && /^##\s/.test(line)) {
      break;
    }
    // Collect numbered list items or checkbox items
    if (inStepsSection) {
      const match = line.match(/^\s*(?:\d+\.|- \[[ x]\])\s+(.+)/);
      if (match && match[1].trim()) {
        steps.push(match[1].trim());
      }
    }
  }

  // Fallback: if no steps section found, look for any numbered items (limit MAX_FALLBACK_STEPS)
  const MAX_FALLBACK_STEPS = 10;
  if (steps.length === 0) {
    for (const line of planContent.split("\n")) {
      const match = line.match(/^\s*\d+\.\s+(.+)/);
      if (match && match[1].trim()) {
        steps.push(match[1].trim());
        if (steps.length >= MAX_FALLBACK_STEPS) break;
      }
    }
  }

  return steps;
}


/**
 * 投递 complete 后的执行通知（D2：goal 档先 goalInit、后按结果选 steer）。
 * 成功发 goal steer——「Execute via /goal」只在 goal 真实创建成功时说出；失败发
 * 含 reason 与恢复动作的降级 steer + warning notify。非 goal 档无 goalInit，按
 * execMode 组 steer。返回 goalInit 的 outcome（非 goal 档为 undefined）。
 */
function deliverExecutionNotice(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  planFilePath: string,
  execMode: string,
): GoalBridgeOutcome | undefined {
  const outcome = execMode === "goal" ? tryGoalInit(pi, planFilePath, ctx) : undefined;

  const modeMessages: Record<string, string> = {
    subagent: "Execute via subagent-driven development: delegate each task to an independent subagent for parallel execution.",
    goal: "Execute via /goal: set up tracked task decomposition with budget control using the goal extension.",
    "single-agent": "Execute step by step in the current session.",
  };

  let modeHint: string;
  if (outcome === undefined) {
    modeHint = modeMessages[execMode] ?? modeMessages["single-agent"];
  } else if (outcome.started) {
    modeHint = modeMessages.goal;
  } else {
    modeHint = `Goal execution was not started (${outcome.reason}). ${GOAL_FAILURE_RECOVERY[outcome.reason]} Execute step by step in the current session.`;
    const detail = outcome.detail ? ` (${outcome.detail})` : "";
    ctx.ui.notify(`Goal execution was not started (${outcome.reason})${detail}. ${GOAL_FAILURE_RECOVERY[outcome.reason]}`, "warning");
  }

  const executeMessage =
    `Plan approved by user. Plan file: ${planFilePath}\n\n` +
    `Execution mode: ${execMode}\n` +
    `${modeHint}\n\n` +
    `Read the plan file and start implementing.`;

  pi.sendUserMessage(executeMessage, { deliverAs: "steer" });
  return outcome;
}

/**
 * complete 的 isolation 分发（D1 后仅 compact | direct，两档都投递执行通知）。
 *
 * 返回值：execMode=goal 且 isolation=direct 时同步返回 goalInit 的 outcome
 * （executeComplete 写进 result content 与 details）；其余情形返回 undefined——
 * 非 goal 档无 goalInit，compact 档 goalInit 在 onComplete 回调内执行（goal 状态
 * entry 须在压缩后的世界里创建，提前到 compact 前有被压缩边界丢弃的风险，时序
 * 不动——设计 §6.2 D2），该档 result 已返回，失败报告走 steer + notify 通道。
 */
export function handlePlanComplete(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PlanState,
  isolation: string,
  execMode: string,
): GoalBridgeOutcome | undefined {
  const planFilePath = state.planFilePath;

  switch (isolation) {
    case "compact": {
      ctx.compact({
        customInstructions: `Plan file: ${planFilePath}. Read plan and execute implementation.`,
        // E1 同构崩溃点（crash-resilience D1）：onComplete/onError 由 compact 内部
        // Promise 链异步调用、不在 pi runner emit() 的 try/catch 内——压缩进行中用户
        // 切换/重载 session 后，回调触碰捕获的 pi/ctx 命中 stale 同步抛错即杀 pi 进程。
        // 守卫 stale 静默降级（执行消息不投递，用户可手动 Read plan 文件执行），非
        // stale 错误原样上抛。plan 未注入代际计数器（低频路径），分诊依赖 PS-30 门禁
        // 守卫的 stale 文案兜底（D1 降级语义声明的合法形态）。
        onComplete: () => {
          guardStaleCtx(() => {
            deliverExecutionNotice(pi, ctx, planFilePath, execMode);
          }, {
            label: "plan:compact-onComplete",
            onStale: (error) => logger.warn("plan execution notice delivery skipped (stale ctx)", { error: toErrorMessage(error) }),
          });
        },
        onError: (_error: Error) => {
          guardStaleCtx(() => {
            ctx.ui.notify("Compact failed, continuing without isolation.", "warning");
            deliverExecutionNotice(pi, ctx, planFilePath, execMode);
          }, {
            label: "plan:compact-onError",
            onStale: (error) => logger.warn("plan execution notice delivery skipped (stale ctx)", { error: toErrorMessage(error) }),
          });
        },
      });
      return undefined;
    }

    case "direct":
    default: {
      return deliverExecutionNotice(pi, ctx, planFilePath, execMode);
    }
  }
}
