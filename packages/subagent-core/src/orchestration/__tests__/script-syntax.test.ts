/**
 * script-syntax — 派发前语法闸（生成期/派发期共用原语）测试。
 *
 * 覆盖：
 * - checkWorkflowScriptSyntax：合法脚本通过；顶层重声明宿主预声明名（args 等）红；
 *   函数内同名声明不红（作用域不同）；`export const meta` 形式可编译
 * - assertWorkflowScriptSyntax：空脚本文本跳过（旧格式 record）；撞名抛
 *   WorkflowScriptSyntaxError 且文案含恢复指引
 * - 内置模板对账：packages/subagent-core/workflows/ 下六个内置脚本全部通过本闸
 *   （模板演化出撞名声明时在此红，而不是真机异步语法错）
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertWorkflowScriptSyntax,
  checkWorkflowScriptSyntax,
  WorkflowScriptSyntaxError,
} from "../script-syntax.ts";

const WORKFLOWS_DIR = fileURLToPath(new URL("../../../workflows/", import.meta.url));

describe("checkWorkflowScriptSyntax（生成期/派发期共用闸）", () => {
  it("合法脚本（宿主名照常使用）通过", () => {
    expect(checkWorkflowScriptSyntax("async function execute() { await agent('x'); return args; }")).toBeUndefined();
  });

  it("顶层重声明宿主预声明名 args → 返回诊断文案（真机 SyntaxError 前置）", () => {
    const detail = checkWorkflowScriptSyntax("const args = { a: 1 };\nasync function execute() {}");
    expect(detail).toBeDefined();
    expect(detail).toContain("Syntax error in script");
    expect(detail).toContain("'args' has already been declared");
  });

  it("函数内同名声明不红（作用域不同，与真机包裹形态一致）", () => {
    expect(
      checkWorkflowScriptSyntax("async function execute() { const args = {}; return args; }"),
    ).toBeUndefined();
  });

  it("`export const meta` 形式可编译（生成期 legacy 形态）", () => {
    expect(
      checkWorkflowScriptSyntax("export const meta = { name: 'x' };\nasync function execute() {}"),
    ).toBeUndefined();
  });
});

describe("assertWorkflowScriptSyntax（run / resume 入口共用）", () => {
  it("撞名脚本抛 WorkflowScriptSyntaxError，文案含诊断 + 恢复指引（列预声明名）", () => {
    let thrown: unknown;
    try {
      assertWorkflowScriptSyntax("wf-collide", "const phase = 1;");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowScriptSyntaxError);
    const err = thrown as WorkflowScriptSyntaxError;
    expect(err.workflowName).toBe("wf-collide");
    expect(err.message).toContain("cannot run");
    expect(err.message).toContain("'phase' has already been declared");
    expect(err.message).toContain("Recovery: rename the script-level declaration");
    expect(err.message).toContain("$ARGS");
  });

  it("空脚本文本跳过（旧格式 run-created 记录无全文，无文本可查）", () => {
    expect(() => assertWorkflowScriptSyntax("wf-legacy", "")).not.toThrow();
    expect(() => assertWorkflowScriptSyntax("wf-legacy", "   \n")).not.toThrow();
  });

  it("合法脚本不抛", () => {
    expect(() => assertWorkflowScriptSyntax("wf-ok", "async function execute() { return $ARGS; }")).not.toThrow();
  });
});

describe("内置模板对账（workflows/*.js 必须全部通过派发前闸）", () => {
  it("六个内置模板脚本全部通过 checkWorkflowScriptSyntax", () => {
    const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".js"));
    expect(files.length, "内置模板目录为空 = 路径锚或产物形态变了，对账失效").toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(`${WORKFLOWS_DIR}${file}`, "utf-8");
      expect(checkWorkflowScriptSyntax(source), `内置模板 ${file} 未通过派发前语法闸`).toBeUndefined();
    }
  });
});
