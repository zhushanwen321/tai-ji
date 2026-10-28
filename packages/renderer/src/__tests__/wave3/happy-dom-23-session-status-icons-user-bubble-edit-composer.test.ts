import { composerApiModule } from '@/__tests__/helpers/composer-mount';
import CommandPopover from '@/components/panel/CommandPopover.vue';
import UserBubbleEditComposer from '@/components/panel/message-stream/UserBubbleEditComposer.vue';
import SessionItem from '@/components/sidebar/SessionItem.vue';
import { DOT_CLASS, deriveStatus, STATUS_ICON } from '@/composables/logic/sessionStatus';
import { markUnread, clearUnread } from '@/composables/useSessionMarkers';
import { useChatStore } from '@/stores/chat';
import type { DerivedStatus } from '@/types';
import type { Segment } from '@taiji/shared';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// wave3 簇 [renderer/happy-dom] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/panel/session-status-icons.test.ts
 * - __tests__/panel/user-bubble-edit-composer.test.ts
 */

// ======================================================================
// ← __tests__/panel/session-status-icons.test.ts
// ======================================================================

describe('session status icons extended states', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('DOT_CLASS 包含所有扩展状态', () => {
    const statuses: DerivedStatus[] = [
      'streaming',
      'pending',
      'compacting',
      'waiting',
      'retrying',
      'working',
      'done',
      'stopped',
      'error',
    ]
    for (const s of statuses) {
      expect(DOT_CLASS[s]).toBeDefined()
    }
  })

  it('STATUS_ICON 包含所有扩展状态', () => {
    const statuses: DerivedStatus[] = [
      'streaming',
      'pending',
      'compacting',
      'waiting',
      'retrying',
      'working',
      'done',
      'stopped',
      'error',
    ]
    for (const s of statuses) {
      expect(STATUS_ICON[s]).toBeDefined()
      expect(STATUS_ICON[s].icon).toBeDefined()
      expect(STATUS_ICON[s].color).toBeDefined()
    }
  })

  it('pendingSend 派生为 pending', () => {
    const chat = useChatStore()
    chat.addPendingSend('sid')
    expect(deriveStatus('sid', chat, true)).toBe('pending')
  })

  it('compacting 派生为 compacting', () => {
    const chat = useChatStore()
    chat.setOccupancy('sid', { turn: 'idle', compacting: true, bash: false })
    expect(deriveStatus('sid', chat, false, true)).toBe('compacting')
  })

  it('hasBackgroundWork=true 且非活跃 派生为 working', () => {
    const chat = useChatStore()
    expect(deriveStatus('sid', chat, false, false, true)).toBe('working')
  })

  it('streaming 优先于 working（主 turn 流式时不被 working 抢占）', () => {
    const chat = useChatStore()
    // isGenerating 经 messages 含 status='streaming' 派生（无 setter），构造 streaming 消息触发
    chat.setMessages('sid', [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, status: 'streaming' },
    ])
    expect(deriveStatus('sid', chat, true, false, true)).toBe('streaming')
  })

  it('working 优先于 pending（isActive 但非 streaming 时 working 抢先）', () => {
    const chat = useChatStore()
    // pendingSend → isActive=true，但非 isGenerating 非 streaming；hasBackgroundWork=true → working 先于 pending
    chat.addPendingSend('sid')
    expect(deriveStatus('sid', chat, true, false, true)).toBe('working')
  })

  it('streaming 状态 SessionItem 渲染 running badge（spec §5.6A D12 列表主行范式）', () => {
    const wrapper = mount(SessionItem, {
      props: {
        session: { id: '1', label: 'x', cwd: '/a', lastActiveAt: 0, status: 'active' },
        active: false,
        status: 'streaming',
      },
    })
    // streaming → 右槽 spinning icon（旋转箭头；2026-10-11 裁决状态点右移，session-icon
    // 本体即状态元素）
    const icon = wrapper.find('[data-testid="session-icon"]')
    expect(icon.exists()).toBe(true)
    expect(icon.classes()).toContain('animate-spin')
  })

  it('waiting 状态 SessionItem 渲染 waiting … badge', () => {
    const wrapper = mount(SessionItem, {
      props: {
        session: { id: '1', label: 'x', cwd: '/a', lastActiveAt: 0, status: 'active' },
        active: false,
        status: 'waiting',
      },
    })
    const icon = wrapper.find('[data-testid="session-icon"]')
    expect(icon.exists()).toBe(true)
    expect(icon.classes()).toContain('bg-warn')
  })

  it('error 状态 SessionItem 渲染 ! 胶囊 badge（danger，需用户介入）', () => {
    const wrapper = mount(SessionItem, {
      props: {
        session: { id: '1', label: 'x', cwd: '/a', lastActiveAt: 0, status: 'active' },
        active: false,
        status: 'error',
      },
    })
    // error → danger 实心圆 icon
    const icon = wrapper.find('[data-testid="session-icon"]')
    expect(icon.exists()).toBe(true)
    expect(icon.classes()).toContain('bg-danger')
  })

  it('done / stopped 状态 SessionItem 无 badge（仅耗时文字）', () => {
    for (const status of ['done', 'stopped'] as const) {
      const wrapper = mount(SessionItem, {
        props: {
          session: { id: '1', label: 'x', cwd: '/a', lastActiveAt: 0, status: 'active' },
          active: false,
          status,
        },
      })
      // 终态：左侧显示 success icon（done）或 neutral-dim icon（stopped），右侧仅时间文字
      expect(wrapper.find('[data-testid="session-icon"]').exists()).toBe(true)
      if (status === 'done') {
        expect(wrapper.find('.bg-success').exists()).toBe(true)
      } else {
        expect(wrapper.find('.border-neutral-dim').exists()).toBe(true)
      }
    }
  })

  it('dead 状态 isDead 抑制 badge（整行 opacity-50 表达，无任何状态 badge）', () => {
    const wrapper = mount(SessionItem, {
      props: {
        session: { id: '1', label: 'x', cwd: '/a', lastActiveAt: 0, status: 'dead' },
        active: false,
        status: 'dead',
      },
    })
    // dead → 右槽 neutral-dim 实心圆 50%，整行 opacity-50
    const icon = wrapper.find('[data-testid="session-icon"]')
    expect(icon.exists()).toBe(true)
    expect(icon.classes()).toContain('bg-neutral-dim')
    expect(icon.classes()).toContain('opacity-50')
    expect(wrapper.find('.session-item').classes()).toContain('opacity-50')
  })

  it('未读替换式：unread 时左侧渲染单一 accent 实心点，状态 icon 被替换不叠加', () => {
    markUnread('1')
    try {
      const wrapper = mount(SessionItem, {
        props: {
          session: { id: '1', label: 'x', cwd: '/a', lastActiveAt: 0, status: 'active' },
          active: false,
          status: 'done',
        },
      })
      // 用户可见 DOM：未读点本体 = accent 实心圆（unread 时 session-icon testid 被
      // session-unread-dot 替换持有——单一 icon 范式，替换而非叠加）
      const dot = wrapper.find('[data-testid="session-unread-dot"]')
      expect(dot.exists()).toBe(true)
      expect(dot.classes()).toContain('bg-accent')
      // done 的 success 点不再渲染（叠加式两点同尺寸 7px 盖不全，左下会露出底层点月牙边）
      expect(wrapper.find('[data-testid="session-icon"].bg-success').exists()).toBe(false)
    } finally {
      clearUnread('1')
    }
  })
})

// ======================================================================
// ← __tests__/panel/user-bubble-edit-composer.test.ts
// ======================================================================

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
