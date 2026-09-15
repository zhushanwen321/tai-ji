/**
 * script-lint — 单元测试。
 *
 * lintScript 是纯函数、零副作用、零 IO，直接传入源码字符串即可。
 *
 * 覆盖：入口检查、result.output/outputSchema/文件状态、bare async IIFE、
 *      多错误同时存在、注释行跳过。
 *
 * 【差异说明】源码中实际不存在「未闭合括号」/「嵌套括号深度」检查——
 * lintScript 是 API 误用 lint（非语法 lint），不做括号配对。
 * 因此原任务清单的对应条目已替换为实际存在的检查项（IIFE / outputSchema 等）。
 */
import { describe, it, expect } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lintAgentMeta, lintScript } from "../script-lint.ts";
import type { LintFinding } from "../script-lint.ts";
import { parseResourceMeta } from "../../shared/meta-parser.ts";

const WORKFLOWS_DIR = join(__dirname, "../../../workflows");

/** 取所有 error 级 finding。 */
function errors(findings: LintFinding[]): LintFinding[] {
  return findings.filter((f) => f.severity === "error");
}

/** 取所有 warning 级 finding。 */
function warnings(findings: LintFinding[]): LintFinding[] {
  return findings.filter((f) => f.severity === "warning");
}

// ── 基础验证 ──────────────────────────────────────────────────

describe("合法脚本通过", () => {
  it("包含 agent() 调用且无其他问题 → valid=true", () => {
    const src = `const meta = { name: "x", description: "d" };\nawait agent({ prompt: "do something" });\n`;
    const result = lintScript(src);

    expect(result.valid).toBe(true);
    expect(errors(result.findings)).toHaveLength(0);
  });

  it("parallel() 也是合法入口", () => {
    const src = `await parallel([\n  { prompt: "a" },\n  { prompt: "b" }\n]);\n`;
    const result = lintScript(src);

    expect(result.valid).toBe(true);
  });

  it("pipeline() 也是合法入口", () => {
    const src = `await pipeline({ prompt: "x" });\n`;
    const result = lintScript(src);

    expect(result.valid).toBe(true);
  });
});

// ── 入口检查 ──────────────────────────────────────────────────

describe("缺入口 — 必须含 agent/parallel/pipeline 之一", () => {
  it("不含任何入口 → 报 error", () => {
    const src = `const x = 1;\nconsole.log("no orchestration here");\n`;
    const result = lintScript(src);

    expect(result.valid).toBe(false);
    const errs = errors(result.findings);
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/must call agent.*parallel.*pipeline/);
  });

  it("错误信息建议添加 agent/parallel/pipeline", () => {
    const src = `const x = 1;\n`;
    const result = lintScript(src);

    const finding = errors(result.findings)[0];
    expect(finding.suggestion).toMatch(/agent\(\).*parallel\(\).*pipeline\(\)/);
  });

  it("类似 agent 字符串但不构成调用不满足入口（agentX( )）", () => {
    const src = `const meta = {};\nagentX("not a real agent call");\n`;
    const result = lintScript(src);

    expect(result.valid).toBe(false);
  });
});

// ── result.output 等错误字段 ───────────────────────────────────

describe("result.output / parsedOutput / content 错误访问", () => {
  it("result.output → error", () => {
    const src = `const out = await agent({ prompt: "x" });\nconst v = result.output;\n`;
    const result = lintScript(src);

    const errs = errors(result.findings);
    const r = errs.find((f) => f.message.includes("result.output"));
    expect(r).toBeDefined();
    expect(r!.line).toBe(2);
  });

  it("result.parsedOutput → error", () => {
    const src = `await agent({ prompt: "x" });\nreturn result.parsedOutput;\n`;
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => f.message.includes("result.parsedOutput")))
      .toBe(true);
  });

  it("result.content → error", () => {
    const src = `await agent({ prompt: "x" });\nconsole.log(result.content);\n`;
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => f.message.includes("result.content")))
      .toBe(true);
  });

  it("result 的三种错误字段都建议用 await agent() 直接取值", () => {
    const src = `await agent({ prompt: "x" });\nresult.output;\nresult.parsedOutput;\nresult.content;\n`;
    const result = lintScript(src);

    for (const f of errors(result.findings)) {
      expect(f.suggestion).toMatch(/await agent/);
    }
  });
});

