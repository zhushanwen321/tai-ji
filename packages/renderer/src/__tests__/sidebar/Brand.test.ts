/**
 * Brand 组件测试（review S-8 补充）。
 *
 * 覆盖：
 *  - versionLabel 正常态（Sidebar 传入的完整文案「v{version} · pi v{piVersion}」）渲染
 *  - versionLabel fallback（未传 / 空串，如 piVersion 未就绪时）版本行不渲染
 *  - 产品名渲染 app.title i18n（zh-CN：太极）
 *  - #trailing slot 内容渲染（Sidebar 注入 UpdateButton）
 *  - dev 模式（provideDevMode(true)）渲染 DEV 徽标；默认/重置后不渲染
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/Brand.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { provideDevMode, __resetDevModeForTesting } from '@taiji/core'
import Brand from '@/components/sidebar/Brand.vue'

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
    const versionLine = wrapper.find('.text-\\[length\\:var\\(--text-3xs\\)\\]')
    expect(versionLine.exists()).toBe(false)
    expect(wrapper.text()).not.toContain('v0.0.0-test')
  })

  it('产品名渲染 app.title i18n（zh-CN：太极）', () => {
    const wrapper = mount(Brand)
    const title = wrapper.find('span.text-\\[length\\:var\\(--text-sm\\)\\]')
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
