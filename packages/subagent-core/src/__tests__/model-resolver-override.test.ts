// src/__tests__/model-resolver-override.test.ts
//
// [subagent-model-switch U2] 解析链第 0 层（用户覆盖记账短路）：
//   - 覆盖在场 → 直接 lookup 解析覆盖值返回，现行三层（paramOverride / agentConfig /
//     ctxModel）整体不触达——不变量 4 的机器核对（不存在「覆盖了但下一轮还是旧模型」）；
//   - 覆盖缺席 → 现行三层原样（现状回归）；
//   - 覆盖路径的档位候选链（§6.2 记账形状）：paramOverride.thinkingLevel >
//     userOverride.thinkingLevel > agentConfig.thinkingLevel > frontmatter 串内联 >
//     最高档兜底；显式候选档位对新模型不可用即抛错（不静默降级）；
//   - 覆盖值经同一 canonical ref 全等裁决——非法 ref 抛错（不变量 3）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// core logger 桩：缺省档位推导路径留 debug 痕迹（与 model-resolver.test.ts 同款隔离）。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import {
  type AgentConfig,
  type ModelInfo,
  type ModelRegistryLike,
  resolveModel,
} from "../execution/assembly/model-resolver.ts";

// ============================================================
// helpers（fixture 形态对齐既有 model-resolver.test.ts）
// ============================================================

function makeModel(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: over.id ?? "sonnet-4-5",
    name: over.name ?? "Claude Sonnet 4.5",
    provider: over.provider ?? "anthropic",
    reasoning: over.reasoning ?? false,
    thinkingLevelMap: over.thinkingLevelMap,
    contextWindow: over.contextWindow,
  };
}

function makeRegistry(
  models: ModelInfo[],
  authed: string[] = models.map((m) => `${m.provider}/${m.id}`),
): ModelRegistryLike {
  const authSet = new Set(authed);
  return {
    getAvailable: () => models,
    find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
    hasConfiguredAuth: (m) => {
      if (!m || typeof m !== "object") return false;
      const mm = m as ModelInfo;
      return authSet.has(`${mm.provider}/${mm.id}`);
    },
  };
}

const ctxModel = makeModel({ id: "main-model", provider: "main" });

