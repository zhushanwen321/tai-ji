/**
 * WorkflowsView 交互面驱动测试（createWorkflowsView 返回的 Component 全行为面）。
 *
 * 与 WorkflowsView.test.ts（纯函数三块：渲染签名 / live 配对 / detail session 行）
 * 互补无断言重叠。本文件经 fake ctx.ui.custom 捕获 Component 后直接驱动：
 *   - render 三级布局（L0 phase 列表 / L1 agent 列表 / L2 详情 + 位置指示）
 *   - 按键链：escape 降级与关闭、↑↓ 导航、enter 下钻与 prompt 展开、
 *     PgUp/PgDn/Home/End 详情滚动、a abort、s save overlay 全编辑键、S trace 导出
 *   - 200ms tick 条件失效（签名同跳过重绘 / trace 变化重绘 / disposed 空转）
 *   - live 进度注入（liveRecords → L1 行与 L2 详情的 live 路径）
 *
 * mock 策略：saveWorkflow 深路径 stub（对齐 commands-resume.test.ts 的
 * barrel-re-export 捕获形态）；saveTraceToFile 的 fs 调用经 spyOn fsPromises
 * 拦截（不触真实盘——trace 导出目标目录由 pi-coding-agent mock 的 getAgentDir
 * 提供，指向不存在的路径，spyOn 后不会发起真实 mkdir）。
 */
import { promises as fsPromises } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { noteRebuiltSettlement } from "@zhushanwen/subagent-core";
import { saveWorkflow } from "@zhushanwen/subagent-core";
import type { AgentEventLogEntry, ExecutionTraceNode, SubagentRecord, WorkerLogEntry, WorkflowRun } from "@zhushanwen/subagent-core";

import type { ThemeLike } from "../../../format/format.ts";
import { createWorkflowsView } from "../WorkflowsView.ts";

vi.mock("@zhushanwen/subagent-core/orchestration/workflow-files.ts", () => ({
  saveWorkflow: vi.fn(),
}));

// ── 键序列（pi-tui 实装转义序列，与 list-component.test.ts 同源） ──

const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const BACKSPACE = "\x7f";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";

const T0 = 1_700_000_000_000;

// ── fixtures ─────────────────────────────────────────────────

/** plain theme：着色方法原样返回（断言业务文本而非 ANSI 码）。 */
const plainTheme: ThemeLike = {
  bg: (_color: string, text: string) => text,
  fg: (_tag: string, text: string) => text,
  bold: (text: string) => text,
  underline: (text: string) => text,
};

function makeNode(stepIndex: number, over: Partial<ExecutionTraceNode> = {}): ExecutionTraceNode {
  return {
    stepIndex,
    agent: "worker",
    task: `task ${stepIndex} do things`,
    model: "test-model",
    status: "running",
    phase: "build",
    startedAt: new Date(T0 + stepIndex * 1000).toISOString(),
    ...over,
  } as ExecutionTraceNode;
}

/** 带两个显式 phase（build×2 + deploy×1）与一个无 phase 节点的默认 trace。 */
function defaultNodes(): ExecutionTraceNode[] {
  return [
    makeNode(0),
    makeNode(1),
    makeNode(2, { phase: "deploy" }),
    makeNode(3, { phase: undefined }),
  ];
}

let driverRunSeq = 0;

function makeRun(
  nodes: ExecutionTraceNode[],
  opts: { status?: string; errorLogs?: WorkerLogEntry[]; description?: string } = {},
): WorkflowRun {
  const runId = `wf-driver-${driverRunSeq++}`;
  const status = opts.status ?? "running";
  if (status === "done") {
    noteRebuiltSettlement(runId, { outcome: "done", settledAt: Date.parse("2026-09-27T00:00:00.000Z") });
  }
  return {
    runId,
    spec: { scriptName: "driver-wf", slug: "dw", description: opts.description ?? "driver workflow" },
    meta: { startedAt: new Date(T0).toISOString() },
    state: {
      status,
      budget: { usedTokens: 5000, maxTokens: 200_000, usedCost: 0.0123 },
      trace: { toArray: () => nodes },
      errorLogs: opts.errorLogs ?? [],
    },
  } as unknown as WorkflowRun;
}

