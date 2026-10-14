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
