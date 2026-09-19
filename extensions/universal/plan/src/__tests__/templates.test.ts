import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getLogger } from "@zhushanwen/pi-extension-logger";

import { extractPlanSteps } from "../compact.js";
import {
  formatAvailablePlans,
  getBuiltinTemplateDir,
  listTemplates,
  loadTemplate,
} from "../templates.js";

const BUILTIN_TEMPLATE_NAMES = [
  "feature-plan",
  "bugfix-plan",
  "refactor-plan",
  "research-plan",
  "implementation-plan",
];

// ── tmp 脚手架（测试红线：写删目标全部 mkdtempSync 自建自删，禁触真实数据目录）──

const createdDirs: string[] = [];

function mkTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

/** 在 dir 下写一个模板 md（返回绝对路径；目录按需创建） */
function writeTemplate(dir: string, file: string, content = "# skeleton\n\n## Implementation Steps\n"): string {
  fs.mkdirSync(dir, { recursive: true });
  const full = join(dir, file);
  fs.writeFileSync(full, content);
  return full;
}

/** 指向 tmp 命名空间但永不创建的路径——existsSync 防御跳过该源（隔离默认 ~/.agents/plans） */
function absentDir(label: string): string {
  return join(tmpdir(), `plan-absent-${label}-${randomUUID()}`);
}

/** loadTemplate 用隔离源（用户级缺位 → 只剩内置源，不受运行机真实 ~/.agents/plans 干扰） */
function isolatedSources(): { userPlansDir: string } {
  return { userPlansDir: absentDir("user") };
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
  vi.restoreAllMocks();
});

