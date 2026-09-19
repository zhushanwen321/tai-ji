import * as path from "node:path";

import type { PlanReviewComment } from "@zhushanwen/extension-protocol";

import { formatAvailablePlans, listTemplates } from "./templates.js";

/**
 * 提示词注入的技能引用：名字 + SKILL.md 路径。
 * 路径来自 pi.getCommands() 的 source === "skill" 条目的 sourceInfo.path——
 * 技能枚举与路径经 pi 取得（不自扫描 7 源目录，D2），AI 自行 read 技能文件。
 */
export interface SkillRef {
  name: string;
  skillPath: string;
}

/** buildPlanModePrompt 的入参（requirement/planFilePath 来自命令解析，skills 来自 E1 校验后的解析结果） */
export interface PlanPromptInput {
  requirement: string;
  planFilePath: string;
  skills: SkillRef[];
}

/**
 * /plan 命令的提示词四段注入（D2）：
 * ① 技能指令（仅挂载 --skills 时）——按技能 SKILL.md 流程产出计划文档；
 * ② 产物纪律（恒注入）——register-doc 登记 / 修订重调 version+1 / 全部完成调
 *    submit-review / submit-review 被消费后当轮回应完重挂直到确认；
 * ③ 只读纪律（恒注入，现状 pi-ext-021 提示词保持）；
 * ④ 模板流程（仅未指定 --skills 时）——<available-plans> 三源清单注入（内置 5
 *    + 用户级 + 项目级，模型自选模板，D8）；空发现不注入段（warn 另落）。
 */
export function buildPlanModePrompt(input: PlanPromptInput): string {
  const sections: string[] = [`[PLAN MODE] Entered plan mode.\n\nRequirement: ${input.requirement || "(from conversation context)"}\nPlan directory documents root: ${input.planFilePath}`];

  // ① 技能指令
  if (input.skills.length > 0) {
    const skillLines = input.skills
      .map((s) => `- ${s.name}: read ${s.skillPath} and follow its workflow to produce the plan documents it specifies.`)
      .join("\n");
    sections.push(
      `## Skill Workflow\n` +
      `You are working through the following skills (mounted via --skills), in order:\n` +
      `${skillLines}\n` +
      `Read each skill file FIRST before producing any document. The skills define WHAT documents to produce and their structure; the plan-mode rules below define WHERE to write them and HOW to register them.`,
    );
  }

  // ② 产物纪律
  sections.push(
    `## Deliverable Discipline\n` +
    `- Write every deliverable document into the plan directory (.taiji-harness/<slug>/), then register it: plan(action='register-doc', fileName='design.md', sourceSkill='<skill name or omit>').\n` +
    `- After revising a document, REWRITE the file and re-register it with plan(action='register-doc', fileName=...) again — the version is bumped so the UI refreshes its content.\n` +
    `- When ALL documents are done, call plan(action='submit-review') to request user review.\n` +
    `- After submit-review is consumed (whether an explanation or a revision request), finish responding for the current turn, then call plan(action='submit-review') again to re-hang the review — repeat until the user confirms execution.`,
  );

  // ③ 只读纪律（现状 pi-ext-021 提示词保持）
  sections.push(
    `## Constraints\n` +
    `- READ-ONLY: Do NOT edit any files except plan documents under the plan directory.\n` +
    `- Do NOT run write commands (mkdir, echo, sed, etc.) on non-plan files.\n` +
    `- All plan content goes to plan documents only.`,
  );

  // ④ 模板流程（无 --skills 回落）——<available-plans> 三源清单随本提示词
  //    一次性注入（D3：选型期一次性信息，select-template 报错自带清单兜底自愈）
  if (input.skills.length === 0) {
    // 项目级模板源锚点（设计 D2 锚定 ctx.cwd）：命令层把 planFilePath 构造为
    // <ctx.cwd>/.taiji-harness/<slug>/plan.md，两级上溯即项目根——prompts 侧
    // 自行回推，命令层无需为此增传参
    const projectRoot = path.dirname(path.dirname(input.planFilePath));
    const plansSection = formatAvailablePlans(listTemplates({ projectRoot }));
    const pickTemplateStep = plansSection !== ""
      ? `1. Pick the template that best fits this requirement from the <available-plans> list below and call plan tool (select-template, templateName='<name>') — you pick the template yourself; the user can override by replying.`
      : `1. No plan templates were discovered — structure the plan document with your own chapter skeleton (e.g. Overview / Requirements / Implementation Steps).`;
    sections.push(
      `## Phase B: Brainstorming\n` +
      `1. **Quick Overview**: ls project root, read README, package.json — build context (< 30s).\n` +
      `2. **Explore before asking**: grep/read code first. Only ask user for preferences, not code-fact questions.\n` +
      `3. **Progressive questioning**: Ask 2-3 questions at a time. Use ask_user tool if available.\n` +
      `4. **Propose 2-3 approaches** with trade-offs + recommendation.\n` +
      `5. **Assumption audit**: Grep-verify interfaces/types exist. Mark [UNVERIFIED] what can't be verified.\n\n` +
      `## Phase C: Writing\n` +
      `${pickTemplateStep}\n` +
      `2. Write chapters in template order — do NOT skip unwritten chapters.\n` +
      `3. Write all chapters in one turn, then ask user to review.` +
      (plansSection !== "" ? `\n\n${plansSection}` : "") +
      `\n\n## Phase D: Completion\n` +
      `1. Ask user to review the complete plan.\n` +
      `2. Call plan tool (complete) with isolation method (compact/direct).\n` +
      `3. After plan complete: the user picks an execution method in the completion dialog — Develop (auto-parallel: complexity-driven subagent delegation vs current-session steps), an execution skill (Execute via skill: <name>, when detected), or goal-driven execution.`,
    );
  }

  return sections.join("\n\n");
}

/**
 * revise/explain decision 的评论清单注入文本（D5 decision 消费）。
 * 评论语义：quote 是用户划选引文（agent 定位段落用），comment 是评语。
 */
export function formatReviewComments(decision: "revise" | "explain", comments: PlanReviewComment[]): string {
  const header = decision === "revise"
    ? `[PLAN REVIEW] The user submitted ${comments.length} comment(s) and requested document revision. For each comment: locate the quoted passage, apply the requested change, rewrite the file, then re-register it via plan(action='register-doc') — after ALL comments are addressed, call plan(action='submit-review') again to re-hang the review.`
    : `[PLAN REVIEW] The user requested further explanation (${comments.length} comment(s)). Answer them in your reply — after answering, call plan(action='submit-review') again to re-hang the review.`;

  const lines = comments.map((c, i) => {
    const quote = c.quote.trim() || "(no selection)";
    const comment = c.comment.trim() || "(no text)";
    return `${i + 1}. Quote: "${quote}"\n   Comment: ${comment}`;
  });

  return `${header}\n\n${lines.join("\n")}`;
}
