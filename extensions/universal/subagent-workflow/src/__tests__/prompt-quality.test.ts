// prompt-quality — 提示词质量契约测试（原 prompt-quality-batch1 / batch3 修复战役批次文件合一）。
//
// 覆盖（按被锚定的资产分组，批次号是修复战役残留，收敛后不再使用）：
// - SKILL.md 示例不含 review-${file}/${round} 违反 MANDATORY 命名规范
// - notifyDone 在终止性原因时追加防偷懒收尾指令
// - not-found 错误含退路指引
// - agent .md frontmatter 键白名单 + agents 目录全量枚举
// - agent 边界声明：explorer read-only / reviewer 验收 / planner 澄清 /
//   coder 测试纪律 / debugger 假设驱动
// - workflow-script tool discovery + anti-pattern
// - agent .md frontmatter 保留有效格式（九角色枚举）

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..", "..");

function readSrc(relPath: string): string {
  return readFileSync(join(PKG_ROOT, relPath), "utf-8");
}

// C5 过渡态收口：agent 模板已迁 @zhushanwen/subagent-core/agents/（C1/D-1）——经
// ./workflows/* 子入口锚点解析 core 包根（与 src/host/pi-host.ts corePackageNpmRoot 同一锚；
// 子入口映射包根真实目录，随源码走不依赖 dist 构建——relay-env 锚在 require 条件下落
// dist/，CI 不构建 workspace 包时 resolve 直接 MODULE_NOT_FOUND）。
const CORE_AGENTS_DIR = join(
  dirname(createRequire(import.meta.url).resolve("@zhushanwen/subagent-core/workflows/README.md")),
  "..",
  "agents",
);

function readAgent(name: string): string {
  return readFileSync(join(CORE_AGENTS_DIR, `${name}.md`), "utf-8");
}

// ── SKILL.md 示例修正 ──────────────────────────────────────────

