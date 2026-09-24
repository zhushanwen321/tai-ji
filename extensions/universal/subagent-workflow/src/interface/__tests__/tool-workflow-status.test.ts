/**
 * actionStatus 黑盒输出测试（LLM 直接消费文本的形态锁）。
 *
 * status 列表行格式（[status] name (id 前 8 位) (elapsed) error: …）此前无测试
 * 锁定——它是 LLM 判断 run 状态与 runId 引用的唯一信息源。本文件经注册层黑盒测
 * （capture tool + 真实 WorkflowRun 聚合根），锁 result.content 实际文本与
 * details.runs 投影。
 *
 * 行为依据：formatRunStatusElapsed 的 done 后冻结语义（completedAt 有值时 elapsed
 * 恒等于 completedAt - startedAt，running 用 Date.now()）——用 fake timers 钉死
 * 墙钟，两种形态的 elapsed 都是确定性值。
 *
 * 范式：tool-workflow-throw-paths.test.ts 的 captureTool。框架：vitest。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Budget, Trace, WorkflowRun } from "@zhushanwen/subagent-core";
import type { DoneReason } from "@zhushanwen/subagent-core";

import type { ReentryGuardRef } from "../reentry-guard.ts";
import { registerWorkflowTool } from "../tool-workflow.ts";

// ── capture helper（注册层黑盒：actionStatus 未导出，经 execute 唯一入口）──

interface StatusResult {
  content: Array<{ type: string; text: string }>;
  details:
    | {
        action: string;
        runs: Array<Record<string, unknown>>;
      }
    | undefined;
  isError?: boolean;
}

interface CapturedTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<StatusResult>;
}

function captureTool(runs: Map<string, WorkflowRun>): CapturedTool {
  const deps = {
    runs,
    // status 路径只触 store.stateFilePath（RunSummary 宿主扩展字段）
    store: { stateFilePath: (runId: string) => `/state/${runId}.jsonl` },
    registry: { get: vi.fn(), getPath: vi.fn(), loadAll: vi.fn(), invalidate: vi.fn() },
  };
  const guard: ReentryGuardRef = { isProcessing: false };
  const tools: CapturedTool[] = [];
  const pi = { registerTool: (t: unknown) => tools.push(t as CapturedTool) };
  registerWorkflowTool(pi as never, deps as never, guard);
  if (!tools[0] || tools[0].name !== "workflow") {
    throw new Error("registerWorkflowTool did not register the workflow tool");
  }
  return tools[0];
}

/** 真实 WorkflowRun 聚合根（reconstruct 工厂——status 路径只读投影面）。 */
function makeRun(opts: {
  runId: string;
  scriptName: string;
  status: "running" | "done";
  reason?: DoneReason;
  error?: string;
  startedAt: string;
  completedAt?: string;
}): WorkflowRun {
  return WorkflowRun.reconstruct(
    opts.runId,
    {
      scriptSource: "// stub source",
      args: {},
      scriptName: opts.scriptName,
      scriptPath: `/abs/${opts.scriptName}.js`,
    },
    {
      status: opts.status,
      reason: opts.reason,
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
      error: opts.error,
    },
    { startedAt: opts.startedAt, completedAt: opts.completedAt },
  );
}

// ── 墙钟 fixture（fake timers 钉死 Date.now，elapsed 全确定性）──

const FAKE_NOW = new Date("2026-01-01T00:00:30.000Z").getTime();

