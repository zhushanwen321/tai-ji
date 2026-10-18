// canvas-harness.ts —— pi-canvas 测试共享装配 harness（session-manager 同款样板：
// registerTool 捕获 + before_agent_start 捕获 + rpc ctx 桩 + select 桩；断言全部留在各测试文件）。

import { expect, vi, type Mock } from "vitest";

import registerExtension from "../../index.js";

/** registerTool 捕获的注册工具形态（execute 以固定五参形态调用）。 */
export interface RegisteredTool { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  name: string;
  exposure?: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<unknown>;
  /** TUI 结果渲染 handler（renderCanvasToolResult，六工具同函数引用）。 */
  renderResult?: (result: unknown, options: { expanded: boolean }, theme: unknown) => unknown;
}

/** before_agent_start handler 的事件/ctx 最小形态（index.ts 只消费 systemPrompt 与 ctx.mode）。 */
export interface BeforeAgentStartShape { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  systemPrompt: string;
}

export type BeforeAgentStartHandler = (
  event: BeforeAgentStartShape,
  ctx: { mode: string },
) => { systemPrompt: string } | undefined;

export interface ToolHarness { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  registered: RegisteredTool[];
  selectMock: Mock;
  /** 捕获的 before_agent_start handler（index.ts 只注册一个；空数组 = 未注册）。 */
  beforeAgentStartHandlers: BeforeAgentStartHandler[];
  /** rpc 模式 ctx 桩（ui.select → selectMock）。 */
  ctx: { mode: "rpc"; hasUI: true; ui: { select: Mock } };
}

/** 挂载被测 extension：捕获六工具 + before_agent_start + select 桩。 */
export function mountCanvas(): ToolHarness {
  const registered: RegisteredTool[] = [];
  const beforeAgentStartHandlers: BeforeAgentStartHandler[] = [];
  registerExtension({
    registerTool: (tool: RegisteredTool) => registered.push(tool),
    on: (event: string, handler: BeforeAgentStartHandler) => {
      if (event === "before_agent_start") beforeAgentStartHandlers.push(handler);
    },
  } as never);
  const selectMock = vi.fn();
  const ctx = { mode: "rpc" as const, hasUI: true as const, ui: { select: selectMock } };
  return { registered, selectMock, beforeAgentStartHandlers, ctx };
}

/** 按名取已注册工具（缺名 = 注册面回归，直接红）。 */
export function toolOf(harness: ToolHarness, name: string): RegisteredTool {
  const tool = harness.registered.find((t) => t.name === name);
  expect(tool, `tool ${name} must be registered`).toBeDefined();
  return tool as RegisteredTool;
}

/** select 桩的一次 marker 调用解包（(marker, [payload], opts) 形态 → {marker, payload, opts}；取最近一次）。 */
export function lastMarkerCall(selectMock: Mock): { marker: string; payload: Record<string, unknown>; opts: unknown } {
  const call = selectMock.mock.calls[selectMock.mock.calls.length - 1] as [string, [string], unknown];
  return { marker: call[0], payload: JSON.parse(call[1][0]) as Record<string, unknown>, opts: call[2] };
}

/** env 信号保全切换（TAIJI_AGENT_EXT_LOG 非数据目录，无副作用面；用后即还）。
 * async 等待式：await fn() 完成后才恢复——env 变更覆盖被测代码的全部 await 点。 */
export async function withExtLogEnv<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.TAIJI_AGENT_EXT_LOG;
  if (value === undefined) delete process.env.TAIJI_AGENT_EXT_LOG;
  else process.env.TAIJI_AGENT_EXT_LOG = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.TAIJI_AGENT_EXT_LOG;
    else process.env.TAIJI_AGENT_EXT_LOG = prev;
  }
}
