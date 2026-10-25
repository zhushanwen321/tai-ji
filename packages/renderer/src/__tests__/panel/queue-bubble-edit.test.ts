/**
 * QueueBubble ✎ 编辑入口与编辑态提示条组件单测（chat-flow-consistency D6）。
 *
 * 组件契约增量（组件头注 D6 段为准）：
 * - 全行 ✎ 钮（queued/in-flight/failed 均渲染——E7 failed 行同样可编辑），点击
 *   emit edit(clientUuid)（编排经 useQueueRows.onEditEntry → 壳层 beginEdit：
 *   单锚定判定 + delivery.peek 预填，组件纯 props 不持状态）
 * - editingClientUuid prop 非空 → 编辑态提示条渲染（「正在编辑排队消息 · 发送后原位替换」
 *   + 「放弃编辑」按钮）；空 → 不渲染（条目离场由壳层帧驱动 watch 自动解除锚定，
 *   提示条随之消失——组件只跟随 props）
 * - 「放弃编辑」点击 emit abandonEdit()（壳层解除锚定但草稿文本保留）
 *
 * 三视角覆盖：
 * - 观察者（形态）：✎ 钮全行渲染、提示条显隐跟随 editingClientUuid
 * - 使用者（黑盒）：✎ emit edit 带条目 id；放弃编辑 emit abandonEdit
 * - 构建者（白盒）：提示条显隐 = 单一 prop 驱动（无组件内状态）
 *
 * 运行：cd packages/renderer && pnpm test -- queue-bubble-edit
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import QueueBubble from '@/components/panel/QueueBubble.vue'
import type { QueueRow } from '@/composables/panel/useQueueRows'

function row(clientUuid: string, preview: string, state: QueueRow['state'] = 'queued'): QueueRow {
  return { clientUuid, preview, state }
}

function mountQB(
  overrides: { rows?: QueueRow[]; hint?: string; editingClientUuid?: string | null } = {},
) {
  return mount(QueueBubble, {
    props: {
      rows: overrides.rows ?? [row('u-1', '排队的消息文本')],
      hint: '占用结束后发送',
      ...(overrides.editingClientUuid !== undefined ? { editingClientUuid: overrides.editingClientUuid } : {}),
    },
  })
}

describe('QueueBubble · ✎ 编辑入口（D6）', () => {
  it('queued 行渲染 ✎ 钮，点击 emit edit 带条目 id', async () => {
    const wrapper = mountQB({ rows: [row('u-1', '排队中的消息')] })
    const btn = wrapper.find('[data-testid="queue-edit-u-1"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(wrapper.emitted('edit')).toEqual([['u-1']])
  })

  it('failed 行 ✎ 钮同样可用（E7：failed 行可编辑），与重试/撤销并存', async () => {
    const wrapper = mountQB({ rows: [row('u-f', '发送未确认的文本', 'failed')] })
    expect(wrapper.find('[data-testid="queue-edit-u-f"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="queue-retry-u-f"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="queue-cancel-u-f"]').exists()).toBe(true)
    await wrapper.find('[data-testid="queue-edit-u-f"]').trigger('click')
    expect(wrapper.emitted('edit')).toEqual([['u-f']])
  })
})

describe('QueueBubble · 编辑态提示条（D6）', () => {
  it('editingClientUuid 非空 → 提示条渲染（编辑态文案 + 放弃编辑入口）', () => {
    const wrapper = mountQB({ editingClientUuid: 'u-1' })
    const banner = wrapper.find('[data-testid="queue-edit-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('正在编辑排队消息')
    expect(banner.text()).toContain('放弃编辑')
    expect(wrapper.find('[data-testid="queue-edit-abandon"]').exists()).toBe(true)
  })

  it('editingClientUuid 空（缺省）→ 提示条不渲染', () => {
    const wrapper = mountQB({})
    expect(wrapper.find('[data-testid="queue-edit-banner"]').exists()).toBe(false)
  })

  it('提示条显隐跟随 prop 变化（条目离场由壳层解除锚定 → prop 翻空 → 提示条消失）', async () => {
    const wrapper = mountQB({ editingClientUuid: 'u-1' })
    expect(wrapper.find('[data-testid="queue-edit-banner"]').exists()).toBe(true)
    await wrapper.setProps({ editingClientUuid: null })
    expect(wrapper.find('[data-testid="queue-edit-banner"]').exists()).toBe(false)
  })

  it('「放弃编辑」点击 emit abandonEdit（解除锚定草稿保留——语义在壳层）', async () => {
    const wrapper = mountQB({ editingClientUuid: 'u-1' })
    await wrapper.find('[data-testid="queue-edit-abandon"]').trigger('click')
    expect(wrapper.emitted('abandonEdit')).toHaveLength(1)
  })
})
