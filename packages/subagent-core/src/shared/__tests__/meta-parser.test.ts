/**
 * meta-parser 测试（v5 §11.1 / TC1-TC10 + 边界 + exec-review 回归）
 *
 * [P-yaml] 探针由 TC5/TC10 承载：验证 eemeli/yaml 真实抛错对象有 linePos 字段且结构为
 * {line,col}（取自 linePos[0]）。不 mock parseYaml——必须用真实库验证此运行时断言。
 *
 * exec-review 回归：major-1（星斜杠截断）+ minor-2（kind 串类）+ minor-3（description 必填）
 * + minor-4（detail 非字符串）+ minor-5（parameters 非对象）+ minor-6（空块 vs 缺块）+ minor-7（CRLF）。
 *
 * 框架：vitest（项目规范：禁 node:test，import from "vitest"）。
 */
import { describe, expect, it } from "vitest";

import {
  parseResourceMeta,
  parseResourceMetaDetailed,
} from "../meta-parser.ts";
import type { AgentMeta, WorkflowMeta } from "../resource-meta.ts";

// ── 固定 content fixtures ────────────────────────────────────

const VALID_WORKFLOW = `// 顶部可有任意代码注释
/* @pi-meta
name: chain
description: 通用编排三步链
when: 用户要顺序编排
phases: [analyze, transform, synthesize]
parameters:
  type: object
  properties:
    task: { type: string }
  required: [task]
usage: |
  ## 使用说明
  - task 必填
*/
const agent = require("./agent");
`;

const VALID_AGENT = `---
name: code-review
description: 审查代码变更
when: 用户要求 review
notFor: 非 taiji 项目
examples:
  - match: "帮我 review 一下"
    action: 调用 code-review
    positive: true
  - match: 今天天气
    action: 不调用
    positive: false
tools: [read, bash, grep]
model: claude-3.5
---
# code-review agent 正文
`;

const MALFORMED_INDENT = `/* @pi-meta
name: x
description: bad
  description: bad indent
phases: [a]
*/`;

const REGEX_SINGLE_BACKSLASH = `/* @pi-meta
name: rfl
description: 测试正则转义
phases: [Review, Fix]
parameters:
  type: object
  patternProperties:
    "^batch\\d+$": { type: string }
*/`;

const LEGACY_CONST_META = `const meta = {
  name: chain,
  description: 旧格式,
  phases: ["a"]
};
const agent = require("./agent");
`;

const NO_META_BLOCK = `const agent = require("./agent");
// 纯代码，无 @pi-meta
`;

const EMPTY_PI_META = `/* @pi-meta

*/
const x = 1;
`;

const EMPTY_PHASES = `/* @pi-meta
name: x
description: 空 phases
phases: []
*/`;

// ── parseResourceMeta（IF1，discovery）──────────────────────

