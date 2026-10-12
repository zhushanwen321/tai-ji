/**
 * Turn.vue 首屏冒烟测试（fast-handoff wave）。
 *
 * Turn.vue 是编排器：fork/handoff 按钮下沉到 TurnSummary 子组件；[actions-anchor] 起
 * TurnSummary 经末位 text 块（Block）的 #turn-actions 插槽挂载，悬停区 = text 块本身。
 * 冒烟验证：
 * - 有 assistant（含 text 块）时锚块包装层存在，TurnSummary 挂载并透传 lastAssistant
 * - 无 assistant（无 text 块）时无锚块，TurnSummary 不挂载
 *
 * mount 真实 Block + stub 其余子组件（shallowMount 的 stub 不渲染具名插槽，探不到插槽挂载的
 * TurnSummary）。fork/handoff 按钮的 data-testid / disabled 守卫单测在 TurnSummary 维度覆盖
 * （本文件 TurnSummary 以 stub 出现，断言 testid 无意义）。Turn.vue 维度只校验编排挂载了
 * 正确的子组件。
 *
 * [w6 chat-ui-and-shell T7] ui 包 Turn 经 ChatViewDeps inject 消费依赖，
 * 原 renderer store/composable vi.mock（chatStore/useChat/useSidebar/useTurnElapsed）
 * 已失效，改为 mount 时 provide mock deps（isHandingOff 守卫断言经 overrides 注入）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/Turn.smoke.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import type { Message } from '@taiji/shared'
import { Turn } from '@taiji/ui'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'

// __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之
vi.stubGlobal('__APP_VERSION__', '0.0.0-test')

/** 构造最小 MessageTurn（含一条 assistant，触发 handoff/fork 按钮渲染） */
function makeTurn(overrides: Partial<MessageTurn> = {}): MessageTurn {
  const assistant: Message = {
    id: 'a-1',
    role: 'assistant',
    content: 'hello',
    segments: [],
    status: 'complete',
    createdAt: Date.now(),
  }
  return {
    index: 0,
    user: null,
    assistants: [assistant],
    isStreaming: false,
    hasFoldable: false,
    ...overrides,
  }
}

/** mount Turn（真实 Block）：stub 编排器其余子组件 + provide mock ChatViewDeps */
function mountTurn(turn: MessageTurn, depsOverrides: Record<string, unknown> = {}) {
  return mount(Turn, {
    props: { turn, sessionId: 'test-session' },
    global: {
      plugins: [createPinia()],
      provide: mockChatProvide(depsOverrides),
      stubs: {
        UserBubble: true,
        TurnMeta: true,
        TurnSummary: true,
        ChangeSetCard: true,
        MarkdownRenderer: true,
        TraceCompactorRow: true,
        BashOutputBlock: true,
        SystemNotice: true,
      },
    },
  })
}

describe('Turn.vue 冒烟', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('有 assistant 时锚块包装层存在，TurnSummary 挂载并透传 lastAssistant（handoff/fork 按钮宿主）', () => {
    const turn = makeTurn()
    const wrapper = mountTurn(turn)
    // [actions-anchor] 操作栏插槽包装层挂在末位 text 块行内（group/text）
    expect(wrapper.find('[data-testid="turn-actions-anchor"]').exists()).toBe(true)
    const summary = wrapper.findComponent({ name: 'TurnSummary' })
    expect(summary.exists()).toBe(true)
    expect(summary.props('lastAssistant')).toEqual(turn.assistants[0])
  })

  it('无 assistant（无 text 块）时无锚块，TurnSummary 不挂载', () => {
    const wrapper = mountTurn(makeTurn({ assistants: [] }))
    expect(wrapper.find('[data-testid="turn-actions-anchor"]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'TurnSummary' }).exists()).toBe(false)
  })
})
