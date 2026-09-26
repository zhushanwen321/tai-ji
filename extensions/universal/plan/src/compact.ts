import * as fs from "node:fs";
import { basename } from "node:path";

import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionBeforeTreeEvent } from "@earendil-works/pi-coding-agent";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import type { GoalInitFn } from "@zhushanwen/pi-goal";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { t } from "./i18n.js";
import type { PlanSessionMap, PlanState } from "./state.js";
import { PLAN_CONTEXT_CUSTOM_TYPE, getPlanState } from "./state.js";

const logger = getLogger("pi-plan");

/**
 * compact / tree 两挂点共用的 summary 主体段（重复构造去重：两挂点均为真实 SDK 挂点
 * 全部保留，去重的只是公共主体——尾段各自不同，compact 档带 requirement + 进行中提示，
 * tree 档带执行指令）。
 */
function buildPlanSummaryBody(planFilePath: string, planContent: string): string {
  return `Plan mode active. Plan file: ${planFilePath}\n\n## Plan Content\n${planContent}\n\n`;
}

export function registerPlanEventHandlers(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
): void {
  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getPlanState(sessions, sessionId, ctx);
    if (!state.isActive) return {};

    // Read plan file content for recovery after compact
    const planContent = readPlanFileSafe(state.planFilePath);

    // handler 已有 isActive 门——能走到这里的 plan 必然进行中（D6：phase 删除，原 phase="complete" 分支为死状态）
    const progressNote = "\nPlan was in progress — review and continue.";

    return {
      compaction: {
        summary:
          buildPlanSummaryBody(state.planFilePath, planContent) +
          `Requirement: ${state.requirement}` +
          progressNote,
        // SDK 类型非可选（pi 0.84.4 dist types.d.ts SessionBeforeCompactEvent.preparation:
        // CompactionPreparation，firstKeptEntryId/tokensBefore 均必有）——直取不容错
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
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
        summary: buildPlanSummaryBody(state.planFilePath, planContent) + "Read the plan file and execute the implementation.",
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
 * goalInit slot key——goal 扩展的跨扩展编程式入口（goal-bridge-cross-extension.md）。
 * ⚠️ 必须与 `extensions/universal/goal/src/index.ts` 的 GOAL_INIT_SLOT_KEY 字符串完全一致：
 * 两侧不共享运行时模块（pi-goal 是 optional peer），靠同一字符串拿到同一 globalThis slot。
 * 改名必须两侧同步。
 */
const GOAL_INIT_SLOT_KEY = Symbol.for("@zhushanwen/pi-goal.goalInit");

/**
 * goal 桥的单一断言点：goal 扩展挂在 globalThis slot 上的编程式接口（发现 7——
 * 桥通道从 pi API 对象挂载迁到 slot：pi 0.84.4 per-extension API 隔离使
 * pi.__goalInit 形态跨扩展恒不可见，slot 是 C-ext-06 惯例的进程级共享形态）。
 */
function getGoalInit(): GoalInitFn | undefined {
  const fn = Reflect.get(globalThis, GOAL_INIT_SLOT_KEY);
  return typeof fn === "function" ? (fn as GoalInitFn) : undefined;
}

/**
 * goal 桥侧 slug（仅 widget 标题 + history 展示用，不注入 prompt）。生产输入恒为
 * <project>/.tmp/plans/<slug>/plan.md（enter.ts 构造，basename 恒 plan.md）→ 恒返回
 * 'plan'——正则链与 fallback 只防「planFilePath 非生产形态」的通用输入，正常路径
 * 不可达。若需区分度（改取路径中 requirement slug 段）属 goal 桥侧跨包展示语义
 * 变更，须单独裁决后实施，裁决前保持现状。
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

/** skill 档 execMode 前缀（D10：`skill:<name>` 动态项，与 tool.ts 选项构造同源约定） */
const SKILL_MODE_PREFIX = "skill:";
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
  | "goal-unavailable" // goal 未加载（slot 不存在/值非函数——execute 档无条件尝试 goalInit，goal 扩展未装/未挂 slot 时即走此出口，独立 pi 常态分支）
  | "plan-unreadable" // plan 文件读取失败
  | "no-steps" // plan 内容提取到 0 条步骤
  | "init-refused" // goalInit 返回 false（已有 active goal / ctx 缺失）
  | "internal-error"; // goalInit 抛出意外异常（catch 出口，含 slot 残留 fn 调用失效）

/** tryGoalInit 的结构化结果：失败分支携带 reason（+ internal-error 的异常文本）。 */
export type GoalBridgeOutcome =
  | { started: true }
  | { started: false; reason: GoalBridgeFailureReason; detail?: string };

/** 每个 reason 指向一个具体恢复动作（不做纯日志字符串，设计 §4.2）。 */
export const GOAL_FAILURE_RECOVERY: Record<GoalBridgeFailureReason, string> = {
  "goal-unavailable": "The goal extension is not loaded — execute directly without goal tracking.",
  "plan-unreadable": "Check that the plan file exists and is readable, then call plan(action='complete') again.",
  "no-steps": "Add numbered steps under a '## Implementation Steps' section in the plan file, then call plan(action='complete') again.",
  "init-refused": "An active goal already exists — run /goal clear first, or continue with the existing goal.",
  "internal-error": "goalInit threw an unexpected exception (details in the warning notification and logs) — falling back to step-by-step execution.",
};

/** Try to initialize goal via programming interface; never throws (catch 出口 → internal-error). */
function tryGoalInit(planFilePath: string, ctx: ExtensionContext): GoalBridgeOutcome {
  try {
    const goalInit = getGoalInit();
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
 * 投递 complete 后的执行通知（2026-09-21 选项集重排：mode 值域 = execute | skill:<name>；
 * execute 档整合 goal 桥 + auto-parallel subagent——goal 可用时先 goalInit 建跟踪，
 * 失败/不可用降级为直接执行的 steer 指令，用户可见失败提示走 notify i18n）。
 * skill 档动态构造 steer（含 skillEntryPath 路径，对齐 register-doc sourceSkill 的 skill 关联
 * 先例；skillEntryPath = skill 入口文件路径——标准形态 SKILL.md 路径 / 散 .md 形态文件本身，
 * 直接 read 不再拼 SKILL.md）。返回 goalInit 的 outcome（非 execute 档为 undefined）。
 */
function deliverExecutionNotice(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  planFilePath: string,
  execMode: string,
  skillEntryPath?: string,
): GoalBridgeOutcome | undefined {
  // execute 档整合 goal 桥：tryGoalInit 内部含 goal-unavailable gate（goal 未挂载走
  // started:false 降级），无需前置探测
  const outcome = execMode === "execute" ? tryGoalInit(planFilePath, ctx) : undefined;

  let modeHint: string;
  if (execMode.startsWith(SKILL_MODE_PREFIX)) {
    const skillName = execMode.slice(SKILL_MODE_PREFIX.length);
    modeHint = skillEntryPath
      ? `Execute via skill: read the ${skillName} skill at ${skillEntryPath} first, then follow its workflow to execute the plan file.`
      : `Execute via skill: load the ${skillName} skill and follow its workflow to execute the plan file.`;
  } else if (outcome?.started) {
    modeHint =
      "Goal tracking is active via /goal — execute the plan through the goal workflow: delegate independent, parallelizable tasks to subagents; run small or tightly-coupled steps in this session.";
  } else if (outcome !== undefined) {
    modeHint =
      `Goal tracking was not started (${outcome.reason}). ${GOAL_FAILURE_RECOVERY[outcome.reason]} ` +
      `Execute directly instead: judge by task complexity — delegate independent, parallelizable tasks to subagents; run small or tightly-coupled steps step by step in the current session.`;
    const detail = outcome.detail ? ` (${outcome.detail})` : "";
    ctx.ui.notify(`${t("exec.goalFailedNotify", { reason: outcome.reason })}${detail}`, "warning");
  } else {
    modeHint =
      "Execute by judging task complexity: delegate independent, parallelizable tasks to subagents; execute small or tightly-coupled steps step by step in the current session.";
  }

  const executeMessage =
    `Plan approved by user. Plan file: ${planFilePath}\n\n` +
    `Execution mode: ${execMode}\n` +
    `${modeHint}\n\n` +
    `Read the plan file and start implementing.`;

  pi.sendMessage(
    { customType: PLAN_CONTEXT_CUSTOM_TYPE, content: executeMessage, display: false },
    { deliverAs: "steer", triggerTurn: true },
  );
  return outcome;
}

/**
 * complete 后的执行通知投递（plan-mode-audit-remediation D-B1-6：执行前压缩档
 * 砍除——原 compact | direct 两档分发退化为单一直接投递路径）。
 *
 * 返回值：execMode=execute 时同步返回 goalInit 的 outcome（executeComplete 写进
 * result content 与 details）；skill 档无 goalInit，返回 undefined——该档 result
 * 已返回，失败报告走 steer + notify 通道。
 */
export function handlePlanComplete(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PlanState,
  execMode: string,
  skillEntryPath?: string,
): GoalBridgeOutcome | undefined {
  return deliverExecutionNotice(pi, ctx, state.planFilePath, execMode, skillEntryPath);
}