describe("builtin source（双形态探测零改动沿用）", () => {
  it("getBuiltinTemplateDir returns valid path", () => {
    const dir = getBuiltinTemplateDir();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("目录入参注入 tmp 隔离后恰为内置 5 条（TemplateInfo 双字段形态，无 source 等多余字段）", () => {
    const templates = listTemplates({ userPlansDir: absentDir("user"), projectRoot: absentDir("proj") });
    expect(templates.map((t) => t.name).sort()).toEqual([...BUILTIN_TEMPLATE_NAMES].sort());
    for (const t of templates) {
      expect(t).toEqual({ name: t.name, path: t.path });
    }
  });

  it("无参调用（默认路径内部推导）恒含内置 5 名", () => {
    // 默认用户源 = 运行机真实 ~/.agents/plans（可能存在），只断言内置 5 名恒在、
    // 调用不炸；全集断言必须在外部目录受控前提下才成立（见上一用例）
    const names = listTemplates().map((t) => t.name);
    for (const n of BUILTIN_TEMPLATE_NAMES) {
      expect(names).toContain(n);
    }
  });
});

describe("三源合并发现器（D2/D4）", () => {
  it("三源目录入参注入：内置 + 用户 + 项目全出现且 location 指向各自路径；非 .md 不进清单", () => {
    const builtinDir = mkTmpDir("plan-3s-builtin-");
    writeTemplate(builtinDir, "alpha.md");
    const userDir = mkTmpDir("plan-3s-user-");
    writeTemplate(userDir, "beta.md");
    fs.writeFileSync(join(userDir, "notes.txt"), "not a template");
    const projectRoot = mkTmpDir("plan-3s-project-");
    const projectPlanPath = writeTemplate(join(projectRoot, ".agents", "plans"), "gamma.md");

    const templates = listTemplates({ builtinDir, userPlansDir: userDir, projectRoot });
    expect(templates.map((t) => t.name).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(templates.find((t) => t.name === "gamma")?.path).toBe(projectPlanPath);
  });

  it("同名遮蔽 last-writer-wins：项目 > 用户 > 内置（同名只出现一次，location 指向胜者）", () => {
    const builtinDir = mkTmpDir("plan-sh-builtin-");
    writeTemplate(builtinDir, "shared.md");
    const userDir = mkTmpDir("plan-sh-user-");
    const userShared = writeTemplate(userDir, "shared.md");
    const projectRoot = mkTmpDir("plan-sh-project-");
    const projectShared = writeTemplate(join(projectRoot, ".agents", "plans"), "shared.md");

    // 项目级胜
    let templates = listTemplates({ builtinDir, userPlansDir: userDir, projectRoot });
    expect(templates.filter((t) => t.name === "shared")).toHaveLength(1);
    expect(templates.find((t) => t.name === "shared")?.path).toBe(projectShared);

    // 撤项目级 → 用户级胜
    fs.rmSync(projectShared);
    templates = listTemplates({ builtinDir, userPlansDir: userDir, projectRoot });
    expect(templates.find((t) => t.name === "shared")?.path).toBe(userShared);

    // 撤用户级 → 内置胜
    fs.rmSync(userShared);
    templates = listTemplates({ builtinDir, userPlansDir: userDir, projectRoot });
    expect(templates.find((t) => t.name === "shared")?.path).toBe(join(builtinDir, "shared.md"));
  });

  it("目录不存在或为空 → 该源静默跳过，合并清单为空不抛错", () => {
    const templates = listTemplates({
      builtinDir: mkTmpDir("plan-empty-builtin-"),
      userPlansDir: absentDir("user"),
      projectRoot: absentDir("proj"),
    });
    expect(templates).toEqual([]);
  });

  it("existsSync 通过但 readdir 失败（权限/TOCTOU，U3）→ 该源降级为空清单 + warn，不向上抛（进入链半进入态防御）", () => {
    // 目录位放普通文件：existsSync 恒真、readdirSync 恒炸（ENOTDIR）——确定性
    // 复现「存在性防御通过后枚举失败」，零 mock；命令层进入顺序 persist →
    // setActiveTools → buildPlanModePrompt，此处 throw 会留半进入态
    const warnSpy = vi.spyOn(getLogger("pi-plan"), "warn");
    const builtinDir = mkTmpDir("plan-scan-ok-");
    writeTemplate(builtinDir, "fine.md");
    const fileAsDir = join(mkTmpDir("plan-scan-filedir-"), "file.md");
    fs.writeFileSync(fileAsDir, "not a directory");

    const templates = listTemplates({ builtinDir, userPlansDir: fileAsDir });
    expect(templates.map((t) => t.name)).toEqual(["fine"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({ dir: fileAsDir });
  });
});

describe("空发现 warn（bundle 布局事故信号）", () => {
  it("内置源扫描为空落 warn（即使外部源有模板遮蔽信号也照落），data 携带探测目录", () => {
    const warnSpy = vi.spyOn(getLogger("pi-plan"), "warn");
    const emptyBuiltin = mkTmpDir("plan-warn-empty-");
    const userDir = mkTmpDir("plan-warn-user-");
    writeTemplate(userDir, "only-user.md");

    const templates = listTemplates({ builtinDir: emptyBuiltin, userPlansDir: userDir });
    expect(templates.map((t) => t.name)).toEqual(["only-user"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toEqual({ builtinDir: emptyBuiltin });
  });

  it("内置源非空不 warn", () => {
    const warnSpy = vi.spyOn(getLogger("pi-plan"), "warn");
    const builtinDir = mkTmpDir("plan-warn-ok-");
    writeTemplate(builtinDir, "fine.md");

    listTemplates({ builtinDir, userPlansDir: absentDir("user") });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("loadTemplate（发现视图的读取侧）", () => {
  it("returns content for existing builtin template（隔离用户源）", () => {
    const content = loadTemplate("feature-plan", isolatedSources());
    expect(content).not.toBeNull();
    expect(content).toContain("## ");
  });

  it("returns null for non-existent template", () => {
    expect(loadTemplate("non-existent-template", isolatedSources())).toBeNull();
  });

  it("从合并视图解析：同名时用户级胜者内容被加载", () => {
    const userDir = mkTmpDir("plan-lt-user-");
    writeTemplate(userDir, "feature-plan.md", "# user-owned skeleton\n");
    expect(loadTemplate("feature-plan", { userPlansDir: userDir })).toBe("# user-owned skeleton\n");
  });
});

describe("<available-plans> 段拼装纯函数（D6）", () => {
  it("空清单返回空串（不注入段）", () => {
    expect(formatAvailablePlans([])).toBe("");
  });

  it("条目 name+location 两字段 + guide 行，name 码点序（'Alpha' < 'zeta'）", () => {
    const section = formatAvailablePlans([
      { name: "zeta", path: "/plans/zeta.md" },
      { name: "Alpha", path: "/plans/Alpha.md" },
    ]);
    expect(section).toBe(
      "<available-plans>\n" +
      "Pick a template from this list, then call plan(action='select-template', templateName='<name>').\n" +
      "  <plan><name>Alpha</name><location>/plans/Alpha.md</location></plan>\n" +
      "  <plan><name>zeta</name><location>/plans/zeta.md</location></plan>\n" +
      "</available-plans>",
    );
  });

  it("码点序而非 locale 序（'-'(0x2D) < 'b'(0x62)，'z'(0x7A) < 'é'(0xE9)）", () => {
    const section = formatAvailablePlans([
      { name: "ab", path: "/1" },
      { name: "a-c", path: "/2" },
      { name: "é", path: "/3" },
      { name: "z", path: "/4" },
    ]);
    // guide 行里的 '<name>' 占位符无闭合标签，正则只命中真实条目
    const order = [...section.matchAll(/<name>([^<]*)<\/name>/g)].map((m) => m[1]);
    expect(order).toEqual(["a-c", "ab", "z", "é"]);
  });

  it("全字段 escapeXml（name 与 location 均转义）", () => {
    const section = formatAvailablePlans([
      { name: 'tag<&>"\'plan', path: '/tmp/a&b<c>"d\'.md' },
    ]);
    expect(section).toContain("<name>tag&lt;&amp;&gt;&quot;&apos;plan</name>");
    expect(section).toContain("<location>/tmp/a&amp;b&lt;c&gt;&quot;d&apos;.md</location>");
  });
});

describe("template ↔ extractPlanSteps alignment guard (D4)", () => {
  // 守卫对象：模板生成端的步骤节标题与解析端正则同仓同测，漂移即红——
  // ① 模板标题改名 → 恰一节断言失败；
  // ② 解析正则与标题脱节 → 提取退化到 fallback 收进其他节的噪音项 → toEqual 失败。
  it.each(BUILTIN_TEMPLATE_NAMES)("template '%s' has exactly one '## Implementation Steps' section that extractPlanSteps consumes", (name) => {
    const content = loadTemplate(name, isolatedSources());
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
