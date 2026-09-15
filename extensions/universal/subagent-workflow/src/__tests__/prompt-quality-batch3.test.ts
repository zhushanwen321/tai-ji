// Batch 3 prompt quality 验证（v2：新 9-agent 体系）
//
// 旧体系（context-builder/oracle/worker）已废弃合并。本文件验证新体系的边界声明：
// U1: explorer.md read-only 黑名单/白名单（保留）
// U2: reviewer 吸收需求验收（原 oracle 职责并入）
// U3: planner 合并需求澄清（原 context-builder 职责并入）
// U4: coder 吸收测试职责（原 worker + tester 合并）
// U5: debugger 假设驱动 + 临时日志恢复纪律
// E1: workflow-script tool discovery + anti-pattern（与 agent 无关，保留）
// E2: 9 个 agent frontmatter 完整性

import { readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..", "..");

function readSrc(relPath: string): string {
  return readFileSync(join(PKG_ROOT, relPath), "utf-8");
}

// C5 过渡态收口：agent 模板已迁 @zhushanwen/subagent-core/agents/（C1/D-1）——经
// ./workflows/* 子入口锚点解析 core 包根（与 src/host/pi-host.ts corePackageNpmRoot 同一锚）
const CORE_AGENTS_DIR = join(
  dirname(createRequire(import.meta.url).resolve("@zhushanwen/subagent-core/workflows/README.md")),
  "..",
  "agents",
);

function readAgent(name: string): string {
  return readFileSync(join(CORE_AGENTS_DIR, `${name}.md`), "utf-8");
}

// ── U1: explorer read-only 黑名单/白名单 ─────────────────────

describe("U1: explorer read-only 黑名单/白名单", () => {
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

// ── U2: reviewer 吸收需求验收（原 oracle 职责） ─────────────

describe("U2: reviewer 吸收需求验收", () => {
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

// ── U3: planner 合并需求澄清（原 context-builder 职责） ─────

describe("U3: planner 合并需求澄清", () => {
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

// ── U4: coder 吸收测试职责（原 worker + tester 合并） ────────

describe("U4: coder 吸收测试职责", () => {
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

// ── U5: debugger 假设驱动 + 临时日志恢复纪律 ────────────────

describe("U5: debugger 假设驱动 + 临时日志恢复", () => {
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

// ── E1: workflow-script tool discovery + anti-pattern ────────
// （与 agent 体系无关，原样保留）

describe("E1: workflow-script tool description + anti-pattern", () => {
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

// ── E2: 9 个 agent frontmatter 完整性 ───────────────────────

describe("E2: agent .md frontmatter 保留有效格式", () => {
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
