// src/interface/__tests__/tool-subagents.test.ts
//
// u2 契约测试：`subagents` 批量 tool（schema 平铺 D2 / handler 转译 D3 / 错误规格 D9 /
// 集合收录 D1 / 渲染不构造 __gui__ D8）。
//
// 三视角（docs/TEST-STRATEGY.md §3）：
// - 构建者（白盒）：注册面 schema 形态（顶层键集/类型/必填形态）+ 转译 spec 组装。
// - 使用者（黑盒）：模型看到的 tool description/guidelines 分工句；execute 的返回文案
//   （一条通知 + 单次 status 恢复出口 + abort 指引）与错误文案（Correct 示例）。
// - 观察者（真值源）：packages/shared/src/constants.ts 真模块（集合收录 SSOT）——
//   动态 import 真文件，不用文本断言。
//
// mock 策略：lifecycle 深路径 stub（runWorkflow 为 vi.fn——不起真 Worker、真 worker
// 线程只验证转译与 spec 组装）；registry/store 用最小 stub。框架：vitest（禁 node:test）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 桩化 lifecycle——runWorkflow 为 vi.fn（只测入口转译面，不起 Worker）。 */
vi.mock("@zhushanwen/subagent-core/orchestration/lifecycle.ts", () => ({
  runWorkflow: vi.fn(),
  abortRun: vi.fn(),
}));

import { runWorkflow } from "@zhushanwen/subagent-core/orchestration/lifecycle.ts";
import { MAX_TIMER_DELAY_MS, SLUG_MAX_LENGTH } from "@zhushanwen/subagent-core";
import {
  FAN_OUT_SCRIPT_NAME,
  generateBatchSlug,
  registerSubagentsTool,
  runSubagentsBatch,
} from "../tool-subagents.ts";
import { REENTRY_BUSY_MESSAGE, type ReentryGuardRef } from "../reentry-guard.ts";
import { captureTool } from "./capture-tool.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_SRC = readFileSync(join(__dirname, "../tool-subagents.ts"), "utf-8");

// ── 注册面最小类型（单层 cast：目标类型全必填，非 no-unsafe-cast 命中的全可选结构断言）──

interface CapturedProperty {
  type?: string;
  optional?: boolean;
}

