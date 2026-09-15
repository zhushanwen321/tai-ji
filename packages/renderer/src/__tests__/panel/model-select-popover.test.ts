/**
 * ModelSelectPopover 单测（数据源 store 化 + 竞态回归）。
 *
 * 锁定两条主轴：
 * 1. 纯受控：去掉本地 selected ref + watch（旧实现 onSelect 后本地态被旧 props 拉回，UI 闪退）
 *    - currentName 解析复合串 "provider/modelId" → 裸 modelId → 查 ModelInfo.name
 *    - props.selected 变化时触发器文案跟随更新，不依赖本地副本
 * 2. 数据源 store 化（2026-07-01 竞态修复）：模型列表不再组件内 onMounted 订阅 onModels，
 *    改从 settingsStore.models 常驻订阅读取。旧实现随 Composer v-if 重新挂载会错过
 *    sendInitialState 一次性推送 → 列表空；新实现读 store，store 已有数据则立即可见。
 *
 * 数据注入：setActivePinia(createPinia()) 后直接赋 getSettingsStore().models（不 mock store，
 * 与 command-popover-landing.test.ts 同模式——验证组件真实读 store）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel/model-select-popover.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ModelInfo } from '@taiji/shared'
import { getSettingsStore, __resetSettingsStoreForTesting } from '@taiji/core'
import ModelSelectPopover from '@/components/panel/ModelSelectPopover.vue'

const MODELS: ModelInfo[] = [
  { id: 'claude-4', name: 'Claude 4', providerId: 'anthropic', providerName: 'Anthropic' },
  { id: 'gpt-4', name: 'GPT-4', providerId: 'openai', providerName: 'OpenAI' },
] as unknown as ModelInfo[]

beforeEach(() => {
  setActivePinia(createPinia())
  __resetSettingsStoreForTesting()
})

describe('ModelSelectPopover 纯受控 + store 数据源', () => {
  it('U18: props.selected 为复合串时，触发器显示对应模型名', async () => {
    getSettingsStore().models.value = MODELS
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    await wrapper.vm.$nextTick()
    // 触发器文案含模型名（title="切换模型" 的 Button 内 span）
    expect(wrapper.text()).toContain('Claude 4')
  })

  it('U18b: props.selected 变化时，触发器文案跟随更新（纯受控，不依赖本地副本）', async () => {
    getSettingsStore().models.value = MODELS
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Claude 4')

    // 父组件更新 selected（模拟 Composer 乐观更新后的 props 回传）
    await wrapper.setProps({ selected: 'openai/gpt-4' })
    expect(wrapper.text()).toContain('GPT-4')
    expect(wrapper.text()).not.toContain('Claude 4')
  })

  it('U19: onSelect 后 emit modelId+provider，不依赖本地态回写', async () => {
    getSettingsStore().models.value = MODELS
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    await wrapper.vm.$nextTick()

    // 直接调组件实例方法（绕过 Popover 交互）
    ;(wrapper.vm as unknown as { onSelect: (id: string, p: string) => void }).onSelect('gpt-4', 'openai')
    const emitted = wrapper.emitted('select')
    expect(emitted).toBeTruthy()
    // emitted('select')[0] = 第一次 emit 的参数数组，[0] = payload 对象
    expect(emitted![0][0]).toEqual({ modelId: 'gpt-4', provider: 'openai' })
  })

  it('U15: props.selected 为空串时，触发器显示占位文案（…）而非空串', async () => {
    getSettingsStore().models.value = MODELS
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: '' },
    })
    await wrapper.vm.$nextTick()
    // D3：已建 session modelId 为空 → 显示占位「…」，不兜底全局默认
    expect(wrapper.find('[title="切换模型"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('…')
  })

  it('U9: store 已有数据时 mount，触发器立即显示模型名（竞态回归——模拟 v-if 翻转后重新 mount，无任何推送）', async () => {
    // 旧实现：组件内 onMounted 订阅 onModels，重新挂载会错过 sendInitialState 一次性推送 → 列表空。
    // 新实现：读 settingsStore.models，store 已有数据则立即可见。此处不触发任何推送。
    getSettingsStore().models.value = MODELS
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Claude 4')
  })

  it('U10: 分组渲染——2 个 provider 各 1 model，groups 有 2 组', async () => {
    getSettingsStore().models.value = MODELS
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    await wrapper.vm.$nextTick()
    const groups = (wrapper.vm as unknown as { groups: { provider: string; providerId: string; models: ModelInfo[] }[] }).groups
    expect(groups).toHaveLength(MODELS.length)
    // 两个 provider 名都出现
    const providers = groups.map((g) => g.provider)
    expect(providers).toContain('Anthropic')
    expect(providers).toContain('OpenAI')
  })

  it('U11: 搜索过滤——query="cla" 时仅渲染 Claude 相关', async () => {
    getSettingsStore().models.value = MODELS
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    await wrapper.vm.$nextTick()
    // 设 query（script setup ref 在实例 proxy 上已解包为字符串）触发 groups 重算
    ;(wrapper.vm as unknown as { query: string }).query = 'cla'
    await wrapper.vm.$nextTick()
    const groups = (wrapper.vm as unknown as { groups: { provider: string; models: ModelInfo[] }[] }).groups
    expect(groups).toHaveLength(1)
    expect(groups[0].provider).toBe('Anthropic')
    expect(groups[0].models).toHaveLength(1)
    expect(groups[0].models[0].name).toBe('Claude 4')
  })

  it('U12: store 空时渲染引导空态（P2：模型池为空 → 引导导入凭据/配置，区别于搜索无结果）', async () => {
    getSettingsStore().models.value = []
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: '' },
    })
    await wrapper.vm.$nextTick()
    const groups = (wrapper.vm as unknown as { groups: unknown[] }).groups
    expect(groups).toHaveLength(0)
    // groups.length===0 且模型池为空 → PopoverContent 内渲染「暂无可用模型」引导空态。
    // reka-ui PopoverContent teleport 到 body：打开 popover 后查 body 文案。
    ;(wrapper.vm as unknown as { open: boolean }).open = true
    await wrapper.vm.$nextTick()
    expect(document.body.textContent).toContain('暂无可用模型，请先在设置中导入凭据或配置供应商')
    expect(document.body.textContent).not.toContain('无匹配模型')
  })

  it('U6: enabled===false 的 model 不出现在分组列表（runtime aggregateModels 已过滤，前端兜底）', async () => {
    // 双保险：runtime aggregateModels 已过滤 enabled===false，但 ModelSelectPopover 直读
    // settingsStore.models（与 providers 同源广播），若某次广播未过滤则会泄漏禁用模型到切换器。
    // 故前端在 groups computed 内也过滤 enabled===false。
    const mixed: ModelInfo[] = [
      { id: 'claude-4', name: 'Claude 4', providerId: 'anthropic', providerName: 'Anthropic', enabled: true },
      { id: 'claude-haiku', name: 'Claude Haiku', providerId: 'anthropic', providerName: 'Anthropic', enabled: false },
      { id: 'gpt-4', name: 'GPT-4', providerId: 'openai', providerName: 'OpenAI', enabled: true },
    ] as unknown as ModelInfo[]
    getSettingsStore().models.value = mixed
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    await wrapper.vm.$nextTick()
    const groups = (wrapper.vm as unknown as { groups: { provider: string; models: ModelInfo[] }[] }).groups
    const allIds = groups.flatMap((g) => g.models.map((m) => m.id))
    expect(allIds).toContain('claude-4')
    expect(allIds).toContain('gpt-4')
    // enabled===false 的 claude-haiku 被过滤
    expect(allIds).not.toContain('claude-haiku')
  })
})
