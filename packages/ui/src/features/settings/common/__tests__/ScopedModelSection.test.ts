/**
 * ScopedModelSection 组件测试（A1/A2/A3 验收标准）。
 *
 * A1: 渲染断言 + 交互——scoped 列表每行显示模型名/provider 名/testid；警示标记（apiKeySet=false 行）；已不存在条目标注；上移/下移/移除按钮触发对应 emit 且 payload 正确
 * A2: 添加面板——分组渲染全量模型、搜索过滤、多选确认 emit add、重复禁选
 * A6: 空列表空状态提示（纯渲染，无 mock 依赖）
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ScopedModelSection from '../ScopedModelSection.vue'
import type { ScopedRenderItem, SelectableModel } from '../scoped-model-types'
import { SCOPED_MODEL_IMPLEMENTATION_TOKEN } from './impl-token'

// 断言真实文案（非 key 回显）：按 vitest.setup.ts 注释指引在测试内 override vue-i18n mock。
// 下方 SCOPED_MESSAGES 是手写字面量，镜像 zh-CN/settings.ts scopedModel 块的当前文案——
// i18n 文案变更时需同步维护此处，否则断言与真实 UI 脱节（查不到回退 key，其余用例仍可断言 DOM 结构）。
const SCOPED_MESSAGES = vi.hoisted(() => ({
  'settings.scopedModel.added': '已添加',
  'settings.scopedModel.title': '模型白名单',
  'settings.scopedModel.desc': '限定会话可用的模型范围，靠前优先级更高',
  'settings.scopedModel.emptyHint': '未配置白名单，全部已启用模型可用',
  'settings.scopedModel.noKey': '未配置密钥',
  'settings.scopedModel.missing': '已不存在',
  'settings.scopedModel.add': '添加模型',
  'settings.scopedModel.confirmAdd': '添加 {count} 个模型',
  'settings.scopedModel.searchPlaceholder': '搜索模型或供应商…',
  'settings.scopedModel.noResults': '没有匹配的模型',
  'settings.scopedModel.moveUp': '上移',
  'settings.scopedModel.moveDown': '下移',
  'settings.scopedModel.remove': '移除',
}))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    // 兼容两种调用形态（镜像 __tests__/vitest-i18n-setup.ts）：
    //   t(key, named) 与复数 t(key, count, { named })（confirmAdd 等）
    t: (key: string, ...rest: unknown[]) => {
      let result: string = SCOPED_MESSAGES[key as keyof typeof SCOPED_MESSAGES] ?? key
      let named: Record<string, unknown> | undefined
      let count: number | undefined
      if (typeof rest[0] === 'number') {
        count = rest[0]
        named = (rest[1] as { named?: Record<string, unknown> } | undefined)?.named
      } else if (rest[0] && typeof rest[0] === 'object') {
        named = rest[0] as Record<string, unknown>
      }
      if (result.includes('|') && count !== undefined) {
        const parts = result.split('|')
        result = (count === 1 ? parts[0] : (parts[1] ?? parts[0])).trim()
      }
      if (named) {
        for (const [k, v] of Object.entries(named)) {
          result = result.replaceAll(`{${k}}`, String(v))
        }
      }
      return result
    },
    locale: { value: 'zh-CN' },
  }),
}))

function makeScopedList(): ScopedRenderItem[] {
  return [
    { scoped: 'openai/gpt-4o', modelName: 'GPT-4o', providerName: 'OpenAI', apiKeySet: true, missing: false },
    { scoped: 'anthropic/claude-sonnet-4.5', modelName: 'Claude Sonnet 4.5', providerName: 'Anthropic', apiKeySet: false, missing: false },
    { scoped: 'deleted/old-model', modelName: 'old-model', providerName: 'deleted', apiKeySet: true, missing: true },
  ]
}

function makeSelectableModels(): SelectableModel[] {
  return [
    { fullId: 'openai/gpt-4o', providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-4o', name: 'GPT-4o', apiKeySet: true },
    { fullId: 'openai/gpt-4o-mini', providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-4o-mini', name: 'GPT-4o Mini', apiKeySet: true },
    { fullId: 'anthropic/claude-sonnet-4.5', providerId: 'anthropic', providerName: 'Anthropic', modelId: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', apiKeySet: false },
    { fullId: 'deepseek/deepseek-v3', providerId: 'deepseek', providerName: 'DeepSeek', modelId: 'deepseek-v3', name: 'DeepSeek V3', apiKeySet: true },
  ]
}

function mountSection(overrides: {
  scopedList?: ScopedRenderItem[]
  selectableModels?: SelectableModel[]
} = {}) {
  return mount(ScopedModelSection, {
    props: {
      scopedList: overrides.scopedList ?? makeScopedList(),
      selectableModels: overrides.selectableModels ?? makeSelectableModels(),
    },
  })
}

describe('ScopedModelSection', () => {
  // ── A1: 渲染断言 ──
  it('A1: scoped 列表每行显示模型名、provider 名、testid', () => {
    const wrapper = mountSection()
    const rows = wrapper.findAll('[data-testid="scoped-row"]')
    expect(rows.length).toBe(3)

    // 第一行：GPT-4o / OpenAI
    expect(rows[0].find('[data-testid="scoped-model-name"]').text()).toBe('GPT-4o')
    expect(rows[0].find('[data-testid="scoped-provider-name"]').text()).toBe('OpenAI')

    // 第二行：Claude Sonnet 4.5 / Anthropic
    expect(rows[1].find('[data-testid="scoped-model-name"]').text()).toBe('Claude Sonnet 4.5')
    expect(rows[1].find('[data-testid="scoped-provider-name"]').text()).toBe('Anthropic')
  })

  it('A1: apiKeySet=false 行显示警示标记', () => {
    const wrapper = mountSection()
    const rows = wrapper.findAll('[data-testid="scoped-row"]')
    // 第二行（Anthropic apiKeySet=false）有 no-key 标记
    expect(rows[1].find('[data-testid="scoped-warn-nokey"]').exists()).toBe(true)
    // 第一行（OpenAI apiKeySet=true）无 no-key 标记
    expect(rows[0].find('[data-testid="scoped-warn-nokey"]').exists()).toBe(false)
  })

  it('A1: 已不存在条目显示 missing 标记', () => {
    const wrapper = mountSection()
    const rows = wrapper.findAll('[data-testid="scoped-row"]')
    // 第三行（deleted/old-model missing=true）有 missing 标记
    expect(rows[2].find('[data-testid="scoped-warn-missing"]').exists()).toBe(true)
  })

  // ── A2: 交互事件 ──
  it('A1: 点击上移按钮触发 move emit，payload 正确', async () => {
    const wrapper = mountSection()
    const rows = wrapper.findAll('[data-testid="scoped-row"]')
    // 点击第二行的上移按钮
    await rows[1].find('[data-testid="scoped-move-up"]').trigger('click')
    expect(wrapper.emitted('move')).toBeTruthy()
    expect(wrapper.emitted('move')![0]).toEqual([{ scoped: 'anthropic/claude-sonnet-4.5', dir: 'up' }])
  })

  it('A1: 点击下移按钮触发 move emit，payload 正确', async () => {
    const wrapper = mountSection()
    const rows = wrapper.findAll('[data-testid="scoped-row"]')
    // 点击第一行的下移按钮
    await rows[0].find('[data-testid="scoped-move-down"]').trigger('click')
    expect(wrapper.emitted('move')).toBeTruthy()
    expect(wrapper.emitted('move')![0]).toEqual([{ scoped: 'openai/gpt-4o', dir: 'down' }])
  })

  it('A1: 点击移除按钮触发 remove emit，payload 正确', async () => {
    const wrapper = mountSection()
    const rows = wrapper.findAll('[data-testid="scoped-row"]')
    // 点击第一行的移除按钮
    await rows[0].find('[data-testid="scoped-remove"]').trigger('click')
    expect(wrapper.emitted('remove')).toBeTruthy()
    expect(wrapper.emitted('remove')![0]).toEqual(['openai/gpt-4o'])
  })

  it('A1: 首行上移按钮 disabled，末行下移按钮 disabled', () => {
    const wrapper = mountSection()
    const rows = wrapper.findAll('[data-testid="scoped-row"]')
    // 首行上移 disabled
    expect(rows[0].find('[data-testid="scoped-move-up"]').attributes('disabled')).toBeDefined()
    // 末行下移 disabled
    expect(rows[2].find('[data-testid="scoped-move-down"]').attributes('disabled')).toBeDefined()
  })

  // ── A3: 添加面板 ──
  it('A2: 点击添加按钮显示添加面板', async () => {
    const wrapper = mountSection()
    expect(wrapper.find('[data-testid="scoped-add-panel"]').exists()).toBe(false)
    await wrapper.find('[data-testid="scoped-add-btn"]').trigger('click')
    expect(wrapper.find('[data-testid="scoped-add-panel"]').exists()).toBe(true)
  })

  it('A2: 添加面板按 provider 分组显示全量模型', async () => {
    const wrapper = mountSection()
    await wrapper.find('[data-testid="scoped-add-btn"]').trigger('click')
    const groups = wrapper.findAll('[data-testid="scoped-group"]')
    // 3 个 provider: openai, anthropic, deepseek
    expect(groups.length).toBe(3)
  })

  it('A2: 重复项显示已添加并禁选', async () => {
    const wrapper = mountSection()
    await wrapper.find('[data-testid="scoped-add-btn"]').trigger('click')
    const items = wrapper.findAll('[data-testid="scoped-add-item"]')
    // gpt-4o 已在 scopedList 中，应有 alreadyAdded 标记且 checkbox disabled
    const gpt4oItem = items.find((item) => item.text().includes('GPT-4o') && !item.text().includes('Mini'))
    expect(gpt4oItem).toBeTruthy()
    // 已添加标记渲染真实文案（zh-CN locale），非 key 回显
    expect(gpt4oItem!.text()).toContain('已添加')
    expect(gpt4oItem!.text()).not.toContain('settings.scopedModel.added')
    expect(gpt4oItem!.find('button[role="checkbox"]').attributes('disabled')).toBeDefined()
  })

  it('A2: 搜索过滤生效', async () => {
    const wrapper = mountSection()
    await wrapper.find('[data-testid="scoped-add-btn"]').trigger('click')
    // Input 组件在 scoped-add-panel 内，find by placeholder 或第二个 input
    const inputs = wrapper.find('[data-testid="scoped-add-panel"]').findAll('input')
    expect(inputs.length).toBeGreaterThan(0)
    await inputs[0].setValue('deep')
    // 只剩 deepseek 组
    const groups = wrapper.findAll('[data-testid="scoped-group"]')
    expect(groups.length).toBe(1)
    expect(groups[0].text()).toContain('DeepSeek')
  })

  it('A2: 多选确认触发 add emit', async () => {
    const wrapper = mountSection()
    await wrapper.find('[data-testid="scoped-add-btn"]').trigger('click')

    // 选中 GPT-4o Mini（未在 scopedList 中）
    const items = wrapper.findAll('[data-testid="scoped-add-item"]')
    const gpt4oMiniItem = items.find((item) => item.text().includes('GPT-4o Mini'))
    expect(gpt4oMiniItem).toBeTruthy()
    await gpt4oMiniItem!.find('button[role="checkbox"]').trigger('click')

    // 确认按钮文案带选中数（复数调用形态 t(key, count, { named })，zh-CN 无单复数之分）
    expect(wrapper.find('[data-testid="scoped-confirm-add"]').text()).toContain('添加 1 个模型')

    // 确认
    await wrapper.find('[data-testid="scoped-confirm-add"]').trigger('click')
    expect(wrapper.emitted('add')).toBeTruthy()
    expect(wrapper.emitted('add')![0]).toEqual([['openai/gpt-4o-mini']])
  })

  it('A2: 空列表时显示空状态提示', () => {
    const wrapper = mountSection({ scopedList: [] })
    expect(wrapper.find('[data-testid="scoped-empty"]').exists()).toBe(true)
  })
})

describe('A6: ScopedModelSection 组件单元测试', () => {
  it('A6: 实现 token 存在（红阶段区分力守卫）', () => {
    // 基线代码树无 scoped-model-types.ts → import fail → 红阶段不通过
    expect(SCOPED_MODEL_IMPLEMENTATION_TOKEN).toBe('scoped-model-v1')
  })

  it('A6: 组件根元素含 data-testid，可独立挂载', () => {
    const wrapper = mountSection()
    expect(wrapper.find('[data-testid="scoped-model-section"]').exists()).toBe(true)
    // 标题存在
    expect(wrapper.find('h3').text()).toBeTruthy()
  })

  it('A6: 空列表且面板关闭时仅显示空状态', () => {
    const wrapper = mountSection({ scopedList: [] })
    expect(wrapper.find('[data-testid="scoped-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="scoped-row"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="scoped-add-panel"]').exists()).toBe(false)
  })

  it('A6: 列表行数与 scopedList 长度一致', () => {
    const wrapper = mountSection({ scopedList: makeScopedList().slice(0, 2) })
    expect(wrapper.findAll('[data-testid="scoped-row"]').length).toBe(2)
  })

  it('A6: selectableModels 为空时添加面板无模型', async () => {
    const wrapper = mountSection({ selectableModels: [] })
    await wrapper.find('[data-testid="scoped-add-btn"]').trigger('click')
    expect(wrapper.findAll('[data-testid="scoped-add-item"]').length).toBe(0)
  })
})
