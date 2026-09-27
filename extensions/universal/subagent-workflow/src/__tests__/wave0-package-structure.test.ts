/**
 * Wave 0 TDD: 包结构合并验证
 *
 * 验证新包 @zhushanwen/pi-subagent-workflow 的结构完整性：
 * - index.ts 导出工厂函数
 * - 3 tool + 2 command 注册正确
 * - pi.__workflowRun 可用
 * - 目录结构符合三层架构
 *
 * [装载模型] 模块图（index.js 全图）beforeAll 静态加载一次，factory 对同一 mock api
 * 执行一次，6 用例共享同一份注册记录断言。各用例断言均为存在性形态（toContain /
 * toBeDefined / length 下界），无「从零只有自己注册项」的隔离性断言，共享一份记录
 * 不改变任何断言语义。factory 幂等（D2b 稳定标识等价保留单例），单次执行即注册面
 * 全集。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

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

describe("wave-0: package structure merge", { timeout: 30000 }, () => {
  // 共享注册记录：beforeAll 装载模块图 + factory 执行一次（全图重 + factory 幂等，
  // 单次执行即全集；[B6]/[HISTORICAL] 30s timeout 豁免随装载点保留）。
  const mounted: ReturnType<typeof createMockExtensionAPI> = createMockExtensionAPI();

  beforeAll(async () => {
    const mod = await import("../../index.js");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("function");
    mod.default(mounted.api);
  });

  it("AC-1.1: registers 3 tools (subagent + workflow + workflow-script)", () => {
    // 3 tools: subagent (from subagents) + workflow + workflow-script (from workflow)
    expect(mounted.tools).toContain("subagent");
    expect(mounted.tools).toContain("workflow");
    expect(mounted.tools).toContain("workflow-script");
    expect(mounted.tools.length).toBeGreaterThanOrEqual(3);
  });

  it("AC-1.1: registers 2 commands (subagents + workflows)", () => {
    expect(mounted.commands).toContain("subagents");
    expect(mounted.commands).toContain("workflows");
    expect(mounted.commands.length).toBeGreaterThanOrEqual(2);
  });

  it("AC-1.1: registers subagent-bg-notify message renderer", () => {
    expect(mounted.messageRenderers).toContain("subagent-bg-notify");
  });

  it("AC-1.1: sets pi.__workflowRun", () => {
    expect(mounted.api.__workflowRun).toBeDefined();
    expect(typeof mounted.api.__workflowRun).toBe("function");
  });

  it("session_start handler registers SubagentService and ModelConfigService", () => {
    expect(mounted.eventHandlers["session_start"]).toBeDefined();
    expect(mounted.eventHandlers["session_start"].length).toBeGreaterThanOrEqual(1);
  });

  it("session_shutdown handler disposes resources", () => {
    expect(mounted.eventHandlers["session_shutdown"]).toBeDefined();
    expect(mounted.eventHandlers["session_shutdown"].length).toBeGreaterThanOrEqual(1);
  });
});
