// src/execution/__tests__/model-config-service.test.ts
//
// [H3/R5 测试归位] ModelConfigService 自有域测试文件。本文件用例自
// subagent-service.test.ts「ModelConfigService ctxModel 缓存」describe 整块迁入
//（用例名与断言零改动，纯移动——被测主体是 ModelConfigService 模块而非
// SubagentService，按被测主体归属原则从 God-class 级测试文件拆出）。
//
// ============================================================
// ModelConfigService ctxModel 缓存(renderCall 标题行 model 显示的核心)
// ============================================================
//
// [HISTORICAL] 99f20da1e 后 renderCall 拿不到主 agent model(ToolRenderContext 无 model),
// resolveModel 第三层拗错→降级不显示 model。修复:session_start 缓存 ctxModel,
// resolveModel 第三参默认用缓存。此测试验证该透传链路。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../model-resolver.ts";

// ── 工具:建临时 agentDir + 真实 ModelConfigService（自 subagent-service.test.ts 迁移段自持副本）──

function makeTmpAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
  return dir;
}

function makeModelService(agentDir: string): ModelConfigService {
  return new ModelConfigService({ agentDir, cwd: agentDir });
}

describe("ModelConfigService ctxModel 缓存", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
  });
  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 最小 mock registry:空可用列表(ctxModel 路径不需要 lookup)。 */
  function makeEmptyRegistry(): ModelRegistryLike {
    return {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    };
  }

  it("initModel 传 ctxModel 后,resolveModel 不传第三参返回缓存 model", () => {
    const svc = makeModelService(agentDir);
    const mainModel: ModelInfo = {
      id: "main-model",
      name: "Main",
      provider: "anthropic",
      reasoning: false,
    };
    svc.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "sess-1",
      ctxModel: mainModel,
    });

    // agent 无 model 声明 + 无 override → 走第三层 ctxModel 缓存
    const r = svc.resolveModel("general-purpose");
    expect(r.model).toBe(mainModel);
    expect(r.model.provider).toBe("anthropic");
  });

  it("显式 ctxModel 参数优先于缓存(execute 路径覆盖 renderCall 缓存)", () => {
    const svc = makeModelService(agentDir);
    const cached: ModelInfo = { id: "cached", name: "C", provider: "p1", reasoning: false };
    const explicit: ModelInfo = { id: "explicit", name: "E", provider: "p2", reasoning: false };
    svc.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "sess-1",
      ctxModel: cached,
    });

    // execute 传显式 ctxModel → 用显式,不用缓存
    const r = svc.resolveModel("general-purpose", undefined, explicit);
    expect(r.model).toBe(explicit);
  });

  it("setCtxModel 刷新缓存(model_select 后 renderCall 能看到新 model)", () => {
    const svc = makeModelService(agentDir);
    const m1: ModelInfo = { id: "m1", name: "1", provider: "p", reasoning: false };
    const m2: ModelInfo = { id: "m2", name: "2", provider: "p", reasoning: false };
    svc.initModel({ modelRegistry: makeEmptyRegistry(), sessionId: "s", ctxModel: m1 });

    expect(svc.resolveModel("general-purpose").model).toBe(m1);
    svc.setCtxModel(m2); // 模拟 model_select 刷新
    expect(svc.resolveModel("general-purpose").model).toBe(m2);
  });

  it("缓存为空且无 override/agentConfig.model → 拗错(不静默降级)", () => {
    const svc = makeModelService(agentDir);
    svc.initModel({
      modelRegistry: makeEmptyRegistry(),
      sessionId: "s",
      // ctxModel 不传 → 缓存为空
    });
    // 空 registry + 空 ctxModel → 第三层不可用 → 拗错
    expect(() => svc.resolveModel("general-purpose")).toThrow(/No available model/);
  });
});
