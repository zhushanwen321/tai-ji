/**
 * chat 组件测试 helper（w6 chat-ui-and-shell T7）。
 *
 * 提供 mock ChatViewDeps 的 provide 对象构造，供迁移的行为型测试 mount 组件时注入
 * （替代 renderer 旧 vi.mock(store/composable) 模式）；以及 Block 工具分支测试的
 * 共享 stub / ToolCall fixture / mount 编排（Block.test.ts 与 BlockWorkflow.test.ts
 * 公共样板提取）。
 */
import { mount } from '@vue/test-utils'
import { h } from 'vue'
import { vi } from 'vitest'
import { Block, ChatViewDepsKey } from '@taiji/ui'
import type { ChatViewDeps } from '@taiji/ui'
import type { ToolCall } from '@taiji/shared'

/** 构造 mock ChatViewDeps（所有字段 vi.fn 或合理默认，零真 store） */
export function createMockDeps(overrides: Partial<ChatViewDeps> = {}): ChatViewDeps {
  return {
    getMessages: () => [],
    isActive: () => false,
    isHandingOff: () => false,
    getChangeSetStatus: () => undefined,
    isExpanded: () => false,
    isTakeover: () => false,
    // [D3] submitEdit 双发锁默认放行（不互斥）；互斥用例经 overrides 注入
    isPendingSend: () => false,
    toggleExpand: vi.fn(),
    collapse: vi.fn(),
    setTakeover: vi.fn(),
    abortBash: vi.fn(),
    editAndResend: vi.fn(),
    onFork: vi.fn(),
    onForkAsk: vi.fn(),
    onHandoff: vi.fn(),
    onHandoffAsk: vi.fn(),
    openDrawer: vi.fn(),
    onFileClick: vi.fn(),
    onAmbiguousSelect: vi.fn(),
    loadFileCandidates: vi.fn().mockResolvedValue([]),
    renderMarkdown: vi.fn().mockResolvedValue([]),
    renderMermaid: vi.fn().mockResolvedValue({ svg: '' }),
    toMarkdown: vi.fn().mockReturnValue(''),
    ...overrides,
  }
}

/** 构造 provide 对象（ChatViewDepsKey → mock），供 mount global.provide 用 */
export function mockChatProvide(overrides: Partial<ChatViewDeps> = {}) {
  return {
    [ChatViewDepsKey as symbol]: createMockDeps(overrides),
  }
}

// ── Block 工具分支测试共享 stub（挂载即暴露 data-testid，可检测组件是否尝试渲染）──

export const GuiStub = {
  name: 'GuiComponentRenderer',
  props: { component: { type: Object, default: undefined } },
  setup() {
    return () => h('div', { 'data-testid': 'gui-renderer-stub' })
  },
}

export const AnsiStub = {
  name: 'AnsiText',
  props: { content: { type: String, default: '' } },
  setup() {
    return () => h('div', { 'data-testid': 'ansi-text-stub' })
  },
}

export const MdStub = {
  name: 'MarkdownRenderer',
  props: { content: { type: String, default: '' }, variant: { type: String, default: undefined } },
  setup() {
    return () => h('div', { class: 'stub-md-render' })
  },
}

/** 默认 ToolCall fixture（read 工具 completed 形态）；workflow 等专属 fixture 经 over 覆写构造。 */
export function makeToolCall(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-1',
    toolName: 'read',
    input: { path: '/tmp/foo.txt' },
    status: 'completed',
    startTime: 1000,
    endTime: 5000,
    ...over,
  }
}

/** mount Block 工具分支（stub 掉 Gui/Ansi/Md 子渲染，隔离 header/交互断言）。 */
export function mountToolBlock(tool: ToolCall) {
  return mount(Block, {
    props: { type: 'tool', tool },
    global: {
      stubs: {
        GuiComponentRenderer: GuiStub,
        AnsiText: AnsiStub,
        MarkdownRenderer: MdStub,
      },
    },
  })
}
