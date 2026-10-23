/**
 * Composer 发送位内容驱动双形态测试（chat-flow-consistency D5，2026-10-23 用户裁决：
 * 有内容才是发送按钮；无内容按占用叠加停止）。
 *
 * 发送位模板优先级链（spinner 最高）：spinner（isSending 提交在途）→ staging（交接横幅）→
 * stop（sendButtonState='stop'：无内容 + 回合进行中/收尾/压缩中，title 两档分型）→
 * send ± 时钟角标（sendButtonBadge：有内容 ∧ 回合进行中/压缩中；bash 不参与；空闲无角标）。
 * **spinner 优先级反转**（表 D isSending 档说明）：现状模板链 spinner 排在 stop/queue 之后
 * （isSending × stop/queue 占用时 spinner 不渲染），目标链 spinner 提到最高——isSending ×
 * 停止/排队占用交叉形态新旧相反，本文件含该反转断言。
 *
 * 枚举对照物 = send-button-matrix.md 表 D（D1 有内容 × 16 格角标 / D2 无内容 × 16 格
 * 停止两档与禁用占位 / D5-4 本地乐观窗）：
 * - 角标判定 = turn ∈ ACTIVE_TURN_PHASES（shared isActiveTurnPhase）∨ compacting；
 *   bash 不参与（D5 采用 3——bash 占用期消息仍直发）；空闲无角标。
 * - 无内容 + 回合进行中/收尾 → stop（title=停止）；无内容 + 仅压缩 → stop（title=终止压缩，
 *   runtime compaction-cancel 门；压缩与干活并存按回合中止优先）；无内容 + 空闲 → 禁用态
 *   发送占位（title=输入内容后发送）；无内容 + bash → 禁用占位（bash 取消入口在其输出块自身）。
 * - 乐观窗（D5-4）：activeView（isGenerating ∨ pendingSend）投影化为 dispatching——无内容
 *   → 停止，有内容 → 角标（先于权威 occupancy 消息）。
 * - 压缩期有内容 → 发送按钮（D5 行为变更点：现状该格是 stop）——点击 = 统一提交（内核排队）。
 *
 * 覆盖（三视角，用户可见 DOM 断言优先）：
 * - D1 16 格参数化（发送按钮 + 角标有无）+ D2 16 格参数化（停止两档 title / 禁用占位）
 * - spinner 反转断言（isSending × generating 占用：spinner 在场、stop 不在场）
 * - 停止按钮点击 → abort（abort 语义保持，压缩 title 分型点击同为 abort）
 * - ActivityStrip（u6a）与发送位同屏共存不互扰（同 wrapper 双组件 + 同一 chat store 真值）
 * - CompactQueueBadge / 专属 i18n key / testid 零残留（源码 grep 断言，C-proc-10）
 *
 * 策略（对齐 composer-three-states.test.ts 结构范本）：真 pinia + 真 chat store
 * （chat.setOccupancy 驱动 occupancy 派生视图）；mock useChat / useNewTaskFlow /
 * api / session store；ComposerInput mock。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-send-button-states.test.ts
 */
// helper import 必须先于项目内模块（@/api mock factory 在模块图加载期执行，TDZ 约束）
import { composerApiModule, composerChildStubs, composerFlowModule, composerSessionStoreModule, makeComposerInputMock } from '../helpers/composer-mount'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

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

/** 驱动 occupancy 派生视图（发送位形态/角标数据源） */
function setOccupancy(sid: string, turn: 'idle' | 'dispatching' | 'generating' | 'settling', compacting = false, bash = false): void {
  useChatStore().setOccupancy(sid, { turn, compacting, bash })
}

async function typeInput(wrapper: VueWrapper, text: string): Promise<void> {
  wrapper.findComponent(ComposerInputMock).vm.$emit('input', text)
  await wrapper.vm.$nextTick()
}

