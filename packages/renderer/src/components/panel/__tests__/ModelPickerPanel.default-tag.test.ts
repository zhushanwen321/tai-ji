/**
 * ModelPickerPanel 默认标签 + ContextChipsBar 缩略图 单文件合并
 * （round5-d 分区 4 簇 4-3 相容子集）。
 *
 * 为什么单文件：vitest 按测试文件隔离模块图——两文件共同装载 lucide-vue /
 * reka-ui-slim / vue / shared 等重模块，且全零 vi.mock，单文件共享一份装载。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动）：
 *  - ModelPickerPanel.default-tag.test.ts（行尾「默认」标签，主体）
 *  - ContextChipsBar.thumb.test.ts（image chip 真图缩略）
 *
 * 冲突处理（试点模式）：
 *  - 两文件顶层 afterEach 同构（wrapper 卸载 + body 清），去重一份公共；
 *    主体的 beforeEach pinia 重建提升文件级（ContextChips 不消费 pinia，幂等无害）
 *
 * 簇注：同簇其余三文件不并入——SubagentTab.model-popover 的 vue-i18n mock 会毁掉
 * 本两节的中文文案断言（「默认」等），且其 @/stores 系窄 mock 与 Panel.plan-quota/
 * dead-diagnostics 挂载的完整 Panel.vue（真实 store 依赖）实质冲突。三文件保持原样。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/__tests__/ModelPickerPanel.default-tag.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { getSettingsStore } from '@taiji/core'
import type { ProviderId } from '@taiji/shared'
import ModelPickerPanel from '@/components/panel/ModelPickerPanel.vue'
import ModelSelectPopover from '@/components/panel/ModelSelectPopover.vue'
import ContextChipsBar from '@/components/panel/ContextChipsBar.vue'

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

  it('ModelSelectPopover 集成：settingsStore.defaultModel 驱动弹层内标签（数据范围接线）', async () => {
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


// ══════════ 来源：ContextChipsBar.thumb.test.ts（image chip 真图缩略；wrapper 槽与
//             afterEach 共享主体声明，零 mock 零泄漏） ══════════

const THUMB_SELECTOR = '[data-testid="context-chip-thumb"]'

function makeItems(count: number): Array<{ id: string; name: string; path: string; type: 'image' }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `chip-${i + 1}`,
    name: `img${i + 1}.png`,
    path: `/tmp/attachments/s1/img${i + 1}.png`,
    type: 'image' as const,
  }))
}

describe('ContextChipsBar image chip 真图缩略（demo .ctxchip .thumb）', () => {
  it('image 项 lead 渲染 img 缩略（local-file src + demo 四值类），非 image 形态无 img', () => {
    wrapper = mount(ContextChipsBar, { props: { items: makeItems(2) } })
    const thumbs = wrapper.findAll(THUMB_SELECTOR)
    expect(thumbs.length).toBe(2)
    // src 经 shared localFileUrl 单点构造（local-file 协议 + 路径段编码）
    expect(thumbs[0].attributes('src')).toBe(
      'local-file:///' + encodeURIComponent('/tmp/attachments/s1/img1.png'),
    )
    expect(thumbs[0].attributes('alt')).toBe('img1.png')
    // demo .ctxchip .thumb 四值：16px（size-4）/ r-3.5px / object-fit cover / flex none（shrink-0）
    expect(thumbs[0].classes()).toContain('size-4')
    expect(thumbs[0].classes()).toContain('rounded-[3.5px]')
    expect(thumbs[0].classes()).toContain('object-cover')
    expect(thumbs[0].classes()).toContain('shrink-0')
  })

  it('img 加载失败 → 该 chip 回退 ImageIcon 占位（img 消失，svg 出现）', async () => {
    wrapper = mount(ContextChipsBar, { props: { items: makeItems(1) } })
    const img = wrapper.find(THUMB_SELECTOR)
    expect(img.exists()).toBe(true)

    await img.trigger('error')
    // img 消失（不留破图），ImageIcon 占位渲染（lucide 组件 → svg）
    expect(wrapper.find(THUMB_SELECTOR).exists()).toBe(false)
    const fallback = wrapper.find('svg')
    expect(fallback.exists()).toBe(true)
  })

  it('失败回退按 chipId 隔离：失败项回退占位，未失败项保持 img', async () => {
    wrapper = mount(ContextChipsBar, { props: { items: makeItems(2) } })
    await wrapper.findAll(THUMB_SELECTOR)[0]!.trigger('error')

    expect(wrapper.findAll(THUMB_SELECTOR).length).toBe(1)
    // 剩下的 img 是第二个 chip 的
    expect(wrapper.find(THUMB_SELECTOR).attributes('src')).toContain(
      encodeURIComponent('/tmp/attachments/s1/img2.png'),
    )
  })
})
