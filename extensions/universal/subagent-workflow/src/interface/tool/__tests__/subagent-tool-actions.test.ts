/**
 * subagent tool 非 start 通道 + renderCall 预解析测试（与 path-guard 的 start 守卫面
 * 互补，覆盖 executeSubagent 的 action 路由全分支与 renderCall 的 model 预解析降级链）。
 *
 * 覆盖面：
 *   - execute：service 缺席 → 带恢复动作的错误；未知 action → immediate throw；
 *     list/cancel/message/close/fork-from 六通道 handler 接线 + adapter 包装
 *     （content JSON 给 LLM / details 领域对象给 renderResult）
 *   - renderCall：model override 三层解析（override 在场 → resolved 注入标题；
 *     resolveModel 抛错 → 降级不崩；override 缺省 → resolved undefined）
 *
 * mock 策略：六 handler 深路径 stub（领域内核行为由 core 侧
 * subagent-actions-core.test.ts 锁定，此处只测接线）；pi-ai/typebox 用共享桩
 * （对齐 subagent-tool-path-guard.test.ts）；logger stub（debug 冷路径不落盘）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", async () => {
  const { piAiStringEnumStub } = await import("../../../__tests__/mocks/runtime-stubs.ts");
  return piAiStringEnumStub();
});
vi.mock("typebox", async () => {
  const { typeboxStub } = await import("../../../__tests__/mocks/runtime-stubs.ts");
  return typeboxStub;
});
vi.mock("@zhushanwen/pi-extension-logger", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@zhushanwen/subagent-core/execution/assembly/subagent-actions-core.ts", () => ({
  startHandler: vi.fn(),
  listHandler: vi.fn(),
  cancelHandler: vi.fn(),
  messageHandler: vi.fn(),
  closeHandler: vi.fn(),
  forkFromHandler: vi.fn(),
  endedMessageGuard: vi.fn(),
  mapExternalState: vi.fn(),
  recordToListItem: vi.fn(),
}));

import {
  cancelHandler,
  closeHandler,
  forkFromHandler,
  listHandler,
  messageHandler,
  startHandler,
  setSubagentService,
  GLOBAL_SLOT_KEYS,
} from "@zhushanwen/subagent-core";

import { registerSubagentTool } from "../subagent-tool.ts";
import { mockExtensionApi } from "@zhushanwen/subagent-core/testing/execution/__tests__/helpers/mock-extension-api.ts";

/** 注册捕获的 tool 窄 view（execute + renderCall）。 */
interface SubagentToolView { // oe-exempt:20260930:test:test double shape for tool capture (test infra)
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
  renderCall: (args: unknown, theme: unknown, ctx: unknown) => { render(width: number): string[] };
}

function captureTool(): SubagentToolView {
  let captured: SubagentToolView | undefined;
  const pi = mockExtensionApi({
    registerTool: (tool: unknown) => {
      captured = tool as SubagentToolView;
    },
  });
  registerSubagentTool(pi);
  if (!captured) throw new Error("subagent tool not registered");
  return captured;
}

function resetServiceSlot(): void {
  const slot = Reflect.get(globalThis, Symbol.for(GLOBAL_SLOT_KEYS.service)) as
    | { current: unknown }
    | undefined;
  if (slot) slot.current = null;
}

const markingTheme = {
  fg: (tag: string, text: string) => `${tag}(${text})`,
  bold: (text: string) => text,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  resetServiceSlot();
});

describe("subagent tool execute：守卫与缺席面", () => {
  it("service 缺席 → immediate throw，错误带恢复动作指引", async () => {
    const tool = captureTool(); // 槽未注入
    await expect(
      tool.execute("c1", { action: "list" }, undefined, undefined, undefined),
    ).rejects.toThrow(/subagents runtime not initialized.*Recovery: reload this session/s);
  });

  it("未知 action → immediate throw（Unknown subagent action）", async () => {
    setSubagentService({ execute: vi.fn() } as never);
    const tool = captureTool();
    await expect(
      tool.execute("c2", { action: "pause" }, undefined, undefined, undefined),
    ).rejects.toThrow("Unknown subagent action: pause");
  });
});

