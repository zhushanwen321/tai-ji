/**
 * Turn.vue 首屏冒烟测试（fast-handoff wave）。
 *
 * W4 拆分后 Turn.vue 是编排器：fork/handoff 按钮下沉到 TurnSummary 子组件。
 * 冒烟验证：
 * - TurnSummary 子组件在有 assistant 时渲染（承载 handoff/fork 按钮的 hover actions）
 * - TurnSummary 在无 assistant 时不渲染
 *
 * fork/handoff 按钮的 data-testid / disabled 守卫单测在 TurnSummary 维度覆盖（shallowMount 下
 * Turn 内是 stub，断言 testid 无意义）。Turn.vue 维度只校验编排器挂载了正确的子组件。
 *
 * [w6 chat-ui-and-shell T7] ui 包 Turn 经 ChatViewDeps inject 消费依赖，
 * 原 renderer store/composable vi.mock（chatStore/useChat/useSidebar/useTurnElapsed）
 * 已失效，改为 mount 时 provide mock deps（isHandingOff 守卫断言经 overrides 注入）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/Turn.smoke.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { shallowMount } from '@vue/test-utils'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import type { Message } from '@xyz-agent/shared'
import { Turn } from '@xyz-agent/ui'
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

/** shallowMount Turn：provide mock ChatViewDeps（isHandingOff 等守卫断言经 overrides 注入） */
function mountTurn(turn: MessageTurn, depsOverrides: Record<string, unknown> = {}) {
  return shallowMount(Turn, {
    props: { turn, sessionId: 'test-session' },
    global: {
      plugins: [createPinia()],
      provide: mockChatProvide(depsOverrides),
    },
  })
}

describe('Turn.vue 冒烟', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  // （原 5 用例压缩为 2：用例 1/2 断言完全相同、用例 3/4 等价——Turn.vue 维度的独立
  //  断言点只有「TurnSummary 挂载 + lastAssistant 透传」两相；depsOverrides 未被
  //  shallowMount 断言消费，已去。）
  it('有 assistant 时挂载 TurnSummary 并透传 lastAssistant（handoff/fork 按钮宿主）', () => {
    const turn = makeTurn()
    const wrapper = mountTurn(turn)
    // W4 编排器：handoff/fork 按钮下沉到 TurnSummary 子组件，shallowMount 下以 stub 出现
    const summary = wrapper.findComponent({ name: 'TurnSummary' })
    expect(summary.exists()).toBe(true)
    expect(summary.props('lastAssistant')).toEqual(turn.assistants[0])
  })

  it('无 assistant 时 TurnSummary 收到 null lastAssistant（fork/handoff 按钮在子组件内不渲染）', () => {
    const wrapper = mountTurn(makeTurn({ assistants: [] }))
    const summary = wrapper.findComponent({ name: 'TurnSummary' })
    expect(summary.exists()).toBe(true)
    // lastAssistant=null → TurnSummary 内部 v-if lastAssistant 守卫不渲染 fork/handoff 按钮
    expect(summary.props('lastAssistant')).toBeNull()
  })
})
