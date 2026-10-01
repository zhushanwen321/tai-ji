/**
 * chat 组件测试 helper（w6 chat-ui-and-shell T7）——renderer 侧薄门面。
 *
 * ui 包 chat 展示组件经 ChatViewDeps inject token 消费壳层依赖。renderer 单组件测试
 * （mount Turn/Block/MarkdownRenderer/...）必须 provide 该 token，否则 useChatViewDeps()
 * 抛错。mock ChatViewDeps 的唯一实装在 ui 包 features/chat/__tests__/helpers.ts
 * （契约本体归 ui；此前两包各持 49 行同构副本，收敛为单一来源），本文件按 renderer
 * 既有导入名（createMockChatDeps / mockChatProvide）re-export，不改变任何用例的用法。
 *
 * 用法：
 * - 单组件 mount：global: { provide: mockChatProvide({ openDrawer: mockOpen }) }
 * - 容器 mount（MessageStream/DetailPane 壳已自 provide 真 deps）：
 *   vi.mock('@/composables/panel/useChatViewDeps', () => ({ useChatViewDeps: () => mockDepsInline }))
 */
export { createMockDeps as createMockChatDeps, mockChatProvide } from '@taiji/ui/features/chat/__tests__/helpers'
