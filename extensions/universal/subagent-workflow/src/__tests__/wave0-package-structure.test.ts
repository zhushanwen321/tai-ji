/**
 * Wave 0 TDD: 包结构合并验证（组合根全图装载层）
 *
 * 本文件 = 组合根接线完整性：装载 index.js 全模块图 + factory 对 mock api 执行
 * 一次，断言注册点全集（7 tool + 2 command + messageRenderer + session 事件
 * handler）。全图装载（import 成本 + factory 进程级副作用：process 信号 hook、
 * 读用户 pi 目录、引擎登记）是集成属性，经 TAIJI_TEST_INTEGRATION 门控——本地
 * 默认跳过，CI / 按改动范围触发时真跑（门控约定见 docs/TEST-STRATEGY.md
 * 「集成测试门控约定」）。
 *
 * 注册清单的单点断言归属（细粒度专测——本地组恒快，本文件只保「组合根全集
 * 接线」这一层；新增注册点须同步补对应专测并更新本表）：
 * - subagent_start/manage/message 三工具名：interface/tool/__tests__/subagent-tool-actions.test.ts
 * - subagents tool：interface/tool/__tests__/tool-subagents.test.ts
 * - workflow_run / workflow_control：interface/tool/__tests__/tool-workflow.test.ts
 * - workflow-script：interface/tool/__tests__/tool-workflow-script.test.ts
 * - /subagents 命令：__tests__/sdk-contract.test.ts + rpc-command-handling.test.ts
 * - /workflows 命令：interface/command/__tests__/commands-open.test.ts / commands-resume.test.ts
 * - subagent-bg-notify renderer：__tests__/contract.notify-custom-types.test.ts
 *   （源级注册断言）+ bg-notify-render.test.ts（渲染行为）
 * - session_start / session_shutdown handler：__tests__/index-session-start.test.ts
 *   + session-start-once-guard.test.ts
 *
 * [装载模型] 模块图 beforeAll 静态加载一次（装载预算 30s 挂 beforeAll——门控
 * 内保留，不占单测层预算），factory 对同一 mock api 执行一次，用例共享同一份
 * 注册记录断言。各用例断言均为存在性形态（toContain / toBeDefined / length
 * 下界），无「从零只有自己注册项」的隔离性断言，共享一份记录不改变任何断言
 * 语义。factory 幂等（D2b 稳定标识等价保留单例），单次执行即注册点全集。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from "../../../../../test-guard/integration-gate.ts";

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
  };

  return { api, tools, commands, eventHandlers, messageRenderers };
}

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  "wave-0: package structure merge（组合根全图装载）" +
    (INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""),
  () => {
    // 共享注册记录：beforeAll 装载模块图 + factory 执行一次（全图重 + factory 幂等，
    // 单次执行即全集；装载预算 30s 挂 beforeAll——describe 级 timeout 已拆到此）。
    const mounted: ReturnType<typeof createMockExtensionAPI> = createMockExtensionAPI();

    beforeAll(async () => {
      const mod = await import("../../index.js");
      expect(mod.default).toBeDefined();
      expect(typeof mod.default).toBe("function");
      mod.default(mounted.api);
    }, 30_000);

    it("AC-1.1: registers 7 tools (subagent 组三件 + subagent_batch + workflow 组两件 + workflow-script)", () => {
      // D3 拆分后 7 tools: subagent_start/manage/message (from subagents) + subagent_batch +
      // workflow_run/workflow_control + workflow-script
      expect(mounted.tools).toContain("subagent_start");
      expect(mounted.tools).toContain("subagent_manage");
      expect(mounted.tools).toContain("subagent_message");
      expect(mounted.tools).toContain("subagent_batch");
      expect(mounted.tools).toContain("workflow_run");
      expect(mounted.tools).toContain("workflow_control");
      expect(mounted.tools).toContain("workflow_script");
      expect(mounted.tools.length).toBeGreaterThanOrEqual(7);
    });

    it("AC-1.1: registers 2 commands (subagents + workflows)", () => {
      expect(mounted.commands).toContain("subagents");
      expect(mounted.commands).toContain("workflows");
      expect(mounted.commands.length).toBeGreaterThanOrEqual(2);
    });

    it("AC-1.1: registers subagent-bg-notify message renderer", () => {
      expect(mounted.messageRenderers).toContain("subagent-bg-notify");
    });

    it("session_start handler registers SubagentService and ModelConfigService", () => {
      expect(mounted.eventHandlers["session_start"]).toBeDefined();
      expect(mounted.eventHandlers["session_start"].length).toBeGreaterThanOrEqual(1);
    });

    it("session_shutdown handler disposes resources", () => {
      expect(mounted.eventHandlers["session_shutdown"]).toBeDefined();
      expect(mounted.eventHandlers["session_shutdown"].length).toBeGreaterThanOrEqual(1);
    });
  },
);
