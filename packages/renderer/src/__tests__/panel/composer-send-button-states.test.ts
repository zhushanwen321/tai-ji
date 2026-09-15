/**
 * Composer 发送位四态测试（session-occupancy u6b / D6 表「发送位」列）。
 *
 * 发送位按 sendButtonState（shell effectivePhase 派生，与分发器 sendRoute 同源）渲染：
 * | 行 | sessionPhase                              | 发送位          |
 * |----|-------------------------------------------|-----------------|
 * | 1  | 全 idle                                    | ↑ send          |
 * | 2  | turn=dispatching/generating（无 compacting）| ■ stop          |
 * | 3  | turn=generating + compacting（threshold）   | ■ stop          |
 * | 4  | turn=settling                              | 单独→stop；+compacting→queue |
 * | 5  | turn=idle + compacting                     | ↑ queue（时钟角标）|
 * | 6  | bash=true 且 turn=idle                     | ↑ queue          |
 *
 * 覆盖（三视角，用户可见 DOM 断言优先）：
 * - 六行逐一 DOM 断言（含 settling 分档两形态与 threshold 行 3 的「turn 活跃优先于 compacting」）
 * - queue 态角标 title（「排队发送 · ⏎」）/ Clock aria-hidden / stop / send title
 * - ActivityStrip（u6a）与发送位同屏共存不互扰（同 wrapper 双组件 + 同一 chat store 真值）
 * - CompactQueueBadge / 专属 i18n key / testid 零残留（源码 grep 断言，C-proc-10）
 *
 * 策略（对齐 composer-three-states.test.ts 结构范本）：真 pinia + 真 chat store
 * （chat.setOccupancy 驱动 occupancy 投影——D6 路由同源）；mock useChat / useNewTaskFlow /
 * api / session store；ComposerInput mock。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-send-button-states.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { textToSegments } from '@taiji/shared'

// ── mock useChat（spy 化 send/steer/abort）──
const chatApiMock = vi.hoisted(() => ({
  send: vi.fn(() => Promise.resolve()),
  steer: vi.fn(() => Promise.resolve()),
  followUp: vi.fn(() => Promise.resolve()),
  abort: vi.fn(() => Promise.resolve()),
  compact: vi.fn(() => Promise.resolve()),
  editAndResend: vi.fn(),
  hydrateHistory: vi.fn(),
  sendBash: vi.fn(() => Promise.resolve()),
  abortBash: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => chatApiMock,
}))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ submitFirstMessage: vi.fn(), currentModel: { value: null }, setPendingModel: vi.fn(), currentCwd: ref(null) }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: { send: chatApiMock.send, steer: chatApiMock.steer, streamSubscribe: vi.fn(() => () => {}) },
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })) },
  composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
  config: { getGlobalSkills: vi.fn().mockResolvedValue([]), getProjectSkills: vi.fn().mockResolvedValue([]), onSkillCacheInvalidated: () => () => {} },
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn() }),
}))

// ── ComposerInput mock：emit input 设 draft ──
const lastInputText = ref('')
const ComposerInputMock = defineComponent({
  name: 'ComposerInput',
  emits: {
    input: (val: string) => {
      lastInputText.value = val
      return true
    },
    keydown: null,
    'slash-trigger': null,
    'file-trigger': null,
  },
  setup(_, { expose }) {
    const clear = vi.fn()
    const setText = vi.fn()
    expose({ clear, setText, insertSlashChip: vi.fn(), getSegments: () => textToSegments(lastInputText.value) })
    return { clear, setText }
  },
  template: '<div data-testid="composer-input" />',
})

const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
const otherStubs = {
  ComposerInput: ComposerInputMock,
  CommandPopover: defineComponent({ name: 'CommandPopover', template: '<div><slot /></div>' }),
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

import Composer from '@/components/panel/Composer.vue'
import ActivityStrip from '@/components/panel/message-stream/ActivityStrip.vue'
import { useChatStore } from '@/stores/chat'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  lastInputText.value = ''
})

function mountComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }): VueWrapper {
  return mount(Composer, { props, global: { stubs: otherStubs } })
}

/** 同一 wrapper 挂 ActivityStrip + Composer（同屏共存场景——同一 chat store 真值驱动两组件） */
function mountStripAndComposer(sessionId: string): VueWrapper {
  return mount(
    defineComponent({
      components: { ActivityStrip, Composer },
      template: `<div><ActivityStrip session-id="${sessionId}" /><Composer session-id="${sessionId}" /></div>`,
    }),
    { global: { stubs: otherStubs } },
  )
}

