/**
 * chat 组件测试 helper（w6 chat-ui-and-shell T7）。
 *
 * ui 包 chat 展示组件经 ChatViewDeps inject token 消费壳层依赖。renderer 单组件测试
 * （mount Turn/Block/MarkdownRenderer/...）必须 provide 该 token，否则 useChatViewDeps()
 * 抛错。本 helper 提供 mock deps 构造 + provide 对象（对齐 ui 包
 * features/chat/__tests__/helpers.ts 的模式，renderer 侧自治副本）。
 *
 * 用法：
 * - 单组件 mount：global: { provide: mockChatProvide({ openDrawer: mockOpen }) }
 * - 容器 mount（MessageStream/DetailPane 壳已自 provide 真 deps）：
 *   vi.mock('@/composables/panel/useChatViewDeps', () => ({ useChatViewDeps: () => mockDepsInline }))
 */
import { vi } from 'vitest'
import { ChatViewDepsKey } from '@taiji/ui'
import type { ChatViewDeps } from '@taiji/ui'

/** 构造 mock ChatViewDeps（所有字段 vi.fn 或合理默认，零真 store） */
export function createMockChatDeps(overrides: Partial<ChatViewDeps> = {}): ChatViewDeps {
  return {
    getMessages: () => [],
    isActive: () => false,
    isHandingOff: () => false,
    getChangeSetStatus: () => undefined,
    isExpanded: () => false,
    toggleExpand: vi.fn(),
    collapse: vi.fn(),
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
    [ChatViewDepsKey as symbol]: createMockChatDeps(overrides),
  }
}
