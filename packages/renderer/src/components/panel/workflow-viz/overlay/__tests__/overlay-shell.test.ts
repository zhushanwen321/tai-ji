/**
 * OverlayShell 测试（display-containers §6.5/§7.3 浮层统一壳——三视角）。
 *
 * - 使用者黑盒：两通道关闭（右上关闭按钮 / 点遮罩；面板内点击不关）+ 标题栏 slot 与
 *   body slot 透传 + dialog 形态（role/aria-modal/aria-label）——每条用例至少一个
 *   用户可见 DOM 断言；
 * - 构建者白盒：Tab 焦点陷阱**注册点**随壳（open→注册面板 ref / close→注销 / 卸载注销，
 *   陷阱逻辑单源在编排器——`getOverlayFocusTrapPanel` 为读点）+ 焦点契约（打开 focus
 *   面板 / 关闭回 composer）；
 * - 观察者形态：ESC 不由壳消费（负向锚：无 close 事件、不 preventDefault——双监听会
 *   一次 Esc 连剥两层）+ IME 组合态不产生壳级动作（守卫单源在编排器 isComposing 前置）。
 *
 * DOM 契约：wfvz-overlay* 四锚点为 WorkflowVizOverlay 时代沿用 testid（抽壳零 DOM 变化，
 * e2e/docs/overlay 单测族共享），壳通用命名的改名清理登记在 OverlayShell 头注。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow-viz/overlay/__tests__/overlay-shell.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import OverlayShell from '../OverlayShell.vue'
import { getOverlayFocusTrapPanel, registerOverlayFocusTrapPanel } from '@/composables/features/app/key-orchestrator'

function mountShell(props: Record<string, unknown> = {}, slots?: Record<string, unknown>): VueWrapper {
  return mount(OverlayShell, {
    props: {
      open: true,
      label: '浮层标题',
      closeLabel: '关闭',
      ...props,
    },
    ...(slots ? { slots } : {}),
  })
}

afterEach(() => {
  // 注销陷阱目标（用例间隔离——注册点是模块级单例，泄漏会让下个用例误判）
  registerOverlayFocusTrapPanel(null)
})

describe('OverlayShell 壳（黑盒 DOM）', () => {
  it('open=false 不渲染；open=true 渲染 dialog 形态 + aria 文案（观察者形态）', () => {
    const closed = mountShell({ open: false })
    expect(closed.find('[data-testid="wfvz-overlay"]').exists()).toBe(false)
    const opened = mountShell()
    const panel = opened.find('[data-testid="wfvz-overlay-panel"]')
    expect(panel.exists()).toBe(true)
    expect(panel.attributes('role')).toBe('dialog')
    expect(panel.attributes('aria-modal')).toBe('true')
    expect(panel.attributes('aria-label')).toBe('浮层标题')
    expect(opened.find('[data-testid="wfvz-overlay-close"]').attributes('aria-label')).toBe('关闭')
  })

  it('标题栏 slot 与 body slot 透传（内容侧注入 header 信息与内容区）', () => {
    const wrapper = mountShell({}, {
      title: () => h('span', { 'data-testid': 'shell-title-probe' }, '标题内容'),
      default: () => h('div', { 'data-testid': 'shell-body-probe' }, '正文内容'),
    })
    const title = wrapper.find('[data-testid="shell-title-probe"]')
    expect(title.exists()).toBe(true)
    // 标题内容挂在标题栏内（关闭按钮恒在最右）
    expect(wrapper.find('[data-testid="wfvz-overlay-header"]').element.contains(title.element)).toBe(true)
    expect(wrapper.find('[data-testid="shell-body-probe"]').text()).toBe('正文内容')
  })

  it('两通道关闭①：右上关闭按钮点击 → close', async () => {
    const wrapper = mountShell()
    await wrapper.find('[data-testid="wfvz-overlay-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('两通道关闭②：点遮罩（面板外区域）→ close；面板内点击不关', async () => {
    const wrapper = mountShell()
    await wrapper.find('[data-testid="wfvz-overlay"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)

    const second = mountShell()
    await second.find('[data-testid="wfvz-overlay-panel"]').trigger('click')
    expect(second.emitted('close')).toBeUndefined()
  })

  it('ESC 不由壳消费（display-containers §6.7 唯一属主 = 栈序编排器，负向锚防双监听双触发）', async () => {
    const wrapper = mountShell()
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    window.dispatchEvent(e)
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(e.defaultPrevented, '壳不消费 Esc（连 preventDefault 约定也不置位）').toBe(false)
  })

  it('IME 组合态壳级零动作（守卫单源在编排器 isComposing 前置——组合态 Esc 不发 close）', async () => {
    const wrapper = mountShell()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('close')).toBeUndefined()
  })
})

describe('OverlayShell Tab 焦点陷阱注册点 + 焦点契约（构建者白盒）', () => {
  it('open→面板 ref 注册为陷阱目标 / close→注销；壳自身不监听 Tab（Tab 事件零动作）', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(OverlayShell, {
      props: { open: true, label: '浮层标题', closeLabel: '关闭' },
      attachTo: host,
    })
    try {
      await wrapper.vm.$nextTick()
      const panel = wrapper.find('[data-testid="wfvz-overlay-panel"]').element as HTMLElement
      expect(getOverlayFocusTrapPanel(), 'open 后面板注册给编排器浮层分支').toBe(panel)
      // Tab 不由壳消费（陷阱逻辑在编排器，本壳只供面板 ref）
      const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      window.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(false)

      await wrapper.setProps({ open: false })
      await wrapper.vm.$nextTick()
      expect(getOverlayFocusTrapPanel(), 'close 后注销陷阱目标').toBe(null)
    } finally {
      wrapper.unmount()
      host.remove()
    }
  })

  it('卸载同样注销陷阱目标（不留模块级残留指向已卸载面板）', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(OverlayShell, {
      props: { open: true, label: '浮层标题', closeLabel: '关闭' },
      attachTo: host,
    })
    await wrapper.vm.$nextTick()
    expect(getOverlayFocusTrapPanel()).not.toBe(null)
    wrapper.unmount()
    expect(getOverlayFocusTrapPanel(), '卸载后注销').toBe(null)
    host.remove()
  })

  it('焦点契约（display-containers §6.7）：打开 focus 面板；关闭后焦点回 composer', async () => {
    const box = document.createElement('div')
    box.className = 'composer-box'
    box.setAttribute('data-testid', 'composer-box')
    const input = document.createElement('div')
    input.setAttribute('contenteditable', 'true')
    box.appendChild(input)
    document.body.appendChild(box)

    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(OverlayShell, {
      props: { open: false, label: '浮层标题', closeLabel: '关闭' },
      attachTo: host,
    })
    await wrapper.setProps({ open: true })
    await wrapper.vm.$nextTick()
    const panel = wrapper.find('[data-testid="wfvz-overlay-panel"]').element as HTMLElement
    expect(document.activeElement, '打开即 focus 面板（安全默认焦点）').toBe(panel)

    await wrapper.setProps({ open: false })
    await wrapper.vm.$nextTick()
    expect(document.activeElement, '关闭后焦点回 composer 而非旧焦点锚').toBe(input)
    wrapper.unmount()
    host.remove()
    box.remove()
  })
})
