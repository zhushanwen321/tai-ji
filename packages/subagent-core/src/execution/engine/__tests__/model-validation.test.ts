// src/execution/engine/__tests__/model-validation.test.ts
//
// [⑦ 模型引用三元组化] validateModelForEngine 的裁决产物结构体语义锚定：
// 输出 = SplitModelRef 三元组（不再是裸 canonicalRef 串），trim 归一缺席、canonical
// 空白回落显式输入、无斜杠 ref 拆分（契约④）都收敛在本入口单点——record 侧不再
// 二次裁词形。字符串仅剩两类边界：输入的未裁决词形（EngineModelSelectorInput）与
// EnginePort.validateModel 引擎契约面（跨包镜像，见 port.ts 边界裁决注释）。

import { describe, expect, it } from "vitest";

import type { EngineModelSelectorInput, EnginePort } from "../port.ts";
import { DEFAULT_ENGINE_ID } from "../registry.ts";
import { validateModelForEngine } from "../model-validation.ts";

/** 最小 EnginePort 测试替身（validateModel 可选成员按用例注入）。 */
function fakeEngine(opts: {
  id?: string;
  validateModel?: (modelRef: EngineModelSelectorInput) => { canonicalRef: string };
}): EnginePort {
  return {
    id: opts.id ?? "fake-engine",
    capabilities: () => {
      throw new Error("not used in this suite");
    },
    probe: () => {
      throw new Error("not used in this suite");
    },
    run: () => {
      throw new Error("not used in this suite");
    },
    read: () => {
      throw new Error("not used in this suite");
    },
    ...(opts.validateModel !== undefined ? { validateModel: opts.validateModel } : {}),
  };
}

describe("validateModelForEngine（裁决产物三元组化）", () => {
  it("引擎未实现 validateModel：显式输入原样透传（拆分归一后返回）", () => {
    const engine = fakeEngine({});
    expect(validateModelForEngine(engine, "zai/glm-5.3")).toEqual({
      provider: "zai",
      id: "glm-5.3",
      name: "zai/glm-5.3",
    });
  });

  it("引擎已实现：裁决产物 canonicalRef 解析为三元组（alias 归一后留痕）", () => {
    const engine = fakeEngine({
      validateModel: (ref) => ({
        canonicalRef: ref === "fast-model" ? "zai/glm-5.3-flash" : (ref ?? ""),
      }),
    });
    expect(validateModelForEngine(engine, "fast-model")).toEqual({
      provider: "zai",
      id: "glm-5.3-flash",
      name: "zai/glm-5.3-flash",
    });
  });

  it("无斜杠 canonicalRef（契约④）：provider 空串、id=ref、整串进 name", () => {
    const engine = fakeEngine({ validateModel: () => ({ canonicalRef: "bare-ref" }) });
    expect(validateModelForEngine(engine, "whatever")).toEqual({
      provider: "",
      id: "bare-ref",
      name: "bare-ref",
    });
  });

  it("canonicalRef 空白 = 引擎裁决缺席：回落显式输入的归一拆分", () => {
    const engine = fakeEngine({ validateModel: () => ({ canonicalRef: "" }) });
    expect(validateModelForEngine(engine, "zai/glm-5.3")).toEqual({
      provider: "zai",
      id: "glm-5.3",
      name: "zai/glm-5.3",
    });
  });

  it("显式输入空白串归一缺席：引擎缺席裁决（空串 canonical）→ undefined（禁空串哨兵）", () => {
    const engine = fakeEngine({ validateModel: () => ({ canonicalRef: "" }) });
    expect(validateModelForEngine(engine, undefined)).toBeUndefined();
    expect(validateModelForEngine(engine, "   ")).toBeUndefined();
  });

  it("pi 引擎（防御分支）：不经引擎裁决，显式输入归一拆分原样返回", () => {
    const engine = fakeEngine({ id: DEFAULT_ENGINE_ID });
    expect(validateModelForEngine(engine, "anthropic/claude-x")).toEqual({
      provider: "anthropic",
      id: "claude-x",
      name: "anthropic/claude-x",
    });
  });

  it("引擎裁决抛错：包装为场景 2 错误（model_not_available + 引擎 id + 原始输入呈现）", () => {
    const engine = fakeEngine({
      validateModel: () => {
        throw new Error("provider creds missing");
      },
    });
    try {
      validateModelForEngine(engine, "zai/glm-5.3");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("model_not_available");
      expect((err as Error).message).toContain("zai/glm-5.3");
      expect((err as Error).message).toContain("fake-engine");
    }
  });
});
