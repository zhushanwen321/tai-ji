/**
 * ToastContainer 行为测试（notify 优化：session 定位行 + 尺寸排版 + 交互）。
 *
 * 覆盖（三视角之使用者黑盒：每条断言落到用户可见 DOM）：
 * 1. sessionLabel + sessionId 存在 → 渲染定位行按钮（点击跳转来源 session 并关闭 toast）；
 *    不存在 → 不渲染定位行（纯消息形态退化）
 * 2. 消息体消费 whitespace-pre-line + line-clamp-5（多行通知换行、5 行封顶），
 *    容器 max-w 收敛（不再被长消息撑宽）
 * 3. hover 暂停：mouseenter 后超时 advance toast 仍留存，mouseleave 恢复到期移除
 *
 * useSidebar 重依赖（导航栈/sessionApi/LRU 编排），mock 只出 selectSession spy。
 * 进出场过渡的源码级回归守卫见 ToastContainer.transition.test.ts（不重复覆盖）。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/ui/__tests__/ToastContainer.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import { useToast } from '@/composables/useToast'

const selectSessionSpy = vi.fn()
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ selectSession: selectSessionSpy }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  selectSessionSpy.mockReset()
})

afterEach(() => {
  // 模块级单例：清空在列 toast，避免跨用例污染
  const { toasts, remove } = useToast()
  for (const t of [...toasts.value]) remove(t.id)
  vi.useRealTimers()
})

describe('ToastContainer session 定位行', () => {
  it('有 sessionLabel+sessionId → 渲染定位行，点击跳转并关闭 toast', async () => {
    const { toasts, warning } = useToast()
    warning('Goal blocked. Use /goal resume.', {
      sessionLabel: '修通知组件 · taiji',
      sessionId: 'sid-9',
    })
    const wrapper = mount(ToastContainer)
    const id = toasts.value[0].id

    const locator = wrapper.find(`[data-testid="toast-session-${id}"]`)
    expect(locator.exists()).toBe(true)
    expect(locator.text()).toContain('修通知组件 · taiji')

    await locator.trigger('click')
    expect(selectSessionSpy).toHaveBeenCalledWith('sid-9')
    expect(toasts.value).toHaveLength(0) // 跳转后关闭
  })

  it('无 sessionLabel → 不渲染定位行（纯消息形态）', () => {
    const { toasts, info } = useToast()
    info('plain message')
    const wrapper = mount(ToastContainer)

    expect(wrapper.find(`[data-testid="toast-session-${toasts.value[0].id}"]`).exists()).toBe(false)
    expect(wrapper.find(`[data-testid="toast-message-${toasts.value[0].id}"]`).exists()).toBe(true)
  })
})

describe('ToastContainer 尺寸与多行排版', () => {
  it('消息体带 pre-line + line-clamp-5，容器 max-w 收敛', () => {
    const { toasts, info } = useToast()
    info('第一行\n第二行\n第三行')
    const wrapper = mount(ToastContainer)

    const body = wrapper.find(`[data-testid="toast-message-${toasts.value[0].id}"]`)
    expect(body.classes()).toContain('whitespace-pre-line')
    expect(body.classes()).toContain('line-clamp-5')
    expect(body.classes()).toContain('break-words')

    const card = body.element.closest('div.pointer-events-auto') as HTMLElement
    expect(card.className).toContain('max-w-[min(360px,100%)]')
  })

  it('定位契约：absolute 右上角锚定（非视口 fixed），随挂载点（main-area/main）定位', () => {
    const wrapper = mount(ToastContainer)

    // 容器即 TransitionGroup tag 元素（测试环境 VTU 将其 stub，class 透传在 stub 元素上）
    const container = wrapper.find('.absolute')
    expect(container.exists()).toBe(true)
    expect(container.classes()).toContain('top-4')
    expect(container.classes()).toContain('inset-x-4')
    expect(container.classes()).not.toContain('fixed')
    expect(container.classes()).not.toContain('bottom-6')
  })
})

describe('ToastContainer hover 暂停自动移除', () => {
  it('mouseenter 冻结计时，mouseleave 按剩余时长续走', async () => {
    vi.useFakeTimers()
    const { toasts, info } = useToast()
    info('hover to read')
    const wrapper = mount(ToastContainer)
    const id = toasts.value[0].id
    const card = wrapper.find('div.pointer-events-auto')

    await card.trigger('mouseenter')
    vi.advanceTimersByTime(10_000) // 暂停期间不消失
    expect(toasts.value).toHaveLength(1)

    await card.trigger('mouseleave')
    vi.advanceTimersByTime(4000) // 恢复后到期移除
    await nextTick() // timer 回调改 toasts 后 DOM 异步重渲染
    expect(toasts.value).toHaveLength(0)
    expect(wrapper.find(`[data-testid="toast-message-${id}"]`).exists()).toBe(false)
  })
})
