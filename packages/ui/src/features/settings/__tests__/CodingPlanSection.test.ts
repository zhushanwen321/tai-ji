/**
 * CodingPlanSection cookie 自动续期入口 + 用户维度参数区测试。
 *
 * cookie 自动续期（quota cookie 刷新 U3）——覆盖按钮渲染与状态文案（module 契约
 * view.cookieRefresh + refreshCookie 动作）：
 * - available=true（cookie 形态 + 在册）→ 入口渲染；available=false → 不渲染
 * - running → 按钮禁用 + 进行中文案（t 返回 key，断言 key 形态）
 * - 点击 → module.refreshCookie 被调（交互经 module seam，组件不直连 IPC）
 * - result ok / fail → 状态文案分别取 i18n key / module 透传 error
 *
 * 用户维度参数区（2026-10 泛化，原 workspace 单框）：view.params 逐项渲染 +
 * 输入经 setParamDraft 写 draft.params（reka 宽联合载荷的字符串收窄）；
 * 缺口提示 / 徽标按 key 判定（per-key，只挂真正缺的那个框）。
 *
 * module 实例经 makeQuotaModuleStub（@taiji/core/testing）注入——契约漂移在桩工厂
 * 侧变编译错误；i18n 经包 vitest.setup mock（t 返回 key）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/settings/__tests__/CodingPlanSection.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { makeQuotaModuleStub } from '@taiji/core/testing'
import type { QuotaParamView, ReadinessMissing } from '@taiji/core'
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

describe('CodingPlanSection 用户维度参数区（2026-10 泛化）', () => {
  /** 挂组件并按需塞入 param 视图项（stub 'ready' 预设 params 为空数组）。 */
  function mountWithParams(params: QuotaParamView[], missing: ReadinessMissing[] = []) {
    const module = makeQuotaModuleStub({ state: 'ready' })
    module.view.value.params = params
    module.view.value.readiness = { ready: missing.length === 0, missing }
    const wrapper = mount(CodingPlanSection, {
      global: { provide: { [QUOTA_CONFIGURE_MODULE_KEY as symbol]: module } },
    })
    return { wrapper, module }
  }

  it('view.params 多项 → 按 key 逐项渲染 label / placeholder / helpText；草稿空的必填项渲染必填提示', async () => {
    const { wrapper } = mountWithParams(
      [
        { key: 'workspace', label: '工作区', placeholder: '输入工作区 ID', helpText: '帮助文字', required: true },
        { key: 'orgId', label: '组织', required: true },
      ],
      ['param'],
    )
    await wrapper.vm.$nextTick()

    const block = wrapper.find('[data-testid="quota-param-block-workspace"]')
    expect(block.exists()).toBe(true)
    expect(wrapper.find('[data-testid="quota-param-block-orgId"]').exists()).toBe(true)
    expect(block.text()).toContain('工作区')
    expect(block.text()).toContain('帮助文字')
    const input = wrapper.find('[data-testid="quota-param-input-workspace"]')
    expect(input.attributes('placeholder')).toBe('输入工作区 ID')
    // 两个 param 草稿均为空 → 各自框下渲染必填提示（per-key 判定；i18n key，t mock 返回 key）
    expect(wrapper.find('[data-testid="quota-missing-param-workspace"]').text())
      .toContain('settings.providerEdit.quotaMissingParam')
  })

  it('多必填参数部分缺失 → 缺口提示 / 徽标按 key 定位（只挂真正缺的那个框）', async () => {
    const { wrapper, module } = mountWithParams(
      [
        { key: 'workspace', label: '工作区', required: true },
        { key: 'orgId', label: '组织', required: true },
      ],
      ['param'],
    )
    module.draft.value.params = { workspace: 'ws-1' }
    await wrapper.vm.$nextTick()

    // workspace 已填：无缺口提示，徽标「已配置」
    expect(wrapper.find('[data-testid="quota-missing-param-workspace"]').exists()).toBe(false)
    const wsBlock = wrapper.find('[data-testid="quota-param-block-workspace"]')
    expect(wsBlock.text()).toContain('settings.providerEdit.quotaConfiguredBadge')
    expect(wsBlock.text()).not.toContain('settings.providerEdit.quotaRequiredBadge')
    // orgId 仍空：缺口提示与「必填」徽标都挂在 orgId 框下，不蔓延到已填的框
    expect(wrapper.find('[data-testid="quota-missing-param-orgId"]').text())
      .toContain('settings.providerEdit.quotaMissingParam')
    expect(wrapper.find('[data-testid="quota-param-block-orgId"]').text())
      .toContain('settings.providerEdit.quotaRequiredBadge')
  })

  it('param 输入 → setParamDraft 写入 draft.params（字符串通过，保留既有键）', async () => {
    const { wrapper, module } = mountWithParams([
      { key: 'workspace', label: '工作区', required: true },
    ])
    module.draft.value.params = { orgId: 'org-1' }

    await wrapper.find('[data-testid="quota-param-input-workspace"]').setValue('ws-9')
    expect(module.draft.value.params).toEqual({ orgId: 'org-1', workspace: 'ws-9' })
  })
})
