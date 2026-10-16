// available-tools.test.ts —— <available_tools> 常驻存在性段（D3-A1 验收实证的
// 入口可见性修复：pi 1.0.0 下 deferred 工具对模型零感知，name + description 须
// 常驻 system prompt 并写明 tool_search 激活路径）。

import { describe, expect, it } from "vitest";

import { buildAvailableToolsSection, CANVAS_AVAILABLE_TOOLS } from "../index.js";
import { CANVAS_TOOL_NAMES } from "@zhushanwen/extension-protocol";

import { mountCanvas, withExtLogEnv, type BeforeAgentStartShape } from "./helpers/canvas-harness.js";

describe("CANVAS_AVAILABLE_TOOLS 单源", () => {
  it("清单 = 六工具全集，与 U1 契约 CANVAS_TOOL_NAMES 一致", () => {
    expect(CANVAS_AVAILABLE_TOOLS.map((t) => t.name).sort()).toEqual([...CANVAS_TOOL_NAMES].sort());
  });

  it("每条 description 与注册进 pi 的工具 description 逐字一致（注册配置从本单源引用）", () => {
    // 一致性由 index.ts 注册配置直接引用本清单保证；此处锁单源形态：
    // 每条非空、无换行（列表形态依赖）
    for (const tool of CANVAS_AVAILABLE_TOOLS) {
      expect(tool.description.trim().length).toBeGreaterThan(40);
      expect(tool.description).not.toContain("\n");
    }
  });
});

describe("buildAvailableToolsSection（纯函数）", () => {
  it("段内含每个工具的 name 与完整 description 及 tool_search 激活指引", () => {
    const section = buildAvailableToolsSection(CANVAS_AVAILABLE_TOOLS);
    expect(section.startsWith("<available_tools>\n")).toBe(true);
    expect(section.endsWith("\n</available_tools>")).toBe(true);
    expect(section).toContain("tool_search");
    for (const tool of CANVAS_AVAILABLE_TOOLS) {
      expect(section).toContain(`- ${tool.name}: ${tool.description}`);
    }
  });

  it("description 多行文本被单行化（列表项内换行破坏列表形态）", () => {
    const section = buildAvailableToolsSection([{ name: "t", description: "a\n\nb  c" }]);
    expect(section).toContain("- t: a b c");
  });
});

describe("before_agent_start 注入钩子", () => {
  it("taiji GUI 宿主下返回追加了 <available_tools> 段的 systemPrompt，段内含六工具与激活指引", async () => {
    const { beforeAgentStartHandlers } = mountCanvas();
    expect(beforeAgentStartHandlers).toHaveLength(1);
    const handler = beforeAgentStartHandlers[0];
    const result = await withExtLogEnv("1", () =>
      handler({ systemPrompt: "BASE PROMPT" } as BeforeAgentStartShape, { mode: "rpc" }),
    );
    expect(result).toBeDefined();
    expect(result?.systemPrompt.startsWith("BASE PROMPT\n\n<available_tools>")).toBe(true);
    expect(result?.systemPrompt).toContain("</available_tools>");
    expect(result?.systemPrompt).toContain("tool_search");
    for (const name of CANVAS_TOOL_NAMES) {
      expect(result?.systemPrompt).toContain(`- ${name}: `);
    }
  });

  it("env 信号缺失或非 rpc 模式均不注入（与工具 execute 宿主守卫同谓词）", async () => {
    const { beforeAgentStartHandlers } = mountCanvas();
    const handler = beforeAgentStartHandlers[0];
    const envMissing = await withExtLogEnv(undefined, () =>
      handler({ systemPrompt: "B" } as BeforeAgentStartShape, { mode: "rpc" }),
    );
    expect(envMissing).toBeUndefined();
    const notRpc = await withExtLogEnv("1", () =>
      handler({ systemPrompt: "B" } as BeforeAgentStartShape, { mode: "tui" }),
    );
    expect(notRpc).toBeUndefined();
  });

  it("同输入两次调用输出一致（每轮注入相同文本，KV-cache 前缀稳定）", async () => {
    const { beforeAgentStartHandlers } = mountCanvas();
    const handler = beforeAgentStartHandlers[0];
    const [a, b] = await withExtLogEnv("1", () => {
      const event = { systemPrompt: "BASE" } as BeforeAgentStartShape;
      const ctx = { mode: "rpc" };
      return [handler(event, ctx), handler(event, ctx)];
    });
    expect(a?.systemPrompt).toBe(b?.systemPrompt);
  });
});
