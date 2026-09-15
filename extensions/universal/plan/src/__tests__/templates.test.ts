import * as fs from "node:fs";

import { describe, expect, it } from "vitest";

import { extractPlanSteps } from "../compact.js";
import { getBuiltinTemplateDir, listTemplates, loadTemplate } from "../templates.js";

const BUILTIN_TEMPLATE_NAMES = [
  "feature-plan",
  "bugfix-plan",
  "refactor-plan",
  "research-plan",
  "implementation-plan",
];

describe("Template system (builtin single source, D3)", () => {
  it("listTemplates returns exactly the 5 builtin templates with no source field", () => {
    const templates = listTemplates();
    expect(templates.map((t) => t.name).sort()).toEqual([...BUILTIN_TEMPLATE_NAMES].sort());
    // 单源化后 TemplateInfo 只有 name/path —— source 等多源残留字段即红
    for (const t of templates) {
      expect(t).toEqual({ name: t.name, path: t.path });
    }
  });

  it("loadTemplate returns content for existing builtin template", () => {
    const content = loadTemplate("feature-plan");
    expect(content).not.toBeNull();
    expect(content).toContain("## ");
  });

  it("loadTemplate returns null for non-existent template", () => {
    const content = loadTemplate("non-existent-template");
    expect(content).toBeNull();
  });

  it("getBuiltinTemplateDir returns valid path", () => {
    const dir = getBuiltinTemplateDir();
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe("template ↔ extractPlanSteps alignment guard (D4)", () => {
  // 守卫对象：模板生成端的步骤节标题与解析端正则同仓同测，漂移即红——
  // ① 模板标题改名 → 恰一节断言失败；
  // ② 解析正则与标题脱节 → 提取退化到 fallback 收进其他节的噪音项 → toEqual 失败。
  it.each(BUILTIN_TEMPLATE_NAMES)("template '%s' has exactly one '## Implementation Steps' section that extractPlanSteps consumes", (name) => {
    const content = loadTemplate(name);
    expect(content).not.toBeNull();

    expect(content!.match(/^## Implementation Steps$/gm)).toHaveLength(1);

    const plan = content!
      // 在第一个非步骤节标题后放噪音编号项（模拟 Requirements 等节含编号列表）
      .replace(/^(## (?!Implementation Steps).+)$/m, "$1\n1. noise-from-other-section")
      // 在步骤节标题后填编号步骤（模拟 AI 按模板写 plan.md）
      .replace(/^## Implementation Steps$/m, "## Implementation Steps\n1. Real step A\n2. Real step B");
    expect(extractPlanSteps(plan)).toEqual(["Real step A", "Real step B"]);
  });
});
