/**
 * Panel inline 统一表单渲染测试（W2: U4-U5 的 u4 接线版——FormOverlay 单渲染器）。
 *
 * 表单请求存在时渲染 FormOverlay（覆盖 composer 位置），互斥隐藏 Composer；
 * 无请求时渲染 Composer（原行为不变）。
 *
 * - U4: 有表单请求（form 帧）→ 渲染 FormOverlay，不渲染 Composer
 * - U5: 无表单请求 → 渲染 Composer，不渲染 FormOverlay
 * mock 策略：vi.mock useExtensionUI，用 vi.hoisted 模块级对象让每个 it 设置不同的
 * currentFormRequest 值（Panel 经 usePanelView 透传消费）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/ask-user-inline.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Panel from '@/components/panel/Panel.vue'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'

// ── vi.hoisted：mock 状态在 vi.mock 工厂执行前就绪，且可在 it 中改值 ──
// 不用 vue ref（hoisted 回调先于 import 初始化，引用 ref 触发 TDZ）；
// 用普通可变对象 { value }，Panel 里同样 .value 读写，行为等价 Ref。
const mockState = vi.hoisted(() => ({
  formReq: { value: undefined as ExtensionUIRequest | undefined },
  respond: () => {},
  cancel: () => {},
}))

vi.mock('@/composables/useExtensionUI', () => ({
  useExtensionUI: () => ({
    currentFormRequest: mockState.formReq,
    respond: mockState.respond,
    cancel: mockState.cancel,
  }),
  formFilter: (req: { form?: boolean }) => req.form === true,
}))

// stub 子组件（除 FormOverlay，断言其挂载）
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

/** form 帧造数（新 form 帧原生形状；legacy askUser 帧经归一同形） */
const formReq: ExtensionUIRequest = {
  sessionId: 'session-A',
  requestId: 'req-1',
  method: 'select',
  form: true,
  formQuestions: [{ type: 'choice', header: 'db', question: '选哪个数据库?', options: [{ label: 'Postgres' }] }],
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockState.formReq.value = undefined
})

describe('Panel inline 统一表单渲染（FormOverlay 单渲染器）', () => {
  it('U4: 有表单请求 → 渲染 FormOverlay，不渲染 Composer', () => {
    mockState.formReq.value = formReq

    const wrapper = mountPanel('session-A')

    // 统一表单 overlay 渲染
    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(true)
    // Composer 互斥隐藏（Composer 组件 v-else-if 不挂载，其 testid 不存在于 DOM）
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
  })

  it('U5: 无表单请求 → 渲染 Composer，不渲染 FormOverlay', () => {
    mockState.formReq.value = undefined

    const wrapper = mountPanel('session-A')

    // Composer 渲染
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    // 统一表单 overlay 不渲染
    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(false)
  })
})