beforeEach(() => {
  vi.useFakeTimers({ now: FAKE_NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("actionStatus 输出形态（LLM 可见文本锁）", () => {
  it("runs 为空 → 固定空态文案 + 空 runs details", async () => {
    const tool = captureTool(new Map());
    const r = await tool.execute("id", { action: "status" }, undefined, undefined, {});
    expect(r.content).toEqual([{ type: "text", text: "No workflows in current session." }]);
    expect(r.details).toMatchObject({ action: "status", runs: [] });
  });

  it("running + done 混合 → 每 run 一行：status/reason 后缀、id 前 8 位、elapsed（done 冻结）、error 尾缀", async () => {
    const running = makeRun({
      runId: "wf-1719500000000-a1b2c3",
      scriptName: "demo-wf",
      status: "running",
      startedAt: "2026-01-01T00:00:24.000Z", // fakeNow - 6s → (6s)
    });
    const doneFailed = makeRun({
      runId: "wf-1719600000000-z9y8x7",
      scriptName: "cleanup-wf",
      status: "done",
      reason: "failed", // ≠ completed → [failed] 后缀
      error: "boom",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:05.000Z", // done 冻结 → (5s)，不随墙钟
    });
    const doneCompleted = makeRun({
      runId: "wf-1719700000000-q5r4t3",
      scriptName: "ok-wf",
      status: "done",
      reason: "completed", // === completed → 无 reason 后缀、无 error 尾缀
      startedAt: "2026-01-01T00:00:08.000Z",
      completedAt: "2026-01-01T00:00:10.000Z", // (2s)
    });
    const runs = new Map([
      [running.runId, running],
      [doneFailed.runId, doneFailed],
      [doneCompleted.runId, doneCompleted],
    ]);
    const tool = captureTool(runs);
    const r = await tool.execute("id", { action: "status" }, undefined, undefined, {});

    expect(r.content).toEqual([
      {
        type: "text",
        text:
          "[running] demo-wf (wf-17195) (6s)\n" +
          "[done [failed]] cleanup-wf (wf-17196) (5s) error: boom\n" +
          "[done] ok-wf (wf-17197) (2s)",
      },
    ]);
    // details.runs = core runSummary 投影 + 宿主 stateFile 扩展（GUI 消费面）
    expect(r.details).toMatchObject({
      action: "status",
      runs: [
        {
          runId: "wf-1719500000000-a1b2c3",
          name: "demo-wf",
          status: "running",
          stateFile: "/state/wf-1719500000000-a1b2c3.jsonl",
        },
        {
          runId: "wf-1719600000000-z9y8x7",
          name: "cleanup-wf",
          status: "done",
          reason: "failed",
          error: "boom",
          completedAt: "2026-01-01T00:00:05.000Z",
          stateFile: "/state/wf-1719600000000-z9y8x7.jsonl",
        },
        {
          runId: "wf-1719700000000-q5r4t3",
          name: "ok-wf",
          status: "done",
          reason: "completed",
          stateFile: "/state/wf-1719700000000-q5r4t3.jsonl",
        },
      ],
    });
  });
});

// ── GUI attach（RPC 模式分发；attach 实现单点在 tool-shared withGuiAttach）──

describe("GUI attach（execute 级 RPC/非 RPC 分发）", () => {
  /** details 的 __gui__ 投影形态（协议 GuiRenderResult 的断言子集）。 */
  type GuiProjection = { __gui__?: { component?: { type?: string; props?: { items?: unknown[] } } } };

  it("RPC ctx → details 附带 __gui__（status → list-tree 组件）", async () => {
    const tool = captureTool(new Map());
    const r = await tool.execute("id", { action: "status" }, undefined, undefined, {
      mode: "rpc",
      hasUI: true,
    });
    const gui = (r.details as unknown as GuiProjection).__gui__;
    expect(gui).toBeDefined();
    expect(gui?.component?.type).toBe("list-tree");
    expect(gui?.component?.props?.items).toEqual([]);
  });

  it("TUI ctx → details 无 __gui__（走 pi 原生渲染）", async () => {
    const tool = captureTool(new Map());
    const r = await tool.execute("id", { action: "status" }, undefined, undefined, {
      mode: "tui",
      hasUI: true,
    });
    expect((r.details as unknown as GuiProjection).__gui__).toBeUndefined();
  });
});