beforeEach(() => {
  loggerMock.debug.mockClear();
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// 第 0 层短路（不变量 4）
// ============================================================

describe("resolveModel — 第 0 层用户覆盖短路（不变量 4）", () => {
  it("覆盖在场：产物 = 覆盖值，三层整体不触达（paramOverride/agentConfig/ctxModel 均被顶住）", () => {
    const overrideTarget = makeModel({ id: "override-target", provider: "ovr" });
    const paramModel = makeModel({ id: "param-model", provider: "prm" });
    const agentModel = makeModel({ id: "agent-model", provider: "agt" });
    // registry 只注册覆盖目标与 agent 模型——paramModel 刻意不入 registry：
    // 若三层被触达（paramOverride.model = prm/param-model），assertCanonicalModelRef
    // 会抛 not found；第 0 层短路下永不触达，解析成功且产物 = 覆盖值。
    const reg = makeRegistry([overrideTarget, agentModel]);
    const agentConfig: AgentConfig = { name: "worker", systemPrompt: "", model: "agt/agent-model" };
    const r = resolveModel(
      agentConfig,
      reg,
      { model: "prm/param-model" },
      ctxModel,
      { model: "ovr/override-target" },
    );
    expect(r.model.provider).toBe("ovr");
    expect(r.model.id).toBe("override-target");
  });

  it("覆盖在场且其余三层全部非法/缺席：仍解析成功（短路的独立可满足性）", () => {
    const overrideTarget = makeModel({ id: "target", provider: "ovr" });
    const reg = makeRegistry([overrideTarget]);
    // ctxModel 不在 registry（第三层若触达，modelRefFromVerified 孪生守卫不炸但产物
    // 是 main-model）——产物必须仍是覆盖值，证明第三层未触达。
    const r = resolveModel(undefined, reg, undefined, makeModel({ id: "off-registry", provider: "nowhere" }), {
      model: "ovr/target",
    });
    expect(r.model.id).toBe("target");
    expect(r.model.provider).toBe("ovr");
  });

  it("覆盖缺席：现行三层原样（现状回归——L1 paramOverride / L2 agentConfig / L3 ctxModel）", () => {
    const paramModel = makeModel({ id: "param-model", provider: "prm" });
    const agentModel = makeModel({ id: "agent-model", provider: "agt" });
    const reg = makeRegistry([paramModel, agentModel]);

    // L1。
    const l1 = resolveModel({ name: "w", systemPrompt: "", model: "agt/agent-model" }, reg, { model: "prm/param-model" }, ctxModel);
    expect(l1.model.id).toBe("param-model");
    // L2。
    const l2 = resolveModel({ name: "w", systemPrompt: "", model: "agt/agent-model" }, reg, undefined, ctxModel);
    expect(l2.model.id).toBe("agent-model");
    // L3。
    const l3 = resolveModel(undefined, reg, undefined, ctxModel);
    expect(l3.model.id).toBe("main-model");
    // userOverride 形状传 undefined 与不传完全同形（可选末位参数零回归）。
    const l1Again = resolveModel({ name: "w", systemPrompt: "" }, reg, { model: "prm/param-model" }, ctxModel, undefined);
    expect(l1Again.model.id).toBe("param-model");
  });
});

// ============================================================
// 覆盖路径的档位候选链（§6.2 记账形状）
// ============================================================

describe("resolveModel — 覆盖路径档位候选链", () => {
  const levels = { off: true, medium: true, high: true, xhigh: true };
  const target = () => makeModel({ id: "target", provider: "ovr", reasoning: true, thinkingLevelMap: levels });

  it("无显式候选 → 最高可用档兜底（现役链缺省推导语义）", () => {
    const r = resolveModel(undefined, makeRegistry([target()]), undefined, undefined, { model: "ovr/target" });
    expect(r.thinkingLevel).toBe("xhigh");
  });

  it("paramOverride.thinkingLevel > userOverride.thinkingLevel（调用参数档位仍最权威）", () => {
    const r = resolveModel(
      undefined,
      makeRegistry([target()]),
      { thinkingLevel: "medium" },
      undefined,
      { model: "ovr/target", thinkingLevel: "high" },
    );
    expect(r.thinkingLevel).toBe("medium");
  });

  it("userOverride.thinkingLevel > agentConfig.thinkingLevel（覆盖内联档位高于 frontmatter）", () => {
    const r = resolveModel(
      { name: "w", systemPrompt: "", thinkingLevel: "medium" },
      makeRegistry([target()]),
      undefined,
      undefined,
      { model: "ovr/target", thinkingLevel: "high" },
    );
    expect(r.thinkingLevel).toBe("high");
  });

  it("覆盖档位缺席 → agentConfig.thinkingLevel 递补（frontmatter 显式档位沿用）", () => {
    const r = resolveModel(
      { name: "w", systemPrompt: "", thinkingLevel: "medium" },
      makeRegistry([target()]),
      undefined,
      undefined,
      { model: "ovr/target" },
    );
    expect(r.thinkingLevel).toBe("medium");
  });

  it("显式候选档位对新模型不可用 → 抛错（不静默降级，§6.2）", () => {
    const onlyMedium = makeModel({ id: "target", provider: "ovr", reasoning: true, thinkingLevelMap: { medium: true } });
    expect(() =>
      resolveModel(undefined, makeRegistry([onlyMedium]), undefined, undefined, { model: "ovr/target", thinkingLevel: "xhigh" }),
    ).toThrow(/thinkingLevel "xhigh" is not available/);
  });
});

// ============================================================
// 不变量 3：覆盖值经同一 canonical ref 全等裁决
// ============================================================

describe("resolveModel — 覆盖值 canonical ref 裁决（不变量 3）", () => {
  it("覆盖 ref 不在 registry → 抛错（不能把用户带进注定启动失败的模型）", () => {
    const reg = makeRegistry([makeModel({ id: "other", provider: "ovr" })]);
    expect(() => resolveModel(undefined, reg, undefined, undefined, { model: "ovr/missing-model" })).toThrow(
      /is not a registry entry/,
    );
  });

  it("覆盖 ref 全等命中但 auth 未配置 → 抛错（凭据校验与显式指定同链）", () => {
    const target = makeModel({ id: "target", provider: "ovr" });
    const reg = makeRegistry([target], []); // 无任何已鉴权模型
    expect(() => resolveModel(undefined, reg, undefined, undefined, { model: "ovr/target" })).toThrow(
      /auth is not configured/,
    );
  });
});