function makeSub(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "sa-driver",
    task: "task 0 do things",
    status: "running",
    startedAt: T0,
    turns: 2,
    totalTokens: 1200,
    eventLog: [
      { type: "tool_start", label: "read", ts: T0 },
      { type: "tool_start", label: "write", ts: T0 },
    ] as AgentEventLogEntry[],
    ...over,
  } as SubagentRecord;
}

// ── 驱动器 ───────────────────────────────────────────────────

interface ViewComponent { // oe-exempt:20260930:test:test double shape for component capture (test infra)
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

interface Driver { // oe-exempt:20260930:test:test fixture harness shape (test infra)
  nodes: ExecutionTraceNode[];
  component: ViewComponent;
  tui: { terminal: { columns: number; rows: number }; requestRender: ReturnType<typeof vi.fn> };
  notifies: Array<{ msg: string; level: string }>;
  abort: ReturnType<typeof vi.fn>;
  done: Promise<void>;
}

function openDriver(opts: {
  nodes?: ExecutionTraceNode[];
  status?: string;
  errorLogs?: WorkerLogEntry[];
  description?: string;
  liveRecords?: () => SubagentRecord[];
  abortImpl?: (runId: string) => Promise<void>;
} = {}): Driver {
  const nodes = opts.nodes ?? defaultNodes();
  const run = makeRun(nodes, opts);
  const tui = { terminal: { columns: 100, rows: 30 }, requestRender: vi.fn() };
  const notifies: Array<{ msg: string; level: string }> = [];
  let component!: ViewComponent;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const ctx = {
    mode: "tui",
    ui: {
      custom: (
        factory: (t: unknown, th: unknown, kb: unknown, d: (v: void) => void) => ViewComponent,
      ): Promise<void> => {
        component = factory(tui, plainTheme, {}, () => resolveDone());
        return done;
      },
      notify: (msg: string, level: string) => {
        notifies.push({ msg, level });
      },
    },
  } as unknown as ExtensionContext;
  const abort = vi.fn(opts.abortImpl ?? (() => Promise.resolve()));
  void createWorkflowsView(run, plainTheme, ctx, { abort }, "/state/snapshots/wf.json", opts.liveRecords);
  return { nodes, component, tui, notifies, abort, done };
}

/** 微任务冲刷（abort/saveWorkflow/saveTraceToFile 的 .then 链在断言前落定）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.mocked(saveWorkflow).mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── 渲染面 ───────────────────────────────────────────────────

describe("WorkflowsView L0 渲染", () => {
  it("初绘：header（名/slug/描述/state 路径）+ phase 列表 + 右侧 agent 概览 + footer", () => {
    const d = openDriver();
    const lines = d.component.render(100);
    const joined = lines.join("\n");
    expect(lines[0]).toContain("╭");
    expect(joined).toContain("driver-wf");
    expect(joined).toContain("dw");
    expect(joined).toContain("driver workflow");
    expect(joined).toContain("state: /state/snapshots/wf.json");
    expect(joined).toContain("1 build 0/2");
    expect(joined).toContain("2 deploy 0/1");
    expect(joined).toContain("3 (unnamed) 0/1");
    expect(joined).toContain("2 agents");
    // footer：running 态含 abort 快捷键
    expect(joined).toContain("↑↓ phase · ⏎ enter");
    expect(joined).toContain("a abort");
    expect(joined).toContain("esc back");
  });

  it("无 description 的 run：header 仍渲染右侧状态段（walled 分支）", () => {
    const d = openDriver({ description: undefined });
    const joined = d.component.render(100).join("\n");
    expect(joined).toContain("driver-wf");
    expect(joined).toContain("0/4 agents");
  });

  it("render 缓存命中返回同一数组；invalidate 后重建", () => {
    const d = openDriver();
    const first = d.component.render(100);
    expect(d.component.render(100)).toBe(first);
    d.component.invalidate();
    expect(d.component.render(100)).not.toBe(first);
  });
});

describe("WorkflowsView 导航（↑↓/enter/escape）", () => {
  it("L0 ↓ 切 phase：选中标记移到第二项，右侧列跟随", () => {
    const d = openDriver();
    d.component.handleInput(DOWN);
    const lines = d.component.render(100);
    const joined = lines.join("\n");
    expect(joined).toContain("❯ ● 2 deploy");
    expect(joined).not.toContain("❯ ● 1 build");
  });

  it("L0 enter → L1：footer 切 agent 提示，右列渲染 agent 行（live 缺省走终态统计）", () => {
    const d = openDriver();
    d.component.handleInput(ENTER);
    const lines = d.component.render(100);
    const joined = lines.join("\n");
    expect(joined).toContain("↑↓ agent · ⏎ detail");
    expect(joined).toContain("worker");
    expect(joined).toContain("test-model");
  });

  it("L1 enter → L2 详情：Detail 标题 + Prompt 段 + Outcome；enter 切换 prompt 展开", () => {
    const d = openDriver();
    d.component.handleInput(ENTER); // L1
    d.component.handleInput(ENTER); // L2
    const folded = d.component.render(100).join("\n");
    expect(folded).toContain("Detail");
    expect(folded).toContain("Prompt · 1 lines · ⏎ expand");
    expect(folded).toContain("Still running...");

    d.component.handleInput(ENTER); // 展开 prompt
    const expanded = d.component.render(100).join("\n");
    expect(expanded).toContain("⏎ collapse");
    expect(expanded).toContain("task 0 do things");
  });

  it("多行 prompt 折叠：显示前 3 行 + more lines 计数；展开后全量", () => {
    const task = Array.from({ length: 6 }, (_, i) => `line-${i}`).join("\n");
    const d = openDriver({ nodes: [makeNode(0, { task })] });
    d.component.handleInput(ENTER);
    d.component.handleInput(ENTER);
    const folded = d.component.render(100).join("\n");
    expect(folded).toContain("Prompt · 6 lines · ⏎ expand");
    expect(folded).toContain("3 more lines");
    d.component.handleInput(ENTER);
    const expanded = d.component.render(100).join("\n");
    expect(expanded).toContain("line-5");
  });

  it("escape 逐级降级；L0 escape 关闭 overlay（done 落定）；关闭后按键与 tick 空转", async () => {
    const d = openDriver();
    d.component.handleInput(ENTER);
    d.component.handleInput(ENTER);
    expect(d.component.render(100).join("\n")).toContain("PgUp/PgDn scroll");
    d.component.handleInput(ESC);
    expect(d.component.render(100).join("\n")).toContain("⏎ detail");
    d.component.handleInput(ESC);
    expect(d.component.render(100).join("\n")).toContain("⏎ enter");
    d.component.handleInput(ESC);
    await d.done;
    // disposed 后：handleInput 不再消费（abort 不触发）、tick 不再重绘
    const callsBefore = d.tui.requestRender.mock.calls.length;
    d.component.handleInput("a");
    expect(d.abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(d.tui.requestRender.mock.calls.length).toBe(callsBefore);
  });

  it("L2 ↑↓ 切 agent：重置详情滚动与 prompt 展开", () => {
    const d = openDriver();
    d.component.handleInput(ENTER); // L1
    d.component.handleInput(ENTER); // L2
    d.component.handleInput(ENTER); // 展开 prompt
    expect(d.component.render(100).join("\n")).toContain("⏎ collapse");
    d.component.handleInput(DOWN); // 切到本 phase 第二个 agent
    const joined = d.component.render(100).join("\n");
    expect(joined).toContain("task 1 do things");
    expect(joined).toContain("⏎ expand");
  });
});

describe("WorkflowsView L2 详情滚动（PgUp/PgDn/Home/End + 位置指示）", () => {
  /** 长 task（30 行）保证 detail 内容超出视口（rows=30 → viewH=14）。 */
  function longTaskDriver(): Driver {
    const task = Array.from({ length: 30 }, (_, i) => `prompt-line-${i}`).join("\n");
    return openDriver({ nodes: [makeNode(0, { task })] });
  }

