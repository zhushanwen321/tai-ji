/**
 * ModelPickerPanel 行尾「默认」标签测试（demo .pt，demo 对齐，登记 docs/todo/ui-replica-demo-fidelity.md 收口记录）。
 *
 * 覆盖：
 *  - 命中 defaultModel 的行渲染行尾标签（i18n 文案），非默认行无标签（demo mock 存在空 tag 行，
 *    空是合法态）
 *  - 同 short-id 多 provider 双匹配：只标对应 provider 组的行（与 isRowSelected 同构语义）
 *  - defaultModel 空（未配置）→ 全部行无标签
 *  - ModelSelectPopover 集成：settingsStore.defaultModel → panel 数据面接线（弹层内出现标签）
 *
 * 每条用例至少一个用户可见 DOM 断言（TEST-STRATEGY §3 三视角纪律）。
 * 运行：cd packages/renderer && npx vitest run src/components/panel/__tests__/ModelPickerPanel.default-tag.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { getSettingsStore } from '@taiji/core'
import type { ProviderId } from '@taiji/shared'
import ModelPickerPanel from '@/components/panel/ModelPickerPanel.vue'
import ModelSelectPopover from '@/components/panel/ModelSelectPopover.vue'

let wrapper: ReturnType<typeof mount> | null = null

const TAG_SELECTOR = '[data-testid="model-picker-default-tag"]'

/** 两组四模型（openai 组含默认模型 gpt-4o；anthropic 组含同 short-id 的 gpt-4o 变体） */
const GROUPS: Array<{ provider: string; providerId: ProviderId; models: Array<{ id: string; name?: string }> }> = [
  {
    provider: 'OpenAI',
    providerId: 'openai',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-5', name: 'GPT-5' },
    ],
  },
  {
    provider: 'Anthropic',
    providerId: 'anthropic',
    models: [{ id: 'gpt-4o', name: 'GPT-4o (claude-api)' }],
  },
]

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('ModelPickerPanel 行尾「默认」标签（demo .pt）', () => {
  it('默认模型行渲染标签（i18n 文案），非默认行无标签', () => {
    wrapper = mount(ModelPickerPanel, {
      props: { groups: GROUPS, modelValue: 'gpt-5', defaultModel: 'openai/gpt-4o' },
    })
    const tags = wrapper.findAll(TAG_SELECTOR)
    // 全弹层恰一个标签（默认模型行），其余行空 tag（demo 合法态）
    expect(tags.length).toBe(1)
    expect(tags[0].text()).toBe('默认')
    // 标签所在行 = gpt-4o 行（行内顺序：标签后随行尾对勾）
    const gpt4oRow = wrapper.find('[data-testid="model-picker-item-gpt-4o"]')
    expect(gpt4oRow.find(TAG_SELECTOR).exists()).toBe(true)
    // 样式四值口径（demo .pt：margin-left auto / font-mono / fs-xs → --text-3xs / dim）
    expect(tags[0].classes()).toContain('ml-auto')
    expect(tags[0].classes()).toContain('font-mono')
    expect(tags[0].classes()).toContain('text-[length:var(--text-3xs)]')
    expect(tags[0].classes()).toContain('text-neutral-dim')
    const gpt5Row = wrapper.find('[data-testid="model-picker-item-gpt-5"]')
    expect(gpt5Row.find(TAG_SELECTOR).exists()).toBe(false)
  })

  it('同 short-id 多 provider：只标 provider 归属匹配的行（双匹配）', () => {
    wrapper = mount(ModelPickerPanel, {
      props: { groups: GROUPS, defaultModel: 'anthropic/gpt-4o' },
    })
    const tags = wrapper.findAll(TAG_SELECTOR)
    expect(tags.length).toBe(1)
    // 标签落在 anthropic 组的 gpt-4o 行（同组内唯一行），openai 组行无标签
    const rows = wrapper.findAll('[data-testid^="model-picker-item-gpt-4o"]')
    const taggedRows = rows.filter((r) => r.find(TAG_SELECTOR).exists())
    expect(taggedRows.length).toBe(1)
    expect(taggedRows[0].text()).toContain('GPT-4o (claude-api)')
  })

  it('defaultModel 为空（未配置）→ 全部行无标签', () => {
    wrapper = mount(ModelPickerPanel, {
      props: { groups: GROUPS, defaultModel: '' },
    })
    expect(wrapper.findAll(TAG_SELECTOR).length).toBe(0)
  })

  it('ModelSelectPopover 集成：settingsStore.defaultModel 驱动弹层内标签（数据面接线）', async () => {
    const settings = getSettingsStore()
    settings.models.value = [
      { id: 'gpt-4o', name: 'GPT-4o', providerId: 'openai', providerName: 'OpenAI', enabled: true },
      { id: 'gpt-5', name: 'GPT-5', providerId: 'openai', providerName: 'OpenAI', enabled: true },
    ]
    settings.defaultModel.value = 'openai/gpt-5'
    wrapper = mount(ModelSelectPopover, { props: { selected: 'openai/gpt-4o' } })
    await flushPromises()

    // 打开弹层（Popover 内容 Teleport 到 body）
    const trigger = wrapper.find('button')
    await trigger.trigger('click')
    await flushPromises()

    const tags = document.body.querySelectorAll(TAG_SELECTOR)
    expect(tags.length).toBe(1)
    expect(tags[0].textContent).toBe('默认')
    // 标签行 = gpt-5（默认模型），非当前选中行 gpt-4o——「默认」与「当前选中」是两个独立语义
    const gpt5Row = document.body.querySelector('[data-testid="model-picker-item-gpt-5"]')
    expect(gpt5Row?.contains(tags[0])).toBe(true)
  })
})
