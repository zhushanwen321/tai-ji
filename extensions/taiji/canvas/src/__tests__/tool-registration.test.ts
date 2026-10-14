// tool-registration.test.ts —— 六工具注册面（设计 §3.1(2)：动词族 6 工具，全 deferred）。

import { describe, expect, it } from "vitest";

import { CANVAS_TOOL_NAMES } from "@zhushanwen/extension-protocol";

import { mountCanvas } from "./helpers/canvas-harness.js";

describe("六工具注册面", () => {
  it("注册 6 个工具，名集与 U1 契约 CANVAS_TOOL_NAMES 一致", () => {
    const { registered } = mountCanvas();
    expect(registered).toHaveLength(6);
    expect([...registered].map((t) => t.name).sort()).toEqual([...CANVAS_TOOL_NAMES].sort());
  });

  it("全部 exposure=deferred（画布低频入口，不设常驻 direct）", () => {
    const { registered } = mountCanvas();
    for (const tool of registered) {
      expect(tool.exposure, `${tool.name} must be deferred`).toBe("deferred");
    }
  });

  it("每工具带非空 promptSnippet（deferred 形态下 system prompt 工具索引的唯一入口信号）", () => {
    // D3-A1 验收实证：缺 snippet 时自然语言驱动下模型不会 tool_search 画布工具
    // （description 须检索命中后才可见）——六工具 snippet 缺一即入口失明
    const { registered } = mountCanvas();
    for (const tool of registered) {
      expect(tool.promptSnippet, `${tool.name} must carry a promptSnippet`).toMatch(/\S/);
    }
    // enter 是发现入口：snippet 须承载「主动进入」引导（plan promptSnippet 同款）
    const enter = registered.find((t) => t.name === "canvas_enter");
    expect(enter?.promptSnippet).toContain("proactively enter canvas mode yourself");
  });

  it("每工具持有独立 typebox schema（object 形态，非共享引用）", () => {
    const { registered } = mountCanvas();
    const schemas = registered.map((t) => t.parameters) as Array<Record<string, unknown>>;
    for (const schema of schemas) {
      expect(schema.type).toBe("object");
      expect(schema.properties).toBeTypeOf("object");
    }
    // 独立 schema：两两不同引用
    for (let i = 0; i < schemas.length; i++) {
      for (let j = i + 1; j < schemas.length; j++) {
        expect(schemas[i]).not.toBe(schemas[j]);
      }
    }
  });
});
