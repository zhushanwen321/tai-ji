/**
 * UserBubbleEditComposer 组件测试（user-bubble-edit-composer）。
 *
 * 被测件 = 用户气泡编辑态富编辑器（简化版 composer）：ComposerInput（真 contenteditable）
 * + CommandPopover（真组件，四符号候选浮层）+ useCommandPopoverTrigger（真态机）。
 * 壳层装配同 composer-hash-trigger 范式：真 pinia + @/api 骨架 mock（session.getCommands
 * 供 slash open-fetch）；ComposerInputDeps 由被测组件自身 provideComposerInputDeps 装配
 * （与 Composer.vue 共享实现，本测试同时验证该装配在组件树内可用）。
 *
 * 覆盖：
 * - R1 挂载回填：segments → 真 chip（.slash-chip / .mention-chip）+ 草稿同步（发送门禁）
 *   + selectedSkillNames 禁选数据范围透传 CommandPopover
 * - R2 Enter 提交：emit submit(segments)（chip 即段，无序列化标记文本）
 * - R3 ⇧⏎ 换行不提交 / Esc 取消
 * - R4 空稿 + disabled 双门禁：发送钮禁用且点击不 emit
 * - R5 五路 trigger：输入 / → CommandPopover（open/type/query）；浮层 open 时 Enter 被
 *   window capture 主入口消费（不直达提交——「浮层开着 ⏎ 绝不误发」防线）
 *
 * happy-dom 光标支持：el.focus() + Range.setStart + Selection.addRange 可定位光标
 * （触发检测依赖光标位置，同 composer-hash-trigger typeWithCursor）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/user-bubble-edit-composer.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Segment } from '@taiji/shared'
import { composerApiModule } from '../helpers/composer-mount'

// ── api mock：session.getCommands 供 slash open-fetch；getSubagents 供 subagent store 挂载拉取 ──
const getCommandsMock = vi.hoisted(() => vi.fn())
const getSubagentsMock = vi.hoisted(() => vi.fn())
vi.mock('@/api', () => {
  const api = composerApiModule()
  return {
    ...api,
    session: {
      ...api.session,
      getCommands: getCommandsMock,
      getSubagents: getSubagentsMock,
    },
  }
})

import UserBubbleEditComposer from '@/components/panel/message-stream/UserBubbleEditComposer.vue'
import CommandPopover from '@/components/panel/CommandPopover.vue'

/** 挂载编辑框（panel 态 s1，消息 u1） */
function mountEditor(segments: Segment[] = [], extraProps: Record<string, unknown> = {}) {
  return mount(UserBubbleEditComposer, {
    props: { sessionId: 's1', messageId: 'u1', segments, ...extraProps },
  })
}

