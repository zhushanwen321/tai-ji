/**
 * CodingPlanSection cookie 自动续期入口测试（quota cookie 刷新 U3）。
 *
 * 覆盖按钮渲染与状态文案（module 契约 view.cookieRefresh + refreshCookie 动作）：
 * - available=true（cookie 形态 + 在册）→ 入口渲染；available=false → 不渲染
 * - running → 按钮禁用 + 进行中文案（t 返回 key，断言 key 形态）
 * - 点击 → module.refreshCookie 被调（交互经 module seam，组件不直连 IPC）
 * - result ok / fail → 状态文案分别取 i18n key / module 透传 error
 *
 * module 实例经 makeQuotaModuleStub（@taiji/core/testing）注入——契约漂移在桩工厂
 * 侧变编译错误；i18n 经包 vitest.setup mock（t 返回 key）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/settings/__tests__/CodingPlanSection.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { makeQuotaModuleStub } from '@taiji/core/testing'
import { QUOTA_CONFIGURE_MODULE_KEY } from '../injection-keys'
import CodingPlanSection from '../coding-plan/CodingPlanSection.vue'

/** 挂组件：stub module 直接改 view 态（普通 ref，写入即生效）。 */
function mountSection() {
  const module = makeQuotaModuleStub({ state: 'ready' })
  // 'ready' 预设是 api-key 形态（zhipu）；cookie 入口的渲染前提是 cookie 输入区在渲染
  module.view.value.credential.form = 'cookie'
  const wrapper = mount(CodingPlanSection, {
    global: { provide: { [QUOTA_CONFIGURE_MODULE_KEY as symbol]: module } },
  })
  return { wrapper, module }
}

describe('CodingPlanSection cookie 自动续期入口', () => {
  it('available=true → 入口渲染，按钮为默认文案 key，无状态文案', async () => {
    const { wrapper, module } = mountSection()
    module.view.value.cookieRefresh.available = true
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="quota-cookie-refresh"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="quota-cookie-refresh-btn"]').text())
      .toContain('settings.providerEdit.quotaCookieAutoRefresh')
    // 未触发过：无状态文案
    expect(wrapper.find('[data-testid="quota-cookie-refresh-status"]').exists()).toBe(false)
  })

  it('available=false → 入口不渲染', async () => {
    const { wrapper } = mountSection()
    // stub 预设 cookieRefresh.available=false（quota-module-stub 基线）
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="quota-cookie-refresh"]').exists()).toBe(false)
  })

  it('running=true → 按钮禁用 + 进行中文案', async () => {
    const { wrapper, module } = mountSection()
    module.view.value.cookieRefresh.available = true
    module.view.value.cookieRefresh.running = true
    await wrapper.vm.$nextTick()

    const btn = wrapper.find('[data-testid="quota-cookie-refresh-btn"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.text()).toContain('settings.providerEdit.quotaCookieAutoRefreshRunning')
  })

  it('点击按钮 → module.refreshCookie 被调', async () => {
    const { wrapper, module } = mountSection()
    module.view.value.cookieRefresh.available = true
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-testid="quota-cookie-refresh-btn"]').trigger('click')
    expect(module.refreshCookie).toHaveBeenCalledTimes(1)
  })

  it('result=ok → 状态文案为成功 key；result=fail → 显示 module 透传 error', async () => {
    const { wrapper, module } = mountSection()
    module.view.value.cookieRefresh.available = true
    module.view.value.cookieRefresh.result = 'ok'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="quota-cookie-refresh-status"]').text())
      .toContain('settings.providerEdit.quotaCookieAutoRefreshOk')

    module.view.value.cookieRefresh.result = 'fail'
    module.view.value.cookieRefresh.error = 'login timeout'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="quota-cookie-refresh-status"]').text()).toContain('login timeout')
  })
})
