// tool-workflow-model-rejection.test.ts
//
// [D8 Q1] workflow tool 创建期模型拒单单测（D4-1 按名解析退役的行为面在
// tool-workflow-run-builtin-name.test.ts 单独钉死，本文件只测模型门）：
//   - 目录查无 → 同步 throw 分类化文案（含可用清单 + 恢复指引），零 run 创建零
//     spawn（runWorkflow/runner/workerHost 零交互）；
//   - provider 漂移 → 文案含配置恢复指引（models.json）；
//   - 目录命中 → 模型门放行，model 参数透传进 RunSpec（runWorkflow 收到）；
//   - 模型目录缺席（单例未装配——生产不可达的防御分支）→ warn 降级跳过不误拒。
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 桩化 lifecycle——runWorkflow/abortRun 为 vi.fn（不起真 Worker，只测启动面）。 */
vi.mock("@zhushanwen/subagent-core/orchestration/lifecycle.ts", () => ({
  runWorkflow: vi.fn(),
  abortRun: vi.fn(),
}));

import { runWorkflow } from "@zhushanwen/subagent-core/orchestration/lifecycle.ts";
import { setModelConfigService } from "@zhushanwen/subagent-core";
import { actionRun } from "../interface/tool-workflow.ts";

function makeScript(name: string, path: string) {
  return {
    name,
    path,
    available: true,
    sourceCode: `// ${name}`,
    meta: { description: `${name} workflow`, parameters: undefined },
    toExecutable: () => `// ${name}`,
  };
}

function makeDeps(scripts: Array<ReturnType<typeof makeScript>>): Record<string, unknown> {
  return {
    runs: new Map(),
    store: { stateFilePath: (id: string) => `/tmp/state/${id}.jsonl` },
    registry: {
      get: vi.fn().mockResolvedValue(undefined),
      getPath: vi.fn(async (ref: string) => scripts.find((s) => s.path === ref) ?? undefined),
      loadAll: vi.fn().mockResolvedValue(scripts),
    },
  };
}

function setCatalogService(entries: Array<{ provider: string; id: string }>): void {
  setModelConfigService({
    initModel: vi.fn(),
    reloadGlobalConfig: vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } })),
    getModelRegistry: () => ({ getAvailable: () => entries }),
  } as never);
}

const SCRIPT = makeScript("chain", "/abs/chain.js");

beforeEach(() => {
  vi.mocked(runWorkflow).mockReset();
  vi.mocked(runWorkflow).mockResolvedValue("run-id-1");
});

describe("D8 创建期模型拒单", () => {
  it("目录缺席（单例未装配）→ warn 降级跳过，不误拒（runWorkflow 正常到达）", async () => {
    // 本用例必须先于任何 setCatalogService 调用执行（声明序 = 执行序）——
    // setModelConfigService 无复位面，单例 set 后 null 分支在本文件不可再达。
    const deps = makeDeps([SCRIPT]);
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
    const deps = makeDeps([SCRIPT]);
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
    const deps = makeDeps([SCRIPT]);
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
    const deps = makeDeps([SCRIPT]);
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
