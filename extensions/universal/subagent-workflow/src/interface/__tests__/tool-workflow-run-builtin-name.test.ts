/**
 * C5③：actionRun 放开内置 workflow 名（convergence D-4 pi 半边）。
 *
 * 解析序：registry.get(name)（内置/已保存 workflow 名，按 tmp>project>user>npm
 * 优先级合并）→ 未命中 registry.getPath(name)（绝对路径 + ~/ 展开）→ 两者都 miss
 * 走原 not_found 报错（文案不变）。严格超集：现有路径用法零变化。
 *
 * 三视角：
 * - 使用者（黑盒）：run {"action":"run","name":"chain"} 直接可跑（内置名新能力）；
 *   传路径仍可跑（现行为）；两者都 miss 的报错与改造前逐字一致。
 * - 构建者（白盒）：解析序 get→getPath、get 未命中才穿透到 getPath。
 * - 观察者（真 registry）：WorkflowScriptRegistryImpl + fixture 目录经真实
 *   discoverWorkflows 按名命中（生产 lookup 链）。
 *
 * mock 策略：lifecycle 深路径 stub（runWorkflow/abortRun 为 vi.fn——不起真 Worker，
 * 只验证 run 启动面的脚本解析与 spec 组装）。框架：vitest（禁 node:test）。
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 桩化 lifecycle——runWorkflow/abortRun 为 vi.fn，不起真 Worker（只测解析面）。 */
vi.mock("@zhushanwen/subagent-core/orchestration/lifecycle.ts", () => ({
  runWorkflow: vi.fn(),
  abortRun: vi.fn(),
}));

// 被 mock 的模块——import 路径与被测源文件（tool-workflow.ts 深路径 import）一致
import { runWorkflow } from "@zhushanwen/subagent-core/orchestration/lifecycle.ts";
import { actionRun } from "../tool-workflow.ts";
import { WorkflowScriptRegistryImpl } from "@zhushanwen/subagent-core";

// ── fixture：可用 workflow 脚本（@pi-meta 新格式，无参数声明） ──

const CHAIN_META = `/* @pi-meta
name: chain
description: 内置名测试用三步链
phases: [a, b]
*/
const agent = require("./agent");
agent("w", { task: $ARGS.task });
`;

/** fake registry 的最小 WorkflowScript stub。 */
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

/** 最小 deps stub（runWorkflow 已 mock；store 只消费 stateFilePath）。 */
function makeDeps(registry: Record<string, unknown>): Record<string, unknown> {
  return {
    runs: new Map(),
    store: { stateFilePath: (id: string) => `/tmp/state/${id}.jsonl` },
    registry,
  };
}

