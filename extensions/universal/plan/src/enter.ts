import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildPlanModePrompt } from "./prompts.js";
import type { SkillRef } from "./prompts.js";
import type { PlanSessionMap, PlanState } from "./state.js";
import { capPlanRequirement, getPlanState, persistPlanState, PLAN_MODE_TOOLS } from "./state.js";
import { updatePlanWidget } from "./widget.js";

export const MAX_SLUG_LENGTH = 30;

/** E1 技能解析结果：ok=false 时携带缺失项与可用清单（fail-fast 回复的材料） */
export type SkillResolution =
  | { ok: true; resolved: SkillRef[] }
  | { ok: false; available: string[]; missing: string[] };

/**
 * 技能名归一：剥掉 pi 命令命名空间前导 `skill:` 前缀，得到自然技能名。
 * pi.getCommands() 枚举 skill 类命令时 name 带 `skill:` 前缀（如 `skill:tech-design`），
 * 这是 pi 的实现细节，不得泄漏到输入面——slash `--skills` 与 plan(enter) 的 skills 参数
 * 都用自然技能名。枚举侧与输入侧双向剥前缀后比对，兼容两种形态。
 */
export function normalizeSkillName(name: string): string {
  return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

/**
 * E1 校验：pi.getCommands() 过滤 source === "skill" 枚举比对（技能枚举与路径
 * 经 pi 取得，不自扫描目录——D2）。比对前双向剥 `skill:` 前缀归一：resolved/missing
 * 用归一后的短名；available 维持枚举原形态（错误信息里可直接复制为 pi 命令）。
 * slash 命令与 plan(enter) tool 两入口共用（自 command.ts 迁入 enter.ts）。
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

/** 进入 plan 模式的归一入参（slash 命令与 plan(enter) tool 两入口共用） */
export interface ActivatePlanModeInput {
  requirement: string;
  /** E1 校验后的技能引用（未挂载传空数组） */
  skills: SkillRef[];
  /** 项目根锚点（= ctx.cwd），plan 目录与模板扫描的公共锚 */
  projectDir: string;
  /** --template 直传时给出（与 skills 互斥，命令层已校验并读好全文） */
  template?: { absPath: string; content: string };
}

/** 进入产物：状态引用 + 直达模型的 plan 模式提示词（两入口分别走 sendUserMessage / tool result 投递） */
export interface ActivatePlanModeOutcome {
  state: PlanState;
  prompt: string;
}

/**
 * 进入 plan 模式的共享核心（plan-mode-agent-enter U1）：slash 命令 handler 与 plan(enter)
 * tool 两入口收敛同一实现——状态建立 + 持久化 + widget + 工具收拢 + 提示词构造。
 *
 * 不做的事（留给调用方）：
 * - 提示词投递通道：slash 入口经 sendUserMessage（用户发起的对话流注入）；tool 入口经
 *   tool result content 直返（对本次 tool 调用的直接响应，agent 同轮即见——不赌 steer 排队）。
 * - flag 解析 / 模板文件读取 / 技能名归一：命令层与 tool 层各自的入参形态不同，前置已完成。
 *
 * 副作用顺序钉死：状态字段 → persistPlanState（entry 落盘）→ updatePlanWidget →
 * setActiveTools → 构造 prompt。persist 先于工具收拢，保证「已持久 isActive 但工具未收」
 * 的半进入态不可达（崩溃窗口内重开 session 经 entry 恢复 isActive，session_start hook
 * 会补 setActiveTools）。
 */
export function activatePlanMode(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
  sessionId: string,
  ctx: ExtensionContext,
  input: ActivatePlanModeInput,
): ActivatePlanModeOutcome {
  const state = getPlanState(sessions, sessionId, ctx);
  const { requirement, skills, projectDir } = input;

  const slug = requirement
    ? requirement.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, MAX_SLUG_LENGTH)
    : "untitled";

  const planDir = path.join(projectDir, ".taiji-harness", slug);
  fs.mkdirSync(planDir, { recursive: true });
  const planFilePath = path.join(planDir, "plan.md");

  state.isActive = true;
  state.planFilePath = planFilePath;
  // state/entry/plan 帧侧 requirement 64KB 封顶（帧有界前提）；prompt 仍用未封顶全文直达模型
  state.requirement = capPlanRequirement(requirement);
  // --template 直传：templateName = 去扩展名 basename（GUI / /plan status 展示）；
  // 直传事实另落 templateProvidedPath（select-template 防御的判定信号，D7）
  state.templateName = input.template ? path.basename(input.template.absPath, ".md") : "";
  state.templateProvidedPath = input.template?.absPath;
  state.skills = skills.map((s) => s.name);
  state.docs = [];
  // 新轮次重置：reviewState 与指纹基线随进入失效（与 resetPlanState 对齐）
  delete state.reviewState;
  delete state.lastSubmitReviewDocsFingerprint;

  persistPlanState(pi, state);
  updatePlanWidget(ctx, state);
  // 收拢工具到 plan 模式白名单（含 bash——文件写约束来自下方注入的只读纪律提示词）
  pi.setActiveTools(PLAN_MODE_TOOLS);

  const prompt = buildPlanModePrompt({
    requirement,
    planFilePath,
    projectRoot: projectDir,
    skills,
    ...(input.template !== undefined ? { template: input.template } : {}),
  });

  return { state, prompt };
}
