/**
 * ModelSelectPopover 空态区分测试（P2）。
 *
 * 覆盖：
 *  - 空态 A：模型池为空 → 「暂无可用模型」引导文案（引导导入凭据/配置供应商）
 *  - 空态 B：模型池有模型但搜索无结果 → 「无匹配模型」
 *  - providerFilter：限定展示指定 provider 的分组（ProviderPage 默认 pill 场景）
 *  - trigger slot：自定义触发器（ProviderPage 默认 pill 复用）
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/beforeEach/afterEach/vi，禁 node:test）。
 * 运行：cd packages/renderer && npx vitest run src/components/panel/__tests__/ModelSelectPopover.spec.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { h } from 'vue'
import { getSettingsStore } from '@taiji/core'
import ModelSelectPopover from '@/components/panel/ModelSelectPopover.vue'
import { Button } from '@/components/ui/button'
import { PopoverTrigger } from '@/components/ui/popover'

let wrapper: ReturnType<typeof mount> | null = null

const OPENAI_MODELS = [
  { id: 'gpt-4o', name: 'GPT-4o', providerId: 'openai', providerName: 'OpenAI', enabled: true },
  { id: 'gpt-5', name: 'GPT-5', providerId: 'openai', providerName: 'OpenAI', enabled: true },
]

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** 打开 popover（点击默认 trigger），返回 body 中 popover 内容文本 */
async function openPopover(): Promise<string> {
  const trigger = wrapper!.find('button')
  await trigger.trigger('click')
  await flushPromises()
  return document.body.textContent ?? ''
}

describe('ModelSelectPopover 空态区分（P2）', () => {
  it('模型池为空 → 引导空态（无匹配搜索文案不出现）', async () => {
    getSettingsStore().models.value = []
    wrapper = mount(ModelSelectPopover, { props: { selected: '' } })
    await flushPromises()

    const bodyText = await openPopover()
    expect(bodyText).toContain('暂无可用模型，请先在设置中导入凭据或配置供应商')
    expect(bodyText).not.toContain('无匹配模型')
  })

  it('有模型但搜索无结果 → 「无匹配模型」空态', async () => {
    getSettingsStore().models.value = OPENAI_MODELS
    wrapper = mount(ModelSelectPopover, { props: { selected: 'openai/gpt-4o' } })
    await flushPromises()

    await openPopover()
    // 输入不存在的模型名
    const input = document.body.querySelector('input') as HTMLInputElement
    input.value = 'no-such-model'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('无匹配模型')
    expect(bodyText).not.toContain('暂无可用模型')
  })

  it('有模型且搜索命中 → 列表渲染，无空态', async () => {
    getSettingsStore().models.value = OPENAI_MODELS
    wrapper = mount(ModelSelectPopover, { props: { selected: 'openai/gpt-4o' } })
    await flushPromises()

    const bodyText = await openPopover()
    expect(bodyText).toContain('GPT-5')
    expect(bodyText).not.toContain('无匹配模型')
  })

  it('providerFilter 限定分组：只展示指定 provider 的模型', async () => {
    getSettingsStore().models.value = [
      ...OPENAI_MODELS,
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', providerId: 'anthropic', providerName: 'Anthropic', enabled: true },
    ]
    wrapper = mount(ModelSelectPopover, {
      props: { selected: 'openai/gpt-4o', providerFilter: ['openai'] },
    })
    await flushPromises()

    const bodyText = await openPopover()
    expect(bodyText).toContain('GPT-5')
    expect(bodyText).not.toContain('Claude Sonnet 4')
  })

  it('providerFilter 限定 provider 无模型 → 引导空态（区分「搜索无结果」）', async () => {
    getSettingsStore().models.value = [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', providerId: 'anthropic', providerName: 'Anthropic', enabled: true },
    ]
    wrapper = mount(ModelSelectPopover, {
      props: { selected: 'openai/gpt-4o', providerFilter: ['openai'] },
    })
    await flushPromises()

    const bodyText = await openPopover()
    expect(bodyText).toContain('暂无可用模型，请先在设置中导入凭据或配置供应商')
    expect(bodyText).not.toContain('无匹配模型')
  })

  it('trigger slot：自定义触发器可打开 popover 并选中模型', async () => {
    getSettingsStore().models.value = OPENAI_MODELS
    wrapper = mount(ModelSelectPopover, {
      props: { selected: 'openai/gpt-4o' },
      slots: {
        trigger: () => h(PopoverTrigger, { 'as-child': true }, {
          default: () => h(Button, { 'data-testid': 'custom-trigger', variant: 'ghost' }, () => '默认供应商'),
        }),
      },
    })
    await flushPromises()

    // 自定义 trigger 渲染（默认 PopoverTriggerButton 不渲染）
    expect(wrapper.find('[data-testid="custom-trigger"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('默认供应商')

    await wrapper.find('[data-testid="custom-trigger"]').trigger('click')
    await flushPromises()

    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('GPT-5')
  })
})
