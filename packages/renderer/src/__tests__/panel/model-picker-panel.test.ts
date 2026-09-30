/**
 * ModelPickerPanel hoverSelect 测试（W3a）—— 可选 prop，默认关闭时行为与改动前逐字节一致。
 *
 * 锁两条：
 * - 默认（不传 hoverSelect）：pointerenter 不 emit hoverSelect（Composer / ProviderPage /
 *   ScheduleForm 三个既有消费面零影响），click 仍照常 emit update:modelValue；
 * - hoverSelect: true：pointerenter 即上抛 hoverSelect（D2 模型聚合的 hover 切换通道），
 *   值未变的去重在消费方（ModelThinkingAggregate）——本层只负责上抛。
 *
 * 三视角：使用者黑盒（列表项 DOM + 交互）+ 观察者形态（emit 面）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/model-picker-panel.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ModelPickerPanel from '@/components/panel/ModelPickerPanel.vue'
import type { ModelPickerGroup } from '@/components/panel/ModelPickerPanel.vue'

const GROUPS: ModelPickerGroup[] = [
  { provider: 'Anthropic', models: [{ id: 'claude-4', name: 'Claude 4' }] },
]

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(ModelPickerPanel, { props: { groups: GROUPS, ...props } })
}

describe('ModelPickerPanel hoverSelect（W3a 可选通道）', () => {
  it('默认关闭：pointerenter 不 emit hoverSelect，列表 DOM 照常渲染（用户可见 DOM 断言）', async () => {
    const wrapper = mountPanel()
    const row = wrapper.find('[data-testid="model-picker-item-claude-4"]')
    expect(row.exists()).toBe(true)

    await row.trigger('pointerenter')
    expect(wrapper.emitted('hoverSelect')).toBeUndefined()
  })

  it('hoverSelect: true → pointerenter 上抛 hoverSelect(id)', async () => {
    const wrapper = mountPanel({ hoverSelect: true })
    const row = wrapper.find('[data-testid="model-picker-item-claude-4"]')
    expect(row.exists()).toBe(true)

    await row.trigger('pointerenter')
    const emitted = wrapper.emitted('hoverSelect')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('claude-4')
  })

  it('click 通道不受 hoverSelect 影响：照常 emit update:modelValue(id)', async () => {
    const wrapper = mountPanel({ hoverSelect: true })
    await wrapper.find('[data-testid="model-picker-item-claude-4"]').trigger('click')
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('claude-4')
  })
})
