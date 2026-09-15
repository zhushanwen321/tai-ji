// src/orchestration/__tests__/test-mocks.ts
//
// Pi ExtensionAPI / ExtensionContext 测试 mock 工厂（PR #173 review S8）。
//
// 为什么需要工厂：此前测试用 `as never` 注入残缺 mock（如 `{ appendEntry: vi.fn() }`
// 直接塞进 `JsonlRunStoreOptions.pi`）。`as never` 是 bottom type 断言，mock 缺字段时
// 编译期零报错，比 `as unknown as T` 更危险。工厂返回**类型完整**的对象——被 mock
// 接口（真实 SDK 类型，tsc 按根 tsconfig 排除规则不检查 __tests__，但编辑器 LSP 与
// 显式 tsc 文件级检查会检查）新增成员时，这里补默认值即暴露，用例侧不再有断言后门。
//
// 语义约定：
// - 默认值贴近真实行为：sessionManager.getEntries 返回浅拷贝（真实 SessionManager
//   契约）；appendEntry 捕获变体追加完整 CustomEntry（真实 pi.appendEntry 即向 session
//   追加 CustomEntry）；isIdle → true、hasPendingMessages → false 等按真实语义取值。
// - 测试真正消费的成员（jsonl-run-store 只读 ctx.sessionManager.getEntries 与
//   pi.appendEntry）行为真实；其余成员为 no-op spy（vi.fn()），调用不炸但返回
//   undefined——本包测试不消费它们。
// - modelRegistry / ui.theme 是含 private 字段的 nominal class：真实构造需
//   ModelRuntime.create()（async + 读用户级 models.json）/ loadTheme 读包文件。
//   pi-coding-agent 在本包测试中仅剩 import type（转译擦除，无运行时导出可用），
//   结构构造又被 private 字段阻断。二者经 fail-loud Proxy 提供：误用时立即抛错（而非
//   静默 undefined），把「缺 mock」变成显式失败。这是本文件仅有的两处断言收敛点。

import { vi } from "vitest";

import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ModelRegistry,
  Theme,
} from "@earendil-works/pi-coding-agent";

/**
 * 误用即抛错的占位成员：比静默返回 undefined 的 no-op 更早暴露「缺 mock」。
 *
 * T 收窄为 object：调用点（ModelRegistry/Theme）均为对象类型；Proxy 静态类型是 `{}`，
 * 目标是 nominal class（private 字段阻断结构构造），单重 `as T` 断言已足够表达
 * 「结构上无法构造，运行时 fail-loud 兜底」的意图，无需 `as unknown as T` 双重断言。
 */
function failLoud<T extends object>(memberPath: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `[test-mocks] ${memberPath}.${String(prop)} 未提供 mock 实现——` +
            `本测试不应消费该成员；确需消费时经 overrides 显式提供`,
        );
      },
    },
  ) as T;
}

/**
 * 构造类型完整的 ExtensionContext。
 *
 * @param entries sessionManager.getEntries 的返回源（浅拷贝返回）。与 mkPi(entries)
 *   共享同一数组时可复现真实 pi 行为：appendEntry 写入 ↔ getEntries 读出。
 * @param overrides 覆写任意 ctx 字段（浅合并，整体替换成员，最后应用）。
 */
export function mkCtx(
  entries: CustomEntry[] = [],
  overrides: Partial<ExtensionContext> = {},
): ExtensionContext {
  const ctx: ExtensionContext = {
    ui: mkUi(),
    // pi 在 taiji 下以 rpc 子进程模式运行；rpc 模式 hasUI 为 true（SDK 契约注释）
    mode: "rpc",
    scopedModels: [],
    hasUI: true,
    cwd: "/tmp",
    sessionManager: {
      getCwd: () => "/tmp",
      getSessionDir: () => "/tmp/sessions-test",
      getSessionId: () => "session-test",
      // 真实语义：首条 assistant 消息前 session 文件未落盘，返回 undefined
      getSessionFile: () => undefined,
      getLeafId: () => null,
      getLeafEntry: () => undefined,
      getEntry: () => undefined,
      getLabel: () => undefined,
      getBranch: () => [],
      buildContextEntries: () => [],
      getHeader: () => null,
      // 真实 SessionManager.getEntries 返回浅拷贝
      getEntries: () => [...entries],
      getTree: () => [],
      getSessionName: () => undefined,
    },
    modelRegistry: failLoud<ModelRegistry>("ctx.modelRegistry"),
    // SDK 契约：model / signal 在 agent 未流式输出时合法为 undefined
    model: undefined,
    isIdle: vi.fn(() => true),
    isProjectTrusted: vi.fn(() => true),
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: vi.fn(() => false),
    shutdown: vi.fn(),
    getContextUsage: vi.fn(() => undefined),
    compact: vi.fn(),
    getSystemPrompt: vi.fn(() => ""),
  };
  return Object.assign(ctx, overrides);
}

/** ExtensionUIContext 完整 no-op mock（theme 为 fail-loud 占位，见文件头说明）。 */
function mkUi(): ExtensionUIContext {
  return {
    select: vi.fn(async () => undefined),
    confirm: vi.fn(async () => false),
    input: vi.fn(async () => undefined),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => () => {}),
    setStatus: vi.fn(),
    setWorkingMessage: vi.fn(),
    setWorkingVisible: vi.fn(),
    setWorkingIndicator: vi.fn(),
    setHiddenThinkingLabel: vi.fn(),
    setWidget: vi.fn(),
    setFooter: vi.fn(),
    setHeader: vi.fn(),
    setTitle: vi.fn(),
    custom: vi.fn(),
    pasteToEditor: vi.fn(),
    setEditorText: vi.fn(),
    getEditorText: vi.fn(() => ""),
    editor: vi.fn(async () => undefined),
    addAutocompleteProvider: vi.fn(),
    setEditorComponent: vi.fn(),
    getEditorComponent: vi.fn(() => undefined),
    theme: failLoud<Theme>("ctx.ui.theme"),
    getAllThemes: vi.fn(() => []),
    getTheme: vi.fn(() => undefined),
    setTheme: vi.fn(() => ({ success: true })),
    getToolsExpanded: vi.fn(() => false),
    setToolsExpanded: vi.fn(),
  };
}

/**
 * 构造类型完整的 ExtensionAPI。
 *
 * @param entries 给定时，appendEntry 追加完整 CustomEntry 到该数组（真实
 *   pi.appendEntry 语义：向 session 追加 custom entry）；缺省为纯 spy（可断言
 *   调用次数、无副作用）。
 * @param overrides 覆写任意 pi 字段（浅合并，最后应用）。
 */
export function mkPi(
  entries?: CustomEntry[],
  overrides: Partial<ExtensionAPI> = {},
): ExtensionAPI {
  const appendEntry =
    entries === undefined
      ? vi.fn()
      : vi.fn((customType: string, data?: unknown) => {
          entries.push({
            type: "custom",
            customType,
            data,
            id: `entry-${entries.length}`,
            parentId: null,
            timestamp: new Date().toISOString(),
          });
        });
  const pi: ExtensionAPI = {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerMarkdownTransformer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => undefined),
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry,
    setSessionName: vi.fn(),
    getSessionName: vi.fn(() => undefined),
    setLabel: vi.fn(),
    exec: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
    getCommands: vi.fn(() => []),
    setModel: vi.fn(async () => true),
    getThinkingLevel: vi.fn(),
    setThinkingLevel: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => () => {}),
    },
  };
  return Object.assign(pi, overrides);
}