// ── outputSchema 作为 key（agent 选项误用）─────────────────────

describe("outputSchema 作为 agent 选项 key", () => {
  it("简写 outputSchema 作为 key → error", () => {
    const src = `await agent({\n  prompt: "x",\n  outputSchema,\n});\n`;
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => f.message.includes("outputSchema"))).toBe(true);
  });

  it("显式 outputSchema: ... 作为 key → error", () => {
    const src = `await agent({\n  prompt: "x",\n  outputSchema: foo,\n});\n`;
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => f.message.includes("outputSchema"))).toBe(true);
  });

  it("schema: outputSchema 作为 value → 不报 error", () => {
    // outputSchema 出现在 value 位置是合法的（schema 才是正确 key）
    const src = `await agent({\n  prompt: "x",\n  schema: outputSchema,\n});\n`;
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => f.message.includes("outputSchema")))
      .toBe(false);
  });
});

// ── 文件状态（warning）─────────────────────────────────────────

describe("文件传状态 / unlinkSync — warning", () => {
  it("readFileSync 读 STATE 文件 → warning", () => {
    const src = `await agent({ prompt: "x" });\nconst s = readFileSync(STATE_PATH, "utf-8");\n`;
    const result = lintScript(src);

    const ws = warnings(result.findings);
    // 实际 message 是 "Reading a state file between agent calls is fragile..."（不含字面 "readFileSync"）
    expect(ws.some((w) => /state file.*fragile/i.test(w.message))).toBe(true);
  });

  it("unlinkSync 清理 state → warning", () => {
    const src = `await agent({ prompt: "x" });\nunlinkSync(stateFile);\n`;
    const result = lintScript(src);

    const ws = warnings(result.findings);
    expect(ws.some((w) => w.message.includes("unlinkSync"))).toBe(true);
  });

  it("warning 不影响 valid 判定（valid 只看 error）", () => {
    const src = `await agent({ prompt: "x" });\nunlinkSync(stateFile);\n`;
    const result = lintScript(src);

    expect(result.valid).toBe(true);
    expect(warnings(result.findings).length).toBeGreaterThan(0);
  });
});

// ── bare async IIFE ───────────────────────────────────────────

describe("顶层未 await 的异步 IIFE + 内部调 agent — 子进程被提前 kill", () => {
  it("孤立 fire-and-forget IIFE 内调 agent → error", () => {
    const src = [
      `(async function main() {`,
      `  await agent({ prompt: "x" });`,
      `})();`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    const errs = errors(result.findings);
    const iifeFinding = errs.find((f) => /fire-and-forget/i.test(f.message));
    expect(iifeFinding).toBeDefined();
  });

  it("await 前缀的 IIFE 内调 agent → 不报 error（warning 或无）", () => {
    const src = [
      `await (async () => {`,
      `  await agent({ prompt: "x" });`,
      `})();`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => /fire-and-forget/i.test(f.message)))
      .toBe(false);
  });

  it("IIFE 被赋值/返回接住 → warning（非 error）", () => {
    const src = [
      `const p = (async () => {`,
      `  await agent({ prompt: "x" });`,
      `})();`,
      `await p;`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => /fire-and-forget/i.test(f.message)))
      .toBe(false);
    expect(warnings(result.findings).some((f) => /assigned|returned/i.test(f.message)))
      .toBe(true);
  });

  it("IIFE 内不含 agent/parallel/pipeline → 不报（合法的纯 I/O IIFE）", () => {
    const src = [
      `(async () => {`,
      `  await new Promise(r => setTimeout(r, 100));`,
      `})();`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    // 无 entry point → 入口检查报 error；但不应有 IIFE error
    const iifeErrors = errors(result.findings).filter((f) => /iife|fire-and-forget/i.test(f.message));
    expect(iifeErrors).toHaveLength(0);
  });
});

// ── 注释/字符串内的模式不被计入 ──────────────────────────────

