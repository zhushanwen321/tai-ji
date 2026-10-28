import { composerApiModule, composerChildStubs, composerFlowModule, composerProjectSkillsModule, composerSessionStoreModule, composerSidebarForkModule } from '@/__tests__/helpers/composer-mount';
import Composer from '@/components/panel/Composer.vue';
import ContextChipsBar from '@/components/panel/ContextChipsBar.vue';
import ModelPickerPanel from '@/components/panel/ModelPickerPanel.vue';
import ModelSelectPopover from '@/components/panel/ModelSelectPopover.vue';
import { useChatStore } from '@/stores/chat';
import { getSettingsStore } from '@taiji/core';
import type { Segment, ProviderId } from '@taiji/shared';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';

// wave3 簇 [renderer/happy-dom] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/panel/composer-draft-segments.test.ts
 * - components/panel/__tests__/ModelPickerPanel.default-tag.test.ts
 */

// ======================================================================
// ← __tests__/panel/composer-draft-segments.test.ts
// ======================================================================

vi.mock('@/composables/features/chat/useChat', () => ({ useChat: () => ({ send: vi.fn(), followUp: vi.fn(), abort: vi.fn(), compact: vi.fn(), sendBash: vi.fn() }) }))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => composerFlowModule())
vi.mock('@/api', () => composerApiModule())
vi.mock('@/composables/features/settings/useProjectSkills', () => composerProjectSkillsModule())
vi.mock('@/composables/features/sidebar/useSidebar', () => composerSidebarForkModule())
vi.mock('@/stores/session', () => composerSessionStoreModule())

// ── ComposerInput mock：输入文本 + skill chips 双状态（getSegments 语义对齐真实解析）──
const inputState = ref({ text: '', chips: [] as Array<{ name: string; location?: string }> })
const insertSkillChipCalls: Array<{ name: string; location?: string }> = []
const ComposerInputMock = defineComponent({
  name: 'ComposerInput',
  props: {
    placeholder: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
  },
  emits: {
    input: () => true,
    keydown: null,
    'slash-trigger': null,
    'file-trigger': null,
  },
  setup(_, { expose, emit }) {
    const emitInput = () => emit('input', inputState.value.text)
    expose({
      clear: () => {
        inputState.value = { text: '', chips: [] }
        emitInput()
      },
      // 对齐真实 ComposerInput 契约：setText 全量替换（replaceChildren 清 chips）+ emit input
      setText: (text: string) => {
        inputState.value = { text, chips: [] }
        emitInput()
      },
      insertSkillChip: (name: string, location?: string) => {
        // restoreSegmentsIntoInput 的 skill 分支唯一重建通路（设计 D3：不删其他 chip）
        insertSkillChipCalls.push({ name, location })
        inputState.value = { ...inputState.value, chips: [...inputState.value.chips, { name, location }] }
        emitInput()
      },
      insertSlashChip: vi.fn(),
      // getSegments = 全量解析语义：text 段（非空时）+ chips 按 DOM 序
      getSegments: (): Segment[] => [
        ...(inputState.value.text ? [{ type: 'text' as const, text: inputState.value.text }] : []),
        ...inputState.value.chips.map((c) => ({ type: 'skill' as const, name: c.name, location: c.location })),
      ],
      getText: () => inputState.value.text,
      moveCaretVertical: () => 'at-edge' as const,
    })
    return {}
  },
  template: '<div data-testid="composer-input" />',
})

const stubs = {
  ComposerInput: ComposerInputMock,
  ...composerChildStubs,
}

/** 用户消息构造（历史派生数据源，↑ browsing 通道测试用） */
function seedHistory(text: string): void {
  useChatStore().hydrate('s1', [
    { id: 'u1', role: 'user', content: text, status: 'complete', timestamp: 0 },
    { id: 'a1', role: 'assistant', content: '回复', status: 'complete', timestamp: 0 },
  ])
}