/** 发送位形态断言辅助：stop / send 双态互斥 DOM 判定（D5 双形态，queue 态已退役） */
function expectSendButtonState(wrapper: VueWrapper, expected: 'stop' | 'send'): void {
  const stop = wrapper.find('.stop-btn')
  const send = wrapper.find('[data-testid="composer-send-btn"]')
  if (expected === 'stop') {
    expect(stop.exists()).toBe(true)
    expect(send.exists()).toBe(false)
  } else {
    expect(stop.exists()).toBe(false)
    expect(send.exists()).toBe(true)
  }
}

/** 发送按钮排队角标断言（Clock svg，aria-hidden） */
function expectQueueBadge(wrapper: VueWrapper, present: boolean): void {
  const send = wrapper.find('[data-testid="composer-send-btn"]')
  expect(send.exists()).toBe(true)
  const clock = send.find('svg.lucide-clock')
  expect(clock.exists()).toBe(present)
  if (present) expect(clock.attributes('aria-hidden')).toBe('true')
}

const TURN_VALUES = ['idle', 'dispatching', 'generating', 'settling'] as const

/** 角标判定（表 D1）：回合进行中（ACTIVE_TURN_PHASES）∨ compacting；bash 不参与；空闲无角标 */
function badgeExpected(turn: (typeof TURN_VALUES)[number], compacting: boolean): boolean {
  return turn !== 'idle' || compacting
}

describe('D5 表 D1：有内容 × 16 格（发送按钮，差异在角标）', () => {
  for (const turn of TURN_VALUES) {
    for (const compacting of [false, true]) {
      for (const bash of [false, true]) {
        const sid = `d1-${turn}-${compacting}-${bash}`
        it(`${sid}：发送按钮可点 + 角标${badgeExpected(turn, compacting) ? '有' : '无'}`, async () => {
          setOccupancy(sid, turn, compacting, bash)
          const wrapper = mountComposer({ sessionId: sid })
          await typeInput(wrapper, 'hello')
          expectSendButtonState(wrapper, 'send')
          // 有内容任何占用组合点击 = 发送成功（D5：有内容恒发送，禁用不出现）
          expect(wrapper.find('[data-testid="composer-send-btn"]').attributes('disabled')).toBeUndefined()
          expectQueueBadge(wrapper, badgeExpected(turn, compacting))
          // bash 不参与角标（D5 采用 3）：bash 维度格的角标与同 turn 无 bash 格一致
          if (badgeExpected(turn, compacting)) {
            expect(wrapper.find('[data-testid="composer-send-btn"]').attributes('title')).toBe('排队发送 · ⏎')
          }
        })
      }
    }
  }

  it('D1 空闲无角标格：title=「发送 · ⏎」（bash 格同——bash 不改角标也不改 title 分型）', async () => {
    setOccupancy('d1-idle-plain', 'idle', false, false)
    const wrapper = mountComposer({ sessionId: 'd1-idle-plain' })
    await typeInput(wrapper, 'hello')
    expect(wrapper.find('[data-testid="composer-send-btn"]').attributes('title')).toBe('发送 · ⏎')
  })
})

describe('D5 表 D2：无内容 × 16 格（停止两档 / 禁用占位）', () => {
  /** 无内容格形态（表 D2）：回合进行中/收尾 → 停止（title=停止）；仅压缩（idle/settling+compacting）→ 停止压缩档（title=终止压缩）；空闲（含 bash）→ 禁用发送占位 */
  function expectEmptyCell(wrapper: VueWrapper, turn: (typeof TURN_VALUES)[number], compacting: boolean): void {
    if (turn !== 'idle' || compacting) {
      expectSendButtonState(wrapper, 'stop')
      // title 分型（D5 采用 2 现状规则保留）：dispatching/generating（含并存压缩）与 settling
      // 单独 → 回合中止；idle/settling + compacting（无生成中 turn）→ 终止压缩
      const compactOnly = compacting && (turn === 'idle' || turn === 'settling')
      expect(wrapper.find('.stop-btn').attributes('title')).toBe(compactOnly ? '终止压缩' : '停止')
    } else {
      // 空闲（无压缩）：禁用态发送占位（bash 格同——取消入口在其输出块自身，D5 采用 2）
      expectSendButtonState(wrapper, 'send')
      const send = wrapper.find('[data-testid="composer-send-btn"]')
      expect(send.attributes('disabled')).toBeDefined()
      expect(send.attributes('title')).toBe('输入内容后发送')
    }
  }

  for (const turn of TURN_VALUES) {
    for (const compacting of [false, true]) {
      for (const bash of [false, true]) {
        const sid = `d2-${turn}-${compacting}-${bash}`
        it(`${sid}：${turn !== 'idle' || compacting ? '停止' : '禁用占位'}`, async () => {
          setOccupancy(sid, turn, compacting, bash)
          const wrapper = mountComposer({ sessionId: sid })
          expectEmptyCell(wrapper, turn, compacting)
        })
      }
    }
  }
})

