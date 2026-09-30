/**
 * /workflows 命令的打开通道契约（与 commands-resume.test.ts 的 resume 通道互补）。
 *
 * 覆盖面：
 *   - getArgumentCompletions：一级 lifecycle 动词（前缀过滤）/ 二级 runId 补全
 *     （数据源空 → null、getRuns 抛错 → null + warn 留痕）/ 非动词前缀 → null
 *   - handler：print/json 模式降级提示；runId 精确匹配 / 前缀唯一匹配 / 前缀歧义 /
 *     未命中；无参 0 runs 提示 / 单 run 直开 / 多 run select（排序 + 取消不打开）
 *   - openView：ViewActions.abort 接线 + liveRecords 查询域接线（service 在场时）
 *
 * mock 策略：WorkflowsView 模块 stub（createWorkflowsView 为 vi.fn——openView 的
 * 断言面是传参而非真实 TUI）；resume-run 深路径 stub（对齐 commands-resume.test.ts）；
 * pi-extension-logger stub（catch 冷路径 warn 不落真实日志盘）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { setSubagentService, GLOBAL_SLOT_KEYS } from "@zhushanwen/subagent-core";
import { noteRebuiltSettlement } from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";

vi.mock("@zhushanwen/pi-extension-logger", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@zhushanwen/subagent-core/orchestration/resume-run.ts", () => ({
  resumeRun: vi.fn(),
}));
vi.mock("../../tui/views/WorkflowsView.ts", () => ({
  createWorkflowsView: vi.fn(() => Promise.resolve()),
}));

import { createWorkflowsView } from "../../tui/views/WorkflowsView.ts";
import { registerWorkflowsCommand } from "../commands.ts";
import { LIST_LIMIT } from "../../tui/list-shared.ts";

// ── fixture ──────────────────────────────────────────────────

const T0 = 1_700_000_000_000;
let runSeq = 0;

function makeRun(opts: { status?: "running" | "interrupted" | "done"; startedAt?: number; name?: string; runId?: string } = {}): WorkflowRun {
  const runId = opts.runId ?? `wf-cmd-${runSeq++}`;
  const status = opts.status ?? "running";
  if (status === "done") {
    noteRebuiltSettlement(runId, { outcome: "done", settledAt: Date.parse("2026-09-27T00:00:00.000Z") });
  }
  const meta: Record<string, unknown> = { startedAt: new Date(opts.startedAt ?? T0).toISOString() };
  if (status === "interrupted") meta.interruptedAt = new Date(T0 + 5000).toISOString();
  return {
    runId,
    spec: { scriptName: opts.name ?? `wf-${runId.slice(-1)}` },
    meta,
    state: { status: "running", budget: { usedTokens: 0, usedCost: 0 }, trace: { toArray: () => [] }, errorLogs: [] },
  } as unknown as WorkflowRun;
}

interface CompletionsView { // oe-exempt:20260930:test:test double shape for command capture (test infra)
  getArgumentCompletions(prefix: string): Array<{ label: string; value: string }> | null;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface CtxHarness { // oe-exempt:20260930:test:test fixture harness shape (test infra)
  ctx: ExtensionCommandContext;
  notifies: Array<{ msg: string; level: string }>;
  select: ReturnType<typeof vi.fn>;
}

function captureCommand(getRuns: () => Map<string, WorkflowRun>, deps: Record<string, unknown> = {}): CompletionsView {
  let captured!: CompletionsView;
  const api = {
    registerCommand: (_name: string, def: unknown) => {
      captured = def as CompletionsView;
    },
  };
  registerWorkflowsCommand(api as never, getRuns, { store: { stateFilePath: (id: string) => `/state/${id}` }, ...deps } as never);
  return captured;
}

function makeTuiCtx(): CtxHarness {
  const notifies: Array<{ msg: string; level: string }> = [];
  const select = vi.fn(() => Promise.resolve(undefined));
  const ctx = {
    mode: "tui",
    ui: {
      theme: { fg: (_t: string, text: string) => text, bold: (t: string) => t, bg: (_c: string, t: string) => t, underline: (t: string) => t },
      notify: (msg: string, level: string) => notifies.push({ msg, level }),
      select,
    },
  };
  return { ctx: ctx as unknown as ExtensionCommandContext, notifies, select };
}

/** 重置进程级 SubagentService 单例槽（测试清理，key 与生产 getServiceSlot 一致）。 */
function resetServiceSlot(): void {
  const slot = Reflect.get(globalThis, Symbol.for(GLOBAL_SLOT_KEYS.service)) as
    | { current: unknown }
    | undefined;
  if (slot) slot.current = null;
}