/** 模拟用户输入（真实链：input 事件 → draft/onInputChange 同步） */
async function typeDraft(wrapper: ReturnType<typeof mount>, text: string): Promise<void> {
  inputState.value = { ...inputState.value, text }
  wrapper.findComponent(ComposerInputMock).vm.$emit('input', text)
  await nextTick()
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  inputState.value = { text: '', chips: [] }
  insertSkillChipCalls.length = 0
})

describe('U8 草稿 segments 化：切走切回 chips 结构保真', () => {
  it('普通态切走：草稿含 text + skill chip segments，切回经 insertSkillChip 通路恢复 chips 完整', async () => {
    const wrapper = mount(Composer, { props: { sessionId: 's1' }, global: { stubs } })
    await nextTick()

    // 用户输入 + 插入 skill chip（真实链：insertSkillChip → onChanged → emit input）
    await typeDraft(wrapper, '看下这个')
    wrapper.findComponent(ComposerInputMock).vm.insertSkillChip('cw-cli', '/skills/cw-cli/SKILL.md')
    await nextTick()
    insertSkillChipCalls.length = 0 // 只统计恢复链的重建调用

    // 切到 s2 再切回 s1
    await wrapper.setProps({ sessionId: 's2' })
    await nextTick()
    await wrapper.setProps({ sessionId: 's1' })
    await nextTick()

    // 恢复走 restoreSegmentsIntoInput 单点：skill chip 经 insertSkillChip(name, location) 重建
    expect(insertSkillChipCalls).toEqual([{ name: 'cw-cli', location: '/skills/cw-cli/SKILL.md' }])
    // 输入区终态 = text + chip 结构完整（纯文本形态会只剩标记污染文本、chips 清零）
    expect(inputState.value.text).toBe('看下这个')
    expect(inputState.value.chips).toEqual([{ name: 'cw-cli', location: '/skills/cw-cli/SKILL.md' }])
    wrapper.unmount()
  })

  it('browsing 态切走（↑ 已清 DOM chips）：savedSegments 通道恢复用户真实输入含 chips', async () => {
    seedHistory('历史消息一')
    const wrapper = mount(Composer, { props: { sessionId: 's1' }, global: { stubs } })
    await nextTick()

    // 用户输入 + chip → ↑ 进 browsing（输入区被历史条目替换，DOM chips 被清——丢失点）
    await typeDraft(wrapper, '我的草稿')
    wrapper.findComponent(ComposerInputMock).vm.insertSkillChip('review-skill')
    await nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    await nextTick()
    // 前置：browsing 生效——输入区已显示历史条目（chips 已被 setText 清掉）
    expect(inputState.value.text).toBe('历史消息一')
    expect(inputState.value.chips).toEqual([])
    insertSkillChipCalls.length = 0

    // browsing 态切走再切回：草稿从 navState.savedSegments 恢复
    await wrapper.setProps({ sessionId: 's2' })
    await nextTick()
    await wrapper.setProps({ sessionId: 's1' })
    await nextTick()

    expect(insertSkillChipCalls).toEqual([{ name: 'review-skill', location: undefined }])
    expect(inputState.value.text).toBe('我的草稿')
    expect(inputState.value.chips).toEqual([{ name: 'review-skill', location: undefined }])
    wrapper.unmount()
  })

  it('空草稿（只含空 text 段）切走切回：走清空分支，无幽灵恢复', async () => {
    const wrapper = mount(Composer, { props: { sessionId: 's1' }, global: { stubs } })
    await nextTick()

    // 输入后清空（分区存在但 segments 全空 text）→ 切走 → 切回
    await typeDraft(wrapper, '临时内容')
    await typeDraft(wrapper, '')
    await wrapper.setProps({ sessionId: 's2' })
    await nextTick()
    await wrapper.setProps({ sessionId: 's1' })
    await nextTick()

    expect(inputState.value.text).toBe('')
    expect(inputState.value.chips).toEqual([])
    wrapper.unmount()
  })
})

// ======================================================================
// ← components/panel/__tests__/ModelPickerPanel.default-tag.test.ts
// ======================================================================

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
