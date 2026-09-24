import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildPlanModePrompt } from "../prompts.js";

// ── tmp 脚手架（测试红线：写删目标全部 mkdtempSync 自建自删，禁触真实数据目录）──

const createdDirs: string[] = [];

function mkTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

/**
 * 注入段项目级源锚点回归锁（U1）：planFilePath = <projectRoot>/.tmp/plans/
 * <slug>/plan.md（slug 目录嵌套）——从 planFilePath 逆推项目级源曾因层级差致
 * 注入段扫浅层 .agents/plans（几乎恒不存在）→ 项目级模板
 * 投放（G2）从注入清单完全消失，而 select-template 侧用 listTemplates({
 * projectRoot: ctx.cwd }) 正确（两轨不同源）。本组用例按真实层级构造
 * planFilePath，锁死「注入段项目级源 = PlanPromptInput.projectRoot 的
 * .agents/plans」——旧签名（无 projectRoot 字段）在类型层即编译失败。
 */
describe("注入段项目级模板源锚点 = PlanPromptInput.projectRoot（ctx.cwd，D2/U1）", () => {
  it("projectRoot/.agents/plans 下的模板进 <available-plans>（name + location 绝对路径）", () => {
    const projectRoot = mkTmpDir("plan-prompt-proj-");
    const templateName = `project-tpl-${randomUUID().slice(0, 8)}`;
    const plansDir = join(projectRoot, ".agents", "plans");
    fs.mkdirSync(plansDir, { recursive: true });
    const templatePath = join(plansDir, `${templateName}.md`);
    fs.writeFileSync(templatePath, "# project skeleton\n\n## Implementation Steps\n");

    const prompt = buildPlanModePrompt({
      requirement: "integrate project-level template source",
      planFilePath: join(projectRoot, ".tmp", "plans", "some-slug", "plan.md"),
      projectRoot,
      skills: [],
    });

    // UUID 后缀名不与运行机真实 ~/.agents/plans、内置 5 模板撞名——containment 断言确定
    expect(prompt).toContain("<available-plans>");
    expect(prompt).toContain(`<name>${templateName}</name>`);
    expect(prompt).toContain(`<location>${templatePath}</location>`);
  });

  it("planDir 逆推层级（<projectRoot>/.tmp/plans/.agents/plans）不是项目级源——放在那里的模板不进清单", () => {
    const projectRoot = mkTmpDir("plan-prompt-trap-");
    const trapName = `trap-tpl-${randomUUID().slice(0, 8)}`;
    const trapDir = join(projectRoot, ".tmp", "plans", ".agents", "plans");
    fs.mkdirSync(trapDir, { recursive: true });
    fs.writeFileSync(join(trapDir, `${trapName}.md`), "# wrong anchor\n");

    const prompt = buildPlanModePrompt({
      requirement: "wrong anchor must not surface",
      planFilePath: join(projectRoot, ".tmp", "plans", "some-slug", "plan.md"),
      projectRoot,
      skills: [],
    });

    expect(prompt).not.toContain(`<name>${trapName}</name>`);
    expect(prompt).not.toContain(`<location>${join(trapDir, `${trapName}.md`)}</location>`);
  });
});

describe("Phase C.5 自审清单 + D8 重挂请求纪律 + selfReview 必带（D9②/D8）", () => {
  it("模板流程：C.5 四项清单在产物纪律段之后注入，submit-review 指引必带 selfReview，重挂请求直接重提", () => {
    const projectRoot = mkTmpDir("plan-prompt-c5-");
    const prompt = buildPlanModePrompt({
      requirement: "add dark mode",
      planFilePath: join(projectRoot, ".tmp", "plans", "add-dark-mode", "plan.md"),
      projectRoot,
      skills: [],
    });

    // Phase C.5 自审清单（D9②）：四项 + 先修文档再提交
    expect(prompt).toContain("Phase C.5: Self-Review Before Submission");
    expect(prompt).toContain("Requirement coverage");
    expect(prompt).toContain("Assumption audit");
    expect(prompt).toContain("[UNVERIFIED]");
    expect(prompt).toContain("Chapter completeness");
    expect(prompt).toContain("Acceptance realism");
    // C.5 段落在产物纪律段之后（D9② 注入位钉死）
    expect(prompt.indexOf("## Deliverable Discipline")).toBeLessThan(prompt.indexOf("Phase C.5"));
    // 自审硬门的提示词面：submit-review 必带 selfReview（无豁免）
    expect(prompt).toContain("selfReview is REQUIRED every time");
    expect(prompt).toContain("plan(action='submit-review', selfReview=");
    // D8 提示词纪律：收到重挂请求直接 submit-review（不再让用户猜/让 agent 无指令）
    expect(prompt).toContain("asks to re-submit the plan review");
    expect(prompt).toContain("IMMEDIATELY");
  });

  it("技能流程同样注入 C.5（自审硬门对每次 submit-review 生效，不随模板/技能流程分叉）", () => {
    const projectRoot = mkTmpDir("plan-prompt-c5s-");
    const prompt = buildPlanModePrompt({
      requirement: "refactor auth",
      planFilePath: join(projectRoot, ".tmp", "plans", "refactor-auth", "plan.md"),
      projectRoot,
      skills: [{ name: "tech-design", skillPath: "/skills/tech-design/SKILL.md" }],
    });

    expect(prompt).toContain("Phase C.5: Self-Review Before Submission");
    expect(prompt).toContain("selfReview is REQUIRED every time");
  });
});
