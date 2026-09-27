/**
 * [D4-1 退役反转] actionRun 按名解析退役（原 C5③ 内置名能力的终态裁决反转）。
 *
 * 用户裁决 2026-09-21：workflow 派发终态形态 = 全路径，裸名派发失败是期望行为，
 * 不为裸名解析设计任何机制。原 C5③ 的 registry.get（内置名 + 用户保存名，按
 * tmp>project>user>npm 优先级合并）随裁决整体退役——P5 修复发现面后注册表会命中
 * 内置名让裸名「复活」，反向违反终态裁决，故机制删除而非禁用：name 解析仅剩
 * getPath（绝对路径 + ~/ 展开），未命中走 not_found 拒单（文案列全部可用条目并
 * 逐条附 location，失败一次即可按绝对路径自救）。
 *
 * 行为变更四要素：量级 = 裸名派发调用；旧行为 = registry.get 命中即启动；
 * 新行为 = not_found 拒单（零 token 沉没）；恢复 = 按清单 location 重试。
 *
 * 三视角：
 * - 使用者（黑盒）：裸名（含旧内置名 chain）被拒且清单可自救；路径可跑（现行为）。
 * - 构建者（白盒）：registry.get 零调用（机制已删，非仅降级）。
 * - 观察者（真 registry）：WorkflowScriptRegistryImpl + fixture 下裸名仍拒
 *   （真发现链里名字存在也拒——拒的是解析机制本身）。
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

describe("D4-1 按名解析退役（fake registry）", () => {
  it("裸名（旧内置名 chain，get 可命中）→ not_found 拒单；registry.get 零调用（机制删除）", async () => {
    const chain = makeScript("chain", "/builtin/workflows/chain.js");
    const registry = {
      // get 仍能命中（registry 层机制未删——退役的是 actionRun 的按名解析通道）
      get: vi.fn().mockResolvedValue(chain),
      getPath: vi.fn().mockResolvedValue(undefined),
      loadAll: vi.fn().mockResolvedValue([chain]),
    };
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

    expect(registry.getPath).toHaveBeenCalledWith("/abs/demo.js");
    expect(vi.mocked(runWorkflow)).toHaveBeenCalledTimes(1);
    const spec = vi.mocked(runWorkflow).mock.calls[0][0] as Record<string, unknown>;
    expect(spec.scriptName).toBe("demo");
  });

  it("getPath 返回 available:false 的 stub → 不启动，走 not_found 报错（W4c 口径不回退）", async () => {
    const ghost = { ...makeScript("ghost", "/builtin/ghost.js"), available: false };
    const registry = {
      get: vi.fn().mockResolvedValue(undefined),
      getPath: vi.fn().mockResolvedValue(ghost),
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

  it("未知名 → 报错含建议清单且逐条附绝对路径 location（全路径自救指引）", async () => {
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
