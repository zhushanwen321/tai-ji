import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildPlanModePrompt } from "./prompts.js";
import type { SkillRef } from "./prompts.js";
import type { PlanAbortControllers, PlanSessionMap, PlanState } from "./state.js";
import { getPlanState, persistPlanState, resetPlanState } from "./state.js";
import { PLAN_MODE_TOOLS } from "./tool.js";
import { updatePlanWidget } from "./widget.js";

const MAX_SLUG_LENGTH = 30;

/** /plan 参数解析产物：requirement = 最早 flag 标记前的自由文本；skills / templatePath 为 undefined = 未提供对应 flag */
export interface ParsedPlanArgs {
  requirement: string;
  skills: string[] | undefined;
  /** --template 的原始值（flag 后至命令结尾整段 trim，不切分——含空格路径天然支持，无需引号约定） */
  templatePath: string | undefined;
}

/**
 * --skills / --template 解析定则：
 * - 标记 = 独立 token（\b 词边界防 `--skillsabc` / `--templatex` 误切）；
 * - 值语义两 flag 同构 = flag 之后至命令结尾的整段文本（requirement 取最早出现
 *   flag 之前的部分）：
 *   - `--skills` 按逗号原样切分 + 每项去首尾空格——内部空格保留（「code review」
 *     「中文 技能」不丢字符），切分后空项丢弃（容忍尾逗号/连续逗号）；
 *   - `--template` 不切分——trim 后整段即路径（D5）；
 * - flag 提供但值为空 = 显式错误（E1 fail-fast，不静默忽略——用户显式用了 flag
 *   却没给值多半是打错了）；
 * - 两 flag 同给 = 互斥 fail-fast（消费方 handleEnterPlanMode 判定，§3.1——
 *   解析层照常返回两个字段供其判定）。
 */
export function parsePlanArgs(args: string): ParsedPlanArgs {
  const skillsMatch = /(?:^|\s)--skills\b/.exec(args);
  const templateMatch = /(?:^|\s)--template\b/.exec(args);
  if (!skillsMatch && !templateMatch) {
    return { requirement: args.trim(), skills: undefined, templatePath: undefined };
  }
  const firstFlagIndex = Math.min(
    skillsMatch?.index ?? Number.POSITIVE_INFINITY,
    templateMatch?.index ?? Number.POSITIVE_INFINITY,
  );
  const requirement = args.slice(0, firstFlagIndex).trim();
  const skills = skillsMatch === null
    ? undefined
    : args
        .slice(skillsMatch.index + skillsMatch[0].length)
        .trim()
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
  const templatePath = templateMatch === null
    ? undefined
    : args.slice(templateMatch.index + templateMatch[0].length).trim();
  return { requirement, skills, templatePath };
}

/** --template 校验结果：ok=false 时 problem 为 fail-fast 回复的问题句（自带用法样例） */
export type TemplateFileResolution =
  | { ok: true; absPath: string }
  | { ok: false; problem: string };

/** --template 系报错附带的用法样例（错误 → 纠正闭环） */
const TEMPLATE_USAGE_SAMPLE = "e.g. /plan <requirement> --template /path/to/template.md";

/**
 * --template 值解析与校验（D5）：
 * - `~` 前缀展开（os.homedir，仅前缀 `~` 与 `~/`——无 per-user home 展开）；
 * - 相对路径相对 ctx.cwd（pi 进程 cwd = 项目根）解析，不做额外路径猜测；
 * - 存在性校验先于 .md 校验，两失败文案分家（not found / not a markdown file），
 *   报错一律带解析后的绝对路径供用户核对。
 */
export function resolveTemplateFile(raw: string, projectDir: string): TemplateFileResolution {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, problem: `--template was given but no path followed it. ${TEMPLATE_USAGE_SAMPLE}` };
  }
  const expanded = trimmed.startsWith("~") ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
  const absPath = path.resolve(projectDir, expanded);
  if (!fs.existsSync(absPath)) {
    return { ok: false, problem: `Template file not found: ${absPath}. ${TEMPLATE_USAGE_SAMPLE}` };
  }
  if (!absPath.endsWith(".md")) {
    return { ok: false, problem: `Not a markdown file: ${absPath}. ${TEMPLATE_USAGE_SAMPLE}` };
  }
  return { ok: true, absPath };
}