  it("running + followTail 默认钉底：指示显示末窗；PgUp 上滚脱离跟随；Home 回顶；End 回底", () => {
    const d = longTaskDriver();
    d.component.handleInput(ENTER); // L1
    d.component.handleInput(ENTER); // L2
    d.component.handleInput(ENTER); // 展开 prompt（30 行 → 内容超出视口）
    const bottom = d.component.render(100).join("\n");
    expect(bottom).toMatch(/Detail \(\d+-\d+\/\d+\)/); // 位置指示（内容 > 视口才出现）
    expect(bottom).toContain("prompt-line-29");

    d.component.handleInput(PAGE_UP);
    const paged = d.component.render(100).join("\n");
    expect(paged).toContain("prompt-line-15");
    expect(paged).not.toContain("prompt-line-29");

    d.component.handleInput(HOME);
    const top = d.component.render(100).join("\n");
    expect(top).toContain("prompt-line-0");
    expect(top).not.toContain("prompt-line-14");

    d.component.handleInput(END);
    expect(d.component.render(100).join("\n")).toContain("prompt-line-29");
  });

  it("PgDn 向下翻页；未命中滚动键回退导航链（up/down 仍切 agent）", () => {
    const d = longTaskDriver();
    d.component.handleInput(ENTER);
    d.component.handleInput(ENTER);
    d.component.handleInput(ENTER); // 展开 prompt
    d.component.handleInput(HOME);
    d.component.handleInput(PAGE_DOWN);
    const paged = d.component.render(100).join("\n");
    expect(paged).toContain("prompt-line-14");

    // 非 L2 滚动键（如 'w'）落到快捷键链尾（无副作用），up 仍走导航链——
    // 单 agent 场景两者都不改滚动窗口（offset 保持 14）
    d.component.handleInput("w");
    d.component.handleInput(UP);
    const joined = d.component.render(100).join("\n");
    expect(joined).toContain("prompt-line-14");
    expect(joined).not.toContain("prompt-line-28");
  });
});

