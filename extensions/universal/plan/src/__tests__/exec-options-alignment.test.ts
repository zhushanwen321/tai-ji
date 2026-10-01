/**
 * PHASE_D 散文 ↔ buildExecOptions 选项集对齐防线（plan-phase-d-prompt-options-alignment
 * 定案：2026-09-26 登记二选一，2026-09-27 裁决 = 单源化 + 对齐测试双管）。
 *
 * 能单源的已单源：技能档上限 MAX_SKILL_OPTIONS（prompts.ts SSOT，散文插值 + 截断同源）、
 * 选项 label（i18n exec.* 词典单源）。散文无法整体生成的结构性原因：面向模型的是英文
 * 静态散文，选项是运行时按检测结果动态构造 + 用户侧 label 随 locale 本地化——两种语言、
 * 两个受众；散文还描述「无技能直通」分支行为（无选项对象对应物）。故散文锚点靠本测试
 * 机器锁定：数量锚、label 字面锚、两分支行为句锚，漂移即红。
 */
import { describe, expect, it } from "vitest";

import { t } from "../i18n.js";
import { MAX_SKILL_OPTIONS, PHASE_D_PROSE } from "../prompts.js";
import { buildExecOptions } from "../tool.js";
import type { ExecSkill } from "@zhushanwen/pi-exec-skills";

function fixtureSkill(name: string): ExecSkill {
  return { name, description: `${name} plan-exec skill`, skillEntryPath: `/tmp/skills/${name}/SKILL.md` } as ExecSkill;
}

describe("PHASE_D 散文 ↔ buildExecOptions 对齐", () => {
  it("数量锚：散文技能档上限 = 截断常量（MAX_SKILL_OPTIONS 单源，改一处散文自动跟随）", () => {
    expect(PHASE_D_PROSE).toContain(`up to ${MAX_SKILL_OPTIONS} detected plan-exec skills`);
  });

  it("截断行为锚：检测超过上限的技能只取前 MAX_SKILL_OPTIONS 个 + 固定尾部两项", () => {
    const skills = Array.from({ length: MAX_SKILL_OPTIONS + 2 }, (_, i) => fixtureSkill(`s${i + 1}`));
    const options = buildExecOptions(skills);

    expect(options).toHaveLength(MAX_SKILL_OPTIONS + 2);
    expect(options.slice(0, MAX_SKILL_OPTIONS).map((o) => o.mode)).toEqual(["skill:s1", "skill:s2"]);
    expect(options.slice(MAX_SKILL_OPTIONS).map((o) => o.mode)).toEqual(["execute", "later"]);
  });

  it("label 锚：选项 label 出自 i18n 词典（en-US 基准），散文含对应英文字面", () => {
    const en = (key: string, params?: Record<string, string | number>) => t(key, params, "en-US");

    const options = buildExecOptions([fixtureSkill("dev-flow")]);
    const [skillOption, executeOption, laterOption] = options;

    // 选项 label 单源 = 词典；散文锚定词典渲染产物（技能档取 name 占位渲染形态）
    expect(skillOption.label).toBe(en("exec.viaSkill", { name: "dev-flow" }));
    expect(executeOption.label).toBe(en("exec.execute"));
    expect(laterOption.label).toBe(en("exec.later"));

    expect(PHASE_D_PROSE).toContain("Execute via skill: <name>");
    // Execute 作为完整选项词（非 "Execute via" 前缀的一部分——用后随括号边界锚定）
    expect(PHASE_D_PROSE).toContain(`${en("exec.execute")} (goal tracking integrated when available), or ${en("exec.later")}`);
  });

  it("两分支行为句锚：有技能弹表单 / 无技能直通（D7②），散文与行为分支共存", () => {
    expect(PHASE_D_PROSE).toContain("the user picks an execution method in the completion dialog");
    expect(PHASE_D_PROSE).toContain("When NO plan-exec skill is detected, no dialog appears and the plan executes directly");
  });
});
