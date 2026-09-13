// src/execution/__tests__/agent-profile.test.ts
//
// parseAgentProfile 宽容解析测试（sink 设计 U2 / D3 / u-core-agent 验收①）。
//
// 字段形态覆盖矩阵（D3 定稿）：单行 key:value、行内数组、block-scalar、
// 多行 `- item` 列表、无 frontmatter 宽容降级不抛；另含 legacy fallback
// （meta=null 单行兜底）与 parseResourceMeta 严格层新字段投影断言
// （AgentMeta 扩 maxTurns/disallowedTools/skills 的 typecheckMeta 行为）。

import { describe, expect, it } from "vitest";

import { parseResourceMeta } from "../../shared/meta-parser.ts";
import { parseAgentProfile } from "../assembly/agent-registry.ts";

describe("parseAgentProfile（D3 宽容解析）", () => {
  it("单行 key:value 全字段（IF1 通过）", () => {
    const profile = parseAgentProfile(
      `---
name: coder
description: coding agent
model: anthropic/claude-3.5-sonnet
thinkingLevel: high
tools: read, bash
maxTurns: 2
disallowedTools: write, edit
skills: code-review
---
body text`,
      "/x/coder.md",
    );
    expect(profile.name).toBe("coder");
    expect(profile.description).toBe("coding agent");
    expect(profile.body).toBe("body text");
    expect(profile.model).toBe("anthropic/claude-3.5-sonnet");
    expect(profile.thinkingLevel).toBe("high");
    expect(profile.tools).toEqual(["read", "bash"]);
    expect(profile.maxTurns).toBe(2);
    expect(profile.disallowedTools).toEqual(["write", "edit"]);
    expect(profile.skills).toEqual(["code-review"]);
    expect(profile.meta).not.toBeNull();
    expect(profile.warnings).toEqual([]);
  });

  it("行内数组形态（tools: [read, bash]）", () => {
    const profile = parseAgentProfile(
      `---
name: coder
description: coding agent
tools: [read, bash]
---
body`,
      "/x/coder.md",
    );
    expect(profile.tools).toEqual(["read", "bash"]);
    expect(profile.meta).not.toBeNull();
  });

  it("block-scalar description 完整保留（多行描述不截断）", () => {
    const profile = parseAgentProfile(
      `---
name: reviewer
description: |
  first line of description
  second line of description
---
body`,
      "/x/reviewer.md",
    );
    // `|` clip chomping 保留单个末尾换行（eemeli/yaml 标准行为）
    expect(profile.description).toBe("first line of description\nsecond line of description\n");
    expect(profile.meta?.description).toBe(profile.description);
  });

  it("多行 `- item` 列表形态（tools/disallowedTools/skills）", () => {
    const profile = parseAgentProfile(
      `---
name: builder
description: build agent
tools:
  - read
  - bash
disallowedTools:
  - write
skills:
  - code-review
  - test-runner
---
body`,
      "/x/builder.md",
    );
    expect(profile.tools).toEqual(["read", "bash"]);
    expect(profile.disallowedTools).toEqual(["write"]);
    expect(profile.skills).toEqual(["code-review", "test-runner"]);
    expect(profile.maxTurns).toBeUndefined();
  });

  it("无 frontmatter：宽容降级不抛——name=stem、description 空串、全文 body、无 warning", () => {
    const profile = parseAgentProfile("# README\n\nplain markdown.", "/x/README.md");
    expect(profile.name).toBe("README");
    expect(profile.description).toBe("");
    expect(profile.body).toBe("# README\n\nplain markdown.");
    expect(profile.meta).toBeNull();
    expect(profile.warnings).toEqual([]);
  });

  it("未闭合 frontmatter：name 经 legacy fallback、全文作 body、warning 可见", () => {
    const text = `---\nname: broken\nmodel: x/y`;
    const profile = parseAgentProfile(text, "/x/broken.md");
    expect(profile.name).toBe("broken");
    expect(profile.body).toBe(text);
    expect(profile.meta).toBeNull();
    expect(profile.warnings).toHaveLength(1);
    expect(profile.warnings[0]).toContain("未闭合");
  });

  it("IF1 失败（缺 description）：执行字段经单行 legacy fallback 不丢失 + warning", () => {
    const profile = parseAgentProfile(
      `---
name: legacy
model: anthropic/claude-3.5-sonnet
tools: read, bash
maxTurns: 5
---
body text`,
      "/x/legacy.md",
    );
    expect(profile.meta).toBeNull();
    expect(profile.name).toBe("legacy");
    expect(profile.description).toBe("");
    expect(profile.model).toBe("anthropic/claude-3.5-sonnet");
    expect(profile.tools).toEqual(["read", "bash"]);
    // legacy fallback 只认字符串形态：`maxTurns: 5` 单行 → Number 换算
    expect(profile.maxTurns).toBe(5);
    expect(profile.warnings).toHaveLength(1);
    expect(profile.warnings[0]).toContain("legacy fallback");
    expect(profile.body).toBe("body text");
  });

  it("IF1 失败 + maxTurns 非数字：忽略该字段并追加 warning（不抛）", () => {
    const profile = parseAgentProfile(
      `---
name: weird
maxTurns: many
---
body`,
      "/x/weird.md",
    );
    expect(profile.meta).toBeNull();
    expect(profile.maxTurns).toBeUndefined();
    expect(profile.warnings.some((w) => w.includes("maxTurns"))).toBe(true);
  });

  it("name 缺省 stem（frontmatter 无 name 字段且 IF1 失败时）", () => {
    const profile = parseAgentProfile("---\nmodel: x/y\n---\nbody", "/x/unnamed.md");
    expect(profile.name).toBe("unnamed");
    expect(profile.model).toBe("x/y");
  });
});

