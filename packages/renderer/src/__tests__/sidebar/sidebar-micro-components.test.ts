import { expectTextOnlyTabs } from '../helpers/sidebar-mount';
import Brand from '@/components/sidebar/Brand.vue';
import SegmentedTab from '@/components/sidebar/SegmentedTab.vue';
import type { SidebarTab } from '@/stores/sidebar';
import { __resetDevModeForTesting, provideDevMode } from '@taiji/core';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← Brand.test.ts
// ======================================================================

describe('Brand', () => {
  it('versionLabel 正常态：渲染完整版本文案（v{version} · pi v{piVersion}）', () => {
    const wrapper = mount(Brand, {
      props: { versionLabel: 'v0.8.40 · pi v0.82.1' },
    })
    // Sidebar 侧 versionLabel 构成：`v${__APP_VERSION__} · pi v${piVersion}`
    expect(wrapper.text()).toContain('v0.8.40 · pi v0.82.1')
  })

  it('versionLabel fallback：未传（piVersion 未就绪）时不渲染版本行', () => {
    const wrapper = mount(Brand)
    // 默认 versionLabel='' → v-if 不渲染版本号行（只留 logo + 产品名）
    const versionLine = wrapper.find('.text-\\[length\\:var\\(--text-2xs\\)\\]')
    expect(versionLine.exists()).toBe(false)
    expect(wrapper.text()).not.toContain('v0.0.0-test')
  })

  it('产品名渲染 app.title i18n（zh-CN：太极）', () => {
    const wrapper = mount(Brand)
    const title = wrapper.find('span.text-\\[length\\:var\\(--text-md\\)\\]')
    expect(title.exists()).toBe(true)
    expect(title.text()).toBe('太极')
  })

  it('#trailing slot 内容渲染（Sidebar 注入 UpdateButton）', () => {
    const wrapper = mount(Brand, {
      slots: {
        trailing: '<button data-testid="trailing-stub">升级</button>',
      },
    })
    const trailing = wrapper.find('[data-testid="trailing-stub"]')
    expect(trailing.exists()).toBe(true)
    expect(trailing.text()).toBe('升级')
  })
})

describe('Brand DEV 徽标', () => {
  // provideDevMode 改的是模块级状态，重置保证不泄漏到其他用例（默认 isDevMode()=false）
  afterEach(() => __resetDevModeForTesting())

  it('dev 模式：渲染 DEV 徽标', () => {
    provideDevMode(true)
    const wrapper = mount(Brand)
    const badge = wrapper.find('[data-testid="brand-dev-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('DEV')
  })

  it('非 dev 模式（重置后）：不渲染 DEV 徽标', () => {
    __resetDevModeForTesting()
    const wrapper = mount(Brand)
    expect(wrapper.find('[data-testid="brand-dev-badge"]').exists()).toBe(false)
  })
})

// ======================================================================
// ← SegmentedTab.spec.ts
// ======================================================================

function mountTab(props: Partial<{ modelValue: SidebarTab; sessionCount: number; fileCount: number }> = {}) {
  return mount(SegmentedTab, {
    props: {
      modelValue: 'sessions' as SidebarTab,
      sessionCount: 0,
      fileCount: 0,
      ...props,
    },
  })
}

describe('SegmentedTab', () => {
  it('渲染 3 个 tab（sessions/files/plugins），label 直出', () => {
    const wrapper = mountTab()

    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(3)

    // tab title 含 label（i18n 中文：与组件 t('sidebar.segmentedTab.*') 输出对齐）
    expect(buttons[0].attributes('title')).toBe('会话')
    expect(buttons[1].attributes('title')).toBe('文件')
    expect(buttons[2].attributes('title')).toBe('插件')
    // 文字 tab：label 直出（demo .vtab 形态）
    expect(buttons[0].text()).toContain('会话')
    expect(buttons[1].text()).toContain('文件')
    expect(buttons[2].text()).toContain('插件')
  })

  it('Agents / Flows 两枚 tab 不存在（任务观察入口已迁 composer 托盘）', () => {
    const wrapper = mountTab()

    const titles = wrapper.findAll('button').map((b) => b.attributes('title'))
    expect(titles).not.toContain('子代理')
    expect(titles).not.toContain('工作流')
    // 全渲染文本里不得出现两枚退役 tab 的中英标签
    expect(wrapper.text()).not.toContain('子代理')
    expect(wrapper.text()).not.toContain('工作流')
  })

  it('文字 tab 形态：不渲染 icon svg 与 count 数字（demo .vtab，count props 保留外部契约）', () => {
    const wrapper = mountTab({ sessionCount: 3, fileCount: 6, modelValue: 'sessions' })

    const buttons = wrapper.findAll('button')
    expectTextOnlyTabs(buttons, ['3', '6'])
  })

  it('点击 tab 触发 update:modelValue', async () => {
    const wrapper = mountTab()

    const buttons = wrapper.findAll('button')
    await buttons[1].trigger('click')

    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('files')
  })

  it('tablist 范式（spec sidebar §3.1）：容器 role=tablist + 钮 role=tab + aria-selected', () => {
    const wrapper = mountTab({ modelValue: 'files' })

    expect(wrapper.find('[role="tablist"]').exists()).toBe(true)
    const buttons = wrapper.findAll('button')
    expect(buttons.map((b) => b.attributes('role'))).toEqual(['tab', 'tab', 'tab'])
    expect(buttons[1].attributes('aria-selected')).toBe('true')
    expect(buttons[0].attributes('aria-selected')).toBe('false')
  })

  it('方向键环形移动并立即激活（spec §3.1：→ 下一视图、← 上一视图、首尾环形）', async () => {
    const wrapper = mountTab({ modelValue: 'sessions' })
    const tablist = wrapper.find('[role="tablist"]')

    // → 自会话到文件
    await tablist.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue')![0][0]).toBe('files')
    await wrapper.setProps({ modelValue: 'files' })

    // → 自文件到插件（立即激活随 modelValue 推进）
    await tablist.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue')![1][0]).toBe('plugins')
    await wrapper.setProps({ modelValue: 'plugins' })

    // → 自插件环形回会话（尾首相接）
    await tablist.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue')![2][0]).toBe('sessions')
    await wrapper.setProps({ modelValue: 'sessions' })

    // ← 自会话环形回插件（反向环绕）
    await tablist.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.emitted('update:modelValue')![3][0]).toBe('plugins')
  })
})
