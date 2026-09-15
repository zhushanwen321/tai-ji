/**
 * ThinkingLevelPopover 动态档位测试。
 *
 * 锁定：
 * - onSelect emit 的是 map 映射后的 value（发给 runtime 的实际 level），非 UI 档位 key
 * - popover 只渲染可用档位（不可用档位不出现在 DOM）
 * - prop level（runtime 返回的 value）经 resolveThinkingKey 反向映射为 UI key 高亮
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel/thinking-level-popover.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import ThinkingLevelPopover from '@/components/panel/ThinkingLevelPopover.vue'

// 真实预设（从 useProviderEdit.ts THINKING_PRESETS 同步）
const HIGH_MAX_MAP = { off: 'off', high: 'high', max: 'xhigh' }
const ON_OFF_MAP = { off: 'off', high: 'high' }

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('ThinkingLevelPopover onSelect 发 value（map 映射后）', () => {
  it('high-max: 选 max 档 → emit xhigh（value），非 max（key）', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'high', levelMap: HIGH_MAX_MAP },
    })
    const vm = wrapper.vm as unknown as { onSelect: (opt: { level: string; label: string; en: string; available: boolean }) => void }
    vm.onSelect({ level: 'max', label: '最高', en: 'max', available: true })
    const emitted = wrapper.emitted('select')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('xhigh')
  })

  it('high-max: 选 high 档 → emit high', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'max', levelMap: HIGH_MAX_MAP },
    })
    const vm = wrapper.vm as unknown as { onSelect: (opt: { level: string; label: string; en: string; available: boolean }) => void }
    vm.onSelect({ level: 'high', label: '高', en: 'high', available: true })
    expect(wrapper.emitted('select')![0][0]).toBe('high')
  })

  it('on-off: 选 off 档 → emit off', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'high', levelMap: ON_OFF_MAP },
    })
    const vm = wrapper.vm as unknown as { onSelect: (opt: { level: string; label: string; en: string; available: boolean }) => void }
    vm.onSelect({ level: 'off', label: '关', en: 'off', available: true })
    expect(wrapper.emitted('select')![0][0]).toBe('off')
  })

  it('all-levels（map 空）→ emit key 自身', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'medium' },
    })
    const vm = wrapper.vm as unknown as { onSelect: (opt: { level: string; label: string; en: string; available: boolean }) => void }
    vm.onSelect({ level: 'off', label: '关', en: 'off', available: true })
    expect(wrapper.emitted('select')![0][0]).toBe('off')
  })
})

// ══ D3: props.level 为空时显示占位文案 ══
describe('D3: props.level 为空时触发器显示占位文案', () => {
  it('level 不传 → 触发器显示占位「…」', async () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: {},
    })
    await wrapper.vm.$nextTick()
    // D3：已建 session thinkingLevel 为空 → 显示占位「…」
    expect(wrapper.text()).toContain('…')
  })

  it('level=undefined → 触发器显示占位「…」', async () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: undefined },
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('…')
  })

  it('level="high" → 触发器正常显示档位名（不显示占位）', async () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'high' },
    })
    await wrapper.vm.$nextTick()
    // 有明确档位时显示 high 档显示文案（getDisplayLabel → '高'，zh-CN 默认 locale）——
    // 断言包含期望文案使「有值仍渲染占位」回归可被抓到（not.toBe 恒真不可证伪）
    expect(wrapper.text()).toContain('高')
    expect(wrapper.text()).not.toContain('…')
  })
})

// ══ U9: pi 新语义（U6 改锚：可用集读 supportedLevels 下发）——mimo 场景档位渲染 ══
// xiaomi-token-plan-cn/mimo-v2.5-pro 的 supportedLevels = pi 同源计算默认五档。
describe('U9: mimo 场景（supportedLevels 未下发）→ 渲染默认五档含 minimal，无 xhigh/max', () => {
  it('DOM 含 5 个档位项：off/minimal/low/medium/high，不含 xhigh/max', async () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'high' }, // supportedLevels 不传（undefined = 归一默认五档）
    })
    // 打开 popover 使档位列表渲染进 DOM
    await (wrapper.vm as unknown as { open: boolean }).$nextTick()
    const vm = wrapper.vm as unknown as { availableOptions: Array<{ level: string }> }
    const renderedLevels = vm.availableOptions.map((o) => o.level)
    expect(renderedLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    expect(renderedLevels).not.toContain('xhigh')
    expect(renderedLevels).not.toContain('max')
  })

  it('supportedLevels=["off"]（non-reasoning 模型，pi 两级门控产物）→ availableOptions 只有 off', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'off', supportedLevels: ['off'] },
    })
    const vm = wrapper.vm as unknown as { availableOptions: Array<{ level: string }> }
    expect(vm.availableOptions.map((o) => o.level)).toEqual(['off'])
  })

  it('U6: supportedLevels 含 xhigh/max 档 → 对应档位渲染（下发集是可用档唯一权威）', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'max', supportedLevels: ['off', 'high', 'xhigh', 'max'] },
    })
    const vm = wrapper.vm as unknown as { availableOptions: Array<{ level: string }> }
    expect(vm.availableOptions.map((o) => o.level)).toEqual(['off', 'high', 'xhigh', 'max'])
  })
})
