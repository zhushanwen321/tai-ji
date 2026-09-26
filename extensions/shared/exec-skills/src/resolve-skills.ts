import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 技能执行门禁共享能力（ADR-0074 落地包）：steer/注入前的「pi 实际认得」确认，
 * 走 pi 注册表（pi.getCommands）。与同包 exec-skills 模块构成两段消费语义闭环——
 * 扫描（发现，自研直读磁盘，技能热装即时可见）≠ 本模块（执行门禁，pi 注册表
 * 是执行权威）；pi 不认得的技能只提示不注入。
 *
 * 门禁取注册表快照在此是有意选择：执行权在 pi 本体，快照滞后只造成「刚装的
 * 技能本 turn 门禁拒绝」，重试即过——与「发现」侧的滞后不可接受（表单永远
 * 看不到新技能）不同源。
 */

/** E1 技能解析结果：ok=false 时携带缺失项与可用清单（fail-fast 回复的材料） */
export type SkillResolution =
  | { ok: true; resolved: SkillRef[] }
  | { ok: false; available: string[]; missing: string[] };

/** 一个已确认可执行的技能引用：自然名 + 注册表回执的入口路径 */
export interface SkillRef {
  name: string;
  skillPath: string;
}

/**
 * 技能名归一：剥掉 pi 命令命名空间前导 `skill:` 前缀，得到自然技能名。
 * pi.getCommands() 枚举 skill 类命令时 name 带 `skill:` 前缀（如 `skill:tech-design`），
 * 这是 pi 的实现细节，不得泄漏到输入面——slash `--skills` 与消费方工具的 skills 参数
 * 都用自然技能名。枚举侧与输入侧双向剥前缀后比对，兼容两种形态。
 */
export function normalizeSkillName(name: string): string {
  return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

/**
 * 执行门禁：pi.getCommands() 过滤 source === "skill" 枚举比对。比对前双向剥
 * `skill:` 前缀归一：resolved/missing 用归一后的短名；available 维持枚举原形态
 * （错误信息里可直接复制为 pi 命令）。
 *
 * 空请求 = 同族 fail-fast（「--skills 给了但没给名字」）：返回 ok:false + 全量
 * available + 空 missing——available 正是调用方报错文案的恢复动作输入（错误 →
 * 可用清单 → 重试闭环），missing 空让报错器走「没有给技能名」分支。自 plan 包
 * enter.ts 迁入（plan-mode-audit-remediation 批次 4②b）：该分支是 slash 空
 * `--skills` 报错复用单源的活契约，非死防御；既有调用方先判非空才调的，行为不受影响。
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
  if (requested.length === 0) {
    return { ok: false, available, missing: [] };
  }
  return missing.length > 0 ? { ok: false, available, missing } : { ok: true, resolved };
}
