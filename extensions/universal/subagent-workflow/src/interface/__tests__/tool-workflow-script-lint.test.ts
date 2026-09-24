/**
 * actionLint 黑盒输出测试（LLM 直接消费文本的形态锁）。
 *
 * lint 的 findings 格式化文案（图标/行号/Suggestion 结构、Errors vs Warnings 标题）
 * 与 not-found 建议清单是 LLM 自纠错的唯一信息源，此前无测试锁定。本文件经注册层
 * 黑盒测（capture tool + registry stub），lint 规则本体走真实 core lintScript——
 * 断言锁 result.content 实际文本与 details 结构，不 mock lint 规则。
 *
 * finding 文案期望值逐字来自 core orchestration/script-lint.ts 与 interface 层
 * actionLint 格式化（图标字节：✅ U+2705、❌ U+274C、⚠️ U+26A0+U+FE0F 带
 * variation selector——修改任一侧文案此测试即红，属预期锁定）。
 *
 * 范式：tool-workflow-throw-paths.test.ts 的 captureTool。框架：vitest。
 */
import { describe, expect, it, vi } from "vitest";

import { registerWorkflowScriptTool } from "../tool-workflow-script.ts";

// ── capture helper（注册层黑盒：actionLint 未导出，经 execute 唯一入口）──

interface CapturedTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: unknown;
    isError?: boolean;
  }>;
}

/** registry stub（duck-typed WorkflowScriptRegistry——lint 只触 get/loadAll）。 */
function makeRegistry(scripts: Array<Record<string, unknown>>) {
  return {
    get: vi.fn((name: string) =>
      Promise.resolve(scripts.find((s) => s.name === name && s.available === true)),
    ),
    loadAll: vi.fn(() => Promise.resolve(scripts)),
    invalidate: vi.fn(),
  };
}

function captureTool(registry: ReturnType<typeof makeRegistry>): CapturedTool {
  const tools: CapturedTool[] = [];
  const pi = { registerTool: (t: unknown) => tools.push(t as CapturedTool) };
  registerWorkflowScriptTool(pi as never, registry as never, () => false);
  if (!tools[0] || tools[0].name !== "workflow-script") {
    throw new Error("registerWorkflowScriptTool did not register the workflow-script tool");
  }
  return tools[0];
}

/** 可用脚本 stub（loadScriptSource 经 registry.get 取 sourceCode）。 */
function makeScript(name: string, sourceCode: string) {
  return { name, source: "saved", path: `/abs/${name}.js`, sourceCode, available: true, meta: {} };
}

function lintCall(tool: CapturedTool, name: string) {
  // ctx 传 {}（mode 非 rpc）→ details 不附加 __gui__，锁的是 pi 侧可见原始输出
  return tool.execute("id", { action: "lint", name }, undefined, undefined, {});
}

// ── lint 脚本 fixtures（按 core script-lint 检查项构造稳定触发形态）──

/** 合法脚本：有 agent() 入口 + 调用带 description → 0 findings。 */
const CLEAN_SCRIPT = [
  "const summary = await agent({",
  '  prompt: "Do the work",',
  '  description: "work-agent",',
  "});",
].join("\n");

/** 无任何编排入口 → 恰 1 个 error finding（line 0，行号稳定）。 */
const NO_ENTRY_SCRIPT = "const x = 1;";

/** agent() 调用缺 description/label → 恰 1 个 warning finding（line 1）。 */
const UNNAMED_AGENT_SCRIPT = 'await agent({ prompt: "work" });';