interface SubagentsToolView {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: { type?: string; properties: Record<string, CapturedProperty> };
  execute: (
    toolCallId: string,
    params: unknown,
    signal: undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
  renderCall: (args: Record<string, unknown>, theme: ThemeStub, ctx?: unknown) => { render(width: number): string[] };
  renderResult: (result: { content?: Array<{ type: string; text?: string }> }, options: unknown, theme: ThemeStub) => { render(width: number): string[] };
}

interface ThemeStub {
  fg(token: string, text: string): string;
  bold(text: string): string;
}

/** 注册并取回 tool 定义（fake pi 捕获单点见 capture-tool.ts；此处只留差异面）。 */
function captureSubagentsTool(
  reentryRef: ReentryGuardRef,
  registry: Record<string, unknown>,
): SubagentsToolView {
  return captureTool<SubagentsToolView>(
    (pi) => registerSubagentsTool(pi as never, makeDeps(registry) as never, reentryRef),
  );
}

// ── registry / deps stubs ──

/** fan-out 执行体 stub（toExecutable 形态与真 WorkflowScript 同签名）。 */
function makeFanOutScript() {
  return {
    name: FAN_OUT_SCRIPT_NAME,
    path: "/builtin/workflows/fan-out.js",
    available: true,
    sourceCode: "// fan-out source",
    meta: {
      description: "N 个已知独立任务并行派发并全量收集",
      parameters: { type: "object", properties: { tasks: { type: "array" } } },
    },
    toExecutable: () => "// fan-out executable",
  };
}

function makeRegistry(script?: ReturnType<typeof makeFanOutScript>): Record<string, unknown> {
  return {
    get: vi.fn().mockResolvedValue(script ?? makeFanOutScript()),
    getPath: vi.fn().mockResolvedValue(undefined),
    loadAll: vi.fn().mockResolvedValue([script ?? makeFanOutScript()]),
    invalidate: vi.fn(),
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

// ── theme stub（renderCall 只用 fg/bold）──

function makeTheme(): ThemeStub {
  return {
    fg: (token, text) => `<${token}>${text}</${token}>`,
    bold: (text) => `<b>${text}</b>`,
  };
}

/** 取 TUI 组件构造时传入的文本（Text mock 把首参存为实例字段）。 */
function renderedText(component: { render(width: number): string[] }): string {
  const obj: Record<string, unknown> = component as unknown as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

// ── 真值源：packages/shared/src/constants.ts（集合收录 SSOT）──

interface SharedConstantsModule {
  WORKFLOW_TOOL_NAMES: ReadonlySet<string>;
  SUBAGENT_TOOL_NAMES: ReadonlySet<string>;
}

/** 动态 import 真 constants 模块（文本断言会漏「值被改」的漂移，故取真值）。 */
async function loadSharedConstants(): Promise<SharedConstantsModule> {
  const url = pathToFileURL(join(__dirname, "../../../../../../packages/shared/src/constants.ts")).href;
  const mod: Record<string, unknown> = await import(/* @vite-ignore */ url);
  const workflows = mod.WORKFLOW_TOOL_NAMES;
  const subagents = mod.SUBAGENT_TOOL_NAMES;
  if (!(workflows instanceof Set) || !(subagents instanceof Set)) {
    throw new Error("packages/shared/src/constants.ts 缺 WORKFLOW_TOOL_NAMES / SUBAGENT_TOOL_NAMES 集合导出");
  }
  return { WORKFLOW_TOOL_NAMES: workflows, SUBAGENT_TOOL_NAMES: subagents };
}

// ── 公共夹具 ──

const TWO_TASKS = ["count .ts files under src", "count .md files under src"];

beforeEach(() => {
  vi.mocked(runWorkflow).mockReset();
  vi.mocked(runWorkflow).mockResolvedValue("wf-1700000000000-abcd");
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 取最近一次 runWorkflow 的 spec（vi.fn 调用记录）。 */
function lastSpec(): Record<string, unknown> {
  expect(vi.mocked(runWorkflow)).toHaveBeenCalledTimes(1);
  const call = vi.mocked(runWorkflow).mock.calls[0];
  return call[0] as unknown as Record<string, unknown>;
}

// ══════════════════════════════════════════════════════════════
describe("schema 契约：一跳扁平 + tasks 必填（D2）", () => {
  it("注册名/label/description 存在，且以 batch 语义自述（one-shot 成员 + 一条通知）", () => {
    const tool = captureSubagentsTool({ isProcessing: false }, makeRegistry());
    expect(tool.name).toBe("subagents");
    expect(tool.label.length).toBeGreaterThan(0);
    expect(tool.description).toContain("one-shot batch member");
    expect(tool.description).toContain("ONE notification");
    // 分工句（D5①）：单数 tool 指路 + 依赖链场景指路 workflow
    expect(tool.description).toContain("`subagent` tool");
    expect(tool.description).toContain("`workflow` tool");
  });

  it("参数全平铺：无 action 分发、无 args 嵌套、无嵌套 object 参数", () => {
    const tool = captureSubagentsTool({ isProcessing: false }, makeRegistry());
    const keys = Object.keys(tool.parameters.properties);
    expect(keys.sort()).toEqual(
      ["agents", "aggregate", "model", "slug", "tasks", "thinkingLevel", "time", "tokens"].sort(),
    );
    expect(keys).not.toContain("action");
    expect(keys).not.toContain("args");
    for (const key of keys) {
      expect(["string", "number", "boolean", "array"]).toContain(tool.parameters.properties[key]?.type);
    }
  });

  it("tasks 为必填形态（未经 Type.Optional 构造）且类型为数组", () => {
    const tool = captureSubagentsTool({ isProcessing: false }, makeRegistry());
    expect(tool.parameters.properties.tasks?.type).toBe("array");
    // mock typebox 的 Optional 标记：tasks 不得带该标记（真 typebox 下即 required）
    expect(tool.parameters.properties.tasks?.optional).toBeUndefined();
    // 源码级：tasks 未经 Type.Optional 包裹（防 mock 失真面丢失 required 语义）
    expect(TOOL_SRC).toContain("tasks: Type.Array(");
    expect(TOOL_SRC).not.toContain("Type.Optional(Type.Array(");
  });

  it("slug 走 SLUG_MAX_LENGTH 上界（schema 第一道关卡 + 运行时第二道）", () => {
    expect(TOOL_SRC).toContain("maxLength: SLUG_MAX_LENGTH");
    expect(TOOL_SRC).toContain("SLUG_MAX_LENGTH");
  });

  it("文件头与 interface/subagents.ts（/subagents 命令壳）互指防混淆", () => {
    expect(TOOL_SRC).toContain("interface/subagents.ts");
    // 指认对面是 slash 命令（同名不同命名空间）
    expect(TOOL_SRC.toLowerCase()).toContain("slash");
  });

  it("不构造 details.__gui__（D8：isWorkflow 块分支恒折叠不消费，构造即死代码）", () => {
    // 文件头注释会提到 __gui__（记录 D8 裁决），故断言构造面：无 GUI 协议依赖 +
    // 无描述符构造（属性赋值/工厂调用）。
    expect(TOOL_SRC).not.toContain("@zhushanwen/extension-protocol");
    expect(TOOL_SRC).not.toContain("__gui__:");
    expect(TOOL_SRC).not.toContain("guiResult(");
    expect(TOOL_SRC).not.toContain("isGuiCapable");
  });

  it("promptGuidelines 含分工句/调用正例/预算默认（弱模型结构信号依赖面）", () => {
    const tool = captureSubagentsTool({ isProcessing: false }, makeRegistry());
    const guidelines = tool.promptGuidelines.join("\n");
    expect(guidelines).toContain("2+ independent tasks in one dispatch");
    expect(guidelines).toContain('{"tasks":[');
    expect(guidelines).toContain("Do NOT set tokens/time unless the user explicitly requests");
    expect(guidelines).toContain("workflow tool");
  });
});

// ══════════════════════════════════════════════════════════════
describe("handler 转译：runWorkflow('fan-out') 确定性映射（D3）", () => {
  it("全参数调用 → spec 逐字段映射（scriptSource/budget/slug/model/thinkingLevel/args）", async () => {
    const registry = makeRegistry();
    const result = await runSubagentsBatch(
      {
        tasks: TWO_TASKS,
        agents: "/abs/security.md,/abs/perf.md",
        aggregate: true,
        slug: "foo-tri-review",
        model: "zai-coding-cn/glm-5.3-flash",
        thinkingLevel: "max",
        tokens: 100000,
        time: 600000,
      },
      makeDeps(registry) as never,
      undefined,
    );

    expect(registry.get).toHaveBeenCalledWith(FAN_OUT_SCRIPT_NAME);
    const spec = lastSpec();
    expect(spec.scriptSource).toBe("// fan-out executable");
    expect(spec.scriptName).toBe(FAN_OUT_SCRIPT_NAME);
    expect(spec.scriptPath).toBe("/builtin/workflows/fan-out.js");
    expect(spec.parameters).toEqual({ type: "object", properties: { tasks: { type: "array" } } });
    expect(spec.args).toEqual({
      tasks: TWO_TASKS,
      agents: "/abs/security.md,/abs/perf.md",
      aggregate: true,
    });
    expect(spec.budgetTokens).toBe(100000);
    expect(spec.budgetTimeMs).toBe(600000);
    expect(spec.slug).toBe("foo-tri-review");
    expect(spec.model).toBe("zai-coding-cn/glm-5.3-flash");
    expect(spec.thinkingLevel).toBe("max");
    // details：无 __gui__，携带 runId/stateFile（程序化消费面）
    expect(Object.keys(result.details)).not.toContain("__gui__");
    expect(result.details).toMatchObject({
      runId: "wf-1700000000000-abcd",
      status: "running",
      scriptName: FAN_OUT_SCRIPT_NAME,
      slug: "foo-tri-review",
      taskCount: 2,
      stateFile: "/tmp/state/wf-1700000000000-abcd.jsonl",
    });
  });

  it("缺省参数不写入 args（不制造「都传/都缺」歧义形态）+ 预算缺省 undefined", async () => {
    await runSubagentsBatch({ tasks: TWO_TASKS }, makeDeps(makeRegistry()) as never, undefined);
    const spec = lastSpec();
    expect(spec.args).toEqual({ tasks: TWO_TASKS });
    expect(spec.budgetTokens).toBeUndefined();
    expect(spec.budgetTimeMs).toBeUndefined();
    expect(spec.model).toBeUndefined();
    expect(spec.thinkingLevel).toBeUndefined();
  });

  it("返回文案：一条通知 + 单次 status 恢复出口 + abort 指引（设计 §3.1 全文）", async () => {
    const result = await runSubagentsBatch(
      { tasks: TWO_TASKS, slug: "foo-tri-review" },
      makeDeps(makeRegistry()) as never,
      undefined,
    );
    const text = result.content[0].text;
    expect(text).toContain("Started batch 'foo-tri-review' (wf-1700000000000-abcd) as workflow run 'fan-out' — 2 subagents dispatched in parallel (allSettled).");
    expect(text).toContain("Results arrive as ONE notification when the run settles. Do NOT poll.");
    expect(text).toContain("make a SINGLE status check: workflow tool with runId wf-1700000000000-abcd (recovery exit, not a poll loop).");
    expect(text).toContain("To abort: workflow tool, action abort, runId wf-1700000000000-abcd");
    // status/abort 不复制：本 tool 无 action 参数（schema 已断言），文案只指路 workflow tool
    expect(text).not.toContain('"action":"status"');
    expect(text).not.toContain('"action":"abort"');
  });
});

// ══════════════════════════════════════════════════════════════
describe("slug 缺省生成 fan-out-<时间短码>（D8 状态面辨识）", () => {
  it("generateBatchSlug 形态稳定且 ≤ SLUG_MAX_LENGTH(35)", () => {
    expect(generateBatchSlug(0)).toBe("fan-out-0");
    const slug = generateBatchSlug(1700000000000);
    expect(slug).toMatch(/^fan-out-[0-9a-z]+$/);
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
  });

  it("未提供 slug → spec.slug 为生成值（不是 undefined/空）", async () => {
    await runSubagentsBatch({ tasks: TWO_TASKS }, makeDeps(makeRegistry()) as never, undefined);
    expect(String(lastSpec().slug)).toMatch(/^fan-out-[0-9a-z]+$/);
  });

  it("空白 slug 按缺省处理；显式 slug 原样透传", async () => {
    await runSubagentsBatch({ tasks: TWO_TASKS, slug: "   " }, makeDeps(makeRegistry()) as never, undefined);
    expect(String(lastSpec().slug)).toMatch(/^fan-out-[0-9a-z]+$/);

    vi.mocked(runWorkflow).mockClear();
    await runSubagentsBatch({ tasks: TWO_TASKS, slug: "tri-review" }, makeDeps(makeRegistry()) as never, undefined);
    expect(lastSpec().slug).toBe("tri-review");
  });

  it("生成的 slug 出现在启动文案与 details（状态面/文本面可对账）", async () => {
    const result = await runSubagentsBatch({ tasks: TWO_TASKS }, makeDeps(makeRegistry()) as never, undefined);
    const generated = result.details.slug;
    expect(String(generated)).toMatch(/^fan-out-[0-9a-z]+$/);
    expect(result.content[0].text).toContain(`Started batch '${String(generated)}'`);
  });
});

// ══════════════════════════════════════════════════════════════
describe("错误规格（D9）", () => {
  it("tasks 缺失 → throw 带 Correct 示例（runWorkflow 未被调用）", async () => {
    const err = await runSubagentsBatch({} as never, makeDeps(makeRegistry()) as never, undefined)
      .catch((e: unknown) => e as Error);
    expect(err.message).toBe('subagents requires \'tasks\' parameter (non-empty string array). Correct: {"tasks":["...","..."]}');
    expect(vi.mocked(runWorkflow)).not.toHaveBeenCalled();
  });

  it("tasks 空数组 → 同一 Correct 文案", async () => {
    const err = await runSubagentsBatch({ tasks: [] }, makeDeps(makeRegistry()) as never, undefined)
      .catch((e: unknown) => e as Error);
    expect(err.message).toContain("subagents requires 'tasks' parameter (non-empty string array)");
    expect(vi.mocked(runWorkflow)).not.toHaveBeenCalled();
  });

  it("time 超上界 → 入口 fail-fast（含上限与实际值，可自纠）", async () => {
    const err = await runSubagentsBatch(
      { tasks: TWO_TASKS, time: MAX_TIMER_DELAY_MS + 1 },
      makeDeps(makeRegistry()) as never,
      undefined,
    ).catch((e: unknown) => e as Error);
    expect(err.message).toContain(`time budget ${MAX_TIMER_DELAY_MS + 1} ms exceeds the maximum of ${MAX_TIMER_DELAY_MS} ms`);
    expect(vi.mocked(runWorkflow)).not.toHaveBeenCalled();
  });

  it("slug 超长 → throw（含上限与建议形态）", async () => {
    const err = await runSubagentsBatch(
      { tasks: TWO_TASKS, slug: "x".repeat(SLUG_MAX_LENGTH + 1) },
      makeDeps(makeRegistry()) as never,
      undefined,
    ).catch((e: unknown) => e as Error);
    expect(err.message).toContain(`slug exceeds ${SLUG_MAX_LENGTH} chars`);
    expect(vi.mocked(runWorkflow)).not.toHaveBeenCalled();
  });

  it("fan-out 执行体缺席/不可用 → throw 带恢复动作 + 可用清单（按名解析失败的自救指引）", async () => {
    const registry = {
      get: vi.fn().mockResolvedValue(undefined),
      getPath: vi.fn().mockResolvedValue(undefined),
      loadAll: vi.fn().mockResolvedValue([makeFanOutScript()]),
      invalidate: vi.fn(),
    };
    const err = await runSubagentsBatch({ tasks: TWO_TASKS }, makeDeps(registry) as never, undefined)
      .catch((e: unknown) => e as Error);
    expect(err.message).toContain(`Built-in workflow 'fan-out' is not available`);
    expect(err.message).toContain("Recovery:");
    expect(err.message).toContain("  - fan-out:");
    expect(vi.mocked(runWorkflow)).not.toHaveBeenCalled();
  });

  it("available:false stub 同样走 fail-fast（不静默空源码启动）", async () => {
    const ghost = { ...makeFanOutScript(), available: false };
    const registry = {
      get: vi.fn().mockResolvedValue(ghost),
      getPath: vi.fn().mockResolvedValue(undefined),
      loadAll: vi.fn().mockResolvedValue([]),
      invalidate: vi.fn(),
    };
    await expect(
      runSubagentsBatch({ tasks: TWO_TASKS }, makeDeps(registry) as never, undefined),
    ).rejects.toThrow(/not available/);
    expect(vi.mocked(runWorkflow)).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
describe("reentry guard：与 workflow tool 共用同一实例", () => {
  it("guard 被占用 → throw busy 文案，且不触达 runWorkflow", async () => {
    const tool = captureSubagentsTool({ isProcessing: true }, makeRegistry());
    await expect(
      tool.execute("call-1", { tasks: TWO_TASKS }, undefined, undefined, undefined),
    ).rejects.toThrow(REENTRY_BUSY_MESSAGE);
    expect(vi.mocked(runWorkflow)).not.toHaveBeenCalled();
  });

  it("成功路径释放 guard（同一 guard 可再次进入）", async () => {
    const guard: ReentryGuardRef = { isProcessing: false };
    const tool = captureSubagentsTool(guard, makeRegistry());
    await tool.execute("call-1", { tasks: TWO_TASKS }, undefined, undefined, undefined);
    expect(guard.isProcessing).toBe(false);
    await tool.execute("call-2", { tasks: TWO_TASKS }, undefined, undefined, undefined);
    expect(vi.mocked(runWorkflow)).toHaveBeenCalledTimes(2);
  });

  it("失败路径经 finally 释放 guard（错误不粘住批量入口）", async () => {
    const guard: ReentryGuardRef = { isProcessing: false };
    const tool = captureSubagentsTool(guard, makeRegistry());
    const err = await tool.execute("call-1", {}, undefined, undefined, undefined).catch((e: unknown) => e as Error);
    expect(err.message).toContain("subagents requires 'tasks' parameter");
    expect(guard.isProcessing).toBe(false);
  });

  it("signal 已 abort → 起步即 throw（不占 guard）", async () => {
    const guard: ReentryGuardRef = { isProcessing: false };
    const tool = captureSubagentsTool(guard, makeRegistry());
    const aborted = AbortSignal.abort();
    await expect(
      tool.execute("call-1", { tasks: TWO_TASKS }, aborted as never, undefined, undefined),
    ).rejects.toThrow("Operation aborted before start");
    expect(guard.isProcessing).toBe(false);
    expect(vi.mocked(runWorkflow)).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
describe("集合收录（D1：单收录 WORKFLOW，不进 SUBAGENT）", () => {
  it("'subagents' ∈ WORKFLOW_TOOL_NAMES 且 ∉ SUBAGENT_TOOL_NAMES", async () => {
    const constants = await loadSharedConstants();
    expect(constants.WORKFLOW_TOOL_NAMES.has("subagents")).toBe(true);
    expect(constants.SUBAGENT_TOOL_NAMES.has("subagents")).toBe(false);
    // 既有成员不回归
    expect(constants.WORKFLOW_TOOL_NAMES.has("workflow")).toBe(true);
    expect(constants.SUBAGENT_TOOL_NAMES.has("subagent")).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
describe("TUI 渲染（renderCall/renderResult 既有惯例）", () => {
  it("renderCall 单行：subagents + 任务数 + slug", () => {
    const tool = captureSubagentsTool({ isProcessing: false }, makeRegistry());
    const text = renderedText(tool.renderCall(
      { tasks: TWO_TASKS, slug: "foo-tri-review" },
      makeTheme(),
    ));
    expect(text).toContain("subagents");
    expect(text).toContain("2 tasks");
    expect(text).toContain("foo-tri-review");
    expect(text).not.toContain("\n");
  });

  it("renderCall 无 slug/无 tasks 时不崩（streaming partial args 形态）", () => {
    const tool = captureSubagentsTool({ isProcessing: false }, makeRegistry());
    expect(() => tool.renderCall({}, makeTheme())).not.toThrow();
    expect(() => tool.renderCall({ tasks: "not-an-array" }, makeTheme())).not.toThrow();
  });

  it("renderResult 透出返回文案（多行保留）", () => {
    const tool = captureSubagentsTool({ isProcessing: false }, makeRegistry());
    const text = renderedText(tool.renderResult(
      { content: [{ type: "text", text: "Started batch 'x' (wf-1) as workflow run 'fan-out'" }] },
      undefined,
      makeTheme(),
    ));
    expect(text).toContain("Started batch 'x'");
  });
});
