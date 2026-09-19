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
 * 注入段项目级源锚点回归锁（U1）：planFilePath = <projectRoot>/.taiji-harness/
 * <slug>/plan.md 三层深——旧实现两级上溯逆推得 <projectRoot>/.taiji-harness（差
 * 一层），注入段恒扫 .taiji-harness/.agents/plans（几乎恒不存在）→ 项目级模板
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
      planFilePath: join(projectRoot, ".taiji-harness", "some-slug", "plan.md"),
      projectRoot,
      skills: [],
    });

    // UUID 后缀名不与运行机真实 ~/.agents/plans、内置 5 模板撞名——containment 断言确定
    expect(prompt).toContain("<available-plans>");
    expect(prompt).toContain(`<name>${templateName}</name>`);
    expect(prompt).toContain(`<location>${templatePath}</location>`);
  });

  it("planDir 逆推层级（<projectRoot>/.taiji-harness/.agents/plans）不是项目级源——放在那里的模板不进清单", () => {
    const projectRoot = mkTmpDir("plan-prompt-trap-");
    const trapName = `trap-tpl-${randomUUID().slice(0, 8)}`;
    const trapDir = join(projectRoot, ".taiji-harness", ".agents", "plans");
    fs.mkdirSync(trapDir, { recursive: true });
    fs.writeFileSync(join(trapDir, `${trapName}.md`), "# wrong anchor\n");

    const prompt = buildPlanModePrompt({
      requirement: "wrong anchor must not surface",
      planFilePath: join(projectRoot, ".taiji-harness", "some-slug", "plan.md"),
      projectRoot,
      skills: [],
    });

    expect(prompt).not.toContain(`<name>${trapName}</name>`);
    expect(prompt).not.toContain(`<location>${join(trapDir, `${trapName}.md`)}</location>`);
  });
});
