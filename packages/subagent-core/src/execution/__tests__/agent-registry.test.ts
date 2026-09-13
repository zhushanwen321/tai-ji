// src/execution/__tests__/agent-registry.test.ts
//
// AgentRegistry 测试（S2 路径统一版）。u-5c 迁自壳套件 src/__tests__/agent-registry.test.ts
// （被测 module 是 core 件，唯一测试覆盖原落壳——设计 §2.2 C6 / §1 目标 6）。
//
// 「builtin agents 数据合规」段：u-5c 曾拆出留壳（feat 侧布局：资产在壳包），但
// 合并终态 10 模板资产已迁 core 包 agents/（dev 侧 C5/D-1），壳 agents/ 不存在，
// 该段随资产回归 core 测试域（C5 锚点 + D-5 去 tools 化断言）。
//
// S2 重构：AgentRegistry 从「按名查找（discoverAll + cache Map<name>）」收敛为
// 「按绝对路径加载（loadByPath）」——agentRef 唯一形态 = .md 绝对路径（注入段
// <location>），内置 agent 即包内物理路径，无 builtin 合并、无名字查找。
// 发现（注入段数据源）职责由 shared/resource-discovery + injector 承担，
// 本文件不再测发现层（见 resource-discovery.test.ts）。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 隔离真实用户全局目录（~/.agents/agents/ 可能有真实 agent 文件）
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/nonexistent-home-for-tests" };
});

import { AgentRegistry, parseAgentFrontmatter, parseAgentWithMeta } from "../assembly/agent-registry.ts";
import { clearEngines, registerEngine } from "../engine/registry.ts";
import type { EnginePort } from "../engine/port.ts";
import { lintAgentMeta } from "../../orchestration/script-lint.ts";
import { parseResourceMeta } from "../../shared/meta-parser.ts";

// ============================================================
// helpers
// ============================================================

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-reg-test-"));
}