describe("WorkflowsView abort / 快捷键", () => {
  it("running 时 'a' → actions.abort(runId)，成功后重绘", async () => {
    const d = openDriver();
    d.component.handleInput("a");
    expect(d.abort).toHaveBeenCalledWith(expect.any(String));
    await flush();
    expect(d.tui.requestRender).toHaveBeenCalled();
  });

  it("abort 拒绝 → notify error（不静默吞）", async () => {
    const d = openDriver({ abortImpl: () => Promise.reject(new Error("boom")) });
    d.component.handleInput("a");
    await flush();
    expect(d.notifies).toEqual([{ msg: "Abort failed: boom", level: "error" }]);
  });

  it("非 running（done）时 'a' 不触发 abort", () => {
    const d = openDriver({ status: "done", nodes: [makeNode(0, { status: "completed" })] });
    d.component.handleInput("a");
    expect(d.abort).not.toHaveBeenCalled();
  });
});

describe("WorkflowsView save overlay（'s'）", () => {
  function openSave(): Driver {
    const d = openDriver();
    d.component.handleInput("s");
    return d;
  }

  it("'s' 进入 save mode：标题/目的地预览/输入行（初值 scriptName）", () => {
    const d = openSave();
    const joined = d.component.render(100).join("\n");
    expect(joined).toContain("Save dynamic workflow");
    expect(joined).toContain(".pi/workflows/driver-wf.js");
    expect(joined).toContain("> driver-wf\u2588");
    expect(joined).toContain("Enter to save · Esc to cancel");
  });

  it("可打印字符追加 + backspace 删除（输入行实时可见）", () => {
    const d = openSave();
    d.component.handleInput("x");
    expect(d.component.render(100).join("\n")).toContain("> driver-wfx\u2588");
    d.component.handleInput(BACKSPACE);
    expect(d.component.render(100).join("\n")).toContain("> driver-wf\u2588");
  });

  it("空名 enter → Please enter a name；esc 退出 save mode", () => {
    const d = openSave();
    for (let i = 0; i < "driver-wf".length; i++) d.component.handleInput(BACKSPACE);
    d.component.handleInput(ENTER);
    expect(d.component.render(100).join("\n")).toContain("Please enter a name");
    d.component.handleInput(ESC);
    expect(d.component.render(100).join("\n")).not.toContain("Save dynamic workflow");
  });

  it("enter 保存成功：saveWorkflow 接线（scriptName, 输入名），overlay 关闭", async () => {
    vi.mocked(saveWorkflow).mockResolvedValue("Saved to .pi/workflows/saved-wf.js");
    const d = openSave();
    for (let i = 0; i < "driver-wf".length; i++) d.component.handleInput(BACKSPACE);
    for (const ch of "saved-wf") d.component.handleInput(ch);
    d.component.handleInput(ENTER);
    expect(vi.mocked(saveWorkflow)).toHaveBeenCalledWith("driver-wf", "saved-wf");
    await flush();
    const joined = d.component.render(100).join("\n");
    expect(joined).not.toContain("Save dynamic workflow");
  });

  it("enter 保存失败：错误消息回显在 overlay（不关闭）", async () => {
    vi.mocked(saveWorkflow).mockRejectedValue(new Error("refusing to overwrite non-tmp workflow"));
    const d = openSave();
    d.component.handleInput(ENTER);
    await flush();
    const joined = d.component.render(100).join("\n");
    expect(joined).toContain("refusing to overwrite non-tmp workflow");
    expect(joined).toContain("Save dynamic workflow");
  });
});

