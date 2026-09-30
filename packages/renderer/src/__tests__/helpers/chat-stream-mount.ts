/**
 * 聊天流壳测试共享 mock 工厂与装配工具单源（Wave C r2-05 chatDepsMock 收敛）。
 *
 * 导出面：
 * - 壳 mock 三工厂：chatViewDepsModule / useChatMockModule / useSidebarMockModule
 *   （vi.mock 注册形态：测试文件自行 vi.mock 转发，或 import
 *   message-stream-shell-mount.ts 由其顶层注册）
 * - virtuaVueMockModule：'virtua/vue' 简化版 mock 工厂（Virtualizer stub 全量渲染
 *   scoped slot）；vi.mock 注册留在测试文件
 * - NoopResizeObserver / resetMessageStreamEnv / messageStreamStubs /
 *   makeStreamMessageFactory：MessageStream 装配族测试的公共工具
 *
 * 约束：本文件禁止 import 被测组件（如 MessageStream.vue）——message-stream-shell-mount.ts
 * 依赖本文件做顶层 mock 注册，注册必须早于被测组件加载，本文件引入组件依赖会经传递
 * 加载把注册时序倒转。
 *
 * vitest 按测试文件隔离模块图：各单例/工厂产物在每个测试文件内是独立实例（文件内
 * mock 工厂与断言共享同一批 vi.fn，与原 vi.hoisted 文件内单例语义一致）。
 *
 * 变体保留未收敛：
 * - MessageStream-truncated-bar.test.ts：23 键版（多 isTakeover/isPendingSend/setTakeover）
 * - MessageStream-kind.test.ts：内联 virtua mock 复杂版（slotKeyCollector/keepMountedCollector
 *   收集器 + keepMounted 渲染循环语义——收集器断言依赖文件内 vi.hoisted 状态，不可共享）
 */
import { vi } from 'vitest'
import { defineComponent, h, type ComponentOptions } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { Message } from '@taiji/shared'

/** 聊天流壳 deps mock 单例（20 键全量默认面，零真 store；测试可断言 vi.fn 调用）。 */
export const chatDepsMock = {
  getMessages: vi.fn(() => []),
  isActive: vi.fn(() => false),
  isHandingOff: vi.fn(() => false),
  getChangeSetStatus: vi.fn(() => undefined),
  isExpanded: vi.fn(() => false),
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
  loadFileCandidates: vi.fn(() => Promise.resolve([])),
  renderMarkdown: vi.fn(() => Promise.resolve([])),
  renderMermaid: vi.fn(() => Promise.resolve({ svg: '' })),
  toMarkdown: vi.fn(() => ''),
}

/** '@/composables/panel/useChatViewDeps' mock 工厂（转发 chatDepsMock 单例）。 */
export function chatViewDepsModule() {
  return {
    useChatViewDeps: () => chatDepsMock,
  }
}

/** '@/composables/features/chat/useChat' mock 工厂（壳依赖：useChat 窄面，测试聚焦渲染分发）。 */
export function useChatMockModule() {
  return {
    useChat: () => ({
      editAndResend: vi.fn(),
      loadMoreHistory: vi.fn(),
      hasMoreHistory: () => false,
    }),
    resetChatModuleState: vi.fn(),
  }
}

/** '@/composables/features/sidebar/useSidebar' mock 工厂（壳依赖：useSidebar 窄面）。
 *  selectSession 为 ActivityStrip 集成用例（挂真实 MessageStream）的无害多余键——
 *  i18n-toast-mock warning 键同款先例，不消费方不读取即无影响。 */
export function useSidebarMockModule() {
  return {
    useSidebar: () => ({ forkSession: vi.fn(), abortHandoff: vi.fn(), selectSession: vi.fn() }),
  }
}

