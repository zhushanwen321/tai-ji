/**
 * W4b：workflow tool 错误路径 throw 语义（代表路径）。
 *
 * pi 只对 execute throw 置 isError:true——返回值里的 isError 被 agent-loop 丢弃
 * （agent-loop.js:453-483），故错误路径必须 throw。本文件抽 4 个代表路径
 * （W4b 验收交付物 3）：
 * - not_found（abort 目标 runId 不存在）
 * - reentry-busy（guard 占用，throw 前未 acquire）
 * - 平铺检测（args 子字段平铺到顶层，LLM 常见错误）
 * - slug 护栏（schema maxLength 之后的运行时第二道）
 * generate 校验族（第 5 代表路径）见 tool-workflow-script-generate.test.ts。
 *
 * 经 registerWorkflowTool 注册层测（capture tool + 最小 deps stub），
 * 与 W4 save/delete 测试同范式。框架：vitest。
 */
import { describe, expect, it, vi } from "vitest";

import { SLUG_MAX_LENGTH } from "@zhushanwen/subagent-core";
import { REENTRY_BUSY_MESSAGE, type ReentryGuardRef } from "../reentry-guard.ts";
import { registerWorkflowTool } from "../tool-workflow.ts";

// ── capture helper ──

interface CapturedTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
}

function captureTool(deps: unknown, reentryRef: ReentryGuardRef): CapturedTool {
  const tools: CapturedTool[] = [];
  const pi = { registerTool: (t: unknown) => tools.push(t as CapturedTool) };
  registerWorkflowTool(pi as never, deps as never, reentryRef);
  if (!tools[0] || tools[0].name !== "workflow") {
    throw new Error("registerWorkflowTool did not register the workflow tool");
  }
  return tools[0];
}

/** 最小 LauncherDeps stub：被测路径只触 registry / runs（C5③ 起 actionRun 先查
 *  registry.get 再 registry.getPath——两查都须在 stub 面）。 */
function makeDeps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runs: new Map(),
    registry: {
      get: vi.fn().mockResolvedValue(undefined),
      getPath: vi.fn().mockResolvedValue(undefined),
      loadAll: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

/** 平铺检测 / slug 护栏路径的 registry script stub（meta.parameters 驱动已知键集）。 */
function makeScript(parameters?: object): Record<string, unknown> {
  return {
    name: "demo-wf",
    path: "/abs/demo-wf.js",
    available: true,
    sourceCode: "// demo",
    meta: { description: "demo workflow", parameters },
    toExecutable: () => "// demo",
  };
}

// ── 代表路径 ──

describe("W4b: workflow tool 错误路径 throw 语义", () => {
  it("not_found：abort 目标 runId 不存在 → throw（pi catch 后置 isError:true）", async () => {
    const tool = captureTool(makeDeps(), { isProcessing: false });
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
    const deps = makeDeps({
      registry: {
        get: vi.fn().mockResolvedValue(undefined),
        getPath: vi.fn().mockResolvedValue({
          name: "ghost-wf",
          path: "/tmp/no-such-workflow.js",
          available: false,
          sourceCode: "",
          meta: { description: "", parameters: undefined },
          toExecutable: () => "",
        }),
        loadAll: vi.fn().mockResolvedValue([]),
      },
    });
    const tool = captureTool(deps, { isProcessing: false });
    await expect(
      tool.execute("id", { action: "run", name: "/tmp/no-such-workflow.js" }, undefined, undefined, {}),
    ).rejects.toThrow("Workflow '/tmp/no-such-workflow.js' not found.");
    // 未假启动：runs 注册表不出现该 run
    expect(deps.runs).toBeInstanceOf(Map);
    expect((deps.runs as Map<string, unknown>).size).toBe(0);
  });

  it("reentry-busy：guard 占用 → throw REENTRY_BUSY_MESSAGE，且 guard 状态不被污染", async () => {
    const guard: ReentryGuardRef = { isProcessing: true };
    const tool = captureTool(makeDeps(), guard);
    await expect(
      tool.execute("id", { action: "status" }, undefined, undefined, {}),
    ).rejects.toThrow(REENTRY_BUSY_MESSAGE);
    // throw 发生在 acquire 之前——占用方语义保持，不产生双重 release
    expect(guard.isProcessing).toBe(true);
  });

  it("平铺检测：args 子字段提到顶层 → throw 'Detected ... at top level'（含 Correct 正例）", async () => {
    const deps = makeDeps({
      registry: {
        get: vi.fn().mockResolvedValue(undefined),
        getPath: vi.fn().mockResolvedValue(
          makeScript({
            type: "object",
            properties: { task: { type: "string" }, items: { type: "array" } },
            required: ["task"],
          }),
        ),
      },
    });
    const tool = captureTool(deps, { isProcessing: false });
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
    const deps = makeDeps({
      registry: {
        get: vi.fn().mockResolvedValue(undefined),
        getPath: vi.fn().mockResolvedValue(
          makeScript({
            type: "object",
            properties: { task: { type: "string" } },
            required: ["task"],
          }),
        ),
      },
    });
    const tool = captureTool(deps, { isProcessing: false });
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
    const deps = makeDeps({
      registry: {
        get: vi.fn().mockResolvedValue(undefined),
        getPath: vi.fn().mockResolvedValue(
          makeScript({
            type: "object",
            properties: { task: { type: "string" } },
            required: ["task"],
          }),
        ),
      },
    });
    const tool = captureTool(deps, { isProcessing: false });
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

  it("throw 后 reentry guard 经 finally 正常释放（成功路径回归）", async () => {
    // abort not_found throw 穿透 execute try/finally：guard 必须复位，否则后续命令全部 busy
    const guard: ReentryGuardRef = { isProcessing: false };
    const tool = captureTool(makeDeps(), guard);
    await expect(
      tool.execute("id", { action: "abort", runId: "no-such-run" }, undefined, undefined, {}),
    ).rejects.toThrow(/not found/);
    expect(guard.isProcessing).toBe(false);
  });
});