describe("parseResourceMeta (discovery, fail-safe null)", () => {
  it("TC1: 合法 workflow @pi-meta 返 WorkflowMeta", () => {
    const meta = parseResourceMeta(VALID_WORKFLOW, "workflow");
    expect(meta).not.toBeNull();
    const wf = meta as WorkflowMeta;
    expect(wf.kind).toBe("workflow");
    expect(wf.name).toBe("chain");
    expect(wf.phases).toEqual(["analyze", "transform", "synthesize"]);
    expect(wf.when).toBe("用户要顺序编排");
    expect(wf.parameters).toBeDefined();
    expect(wf.usage).toContain("task 必填");
  });

  it("TC2: 合法 agent frontmatter 返 AgentMeta", () => {
    const meta = parseResourceMeta(VALID_AGENT, "agent");
    expect(meta).not.toBeNull();
    const a = meta as AgentMeta;
    expect(a.kind).toBe("agent");
    expect(a.name).toBe("code-review");
    expect(a.notFor).toBe("非 taiji 项目");
    expect(a.examples).toHaveLength(2);
    expect(a.examples![0]).toEqual({ match: "帮我 review 一下", action: "调用 code-review", positive: true });
    expect(a.examples![1]!.positive).toBe(false);
    expect(a.tools).toEqual(["read", "bash", "grep"]);
    expect(a.model).toBe("claude-3.5");
  });

  it("TC3: malformed YAML（缩进错）返 null，不抛 [P-yaml]", () => {
    expect(() => parseResourceMeta(MALFORMED_INDENT, "workflow")).not.toThrow();
    expect(parseResourceMeta(MALFORMED_INDENT, "workflow")).toBeNull();
  });

  it("TC4: 缺 meta 块返 null", () => {
    expect(parseResourceMeta(NO_META_BLOCK, "workflow")).toBeNull();
  });

  it("TC8（修正）: workflow 字段（phases）当 agent kind 解析，typecheckMeta 串类 reject [minor-2]", () => {
    // 用 frontmatter 包裹 workflow 字段，确保 FRONTMATTER_RE 匹配、typecheckMeta 真正被触达
    const content = `---
name: chainlike
description: has phases but parsed as agent
phases: [analyze, transform]
parameters:
  type: object
---
# agent body`;
    expect(parseResourceMeta(content, "agent")).toBeNull();
  });

  it("TC8b: agent 字段（examples）当 workflow kind 解析，串类 reject [minor-2]", () => {
    const content = `/* @pi-meta
name: x
description: has examples but workflow
phases: [A]
examples:
  - match: m
    action: a
    positive: true
*/`;
    expect(parseResourceMeta(content, "workflow")).toBeNull();
  });

  it("TC9: legacy const meta（无 @pi-meta 块）返 null（无 adapter）[D1]", () => {
    expect(parseResourceMeta(LEGACY_CONST_META, "workflow")).toBeNull();
  });

  it("TC10: patternProperties 单反斜杠正则致 YAML 解析失败返 null [P-yaml]", () => {
    expect(parseResourceMeta(REGEX_SINGLE_BACKSLASH, "workflow")).toBeNull();
  });

  it("边界：空 @pi-meta 块（内容为空）返 null", () => {
    expect(parseResourceMeta(EMPTY_PI_META, "workflow")).toBeNull();
  });

  it("边界：phases: [] 空数组合法（workflow 可无 phase）", () => {
    const meta = parseResourceMeta(EMPTY_PHASES, "workflow");
    expect(meta).not.toBeNull();
    expect((meta as WorkflowMeta).phases).toEqual([]);
  });

  // ── exec-review 回归 ──────────────────────────────────────

  it("major-1: usage 块标量含 */ 不再截断，parameters 不丢失", () => {
    const content = `/* @pi-meta
name: x
description: d
phases: [A]
when: present
usage: |
  see */ for details
parameters:
  type: object
  properties:
    task: { type: string }
*/`;
    const meta = parseResourceMeta(content, "workflow");
    expect(meta).not.toBeNull();
    const wf = meta as WorkflowMeta;
    expect(wf.parameters).toBeDefined(); // major-1：此前被 */ 截断静默丢失
    expect(wf.when).toBe("present");     // 此前同样丢失
    expect(wf.usage).toContain("see */ for details");
  });

  it("major-1b: patternProperties 正则含 * 后接 / 不再误截断", () => {
    const content = `/* @pi-meta
name: re
description: regex
phases: [A]
parameters:
  type: object
  patternProperties:
    "^\\\\d*/\\\\w+$": { type: string }
*/`;
    const meta = parseResourceMeta(content, "workflow");
    expect(meta).not.toBeNull();
    expect((meta as WorkflowMeta).parameters).toBeDefined();
  });

  it("minor-3: 缺 description 返 null（必填，不再静默空串）", () => {
    const content = `/* @pi-meta
name: nodesc
phases: [A]
*/`;
    expect(parseResourceMeta(content, "workflow")).toBeNull();
  });

  it("minor-4: phase detail 非字符串返 null（不再静默丢弃）", () => {
    const content = `/* @pi-meta
name: x
description: d
phases:
  - title: A
    detail: 123
*/`;
    expect(parseResourceMeta(content, "workflow")).toBeNull();
  });

  it("minor-5: parameters 是数组返 null（不再静默当 undefined）", () => {
    const content = `/* @pi-meta
name: x
description: d
phases: [A]
parameters: [a, b]
*/`;
    expect(parseResourceMeta(content, "workflow")).toBeNull();
  });

  it("minor-7: CRLF 行尾 frontmatter 正确提取", () => {
    const content = "---\r\nname: a\r\ndescription: d\r\n---\r\n# body";
    const meta = parseResourceMeta(content, "agent");
    expect(meta).not.toBeNull();
    expect((meta as AgentMeta).name).toBe("a");
  });
});