/** E1 技能解析结果：ok=false 时携带缺失项与可用清单（fail-fast 回复的材料） */
export type SkillResolution =
  | { ok: true; resolved: SkillRef[] }
  | { ok: false; available: string[]; missing: string[] };

/**
 * 技能名归一：剥掉 pi 命令命名空间前导 `skill:` 前缀，得到自然技能名。
 * pi.getCommands() 枚举 skill 类命令时 name 带 `skill:` 前缀（如 `skill:tech-design`），
 * 这是 pi 的实现细节，不得泄漏到用户输入面——设计面（tech-design §步骤①）用户输入
 * 自然技能名（`--skills tech-design`）。枚举侧与输入侧双向剥前缀后比对，兼容两种形态。
 */
function normalizeSkillName(name: string): string {
  return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

/**
 * E1 校验：pi.getCommands() 过滤 source === "skill" 枚举比对（技能枚举与路径
 * 经 pi 取得，不自扫描目录——D2）。比对前双向剥 `skill:` 前缀归一（trim 由
 * parsePlanArgs 保证）：resolved/missing 用归一后的短名；available 维持枚举
 * 原形态（错误信息里用户可直接复制为 pi 命令）。
 */
export function resolveSkills(pi: ExtensionAPI, requested: string[]): SkillResolution {
  const skillCommands = pi.getCommands().filter((c) => c.source === "skill");
  const byShortName = new Map(skillCommands.map((c) => [normalizeSkillName(c.name), c.sourceInfo.path]));
  const available = skillCommands.map((c) => c.name);
  const resolved: SkillRef[] = [];
  const missing: string[] = [];
  for (const raw of requested) {
    const name = normalizeSkillName(raw);
    const skillPath = byShortName.get(name);
    if (skillPath === undefined) {
      missing.push(name);
    } else {
      resolved.push({ name, skillPath });
    }
  }
  return missing.length > 0 ? { ok: false, available, missing } : { ok: true, resolved };
}

export function registerPlanCommand(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
  controllers: PlanAbortControllers,
): void {
  pi.registerCommand("plan", {
    description:
      "Enter plan mode: /plan [description] [--skills a,b] or /plan [description] --template <path-to-markdown>. " +
      "Subcommands: /plan abort, /plan status. " +
      "With no args, show status or detect existing plan.",
    getArgumentCompletions(prefix: string) {
      const parts = prefix.trimStart().split(/\s+/).filter(Boolean);
      // More than 1 token means the user is typing a free-text requirement, no completion.
      if (parts.length > 1) return null;
      const trimmed = (parts[0] ?? "").toLowerCase();
      const opts = [
        { label: "abort", value: "abort", description: "取消活跃的 plan mode" },
        { label: "status", value: "status", description: "查看 plan mode 状态" },
      ];
      return trimmed === "" ? opts : opts.filter((o) => o.label.startsWith(trimmed));
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const trimmed = args.trim();
      const sessionId = ctx.sessionManager.getSessionId();
      const state = getPlanState(sessions, sessionId, ctx);

      // Subcommand: abort
      if (trimmed === "abort") {
        await handleAbort(pi, sessions, controllers, sessionId, ctx, state);
        return;
      }

      // Subcommand: status
      if (trimmed === "status") {
        handleStatus(ctx, state);
        return;
      }

      // If already in plan mode with no args, show status
      if (state.isActive && !trimmed) {
        handleStatus(ctx, state);
        return;
      }

      // If already in plan mode with args, warn
      if (state.isActive && trimmed) {
        ctx.ui.notify("Plan mode is already active. Use /plan abort to cancel first.", "warning");
        return;
      }

      // Reentry: check for existing plan files in .taiji-harness/
      if (!state.isActive && !trimmed) {
        const projectDir = ctx.cwd;
        const harnessDir = path.join(projectDir, ".taiji-harness");
        const existingPlans = findExistingPlans(harnessDir);
        if (existingPlans.length > 0) {
          pi.sendUserMessage(
            `[PLAN MODE] Found existing plan files:\n${existingPlans.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}\n\n` +
            `Choose an option:\n` +
            `  a) Continue existing plan\n` +
            `  b) Implement existing plan\n` +
            `  c) Create new plan\n` +
            `  d) Cancel`,
          );
          return;
        }
      }

      // Enter plan mode
      handleEnterPlanMode(pi, sessions, sessionId, ctx, state, args);
    },
  });
}

/** Handle /plan abort subcommand */
async function handleAbort(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
  controllers: PlanAbortControllers,
  sessionId: string,
  ctx: ExtensionContext,
  state: PlanState,
): Promise<void> {
  if (!state.isActive) {
    ctx.ui.notify("No active plan mode.", "info");
    return;
  }
  // E10 顺序不可反（因果链）：controller.abort() → 挂起 select resolve undefined →
  // tool execute 走「已取消」分支返回 → turn 正常结束 → agent_settled 到达 →
  // busy defer 队列恢复投递。若先 reset 后 abort，挂起 select 无人 resolve 且
  // runtime 不超时 → pi turn 永占用 → 后续消息永 defer → session 只能 forceQuit。
  controllers.get(sessionId)?.abort();
  controllers.delete(sessionId);
  const updatedState = resetPlanState(pi, sessions, sessionId, ctx);
  updatePlanWidget(ctx, updatedState);
  // Restore full tool set (SDK does NOT support undefined)
  pi.setActiveTools(pi.getAllTools().map((t: { name: string }) => t.name));
  ctx.ui.notify("Plan mode aborted.", "info");
}

/** Handle /plan status subcommand */
function handleStatus(
  ctx: ExtensionContext,
  state: PlanState,
): void {
  if (!state.isActive) {
    ctx.ui.notify("No active plan mode.", "info");
    return;
  }
  const skillsLine = state.skills.length > 0 ? `\nSkills: ${state.skills.join(", ")}` : "";
  const docsLine = state.docs.length > 0 ? `\nDocuments: ${state.docs.map((d) => `${d.fileName} (v${d.version})`).join(", ")}` : "";
  ctx.ui.notify(
    `Plan: ${state.planFilePath}\nTemplate: ${state.templateName || "(not selected)"}${skillsLine}${docsLine}`,
    "info",
  );
}

/** Find existing plan.md files in .taiji-harness/ subdirectories */
function findExistingPlans(harnessDir: string): string[] {
  try {
    return fs.readdirSync(harnessDir)
      .filter((f) => {
        const subDir = path.join(harnessDir, f);
        return fs.statSync(subDir).isDirectory() && fs.existsSync(path.join(subDir, "plan.md"));
      })
      .map((f) => path.join(harnessDir, f, "plan.md"));
  } catch {
    return [];
  }
}

/** E1 fail-fast 回复：不进入计划模式（不写 entry / 不限制工具 / 不注入计划提示词），回复可用技能清单与纠正命令 */
function reportUnknownSkills(pi: ExtensionAPI, resolution: Extract<SkillResolution, { ok: false }>): void {
  const available = resolution.available.length > 0
    ? resolution.available.map((n) => `  - ${n}`).join("\n")
    : "  (no skills installed)";
  const problem = resolution.missing.length > 0
    ? `unknown skill(s): ${resolution.missing.join(", ")}`
    : "--skills was given but no skill names followed it";
  pi.sendUserMessage(
    `[PLAN MODE] Failed to enter: ${problem}.\n\n` +
    `Available skills:\n${available}\n\n` +
    `Do NOT enter plan mode. Reply to the user listing the available skills and the corrected command, e.g. /plan <requirement> --skills <skill1>,<skill2>.`,
  );
}

/**
 * --template 系 fail-fast 回复（E1 同款形态）：不进入计划模式（不写 entry /
 * 不限制工具 / 不注入计划提示词），回复问题句（互斥/不存在/非 md，problem 内
 * 已带用法样例）。
 */
function reportTemplateFlagError(pi: ExtensionAPI, problem: string): void {
  pi.sendUserMessage(
    `[PLAN MODE] Failed to enter: ${problem}.\n\n` +
    `Do NOT enter plan mode. Reply to the user with the problem and the corrected command.`,
  );
}

/** Handle entering plan mode */
function handleEnterPlanMode(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
  sessionId: string,
  ctx: ExtensionContext,
  state: PlanState,
  args: string,
): void {
  // flag 解析 + 校验先行：--template / --skills 任一校验失败 fail-fast，
  // 不产生任何进入动作（横幅不出现：不写 entry / 不限制工具 / 不注入提示词）
  const parsed = parsePlanArgs(args);

  // 互斥 fail-fast（§3.1）：两 flag 同给先于一切值校验报错
  if (parsed.skills !== undefined && parsed.templatePath !== undefined) {
    reportTemplateFlagError(
      pi,
      "--template and --skills are mutually exclusive. Use one: /plan <requirement> --skills a,b | /plan <requirement> --template <path>",
    );
    return;
  }

  let templateAbsPath: string | undefined;
  let templateContent: string | undefined;
  if (parsed.templatePath !== undefined) {
    const resolution = resolveTemplateFile(parsed.templatePath, ctx.cwd);
    if (!resolution.ok) {
      reportTemplateFlagError(pi, resolution.problem);
      return;
    }
    // 全文在校验通过后、任何进入副作用（entry/工具限制）之前读好——读失败
    // （权限/竞态删除）同族 fail-fast，不留「已持久 isActive 但提示词没注入」
    // 的半进入态（D5）
    try {
      templateContent = fs.readFileSync(resolution.absPath, "utf-8");
    } catch {
      reportTemplateFlagError(pi, `Template file not readable: ${resolution.absPath}. ${TEMPLATE_USAGE_SAMPLE}`);
      return;
    }
    templateAbsPath = resolution.absPath;
  }

  // --skills E1 校验（互斥已判过后，走到这里 templatePath 必为 undefined）
  const requested = parsed.skills ?? [];
  if (parsed.skills !== undefined && requested.length === 0) {
    reportUnknownSkills(pi, { ok: false, available: pi.getCommands().filter((c) => c.source === "skill").map((c) => c.name), missing: [] });
    return;
  }
  let resolved: SkillRef[] = [];
  if (requested.length > 0) {
    const resolution = resolveSkills(pi, requested);
    if (!resolution.ok) {
      reportUnknownSkills(pi, resolution);
      return;
    }
    resolved = resolution.resolved;
  }

  const requirement = parsed.requirement;
  const slug = requirement
        ? requirement.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, MAX_SLUG_LENGTH)
    : "untitled";

  const projectDir = ctx.cwd;
  const planDir = path.join(projectDir, ".taiji-harness", slug);
  fs.mkdirSync(planDir, { recursive: true });
  const planFilePath = path.join(planDir, "plan.md");

  state.isActive = true;
  state.planFilePath = planFilePath;
  state.requirement = requirement;
  // --template 直传：templateName = 去扩展名 basename（GUI / /plan status 展示，
  // 复用既有字段既有值形态——D5）；模板流程进入时仍为空，等 select-template 写入。
  // 直传事实另落 templateProvidedPath（select-template 防御的判定信号——
  // templateName 单看无法区分「已直传」与「已选中」，D7）
  state.templateName = templateAbsPath ? path.basename(templateAbsPath, ".md") : "";
  state.templateProvidedPath = templateAbsPath;
  state.skills = resolved.map((s) => s.name);
  state.docs = [];
  delete state.reviewState;

  persistPlanState(pi, state);
  updatePlanWidget(ctx, state);

  // Restrict tools to the plan-mode set (includes bash — file-write constraints come from the injected plan mode prompt below)
  pi.setActiveTools(PLAN_MODE_TOOLS);

  // Inject plan mode prompt inline (四段：技能指令 / 产物纪律 / 只读纪律 / 模板流程——D2)
  // --template 直传走 prompts.ts 直传分支（清单段抑制 + 全文内嵌，D5）
  // projectRoot 显式传 ctx.cwd（设计 D2 项目级锚点）——与 select-template 侧
  // listTemplates({ projectRoot: ctx.cwd }) 同锚点，禁从 planFilePath 逆推层级
  pi.sendUserMessage(
    buildPlanModePrompt({
      requirement,
      planFilePath,
      projectRoot: projectDir,
      skills: resolved,
      ...(templateAbsPath !== undefined && templateContent !== undefined
        ? { template: { absPath: templateAbsPath, content: templateContent } }
        : {}),
    }),
  );
}
