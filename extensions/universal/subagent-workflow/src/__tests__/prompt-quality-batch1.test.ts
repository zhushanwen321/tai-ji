// U1-U4: 提示词质量第 1 批修复验证
//
// 覆盖：
// U1: SKILL.md 示例不再含 review-${file}/${round} 违反 MANDATORY 命名规范
// U2: notifyDone 在终止性原因时追加防偷懒收尾指令
// U3: 5 处 not-found 错误含退路指引
// U4: agent .md 无无效 frontmatter 键

import { readdirSync,readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..", "..");

function readSrc(relPath: string): string {
  return readFileSync(join(PKG_ROOT, relPath), "utf-8");
}

// ── U1: SKILL.md 示例修正 ──────────────────────────────────────

describe("U1: SKILL.md 示例不含 review-${file}/${round} 模式", () => {
  const skillSrc = readSrc("skills/workflow-script-format/SKILL.md");

  it("不含 review-${file} 字面量", () => {
    expect(skillSrc).not.toContain("review-${file}");
  });

  it("不含 review-${round} 字面量", () => {
    expect(skillSrc).not.toContain("review-${round}");
  });

  it("不含 verify-review-${file} 字面量", () => {
    expect(skillSrc).not.toContain("verify-review-${file}");
  });
});

// ── U2: notifyDone 终止性错误收尾 ──────────────────────────────

describe("U2: notifyDone 终止性原因追加防偷懒收尾", () => {
  const helpersSrc = readSrc("src/interface/helpers.ts");

  it("含终止性原因集合定义", () => {
    // TERMINAL_REASONS 包含 budget_limited / time_limited / aborted 等
    expect(helpersSrc).toContain("budget_limited");
    expect(helpersSrc).toContain("time_limited");
    expect(helpersSrc).toContain("aborted");
  });

  it("含防偷懒收尾指令（NOT task completion）", () => {
    expect(helpersSrc).toContain("NOT task completion");
  });

  it("含收尾三步骤关键词（DONE / NOT DONE / next step）", () => {
    expect(helpersSrc).toContain("DONE");
    expect(helpersSrc).toContain("NOT DONE");
    expect(helpersSrc).toContain("next step");
  });
});

// ── U3: not-found 错误含退路指引 ───────────────────────────────

describe("U3: not-found 错误含退路指引", () => {
  const toolWorkflowSrc = readSrc("src/interface/tool-workflow.ts");
  const toolWorkflowScriptSrc = readSrc("src/interface/tool-workflow-script.ts");
  // [D6②] cancel not-found 文案权威源已随领域内核下沉 core subagent-actions-core。
  // 锚点用 ./workflows/* 子入口（exports 映射包根真实目录，随源码走不依赖 dist 构建——
  // relay-env 锚在 require 条件下落 dist/，CI 不构建 workspace 包时 resolve 直接
  // MODULE_NOT_FOUND）
  const coreRoot = join(
    dirname(
      createRequire(import.meta.url).resolve("@zhushanwen/subagent-core/workflows/README.md"),
    ),
    "..",
  );
  const subagentActionsCoreSrc = readFileSync(
    join(coreRoot, "src/execution/assembly/subagent-actions-core.ts"),
    "utf-8",
  );

  it("tool-workflow.ts: not-found 错误含 action:status 指引", () => {
    // abort 的 not-found 错误应有 action:status 指引（pause/resume 已随一次性生命周期移除）
    const matches = toolWorkflowSrc.match(/action:status/g) ?? [];
    // 至少 1 处（lifecycle not-found 错误）
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("tool-workflow-script.ts: lint not-found 含可用列表", () => {
    // loadAll + filter available + suggestions
    expect(toolWorkflowScriptSrc).toMatch(/Available:/);
  });

  it("cancel not-found 含 includeFinished 指引", () => {
    expect(subagentActionsCoreSrc).toContain("includeFinished");
  });
});

// ── U4: agent .md 无无效 frontmatter 键 ────────────────────────

describe("U4: agent .md 无无效 frontmatter 键", () => {
  // C5 过渡态收口：模板已迁 @zhushanwen/subagent-core/agents/（C1/D-1）——经
  // ./workflows/* 子入口锚点解析 core 包根（与 src/host/pi-host.ts 同一锚）
  const coreAgentsDir = join(
    dirname(createRequire(import.meta.url).resolve("@zhushanwen/subagent-core/workflows/README.md")),
    "..",
    "agents",
  );
  const agentFiles = readdirSync(coreAgentsDir).filter((f) => f.endsWith(".md"));

  it("agents 目录有 ≥7 个 .md 文件", () => {
    expect(agentFiles.length).toBeGreaterThanOrEqual(7);
  });

  it.each(agentFiles)("%s 不含 extensions: 和 category: 行", (filename) => {
    const src = readFileSync(join(coreAgentsDir, filename), "utf-8");
    const lines = src.split("\n");
    // frontmatter 在第一个 --- 和第二个 --- 之间
    const fmStart = lines.indexOf("---");
    const fmEnd = lines.indexOf("---", fmStart + 1);
    expect(fmStart).toBeGreaterThanOrEqual(0);
    expect(fmEnd).toBeGreaterThan(fmStart);
    const frontmatter = lines.slice(fmStart + 1, fmEnd);
    const invalidKeys = frontmatter.filter((l) => /^extensions:\s/.test(l) || /^category:\s/.test(l));
    expect(invalidKeys).toEqual([]);
  });
});
