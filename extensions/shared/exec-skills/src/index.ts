/**
 * @zhushanwen/pi-exec-skills 公共出口（ADR-0074 落地包）。
 *
 * 两段消费语义闭环：exec-skills = 发现（目录扫描，技能热装即时可见）；
 * resolve-skills = 执行门禁（pi 注册表确认 pi 实际认得）。禁止各扩展自扫
 * skill 目录或直用 pi 注册表快照形成第二实现。
 */
export { detectExecSkills, hasPlanExecMarker, isEnabledByOverrides } from "./exec-skills.js";
export type { DetectExecSkillsOptions, ExecSkill } from "./exec-skills.js";
export { normalizeSkillName, resolveSkills } from "./resolve-skills.js";
export type { SkillRef, SkillResolution } from "./resolve-skills.js";
