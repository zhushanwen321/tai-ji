/**
 * Composer 发送位四态测试（session-occupancy u6b / D6 表「发送位」列）。
 *
 * 发送位按 sendButtonState（shell effectivePhase 派生）渲染。**按钮形态与 Enter 车道是两个
 * 问题**（2026-10 用户裁决）：按钮回答「现在能中止什么」（忙 → 终止钮；压缩期 → 中止压缩
 * 流程，title 分型：turn 非生成中=「终止压缩」（runtime 走压缩取消）、生成中压缩=「停止」
 * （abort 归回合中止）），Enter 回答「消息走哪条车道」（sendRoute，compacting →
 * queued 排队——断言见 composer-compact-queue.test.ts TC11）。
 * | 行 | sessionPhase                              | 发送位          |
 * |----|-------------------------------------------|-----------------|
 * | 1  | 全 idle                                    | ↑ send          |
 * | 2  | turn=dispatching/generating（无 compacting）| ■ stop          |
 * | 3  | turn=generating + compacting（threshold）   | ■ stop（title=停止：回合中止）|
 * | 4  | turn=settling                              | 单独→stop；+compacting→stop（终止压缩）|
 * | 5  | turn=idle + compacting（手动 /compact）     | ■ stop（中止压缩）|
 * | 6  | bash=true 且 turn=idle                     | ↑ queue          |
 *
 * 覆盖（三视角，用户可见 DOM 断言优先）：
 * - 六行逐一 DOM 断言（含 settling 分档两形态；压缩期三行 3/4b/5 一律 stop，title 分型：
 *   3=停止（生成中压缩 abort 归回合中止）、4b/5=终止压缩（runtime compaction-cancel））
 * - queue 态角标 title（「排队发送 · ⏎」）/ Clock aria-hidden（现由 bash 行承载）/ stop / send title
 * - 压缩期 stop 不随输入禁用（⏎ 仍走排队提交，按钮与输入正交）
 * - ActivityStrip（u6a）与发送位同屏共存不互扰（同 wrapper 双组件 + 同一 chat store 真值）
 * - CompactQueueBadge / 专属 i18n key / testid 零残留（源码 grep 断言，C-proc-10）
 *
 * 策略（对齐 composer-three-states.test.ts 结构范本）：真 pinia + 真 chat store
 * （chat.setOccupancy 驱动 occupancy 投影——D6 路由同源）；mock useChat / useNewTaskFlow /
 * api / session store；ComposerInput mock。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-send-button-states.test.ts
 */
// helper import 必须先于项目内模块（@/api mock factory 在模块图加载期执行，TDZ 约束）
import { composerApiModule, composerChildStubs, composerFlowModule, composerSessionStoreModule, makeComposerInputMock } from '../helpers/composer-mount'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { textToSegments } from '@taiji/shared'

// ── mock useChat（spy 化 send/abort）──
const chatApiMock = vi.hoisted(() => ({
  send: vi.fn(() => Promise.resolve()),
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
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => composerFlowModule())
vi.mock('@/api', () => ({
  ...composerApiModule(),
  chat: { send: chatApiMock.send, streamSubscribe: vi.fn(() => () => {}) },
}))
vi.mock('@/stores/session', () => composerSessionStoreModule())

// ── ComposerInput mock + 兄弟子 stubs：helper 单源基型 ──
const { lastInputText, ComposerInputMock } = makeComposerInputMock()
const otherStubs = {
  ComposerInput: ComposerInputMock,
  ...composerChildStubs,
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

  it('行 3：turn=generating + compacting（threshold turn 内压缩）→ ■ stop（title=停止：isGenerating=true，abort 归回合中止）', () => {
    // [compaction-input-unlock 演进 / 2026-10 用户裁决] 旧断言 queue（compacting hold 优先，
    // 修「按钮 stop 但 Enter 排队」漂移）——代价是压缩期 composer 失去全部中止能力（连阈值
    // 自动压缩的 stop 一并消失）。现按钮回答「现在能中止什么」：压缩期 = 中止压缩流程
    // （onStopClick → abort → pi session.abort → abortCompaction）；Enter 车道仍走 sendRoute
    // 的 queued 排队（compaction-end flush，断言见 composer-compact-queue.test.ts TC11）
    // ——按钮与 Enter 两问题分立，漂移根源（混谈）消除而非再次二选一。
    // [2026-10 审查修正] title 分型对齐 runtime compaction-cancel 门：本行 isGenerating=true，
    // abort 语义是回合中止（写 stopped 终态）而非压缩取消——title=「停止」，不再谎报「终止压缩」。
    const chat = useChatStore()
    chat.setOccupancy('s3', { turn: 'generating', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's3' })
    expectSendButtonState(wrapper, 'stop')
    expect(wrapper.find('.stop-btn').attributes('title')).toBe('停止')
  })

  it('行 4：turn=settling 单独 → ■ stop（收尾期可中止）', () => {
    const chat = useChatStore()
    chat.setOccupancy('s4', { turn: 'settling', compacting: false, bash: false })
    const wrapper = mountComposer({ sessionId: 's4' })
    expectSendButtonState(wrapper, 'stop')
  })

  it('行 4 分档：turn=settling + compacting（overflow）→ ■ stop（title=终止压缩）', () => {
    const chat = useChatStore()
    chat.setOccupancy('s4b', { turn: 'settling', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's4b' })
    expectSendButtonState(wrapper, 'stop')
    expect(wrapper.find('.stop-btn').attributes('title')).toBe('终止压缩')
  })

  it('行 5：turn=idle + compacting（手动 /compact）→ ■ stop（title=终止压缩）', () => {
    // 手动 /compact 全窗口可中止：旧行为此处也是 queue（idle+compacting），用户无任何
    // composer 内中止入口——本行是修复的主场景（终止压缩 ≠ 排队发送）。
    const chat = useChatStore()
    chat.setOccupancy('s5', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's5' })
    expectSendButtonState(wrapper, 'stop')
    expect(wrapper.find('.stop-btn').attributes('title')).toBe('终止压缩')
  })

  it('行 6：bash=true 且 turn=idle → ↑ queue', () => {
    const chat = useChatStore()
    chat.setOccupancy('s6', { turn: 'idle', compacting: false, bash: true })
    const wrapper = mountComposer({ sessionId: 's6' })
    expectSendButtonState(wrapper, 'queue')
  })
})

