/**
 * TurnSummary.vue 组件测试（W4TC4 + ai-voice-tts §5.1 朗读按钮）。
 *
 * 覆盖：
 * - W4TC4: TurnSummary 拆分后渲染一致（summary + streaming cursor + hover actions 复制/MD/朗读/fork/handoff）
 * - [block-rendering M0] 去内容化：根 v-if 从 summaryText 改 lastAssistant（纯工具 turn 出现操作栏，
 *   预期行为变更）；streaming 光标迁移到 Turn.vue streaming-tail（TC-M0-2 在 turn-working 覆盖）；
 *   text-neutral-* 切色迁移到 Block.vue text 分支（TC-M0-4）
 * - ai-voice-tts §5.1：朗读按钮（未 provide 不渲染 / 状态机三态 title 与图标形态 /
 *   生成中置灰 / subagent session 可见）
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/TurnSummary.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { TurnSummary, type ChatViewDeps } from '@taiji/ui'
import type { MessageTurn } from '@taiji/core/domain/chat'
import type { Message } from '@taiji/shared'
import { mockChatProvide } from './helpers'

// 朗读按钮 title 走 i18n（panel.message.speak*，键登记唯一写入者 = u4，locale 文件未落盘时
// 全局 setup 的 t() 返回 key 本身无法断言文案）——按 vitest.setup.ts 指引在测试内 override
// vi.mock('vue-i18n')，提供 speak* 四键测试词表，其余 key 维持「返回 key 本身」行为。
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, ...rest: unknown[]) => {
      const table: Record<string, string> = {
        'panel.message.speakTitle': '朗读',
        'panel.message.speakCancel': '取消',
        'panel.message.speakStop': '停止',
        'panel.message.speakStreaming': '回复生成中',
      }
      let result = table[key] ?? key
      const named = typeof rest[0] === 'object' && rest[0] !== null ? (rest[0] as Record<string, unknown>) : undefined
      if (named) {
        for (const [k, v] of Object.entries(named)) result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
      }
      return result
    },
    locale: { value: 'zh-CN' },
  }),
}))

const NOW = Date.now()

function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: NOW },
    assistants: [{ id: 'a1', role: 'assistant', content: 'Here is the result.', status: 'complete', timestamp: NOW }],
    isStreaming: false,
    hasFoldable: false,
    ...over,
  }
}

function mountSummary(props: {
  turn?: MessageTurn
  sessionId?: string
  lastAssistant?: Message | null
  depsOverrides?: Partial<ChatViewDeps>
} = {}) {
  const turn = props.turn ?? makeTurn()
  return mount(TurnSummary, {
    props: {
      turn,
      sessionId: props.sessionId ?? 's1',
      lastAssistant: 'lastAssistant' in props ? (props.lastAssistant ?? null) : (turn.assistants[turn.assistants.length - 1] ?? null),
    },
    global: {
      provide: mockChatProvide(props.depsOverrides ?? {}),
      stubs: {
        MarkdownRenderer: true,
      },
    },
  })
}

describe('W4TC4: TurnSummary 基本渲染', () => {
  it('有 lastAssistant 时 turn-summary 操作栏存在', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('.turn-summary').exists()).toBe(true)
  })

  // [block-rendering M0] 空 content（纯工具 turn）：根 v-if 从 summaryText 改 lastAssistant 后
  // 操作栏仍渲染（预期行为变更，原 summaryText 门控下不渲染）
  it('空 content（纯工具 turn）也渲染 turn-summary + 操作栏（根 v-if 改 lastAssistant）', () => {
    const wrapper = mountSummary({
      turn: makeTurn({ assistants: [{ id: 'a1', role: 'assistant', content: '', status: 'complete', timestamp: NOW }] }),
    })
    expect(wrapper.find('.turn-summary').exists()).toBe(true)
    expect(wrapper.find('[data-testid="copy-btn"]').exists()).toBe(true)
  })
})

describe('W4TC4: TurnSummary hover actions', () => {
  it('有 lastAssistant 时 hover actions 容器存在 + 5 并列按钮渲染', () => {
    const wrapper = mountSummary()
    // hover actions 容器存在（opacity-0 group-hover:opacity-100）
    const actionsDiv = wrapper.find('.turn-summary .mt-1\\.5')
    expect(actionsDiv.exists()).toBe(true)
    // 5 个并列按钮：复制 / 复制MD / 朗读 / fork / handoff（无两层 hover 变体）
    const buttons = actionsDiv.findAll('button')
    expect(buttons.length).toBe(5)
  })

  it('无 lastAssistant 时不渲染 hover actions', () => {
    const wrapper = mountSummary({ lastAssistant: null })
    expect(wrapper.find('[data-testid="fork-ask-btn"]').exists()).toBe(false)
  })

  it('copy-btn 存在（复制纯文本）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="copy-btn"]').exists()).toBe(true)
  })

  it('copy-markdown-btn 作为独立按钮存在（复制 Markdown）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="copy-markdown-btn"]').exists()).toBe(true)
  })

  it('fork-ask-btn 存在（fork 进 composer 模式）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="fork-ask-btn"]').exists()).toBe(true)
  })

  it('不再渲染 fork-background-btn（已并入 fork-ask 空提交）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="fork-background-btn"]').exists()).toBe(false)
  })

  it('handoff-ask-btn 存在（handoff 进 composer 模式）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="handoff-ask-btn"]').exists()).toBe(true)
  })

  it('不再渲染 handoff-btn（已并入 handoff-ask 空提交）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="handoff-btn"]').exists()).toBe(false)
  })

  it('不再渲染 ⋯ overflow（more-actions-btn）', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('[data-testid="more-actions-btn"]').exists()).toBe(false)
  })

  it('fork/handoff 按钮在 subagent session 隐藏', () => {
    const wrapper = mountSummary({ sessionId: 'subagent:main1:sub1' })
    // subagent session：复制×2 + 朗读 3 按钮形态（朗读是只读消费，与复制同类可见），无 fork/handoff
    expect(wrapper.find('[data-testid="fork-ask-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="handoff-ask-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="speak-btn"]').exists()).toBe(true)
    const actionsDiv = wrapper.find('.turn-summary .mt-1\\.5')
    expect(actionsDiv.findAll('button').length).toBe(3)
  })
})

// [block-rendering M0] TC-M0-5：TurnSummary 去内容化门控（streaming-tail 是 Turn.vue 元素，由 turn-working 覆盖）
describe('block-rendering M0: TurnSummary 去内容化', () => {
  it('TC-M0-5a: 有 content 时 .turn-summary 存在但不含 MarkdownRenderer 渲染与 .streaming-cursor', () => {
    const wrapper = mountSummary()
    expect(wrapper.find('.turn-summary').exists()).toBe(true)
    // 文字渲染已移除（MarkdownRenderer stub 不出现）
    expect(wrapper.findComponent({ name: 'MarkdownRenderer' }).exists()).toBe(false)
    // 光标已迁移到 Turn.vue streaming-tail，TurnSummary 内无光标
    expect(wrapper.find('.streaming-cursor').exists()).toBe(false)
  })

  it('TC-M0-5b: 纯工具 turn（lastAssistant 无 content）出现完整操作栏（预期行为变更）', () => {
    const wrapper = mountSummary({
      turn: makeTurn({ assistants: [{ id: 'a1', role: 'assistant', content: '', status: 'complete', timestamp: NOW }] }),
    })
    expect(wrapper.find('.turn-summary').exists()).toBe(true)
    // 5 操作按钮：复制 / 复制MD / 朗读 / fork / handoff
    const actionsDiv = wrapper.find('.turn-summary .mt-1\\.5')
    expect(actionsDiv.findAll('button').length).toBe(5)
  })
})

// ai-voice-tts §5.1：朗读按钮（u5）——未 provide 不渲染 / 状态机 / 生成中置灰
describe('ai-voice-tts §5.1: 朗读按钮', () => {
  it('deps 两字段未 provide 时朗读按钮不渲染（provide 后渲染）', () => {
    const absent = mountSummary({
      depsOverrides: { onSpeak: undefined, speakStateOf: undefined },
    })
    expect(absent.find('[data-testid="speak-btn"]').exists()).toBe(false)

    const present = mountSummary()
    expect(present.find('[data-testid="speak-btn"]').exists()).toBe(true)
  })

  it('idle 态：按钮可点、title=朗读、点击透传 onSpeak(sessionId, lastAssistant)', async () => {
    const onSpeak = vi.fn()
    const wrapper = mountSummary({ depsOverrides: { onSpeak } })
    const btn = wrapper.find('[data-testid="speak-btn"]')
    expect(btn.attributes('title')).toBe('朗读')
    expect(btn.attributes('disabled')).toBeUndefined()
    // loading/playing 图标形态缺席（Volume2 无 spin 类）
    expect(btn.find('svg.animate-spin').exists()).toBe(false)

    await btn.trigger('click')
    expect(onSpeak).toHaveBeenCalledTimes(1)
    expect(onSpeak).toHaveBeenCalledWith('s1', wrapper.props('lastAssistant'))
  })

  it('loading 态：Loader2 旋转形态 + title=取消；点击仍透传 onSpeak（取消动作分流在装配层）', async () => {
    const onSpeak = vi.fn()
    const wrapper = mountSummary({
      depsOverrides: { onSpeak, speakStateOf: () => 'loading' },
    })
    const btn = wrapper.find('[data-testid="speak-btn"]')
    expect(btn.attributes('title')).toBe('取消')
    expect(btn.find('svg.animate-spin').exists()).toBe(true)

    await btn.trigger('click')
    expect(onSpeak).toHaveBeenCalledTimes(1)
  })

  it('playing 态：title=停止；点击后状态回 idle（speakStateOf 变化驱动按钮回朗读态）', async () => {
    const onSpeak = vi.fn()
    // 状态源用 ref 驱动（对齐生产实现：speakStateOf 内部读全局单例 ref，computed 才可追踪）
    const state = ref<'idle' | 'loading' | 'playing'>('playing')
    const wrapper = mountSummary({
      depsOverrides: { onSpeak, speakStateOf: () => state.value },
    })
    let btn = wrapper.find('[data-testid="speak-btn"]')
    expect(btn.attributes('title')).toBe('停止')

    // playing 点击 = 停止（装配层调 stop；ui 断言点击透传 + 状态源变化后按钮回 idle 形态）
    await btn.trigger('click')
    expect(onSpeak).toHaveBeenCalledTimes(1)

    // 播完 / 停止：speakStateOf 返回 idle → 按钮回 idle 形态（title=朗读）
    state.value = 'idle'
    await wrapper.vm.$nextTick()
    btn = wrapper.find('[data-testid="speak-btn"]')
    expect(btn.attributes('title')).toBe('朗读')
  })

  it('生成中置灰：turn.isStreaming=true 时 disabled + title=回复生成中；false 恢复可点', async () => {
    const wrapper = mountSummary({ turn: makeTurn({ isStreaming: true }) })
    let btn = wrapper.find('[data-testid="speak-btn"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toBe('回复生成中')

    // 生成完成（isStreaming 翻转）→ 恢复可点 + title=朗读
    await wrapper.setProps({ turn: makeTurn({ isStreaming: false }) })
    btn = wrapper.find('[data-testid="speak-btn"]')
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.attributes('title')).toBe('朗读')
  })
})
