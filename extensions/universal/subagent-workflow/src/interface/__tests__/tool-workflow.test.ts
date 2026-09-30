/**
 * workflow tool 行为契约合一（2026-09-27 测试审计组 6：六源并一文件）。
 *
 * 来源与分工：
 * - actionStatus 输出形态 + GUI attach（原 tool-workflow-status.test.ts）——
 *   status 列表行格式是 LLM 判断 run 状态与 runId 引用的唯一信息源，锁
 *   result.content 实际文本与 details.runs 投影。
 * - W4b 错误路径 throw 语义（原 tool-workflow-throw-paths.test.ts）——pi 只对
 *   execute throw 置 isError:true（返回值里的 isError 被 agent-loop 丢弃），故
 *   错误路径必须 throw。其中 4 条 entry-guard 用例（slug 上限 / time 上限 /
 *   tokens·time 负值）是 core shared/entry-guards.ts 当前唯一行为证明。
 * - D8 创建期模型拒单（原 tool-workflow-model-rejection.test.ts）。
 * - D4-1 按名解析退役 + run/abort 文案全文锚定（原 tool-workflow-run-builtin-name.test.ts）。
 * - TC3i 宿主 reservedKeys 接线锚（原 detectors.test.ts——TC3a-h 的行为等值断言
 *   在 core orchestration/__tests__/args-meta.test.ts，宿主差异面只留此条）。
 * - run details.stateFile 暴露（原 workflow-state-file-exposure.test.ts 第 3 条，
 *   grep 断言改行为级等值）。
 *
 * 结构约束：
 * - fake timers 只在 actionStatus describe 内启用（done 冻结语义需钉死墙钟），
 *   不泄漏到 run/abort 路径。
 * - D8 describe 首条必须在任何 setCatalogService 调用之前执行（声明序 = 执行序）：
 *   setModelConfigService 无复位面，单例 set 后「目录缺席」防御分支不可再达。
 *
 * mock 策略：lifecycle 深路径 stub（runWorkflow/abortRun 为 vi.fn——不起真
 * Worker，只测启动面与入口校验）。范式：captureTool 注册层黑盒。框架：vitest。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Budget,
  SLUG_MAX_LENGTH,
  Trace,
  WorkflowRun,
  WorkflowScriptRegistryImpl,
  doneReasonToRunOutcome,
  noteRebuiltSettlement,
  parseResourceMeta,
  setModelConfigService,
} from "@zhushanwen/subagent-core";
import type { DoneReason } from "@zhushanwen/subagent-core";
import {
  argKeysFromMeta,
  findFlattenedArgKeys,
} from "@zhushanwen/subagent-core/orchestration/args-meta.ts";
// 被 mock 的模块——import 路径与被测源文件的等值实例（vi.mock hoist 后 barrel
// re-export 与深路径指向同一 mock 实例）
import { runWorkflow, abortRun } from "@zhushanwen/subagent-core/orchestration/lifecycle.ts";
// [D6(a) 第 1 步] 终局记录注册表清零面（换源后 done 判定唯一源 = 注册表，且注册表
// 按 runId 全局分区——用例间不清零会让复用 runId 的 fixture 跨用例污染）。
import { setRunEventJournalDirForTest } from "@zhushanwen/subagent-core/orchestration/terminal-actions.ts";

import { actionRun, registerWorkflowTool, TOOL_TOP_LEVEL } from "../tool-workflow.ts";
import { REENTRY_BUSY_MESSAGE, type ReentryGuardRef } from "../reentry-guard.ts";
import { captureTool, type CapturedTool } from "./capture-tool.ts";

/** 桩化 lifecycle——runWorkflow/abortRun 为 vi.fn（不起真 Worker，只测启动面/入口校验）。 */
vi.mock("@zhushanwen/subagent-core/orchestration/lifecycle.ts", () => ({
  runWorkflow: vi.fn(),
  abortRun: vi.fn(),
}));

