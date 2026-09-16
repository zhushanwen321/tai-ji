/**
 * [session-dead 结构性修复 D3] 队列回收 → Composer 草稿的组件层测试（设计 §4 V1② 前端部分：
 * 「队列文本出现在 Composer 草稿且有提示」的 DOM/核心层断言落位）。
 *
 * 消费链端到端：composerInjectionStore.requestInjection（forceQuit 编排写入，见
 * __tests__/sidebar/force-quit-queue-recovery.test.ts）→ 真 Composer.vue 的
 * useComposerInjection（watch + onMounted 遗留补消费）→ ComposerInput.insertTextAtCursor。
 *
 * 场景对应（设计 §3.4 错误规格表「前端草稿回收时 Composer 已有内容」行 + §5 检查点④）：
 * - R1 挂载补消费（草稿可见）：dead 期间滞留槽位的注入请求在 restore 重开（Composer
 *   重新挂载）时被 onMounted 补消费——回收文本进入输入框（可见、可改、可一键重发）
 * - R2 追加不覆盖：消费通道 = insertTextAtCursor（dom-core contenteditable 实现为
 *   execCommand('insertText') 光标插入，已有内容保留——该行为由 dom-core
 *   contenteditable.test.ts 锁定）；本测试锁定消费面**不触碰覆盖型 API（setText/clear）**
 * - R3 提示文案：两 locale key 形态 + zh 渲染产物（30 字内、只陈述事实）
 *
 * jsdom 不实现 document.execCommand（contenteditable 真实 DOM 写入不可行），故 R1/R2 以
 * ComposerInput stub 的 expose spy 锁定「真 Composer 消费链调用了哪个输入 API、携带什么
 * 文本」——挂载的 Composer.vue / useComposerInjection / injection store 全为真实实现。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/force-quit-draft-recovery-dom.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── mock composable / api（对齐 composer-file-injection.test.ts 的可挂载最小面）──
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    send: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    abort: vi.fn(),
    compact: vi.fn(),
    editAndResend: vi.fn(),
    hydrateHistory: vi.fn(),
  }),
}))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({
    startFlow: vi.fn(),
    submitFirstMessage: vi.fn(),
    currentModel: { value: null },
    setPendingModel: vi.fn(),
    state: { value: 'idle' },
    currentSessionId: { value: null },
    currentCwd: { value: null },
  }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({
  project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })) },
  composer: {
    getMentionCandidates: vi.fn().mockResolvedValue([]),
    getFileCandidates: vi.fn().mockResolvedValue([]),
  },
  config: {
    getGlobalSkills: vi.fn().mockResolvedValue([]),
    getProjectSkills: vi.fn().mockResolvedValue([]),
    onSkillCacheInvalidated: () => () => {},
  },
}))

// ── mock store（commandStore / chat / session / settings 依赖面）──
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    isStreaming: ref(false),
    isActive: () => false,
    getRetryState: () => undefined,
    getQueueState: () => undefined,
    isCompacting: () => false,
    sessionPhase: () => ({ turn: 'idle', compacting: false, bash: false }),
    getMessages: () => [],
    getOccupancy: () => ({ turn: 'idle', compacting: false, bash: false }),
  }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn() }),
}))

// ── ComposerInput stub：expose 面带 insertTextAtCursor / setText 等 spy（消费 API 断言面）──
interface InputCalls {
  insertTextAtCursor: ReturnType<typeof vi.fn>
  setText: ReturnType<typeof vi.fn>
  clear: ReturnType<typeof vi.fn>
  insertFileChip: ReturnType<typeof vi.fn>
  insertSessionChip: ReturnType<typeof vi.fn>
}
let inputCallsList: InputCalls[] = []
vi.mock('@taiji/ui/features/composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/ui/features/composer')>()
  return {
    ...actual,
    ComposerInput: defineComponent({
      name: 'ComposerInput',
      emits: ['input', 'keydown', 'focus', 'blur', 'slash-trigger', 'file-trigger'],
      setup(_, { expose }) {
        const calls: InputCalls = {
          insertTextAtCursor: vi.fn(),
          setText: vi.fn(),
          clear: vi.fn(),
          insertFileChip: vi.fn(),
          insertSessionChip: vi.fn(),
        }
        inputCallsList.push(calls)
        expose({
          clear: calls.clear,
          focus: vi.fn(),
          getText: () => '',
          getSegments: () => [],
          setText: calls.setText,
          insertTextAtCursor: calls.insertTextAtCursor,
          insertSlashChip: vi.fn(),
          insertFileChip: calls.insertFileChip,
          insertImageBadge: vi.fn(),
          removeImageChip: vi.fn(),
          moveCaretVertical: () => 'at-edge' as const,
          insertSessionChip: calls.insertSessionChip,
        })
        return () => null
      },
    }),
  }
})

import Composer from '@/components/panel/Composer.vue'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'
import zhSidebar from '@/i18n/locales/zh-CN/sidebar'
import enSidebar from '@/i18n/locales/en-US/sidebar'
import { useI18n } from 'vue-i18n'

const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
const otherStubs = {
  CommandPopover: defineComponent({ name: 'CommandPopover', template: '<div><slot /></div>' }),
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

function mountComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }) {
  const wrapper = mount(Composer, { props, global: { stubs: otherStubs } })
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  inputCallsList = []
  composerInjectionStore.clearInjection()
})

const wrappers: Array<{ unmount: () => void }> = []
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
})

describe('队列回收 → Composer 草稿（session-dead D3 / V1② 组件层）', () => {
  it('R1: dead 期间滞留槽位的回收文本，Composer 挂载（restore 重开）时补消费进输入框——草稿可见', async () => {
    // 模拟 forceQuit 时序：Composer 已随 dead 占位卸载，注入请求滞留槽位
    composerInjectionStore.requestInjection({
      target: 'current',
      sessionId: 's1',
      text: '排队消息甲\n\n排队消息乙',
    })

    // 用户点击 dead session → restore 重开 → Composer 重新挂载（sessionId 不变）
    wrappers.push(mountComposer({ sessionId: 's1', variant: 'panel' }))
    await flushPromises()

    // onMounted 遗留请求补消费：回收文本经 insertTextAtCursor 进入输入框（草稿可见、
    // 可改、可一键重发），槽位清空
    expect(inputCallsList).toHaveLength(1)
    expect(inputCallsList[0]!.insertTextAtCursor).toHaveBeenCalledTimes(1)
    expect(inputCallsList[0]!.insertTextAtCursor).toHaveBeenCalledWith('排队消息甲\n\n排队消息乙')
    expect(composerInjectionStore.pendingInjection.value).toBeNull()
  })

  it('R2: Composer 已有内容时追加不覆盖——消费面只走光标插入通道，覆盖型 API 零调用', async () => {
    wrappers.push(mountComposer({ sessionId: 's1', variant: 'panel' }))

    // 第一批注入（模拟既有草稿/先回收的一批）
    composerInjectionStore.requestInjection({ target: 'current', sessionId: 's1', text: '用户正在输入的内容' })
    await flushPromises()
    // 第二批注入（forceQuit 回收的队列文本）——设计 §3.4：追加到现有草稿之后，不覆盖
    composerInjectionStore.requestInjection({ target: 'current', sessionId: 's1', text: '回收的队列文本' })
    await flushPromises()

    const calls = inputCallsList[0]!
    // 两次注入都经光标插入通道（execCommand insertText = 追加语义，保留光标前内容）
    expect(calls.insertTextAtCursor.mock.calls.map((c) => c[0])).toEqual([
      '用户正在输入的内容',
      '回收的队列文本',
    ])
    // 覆盖型 API 全程零调用（结构上不可能清掉用户正在输入的内容）
    expect(calls.setText).not.toHaveBeenCalled()
    expect(calls.clear).not.toHaveBeenCalled()
  })

  it('R3: 提示文案——两 locale key 就位、只陈述事实，zh 渲染产物为「N 条排队消息已收回草稿」', () => {
    // zh：单数复数同文案（中文无复数形态，对齐 deleteFolderPartialFailed 先例）
    expect(zhSidebar.forceQuitQueueRecovered).toBe('{count} 条排队消息已收回草稿')
    // en：vue-i18n 复数两段形态
    expect(enSidebar.forceQuitQueueRecovered).toContain('|')
    expect(enSidebar.forceQuitQueueRecovered.split('|')).toHaveLength(2)
    for (const segment of enSidebar.forceQuitQueueRecovered.split('|')) {
      expect(segment).toContain('moved back to draft')
    }
    // 渲染产物（全局 i18n setup 的 t mock，按 zh-CN 解析 + 命名参数替换）
    const { t } = useI18n()
    const rendered = t('sidebar.forceQuitQueueRecovered', 2, { named: { count: 2 } })
    expect(rendered).toBe('2 条排队消息已收回草稿')
  })
})
