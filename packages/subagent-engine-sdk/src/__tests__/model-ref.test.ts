// src/__tests__/model-ref.test.ts
//
// 模型引用串语法 + thinking 档位词表单点（host/壳/CLI/前端共用面）。
// 三视角：①构建者——解析逐字段；②使用者——剪裁后的 ref 能直接进 registry 匹配；
// ③观察者——非法输入不抛、返回空段由调用方按未命中处理。

import { describe, expect, it } from "vitest";

import {
  THINKING_ORDER,
  assertThinkingLevel,
  isModelRef,
  isThinkingLevel,
  parseModelSelector,
} from "../model-ref.ts";

describe("parseModelSelector（语法单点，档位随串返回）", () => {
  it("白名单后缀：剥出 ref 并带出档位", () => {
    expect(parseModelSelector("p/m:high")).toEqual({
      input: "p/m:high",
      ref: "p/m",
      provider: "p",
      id: "m",
      thinkingLevel: "high",
    });
    expect(parseModelSelector("p/m:max").thinkingLevel).toBe("max");
  });

  it("无后缀：档位缺省，provider/id 照切", () => {
    expect(parseModelSelector("p/m")).toEqual({
      input: "p/m",
      ref: "p/m",
      provider: "p",
      id: "m",
    });
  });

  it("非白名单冒号不剥（仍属 id 的一部分）", () => {
    expect(parseModelSelector("p/m:foo")).toMatchObject({ ref: "p/m:foo", id: "m:foo" });
  });

  it("id 自身含 /：按第一个 / 切分", () => {
    expect(parseModelSelector("a/b/c")).toMatchObject({ provider: "a", id: "b/c" });
    expect(parseModelSelector("a/b/c:xhigh")).toMatchObject({
      provider: "a",
      id: "b/c",
      thinkingLevel: "xhigh",
    });
  });

  it("缺 / 或空段：至少一侧为空串（调用方按未命中处理）", () => {
    expect(parseModelSelector("foo")).toMatchObject({ provider: "", id: "" });
    expect(parseModelSelector("/m")).toMatchObject({ provider: "", id: "" });
    expect(parseModelSelector("p/")).toMatchObject({ provider: "p", id: "" });
  });
});

describe("isModelRef / thinking 词表", () => {
  it("isModelRef：provider 与 id 都非空才成立", () => {
    expect(isModelRef("p/m")).toBe(true);
    expect(isModelRef("a/b/c")).toBe(true);
    expect(isModelRef("p/m:high")).toBe(true);
    expect(isModelRef("p/")).toBe(false);
    expect(isModelRef("/m")).toBe(false);
    expect(isModelRef("m")).toBe(false);
    expect(isModelRef("")).toBe(false);
  });

  it("isThinkingLevel：白名单内 true，其余 false", () => {
    for (const level of THINKING_ORDER) expect(isThinkingLevel(level)).toBe(true);
    expect(isThinkingLevel("ultra")).toBe(false);
    expect(isThinkingLevel(1)).toBe(false);
    expect(isThinkingLevel(undefined)).toBe(false);
  });

  it("assertThinkingLevel：undefined 透传；非法值抛错并列出全集", () => {
    expect(assertThinkingLevel(undefined)).toBeUndefined();
    expect(assertThinkingLevel("xhigh")).toBe("xhigh");
    expect(() => assertThinkingLevel("ultra")).toThrow(/Allowed values: off, minimal/);
  });
});