describe('queue 态角标 / title / aria 语义', () => {
  it('queue 态（bash 行承载）：title=「排队发送 · ⏎」，Clock 角标 aria-hidden', async () => {
    // queue 态现只覆盖 bash / settling+bash（压缩期是 stop）——时钟角标语义由 bash 行断言
    const chat = useChatStore()
    chat.setOccupancy('qb1', { turn: 'idle', compacting: false, bash: true })
    const wrapper = mountComposer({ sessionId: 'qb1' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'hello')
    await wrapper.vm.$nextTick()
    const btn = wrapper.find('.queue-send-btn')
    expect(btn.attributes('title')).toBe('排队发送 · ⏎')
    // 时钟角标：lucide Clock svg，装饰性 → aria-hidden
    const clock = btn.find('svg.lucide-clock')
    expect(clock.exists()).toBe(true)
    expect(clock.attributes('aria-hidden')).toBe('true')
  })

  it('压缩期 stop 态：title=「终止压缩」，有输入也不禁用（停止与输入正交），点击 → abort', async () => {
    const chat = useChatStore()
    chat.setOccupancy('q1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 'q1' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'hello')
    await wrapper.vm.$nextTick()
    const btn = wrapper.find('.stop-btn')
    expect(btn.attributes('title')).toBe('终止压缩')
    // 有输入不禁用：⏎ 仍走排队提交（内核 queued 车道），按钮与输入内容正交
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    expect(chatApiMock.abort).toHaveBeenCalled()
  })

  it('压缩期无输入：stop 仍可点（canSubmit 不拦停止），点击 → abort', async () => {
    const chat = useChatStore()
    chat.setOccupancy('q2', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 'q2' })
    const btn = wrapper.find('.stop-btn')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    expect(chatApiMock.abort).toHaveBeenCalled()
  })

  it('stop 态（执行中无 compacting）：title=「停止」，点击 → abort（abort 语义保持）', async () => {
    const chat = useChatStore()
    chat.setOccupancy('q3', { turn: 'generating', compacting: false, bash: false })
    const wrapper = mountComposer({ sessionId: 'q3' })
    const btn = wrapper.find('.stop-btn')
    expect(btn.attributes('title')).toBe('停止')
    await btn.trigger('click')
    expect(chatApiMock.abort).toHaveBeenCalled()
  })

  it('settling+compacting stop 态：title=「终止压缩」', () => {
    const chat = useChatStore()
    chat.setOccupancy('q4', { turn: 'settling', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 'q4' })
    const btn = wrapper.find('.stop-btn')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toBe('终止压缩')
  })
})

describe('ActivityStrip 与发送位同屏共存不互扰（u6a + u6b）', () => {
  it('compacting 期：活动条 compacting 行 + 发送位 stop 态（title=终止压缩）同时渲染（同一 chat store 真值）', () => {
    const chat = useChatStore()
    chat.setOccupancy('co1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountStripAndComposer('co1')
    // 活动条：压缩行可见（G3 单一展示位）
    expect(wrapper.find('[data-testid="activity-strip-row-compacting"]').exists()).toBe(true)
    // 发送位：stop 态（中止入口在按钮位，与活动条独立渲染位，互不吞没）
    expectSendButtonState(wrapper, 'stop')
    expect(wrapper.find('.stop-btn').attributes('title')).toBe('终止压缩')
  })

  it('占用解除（全 idle）：活动条消失 + 发送位回归 send 态（两组件同步复位）', async () => {
    const chat = useChatStore()
    chat.setOccupancy('co2', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountStripAndComposer('co2')
    expect(wrapper.find('[data-testid="activity-strip"]').exists()).toBe(true)
    expectSendButtonState(wrapper, 'stop')

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