beforeEach(() => {
  runSeq = 0;
  vi.mocked(createWorkflowsView).mockClear();
});

afterEach(() => {
  resetServiceSlot();
});

// ── 补全面 ───────────────────────────────────────────────────

describe("/workflows getArgumentCompletions", () => {
  it("一级：空前缀给 abort/resume 两动词（带尾随空格），前缀过滤生效", () => {
    const cmd = captureCommand(() => new Map());
    const all = cmd.getArgumentCompletions("");
    expect(all).toHaveLength(2);
    expect(all!.map((o) => o.value)).toEqual(["abort ", "resume "]);
    expect(cmd.getArgumentCompletions("ab")).toEqual([
      { label: "abort", value: "abort ", description: "Abort a workflow run" },
    ]);
    expect(cmd.getArgumentCompletions("wor")).toEqual([]);
  });

  it("二级：动词后补全 session runs（runId + 名字/状态描述），按排序输出", () => {
    const older = makeRun({ startedAt: T0, name: "older" });
    const newer = makeRun({ startedAt: T0 + 60_000, name: "newer" });
    const runs = new Map<string, WorkflowRun>([
      [older.runId, older],
      [newer.runId, newer],
    ]);
    const cmd = captureCommand(() => runs);
    // 二级触发条件 = parts.length ≥ 2（"abort x"——尾随单空格会被 trim 进一级动词匹配）
    const items = cmd.getArgumentCompletions("abort x");
    expect(items).toHaveLength(2);
    expect(items![0]!.label).toBe(newer.runId); // 新的在前
    expect(items![0]!.description).toContain("newer");
    expect(items![0]!.description).toContain("[running]");
    expect(cmd.getArgumentCompletions("resume x")).toHaveLength(2);
  });

  it("二级：0 runs → null；getRuns 抛错 → null（补全缺失不致命）", () => {
    const cmd = captureCommand(() => new Map());
    expect(cmd.getArgumentCompletions("abort x")).toBeNull();
    const boom = captureCommand(() => {
      throw new Error("store unavailable");
    });
    expect(boom.getArgumentCompletions("resume x")).toBeNull();
  });

  it("非动词首词 → null", () => {
    const cmd = captureCommand(() => new Map());
    expect(cmd.getArgumentCompletions("view x")).toBeNull();
  });
});

// ── handler：模式分流 + 打开通道 ─────────────────────────────