describe("WorkflowsView trace 导出（'S'）", () => {
  it("导出 Markdown：mkdir→writeFile 链 + 成功 notify（含 header/phase/节点全段）", async () => {
    const mkdir = vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
    const writeFile = vi.spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
    const nodes = [
      makeNode(0, {
        status: "completed",
        completedAt: new Date(T0 + 60_000).toISOString(),
        result: {
          content: "all done",
          usage: { input: 900, output: 100 },
          toolCalls: [{ name: "read", input: "/a.ts" }],
        },
      }),
    ];
    const d = openDriver({ nodes, errorLogs: [{ level: "error", message: "E-1" }] });
    d.component.handleInput("S");
    await flush();
    expect(mkdir).toHaveBeenCalledWith(expect.stringContaining("workflow-traces"), { recursive: true });
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, content] = vi.mocked(writeFile).mock.calls[0] as unknown as [string, string];
    expect(path).toContain("workflow-traces/");
    expect(path).toMatch(/wf-driver-\d+\.md$/);
    expect(content).toContain("# Workflow Trace: driver-wf");
    expect(content).toContain("Status: running");
    expect(content).toContain("Budget: 5000/200000 tokens, $0.0123");
    expect(content).toContain("## Phase: build");
    expect(content).toContain("### [#0] worker — completed");
    expect(content).toContain("**Activity:**");
    expect(content).toContain("- read(/a.ts)");
    expect(content).toContain("all done");
    expect(d.notifies[0]?.level).toBe("info");
    expect(d.notifies[0]?.msg).toContain("Trace saved: ");
  });

  it("导出失败（mkdir 拒绝）→ notify error（Save failed 指引）", async () => {
    vi.spyOn(fsPromises, "mkdir").mockRejectedValue(new Error("EACCES: no perms"));
    const d = openDriver();
    d.component.handleInput("S");
    await flush();
    expect(d.notifies).toEqual([{ msg: "Save failed: EACCES: no perms", level: "error" }]);
  });
});

describe("WorkflowsView tick 条件失效（200ms）", () => {
  it("首 tick 必失效重绘；签名不变跳过；trace 变化后恢复重绘", () => {
    const d = openDriver();
    vi.advanceTimersByTime(200);
    expect(d.tui.requestRender).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(d.tui.requestRender).toHaveBeenCalledTimes(1); // 同秒桶同签名 → 跳过
    d.nodes.push(makeNode(4));
    vi.advanceTimersByTime(200);
    expect(d.tui.requestRender).toHaveBeenCalledTimes(2);
  });

  it("live record 变化驱动重绘（签名含 live 字段）", () => {
    const subs = [makeSub()];
    const d = openDriver({ liveRecords: () => subs });
    vi.advanceTimersByTime(200);
    expect(d.tui.requestRender).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(d.tui.requestRender).toHaveBeenCalledTimes(1);
    // 原位替换 record（token 数变化 → 配对投影变 → 签名变）。追加同分候选不改投影
    // （startedAt 最近邻贪心仍取首个，签名不变——非本用例目标）。
    subs[0] = makeSub({ totalTokens: 2400 });
    vi.advanceTimersByTime(200);
    expect(d.tui.requestRender).toHaveBeenCalledTimes(2);
  });
});

