/**
 * ProviderTemplatePicker 插件 Provider 菜单条目单测（provider-plugin-access D1）。
 *
 * 独立成文件的原因：本组件主测试文件 ProviderTemplatePicker.test.ts 已登记
 * domain-map.json 挂载排除（settings 域，默认档不跑），「插件 Provider」菜单条目
 * 新增后（第三来源类型）在默认档（含 pr-cr-fix 覆盖率门禁）零执行。本文件只覆盖
 * 新条目的交互契约，落回默认档；归属不变（settings 域 tests glob
 * `packages/ui/src/features/settings/**` 覆盖）。
 *
 * 覆盖验收：
 * ① 菜单含「插件 Provider」条目（与内置模板 / 自定义并列的第三来源类型）
 * ② 点条目 → emit 'plugin-source'（父打开插件接入流程）+ Popover menu 关闭
 *
 * 测试模式：沿 ProviderTemplatePicker.test.ts 同款——reka Popover 经 Portal teleport
 * 到 document.body，mount attachTo body 后用 document.body.querySelector 查询；
 * i18n 经 vitest.setup mock（t 返回 key）。
 */
import { describe, it, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ProviderTemplatePicker from '../provider/ProviderTemplatePicker.vue'
import type { BuiltinProviderTemplate } from '@taiji/shared'

const PROVIDERS: BuiltinProviderTemplate[] = []

async function openMenu(): Promise<ReturnType<typeof mount<typeof ProviderTemplatePicker>>> {
  const wrapper = mount(ProviderTemplatePicker, {
    props: { providers: PROVIDERS },
    attachTo: document.body,
  })
  const trigger = document.body.querySelector('[data-testid="provider-template-picker"]')
  ;(trigger as HTMLElement).click()
  await flushPromises() // reka Popover 异步挂载 menu
  return wrapper
}

describe('ProviderTemplatePicker 插件 Provider 菜单条目（D1）', () => {
  it('菜单含「插件 Provider」条目（与内置模板 / 自定义并列的第三来源类型）', async () => {
    const wrapper = await openMenu()
    // i18n mock t() 返回 key，断言 key 文案即条目渲染
    const pluginItem = document.body.querySelector('[data-testid="add-menu-plugin"]')
    expect(pluginItem).toBeTruthy()
    expect(pluginItem!.textContent).toContain('settings.provider.builtinTemplate.menuPlugin')
    wrapper.unmount()
  })

  it('点条目 → emit plugin-source（父走插件接入流程）+ Popover menu 关闭（不打开模板 Dialog）', async () => {
    const wrapper = await openMenu()
    ;(document.body.querySelector('[data-testid="add-menu-plugin"]') as HTMLElement).click()
    await flushPromises()
    expect(wrapper.emitted('plugin-source')).toBeTruthy()
    expect(wrapper.emitted('plugin-source')!.length).toBe(1)
    // 关闭后菜单内容从 body 消失（同「自定义」条目的关闭语义）
    expect(document.body.querySelector('[data-testid="add-menu-plugin"]')).toBeNull()
    // 插件条目不走内置模板 Dialog
    expect(document.body.querySelector('[data-testid="provider-template-dialog"]')).toBeNull()
    wrapper.unmount()
  })
})
