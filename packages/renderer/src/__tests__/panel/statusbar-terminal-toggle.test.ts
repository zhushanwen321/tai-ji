/**
 * StatusBar 原生动作通道 + 终端开关按钮测试（display-containers u-w1-layout：§5.1 规则 4）。
 *
 * 被测行为：
 * - StatusBar（@taiji/ui/extension-host，真实渲染）自隐藏条件扩展为「有状态项**或有原生动作**」：
 *   干净安装（无插件无 statusline 项）+ trailing 原生动作 → 根元素常驻、按钮仍可见
 *   （防纯键盘不可发现——§5.1 裁决的表面变更）；无项且无原生动作 → 维持旧自隐藏语义
 * - StatusBarTerminalToggle（renderer statusbar/）：点击 = toggleBottomDrawer()（与 ⌃` 同一
 *   协调函数落点），aria-pressed 投影底抽屉开合态
 *
 * 三视角：构建者白盒（trailing slot 注入通道 + 根 v-if 条件）、使用者黑盒（干净安装下按钮可见可点、
 * 点击开底抽屉）、观察者形态（按钮 testid/aria-pressed/title 文案）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/statusbar-terminal-toggle.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import {
  StatusBar,
  STATUS_BAR_SOURCE_KEY,
} from '@taiji/ui/extension-host'
import type { StatusBarSource, StatusBarEntry } from '@taiji/ui/extension-host'
import {
  bindBottomDrawerSessionId,
  useBottomDrawerControl,
  _resetBottomDrawerForTest,
} from '@taiji/core/domain/bottom-drawer'
import StatusBarTerminalToggle from '@/components/statusbar/StatusBarTerminalToggle.vue'

const SESSION = 's-statusbar'

function makeSource(items: { perSession: StatusBarEntry[]; global: StatusBarEntry[] }): StatusBarSource {
  return {
    getItems: (scope: 'per-session' | 'global') => (scope === 'per-session' ? items.perSession : items.global),
  }
}

const emptySource = makeSource({ perSession: [], global: [] })
const oneItemSource = makeSource({
  perSession: [],
  global: [{ id: 'g1', pluginId: 'p1', text: 'ready', alignment: 'left', priority: 0 }],
})

/** StatusBar 真实渲染 + trailing 原生动作（终端开关按钮本体） */
function mountBar(source: StatusBarSource, trailing: boolean) {
  return mount(StatusBar, {
    props: { sessionId: SESSION },
    global: {
      provide: { [STATUS_BAR_SOURCE_KEY as symbol]: source },
    },
    slots: trailing ? { trailing: '<div data-testid="trailing-stub" />' } : {},
  })
}

const sid = ref<string | null>(null)

beforeEach(() => {
  sid.value = SESSION
  bindBottomDrawerSessionId(sid)
  _resetBottomDrawerForTest()
})

afterEach(() => {
  _resetBottomDrawerForTest()
})

describe('StatusBar 原生动作通道（根 v-if 自隐藏条件扩展）', () => {
  it('干净安装（零状态项）+ trailing 原生动作 → 根元素常驻、动作可见（防纯键盘不可发现）', () => {
    const wrapper = mountBar(emptySource, true)
    expect(wrapper.find('[data-testid="status-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="status-bar-trailing"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="trailing-stub"]').exists()).toBe(true)
    // 零项 → 无状态项渲染（自隐藏的项级语义不变）
    expect(wrapper.findAll('[data-testid="status-bar-item"]')).toHaveLength(0)
  })

  it('零状态项且无原生动作 → 根元素自隐藏（旧语义保持，不占位）', () => {
    const wrapper = mountBar(emptySource, false)
    expect(wrapper.find('[data-testid="status-bar"]').exists()).toBe(false)
  })

  it('有状态项 + 原生动作 → 项与动作共存（原生动作通道不挤占状态项）', () => {
    const wrapper = mountBar(oneItemSource, true)
    expect(wrapper.find('[data-testid="status-bar"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="status-bar-item"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="status-bar-trailing"]').exists()).toBe(true)
  })
})

describe('StatusBarTerminalToggle（底抽屉鼠标路径入口）', () => {
  it('按钮常驻可点：title 文案 + aria-pressed 投影开合态；点击切换底抽屉（toggleBottomDrawer 同源）', async () => {
    const wrapper = mount(StatusBarTerminalToggle)
    const button = wrapper.find('[data-testid="statusbar-terminal-toggle"]')
    expect(button.exists()).toBe(true)
    expect(button.attributes('title')).toBe('开关终端')
    expect(button.attributes('aria-pressed')).toBe('false')
    expect(useBottomDrawerControl().isOpen.value).toBe(false)

    await button.trigger('click')
    await flushPromises()
    expect(useBottomDrawerControl().isOpen.value).toBe(true)
    expect(wrapper.find('[data-testid="statusbar-terminal-toggle"]').attributes('aria-pressed')).toBe('true')

    await wrapper.find('[data-testid="statusbar-terminal-toggle"]').trigger('click')
    await flushPromises()
    expect(useBottomDrawerControl().isOpen.value).toBe(false)
    expect(wrapper.find('[data-testid="statusbar-terminal-toggle"]').attributes('aria-pressed')).toBe('false')
  })

  it('关闭分支焦点回 composer（§6.7 焦点契约，鼠标路径与键盘通道同款）；打开分支不抢焦点', async () => {
    document.body.innerHTML = '<div class="composer-box" data-testid="composer-box" tabindex="0"></div>'
    const composer = document.querySelector('[data-testid="composer-box"]')
    try {
      const wrapper = mount(StatusBarTerminalToggle)
      const button = () => wrapper.find('[data-testid="statusbar-terminal-toggle"]')

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

  it('经 StatusBar trailing 通道注入后仍可点（壳路径：按钮在 status-bar 根内渲染）', async () => {
    const wrapper = mount(StatusBar, {
      props: { sessionId: SESSION },
      global: {
        provide: { [STATUS_BAR_SOURCE_KEY as symbol]: emptySource },
      },
      slots: { trailing: StatusBarTerminalToggle },
    })
    const button = wrapper.find('[data-testid="statusbar-terminal-toggle"]')
    expect(button.exists()).toBe(true)

    await button.trigger('click')
    await flushPromises()
    expect(useBottomDrawerControl().isOpen.value).toBe(true)
    // 开合后按钮仍常驻（根元素因原生动作不自隐藏）
    expect(wrapper.find('[data-testid="status-bar"]').exists()).toBe(true)
  })
})