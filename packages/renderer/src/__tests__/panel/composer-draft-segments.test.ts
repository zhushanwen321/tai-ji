/**
 * composer 草稿 segments 化组件测试（U8，design-session-lifecycle 缺陷 1 P0）。
 *
 * 锁定切走切回草稿的 chips 结构保真（保存含 segments、恢复走 restoreSegmentsIntoInput
 * 单点——skill chip 经 insertSkillChip 通路重建，与 D6 编辑预填/发送失败恢复共用同一实现）：
 * ① 普通态切走：saveDraft 收 getSegments() 快照（text + chip），切回恢复 chips 完整；
 * ② browsing 态切走（比切走更早的丢失点——↑ 已用 setText 清掉 DOM chips）：navState
 *    savedSegments 通道恢复用户真实输入含 chips；
 * ③ 空草稿归一：空输入切走切回走清空分支（无残留、无幽灵恢复）。
 *
 * mock 策略对齐 composer-history-cache.test.ts（真 pinia chat store + ComposerInput mock
 * 持 chips 状态），mount 真实 Composer 驱动完整保存/恢复链。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-draft-segments.test.ts
 */
// helper import 必须先于一切项目内模块（@/stores 等会在模块图加载期触发 @/api mock
// factory，vi.mock hoisting 约束——对齐 composer-history-cache.test.ts 头注）
import {
  composerApiModule,
  composerChildStubs,
  composerFlowModule,
  composerProjectSkillsModule,
  composerSessionStoreModule,
  composerSidebarForkModule,
} from '../helpers/composer-mount'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { Segment } from '@taiji/shared'
import { useChatStore } from '@/stores/chat'
import Composer from '@/components/panel/Composer.vue'

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