describe("actionLint 输出形态（LLM 可见文本锁）", () => {
  it("0 findings → ✅ 单行文案，无 details、无 isError", async () => {
    const registry = makeRegistry([makeScript("clean-wf", CLEAN_SCRIPT)]);
    const tool = captureTool(registry);
    const r = await lintCall(tool, "clean-wf");
    expect(registry.get).toHaveBeenCalledWith("clean-wf");
    expect(r.content).toEqual([{ type: "text", text: "✅ No issues found in 'clean-wf'." }]);
    expect(r.details).toBeUndefined();
    expect(r.isError).toBeUndefined();
  });

  it("error finding → ❌ 行 + Suggestion 缩进续行 + Errors 标题，details/isError 结构化", async () => {
    const registry = makeRegistry([makeScript("no-entry-wf", NO_ENTRY_SCRIPT)]);
    const tool = captureTool(registry);
    const r = await lintCall(tool, "no-entry-wf");
    expect(r.content).toEqual([
      {
        type: "text",
        text:
          "Errors found in 'no-entry-wf':\n\n" +
          "❌ L0: Workflow script must call agent(), parallel(), or pipeline() at least once.\n" +
          "   Suggestion: Add at least one agent(), parallel(), or pipeline() invocation.",
      },
    ]);
    expect(r.details).toEqual({
      action: "lint",
      name: "no-entry-wf",
      valid: false,
      findingCount: 1,
    });
    expect(r.isError).toBe(true);
  });

  it("warning-only finding（agent 缺 description）→ ⚠️ 行 + Warnings 标题，isError=false 不拦截", async () => {
    const registry = makeRegistry([makeScript("unnamed-wf", UNNAMED_AGENT_SCRIPT)]);
    const tool = captureTool(registry);
    const r = await lintCall(tool, "unnamed-wf");
    expect(r.content).toEqual([
      {
        type: "text",
        text:
          "Warnings found in 'unnamed-wf':\n\n" +
          "⚠️ L1: agent() call without `description` (or `label`) will show as '(unnamed)' in TUI.\n" +
          "   Suggestion: Add `description: 'kebab-case-name'` to agent() opts for readable /workflows display.",
      },
    ]);
    expect(r.details).toEqual({ action: "lint", name: "unnamed-wf", valid: true, findingCount: 1 });
    expect(r.isError).toBe(false);
  });

  it("name 不存在 → throw 完整 not-found 文案，仅列 available 脚本（不可用项剔除）", async () => {
    const registry = makeRegistry([
      { ...makeScript("broken-wf", "// x"), available: false, meta: { description: "解析失败" } },
      { ...makeScript("clean-scripts", "// x"), meta: { description: "remove stale tmp scripts" } },
    ]);
    const tool = captureTool(registry);
    // toThrow 为子串匹配——传入完整多行文案即锁定全文（含 available 建议行格式）
    await expect(lintCall(tool, "ghost-wf")).rejects.toThrow(
      "Workflow 'ghost-wf' not found or not available.\n" +
        "Available:\n" +
        "  - clean-scripts: remove stale tmp scripts",
    );
  });

  it("name 不存在且无可用脚本 → 建议清单降级为 (none)", async () => {
    const registry = makeRegistry([]);
    const tool = captureTool(registry);
    await expect(lintCall(tool, "ghost-wf")).rejects.toThrow(
      "Workflow 'ghost-wf' not found or not available.\nAvailable:\n  (none)",
    );
  });
});

// ── GUI attach（RPC 模式分发；attach 实现单点在 tool-shared withGuiAttach）──

describe("GUI attach（execute 级 RPC/非 RPC 分发）", () => {
  /** details 的 __gui__ 投影形态（协议 GuiRenderResult 的断言子集）。 */
  type GuiProjection = { __gui__?: { component?: { type?: string; props?: { items?: Array<{ label?: string; value?: string }> } } } };

  it("RPC ctx → details 附带 __gui__（lint findings → stats-line warn）", async () => {
    const registry = makeRegistry([makeScript("no-entry-wf", NO_ENTRY_SCRIPT)]);
    const tool = captureTool(registry);
    const r = await tool.execute("id", { action: "lint", name: "no-entry-wf" }, undefined, undefined, {
      mode: "rpc",
      hasUI: true,
    });
    const gui = (r.details as GuiProjection).__gui__;
    expect(gui).toBeDefined();
    expect(gui?.component?.type).toBe("stats-line");
    expect(gui?.component?.props?.items).toEqual([{ label: "lint", value: "1 findings", severity: "warn" }]);
  });

  it("RPC ctx + 纯文本结果（details undefined）→ details 保持 undefined", async () => {
    const registry = makeRegistry([makeScript("clean-wf", CLEAN_SCRIPT)]);
    const tool = captureTool(registry);
    const r = await tool.execute("id", { action: "lint", name: "clean-wf" }, undefined, undefined, {
      mode: "rpc",
      hasUI: true,
    });
    expect(r.details).toBeUndefined();
  });

  it("非 RPC ctx（lintCall 既有形态）→ details 无 __gui__", async () => {
    const registry = makeRegistry([makeScript("no-entry-wf", NO_ENTRY_SCRIPT)]);
    const tool = captureTool(registry);
    const r = await lintCall(tool, "no-entry-wf");
    expect((r.details as GuiProjection).__gui__).toBeUndefined();
  });
});
