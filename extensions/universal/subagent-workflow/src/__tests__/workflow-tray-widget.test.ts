// workflow-tray-widget.test.ts —— workflow 托盘件 widget 树构造 + 推送器（容器扩展点
// 统一 §6.6 U10 层 1）。
//
// 三视角（与 subagent 件 tray-widget.test 同族）：
//   ①使用者（宿主 widget 区视角）——树形状：meta head（title/status/progress/icon/badge）
//     + tab-bar 双段（进行中/已结束）行集；成员进度 N/M 拼进行 label（list-tree 无进度
//     条原语——原宿主托盘 workflow 行的进度条信息经 label 承载，不静默丢弃）；interrupted
//     落已结束段（无活体暂停态不算进行中，原宿主 [D2] 裁决同口径）且行无圆点 pause 图标。
//   ②构建者——空 runs 清屏（undefined）/ 推送器 attach 初始推送 + notifyRunsChanged
//     变更驱动重推（微任务合并）+ detach 停推；readRuns 抛错按清屏投影不反噬调用方。
//   ③观察者——纯函数入参出参；推送失败 warn 留痕后继续（绝对投影，下一事件自愈）。
//
// WorkflowRun fixture 用真聚合根（WorkflowRun.reconstruct——runSummary/calls 派生消费
// 真字段；终局事实经 noteRebuiltSettlement 注入注册表，与 tool-workflow.test 同款夹具）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted mocks（依赖收窄：logger 防文件落盘；protocol 只 mock setWidgetDual 推送点，
//    guiComponent/guiResult/runSummary 走真实现——树形状断言消费真实产物）──

const extensionLoggerMock = vi.hoisted(() => {
  const instance = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: vi.fn(() => instance), instance };
});

const setWidgetDualMock = vi.hoisted(() => vi.fn());

