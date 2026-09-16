/**
 * Panel inline ask-user 渲染测试（W2: U4-U5）。
 *
 * W2 把 ask-user 富交互从 dialog modal 搬到 Panel.vue 的 composer-band
 * （inline，覆盖 composer 位置）。当前 AskUserRequest 存在时渲染 AskUserOverlay，
 * 互斥隐藏 Composer；无 AskUserRequest 时渲染 Composer（原行为不变）。
 *
 * - U4: 有 ask-user 请求 → 渲染 AskUserOverlay，不渲染 Composer
 * - U5: 无 ask-user 请求 → 渲染 Composer，不渲染 AskUserOverlay
 * mock 策略：vi.mock useExtensionUI，用 vi.hoisted 模块级 ref 让每个 it 设置不同的
 * currentAskUserRequest 值。Panel 内 useExtensionUI(computed(sessionId)) 的返回值由此 mock 决定。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/ask-user-inline.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import Panel from '@/components/panel/Panel.vue'
import { useChatStore } from '@/stores/chat'
import { useExtensionUIStore } from '@/stores/extension-ui'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'

// ── vi.hoisted：mock 状态在 vi.mock 工厂执行前就绪，且可在 it 中改值 ──
// 不用 vue ref（hoisted 回调先于 import 初始化，引用 ref 触发 TDZ）；
// 用普通可变对象 { value }，Panel 里同样 .value 读写，行为等价 Ref。
const mockState = vi.hoisted(() => ({
  askUserReq: { value: undefined as ExtensionUIRequest | undefined },
  dialogReq: { value: undefined as ExtensionUIRequest | undefined },
  respond: () => {},
  cancel: () => {},
}))

vi.mock('@/composables/useExtensionUI', () => ({
  useExtensionUI: () => ({
    currentAskUserRequest: mockState.askUserReq,
    respond: mockState.respond,
    cancel: mockState.cancel,
  }),
  askUserFilter: (req: { askUser?: boolean }) => req.askUser === true,
}))

// stub 子组件（除 AskUserOverlay，断言其挂载）
const stubs = {
  PanelHeader: { template: '<div />' },
  MessageStream: { template: '<div data-testid="msg-stream" />' },
  // Composer stub testid 对齐真实 Composer.vue（data-testid="composer-box"，见 Composer.vue L25）
  Composer: { template: '<div data-testid="composer-box" />' },
  Landing: { template: '<div data-testid="landing">landing</div>' },
}

function mountPanel(sessionId: string | null) {
  return mount(Panel, {
    props: {
      panelId: 'panel-root',
      sessionId,
      sessionLabel: sessionId ?? '',
      sessionDir: '/repo',
      status: 'done' as never,
    },
    global: { stubs },
  })
}

const askUserReq: ExtensionUIRequest = {
  sessionId: 'session-A',
  requestId: 'req-1',
  method: 'select',
  askUser: true,
  askUserQuestions: [{ header: 'db', question: '选哪个数据库?', options: [{ label: 'Postgres' }] }],
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockState.askUserReq.value = undefined
  mockState.dialogReq.value = undefined
})

describe('Panel inline ask-user 渲染（W2）', () => {
  it('U4: 有 ask-user 请求 → 渲染 AskUserOverlay，不渲染 Composer', () => {
    mockState.askUserReq.value = askUserReq

    const wrapper = mountPanel('session-A')

    // ask-user overlay 渲染
    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(true)
    // Composer 互斥隐藏（Composer 组件 v-else-if 不挂载，其 testid 不存在于 DOM）
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
  })

  it('U5: 无 ask-user 请求 → 渲染 Composer，不渲染 AskUserOverlay', () => {
    mockState.askUserReq.value = undefined

    const wrapper = mountPanel('session-A')

    // Composer 渲染
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    // ask-user overlay 不渲染
    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(false)
  })

})
