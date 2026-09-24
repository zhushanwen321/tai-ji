/**
 * actionList 黑盒输出测试（LLM 直接消费文本的形态锁）。
 *
 * actionList 的清单 content 此前零测试：item 行已收敛到 core
 * formatAvailableWorkflowRefs（includeSource:true / includeLocation:false——
 * 与 run 拒单 / lint not-found 清单同模板单源），本文件经注册层黑盒
 * （capture tool + registry stub）锁定 LLM 可见全文与 details/GUI 投影。
 *
 * item 行期望值逐字来自 core orchestration/launcher.ts 的
 * formatAvailableWorkflowRefs——修改模板此测试即红，属预期锁定。
 * 标题 "Available workflows:" 与空态文案是本调用点语境（非 item 模板），
 * 一并在此锁定。
 *
 * 范式：tool-workflow-script-lint.test.ts 的 captureTool。框架：vitest。
 */
import { describe, expect, it, vi } from "vitest";

import { registerWorkflowScriptTool } from "../tool-workflow-script.ts";

// ── capture helper（注册层黑盒：actionList 未导出，经 execute 唯一入口）──

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

/** registry stub（duck-typed WorkflowScriptRegistry——list 只触 loadAll）。 */
function makeRegistry(scripts: Array<Record<string, unknown>>) {
  return {
    get: vi.fn(() => Promise.resolve(undefined)),
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

function listCall(tool: CapturedTool) {
  // ctx 传 {}（mode 非 rpc）→ details 不附加 __gui__，锁的是 pi 侧可见原始输出
  return tool.execute("id", { action: "list" }, undefined, undefined, {});
}

/** 清单脚本 stub（source 显式覆盖以覆盖 saved/tmp 两种标签形态）。 */
function makeListScript(name: string, source: "saved" | "tmp", description: string) {
  return { name, source, path: `/abs/${name}.js`, sourceCode: "// x", available: true, meta: { description } };
}

describe("actionList 输出形态（LLM 可见文本锁）", () => {
  it("非空清单 → 标题 + core formatter item 行（[source] 标签 + ':' 分隔 + 无 location 行）+ details 计数", async () => {
    const registry = makeRegistry([
      makeListScript("deploy-wf", "saved", "deploy the app"),
      makeListScript("scratch-wf", "tmp", "one-off scratch task"),
    ]);
    const tool = captureTool(registry);
    const r = await listCall(tool);
    expect(registry.loadAll).toHaveBeenCalledOnce();
    expect(r.content).toEqual([
      {
        type: "text",
        text:
          "Available workflows:\n" +
          "  - [saved] deploy-wf: deploy the app\n" +
          "  - [tmp] scratch-wf: one-off scratch task",
      },
    ]);
    expect(r.details).toEqual({ action: "list", count: 2 });
    expect(r.isError).toBeUndefined();
  });

  it("不可用项剔除：available=false 不进清单，count 只计可用项", async () => {
    const registry = makeRegistry([
      makeListScript("deploy-wf", "saved", "deploy the app"),
      { ...makeListScript("broken-wf", "saved", "解析失败"), available: false },
    ]);
    const tool = captureTool(registry);
    const r = await listCall(tool);
    expect(r.content).toEqual([
      { type: "text", text: "Available workflows:\n  - [saved] deploy-wf: deploy the app" },
    ]);
    expect(r.details).toEqual({ action: "list", count: 1 });
  });

  it("description 缺省 → (no description) 占位（core formatter 行为透传）", async () => {
    const registry = makeRegistry([makeListScript("bare-wf", "saved", "")]);
    const tool = captureTool(registry);
    const r = await listCall(tool);
    expect(r.content).toEqual([
      { type: "text", text: "Available workflows:\n  - [saved] bare-wf: (no description)" },
    ]);
  });

  it("空清单（无任何脚本）→ 空态单行文案，无 details、无 isError", async () => {
    const registry = makeRegistry([]);
    const tool = captureTool(registry);
    const r = await listCall(tool);
    expect(r.content).toEqual([{ type: "text", text: "No workflow scripts available." }]);
    expect(r.details).toBeUndefined();
    expect(r.isError).toBeUndefined();
  });

  it("全不可用清单 → 同空态文案（available filter 后为空）", async () => {
    const registry = makeRegistry([{ ...makeListScript("broken-wf", "saved", "x"), available: false }]);
    const tool = captureTool(registry);
    const r = await listCall(tool);
    expect(r.content).toEqual([{ type: "text", text: "No workflow scripts available." }]);
  });
});

// ── GUI attach（RPC 模式分发；list 的 GUI 投影 = scripts 计数 stats-line）──

describe("actionList GUI attach（execute 级 RPC/非 RPC 分发）", () => {
  type GuiProjection = { __gui__?: { component?: { type?: string; props?: { items?: Array<{ label?: string; value?: string; severity?: string }> } } } };

  it("RPC ctx → details 附带 __gui__（list → scripts 计数 stats-line）", async () => {
    const registry = makeRegistry([makeListScript("deploy-wf", "saved", "deploy the app")]);
    const tool = captureTool(registry);
    const r = await tool.execute("id", { action: "list" }, undefined, undefined, {
      mode: "rpc",
      hasUI: true,
    });
    const gui = (r.details as GuiProjection).__gui__;
    expect(gui).toBeDefined();
    expect(gui?.component?.type).toBe("stats-line");
    expect(gui?.component?.props?.items).toEqual([{ label: "scripts", value: "1", severity: "ok" }]);
  });

  it("非 RPC ctx → details 无 __gui__（原始 details 结构保留）", async () => {
    const registry = makeRegistry([makeListScript("deploy-wf", "saved", "deploy the app")]);
    const tool = captureTool(registry);
    const r = await listCall(tool);
    expect((r.details as GuiProjection).__gui__).toBeUndefined();
    expect(r.details).toEqual({ action: "list", count: 1 });
  });
});