vi.mock("@zhushanwen/pi-extension-logger", () => extensionLoggerMock);
vi.mock("@zhushanwen/pi-ext-guards", () => ({
  toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock("@zhushanwen/extension-protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zhushanwen/extension-protocol")>();
  return { ...actual, setWidgetDual: setWidgetDualMock };
});

import {
  AgentCall,
  Budget,
  Trace,
  WorkflowRun,
  noteRebuiltSettlement,
  runSummary,
} from "@zhushanwen/subagent-core";
import type { DoneReason } from "@zhushanwen/subagent-core";
import type { GuiComponent } from "@zhushanwen/extension-protocol";
import {
  WORKFLOW_TRAY_VIEW_ID,
  buildWorkflowTrayWidget,
  createWorkflowTrayWidgetPusher,
} from "../interface/gui/workflow-tray-widget.ts";

/** run fixture（字段集与 tool-workflow.test 的 makeRun 同源：reconstruct 真聚合根）。
 *  calls 经 AgentCall.markDone 注入成员进度事实（result 有无 = 落定判据；error 有无
 *  = 失败判据）。终局事实经 noteRebuiltSettlement 注入注册表。 */
function makeRun(opts: {
  runId: string;
  scriptName: string;
  status: "running" | "done";
  reason?: DoneReason;
  slug?: string;
  interrupted?: boolean;
  calls?: Array<{ settled: boolean; failed?: boolean }>;
}): WorkflowRun {
  const run = WorkflowRun.reconstruct(
    opts.runId,
    {
      scriptSource: "// stub source",
      args: {},
      scriptName: opts.scriptName,
      scriptPath: `/abs/${opts.scriptName}.js`,
      ...(opts.slug !== undefined ? { slug: opts.slug } : {}),
    },
    {
      status: opts.status,
      reason: opts.reason,
      budget: new Budget(),
      calls: new Map(
        (opts.calls ?? []).map((c, i) => {
          const call = new AgentCall(i, { prompt: `task ${i}` } as never, new Trace());
          // markRunning 前置（pending 不能直接 markDone——AgentCall 状态机约束）
          call.markRunning();
          if (c.settled) {
            call.markDone({ ...(c.failed ? { error: "boom" } : {}) } as never);
          }
          return [i, call];
        }),
      ),
      trace: new Trace(),
      errorLogs: [],
      error: undefined,
    },
    {
      startedAt: "2026-10-25T00:00:00Z",
      ...(opts.status === "done" ? { completedAt: "2026-10-25T00:01:00Z" } : {}),
      ...(opts.interrupted ? { interruptedAt: "2026-10-25T00:00:30Z" } : {}),
    },
  );
  if (opts.status === "done") {
    noteRebuiltSettlement(opts.runId, {
      outcome: opts.reason === "failed" ? "failed" : "done",
      settledAt: Date.parse("2026-10-25T00:01:00Z"),
    });
  }
  return run;
}

/** tab-bar 树的段 items 提取（sections[i][0].items——段 = 子树数组，单组件子树取首项）。 */
function segmentItems(component: GuiComponent, index: number): Array<Record<string, unknown>> {
  expect(component.type).toBe("tab-bar");
  const sections = (component.props as { sections?: GuiComponent[][] }).sections ?? [];
  const seg = sections[index]?.[0];
  expect(seg?.type).toBe("list-tree");
  return (seg.props as { items: Array<Record<string, unknown>> }).items;
}

beforeEach(() => {
  setWidgetDualMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildWorkflowTrayWidget —— 树构造（使用者视角）", () => {
  it("running run → 进行中段 1 行（status=running），meta status=running + badge 计数", () => {
    const widget = buildWorkflowTrayWidget([
      makeRun({ runId: "wf-run-1", scriptName: "build", slug: "ci", status: "running", calls: [{ settled: false }] }),
    ]);
    expect(widget).toBeDefined();
    const comp = widget!.gui.component;
    expect(comp.type).toBe("tab-bar");
    const tabs = (comp.props as { tabs: Array<{ label: string }> }).tabs;
    expect(tabs[0].label).toBe("进行中 1");
    expect(tabs[1].label).toBe("已结束 0");
    const running = segmentItems(comp, 0);
    expect(running).toHaveLength(1);
    expect(running[0].status).toBe("running");
    expect(running[0].icon).toBe("circle");
    // meta head：标题/状态点/进度/icon/badge（宿主壳层唯一渲染 head）
    const meta = widget!.gui.meta;
    expect(meta.title).toBe("Workflows");
    expect(meta.status).toBe("running");
    expect(meta.badge).toBe("1");
    expect(meta.icon).toBe("workflow");
    expect(meta.progress).toEqual({ current: 1, total: 1, label: "1" });
  });

  it("行 label 携带成员进度 N/M（原宿主进度条信息的原语承载位，不静默丢弃）", () => {
    const widget = buildWorkflowTrayWidget([
      makeRun({
        runId: "wf-run-2",
        scriptName: "ship",
        slug: "v2",
        status: "running",
        calls: [{ settled: true }, { settled: true }, { settled: false }],
      }),
    ]);
    const running = segmentItems(widget!.gui.component, 0);
    expect(running[0].label).toBe("ship · v2 · 2/3");
  });

  it("done(completed) run → 已结束段（status=done）；interrupted run 落已结束段且无圆点 pause", () => {
    const widget = buildWorkflowTrayWidget([
      makeRun({ runId: "wf-run-3", scriptName: "ok", status: "done", reason: "completed" }),
      makeRun({ runId: "wf-run-4", scriptName: "halt", status: "running", interrupted: true }),
    ]);
    const ended = segmentItems(widget!.gui.component, 1);
    expect(ended).toHaveLength(2);
    expect(ended[0].status).toBe("done");
    // interrupted：无圆点（不作成败断言）+ pause 图标
    expect(ended[1].status).toBeUndefined();
    expect(ended[1].icon).toBe("pause");
  });

  it("failed 终局 → 行 status=failed + meta status=failed（失败可见不吞）", () => {
    const widget = buildWorkflowTrayWidget([
      makeRun({ runId: "wf-run-5", scriptName: "boom", status: "done", reason: "failed" }),
    ]);
    const ended = segmentItems(widget!.gui.component, 1);
    expect(ended[0].status).toBe("failed");
    expect(widget!.gui.meta.status).toBe("failed");
  });

  it("空 runs → undefined（清屏语义；调用方推 setWidgetDual(…, undefined)）", () => {
    expect(buildWorkflowTrayWidget([])).toBeUndefined();
  });

  it("text 臂 = TUI 原生文本行（[status] 前缀 + 行 label）", () => {
    const widget = buildWorkflowTrayWidget([
      makeRun({ runId: "wf-run-6", scriptName: "build", status: "running" }),
    ]);
    expect(widget!.text).toEqual(["[running] build · 0/0"]);
  });

  it("runSummary 派生视图单源（行状态 = core 三态投影，不经本地第二套判定）", () => {
    const run = makeRun({ runId: "wf-run-7", scriptName: "x", status: "running" });
    expect(runSummary(run).status).toBe("running");
    const widget = buildWorkflowTrayWidget([run]);
    expect(segmentItems(widget!.gui.component, 0)[0].status).toBe("running");
  });
});

describe("createWorkflowTrayWidgetPusher —— 推送器（构建者视角）", () => {
  function makeCtx(): unknown {
    return { mode: "rpc", hasUI: true };
  }

  it("attach 初始推送（绝对投影）+ notifyRunsChanged 变更驱动重推（微任务合并）", async () => {
    let runs: WorkflowRun[] = [];
    const pusher = createWorkflowTrayWidgetPusher(() => runs);
    const ctx = makeCtx();

    pusher.attach(ctx as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(setWidgetDualMock).toHaveBeenCalledTimes(1);
    expect(setWidgetDualMock.mock.calls[0][1]).toBe(WORKFLOW_TRAY_VIEW_ID);
    expect(setWidgetDualMock.mock.calls[0][2]).toBeUndefined(); // 空集清屏

    // 变更信号：同一 tick 两次 notify 合并为一次推送（微任务边界）
    runs = [makeRun({ runId: "wf-run-8", scriptName: "build", status: "running" })];
    pusher.notifyRunsChanged();
    pusher.notifyRunsChanged();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(setWidgetDualMock).toHaveBeenCalledTimes(2);
    const pushed = setWidgetDualMock.mock.calls[1][2];
    expect(pushed).toBeDefined();
    expect(pushed.gui.component.type).toBe("tab-bar");

    // detach 后停推
    pusher.detach();
    pusher.notifyRunsChanged();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(setWidgetDualMock).toHaveBeenCalledTimes(2);
  });

  it("readRuns 抛错 → 按清屏投影 + warn 留痕，不反噬调用方", async () => {
    const pusher = createWorkflowTrayWidgetPusher(() => {
      throw new Error("session not assembled");
    });
    pusher.attach(makeCtx() as never);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(setWidgetDualMock).toHaveBeenCalledWith(
      expect.anything(),
      WORKFLOW_TRAY_VIEW_ID,
      undefined,
    );
    expect(extensionLoggerMock.instance.warn).toHaveBeenCalledWith(
      expect.stringContaining("runs read failed"),
    );
  });

  it("推送失败（setWidgetDual throw）→ warn 留痕不反噬 notifyRunsChanged 调用方", async () => {
    setWidgetDualMock.mockImplementation(() => {
      throw new Error("channel down");
    });
    const pusher = createWorkflowTrayWidgetPusher(() => [
      makeRun({ runId: "wf-run-9", scriptName: "build", status: "running" }),
    ]);
    pusher.attach(makeCtx() as never);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(extensionLoggerMock.instance.warn).toHaveBeenCalledWith(
      expect.stringContaining("widget push failed"),
    );
    // 第二次变更信号继续尝试（首败 warn 只记一次，重推不中断）
    setWidgetDualMock.mockImplementation(() => {});
    pusher.notifyRunsChanged();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(setWidgetDualMock).toHaveBeenCalledTimes(2);
  });
});
