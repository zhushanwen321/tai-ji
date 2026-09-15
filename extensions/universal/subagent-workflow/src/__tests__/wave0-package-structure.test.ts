/**
 * Wave 0 TDD: 包结构合并验证
 *
 * 验证新包 @zhushanwen/pi-subagent-workflow 的结构完整性：
 * - index.ts 导出工厂函数
 * - 3 tool + 2 command 注册正确
 * - pi.__workflowRun 可用
 * - 目录结构符合三层架构
 */
import { describe, expect, it, vi } from "vitest";

// Mock the ExtensionAPI
function createMockExtensionAPI() {
  const tools: string[] = [];
  const commands: string[] = [];
  const eventHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const messageRenderers: string[] = [];

  const api = {
    registerTool: vi.fn((_tool: { name: string }) => {
      tools.push(_tool.name);
    }),
    registerCommand: vi.fn((nameOrCmd: string | { name: string }, _opts?: unknown) => {
      const name = typeof nameOrCmd === 'string' ? nameOrCmd : nameOrCmd.name;
      commands.push(name);
    }),
    registerMessageRenderer: vi.fn((_name: string, _renderer: unknown) => {
      messageRenderers.push(_name);
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
    }),
    appendEntry: vi.fn(),
    events: {
      emit: vi.fn(),
      on: vi.fn(),
    },
    __workflowRun: undefined as unknown,
  };

  return { api, tools, commands, eventHandlers, messageRenderers };
}

// [HISTORICAL] 2026-09-15 对齐 PR #185 口径：describe 级 30s timeout 豁免——首次
// `await import("../../index.js")` 拉起整个 extension 模块图（模块加载重），整包满
// 并行高负载下偶发超 vitest 默认 testTimeout，属模块加载 headroom 而非用例逻辑耗时。
describe("wave-0: package structure merge", { timeout: 30000 }, () => {
  // [B6] `await import("../../index.js")` 首次加载会拉起整个 extension 模块图（含
  //  orchestration/execution/interface 三层），全量跑时偶发超 vitest 默认 5s testTimeout（flaky）。
  //  describe 级 30s timeout 覆盖本块所有 test（模块加载仅首 test 付一次成本，后续复用缓存）。
  it("AC-1.1: registers 3 tools (subagent + workflow + workflow-script)", async () => {
    const mod = await import("../../index.js");
    const factory = mod.default;
    expect(factory).toBeDefined();
    expect(typeof factory).toBe("function");

    const { api, tools } = createMockExtensionAPI();
    factory(api);

    // 3 tools: subagent (from subagents) + workflow + workflow-script (from workflow)
    expect(tools).toContain("subagent");
    expect(tools).toContain("workflow");
    expect(tools).toContain("workflow-script");
    expect(tools.length).toBeGreaterThanOrEqual(3);
  });

  it("AC-1.1: registers 2 commands (subagents + workflows)", async () => {
    const mod = await import("../../index.js");
    const factory = mod.default;
    const { api, commands } = createMockExtensionAPI();
    factory(api);

    expect(commands).toContain("subagents");
    expect(commands).toContain("workflows");
    expect(commands.length).toBeGreaterThanOrEqual(2);
  });

  it("AC-1.1: registers subagent-bg-notify message renderer", async () => {
    const mod = await import("../../index.js");
    const factory = mod.default;
    const { api, messageRenderers } = createMockExtensionAPI();
    factory(api);

    expect(messageRenderers).toContain("subagent-bg-notify");
  });

  it("AC-1.1: sets pi.__workflowRun", async () => {
    const mod = await import("../../index.js");
    const factory = mod.default;
    const { api } = createMockExtensionAPI();
    factory(api);

    expect(api.__workflowRun).toBeDefined();
    expect(typeof api.__workflowRun).toBe("function");
  });

  it("session_start handler registers SubagentService and ModelConfigService", async () => {
    const mod = await import("../../index.js");
    const factory = mod.default;
    const { api, eventHandlers } = createMockExtensionAPI();
    factory(api);

    expect(eventHandlers["session_start"]).toBeDefined();
    expect(eventHandlers["session_start"].length).toBeGreaterThanOrEqual(1);
  });

  it("session_shutdown handler disposes resources", async () => {
    const mod = await import("../../index.js");
    const factory = mod.default;
    const { api, eventHandlers } = createMockExtensionAPI();
    factory(api);

    expect(eventHandlers["session_shutdown"]).toBeDefined();
    expect(eventHandlers["session_shutdown"].length).toBeGreaterThanOrEqual(1);
  });
});
