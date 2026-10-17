/**
 * TerminalToggleButton 测试（display-containers u-w1-layout：§5.1 规则 4）。
 *
 * 被测行为：TerminalToggleButton（renderer panel/）：点击 = toggleBottomDrawer()（与 ⌃` 同一
 * 协调函数落点），aria-pressed 投影底抽屉开合态；关闭分支焦点回 composer（§6.7）。
 *
 * 三视角：使用者黑盒（按钮可见可点、点击开底抽屉）、观察者形态（testid/aria-pressed/title 文案）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/terminal-toggle-button.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import {
  bindBottomDrawerSessionId,
  useBottomDrawerControl,
  _resetBottomDrawerForTest,
} from '@taiji/core/domain/bottom-drawer'
import TerminalToggleButton from '@/components/panel/TerminalToggleButton.vue'

const SESSION = 's-terminal-toggle'

const sid = ref<string | null>(null)

beforeEach(() => {
  sid.value = SESSION
  bindBottomDrawerSessionId(sid)
  _resetBottomDrawerForTest()
})

afterEach(() => {
  _resetBottomDrawerForTest()
})

describe('TerminalToggleButton（顶栏鼠标路径入口，三卡化 2026-10-04 迁 PanelHeader）', () => {
  it('按钮常驻可点：title 文案 + aria-pressed 投影开合态；点击切换底抽屉（toggleBottomDrawer 同源）', async () => {
    const wrapper = mount(TerminalToggleButton)
    const button = wrapper.find('[data-testid="terminal-toggle-button"]')
    expect(button.exists()).toBe(true)
    expect(button.attributes('title')).toBe('开关终端')
    expect(button.attributes('aria-pressed')).toBe('false')
    expect(useBottomDrawerControl().isOpen.value).toBe(false)

    await button.trigger('click')
    await flushPromises()
    expect(useBottomDrawerControl().isOpen.value).toBe(true)
    expect(wrapper.find('[data-testid="terminal-toggle-button"]').attributes('aria-pressed')).toBe('true')

    await wrapper.find('[data-testid="terminal-toggle-button"]').trigger('click')
    await flushPromises()
    expect(useBottomDrawerControl().isOpen.value).toBe(false)
    expect(wrapper.find('[data-testid="terminal-toggle-button"]').attributes('aria-pressed')).toBe('false')
  })

  it('关闭分支焦点回 composer（§6.7 焦点契约，鼠标路径与键盘通道同款）；打开分支不抢焦点', async () => {
    document.body.innerHTML = '<div class="composer-box" data-testid="composer-box" tabindex="0"></div>'
    const composer = document.querySelector('[data-testid="composer-box"]')
    try {
      const wrapper = mount(TerminalToggleButton)
      const button = () => wrapper.find('[data-testid="terminal-toggle-button"]')

      // 打开分支：不调 focusComposer（焦点不迁移）
      await button().trigger('click')
      await flushPromises()
      expect(useBottomDrawerControl().isOpen.value).toBe(true)
      expect(document.activeElement).not.toBe(composer)

      // 关闭分支：焦点回 composer（§6.7 任一容器关闭后焦点回 composer）
      await button().trigger('click')
      await flushPromises()
      expect(useBottomDrawerControl().isOpen.value).toBe(false)
      expect(document.activeElement).toBe(composer)
    } finally {
      document.body.innerHTML = ''
    }
  })

})