describe("parseResourceMeta 严格层新字段投影（AgentMeta D3 扩展的 typecheckMeta 行为）", () => {
  it("数字 maxTurns + 数组 disallowedTools/skills 投影进 AgentMeta", () => {
    const meta = parseResourceMeta(
      `---
name: coder
description: coding agent
maxTurns: 2
disallowedTools: [write]
skills:
  - code-review
---
body`,
      "agent",
    );
    expect(meta).not.toBeNull();
    if (meta?.kind !== "agent") return expect.fail("kind 应为 agent");
    expect(meta.maxTurns).toBe(2);
    expect(meta.disallowedTools).toEqual(["write"]);
    expect(meta.skills).toEqual(["code-review"]);
  });

  it("maxTurns 非有限数字 → reject（严格层不静默丢弃非法字段）", () => {
    const meta = parseResourceMeta(
      "---\nname: x\ndescription: y\nmaxTurns: many\n---\nbody",
      "agent",
    );
    expect(meta).toBeNull();
  });

  it("disallowedTools 数组含非字符串 → reject", () => {
    const meta = parseResourceMeta(
      "---\nname: x\ndescription: y\ndisallowedTools: [write, 42]\n---\nbody",
      "agent",
    );
    expect(meta).toBeNull();
  });

  it("disallowedTools/skills 空数组 → 键保留为 []（与 tools: [] 空列表语义一致）", () => {
    const meta = parseResourceMeta(
      "---\nname: x\ndescription: y\ntools: []\ndisallowedTools: []\nskills: []\n---\nbody",
      "agent",
    );
    expect(meta).not.toBeNull();
    if (meta?.kind !== "agent") return expect.fail("kind 应为 agent");
    expect("disallowedTools" in meta).toBe(true);
    expect(meta.disallowedTools).toEqual([]);
    expect("skills" in meta).toBe(true);
    expect(meta.skills).toEqual([]);
    // 同 fixture 的 tools 基准：空数组三字段族同语义
    expect("tools" in meta).toBe(true);
    expect(meta.tools).toEqual([]);
  });

  it("workflow meta 含 agent 专属新字段 → 串类 reject", () => {
    const meta = parseResourceMeta(
      "/* @pi-meta\nname: wf\ndescription: d\nphases: [a]\nmaxTurns: 2\n*/\ncode",
      "workflow",
    );
    expect(meta).toBeNull();
  });

  it("缺 maxTurns/disallowedTools/skills 时 AgentMeta 不出现这些键（零回归）", () => {
    const meta = parseResourceMeta(
      "---\nname: x\ndescription: y\n---\nbody",
      "agent",
    );
    expect(meta).not.toBeNull();
    if (meta?.kind !== "agent") return expect.fail("kind 应为 agent");
    expect("maxTurns" in meta).toBe(false);
    expect("disallowedTools" in meta).toBe(false);
    expect("skills" in meta).toBe(false);
  });
});
