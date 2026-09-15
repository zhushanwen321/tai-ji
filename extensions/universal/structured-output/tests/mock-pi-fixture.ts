// 公共 mock pi fixture（M5-T4 / M5-C2）
//
// 消除 characterization-hook.test.ts 与 structured-output.test.ts Workflow hook 组的
// ~40 行×2 同构重复（on 收集回调 / emit 按注册顺序触发 / sendUserMessage+registerTool spy）。
// 无 .test. 后缀——vitest include 仅匹配 tests/**/*.test.ts，本文件不执行。
//
// loadExtension：设 process.env[PI_WORKFLOW_SCHEMA] + vi.resetModules + 动态 import
// '../src/index.js'（fixture 位于 tests/ 根下，相对路径与消费方一致），再调 mod.default(mockPi)。
// restoreSchemaEnv(original)：只处理 env——消费方 afterEach 必须保留自己的 vi.restoreAllMocks()。
//
// U2（D3 闸门）增量：emit 第二参数恒传 handlerCtx（含 shutdown spy）；appendEntry
// 提升到 partial 供断言；failedToolEndWith / paramLayerErrorText 构造失败事件原料。
// 向后兼容——既有消费方（workflow-hook 两测试）不受影响。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

export const SCHEMA_ENV_NAME = "PI_WORKFLOW_SCHEMA";

export function createMockPi() {
  const handlers = new Map<string, ((...args: unknown[]) => Promise<void> | void)[]>();
  const sendUserMessage = vi.fn();
  const appendEntry = vi.fn();
  // U2（D3 闸门）：事件 handler 的第二参数 ctx（ExtensionContext）。
  // pi 真实形态：shutdown/abort 存在于 ctx（ExtensionContextActions），不在 pi 顶层
  // API——闸门 terminal 时经 ctx.abort()（停当前 turn）+ ctx.shutdown()（请求优雅
  // 退出）终止子进程。mock 只补齐闸门消费的成员。
  const shutdown = vi.fn();
  const abort = vi.fn();
  const handlerCtx = { shutdown, abort };
  // on 的类型保持 Mock<Procedure>（vi.fn() 无实现）——Mock 调用签名参数是 any，
  // 赋给 ExtensionAPI 的 on 重载兼容；收集逻辑经 mockImplementation 注入，规避
  // 宽签名回调（参数逆变）与重载 handler 的静态类型冲突。
  const on = vi.fn();
  on.mockImplementation((event: string, cb: (...args: unknown[]) => Promise<void> | void) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event)!.push(cb);
  });
  return {
    sendUserMessage,
    appendEntry,
    /** 断言入口：ctx.shutdown 的 spy（闸门 terminal 行为断言用）。 */
    ctx: handlerCtx,
    registerTool: vi.fn(),
    on,
    // 驱动器：按注册顺序触发某事件的所有回调（第二参数恒传 handlerCtx）
    async emit(event: string, payload: unknown): Promise<void> {
      for (const cb of handlers.get(event) ?? []) {
        await cb(payload, handlerCtx);
      }
    },
  };
}

// 补齐 ExtensionAPI 全部成员——fixture 无 .test. 后缀会被 tsc 检查，而消费方 .test.ts
// 被 tsconfig exclude（原版同构 mock 定义在 .test.ts 里从不被检查）。补齐方法均为未用
// spy，行为零变化（现有用例只断言 sendUserMessage / on / emit）。
function toFullExtensionAPI(partial: ReturnType<typeof createMockPi>): ExtensionAPI {
  return {
    ...partial,
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerMarkdownTransformer: vi.fn(),
    sendMessage: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(),
    setLabel: vi.fn(),
    exec: vi.fn(),
    getActiveTools: vi.fn(),
    getAllTools: vi.fn(),
    setActiveTools: vi.fn(),
    getCommands: vi.fn(),
    setModel: vi.fn(),
    getThinkingLevel: vi.fn(),
    setThinkingLevel: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
  };
}

export async function loadExtension(
  mockPi: ReturnType<typeof createMockPi>,
  schemaJson: string | undefined,
): Promise<void> {
  // U1 装配分岔：schemaJson = undefined 表示无 env（日常变体路径）。
  // 注意必须 delete 而非赋空串——空串 env 在入口处与未设置同义（`if (schemaEnv)` truthy 语义），
  // 但测试里 delete 才能真实模拟「未设置」。
  if (schemaJson === undefined) delete process.env[SCHEMA_ENV_NAME];
  else process.env[SCHEMA_ENV_NAME] = schemaJson;
  // 动态 import 确保每次拿到模块级 const（环境变量已设好）。
  // vitest 默认缓存模块，这里用 vi.resetModules + 动态 import 重置。
  vi.resetModules();
  const mod = await import("../src/index.js");
  mod.default(toFullExtensionAPI(mockPi));
}

export function restoreSchemaEnv(original: string | undefined): void {
  if (original === undefined) delete process.env[SCHEMA_ENV_NAME];
  else process.env[SCHEMA_ENV_NAME] = original;
}

export const SCHEMA = JSON.stringify({ type: "object", properties: { count: { type: "number" } }, required: ["count"] });
// 校验失败时 Pi 把错误文本（参数层 immediate 路径 / execute 抛错）塞进 result.content[0].text。
export const FAILED_TOOL_END = {
  type: "tool_execution_end",
  toolName: "structured-output",
  isError: true,
  result: { content: [{ type: "text", text: "Schema validation failed: /count must be number" }] },
};
export const SUCCESS_TOOL_END = {
  type: "tool_execution_end",
  toolName: "structured-output",
  isError: false,
  result: { details: { count: 5 } },
};
// 默认值用 pi-ai StopReason 真实枚举成员 "stop"（pi-ai dist/types.d.ts:275；披露修正：
// 曾误用不存在的 "end_turn"——handler 只判特定值故测试行为不受影响，但 fixture 应如实建模）。
export const turnEndPayload = (stopReason = "stop") => ({ message: { stopReason } });

/**
 * U2（D3 闸门）增量：按错误文本构造 structured-output 失败事件——
 * 同/异签名、参数层回显形态（"Received arguments:" 起的实参块）的测试原料。
 */
export function failedToolEndWith(errorText: string, toolName = "structured-output") {
  return {
    type: "tool_execution_end",
    toolName,
    isError: true,
    result: { content: [{ type: "text", text: errorText }] },
  };
}

/** pi-ai 参数层错误的原生格式（validation.js errorMessage）：错误行 + 实参回显。 */
export function paramLayerErrorText(errorLines: string, argsEcho: string): string {
  return `Validation failed for tool "structured-output":\n${errorLines}\n\nReceived arguments:\n${argsEcho}`;
}