/** 在 contenteditable 内键入文本并把光标定位到指定位置（触发检测依赖光标位置） */
async function typeWithCursor(
  wrapper: ReturnType<typeof mount>,
  text: string,
  cursorOffset = text.length,
): Promise<void> {
  const div = wrapper.find('[role="textbox"]')
  const el = div.element as HTMLDivElement
  el.textContent = text
  el.focus()
  const sel = window.getSelection()
  if (sel && el.firstChild) {
    const range = document.createRange()
    range.setStart(el.firstChild, Math.min(cursorOffset, text.length))
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  await div.trigger('input')
}

beforeEach(() => {
  setActivePinia(createPinia())
  getCommandsMock.mockReset()
  getCommandsMock.mockResolvedValue({ sessionId: 's1', commands: [] })
  getSubagentsMock.mockReset()
  // RT-4#8 起 API 返结构化形状 { subagents, oversize }（store 按此解构）
  getSubagentsMock.mockResolvedValue({ subagents: [], oversize: false })
  // happy-dom 无 document.execCommand（dom-core ⇧⏎ 换行 / 粘贴文本写入依赖）——打桩让
  // 换行分支走通（断言点在 emit 面，不在 DOM 写入效果）
  document.execCommand = vi.fn(() => true)
})

describe('UserBubbleEditComposer 挂载回填（R1）', () => {
  it('segments → 真 chip 还原（.slash-chip）+ 文本进输入区', async () => {
    const wrapper = mountEditor([
      { type: 'text', text: '总结' },
      { type: 'slash', name: 'compact' },
    ])
    await flushPromises()
    // slash chip 真 DOM（非序列化标记文本）
    const chip = wrapper.find('.slash-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('compact')
    // 文本段进 contenteditable
    expect(wrapper.find('[role="textbox"]').text()).toContain('总结')
  })

  it('file/skill 段 → mention/skill chip 还原 + selectedSkillNames 禁选数据范围透传', async () => {
    const wrapper = mountEditor([
      { type: 'skill', name: 'cw-cli', location: '/sk.md' },
      { type: 'file', path: '/a.ts', lineRange: [10, 20] },
    ])
    await flushPromises()
    // skill chip 复用 .slash-chip class + dataset.chipType='skill'（dom-core 约定）
    expect(wrapper.find('.slash-chip[data-chip-type="skill"]').exists()).toBe(true)
    // file chip → .mention-chip.mention-file
    expect(wrapper.find('.mention-chip.mention-file').exists()).toBe(true)
    // 已选 skill 集合透传 CommandPopover（命中项禁选，防同一 skill 重复注入）
    const popover = wrapper.findComponent(CommandPopover)
    expect(popover.props('selectedSkillNames')).toEqual(['cw-cli'])
  })

  it('回填后草稿非空 → 发送钮可点（canSubmit 同步）', async () => {
    const wrapper = mountEditor([{ type: 'text', text: '你好' }])
    await flushPromises()
    expect(wrapper.find('[data-testid="user-bubble-edit-submit"]').attributes('disabled')).toBeUndefined()
  })
})

describe('UserBubbleEditComposer 键盘路由（R2/R3）', () => {
  it('Enter → emit submit(segments)（chip 即段，与主 composer send 同契约）', async () => {
    const wrapper = mountEditor([
      { type: 'text', text: '总结' },
      { type: 'slash', name: 'compact' },
    ])
    await flushPromises()
    await wrapper.find('[role="textbox"]').trigger('keydown', { key: 'Enter' })
    const submitted = wrapper.emitted('submit')![0]![0] as Segment[]
    expect(submitted.filter((s) => s.type === 'slash')).toEqual([{ type: 'slash', name: 'compact' }])
    expect(submitted.some((s) => s.type === 'text' && s.text.includes('总结'))).toBe(true)
  })

  it('⇧⏎ 换行 → 不 emit submit（dom-core 内部分流，不转发 keydown）', async () => {
    const wrapper = mountEditor([{ type: 'text', text: '你好' }])
    await flushPromises()
    await wrapper.find('[role="textbox"]').trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('Esc → emit cancel', async () => {
    const wrapper = mountEditor([{ type: 'text', text: '你好' }])
    await flushPromises()
    await wrapper.find('[role="textbox"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('cancel')).toBeTruthy()
  })
})

describe('UserBubbleEditComposer 门禁（R4）', () => {
  it('空 segments → 发送钮禁用 + 点击不 emit submit', async () => {
    const wrapper = mountEditor([])
    await flushPromises()
    const btn = wrapper.find('[data-testid="user-bubble-edit-submit"]')
    expect(btn.attributes('disabled')).toBeDefined()
    await btn.trigger('click')
    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('disabled=true（isPendingSend 双发锁透传）→ 发送钮禁用', async () => {
    const wrapper = mountEditor([{ type: 'text', text: '你好' }], { disabled: true })
    await flushPromises()
    expect(
      wrapper.find('[data-testid="user-bubble-edit-submit"]').attributes('disabled'),
    ).toBeDefined()
  })

  it('取消钮 → emit cancel', async () => {
    const wrapper = mountEditor([{ type: 'text', text: '你好' }])
    await flushPromises()
    await wrapper.find('[data-testid="user-bubble-edit-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toBeTruthy()
  })
})

describe('UserBubbleEditComposer 命令浮层联动（R5）', () => {
  it('行首敲 / → CommandPopover open + type=slash + query 透传', async () => {
    const wrapper = mountEditor([])
    await flushPromises()
    await typeWithCursor(wrapper, '/com', 4)
    const popover = wrapper.findComponent(CommandPopover)
    expect(popover.props('open')).toBe(true)
    expect(popover.props('type')).toBe('slash')
    expect(popover.props('query')).toBe('com')
  })

  it('敲 @ → CommandPopover type=subagent（四符号换绑）', async () => {
    const wrapper = mountEditor([])
    await flushPromises()
    await typeWithCursor(wrapper, '@sub', 4)
    const popover = wrapper.findComponent(CommandPopover)
    expect(popover.props('open')).toBe(true)
    expect(popover.props('type')).toBe('subagent')
    expect(popover.props('query')).toBe('sub')
  })

  it('浮层 open 时 Enter 被 window capture 主入口消费（不直达提交——绝不误发）', async () => {
    const wrapper = mountEditor([{ type: 'text', text: '你好' }])
    await flushPromises()
    await typeWithCursor(wrapper, '/com', 4)
    expect(wrapper.findComponent(CommandPopover).props('open')).toBe(true)
    // [TEST-ENV] happy-dom 的 trigger() 不经 window capture 阶段（探针实证：capture 监听
    // 收不到元素 dispatch 的事件），故直接 dispatch 到 window 复现 production 主入口路径：
    // capture 监听先于 contenteditable 命中 → preventDefault + stopPropagation 消费。
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(wrapper.emitted('submit')).toBeUndefined()
  })
})
