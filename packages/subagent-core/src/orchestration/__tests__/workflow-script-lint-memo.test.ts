/**
 * WorkflowScript.validate lint memo（IF9/#15，TC9/DM2）— 引用相等键缓存测试。
 *
 * vi.mock script-lint 模块统计 lintScript 调用次数（design IF9 测试面）：
 * - 同 path + sourceCode 相等（含等值异字面量）→ 二次 validate 只 1 次 lint 调用
 * - 【设计修正】design 原文「异引用等值 miss」在 JS 不可构造：字符串 === 是值相等
 *   （实测等值异字面量命中）。lintScript 是纯函数，值相等 ⟹ 结果相同，值键 memo
 *   语义严格正确且是引用键意图的超集（registry 等值重建实例同样命中）。
 * - 同 path 新内容（值不等）→ 重 lint 并更新条目
 * - clearLintMemo → 重 lint（config-loader.invalidateCache 挂载点）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const lintCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../script-lint.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../script-lint.ts")>();
  const realLintScript = actual.lintScript;
  const countingLintScript = ((source: string) => {
    lintCalls.count++;
    return realLintScript(source);
  }) as typeof actual.lintScript;
  return { ...actual, lintScript: countingLintScript };
});

import { WorkflowScript, clearLintMemo, type WorkflowMeta } from "../models/workflow-script.ts";

const meta: WorkflowMeta = {
  kind: "workflow",
  name: "w",
  description: "",
  phases: [],
};

function makeScript(path: string, sourceCode: string): WorkflowScript {
  return new WorkflowScript({
    name: "w",
    source: "saved",
    path,
    sourceCode,
    meta,
    available: true,
  });
}

const VALID = '/* @pi-meta name: w */\nagent({ prompt: "x" });\n';

beforeEach(() => {
  clearLintMemo();
  lintCalls.count = 0;
});

describe("WorkflowScript.validate — lintMemo（IF9）", () => {
  it("同 sourceCode 引用：二次 validate 只 1 次 lint 调用", () => {
    const src = VALID;
    const a = makeScript("/ws/.pi/workflows/w.js", src);
    const b = makeScript("/ws/.pi/workflows/w.js", src); // registry 重建实例场景

    const ra = a.validate();
    const rb = b.validate();

    expect(lintCalls.count).toBe(1);
    expect(rb).toEqual(ra); // 缓存返回同一 lint 结果
  });

  it("等值异字面量同样命中（JS === 值相等；lintScript 纯函数 ⟹ 值键 memo 正确）", () => {
    const a = makeScript("/ws/.pi/workflows/w.js", VALID);
    const b = makeScript("/ws/.pi/workflows/w.js", `/* @pi-meta name: w */\nagent({ prompt: "x" });\n`);

    a.validate();
    b.validate();

    // 设计原文预期「异引用 miss → 2 次」，但字符串 === 是值相等，等值必命中；
    // lintScript(source) 纯函数，同值同结果，缓存正确性不受影响（实测锚定）。
    expect(lintCalls.count).toBe(1);
  });

  it("同 path 新内容（值不等）：重 lint 并更新条目", () => {
    const path = "/ws/.pi/workflows/w.js";
    const old = makeScript(path, VALID);
    old.validate();
    expect(lintCalls.count).toBe(1);

    const edited = makeScript(path, '/* @pi-meta name: w */\nagent({ prompt: "y", outputSchema: {} });\n');
    edited.validate();
    expect(lintCalls.count).toBe(2); // 新引用 → miss → 重 lint

    // 新条目已覆写：再以 edited 同引用 validate 命中缓存
    const replay = makeScript(path, edited.sourceCode);
    replay.validate();
    expect(lintCalls.count).toBe(2);
  });

  it("clearLintMemo 后重 lint（invalidateCache 挂载点）", () => {
    const a = makeScript("/ws/.pi/workflows/w.js", VALID);
    a.validate();
    expect(lintCalls.count).toBe(1);

    clearLintMemo();
    a.validate();
    expect(lintCalls.count).toBe(2);
  });

  it("不同 path 互不共享条目", () => {
    const src = VALID;
    makeScript("/ws/.pi/workflows/a.js", src).validate();
    makeScript("/ws/.pi/workflows/b.js", src).validate();
    expect(lintCalls.count).toBe(2);
  });
});