describe("SKILL.md 示例不含 review-${file}/${round} 模式", () => {
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

// ── notifyDone 终止性错误收尾 ──────────────────────────────────

describe("notifyDone 终止性原因追加防偷懒收尾", () => {
  const helpersSrc = readSrc("src/workflow-notify.ts");

  it("终止性判定消费 core 谓词（词表已收编 isTerminalDoneReason，非本地 Set）", () => {
    // 原本地 TERMINAL_REASONS Set 镜像已删（其幽灵成员 circular 不在 core 词表）；
    // 判定单源 = core isTerminalDoneReason（穷举 switch，词表演化 tsc 强制归类）
    expect(helpersSrc).toContain("isTerminalDoneReason");
    expect(helpersSrc).not.toContain("TERMINAL_REASONS");
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

// ── not-found 错误含退路指引 ───────────────────────────────────
// 注：cancel not-found 的 includeFinished 指引原条已删——core
// subagent-actions-core not-found 文案已逐字含更强指引（action:'list' with
// includeFinished:true + includeWorkflow 扩展），壳侧 toContain 弱锚无增量。

describe("not-found 错误含退路指引", () => {
  const toolWorkflowSrc = readSrc("src/interface/tool-workflow.ts");
  const toolWorkflowScriptSrc = readSrc("src/interface/tool-workflow-script.ts");

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
});

// ── agent .md frontmatter 键白名单 + agents 目录全量枚举 ────────

describe("agent .md frontmatter 键白名单 + agents 目录全量枚举", () => {
  const agentFiles = readdirSync(CORE_AGENTS_DIR).filter((f) => f.endsWith(".md"));

  // E2 式全量枚举：实目录恰为九角色 + doc-reviewer 共 10 个 .md——模板新增/删除
  // 必须有意识过本断言（计数式弱断言不防漂移，全量枚举缺一即红）
  const EXPECTED_AGENT_FILES = [
    "analyst",
    "coder",
    "debugger",
    "doc-reviewer",
    "explorer",
    "general-purpose",
    "orchestrator",
    "planner",
    "researcher",
    "reviewer",
  ].map((name) => `${name}.md`).sort();

  it("agents 目录 .md 全量枚举（10 个：九角色 + doc-reviewer，无缺无增）", () => {
    expect([...agentFiles].sort()).toEqual(EXPECTED_AGENT_FILES);
  });

  it.each(agentFiles)("%s 不含 extensions: 和 category: 行", (filename) => {
    const src = readFileSync(join(CORE_AGENTS_DIR, filename), "utf-8");
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

// ── explorer read-only 黑名单/白名单 ─────────────────────────

describe("explorer read-only 黑名单/白名单", () => {
  const explorer = readAgent("explorer");

  it("包含 NEVER run 黑名单标题", () => {
    expect(explorer).toContain("NEVER run");
  });

  it("黑名单含 git 写操作", () => {
    expect(explorer).toContain("git commit");
    expect(explorer).toContain("git push");
    expect(explorer).toContain("git reset");
    expect(explorer).toContain("git checkout");
  });

  it("不含旧白名单措辞", () => {
    expect(explorer).not.toContain("Your bash access is for exploration only");
    expect(explorer).not.toContain("unlisted commands");
  });

  it("包含 Free to run 只读白名单", () => {
    expect(explorer).toContain("Free to run");
    expect(explorer).toContain("git log");
    expect(explorer).toContain("git diff");
  });
});

// ── reviewer 吸收需求验收（原 oracle 职责） ─────────────────

describe("reviewer 吸收需求验收", () => {
  const reviewer = readAgent("reviewer");

  it("含 Correctness 需求符合性第一视角", () => {
    expect(reviewer).toContain("Correctness");
  });

  it("整个需求未实现时记 requirements gap 转 planner", () => {
    expect(reviewer).toContain("requirements gap");
  });

  it("severity 三档分级", () => {
    expect(reviewer).toContain("Critical");
    expect(reviewer).toContain("Major");
    expect(reviewer).toContain("Minor");
  });

  it("缺材料返回 Context insufficient 不硬审", () => {
    expect(reviewer).toContain("Context insufficient");
  });
});

// ── planner 合并需求澄清（原 context-builder 职责） ─────────

describe("planner 合并需求澄清", () => {
  const planner = readAgent("planner");

  it("声明需求澄清职责（吸收 context-builder）", () => {
    expect(planner).toContain("澄清");
  });

  it("产出 execution guide for a coder", () => {
    expect(planner).toContain("execution guide for a coder");
  });

  it("产出编号有序步骤", () => {
    expect(planner).toContain("编号");
  });
});

// ── coder 吸收测试职责（原 worker + tester 合并） ────────────

describe("coder 吸收测试职责", () => {
  const coder = readAgent("coder");

  it("含测试纪律段", () => {
    expect(coder).toContain("测试纪律");
  });

  it("修 bug 先写复现测试再改", () => {
    expect(coder).toContain("复现测试");
  });

  it("外科手术式变更约束", () => {
    expect(coder).toContain("外科手术式变更");
  });
});

// ── debugger 假设驱动 + 临时日志恢复纪律 ────────────────────

describe("debugger 假设驱动 + 临时日志恢复", () => {
  const dbg = readAgent("debugger");

  it("假设驱动而非线性 5 whys", () => {
    expect(dbg).toContain("假设驱动");
  });

  it("临时日志必须恢复", () => {
    expect(dbg).toContain("临时");
    expect(dbg).toContain("恢复");
  });

  it("不改业务代码（修复归 coder）", () => {
    expect(dbg).toContain("修复动作归 coder");
  });
});

// ── workflow-script tool description + anti-pattern ──────────

describe("workflow-script tool description + anti-pattern", () => {
  const src = readSrc(join("src", "interface", "tool-workflow-script.ts"));

  it("description 含 discovery 优先提示", () => {
    expect(src).toContain("Before generating");
    expect(src).toContain("action:list");
  });

  it("promptGuidelines 含 ANTI-PATTERN 条目", () => {
    expect(src).toContain("ANTI-PATTERN");
  });

  it("anti-pattern 保留字样但不点名内置 workflow（m4：发现靠注入段，防硬编码）", () => {
    expect(src).toContain("ANTI-PATTERN");
    expect(src).toContain("NEVER generate");
    expect(src).not.toContain("chain/parallel/scatter-gather/map-reduce");
  });
});

// ── agent .md frontmatter 保留有效格式（九角色枚举） ─────────

describe("agent .md frontmatter 保留有效格式（九角色枚举）", () => {
  const agents = [
    "explorer", "planner", "coder", "reviewer", "debugger",
    "analyst", "researcher", "orchestrator", "general-purpose",
  ];

  for (const name of agents) {
    it(`${name}.md 以 --- 开头且含 name + description 字段`, () => {
      const md = readAgent(name);
      expect(md.startsWith("---")).toBe(true);
      expect(md).toContain(`name: ${name}`);
      expect(md).toMatch(/^description:\s+.+/m);
    });
  }
});
