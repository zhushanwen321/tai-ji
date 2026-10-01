/**
 * composer 历史派生测试：deriveHistoryFromChatStore 派生语义基线 + R2-A6 草稿保存回归。
 *
 * 本文件锁定：
 * ① 派生语义（倒序 + role==='user' + status==='complete' + 去重连续相同文本）——
 *    唯一消费链是 core history 模块的 Vue computed（记忆化由 computed 承担），派生函数
 *    保持纯函数形态
 * ② [R2-A6 回归] browsing 态切 session 再切回：草稿恢复用户真实输入（history savedDraft），
 *    而非 browsing 期输入区显示的历史条目文本（修复前恒存 getText()＝历史条目）
 *
 * mock 策略参照 composer-model-reasoning.test.ts：composer-shell.ts 模块加载链含
 * useChat/useNewTaskFlow/api 等 renderer 重依赖，vi.mock 隔离；① 直调纯派生函数，
 * ② mount Composer（真 pinia chat store 驱动历史派生）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-history-cache.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { Message } from '@taiji/shared'
import { deriveHistoryFromChatStore } from '@/composables/panel/composer-shell'
import { useChatStore } from '@/stores/chat'
import { composerChildStubs } from '../helpers/composer-mount'
import Composer from '@/components/panel/Composer.vue'

vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    send: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    abort: vi.fn(),
    compact: vi.fn(),
    sendBash: vi.fn(),
  }),
}))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({
    submitFirstMessage: vi.fn(),
    currentModel: { value: null },
    setPendingModel: vi.fn(),
    currentCwd: ref(null),
  }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({
  project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn() },
  composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/composables/features/settings/useProjectSkills', () => ({
  useProjectSkills: () => ({ projectSkills: [] }),
  useGlobalSkills: () => ({ globalSkills: [] }),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ forkSessionAsk: vi.fn(), forkSession: vi.fn() }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn() }),
}))

type ChatStore = ReturnType<typeof useChatStore>

/** 最小 user/assistant 消息构造（派生只读 role/status/content） */
function userMsg(id: string, text: string, status: Message['status'] = 'complete'): Message {
  return { id, role: 'user', content: text, status, timestamp: 0 }
}
function assistantMsg(id: string, text: string): Message {
  return { id, role: 'assistant', content: text, status: 'complete', timestamp: 0 }
}

/** 结构化 chatStore stub：deriveHistoryFromChatStore 只消费 getMessages（固定数组引用） */
function fakeStore(msgs: Message[]): ChatStore {
  return { getMessages: (_sid: string) => msgs } as unknown as ChatStore
}

describe('deriveHistoryFromChatStore 派生语义（纯函数基线行为）', () => {
  it('倒序 + 仅 user+complete + 连续相同文本去重', () => {
    const msgs = [
      userMsg('u1', 'first'),
      assistantMsg('a1', 'reply'),
      userMsg('u2', 'second'),
      userMsg('u3', 'second'), // 连续重复 → 去重
      userMsg('u4', 'draft', 'streaming'), // 未 complete → 排除
      assistantMsg('a2', 'as text'),
    ]
    expect(deriveHistoryFromChatStore(fakeStore(msgs), 's1')).toEqual(['second', 'first'])
  })

  it('非连续相同文本不去重', () => {
    const msgs = [userMsg('u1', 'same'), userMsg('u2', 'other'), userMsg('u3', 'same')]
    expect(deriveHistoryFromChatStore(fakeStore(msgs), 's1')).toEqual(['same', 'other', 'same'])
  })

  it('Segment[] content 经 normalizeContent 归一为纯文本', () => {
    const msgs: Message[] = [
      {
        id: 'u1',
        role: 'user',
        content: [
          { type: 'text', text: '带结构 ' },
          { type: 'text', text: '分段' },
        ],
        status: 'complete',
        timestamp: 0,
      },
    ]
    expect(deriveHistoryFromChatStore(fakeStore(msgs), 's1')).toEqual(['带结构 分段'])
  })
})

// ── [R2-A6 回归] browsing 态跨 session 切换的草稿保存 ──────────────────────

const lastInputText = ref('')
const ComposerInputMock = defineComponent({
  name: 'ComposerInput',
  props: {
    placeholder: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
  },
  emits: {
    input: (val: string) => {
      lastInputText.value = val
      return true
    },
    keydown: null,
    'slash-trigger': null,
    'file-trigger': null,
  },
  setup(_, { expose, emit }) {
    expose({
      clear: () => {
        lastInputText.value = ''
        emit('input', '')
      },
      // 对齐真实 ComposerInput 契约：setText 更新输入区并 emit input（contenteditable.ts setText 末尾 emitInput）
      setText: (text: string) => {
        lastInputText.value = text
        emit('input', text)
      },
      insertSlashChip: vi.fn(),
      getSegments: () => (lastInputText.value ? [{ type: 'text' as const, text: lastInputText.value }] : []),
      getText: () => lastInputText.value,
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

describe('R2-A6 回归：browsing 态切 session 后切回，草稿为用户输入而非历史文本', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    lastInputText.value = ''
  })

  it('browsing 中切走（草稿存 savedDraft）→ 切回恢复用户真实输入', async () => {
    const chat = useChatStore()
    chat.hydrate('s1', [
      userMsg('u1', '历史消息一'),
      assistantMsg('a1', '回复'),
    ])
    const wrapper = mount(Composer, { props: { sessionId: 's1' }, global: { stubs } })
    await nextTick()
    const input = wrapper.findComponent(ComposerInputMock)

    // 用户输入草稿
    input.vm.$emit('input', '用户的草稿')
    await nextTick()
    // ↑ 进 browsing：输入区被历史条目替换（getText 返回历史文本）
    input.vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    await nextTick()
    // 前置：browsing 生效——输入区当前显示的是历史条目而非用户草稿
    expect(lastInputText.value).toBe('历史消息一')

    // 切到 s2（此刻保存旧 session 草稿），再切回 s1
    await wrapper.setProps({ sessionId: 's2' })
    await nextTick()
    await wrapper.setProps({ sessionId: 's1' })
    await nextTick()

    // 草稿 = 用户真实输入（history savedDraft），而非 browsing 期输入区显示的历史条目
    expect(lastInputText.value).toBe('用户的草稿')
    expect(lastInputText.value).not.toBe('历史消息一')
  })
})