describe("/workflows handler 打开通道（TUI）", () => {
  it("print 模式 → 交互模式降级提示，不打开面板", async () => {
    const cmd = captureCommand(() => new Map());
    const { ctx, notifies } = makeTuiCtx();
    (ctx as { mode: string }).mode = "print";
    await cmd.handler("", ctx);
    expect(notifies).toEqual([{ msg: "/workflows requires interactive mode", level: "error" }]);
    expect(vi.mocked(createWorkflowsView)).not.toHaveBeenCalled();
  });

  it("runId 精确匹配 → 打开该 run（theme/stateFilePath 原样透传；service 缺席 → liveRecords undefined）", async () => {
    const run = makeRun();
    const cmd = captureCommand(() => new Map([[run.runId, run]]));
    const { ctx } = makeTuiCtx();
    await cmd.handler(run.runId, ctx);
    expect(vi.mocked(createWorkflowsView)).toHaveBeenCalledTimes(1);
    const args = vi.mocked(createWorkflowsView).mock.calls[0] as unknown as [
      WorkflowRun, unknown, ExtensionCommandContext, { abort: (id: string) => Promise<void> }, string, undefined,
    ];
    expect(args[0]).toBe(run);
    expect(args[2]).toBe(ctx);
    expect(args[4]).toBe(`/state/${run.runId}`);
    expect(args[5]).toBeUndefined();
  });

  it("runId 前缀唯一匹配 → 打开；前缀歧义/未命中 → error notify", async () => {
    const a = makeRun({ runId: "wf-alpha-1" });
    const b = makeRun({ runId: "wf-beta-2" });
    const cmd = captureCommand(() => new Map([[a.runId, a], [b.runId, b]]));
    const { ctx, notifies } = makeTuiCtx();
    await cmd.handler("wf-alp", ctx);
    expect(vi.mocked(createWorkflowsView)).toHaveBeenCalledTimes(1);
    expect((vi.mocked(createWorkflowsView).mock.calls[0] as unknown as [WorkflowRun])[0]).toBe(a);

    await cmd.handler("wf-", ctx); // 两 run 同前缀 → 歧义不打开
    expect(notifies.at(-1)).toMatchObject({ msg: "Workflow 'wf-' not found", level: "error" });

    await cmd.handler("nope", ctx);
    expect(notifies.at(-1)).toMatchObject({ msg: "Workflow 'nope' not found", level: "error" });
    expect(vi.mocked(createWorkflowsView)).toHaveBeenCalledTimes(1);
  });

  it("无参 0 runs → No workflows 提示；单 run 直开", async () => {
    const cmd = captureCommand(() => new Map());
    const { ctx, notifies } = makeTuiCtx();
    await cmd.handler("", ctx);
    expect(notifies).toEqual([{ msg: "No workflows in current session.", level: "info" }]);

    const run = makeRun();
    const cmd1 = captureCommand(() => new Map([[run.runId, run]]));
    await cmd1.handler("", ctx);
    expect(vi.mocked(createWorkflowsView)).toHaveBeenCalledTimes(1);
    expect((vi.mocked(createWorkflowsView).mock.calls[0] as unknown as [WorkflowRun])[0]).toBe(run);
  });

  it("无参多 runs → select 展示排序条目（running 优先、新在前），选中后打开", async () => {
    const older = makeRun({ startedAt: T0, name: "older" });
    const newer = makeRun({ startedAt: T0 + 60_000, name: "newer" });
    const done = makeRun({ status: "done", name: "finished" });
    const interrupted = makeRun({ status: "interrupted", name: "paused" });
    const runs = new Map<string, WorkflowRun>([
      [done.runId, done],
      [interrupted.runId, interrupted],
      [older.runId, older],
      [newer.runId, newer],
    ]);
    const cmd = captureCommand(() => runs);
    const { ctx, notifies, select } = makeTuiCtx();
    select.mockReturnValue(Promise.resolve(undefined)); // 取消 → 不打开
    await cmd.handler("", ctx);
    expect(vi.mocked(createWorkflowsView)).not.toHaveBeenCalled();

    // 排序：running(新) → running(旧) → interrupted → done
    const entries = select.mock.calls[0][1] as string[];
    expect(entries).toHaveLength(4);
    expect(entries[0]).toContain("newer");
    expect(entries[1]).toContain("older");
    expect(entries[2]).toContain("paused");
    expect(entries[2]).toContain("[interrupted]");
    expect(entries[3]).toContain("finished");
    expect(entries[3]).toContain("[done]");

    select.mockReturnValue(Promise.resolve(entries[1])); // 选中 older
    await cmd.handler("", ctx);
    expect(vi.mocked(createWorkflowsView)).toHaveBeenCalledTimes(1);
    expect((vi.mocked(createWorkflowsView).mock.calls[0] as unknown as [WorkflowRun])[0]).toBe(older);
    expect(notifies).toHaveLength(0);
  });

  it("select 条目不在列表（索引 -1）→ 不打开", async () => {
    const a = makeRun();
    const b = makeRun();
    const cmd = captureCommand(() => new Map([[a.runId, a], [b.runId, b]]));
    const { ctx, select } = makeTuiCtx();
    select.mockReturnValue(Promise.resolve("ghost-entry"));
    await cmd.handler("", ctx);
    expect(vi.mocked(createWorkflowsView)).not.toHaveBeenCalled();
  });
});

// ── openView 接线 ────────────────────────────────────────────

describe("/workflows openView 接线", () => {
  it("service 在场：liveRecords 绑定 collectRecordsByParentRunId(runId, LIST_LIMIT)", async () => {
    const collectRecordsByParentRunId = vi.fn(() => []);
    setSubagentService({
      queries: { collectRecordsByParentRunId },
    } as never);
    const run = makeRun();
    const cmd = captureCommand(() => new Map([[run.runId, run]]));
    const { ctx } = makeTuiCtx();
    await cmd.handler(run.runId, ctx);

    const args = vi.mocked(createWorkflowsView).mock.calls[0] as unknown as [
      WorkflowRun, unknown, ExtensionCommandContext, { abort: (id: string) => Promise<void> }, string, () => unknown[],
    ];
    expect(args[5]).toBeTypeOf("function");
    expect(args[5]()).toEqual([]);
    expect(collectRecordsByParentRunId).toHaveBeenCalledWith(run.runId, LIST_LIMIT);
  });
});