// ── parseResourceMetaDetailed（IF2，generate 闭环）──────────

describe("parseResourceMetaDetailed (generate, linePos)", () => {
  it("TC6: 合法返 {ok:true, meta}", () => {
    const r = parseResourceMetaDetailed(VALID_WORKFLOW, "workflow");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta.name).toBe("chain");
  });

  it("TC5: malformed YAML 返 {ok:false, error, linePos:{line,col}} [P-yaml]", () => {
    const r = parseResourceMetaDetailed(MALFORMED_INDENT, "workflow");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeTruthy();
      expect(r.linePos).toBeDefined();
      expect(typeof r.linePos!.line).toBe("number");
      expect(typeof r.linePos!.col).toBe("number");
      expect(r.linePos!.line).toBeGreaterThan(0);
    }
  });

  it("TC7: 缺块返 {ok:false, error} 无 linePos", () => {
    const r = parseResourceMetaDetailed(NO_META_BLOCK, "workflow");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.linePos).toBeUndefined();
  });

  it("TC10: 单反斜杠正则返 {ok:false, error 含 escape, linePos} [P-yaml]", () => {
    const r = parseResourceMetaDetailed(REGEX_SINGLE_BACKSLASH, "workflow");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("escape");
      expect(r.linePos).toBeDefined();
      expect(r.linePos!.line).toBeGreaterThan(0);
    }
  });

  it("minor-6: 空块与缺块错误消息区分（空块不报「未找到」）", () => {
    const empty = parseResourceMetaDetailed(EMPTY_PI_META, "workflow");
    const missing = parseResourceMetaDetailed(NO_META_BLOCK, "workflow");
    expect(empty.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (!empty.ok && !missing.ok) {
      // 缺块报「未找到 meta 块」；空块报类型校验失败（块在但内容空/非法）
      expect(missing.error).toContain("未找到");
      expect(empty.error).not.toContain("未找到");
    }
  });
});

// ── typecheckMeta 分支覆盖补充（特征锚定，经 IF1/IF2 公共入口驱动）──
// 此前未覆盖的校验分支逐条锚定返回值与（IF2 的）错误文案，守护行为保持重构。