describe("注释行内的模式跳过", () => {
  it("// 注释中的 result.output 不报", () => {
    const src = [
      `await agent({ prompt: "x" });`,
      `// here we discuss result.output as a concept`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => f.message.includes("result.output")))
      .toBe(false);
  });

  it("/* 块注释行内的 result.output 不报", () => {
    const src = [
      `await agent({ prompt: "x" });`,
      `/* block comment mentions result.output on purpose */`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => f.message.includes("result.output")))
      .toBe(false);
  });

  it("* 续行注释中的 result.parsedOutput 不报", () => {
    const src = [
      `await agent({ prompt: "x" });`,
      `/**`,
      ` * result.parsedOutput is intentionally mentioned here`,
      ` */`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => f.message.includes("result.parsedOutput")))
      .toBe(false);
  });

  it("注释中的 readFileSync(STATE) 不报 warning", () => {
    const src = [
      `await agent({ prompt: "x" });`,
      `// we used to readFileSync(STATE) but no longer`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(warnings(result.findings).some((w) => /state file/i.test(w.message)))
      .toBe(false);
  });
});

// ── 多错误同时存在 ────────────────────────────────────────────

describe("多种错误同时存在", () => {
  it("缺入口 + result.output + readFileSync 一起报", () => {
    const src = [
      `const x = result.output;`,
      `const s = readFileSync(STATE, "utf-8");`,
      `console.log(x, s);`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    const msgs = result.findings.map((f) => f.message).join("\n");
    expect(result.valid).toBe(false);
    expect(msgs).toMatch(/must call agent.*parallel.*pipeline/);
    expect(msgs).toMatch(/result\.output/);
    // readFileSync(STATE) 触发的 warning 文案是 "Reading a state file..."
    expect(msgs).toMatch(/state file/i);
  });

  it("result.output + result.content + outputSchema 三种错误同报", () => {
    const src = [
      `await agent({`,
      `  prompt: "x",`,
      `  outputSchema,`,
      `});`,
      `const a = result.output;`,
      `const b = result.content;`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    const msgs = result.findings.map((f) => f.message).join("\n");
    expect(msgs).toMatch(/result\.output/);
    expect(msgs).toMatch(/result\.content/);
    expect(msgs).toMatch(/outputSchema/);
  });

  it("findings 按行号升序排列（稳定输出）", () => {
    const src = [
      `await agent({ prompt: "x" });`,           // line 1
      `const a = result.content;`,                // line 2 → 应在 outputSchema(line 5) 之前
      `const b = result.output;`,                 // line 3
      `await agent({`,
      `  prompt: "y",`,
      `  outputSchema,`,                          // line 6
      `});`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    const lines = result.findings.map((f) => f.line);
    const sorted = [...lines].sort((a, b) => a - b);
    expect(lines).toEqual(sorted);
  });
});

// ── agent description / meta.phases / phase 一致性（新增 warning 检查）─

describe("agent() 缺 description/label — warning", () => {
  it("agent 无 description/label → 1 warning", () => {
    const src = `await agent({ prompt: "x" });\n`;
    const result = lintScript(src);

    const descWarnings = warnings(result.findings).filter((w) =>
      /description.*unnamed/i.test(w.message));
    expect(descWarnings).toHaveLength(1);
    expect(descWarnings[0].line).toBe(1);
  });

  it("agent 有 description → 0 此类 warning", () => {
    const src = `await agent({ prompt: "x", description: "review-diff" });\n`;
    const result = lintScript(src);

    expect(warnings(result.findings).some((w) => /description.*unnamed/i.test(w.message)))
      .toBe(false);
  });

  it("agent 有 label（description 别名）→ 0 此类 warning", () => {
    const src = `await agent({ prompt: "x", label: "review-diff" });\n`;
    const result = lintScript(src);

    expect(warnings(result.findings).some((w) => /description.*unnamed/i.test(w.message)))
      .toBe(false);
  });
});

// ── MF-4 重构核心回归：字符串剔除 / 非字面量实参跳过 ──────────────
//
// review-fix-loop L281 误报根因：字符串字面量里的 "agent(s)" 被 `\bagent\s*\(` 命中，
// 误开 agent 调用范围；三连误报根因：agent(callVar) 非字面量实参在调用点静态不可见。
// forEachAgentCallRange 对两者都有专门分支（stripStringsAndComments / argTail 非 `{` 跳过），
// 下面用例锁定这些新增逻辑（MF-3）。

describe("MF-4 回归：字符串字面量里的 agent(...) 不误触发", () => {
  it("`const s = \"agent(s)\";` 字符串不触发 description 检测（review-fix-loop L281 回归）", () => {
    const src = [
      `const s = "agent(s)";`,
      `await agent({ prompt: "x", description: "d" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    // 字符串不产生幻影调用范围：真实调用只有 1 个且有 description → 0 warning
    expect(warnings(result.findings).filter((w) => /description.*unnamed/i.test(w.message)))
      .toHaveLength(0);
    // 也不产生 outputSchema 等连带误报
    expect(errors(result.findings)).toHaveLength(0);
  });

  it("字符串字面量里含完整调用形态 agent({...}) 同样不误触发（剔除逻辑真正生效的用例）", () => {
    // 若 stripStringsAndComments 失效，此串会被当成字面量调用（argTail 以 { 开头）
    // 并因缺 description 报 warning——本用例即失败
    const src = [
      `const s = "agent({ prompt: 'x' })";`,
      `await agent({ prompt: "x", description: "d" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(warnings(result.findings).filter((w) => /description.*unnamed/i.test(w.message)))
      .toHaveLength(0);
  });

  it("模板串内 agent({...}) 完整调用形态不误触发（反引号剔除路径）", () => {
    // MF-4 既有用例只覆盖双引号字面量；workflow 脚本 prompt 常用模板串（含 ${} 插值）。
    // 若 `...` 反引号剔除失效，模板串里的 agent({...}) 会开幻影调用范围并误报缺 description
    const src = [
      "const prompt = `agent({ prompt: '${x}' })`;",
      `await agent({ prompt: "x", description: "d" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(warnings(result.findings).filter((w) => /description.*unnamed/i.test(w.message)))
      .toHaveLength(0);
    expect(errors(result.findings)).toHaveLength(0);
  });

  it("块注释内 agent({...}) 完整调用形态不误触发（/* */ 剔除路径）", () => {
    // 行首 /* 注释由行级跳过兜底；行尾块注释（非行首前缀）走 stripStringsAndComments 的
    // /* */ 剔除路径——若失效，注释里的 agent({...}) 会开幻影调用范围并误报缺 description
    const src = [
      `/* agent({ prompt: 'x' }) */`,
      `const s = "x"; /* agent({ prompt: 'y' }) */`,
      `await agent({ prompt: "x", description: "d" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(warnings(result.findings).filter((w) => /description.*unnamed/i.test(w.message)))
      .toHaveLength(0);
    expect(errors(result.findings)).toHaveLength(0);
  });
});

describe("MF-4 回归：非字面量实参 agent(callVar) / agent(expr()) 跳过", () => {
  it("agent(callVar) 不产生 description warning，且不误伤后续真实 agent 调用", () => {
    const src = [
      `const call = { prompt: "x" };`,
      `await agent(call);`,
      `await agent({ prompt: "y", description: "d" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    // 三连误报根因：非字面量实参被当成缺 description 报 warning
    expect(warnings(result.findings).filter((w) => /description.*unnamed/i.test(w.message)))
      .toHaveLength(0);
  });

  it("agent(expr()) 表达式实参同样跳过", () => {
    const src = [
      `await agent(buildCall());`,
      `await agent({ prompt: "y", description: "d" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(warnings(result.findings).filter((w) => /description.*unnamed/i.test(w.message)))
      .toHaveLength(0);
  });

  it("非字面量实参 + 后续真实调用缺 description → 只对真实调用报 1 条", () => {
    // 跳过逻辑不能吞掉后面真正缺 description 的调用
    const src = [
      `await agent(call);`,
      `await agent({ prompt: "y" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    const descWarnings = warnings(result.findings).filter((w) => /description.*unnamed/i.test(w.message));
    expect(descWarnings).toHaveLength(1);
    expect(descWarnings[0].line).toBe(2);
  });

  it("`agent(` 换行 `{` 的多行字面量调用保留追踪（argTail 为空分支）", () => {
    // agent( 与 { 分离两行：argTail 为空不跳过，范围跨三行闭合——缺 description
    // 报 1 条且行号落在调用起点（锚定 matchAgentCallHead 的空 argTail 保留路径）
    const src = [
      `await agent(`,
      `  { prompt: "x" }`,
      `);`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    const descWarnings = warnings(result.findings).filter((w) => /description.*unnamed/i.test(w.message));
    expect(descWarnings).toHaveLength(1);
    expect(descWarnings[0].line).toBe(1);
  });
});

// ── MF-4 回归：checkAgentDescription 的两个跳过分支 ────────────────

describe("MF-4 回归：展开形态 / schema 内嵌 description", () => {
  it("agent({ ...call, agent: ... }) 展开形态 → 0 description warning（review-fix-loop 三连误报根因修复点）", () => {
    const src = [
      `const call = { prompt: "x", model: "m" };`,
      `await agent({ ...call, agent: "reviewer" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    // 展开形态 description 来自运行时对象、调用点静态不可见——无法验证即不报
    expect(warnings(result.findings).filter((w) => /description.*unnamed/i.test(w.message)))
      .toHaveLength(0);
  });

  it("多行 agent 调用内 schema properties 含 description 字符串 → 仍报「无 description」warning（I-10 回归）", () => {
    const src = [
      `await agent({`,
      `  prompt: "x",`,
      `  schema: {`,
      `    type: "object",`,
      `    properties: {`,
      `      result: { type: "string", description: "the result" },`,
      `    },`,
      `  },`,
      `});`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    // schema 内嵌的 description 是 JSON Schema 字段说明，不是 agent 选项——
    // 若被误判为「已提供」则漏报（无 warning），本用例锁定仍报 warning
    const descWarnings = warnings(result.findings).filter((w) => /description.*unnamed/i.test(w.message));
    expect(descWarnings).toHaveLength(1);
    expect(descWarnings[0].line).toBe(1);
  });

  it("schema 块剔除后，真正的 agent 选项 description 仍被识别（不误伤）", () => {
    const src = [
      `await agent({`,
      `  prompt: "x",`,
      `  schema: { properties: { r: { description: "d" } } },`,
      `  description: "review-diff",`,
      `});`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(warnings(result.findings).filter((w) => /description.*unnamed/i.test(w.message)))
      .toHaveLength(0);
  });
});

describe("meta.phases 非字符串数组 — warning", () => {
  it("phases: [{...}] 对象数组 → warning", () => {
    const src = [
      `const meta = { phases: [{ title: "a" }, { title: "b" }] };`,
      `await agent({ prompt: "x", description: "d" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(warnings(result.findings).some((w) => /meta\.phases.*string array/i.test(w.message)))
      .toBe(true);
  });

  it("phases: ['a'] 字符串数组 → 0 此类 warning", () => {
    const src = [
      `const meta = { phases: ["a"] };`,
      `phase("a");`,
      `await agent({ prompt: "x", description: "d" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(warnings(result.findings).some((w) => /meta\.phases.*string array/i.test(w.message)))
      .toBe(false);
  });

  it("多行对象数组（phases: [ 换行 { ... }）→ warning（MF-5 跨行匹配）", () => {
    const src = [
      `const meta = { phases: [`,
      `  { title: "a" },`,
      `  { title: "b" },`,
      `] };`,
      `await agent({ prompt: "x", description: "d" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(warnings(result.findings).some((w) => /meta\.phases.*string array/i.test(w.message)))
      .toBe(true);
  });

  it("多行字符串数组（phases: [ 换行 'a' ]）→ 0 此类 warning", () => {
    const src = [
      `const meta = { phases: [`,
      `  "a",`,
      `] };`,
      `phase("a");`,
      `await agent({ prompt: "x", description: "d" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(warnings(result.findings).some((w) => /meta\.phases.*string array/i.test(w.message)))
      .toBe(false);
  });
});

describe("声明 phases 与 phase() 调用一致性 — warning", () => {
  it("声明 + 调用一致 → 0 此类 warning", () => {
    const src = [
      `const meta = { phases: ["review"] };`,
      `phase("review");`,
      `await agent({ prompt: "x", description: "d" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(warnings(result.findings).some((w) =>
      /never set via phase|called but not in meta\.phases/i.test(w.message))).toBe(false);
  });

  it("声明了但从不 phase() 调用 → warning", () => {
    const src = [
      `const meta = { phases: ["review", "fix"] };`,
      `await agent({ prompt: "x", description: "d" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(warnings(result.findings).some((w) => /never set via phase/i.test(w.message)))
      .toBe(true);
  });

  it("phase() 调用了但未声明 → warning", () => {
    const src = [
      `const meta = { phases: ["review"] };`,
      `phase("fix");`,
      `await agent({ prompt: "x", description: "d" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(warnings(result.findings).some((w) => /called but not in meta\.phases/i.test(w.message)))
      .toBe(true);
  });

  it("对象数组 phases 不触发一致性 warning（由 checkMetaPhases 负责）", () => {
    // 对象数组场景：checkPhaseConsistency 应跳过提取，不产生 never-set warning
    const src = [
      `const meta = { phases: [{ title: "a" }] };`,
      `await agent({ prompt: "x", description: "d" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(warnings(result.findings).some((w) => /never set via phase/i.test(w.message)))
      .toBe(false);
  });

  it("无 phases 声明 + 无 phase() 调用 → 0 warning（skip 分支）", () => {
    // checkPhaseConsistency 的 declared/called 都为空 → 提前 return（脚本不使用 phase 机制）。
    // 断言用全量 warning 而非 message 正则过滤——skip 分支若产生 spurious warning 也会被捕获
    const src = [
      `const meta = { name: "x" };`,
      `await agent({ prompt: "x", description: "d" });`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(warnings(result.findings)).toHaveLength(0);
  });
});

// ── m4 W1-W5：meta 质量（SSOT lint） ─────────────────────────

describe("m4 W1-W5: meta 质量 lint", () => {
  const wf = (meta: string, body = 'await agent({ prompt: "x" });') =>
    `/* @pi-meta\n${meta}\n*/\n${body}`;

  it("TC5 W1: 已声明参数名 :/= 形态 → error；非参数 prose 不误报", () => {
    // 参数名集合 = properties keys + patternProperties word 前缀
    const bad = lintScript(
      wf(
        'name: w\ndescription: "targetType: git-diff 用法"\nphases: [a]\nparameters:\n  type: object\n  properties:\n    targetType: { type: string }\n  required: [targetType]',
      ),
    );
    expect(errors(bad.findings).some((f) => f.message.includes("targetType"))).toBe(true);

    // note:/a=b 非参数 → 不误报（评审探针实测形态匹配误报面）
    const good = lintScript(
      wf(
        'name: w\ndescription: "note: fix agent 与 batchN 互斥，见 a=b 说明"\nphases: [a]\nparameters:\n  type: object\n  properties:\n    targetType: { type: string }\n  required: [targetType]',
      ),
    );
    expect(errors(good.findings).length).toBe(0);
  });

  it("TC5b W1: patternProperties word 前缀参数名（batch）也检查", () => {
    const bad = lintScript(
      wf(
        'name: w\ndescription: "batch=high 模式"\nphases: [a]\nparameters:\n  type: object\n  patternProperties:\n    "^batch\\\\d+$": { type: string }',
      ),
    );
    expect(errors(bad.findings).some((f) => f.message.includes("batch"))).toBe(true);
  });

  it("TC6 W2: >200 字符 → error；200 边界通过", () => {
    const over = lintScript(
      wf('name: w\ndescription: "' + "x".repeat(201) + '"\nphases: [a]'),
    );
    expect(errors(over.findings).some((f) => f.message.includes("200"))).toBe(true);
    const at = lintScript(
      wf('name: w\ndescription: "' + "x".repeat(200) + '"\nphases: [a]'),
    );
    expect(errors(at.findings).length).toBe(0);
  });

  it("TC7 W3: 括号内句号/缩写剥离后不报；括号外多句报", () => {
    // 括号内 e.g. + 句号 → 剥离后单句无 finding
    const paren = lintScript(
      wf('name: w\ndescription: "多批串行循环（批内并行 review，e.g. 每批 3 视角）"\nphases: [a]'),
    );
    expect(errors(paren.findings).length).toBe(0);
    // 括号外两个句号 → error
    const multi = lintScript(
      wf('name: w\ndescription: "第一句。第二句"\nphases: [a]'),
    );
    expect(errors(multi.findings).some((f) => f.message.includes("单句"))).toBe(true);
  });

  it("TC8 W4: lintAgentMeta positive 四形态", () => {
    const meta = (examples: unknown) =>
      ({ kind: "agent", name: "a", description: "d", examples }) as never;
    // 正反各一 → 无 finding
    expect(
      lintAgentMeta(
        meta([{ match: "review 代码", action: "reviewer", positive: true }, { match: "天气", action: "x", positive: false }]),
      ).length,
    ).toBe(0);
    // 全正向 → error
    expect(
      lintAgentMeta(
        meta([{ match: "a", action: "x", positive: true }, { match: "b", action: "y", positive: true }]),
      ).length,
    ).toBe(1);
    // [] → error
    expect(lintAgentMeta(meta([])).length).toBe(1);
    // 缺失 → 无 finding（WQ1：未迁移 agent 不报错）
    expect(lintAgentMeta(meta(undefined)).length).toBe(0);
  });

  it("TC8a: W4 EXAMPLES_MAX 边界——3/4 条合法，5 条 → finding", () => {
    const meta = (examples: unknown) =>
      ({ kind: "agent", name: "a", description: "d", examples }) as never;
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        match: `m${i}`,
        action: "x",
        positive: i % 2 === 0,
      }));
    expect(lintAgentMeta(meta(mk(3))).length).toBe(0); // 3 条合法
    expect(lintAgentMeta(meta(mk(4))).length).toBe(0); // 4 条合法（上限）
    expect(lintAgentMeta(meta(mk(5))).length).toBe(1); // 5 条超上限
  });

  it("TC8b: W4 EXAMPLES_MAX——examples 超上限（5 条）→ finding", () => {
    const meta = (examples: unknown) =>
      ({ kind: "agent", name: "a", description: "d", examples }) as never;
    const five = [
      { match: "a", action: "x", positive: true },
      { match: "b", action: "x", positive: false },
      { match: "c", action: "x", positive: true },
      { match: "d", action: "x", positive: false },
      { match: "e", action: "x", positive: true },
    ];
    const findings = lintAgentMeta(meta(five));
    expect(findings.length).toBe(1);
    expect(findings[0]!.message).toContain("上限");
  });

  it("TC9: 5 内置真实 workflow 过 W1-W5（lintScript valid 无 meta 质量 error）", () => {
    const files = ["chain", "parallel", "scatter-gather", "map-reduce", "review-fix-loop"];
    for (const f of files) {
      const src = readFileSync(join(WORKFLOWS_DIR, `${f}.js`), "utf-8");
      // F11：先断言 meta 真实解析成功——防 parse 失败时 W1-W3 整体跳过真空通过
      const meta = parseResourceMeta(src, "workflow");
      expect(meta, `${f} meta 解析`).not.toBeNull();
      const result = lintScript(src);
      const qualityErrors = errors(result.findings).filter((x) => x.message.includes("meta."));
      expect(qualityErrors, `${f} meta 质量`).toEqual([]);
    }
  });

  it("F2 回归: 参数名含未配对 [ 不崩溃（RegExp 注入）", () => {
    const src = wf(
      'name: w\ndescription: "x[ 参数说明"\nphases: [a]\nparameters:\n  type: object\n  properties:\n    "x[": { type: string }\n  required: ["x["]',
    );
    expect(() => lintScript(src)).not.toThrow();
  });

  it("F6 回归: 子串词缀不误报（task 不命中 subtask:）", () => {
    const src = wf(
      'name: w\ndescription: "subtask: 需要分解"\nphases: [a]\nparameters:\n  type: object\n  properties:\n    task: { type: string }\n  required: [task]',
    );
    const metaErrors = errors(lintScript(src).findings).filter((x) => x.message.includes("meta."));
    expect(metaErrors).toEqual([]);
  });

  it("F6b 回归: 元字符参数名不误报（a.b 不命中 aXb:）", () => {
    const src = wf(
      'name: w\ndescription: "aXb: 任意字符"\nphases: [a]\nparameters:\n  type: object\n  properties:\n    "a.b": { type: string }\n  required: ["a.b"]',
    );
    const metaErrors = errors(lintScript(src).findings).filter((x) => x.message.includes("meta."));
    expect(metaErrors).toEqual([]);
  });

  it("F7 回归: description 空串时 when/notFor 仍受检查", () => {
    const src = wf(
      'name: w\ndescription: ""\nwhen: "第一句。第二句"\nphases: [a]',
    );
    const metaErrors = errors(lintScript(src).findings).filter((x) => x.message.includes("meta."));
    expect(metaErrors.length).toBeGreaterThan(0); // when 非单句被拦
  });

  it("F8 回归: 括号外 e.g. 缩写不误报", () => {
    const src = wf(
      'name: w\ndescription: "Run when user wants review, e.g. iterative fix loop"\nphases: [a]',
    );
    const metaErrors = errors(lintScript(src).findings).filter((x) => x.message.includes("meta."));
    expect(metaErrors).toEqual([]);
  });
});