describe("subagent tool execute：六 action 通道接线", () => {
  /** 注入最小 fake service 并捕获 tool（六通道共用基座）。 */
  function withService(): SubagentToolView {
    setSubagentService({ execute: vi.fn() } as never);
    return captureTool();
  }

  it("list：listParam 解包透传，adapter 包装 listResponse", async () => {
    vi.mocked(listHandler).mockReturnValue({ response: { items: [], total: 0 } } as never);
    const tool = withService();
    const params = { action: "list", listParam: { includeFinished: true, limit: 5 } };
    const result = await tool.execute("c3", params, undefined, undefined, undefined);
    expect(vi.mocked(listHandler)).toHaveBeenCalledWith(expect.anything(), params.listParam);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ action: "list" });
    expect(result.details).toMatchObject({ action: "list" });
  });

  it("cancel：cancelParam 解包透传 + subagentId 回显", async () => {
    vi.mocked(cancelHandler).mockResolvedValue({ subagentId: "sa-9", response: { stopped: true } } as never);
    const tool = withService();
    const params = { action: "cancel", cancelParam: { subagentId: "sa-9" } };
    const result = await tool.execute("c4", params, undefined, undefined, undefined);
    expect(vi.mocked(cancelHandler)).toHaveBeenCalledWith(expect.anything(), { subagentId: "sa-9" });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ action: "cancel", subagentId: "sa-9" });
  });

  it("message：messageParam 解包透传", async () => {
    vi.mocked(messageHandler).mockResolvedValue({ subagentId: "sa-7", response: { queued: true } } as never);
    const tool = withService();
    const params = { action: "message", messageParam: { subagentId: "sa-7", text: "continue" } };
    const result = await tool.execute("c5", params, undefined, undefined, undefined);
    expect(vi.mocked(messageHandler)).toHaveBeenCalledWith(expect.anything(), params.messageParam);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ action: "message", subagentId: "sa-7" });
  });

  it("close：closeParam 解包透传", async () => {
    vi.mocked(closeHandler).mockResolvedValue({ subagentId: "sa-6", response: { archived: true } } as never);
    const tool = withService();
    const params = { action: "close", closeParam: { subagentId: "sa-6" } };
    const result = await tool.execute("c6", params, undefined, undefined, undefined);
    expect(vi.mocked(closeHandler)).toHaveBeenCalledWith(expect.anything(), { subagentId: "sa-6" });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ action: "close", subagentId: "sa-6" });
  });

  it("fork-from：forkFromParam 解包透传", async () => {
    vi.mocked(forkFromHandler).mockResolvedValue({
      subagentId: "sa-new",
      response: { sourceSubagentId: "sa-old", newSubagentId: "sa-new" },
    } as never);
    const tool = withService();
    const params = { action: "fork-from", forkFromParam: { sourceSubagentId: "sa-old", prompt: "continue" } };
    const result = await tool.execute("c7", params, undefined, undefined, undefined);
    expect(vi.mocked(forkFromHandler)).toHaveBeenCalledWith(expect.anything(), params.forkFromParam);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ action: "fork-from", subagentId: "sa-new" });
  });

  it("start：合法绝对路径放行，顶层 params 原样透传（含 signal/model override）", async () => {
    vi.mocked(startHandler).mockResolvedValue({
      subagentId: "sa-1",
      slug: "demo",
      model: "p/m",
      response: { mode: "background" },
    } as never);
    setSubagentService({ execute: vi.fn() } as never);
    const tool = captureTool();
    const params = {
      action: "start",
      task: "t",
      slug: "demo",
      skillPath: "/abs/skills/x.md",
      cwd: "/abs/cwd",
      model: "p/m",
    };
    const result = await tool.execute("c8", params, undefined, undefined, { mode: "rpc", hasUI: true });
    expect(vi.mocked(startHandler)).toHaveBeenCalledWith(expect.anything(), params, undefined, undefined);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ action: "start", subagentId: "sa-1", slug: "demo" });
  });
});

describe("subagent tool renderCall：model 预解析", () => {
  it("override 在场 + resolveModel 成功 → resolved 注入标题（provider/model · thinking）", () => {
    setSubagentService({
      resolveModel: () => ({ model: { provider: "p", id: "m1" }, thinkingLevel: "high" }),
    } as never);
    const tool = captureTool();
    const comp = tool.renderCall({ agent: "coder", model: "p/m1", thinkingLevel: "high", slug: "demo" }, markingTheme, {});
    const text = comp.render(200).join("");
    expect(text).toContain("p/m1");
    expect(text).toContain("· high");
    expect(text).toContain("demo");
  });

  it("resolveModel 抛错 → 降级不崩（标题无 model 段）", () => {
    setSubagentService({
      resolveModel: () => {
        throw new Error("registry cold");
      },
    } as never);
    const tool = captureTool();
    const comp = tool.renderCall({ agent: "coder", model: "p/m1" }, markingTheme, {});
    const text = comp.render(80).join("");
    expect(text).toContain("subagent");
    expect(text).not.toContain("p/m1");
  });

  it("service 缺席 → resolved undefined 降级；无 agent 字段兜底默认名", () => {
    const tool = captureTool(); // 槽空
    const comp = tool.renderCall({ task: "t" }, markingTheme, {});
    const text = comp.render(80).join("");
    expect(text).toContain("subagent");
    expect(text).not.toContain(" · high");
  });

  it("args 非 object（null）→ 不崩，标题仍渲染（isModelOverrideObj 假分支）", () => {
    setSubagentService({
      resolveModel: () => ({ model: { provider: "p", id: "m1" }, thinkingLevel: "high" }),
    } as never);
    const tool = captureTool();
    const comp = tool.renderCall(null, markingTheme, {});
    expect(comp.render(80).join("")).toContain("subagent");
  });
});