/** 发送位形态断言辅助：stop / queue / send 三态的互斥 DOM 判定 */
function expectSendButtonState(wrapper: VueWrapper, expected: 'stop' | 'queue' | 'send'): void {
  const stop = wrapper.find('.stop-btn')
  const queue = wrapper.find('.queue-send-btn')
  if (expected === 'stop') {
    expect(stop.exists()).toBe(true)
    expect(queue.exists()).toBe(false)
  } else if (expected === 'queue') {
    expect(queue.exists()).toBe(true)
    expect(stop.exists()).toBe(false)
  } else {
    expect(stop.exists()).toBe(false)
    expect(queue.exists()).toBe(false)
    // idle send 态：发送按钮存在（title 随 canSubmit=「发送 · ⏎」/ 无输入=「输入内容后发送」）
    const sendBtn = wrapper.findAll('button').find((b) => b.attributes('title')?.includes('发送'))
    expect(sendBtn).toBeDefined()
  }
}

describe('D6 发送位四态（六行逐一 DOM 断言）', () => {
  it('行 1：全 idle → ↑ send（无 stop/queue）', () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    expectSendButtonState(wrapper, 'send')
  })

  it('行 2：turn=dispatching → ■ stop', () => {
    const chat = useChatStore()
    chat.setOccupancy('s2', { turn: 'dispatching', compacting: false, bash: false })
    const wrapper = mountComposer({ sessionId: 's2' })
    expectSendButtonState(wrapper, 'stop')
  })

  it('行 2：turn=generating（无 compacting）→ ■ stop', () => {
    const chat = useChatStore()
    chat.setOccupancy('s2g', { turn: 'generating', compacting: false, bash: false })
    const wrapper = mountComposer({ sessionId: 's2g' })
    expectSendButtonState(wrapper, 'stop')
  })

  it('行 3：turn=generating + compacting（threshold turn 内压缩）→ ■ stop（turn 活跃优先，不入 queue）', () => {
    const chat = useChatStore()
    chat.setOccupancy('s3', { turn: 'generating', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's3' })
    expectSendButtonState(wrapper, 'stop')
  })

  it('行 4：turn=settling 单独 → ■ stop（收尾期可中止）', () => {
    const chat = useChatStore()
    chat.setOccupancy('s4', { turn: 'settling', compacting: false, bash: false })
    const wrapper = mountComposer({ sessionId: 's4' })
    expectSendButtonState(wrapper, 'stop')
  })

  it('行 4 分档：turn=settling + compacting（overflow）→ ↑ queue', () => {
    const chat = useChatStore()
    chat.setOccupancy('s4b', { turn: 'settling', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's4b' })
    expectSendButtonState(wrapper, 'queue')
  })

  it('行 5：turn=idle + compacting → ↑ queue（时钟角标）', () => {
    const chat = useChatStore()
    chat.setOccupancy('s5', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's5' })
    expectSendButtonState(wrapper, 'queue')
  })

  it('行 6：bash=true 且 turn=idle → ↑ queue', () => {
    const chat = useChatStore()
    chat.setOccupancy('s6', { turn: 'idle', compacting: false, bash: true })
    const wrapper = mountComposer({ sessionId: 's6' })
    expectSendButtonState(wrapper, 'queue')
  })
})