/** happy-dom 不提供真实 ResizeObserver 布局测量，stub 成 no-op（beforeEach 里 stubGlobal 用）。 */
export class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * MessageStream 测试的外围组件 stub 集：Turn 按测试聚焦点由调用方传入变体
 * （forceWorking 接线 / 编辑事件链 / 纯占位等），其余外围组件统一极简 stub；
 * 断言「kind → 组件」选中关系的测试传 stubTestids（SystemNotice/BashOutputBlock
 * 带 data-testid，选中哪个就渲染哪个 testid）。
 */
export function messageStreamStubs(turnStub: ComponentOptions, opts: { stubTestids?: boolean } = {}) {
  return {
    Turn: turnStub,
    SystemNotice: {
      name: 'SystemNotice',
      template: opts.stubTestids ? '<div data-testid="system-notice-stub" />' : '<div />',
    },
    BashOutputBlock: {
      name: 'BashOutputBlock',
      template: opts.stubTestids ? '<div data-testid="bash-output-stub" />' : '<div />',
    },
    ForkNotice: { name: 'ForkNotice', template: '<div />' },
    Button: { name: 'Button', template: '<button><slot /></button>' },
  }
}

/** MessageStream 测试 beforeEach 公共重置：新 pinia + ResizeObserver no-op + scrollTo 捕获。 */
export function resetMessageStreamEnv(): void {
  setActivePinia(createPinia())
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  HTMLElement.prototype.scrollTo = vi.fn()
}

/**
 * 聊天流测试消息工厂的工厂：按测试聚焦点定 role 缺省（system 类消息族 / turn 消息族），
 * 其余缺省字段统一补全。用法：`const makeMsg = makeStreamMessageFactory('system')`。
 */
export function makeStreamMessageFactory(defaultRole: Message['role']) {
  return (over: Partial<Message>): Message =>
    ({
      id: 'm1',
      role: defaultRole,
      content: '',
      status: 'complete',
      timestamp: Date.now(),
      ...over,
    }) as Message
}

/**
 * 'virtua/vue' mock 工厂（简化版）：Virtualizer stub 全量渲染 scoped slot。
 *
 * 为什么 mock virtua：happy-dom 无真实布局/ResizeObserver，真 <Virtualizer> 的
 * viewportSize=0 → 不窗口化渲染任何项（完整论证见 MessageStream-kind.test.ts 文件头）。
 * stub 让模板 v-if/v-else-if/v-else 链对每项真实执行。
 *
 * setup 暴露 VirtualizerHandle 兼容字段（MessageStream 的 rail/useVirtuaFollow 在
 * mount 期读取 scrollSize/findItemIndex/getItemOffset 等；vi.fn 保证不会调崩）。
 * scrollRef prop 吸收 MessageStream 的 :scroll-ref 绑定：不声明则落 reactive attrs，
 * dev 下挂载期触发额外自渲染。需要收集器断言（slot key / keepMounted）的测试用
 * MessageStream-kind.test.ts 内联复杂版。
 */
export function virtuaVueMockModule() {
  return {
    Virtualizer: defineComponent({
      name: 'MockVirtualizer',
      props: {
        data: { type: Array, default: () => [] },
        scrollRef: { type: Object, default: null },
      },
      setup() {
        return {
          scrollSize: 600,
          scrollOffset: 0,
          viewportSize: 400,
          cache: {},
          scrollToIndex: vi.fn(),
          getItemOffset: vi.fn(() => 0),
          getItemSize: vi.fn(() => 200),
          findItemIndex: vi.fn(() => 0),
          scrollTo: vi.fn(),
          scrollToItem: vi.fn(),
          scrollBy: vi.fn(),
        }
      },
      render(ctx: { data: unknown[]; $slots: { default?: (args: { item: unknown; index: number }) => unknown[] } }) {
        return h(
          'div',
          { class: 'mock-virtualizer' },
          ctx.data.map((item, index) => ctx.$slots.default?.({ item, index }) ?? []),
        )
      },
    }),
  }
}