describe('D5 spinner 优先级反转（表 D isSending 档：提交后回执未返回压过一切形态）', () => {
  /** 受控 send mock：isSending 挂起窗内断言 DOM（send 返回手动 resolve 的 Promise） */
  let releaseSend: () => void = () => {}
  function holdSend(): void {
    chatApiMock.send.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseSend = resolve }),
    )
  }

  it('isSending × 回合占用（generating）：spinner 在场，stop 不渲染（现状模板链该格是 stop——反转断言）', async () => {
    setOccupancy('sp1', 'generating', false, false)
    holdSend()
    const wrapper = mountComposer({ sessionId: 'sp1' })
    await typeInput(wrapper, '提交后回执未返回')
    await wrapper.find('[data-testid="composer-send-btn"]').trigger('click')
    await wrapper.vm.$nextTick()

    // 反转点：现状 stop 分支先于 spinner（spinner 不渲染）；目标链 spinner 最高
    expect(wrapper.find('.stop-btn').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-send-btn"]').exists()).toBe(false)
    expect(wrapper.find('.animate-loader-spin').exists()).toBe(true)
    expect(wrapper.find('.animate-loader-spin').attributes('aria-hidden')).toBe('true')

    releaseSend()
    await wrapper.vm.$nextTick()
  })

  it('isSending × 排队去向占用（compacting）：同样 spinner（提交在途压过压缩期停止形态）', async () => {
    setOccupancy('sp2', 'idle', true, false)
    holdSend()
    const wrapper = mountComposer({ sessionId: 'sp2' })
    await typeInput(wrapper, '压缩期提交')
    await wrapper.find('[data-testid="composer-send-btn"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.stop-btn').exists()).toBe(false)
    expect(wrapper.find('.animate-loader-spin').exists()).toBe(true)

    releaseSend()
    await wrapper.vm.$nextTick()
  })

  it('send 回执返回（isSending 复位）→ 形态回归内容驱动双形态（无内容 + 压缩 → stop）', async () => {
    setOccupancy('sp3', 'idle', true, false)
    holdSend()
    const wrapper = mountComposer({ sessionId: 'sp3' })
    await typeInput(wrapper, '回执后回归')
    await wrapper.find('[data-testid="composer-send-btn"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.animate-loader-spin').exists()).toBe(true)

    releaseSend()
    // onSend 的 await 恢复链（send resolve → clear → finally 复位 isSending）是多层微任务，
    // flushPromises 排空后再判 DOM
    await flushPromises()
    await wrapper.vm.$nextTick()
    // 提交成功清空输入（clear emitInput('') → hasInput=false）+ 压缩中 → stop
    expect(wrapper.find('.animate-loader-spin').exists()).toBe(false)
    expectSendButtonState(wrapper, 'stop')
  })
})

describe('D5 表 D5-4：本地乐观窗（activeView 投影 dispatching，先于权威 occupancy）', () => {
  it('无内容 + 本地 streaming 实体（occupancy 未到）→ stop（防死键回退的乐观升级保留）', () => {
    const chat = useChatStore()
    chat.applyMessageEvent('opt1', {
      type: 'message.message_start',
      payload: { sessionId: 'opt1', messageId: 'a1' },
    })
    const wrapper = mountComposer({ sessionId: 'opt1' })
    expectSendButtonState(wrapper, 'stop')
    expect(wrapper.find('.stop-btn').attributes('title')).toBe('停止')
  })

  it('有内容 + 本地 pendingSend（occupancy turn=idle）→ 发送按钮 + 角标', async () => {
    const chat = useChatStore()
    chat.addPendingSend('opt2')
    const wrapper = mountComposer({ sessionId: 'opt2' })
    await typeInput(wrapper, '乐观窗排队')
    expectSendButtonState(wrapper, 'send')
    expectQueueBadge(wrapper, true)
  })
})

