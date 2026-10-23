/**
 * plan 工具测试共享布景（enter.test.ts / tool.test.ts 的 setup 同构部分单点）：
 * ctx 工厂 + registerTool 桩的 execute 回调捕获。两文件 setup 的 fake pi 能力集
 * 是真差异（enter 版带 sendMessage/getCommands/skillCommands 参数；tool 版带
 * TOOL_SEARCH exposure 布景），各自留在本文件不合并。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

/** 独立 pi 的全量工具名布景（getAllTools / getActiveTools 派生共用）。 */
export const ALL_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "plan", "write", "edit"];

/** plan 工具 execute 的返回形态（tool result 正文 + details 结构）。 */
export type PlanExecuteResult = {
  content: Array<{ type: string; text: string }>;
  details: { action: string; requirement?: string; skills?: string[] };
};

/** 标准测试 ctx 布景（TUI 形态；GUI 用例拿到后覆写 mode / ui.select mock 等字段）。 */
export function createTestCtx() {
  return {
    sessionId: "test-session",
    cwd: "/tmp/test-project",
    hasUI: true,
    mode: "tui" as const,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "test-session", getLeafId: () => null, getEntries: () => [] },
    ui: { select: vi.fn(), notify: vi.fn() },
  };
}

/**
 * registerTool 桩的 execute 回调捕获 + 标准入参 exec 闭包（id 恒 "tc0"、ctx 布景
 * 注入末参）。返回的 registerTool 桩装进各文件的 fake pi 对象。
 */
export function createExecCapture<R = unknown>(ctx: unknown) {
  type ExecuteFn = (id: string, p: Record<string, unknown>, sig?: AbortSignal, upd?: unknown, ctx?: unknown) => Promise<R>;
  let executeFn: ExecuteFn | undefined;
  return {
    registerTool: vi.fn((tool: { execute: ExecuteFn }) => {
      executeFn = tool.execute;
    }),
    exec: (params: Record<string, unknown>, signal?: AbortSignal): Promise<R> =>
      executeFn!("tc0", params, signal, undefined, ctx),
  };
}

/**
 * enter 族 fake pi 骨架（enter.test.ts / skills.test.ts 共用）：register 入口字段由
 * 调用方以单键对象注入（enter 用 registerTool 捕获 tool.execute；skills 用
 * registerCommand 捕获 command handler——字段名是 pi API 的真差异），getCommands
 * 的命令清单由参数给定（enter 按用例参数派生；skills 用固定 SKILL_COMMANDS 布景）。
 */
export function createEnterFamilyPi(register: Record<string, unknown>, commands: unknown): ExtensionAPI {
  return {
    ...register,
    appendEntry: vi.fn(),
    setActiveTools: vi.fn(),
    // 快照式恢复（dmg-r1-2）：enter 收拢前记录进入前激活集（getActiveTools）
    getActiveTools: vi.fn(() => ALL_TOOL_NAMES.filter((n) => n !== "plan")),
    sendMessage: vi.fn(),
    getCommands: vi.fn(() => commands),
    getAllTools: vi.fn(() => ALL_TOOL_NAMES.map((n) => ({ name: n }))),
  } as unknown as ExtensionAPI;
}