// 顶层 mock 生命周期（合并自原 run-builtin-name / model-rejection 两文件的
// 同构 beforeEach/afterEach；abort 用例另在 stubAbortTransition 内重置 abortRun）
beforeEach(() => {
  vi.mocked(runWorkflow).mockReset();
  vi.mocked(runWorkflow).mockResolvedValue("run-id-1");
  // 终局记录注册表清零（setRunEventJournalDirForTest 同实现内清注册表 + 活体态）
  setRunEventJournalDirForTest(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 生产源码文本（KNOWN_ARG_KEYS 退役守卫用——读源码非 import，同提示词测试模式）──

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_WORKFLOW_SRC = readFileSync(join(__dirname, "../tool-workflow.ts"), "utf-8");

// ── 共享 fixture（合并前各文件同构拷贝收敛单点）──

/** fake registry / 真 registry 通用的最小 WorkflowScript stub。 */
function makeScript(name: string, path: string, parameters?: object) {
  return {
    name,
    path,
    available: true,
    sourceCode: `// ${name}`,
    meta: { description: `${name} workflow`, parameters },
    toExecutable: () => `// ${name}`,
  };
}

/** registry vi.fn 齐面快捷构造（缺省全 miss；overrides 覆盖单键）。 */
function stubRegistry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    get: vi.fn().mockResolvedValue(undefined),
    getPath: vi.fn().mockResolvedValue(undefined),
    loadAll: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/** 最小 deps stub（runWorkflow 已 mock；store 只消费 stateFilePath）。 */
function makeDeps(registry: Record<string, unknown>): Record<string, unknown> {
  return {
    runs: new Map(),
    store: { stateFilePath: (id: string) => `/tmp/state/${id}.jsonl` },
    registry,
  };
}

// ══════════════════════════════════════════════════════════════
// actionStatus 黑盒输出（原 tool-workflow-status.test.ts）
// ══════════════════════════════════════════════════════════════

type StatusResult = {
  content: Array<{ type: string; text: string }>;
  details:
    | {
        action: string;
        runs: Array<Record<string, unknown>>;
      }
    | undefined;
  isError?: boolean;
};

// 测试夹具描述符（非生产契约）：黑盒 capture 的结构收窄——actionStatus 未导出，
// 经注册层 execute 唯一入口取回后按此类型读取输出；单"实现"是 capture 对象本身。
interface StatusToolView extends CapturedTool { // oe-exempt:20260927:wip:test fixture descriptor, not a production contract awaiting variants
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<StatusResult>;
}

/** 注册层黑盒 capture（actionStatus/actionAbort 未导出，经 execute 唯一入口；
 *  fake pi 捕获单点见 capture-tool.ts，此处只留差异面：runs Map + 泛型 view）。 */
function captureRegisteredTool<T extends CapturedTool>(runs: Map<string, WorkflowRun>): T {
  const deps = {
    runs,
    // status/abort 路径只触 store.stateFilePath（RunSummary 宿主扩展字段）
    store: { stateFilePath: (runId: string) => `/state/${runId}.jsonl` },
    registry: { get: vi.fn(), getPath: vi.fn(), loadAll: vi.fn(), invalidate: vi.fn() },
  };
  const guard: ReentryGuardRef = { isProcessing: false };
  return captureTool<T>(
    (pi) => registerWorkflowTool(pi as never, deps as never, guard),
    "workflow",
  );
}

/** 真实 WorkflowRun 聚合根（reconstruct 工厂——status/abort 路径只读投影面）。 */
function makeRun(opts: {
  runId: string;
  scriptName: string;
  status: "running" | "done";
  reason?: DoneReason;
  error?: string;
  startedAt: string;
  completedAt?: string;
}): WorkflowRun {
  const run = WorkflowRun.reconstruct(
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
  // [D6(a) 第 1 步] 终局判定源 = 终局记录注册表：done 形态 fixture 建模「重水合
  // done run」时必须携带注册表条目（生产 = 壳重建点 noteRebuiltSettlement 注入
  // run-settled 帧事实；settledAt = 快照 completedAt = 帧时序）。
  if (opts.status === "done") {
    noteRebuiltSettlement(opts.runId, {
      outcome: doneReasonToRunOutcome(opts.reason ?? "completed"),
      settledAt: opts.completedAt !== undefined ? Date.parse(opts.completedAt) : 0,
    });
  }
  return run;
}

describe("actionStatus 输出形态（LLM 可见文本锁）", () => {
  // ── 墙钟 fixture（fake timers 钉死 Date.now，elapsed 全确定性；
  //    收窄进本 describe——不泄漏到 run/abort 路径）──
  const FAKE_NOW = new Date("2026-01-01T00:00:30.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers({ now: FAKE_NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs 为空 → 固定空态文案 + 空 runs details", async () => {
    const tool = captureRegisteredTool<StatusToolView>(new Map());
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
    const tool = captureRegisteredTool<StatusToolView>(runs);
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

// ── details 不含 GUI 描述符（isWorkflow 块分支恒折叠单行不消费 __gui__，构造即
//    死代码——D8 裁决，execute 级不 attach）──

describe("details 形状（execute 级无 GUI attach）", () => {
  it("RPC ctx → details 不含 __gui__ 键（workflow tool 不构造 GUI 描述符）", async () => {
    const tool = captureRegisteredTool<Record<string, unknown>>(new Map());
    const r = await tool.execute("id", { action: "status" }, undefined, undefined, {
      mode: "rpc",
      hasUI: true,
    });
    expect(Object.keys(r.details as object)).not.toContain("__gui__");
  });
});

// ══════════════════════════════════════════════════════════════
// W4b 错误路径 throw 语义（原 tool-workflow-throw-paths.test.ts）
// ══════════════════════════════════════════════════════════════

/** throw-paths 专用 capture wrapper（差异面：deps 实参 + reentry guard 可注入占用态）。 */
function captureWorkflowTool(deps: unknown, reentryRef: ReentryGuardRef): CapturedTool {
  return captureTool(
    (pi) => registerWorkflowTool(pi as never, deps as never, reentryRef),
    "workflow",
  );
}

/** 平铺检测 / slug 护栏路径的 registry script stub（meta.parameters 驱动已知键集）。 */
function scriptRegistry(parameters?: object): Record<string, unknown> {
  return stubRegistry({
    getPath: vi.fn().mockResolvedValue(makeScript("demo-wf", "/abs/demo-wf.js", parameters)),
  });
}

describe("W4b: workflow tool 错误路径 throw 语义", () => {
  it("not_found：abort 目标 runId 不存在 → throw（pi catch 后置 isError:true）", async () => {
    const tool = captureWorkflowTool(makeDeps(stubRegistry()), { isProcessing: false });
    await expect(
      tool.execute("id", { action: "abort", runId: "no-such-run" }, undefined, undefined, {}),
    ).rejects.toThrow(
      "Workflow 'no-such-run' not found. Use action:status to list active runs and their runIds.",
    );
  });

  it("W4c not_found：run 目标路径不可读（getPath 返回 available:false stub 而非 undefined）→ throw，不假启动", async () => {
    // config-loader.toCachedMeta 对不存在/不可读文件返回 available:false 的空壳实体
    // （非 undefined）——旧判定仅 !script 绕过 not_found，空 sourceCode 的 run 假启动
    // （W4b verifier 探针实测复现）。registry 层真行为见 config-loader.ts:143-151。
    const deps = makeDeps(
      stubRegistry({
        getPath: vi.fn().mockResolvedValue({
          name: "ghost-wf",
          path: "/tmp/no-such-workflow.js",
          available: false,
          sourceCode: "",
          meta: { description: "", parameters: undefined },
          toExecutable: () => "",
        }),
      }),
    );
    const tool = captureWorkflowTool(deps, { isProcessing: false });
    await expect(
      tool.execute("id", { action: "run", name: "/tmp/no-such-workflow.js" }, undefined, undefined, {}),
    ).rejects.toThrow("Workflow '/tmp/no-such-workflow.js' not found.");
    // 未假启动：runs 注册表不出现该 run
    expect(deps.runs).toBeInstanceOf(Map);
    expect((deps.runs as Map<string, unknown>).size).toBe(0);
  });

  it("reentry-busy：guard 占用 → throw REENTRY_BUSY_MESSAGE，且 guard 状态不被污染", async () => {
    const guard: ReentryGuardRef = { isProcessing: true };
    const tool = captureWorkflowTool(makeDeps(stubRegistry()), guard);
    await expect(
      tool.execute("id", { action: "status" }, undefined, undefined, {}),
    ).rejects.toThrow(REENTRY_BUSY_MESSAGE);
    // throw 发生在 acquire 之前——占用方语义保持，不产生双重 release
    expect(guard.isProcessing).toBe(true);
  });

  it("平铺检测：args 子字段提到顶层 → throw 'Detected ... at top level'（含 Correct 正例）", async () => {
    const deps = makeDeps(
      scriptRegistry({
        type: "object",
        properties: { task: { type: "string" }, items: { type: "array" } },
        required: ["task"],
      }),
    );
    const tool = captureWorkflowTool(deps, { isProcessing: false });
    await expect(
      tool.execute(
        "id",
        { action: "run", name: "/abs/demo-wf.js", task: "do work" },
        undefined,
        undefined,
        {},
      ),
    ).rejects.toThrow(
      /Detected task at top level — they belong inside 'args'\. Correct: \{"action":"run","name":"\/abs\/demo-wf\.js","args":\{"task": "<value>"\}\}/,
    );
  });

  it("slug 护栏：slug 超 SLUG_MAX_LENGTH → throw 'slug exceeds ...'（运行时第二道）", async () => {
    const deps = makeDeps(
      scriptRegistry({
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
      }),
    );
    const tool = captureWorkflowTool(deps, { isProcessing: false });
    const longSlug = "a".repeat(SLUG_MAX_LENGTH + 1);
    await expect(
      tool.execute(
        "id",
        { action: "run", name: "/abs/demo-wf.js", slug: longSlug, args: {} },
        undefined,
        undefined,
        {},
      ),
    ).rejects.toThrow(
      `slug exceeds ${SLUG_MAX_LENGTH} chars (got ${longSlug.length}). Shorten to a kebab-case label, e.g. "fix-login", "extract-urls".`,
    );
  });

  it("OR-1 入口校验：time 超 setTimeout 上限 → throw 含上限 2147483647 与实际值，run 未启动", async () => {
    const deps = makeDeps(
      scriptRegistry({
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
      }),
    );
    const tool = captureWorkflowTool(deps, { isProcessing: false });
    // LLM 对「跑久一点」完全可能生成 1e12——超 2^31-1 的典型形态（schema Type.Number
    // 直通无上界，用户入口 fail-fast 不依赖 lifecycle 内层 assertSafeTimerDelay）
    await expect(
      tool.execute(
        "id",
        { action: "run", name: "/abs/demo-wf.js", args: { task: "do work" }, time: 1_000_000_000_000 },
        undefined,
        undefined,
        {},
      ),
    ).rejects.toThrow(
      "time budget 1000000000000 ms exceeds the maximum of 2147483647 ms (~24.8 days). Retry with a smaller \"time\", or omit it for unlimited.",
    );
    // fail-fast 于 runWorkflow 之前：runs 无条目（abortRun not found 语义保持）
    expect((deps.runs as Map<string, unknown>).size).toBe(0);
  });

  it.each([
    { field: "tokens", params: { tokens: -5 }, message: 'tokens budget -5 is negative. Retry with a positive "tokens", or omit it for unlimited.' },
    { field: "time", params: { time: -1 }, message: 'time budget -1 ms is negative. Retry with a positive "time", or omit it for unlimited.' },
  ] as const)(
    "负值 fail-fast：$field 为负 → throw 拒绝（不再静默升格 unlimited），run 未启动",
    async ({ params, message }) => {
      const deps = makeDeps(
        scriptRegistry({
          type: "object",
          properties: { task: { type: "string" } },
          required: ["task"],
        }),
      );
      const tool = captureWorkflowTool(deps, { isProcessing: false });
      await expect(
        tool.execute(
          "id",
          { action: "run", name: "/abs/demo-wf.js", args: { task: "do work" }, ...params },
          undefined,
          undefined,
          {},
        ),
      ).rejects.toThrow(message);
      // fail-fast 于 runWorkflow 之前：runs 无条目
      expect((deps.runs as Map<string, unknown>).size).toBe(0);
    },
  );

  it("throw 后 reentry guard 经 finally 正常释放（成功路径回归）", async () => {
    // abort not_found throw 穿透 execute try/finally：guard 必须复位，否则后续命令全部 busy
    const guard: ReentryGuardRef = { isProcessing: false };
    const tool = captureWorkflowTool(makeDeps(stubRegistry()), guard);
    await expect(
      tool.execute("id", { action: "abort", runId: "no-such-run" }, undefined, undefined, {}),
    ).rejects.toThrow(/not found/);
    expect(guard.isProcessing).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// D8 创建期模型拒单（原 tool-workflow-model-rejection.test.ts）
// ══════════════════════════════════════════════════════════════

/** D8 专用 deps：getPath 按 path 从给定 scripts 集解析（模型门之前的解析面）。 */
function depsWithScripts(scripts: Array<ReturnType<typeof makeScript>>): Record<string, unknown> {
  return makeDeps({
    get: vi.fn().mockResolvedValue(undefined),
    getPath: vi.fn(async (ref: string) => scripts.find((s) => s.path === ref) ?? undefined),
    loadAll: vi.fn().mockResolvedValue(scripts),
  });
}

function setCatalogService(entries: Array<{ provider: string; id: string }>): void {
  setModelConfigService({
    initModel: vi.fn(),
    reloadGlobalConfig: vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } })),
    getModelRegistry: () => ({ getAvailable: () => entries }),
  } as never);
}

describe("D8 创建期模型拒单", () => {
  const SCRIPT = makeScript("chain", "/abs/chain.js");

  it("目录缺席（单例未装配）→ warn 降级跳过，不误拒（runWorkflow 正常到达）", async () => {
    // 本用例必须先于任何 setCatalogService 调用执行（声明序 = 执行序）——
    // setModelConfigService 无复位面，单例 set 后 null 分支不可再达。
    const deps = depsWithScripts([SCRIPT]);
    await actionRun(
      { action: "run", name: "/abs/chain.js", args: {}, model: "prov1/typo" } as never,
      deps as never,
      undefined,
    );
    expect(vi.mocked(runWorkflow)).toHaveBeenCalledTimes(1);
  });

  it("目录查无 → 同步 throw 分类化文案 + 可用清单，零 run 创建", async () => {
    setCatalogService([
      { provider: "prov1", id: "good-a" },
      { provider: "prov2", id: "solo" },
    ]);
    const deps = depsWithScripts([SCRIPT]);
    const err = await actionRun(
      { action: "run", name: "/abs/chain.js", args: {}, model: "prov1/typo" } as never,
      deps as never,
      undefined,
    ).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("not in the pi engine model catalog");
    expect(err.message).toContain("prov1/good-a");
    expect(err.message).toContain("prov2/solo");
    expect(err.message).toContain("Recovery:");
    // 零 spawn（拒单先于 runWorkflow）
    expect(vi.mocked(runWorkflow)).not.toHaveBeenCalled();
  });

  it("provider 漂移 → 拒单文案含配置恢复指引（models.json）", async () => {
    setCatalogService([{ provider: "prov1", id: "good-a" }]);
    const deps = depsWithScripts([SCRIPT]);
    const err = await actionRun(
      { action: "run", name: "/abs/chain.js", args: {}, model: "retired/m1" } as never,
      deps as never,
      undefined,
    ).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("provider configuration drift");
    expect(err.message).toContain("models.json under the pi agent dir");
    expect(vi.mocked(runWorkflow)).not.toHaveBeenCalled();
  });

  it("目录命中 → 模型门放行，model 透传进 RunSpec（runWorkflow 收到）", async () => {
    setCatalogService([{ provider: "prov1", id: "good-a" }]);
    const deps = depsWithScripts([SCRIPT]);
    await actionRun(
      { action: "run", name: "/abs/chain.js", args: {}, model: "prov1/good-a" } as never,
      deps as never,
      undefined,
    );

    expect(vi.mocked(runWorkflow)).toHaveBeenCalledTimes(1);
    const spec = vi.mocked(runWorkflow).mock.calls[0][0] as Record<string, unknown>;
    expect(spec.model).toBe("prov1/good-a");
  });
});

// ══════════════════════════════════════════════════════════════
// D4-1 按名解析退役 + 文案全文锚定（原 tool-workflow-run-builtin-name.test.ts）
// ══════════════════════════════════════════════════════════════

// ── fixture：可用 workflow 脚本（@pi-meta 新格式，无参数声明） ──

const CHAIN_META = `/* @pi-meta
name: chain
description: 内置名测试用三步链
phases: [a, b]
*/
const agent = require("./agent");
agent("w", { task: $ARGS.task });
`;

describe("D4-1 按名解析退役（fake registry）", () => {
  it("裸名（旧内置名 chain，get 可命中）→ not_found 拒单；registry.get 零调用（机制删除）", async () => {
    const chain = makeScript("chain", "/builtin/workflows/chain.js");
    const registry = stubRegistry({
      // get 仍能命中（registry 层机制未删——退役的是 actionRun 的按名解析通道）
      get: vi.fn().mockResolvedValue(chain),
      getPath: vi.fn().mockResolvedValue(undefined),
      loadAll: vi.fn().mockResolvedValue([chain]),
    });
    const err = await actionRun(
      { action: "run", name: "chain" } as never,
      makeDeps(registry) as never,
      undefined,
    ).catch((e: unknown) => e as Error);

    // 退役断言：get 零调用 = 裸名不进入按名通道（P5 修复发现面后也不会复活）
    expect(registry.get).not.toHaveBeenCalled();
    expect(registry.getPath).toHaveBeenCalledWith("chain");
    expect(vi.mocked(runWorkflow)).not.toHaveBeenCalled();
    // 拒单文案：清单逐条附 location（唯一自救路径）
    expect(err.message).toContain(
      "Workflow 'chain' not found. Available (name — use the absolute location path as 'name' when the bare name is rejected):",
    );
    expect(err.message).toContain("    location: /builtin/workflows/chain.js");
  });

  it("路径引用 → getPath 命中即启动（现行为零变化）", async () => {
    const byPath = makeScript("demo", "/abs/demo.js");
    const registry = stubRegistry({
      getPath: vi.fn().mockResolvedValue(byPath),
      loadAll: vi.fn().mockResolvedValue([byPath]),
    });
    await actionRun(
      { action: "run", name: "/abs/demo.js" } as never,
      makeDeps(registry) as never,
      undefined,
    );

    expect(registry.getPath).toHaveBeenCalledWith("/abs/demo.js");
    expect(vi.mocked(runWorkflow)).toHaveBeenCalledTimes(1);
    const spec = vi.mocked(runWorkflow).mock.calls[0][0] as Record<string, unknown>;
    expect(spec.scriptName).toBe("demo");
  });

  it("getPath 返回 available:false 的 stub → 不启动，走 not_found 报错（W4c 口径不回退）", async () => {
    const ghost = { ...makeScript("ghost", "/builtin/ghost.js"), available: false };
    const registry = stubRegistry({
      getPath: vi.fn().mockResolvedValue(ghost),
    });
    await expect(
      actionRun(
        { action: "run", name: "ghost" } as never,
        makeDeps(registry) as never,
        undefined,
      ),
    ).rejects.toThrow(/Workflow 'ghost' not found\./);
    expect(vi.mocked(runWorkflow)).not.toHaveBeenCalled();
  });

  it("未知名 → 报错含建议清单且逐条附绝对路径 location（全路径自救指引）", async () => {
    const registry = stubRegistry({
      loadAll: vi.fn().mockResolvedValue([makeScript("chain", "/builtin/workflows/chain.js")]),
    });
    const err = await actionRun(
      { action: "run", name: "no-such" } as never,
      makeDeps(registry) as never,
      undefined,
    ).catch((e: unknown) => e as Error);
    // 逐条 location：按名解析已退役，location 是唯一可派发形态，失败一次即自救。
    expect(err.message).toContain(
      "Workflow 'no-such' not found. Available (name — use the absolute location path as 'name' when the bare name is rejected):",
    );
    expect(err.message).toContain("  - chain: chain workflow");
    expect(err.message).toContain("    location: /builtin/workflows/chain.js");
  });
});

describe("D4-1 按名解析退役（真 registry：WorkflowScriptRegistryImpl + 真实发现链）", () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "d4-ref-bare-"));
    // WorkflowScanConfig 布局：projectDir = <fixture>/ws/.pi/workflows（反推 workspaceRoot）
    const projectDir = join(fixtureDir, "ws", ".pi", "workflows");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "chain.js"), CHAIN_META, "utf-8");
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("真发现链里名字存在也拒：裸名 'chain' → not_found（拒的是解析机制本身）", async () => {
    const registry = new WorkflowScriptRegistryImpl({
      projectDir: join(fixtureDir, "ws", ".pi", "workflows"),
      userDir: join(fixtureDir, "user", "workflows"),
      tmpDir: join(fixtureDir, "ws", ".pi", "workflows", ".tmp"),
      npmDirs: [],
    });
    // 前置自检：fixture 布局可被扫描（隔离 config 下 hostRoots 为空、仅 project 根命中）
    // ——名字确实在发现面内，拒单非「不可见」而是「按名通道退役」。
    const all = await registry.loadAll();
    expect(all.filter((w) => w.available).map((w) => w.name)).toContain("chain");

    await expect(
      actionRun(
        { action: "run", name: "chain" } as never,
        makeDeps(registry as unknown as Record<string, unknown>) as never,
        undefined,
      ),
    ).rejects.toThrow(/Workflow 'chain' not found\./);
    expect(vi.mocked(runWorkflow)).not.toHaveBeenCalled();
  });

  it("location 全路径 → 正常启动（真 registry 下唯一可派发形态）", async () => {
    const registry = new WorkflowScriptRegistryImpl({
      projectDir: join(fixtureDir, "ws", ".pi", "workflows"),
      userDir: join(fixtureDir, "user", "workflows"),
      tmpDir: join(fixtureDir, "ws", ".pi", "workflows", ".tmp"),
      npmDirs: [],
    });
    const result = await actionRun(
      { action: "run", name: join(fixtureDir, "ws", ".pi", "workflows", "chain.js") } as never,
      makeDeps(registry as unknown as Record<string, unknown>) as never,
      undefined,
    );

    expect(vi.mocked(runWorkflow)).toHaveBeenCalledTimes(1);
    const spec = vi.mocked(runWorkflow).mock.calls[0][0] as Record<string, unknown>;
    expect(spec.scriptName).toBe("chain");
    expect(String(spec.scriptPath)).toContain("chain.js");
    expect(result.content[0]?.text).toContain("Started workflow 'chain'");
  });

  it("fixture 卫生断言：fixture 目录无其他 .js 泄漏（避免 discoverWorkflows 误扫）", () => {
    const projectDir = join(fixtureDir, "ws", ".pi", "workflows");
    expect(readdirSync(projectDir).filter((f) => f.endsWith(".js"))).toEqual(["chain.js"]);
  });
});

// ══════════════════════════════════════════════════════════════
// LLM 直接消费文案全文锚定（第四轮架构审查 Strong 项）。
//
// run 启动文案（防轮询段）与 abort 转移文案此前零锚定——重构/顺手清理改写无红灯。
// 本节逐字锁 LLM 看到的 content[0].text（期望值从 tool-workflow.ts 实现逐字复制）。
// abort 的终态语义（done/aborted 由 lifecycle transition 落位）归 core lifecycle
// 测试；此处 mock abortRun 仅落位 state（actionAbort 从 run 对象读转移前后状态
// 拼接文案的真实行为面不变）。
// ══════════════════════════════════════════════════════════════

describe("run 启动文案全文锚定（LLM 可见文本锁）", () => {
  /** fake registry：getPath 命中 demo script（无参数声明——平铺检测跳过）。 */
  function demoRegistry(): Record<string, unknown> {
    return stubRegistry({
      getPath: vi.fn().mockResolvedValue(makeScript("demo", "/abs/demo.js")),
    });
  }

  it("含 slug → 'name · slug (runId)' + 防轮询段（逐字 toBe）", async () => {
    const result = await actionRun(
      { action: "run", name: "/abs/demo.js", slug: "tri-review" } as never,
      makeDeps(demoRegistry()) as never,
      undefined,
    );
    // runId 来自顶层 beforeEach 的 runWorkflow mockResolvedValue("run-id-1")
    expect(result.content[0]?.text).toBe(
      "Started workflow 'demo' · tri-review (run-id-1). Running in background — DO NOT bash sleep or poll status; results are auto-delivered via notifyDone.",
    );
  });

  it("不含 slug → 'name (runId)' 无 · 段（逐字 toBe）", async () => {
    const result = await actionRun(
      { action: "run", name: "/abs/demo.js" } as never,
      makeDeps(demoRegistry()) as never,
      undefined,
    );
    expect(result.content[0]?.text).toBe(
      "Started workflow 'demo' (run-id-1). Running in background — DO NOT bash sleep or poll status; results are auto-delivered via notifyDone.",
    );
  });
});

// ── run details.stateFile 暴露（原 workflow-state-file-exposure.test.ts 第 3 条，
//    grep 断言改行为级等值；前 2 条类型/来源 grep 已由上方 status details 的
//    stateFile 逐字段断言三合一覆盖）──

describe("run details.stateFile = store.stateFilePath(runId)（行为级等值）", () => {
  it("actionRun 返回的 details.stateFile 等于同一 store 对该 runId 的 stateFilePath 返回值", async () => {
    const storeRef = { stateFilePath: (id: string) => `/tmp/state/${id}.jsonl` };
    const deps = {
      ...makeDeps(
        stubRegistry({
          getPath: vi.fn().mockResolvedValue(makeScript("demo", "/abs/demo.js")),
        }),
      ),
      store: storeRef,
    };
    const result = await actionRun(
      { action: "run", name: "/abs/demo.js" } as never,
      deps as never,
      undefined,
    );

    const details = result.details as Record<string, unknown> | undefined;
    expect(details).toBeDefined();
    expect(details?.stateFile).toBe(storeRef.stateFilePath(String(details?.runId)));
  });
});

describe("abort 转移文案全文锚定（LLM 可见文本锁）", () => {
  type AbortResult = {
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown> | undefined;
  };

  type AbortToolView = CapturedTool & {
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<AbortResult>;
  };

  /** mock abortRun 落位终态（模拟 lifecycle transition 语义：status=done + 可选 reason）。
   *  `settle: false` = abort 未产生终局记录（换源后 run 保持 running 投影）。 */
  function stubAbortTransition(opts: { reason?: string; settle?: boolean }): void {
    vi.mocked(abortRun).mockReset();
    vi.mocked(abortRun).mockImplementation(async (runId, deps) => {
      const run = deps.runs.get(runId);
      if (run && (opts.settle ?? true)) {
        run.state.status = "done";
        run.state.reason = opts.reason;
        // [D6(a) 第 1 步] 终局判定源 = 终局记录注册表：stub 直改状态须同步注入终局
        // 事实（生产 abortRun 经 dispatch 链 note）——否则 runSummary 投影回退 running。
        noteRebuiltSettlement(runId, { outcome: "cancelled", settledAt: Date.now() });
      }
    });
  }

  it("running run → abort → 'running → done (aborted)'（reason 后缀拼接形态）", async () => {
    stubAbortTransition({ reason: "aborted" });
    const run = makeRun({
      runId: "wf-1719500000000-a1b2c3",
      scriptName: "demo-wf",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const tool = captureRegisteredTool<AbortToolView>(new Map([[run.runId, run]]));

    const r = await tool.execute("id", { action: "abort", runId: run.runId }, undefined, undefined, {});
    expect(r.content[0]?.text).toBe("Workflow 'demo-wf' (wf-1719500000000-a1b2c3): running → done (aborted)");
    expect(r.details).toMatchObject({ action: "abort", runId: run.runId, status: "done", reason: "aborted" });
  });

  it("无终局记录 → 转移段无后缀（reasonSuffix 条件拼接；[D6(a) 第 1 步] 换源后「未终局」不再投影 done/reason）", async () => {
    // 换源前本用例靠「聚合 done 而注册表 miss」造出 done+无 reason 形态——该形态随
    // R6 判据换源消失（done ⟺ 注册表有条目 ⟺ reason 由 (outcome,errorCode) 恒派生）。
    // 现锁同一条拼接分支的可达形态：无终局记录 = 未终局，status 与 reason 都不投影。
    stubAbortTransition({ settle: false });
    const run = makeRun({
      runId: "wf-1719600000000-z9y8x7",
      scriptName: "cleanup-wf",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const tool = captureRegisteredTool<AbortToolView>(new Map([[run.runId, run]]));

    const r = await tool.execute("id", { action: "abort", runId: run.runId }, undefined, undefined, {});
    expect(r.content[0]?.text).toBe("Workflow 'cleanup-wf' (wf-1719600000000-z9y8x7): running → running");
    expect(r.details).toMatchObject({ action: "abort", runId: run.runId, status: "running" });
  });
});

// ══════════════════════════════════════════════════════════════
// 宿主 reservedKeys 接线锚（原 detectors.test.ts TC3i，M-3 回归唯一红灯）。
//
// D9 下沉后权威实现在 core args-meta：宿主差异（TOOL_TOP_LEVEL 撞名保护）经
// reservedKeys 注入。core 侧 args-meta.test.ts 用 core 自己的常量锁行为等值，
// 本 describe 锁「tool-workflow.ts 导出的 TOOL_TOP_LEVEL 真实注入」这一宿主接线
// （TOOL_TOP_LEVEL 漏注入/漂移时只有此条会红）。
// ══════════════════════════════════════════════════════════════

/** 真实参数 meta（@pi-meta parameters——与 core args-meta.test.ts 同源防漂移）。 */
function rflParams(): object {
  const src = readFileSync(
    join(
      __dirname,
      "../../../node_modules/@zhushanwen/subagent-core/workflows/review-fix-loop.js",
    ),
    "utf-8",
  );
  const meta = parseResourceMeta(src, "workflow");
  if (!meta || meta.kind !== "workflow" || !meta.parameters) throw new Error("rfl meta");
  return meta.parameters;
}

describe("TC3i: 宿主 TOOL_TOP_LEVEL reservedKeys 接线锚（M-3 回归）", () => {
  // 宿主 reservedKeys 注入（与 tool-workflow ARGS_META_OPTIONS 等值契约）
  const OPT = { reservedKeys: TOOL_TOP_LEVEL };

  it("tool 顶层键不误报——argKeysFromMeta 经宿主 OPT 注入排除撞名键", () => {
    // 合成 parameters：workflow 声明参数 name（tool 键撞名）——argKeysFromMeta 必须排除
    const synthetic = {
      type: "object",
      properties: { name: { type: "string" }, task: { type: "string" } },
      required: ["name"],
    };
    const keys = argKeysFromMeta(synthetic, OPT);
    expect(keys.exact.has("task")).toBe(true);
    expect(keys.exact.has("name")).toBe(false); // TOOL_TOP_LEVEL 排除（M-3 真回归锁定）
    // 合法调用不误报
    expect(
      findFlattenedArgKeys(
        { action: "run", name: "mywf", args: { name: "x" } },
        synthetic,
        OPT,
      ),
    ).toEqual([]);
    // 真实 meta 不含 name（探针实测 16 键）——附加验证
    expect(argKeysFromMeta(rflParams(), OPT).exact.has("name")).toBe(false);
  });
});