describe('停止/发送按钮点击行为（abort 语义保持 + 压缩期有内容恒发送行为变更点）', () => {
  it('压缩期无输入：stop 可点（canSubmit 不拦停止），点击 → abort', async () => {
    setOccupancy('q2', 'idle', true, false)
    const wrapper = mountComposer({ sessionId: 'q2' })
    const btn = wrapper.find('.stop-btn')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    expect(chatApiMock.abort).toHaveBeenCalled()
  })

  it('stop 态（执行中无 compacting）：title=「停止」，点击 → abort（abort 语义保持）', async () => {
    setOccupancy('q3', 'generating', false, false)
    const wrapper = mountComposer({ sessionId: 'q3' })
    const btn = wrapper.find('.stop-btn')
    expect(btn.attributes('title')).toBe('停止')
    await btn.trigger('click')
    expect(chatApiMock.abort).toHaveBeenCalled()
  })

  it('settling+compacting stop 态：title=「终止压缩」', () => {
    setOccupancy('q4', 'settling', true, false)
    const wrapper = mountComposer({ sessionId: 'q4' })
    const btn = wrapper.find('.stop-btn')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toBe('终止压缩')
  })

  it('压缩期有内容（D5 行为变更点）：发送按钮 + 角标，点击 → 统一提交（内核排队），不 abort', async () => {
    setOccupancy('q5', 'idle', true, false)
    const wrapper = mountComposer({ sessionId: 'q5' })
    await typeInput(wrapper, '压缩期也要能发')
    expectSendButtonState(wrapper, 'send')
    expectQueueBadge(wrapper, true)
    await wrapper.find('[data-testid="composer-send-btn"]').trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(chatApiMock.send).toHaveBeenCalled()
    expect(chatApiMock.abort).not.toHaveBeenCalled()
  })
})

describe('ActivityStrip 与发送位同屏共存不互扰（u6a + D5）', () => {
  it('compacting 期：活动条 compacting 行 + 发送位 stop 态（title=终止压缩）同时渲染（同一 chat store 真值）', () => {
    setOccupancy('co1', 'idle', true, false)
    const wrapper = mountStripAndComposer('co1')
    // 活动条：压缩行可见（G3 单一展示位）
    expect(wrapper.find('[data-testid="activity-strip-row-compacting"]').exists()).toBe(true)
    // 发送位：stop 态（中止入口在按钮位，与活动条独立渲染位，互不吞没）
    expectSendButtonState(wrapper, 'stop')
    expect(wrapper.find('.stop-btn').attributes('title')).toBe('终止压缩')
  })

  it('占用解除（全 idle）：活动条消失 + 发送位回归禁用占位（两组件同步复位）', async () => {
    setOccupancy('co2', 'idle', true, false)
    const wrapper = mountStripAndComposer('co2')
    expect(wrapper.find('[data-testid="activity-strip"]').exists()).toBe(true)
    expectSendButtonState(wrapper, 'stop')

    setOccupancy('co2', 'idle', false, false)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="activity-strip"]').exists()).toBe(false)
    expectSendButtonState(wrapper, 'send')
    expect(wrapper.find('[data-testid="composer-send-btn"]').attributes('disabled')).toBeDefined()
  })

  it('turn 活跃（generating 无 compacting）：活动条不渲染 streaming 行 + 发送位 stop（分工正确）', () => {
    setOccupancy('co3', 'generating', false, false)
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
    const FORBIDDEN = ['CompactQueueBadge', 'compact-queue-badge', 'compact-queue-cancel', 'panel.compactQueue', 'queue-send-btn']
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