describe('queue 态角标 / title / aria 语义', () => {
  it('queue 态：title=「排队发送 · ⏎」，Clock 角标 aria-hidden', async () => {
    const chat = useChatStore()
    chat.setOccupancy('q1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 'q1' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'hello')
    await wrapper.vm.$nextTick()
    const btn = wrapper.find('.queue-send-btn')
    expect(btn.attributes('title')).toBe('排队发送 · ⏎')
    // 时钟角标：lucide Clock svg，装饰性 → aria-hidden
    const clock = btn.find('svg.lucide-clock')
    expect(clock.exists()).toBe(true)
    expect(clock.attributes('aria-hidden')).toBe('true')
  })

  it('queue 态无输入：disabled + title=sendHint（守卫语义与 send 态一致）', () => {
    const chat = useChatStore()
    chat.setOccupancy('q2', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 'q2' })
    const btn = wrapper.find('.queue-send-btn')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toBe('输入内容后发送')
  })

  it('stop 态：title=「停止」，点击 → abort（abort 语义保持）', async () => {
    const chat = useChatStore()
    chat.setOccupancy('q3', { turn: 'generating', compacting: false, bash: false })
    const wrapper = mountComposer({ sessionId: 'q3' })
    const btn = wrapper.find('.stop-btn')
    expect(btn.attributes('title')).toBe('停止')
    await btn.trigger('click')
    expect(chatApiMock.abort).toHaveBeenCalled()
  })

  it('settling+compacting queue 态：title 同 queue 语义（角标随分档出现）', () => {
    const chat = useChatStore()
    chat.setOccupancy('q4', { turn: 'settling', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 'q4' })
    const btn = wrapper.find('.queue-send-btn')
    expect(btn.exists()).toBe(true)
    expect(btn.find('svg.lucide-clock').exists()).toBe(true)
  })
})

describe('ActivityStrip 与发送位同屏共存不互扰（u6a + u6b）', () => {
  it('compacting 期：活动条 compacting 行 + 发送位 queue 态同时渲染（同一 chat store 真值）', () => {
    const chat = useChatStore()
    chat.setOccupancy('co1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountStripAndComposer('co1')
    // 活动条：压缩行可见（G3 单一展示位）
    expect(wrapper.find('[data-testid="activity-strip-row-compacting"]').exists()).toBe(true)
    // 发送位：queue 态（与活动条独立渲染位，互不吞没）
    expectSendButtonState(wrapper, 'queue')
  })

  it('占用解除（全 idle）：活动条消失 + 发送位回归 send 态（两组件同步复位）', async () => {
    const chat = useChatStore()
    chat.setOccupancy('co2', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountStripAndComposer('co2')
    expect(wrapper.find('[data-testid="activity-strip"]').exists()).toBe(true)
    expectSendButtonState(wrapper, 'queue')

    chat.setOccupancy('co2', { turn: 'idle', compacting: false, bash: false })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="activity-strip"]').exists()).toBe(false)
    expectSendButtonState(wrapper, 'send')
  })

  it('turn 活跃（generating 无 compacting）：活动条不渲染 streaming 行 + 发送位 stop（分工正确）', () => {
    const chat = useChatStore()
    chat.setOccupancy('co3', { turn: 'generating', compacting: false, bash: false })
    const wrapper = mountStripAndComposer('co3')
    // streaming 本体由 TurnMeta 承担，活动条无行（u6a 语义）
    expect(wrapper.find('[data-testid="activity-strip"]').exists()).toBe(false)
    expectSendButtonState(wrapper, 'stop')
  })
})

describe('CompactQueueBadge 零残留（C-proc-10 grep 断言）', () => {
  // 生产源码（src 下 .vue/.ts，排除 __tests__——本文件含标记字符串字面量属断言自身）。
  // cwd = packages/renderer（测试红线：vitest 从子包目录运行）。
  const SRC_ROOT = resolve(process.cwd(), 'src')

  function collectFiles(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      if (name === '__tests__' || name === 'node_modules') continue
      const full = resolve(dir, name)
      if (statSync(full).isDirectory()) out.push(...collectFiles(full))
      else if (/\.(vue|ts)$/.test(name)) out.push(full)
    }
    return out
  }

  it('组件名 / 专属 testid / 专属 i18n key 组在 renderer 生产源码零残留', () => {
    const FORBIDDEN = ['CompactQueueBadge', 'compact-queue-badge', 'compact-queue-cancel', 'panel.compactQueue']
    const offenders: string[] = []
    for (const file of collectFiles(SRC_ROOT)) {
      const content = readFileSync(file, 'utf8')
      for (const marker of FORBIDDEN) {
        if (content.includes(marker)) offenders.push(`${file} :: ${marker}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