describe("WorkflowsView live 进度渲染（liveRecords 注入）", () => {
  it("L1 agent 行 live 路径：tok/tools/elapsed 来自 store record 投影", () => {
    const d = openDriver({
      liveRecords: () => [makeSub({ totalTokens: 1200, turns: 2 })],
    });
    d.component.handleInput(ENTER);
    const joined = d.component.render(100).join("\n");
    expect(joined).toContain("1k tok");
    expect(joined).toContain("2 tools");
  });

  it("L2 详情 live 路径：当前活动行 + 最近事件 + 实时 Outcome（含 lastError）", () => {
    const d = openDriver({
      liveRecords: () => [
        makeSub({
          currentActivity: { type: "tool", label: "bash" },
          eventLog: [
            { type: "tool_start", label: "read", ts: T0 },
            { type: "error", label: "EPIPE: broken pipe", ts: T0 },
          ] as AgentEventLogEntry[],
        }),
      ],
    });
    d.component.handleInput(ENTER);
    d.component.handleInput(ENTER);
    const joined = d.component.render(100).join("\n");
    expect(joined).toContain("⎿ tool: bash");
    expect(joined).toContain("→ read");
    expect(joined).toContain("Running ·");
    expect(joined).toContain("EPIPE: broken pipe");
  });

  it("L2 详情 live 零活动：显示 (starting...) 占位", () => {
    const d = openDriver({ liveRecords: () => [makeSub({ eventLog: [], turns: 0, totalTokens: 0 })] });
    d.component.handleInput(ENTER);
    d.component.handleInput(ENTER);
    expect(d.component.render(100).join("\n")).toContain("(starting...)");
  });

  it("L2 详情 worker diagnostics：errorLogs 渲染 level 前缀行", () => {
    const d = openDriver({
      errorLogs: [
        { level: "error", message: "wave 1 failed" },
        { level: "warn", message: "retrying" },
      ],
    });
    d.component.handleInput(ENTER);
    d.component.handleInput(ENTER);
    const joined = d.component.render(100).join("\n");
    expect(joined).toContain("Worker diagnostics · 2 entries");
    expect(joined).toContain("[error] wave 1 failed");
    expect(joined).toContain("[warn] retrying");
  });

  it("终态节点 Activity 截断标签：toolCalls 超 3 条显示 last N of M", () => {
    const toolCalls = Array.from({ length: 5 }, (_, i) => ({ name: `t${i}`, input: "{}" }));
    const d = openDriver({
      nodes: [makeNode(0, { status: "completed", result: { content: "ok", toolCalls } })],
    });
    d.component.handleInput(ENTER);
    d.component.handleInput(ENTER);
    const joined = d.component.render(100).join("\n");
    expect(joined).toContain("Activity · last 3 of 5 tool calls");
    expect(joined).toContain("t4({})");
    expect(joined).not.toContain("t0({})");
  });

  it("终态节点 Outcome：error 优先于 content；超预算内容截断 + (truncated) 标记", () => {
    const big = "x".repeat(120_000);
    const d = openDriver({
      nodes: [
        makeNode(0, { status: "failed", result: { error: "agent crashed", content: big } }),
      ],
    });
    d.component.handleInput(ENTER);
    d.component.handleInput(ENTER);
    const joined = d.component.render(100).join("\n");
    expect(joined).toContain("agent crashed");
    expect(joined).not.toContain("xxxx");

    const d2 = openDriver({
      nodes: [makeNode(0, { status: "completed", result: { content: `head\n${big}` } })],
    });
    d2.component.handleInput(ENTER);
    d2.component.handleInput(ENTER);
    const joined2 = d2.component.render(100).join("\n");
    expect(joined2).toContain("(truncated)");
  });
});