function writeAgent(dir: string, name: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.md`);
  fs.writeFileSync(filePath, body, "utf-8");
  return filePath;
}

// ============================================================
// parseAgentFrontmatter
// ============================================================

describe("parseAgentFrontmatter", () => {
  it("parses name from filename + body as systemPrompt when no frontmatter", () => {
    const cfg = parseAgentFrontmatter("/x/worker.md", "You are a worker.");
    expect(cfg.name).toBe("worker");
    expect(cfg.systemPrompt).toBe("You are a worker.");
  });
  it("extracts model/thinkingLevel/tools from frontmatter", () => {
    const cfg = parseAgentFrontmatter("/x/coder.md", `---
name: coder
description: coding agent
model: anthropic/claude-3.5-sonnet
thinkingLevel: high
tools: [read, bash]
---
body text`);
    expect(cfg.name).toBe("coder");
    expect(cfg.model).toBe("anthropic/claude-3.5-sonnet");
    expect(cfg.thinkingLevel).toBe("high");
    expect(cfg.tools).toEqual(["read", "bash"]);
    expect(cfg.systemPrompt).toBe("body text");
  });
});

// ============================================================
// parseAgentWithMeta（m5 T2：W4 lint 用 AgentMeta 二元组）
// ============================================================

describe("parseAgentWithMeta", () => {
  it("有 frontmatter（IF1 通过）：meta 非 null 且路由字段完整，config 同步正确", () => {
    const { config, meta } = parseAgentWithMeta("/x/coder.md", `---
name: coder
description: 编码 agent
when: 需要写代码
notFor: 纯分析
model: anthropic/claude-3.5-sonnet
thinkingLevel: high
tools: [read, bash]
---
body text`);
    expect(meta).not.toBeNull();
    expect(meta!.kind).toBe("agent");
    expect(meta!.name).toBe("coder");
    expect(meta!.description).toBe("编码 agent");
    expect(meta!.when).toBe("需要写代码");
    expect(meta!.notFor).toBe("纯分析");
    expect(config.name).toBe("coder");
    expect(config.systemPrompt).toBe("body text");
    expect(config.model).toBe("anthropic/claude-3.5-sonnet");
    expect(config.thinkingLevel).toBe("high");
    expect(config.tools).toEqual(["read", "bash"]);
  });

  it("无 frontmatter：meta = null，整个内容作为 systemPrompt", () => {
    const { config, meta } = parseAgentWithMeta("/x/plain.md", "Just a prompt body.");
    expect(meta).toBeNull();
    expect(config).toEqual({
      name: "plain",
      systemPrompt: "Just a prompt body.",
    });
  });

  it("MF-3 fallback：缺 description（IF1 返 null）时 model/tools 经 extractYamlField 仍生效", () => {
    const { config, meta } = parseAgentWithMeta("/x/legacy.md", `---
name: legacy
model: anthropic/claude-3.5-sonnet
tools: read, bash, write
---
body text`);
    // 缺 description → parseResourceMeta 返 null → meta 为 null（结构化路由不可见）
    expect(meta).toBeNull();
    // 但 config 的 model/tools 不丢（direct-path loadByPath 与重构前行为一致）
    expect(config.name).toBe("legacy");
    expect(config.model).toBe("anthropic/claude-3.5-sonnet");
    expect(config.tools).toEqual(["read", "bash", "write"]);
    expect(config.systemPrompt).toBe("body text");
  });

  it("未闭合 frontmatter：meta = null，name 经 extractYamlField fallback，其余作为 systemPrompt", () => {
    const { config, meta } = parseAgentWithMeta("/x/broken.md", `---
name: broken
model: x/y`);
    expect(meta).toBeNull();
    expect(config.name).toBe("broken");
    // 未闭合分支只取 name（原行为），不解析 model
    expect(config.systemPrompt).toBe(`---\nname: broken\nmodel: x/y`);
  });
});

// ============================================================
// AgentRegistry.loadByPath（S2：agentRef = .md 绝对路径）
// ============================================================

describe("AgentRegistry.loadByPath", () => {
  let ws: string;
  beforeEach(() => { ws = tmpWorkspace(); });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

  it("按绝对路径加载 agent：frontmatter + body → AgentConfig", () => {
    const file = writeAgent(path.join(ws, ".pi", "agents"), "worker", `---
name: worker
description: 通用执行 agent
tools: [read, bash]
---
You are a worker.`);
    const reg = new AgentRegistry();
    const cfg = reg.loadByPath(file);
    expect(cfg?.name).toBe("worker");
    expect(cfg?.systemPrompt).toBe("You are a worker.");
    expect(cfg?.tools).toEqual(["read", "bash"]);
  });

  it("无 frontmatter 文件：整个内容作为 systemPrompt", () => {
    const file = writeAgent(ws, "plain", "Just a prompt body.");
    const cfg = new AgentRegistry().loadByPath(file);
    expect(cfg?.name).toBe("plain");
    expect(cfg?.systemPrompt).toBe("Just a prompt body.");
  });

  it("mtime 缓存：未变文件不重读（config 引用稳定）", () => {
    const file = writeAgent(ws, "cached", "v1");
    const reg = new AgentRegistry();
    const first = reg.loadByPath(file);
    const second = reg.loadByPath(file);
    expect(second).toBe(first);
    // 修改后 mtime 变化 → 新 config
    fs.writeFileSync(file, "v2", "utf-8");
    const third = reg.loadByPath(file);
    expect(third?.systemPrompt).toBe("v2");
  });

  it("相对路径引用返回 undefined（引用唯一形态 = 绝对路径）", () => {
    const reg = new AgentRegistry();
    expect(reg.loadByPath("worker")).toBeUndefined();
    expect(reg.loadByPath("./agents/worker.md")).toBeUndefined();
  });

  it("非 .md 引用返回 undefined", () => {
    const reg = new AgentRegistry();
    expect(reg.loadByPath("/tmp/worker.txt")).toBeUndefined();
  });

  it("文件不存在返回 undefined，require=true 抛错带指引", () => {
    const reg = new AgentRegistry();
    expect(reg.loadByPath("/nonexistent/x.md")).toBeUndefined();
    // R5（D7）：三态错误文案统一带 <available_subagents> <location> 恢复指引
    expect(() => reg.loadByPath("/nonexistent/x.md", true)).toThrow(/not found or unreadable/);
    expect(() => reg.loadByPath("/nonexistent/x.md", true)).toThrow(/<available_subagents> <location>/);
    expect(() => reg.loadByPath("relative", true)).toThrow(/Invalid agent ref/);
    expect(() => reg.loadByPath("relative", true)).toThrow(/<available_subagents>/);
  });

  it("~/ 前缀展开", () => {
    const reg = new AgentRegistry();
    // homedir 被 mock 为 /nonexistent-home-for-tests → 文件必然不存在，验证展开逻辑
    expect(reg.loadByPath("~/agent.md")).toBeUndefined();
  });
});

// ============================================================
// 包内 agents/*.md 数据合规（S2：内置 agent = 包内路径文件）
// ============================================================

describe("builtin agents 数据合规", () => {
  // C5 过渡态收口：10 模板已迁 @zhushanwen/subagent-core/agents/（C1/D-1）——经
  // ./workflows/* 子入口锚点解析 core 包根（与 src/host/pi-host.ts corePackageNpmRoot
  // 同一锚，workspace 与发布形态同径），数据面断言随资产指向 core。
  const CORE_PKG_ROOT = path.resolve(
    path.dirname(createRequire(import.meta.url).resolve("@zhushanwen/subagent-core/workflows/README.md")),
    "..",
  );
  const AGENTS_DIR = path.join(CORE_PKG_ROOT, "agents");
  const CORE = ["explorer", "coder", "reviewer", "debugger", "analyst", "planner", "researcher", "orchestrator", "general-purpose", "doc-reviewer"];

  it("agents/*.md 全部 IF1 解析成功", () => {
    for (const f of fs.readdirSync(AGENTS_DIR).filter((x) => x.endsWith(".md"))) {
      const meta = parseResourceMeta(fs.readFileSync(path.join(AGENTS_DIR, f), "utf-8"), "agent");
      expect(meta?.kind, `${f} parse 失败`).toBe("agent");
    }
  });

  it("核心 agent 均含 when/notFor/examples 且正反各一（lintAgentMeta 无 finding）", () => {
    for (const name of CORE) {
      const meta = parseResourceMeta(fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), "utf-8"), "agent");
      expect(meta, `${name} 解析失败`).not.toBeNull();
      if (meta?.kind !== "agent") continue;
      expect(meta.when, `${name} 缺 when`).toBeDefined();
      expect(meta.notFor, `${name} 缺 notFor`).toBeDefined();
      expect(meta.examples?.length, `${name} 缺 examples`).toBeGreaterThanOrEqual(2);
      expect(meta.examples?.some((e) => e.positive), `${name} 缺正向样本`).toBe(true);
      expect(meta.examples?.some((e) => !e.positive), `${name} 缺反向样本`).toBe(true);
      expect(lintAgentMeta(meta), `${name} examples 不合规`).toEqual([]);
    }
  });

  it("loadByPath 直接加载 core 包内 agent（内置 = 路径文件，无名字查找）", () => {
    const reg = new AgentRegistry();
    const coder = reg.loadByPath(path.join(AGENTS_DIR, "coder.md"));
    expect(coder?.name).toBe("coder");
    expect(coder?.systemPrompt.length).toBeGreaterThan(0);
    // D-5（C1）去 tools 化：模板不再声明 tools 白名单——全部 undefined（工具约束
    // 回归宿主默认面；想要白名单在 <ws>/.agents/agents/ 放同名 .md 覆写）。
    // 本断言拦「tools 字段回流」——模板侧任何 tools 重新声明会在此立即报错。
    for (const name of CORE) {
      expect(
        reg.loadByPath(path.join(AGENTS_DIR, `${name}.md`))?.tools,
        `${name} 模板不应声明 tools`,
      ).toBeUndefined();
    }
  });
});

// ============================================================
// engine 字段（P4 D9：frontmatter 主通道 + 解析期注册表校验）
// ============================================================

describe("parseAgentWithMeta engine 字段（P4 路由）", () => {
  beforeEach(() => {
    // 解析期校验消费注册表——测试内注册假引擎（惰性工厂无副作用）
    clearEngines();
    // 工厂恒 throw：解析期校验只查注册表存在性，不实例化（惰性工厂契约）
    const neverInstantiate = (): EnginePort => {
      throw new Error("parse-time validation must not instantiate engines");
    };
    registerEngine("pi", neverInstantiate);
    registerEngine("zcode", neverInstantiate);
  });
  afterEach(() => {
    clearEngines();
  });

  it("frontmatter engine 进 config.engine（结构化路径，IF1）", () => {
    const { config, meta } = parseAgentWithMeta(
      "/x/reviewer.md",
      `---
name: reviewer
description: review agent
engine: zcode
---
body`,
    );
    expect(config.engine).toBe("zcode");
    expect(meta?.kind === "agent" && meta.engine).toBe("zcode");
  });

  it("IF1 未通过（缺 description）时 legacy fallback 取 engine（配置不丢，与 model 同判）", () => {
    const { config } = parseAgentWithMeta(
      "/x/reviewer.md",
      `---
name: reviewer
engine: zcode
---
body`,
    );
    expect(config.engine).toBe("zcode");
  });

  it("未注册 engine id：解析期抛 EngineNotFoundError，文案含注册清单与文件路径", () => {
    expect(() =>
      parseAgentWithMeta(
        "/x/reviewer.md",
        `---
name: reviewer
description: review agent
engine: nonexistent-engine
---
body`,
      ),
    ).toThrowError(/engine_not_found: engine 'nonexistent-engine'/);
    expect(() =>
      parseAgentWithMeta(
        "/x/reviewer.md",
        `---
name: reviewer
description: review agent
engine: nonexistent-engine
---
body`,
      ),
    ).toThrowError(/Registered engines: pi, zcode/);
    expect(() =>
      parseAgentWithMeta(
        "/x/my-agent.md",
        `---
name: my-agent
description: d
engine: nonexistent-engine
---
body`,
      ),
    ).toThrowError(/Source: \/x\/my-agent\.md/);
  });

  it("已注册 id（pi/zcode）：解析通过，不抛", () => {
    expect(() =>
      parseAgentWithMeta(
        "/x/reviewer.md",
        `---
name: reviewer
description: review agent
engine: pi
---
body`,
      ),
    ).not.toThrow();
  });

  it("无 engine 字段：config.engine 缺省（走全局默认层）", () => {
    const { config } = parseAgentWithMeta(
      "/x/worker.md",
      `---
name: worker
description: d
---
body`,
    );
    expect(config.engine).toBeUndefined();
  });
});