describe("typecheckMeta 分支覆盖补充（特征锚定）", () => {
  // ── 公共必填 ──────────────────────────────────────────────

  it("公共: name 空串 → null（name 非空字符串）", () => {
    const meta = parseResourceMeta('---\nname: ""\ndescription: d\n---\nbody', "agent");
    expect(meta).toBeNull();
  });

  it("公共: description 非字符串（数字）→ null", () => {
    const meta = parseResourceMeta("---\nname: x\ndescription: 123\n---\nbody", "agent");
    expect(meta).toBeNull();
  });

  it("公共: YAML 顶层标量（非对象）→ null", () => {
    const meta = parseResourceMeta("---\njust a scalar\n---\nbody", "agent");
    expect(meta).toBeNull();
  });

  it("公共: when 非字符串 → 宽容降级为缺席（meta 仍合法，无 when 键）", () => {
    const meta = parseResourceMeta("---\nname: x\ndescription: d\nwhen: 123\n---\nbody", "agent");
    expect(meta).not.toBeNull();
    const a = meta as AgentMeta;
    expect("when" in a).toBe(false);
  });

  it("公共: notFor 非字符串 → 宽容降级为缺席（meta 仍合法，无 notFor 键）", () => {
    const meta = parseResourceMeta(
      "/* @pi-meta\nname: x\ndescription: d\nphases: [A]\nnotFor:\n  - a: 1\n*/",
      "workflow",
    );
    expect(meta).not.toBeNull();
    const wf = meta as WorkflowMeta;
    expect("notFor" in wf).toBe(false);
  });

  // ── workflow 分支 ─────────────────────────────────────────

  it("workflow: phase 对象形态 {title, detail} 合法投影（与字符串元素混排）", () => {
    const meta = parseResourceMeta(
      "/* @pi-meta\nname: x\ndescription: d\nphases:\n  - title: A\n    detail: do a\n  - B\n*/",
      "workflow",
    );
    expect(meta).not.toBeNull();
    const wf = meta as WorkflowMeta;
    expect(wf.phases).toEqual([{ title: "A", detail: "do a" }, "B"]);
  });

  it("workflow: phase 对象缺 title → null（title 非空字符串必填）", () => {
    const meta = parseResourceMeta(
      "/* @pi-meta\nname: x\ndescription: d\nphases:\n  - detail: no title\n*/",
      "workflow",
    );
    expect(meta).toBeNull();
  });

  it("workflow: 串类链非首成员（tools/model/engine）→ reject [minor-2]", () => {
    const meta = parseResourceMeta(
      "/* @pi-meta\nname: x\ndescription: d\nphases: [A]\ntools: [read]\nmodel: m\nengine: e\n*/",
      "workflow",
    );
    expect(meta).toBeNull();
  });

  it("workflow: usage 缺席 → 无 usage 键（零回归）", () => {
    const meta = parseResourceMeta("/* @pi-meta\nname: x\ndescription: d\nphases: [A]\n*/", "workflow");
    expect(meta).not.toBeNull();
    const wf = meta as WorkflowMeta;
    expect("usage" in wf).toBe(false);
  });

  // ── agent 分支 ────────────────────────────────────────────

  it("agent: usage（workflow 专属）出现在 agent → 串类 reject [minor-2]", () => {
    const meta = parseResourceMeta("---\nname: x\ndescription: d\nusage: |\n  notes\n---\nbody", "agent");
    expect(meta).toBeNull();
  });

  it("agent: tools 逗号分隔字符串 → 数组投影（trim + 空段过滤）", () => {
    const meta = parseResourceMeta(
      "---\nname: x\ndescription: d\ntools: read, bash ,, grep\n---\nbody",
      "agent",
    );
    expect(meta).not.toBeNull();
    const a = meta as AgentMeta;
    expect(a.tools).toEqual(["read", "bash", "grep"]);
  });

  it("agent: tools 逗号串全空段（\",\") → 缺席（不进 meta）", () => {
    const meta = parseResourceMeta('---\nname: x\ndescription: d\ntools: ","\n---\nbody', "agent");
    expect(meta).not.toBeNull();
    const a = meta as AgentMeta;
    expect("tools" in a).toBe(false);
  });

  it("agent: tools 非法形态（数字）→ null", () => {
    const meta = parseResourceMeta("---\nname: x\ndescription: d\ntools: 42\n---\nbody", "agent");
    expect(meta).toBeNull();
  });

  it("agent: examples 非数组（字符串）→ null", () => {
    const meta = parseResourceMeta(
      "---\nname: x\ndescription: d\nexamples: not-a-list\n---\nbody",
      "agent",
    );
    expect(meta).toBeNull();
  });

  it("agent: example 元素缺 positive → null（结构不完整不静默丢字段）", () => {
    const meta = parseResourceMeta(
      "---\nname: x\ndescription: d\nexamples:\n  - match: m\n    action: a\n---\nbody",
      "agent",
    );
    expect(meta).toBeNull();
  });

  it("agent: engine 字符串投影", () => {
    const meta = parseResourceMeta("---\nname: x\ndescription: d\nengine: zsw\n---\nbody", "agent");
    expect(meta).not.toBeNull();
    const a = meta as AgentMeta;
    expect(a.engine).toBe("zsw");
  });

  it("agent: maxTurns 非有限数字（.nan）→ null", () => {
    const meta = parseResourceMeta("---\nname: x\ndescription: d\nmaxTurns: .nan\n---\nbody", "agent");
    expect(meta).toBeNull();
  });

  // ── IF2 错误文案逐字节锚定（typecheckMeta 校验失败 / 缺块）──

  it("IF2: 缺块错误文案逐字节锚定", () => {
    const r = parseResourceMetaDetailed("no block here", "workflow");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("未找到 meta 块（缺少 /* @pi-meta */ 或 frontmatter，或闭合 */ 不在行首）");
      expect(r.linePos).toBeUndefined();
    }
  });

  it("IF2: 类型校验失败错误文案逐字节锚定", () => {
    const r = parseResourceMetaDetailed("---\nname: x\n---\nbody", "agent");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("meta 类型校验失败（缺 name/description、phases 非法、kind 字段串类或可选字段类型错）");
      expect(r.linePos).toBeUndefined();
    }
  });
});