beforeEach(() => {
  vi.mocked(runWorkflow).mockReset();
  vi.mocked(runWorkflow).mockResolvedValue("run-id-1");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("C5③ run 内置名（fake registry）", () => {
  it("run 传内置名 → registry.get 命中即启动（runWorkflow 收到该脚本，getPath 不被调用）", async () => {
    const chain = makeScript("chain", "/builtin/workflows/chain.js");
    const registry = {
      get: vi.fn().mockResolvedValue(chain),
      getPath: vi.fn().mockResolvedValue(undefined),
      loadAll: vi.fn().mockResolvedValue([chain]),
    };
    const result = await actionRun(
      { action: "run", name: "chain" } as never,
      makeDeps(registry) as never,
      undefined,
    );

    expect(registry.get).toHaveBeenCalledWith("chain");
    expect(registry.getPath).not.toHaveBeenCalled();
    expect(vi.mocked(runWorkflow)).toHaveBeenCalledTimes(1);
    // spec 组装：scriptName/scriptPath 来自按名命中的脚本
    const spec = vi.mocked(runWorkflow).mock.calls[0][0] as Record<string, unknown>;
    expect(spec.scriptName).toBe("chain");
    expect(spec.scriptPath).toBe("/builtin/workflows/chain.js");
    expect(result.content[0]?.text).toContain("Started workflow 'chain'");
    expect(result.details).toMatchObject({ action: "run", status: "running", name: "chain" });
  });

  it("严格超集：get 未命中的路径名 → 穿透 getPath（现有路径用法零变化）", async () => {
    const byPath = makeScript("demo", "/abs/demo.js");
    const registry = {
      get: vi.fn().mockResolvedValue(undefined),
      getPath: vi.fn().mockResolvedValue(byPath),
      loadAll: vi.fn().mockResolvedValue([byPath]),
    };
    await actionRun(
      { action: "run", name: "/abs/demo.js" } as never,
      makeDeps(registry) as never,
      undefined,
    );

    expect(registry.get).toHaveBeenCalledWith("/abs/demo.js");
    expect(registry.getPath).toHaveBeenCalledWith("/abs/demo.js");
    expect(vi.mocked(runWorkflow)).toHaveBeenCalledTimes(1);
    const spec = vi.mocked(runWorkflow).mock.calls[0][0] as Record<string, unknown>;
    expect(spec.scriptName).toBe("demo");
  });

  it("get 命中 available:false 的 stub → 不启动，走 not_found 报错（W4c 口径不回退）", async () => {
    const ghost = { ...makeScript("ghost", "/builtin/ghost.js"), available: false };
    const registry = {
      get: vi.fn().mockResolvedValue(ghost),
      getPath: vi.fn().mockResolvedValue(undefined),
      loadAll: vi.fn().mockResolvedValue([]),
    };
    await expect(
      actionRun(
        { action: "run", name: "ghost" } as never,
        makeDeps(registry) as never,
        undefined,
      ),
    ).rejects.toThrow(/Workflow 'ghost' not found\./);
    expect(vi.mocked(runWorkflow)).not.toHaveBeenCalled();
  });

  it("两者都 miss → 报错含建议清单且逐条附绝对路径 location（按名失败后的自救指引）", async () => {
    const registry = {
      get: vi.fn().mockResolvedValue(undefined),
      getPath: vi.fn().mockResolvedValue(undefined),
      loadAll: vi.fn().mockResolvedValue([makeScript("chain", "/builtin/workflows/chain.js")]),
    };
    const err = await actionRun(
      { action: "run", name: "no-such" } as never,
      makeDeps(registry) as never,
      undefined,
    ).catch((e: unknown) => e as Error);
    // 逐条 location：模型按清单里的名字重试注定再 throw（8.6.0 getPath-only 时代
    // 实测失败形态）——摘要必须直接给出可用的绝对路径，失败一次即自救。
    expect(err.message).toContain(
      "Workflow 'no-such' not found. Available (name — use the absolute location path as 'name' when the bare name is rejected):",
    );
    expect(err.message).toContain("  - chain: chain workflow");
    expect(err.message).toContain("    location: /builtin/workflows/chain.js");
  });
});

describe("C5③ run 内置名（真 registry：WorkflowScriptRegistryImpl + 真实发现链）", () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "c5-run-builtin-"));
    // WorkflowScanConfig 布局：projectDir = <fixture>/ws/.pi/workflows（反推 workspaceRoot）
    const projectDir = join(fixtureDir, "ws", ".pi", "workflows");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "chain.js"), CHAIN_META, "utf-8");
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("get('chain') 经真实 discoverWorkflows 命中 fixture 脚本 → actionRun 按名启动成功", async () => {
    const registry = new WorkflowScriptRegistryImpl({
      projectDir: join(fixtureDir, "ws", ".pi", "workflows"),
      userDir: join(fixtureDir, "user", "workflows"),
      tmpDir: join(fixtureDir, "ws", ".pi", "workflows", ".tmp"),
      npmDirs: [],
    });
    // 前置自检：fixture 布局可被扫描（隔离 config 下 hostRoots 为空、仅 project 根命中）
    const all = await registry.loadAll();
    expect(all.filter((w) => w.available).map((w) => w.name)).toContain("chain");

    const result = await actionRun(
      { action: "run", name: "chain" } as never,
      makeDeps(registry as unknown as Record<string, unknown>) as never,
      undefined,
    );

    expect(vi.mocked(runWorkflow)).toHaveBeenCalledTimes(1);
    const spec = vi.mocked(runWorkflow).mock.calls[0][0] as Record<string, unknown>;
    expect(spec.scriptName).toBe("chain");
    expect(String(spec.scriptPath)).toContain("chain.js");
    expect(result.content[0]?.text).toContain("Started workflow 'chain'");
  });

  it("真 registry 下未知名（无路径形态）→ not_found（含 fixture 内可用清单）", async () => {
    const registry = new WorkflowScriptRegistryImpl({
      projectDir: join(fixtureDir, "ws", ".pi", "workflows"),
      userDir: join(fixtureDir, "user", "workflows"),
      tmpDir: join(fixtureDir, "ws", ".pi", "workflows", ".tmp"),
      npmDirs: [],
    });
    await expect(
      actionRun(
        { action: "run", name: "not-a-workflow" } as never,
        makeDeps(registry as unknown as Record<string, unknown>) as never,
        undefined,
      ),
    ).rejects.toThrow(/Workflow 'not-a-workflow' not found\./);
    expect(vi.mocked(runWorkflow)).not.toHaveBeenCalled();
  });

  it("fixture 卫生断言：fixture 目录无其他 .js 泄漏（避免 discoverWorkflows 误扫）", () => {
    const projectDir = join(fixtureDir, "ws", ".pi", "workflows");
    expect(readdirSync(projectDir).filter((f) => f.endsWith(".js"))).toEqual(["chain.js"]);
  });
});
