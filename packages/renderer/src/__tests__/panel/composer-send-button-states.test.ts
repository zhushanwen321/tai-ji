/**
 * Composer 发送位与统一发送分发器合并测试（单文件多源合并：2 个源文件同 SUT
 * （Composer.vue）、mock 骨架同构——queue 族 harness 单源）。
 *
 * 为什么单文件：vitest 按测试文件隔离模块图——单文件让全部用例共享一份 Composer 全树
 * 装载与环境初始化；拆文件会让每个文件各付一次装载，合并后只装一份。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动）：
 *  - composer-send-button-states.test.ts（发送位内容驱动双形态 D5）
 *  - composer-dispatch-route.test.ts（统一发送分发器 u3b/D1）
 *
 * mock 统一（原 send-button-states 手写 chatApiMock 单例与 dispatch-route 的
 * composerChatApiSpy 是同构形态——resolve 基线 + 同键集，合并后统一为 spy 单例，
 * 断言锚不分裂；send-button 节内以别名 const chatApiMock = composerChatApiSpy
 * 保持 it 体零改动）：
 *  - useChat / useNewTaskFlow / @/stores/session：composer-shell-mount 转注册
 *  - @/api（composerApiModuleWithChat：基础五组 + chat 组 spy 转发）/ useToast：
 *    composer-queue-mount 顶层注册
 * 未并入同簇的 ask-user-inline.test.ts：useExtensionUI/Panel overlay 域 mock 与
 * Composer 族 mock 组合行为未验证，保持独立（与 schedule-create-inline.test.ts
 * 同款形态，可后续归并）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-send-button-states.test.ts
 */
// helper import 必须先于项目内模块（@/api mock factory 在模块图加载期执行，TDZ 约束）；
// composer-queue-mount import 即注册 @/api / useToast（并转注册 shell-mount 三枚）
import { composerApiModule, composerChildStubs, makeComposerInputMock } from '../helpers/composer-mount'
import { composerChatApiSpy, setupComposerQueueHarness } from '../helpers/composer-queue-mount'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { textToSegments } from '@taiji/shared'
import Composer from '@/components/panel/Composer.vue'
import ActivityStrip from '@/components/panel/message-stream/ActivityStrip.vue'
import { useChatStore } from '@/stores/chat'

// ══════════ 来源：composer-send-button-states.test.ts ══════════
{
  // 原文件手写 chatApiMock 单例——统一 spy 后的别名（it 体引用名零改动）
  const chatApiMock = composerChatApiSpy

  // ── ComposerInput mock + 兄弟子 stubs：helper 单源基型 ──
  const { lastInputText, ComposerInputMock } = makeComposerInputMock()
  const otherStubs = {
    ComposerInput: ComposerInputMock,
    ...composerChildStubs,
  }

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
}

// ══════════ 来源：composer-dispatch-route.test.ts ══════════
{
  const { ComposerInputMock, otherStubs } = setupComposerQueueHarness()

  function mountComposer(): ReturnType<typeof mount> {
    return mount(Composer, { props: { sessionId: 's1' }, global: { stubs: otherStubs } })
  }

  async function pressKey(wrapper: ReturnType<typeof mountComposer>, init: KeyboardEventInit): Promise<void> {
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter', ...init }))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick() // onSend 是 async，需 flush
  }

  /** 驱动 occupancy 派生视图（sessionPhase 数据源） */
  function setPhase(turn: 'idle' | 'dispatching' | 'generating' | 'settling', compacting = false, bash = false): void {
    useChatStore().setOccupancy('s1', { turn, compacting, bash })
  }

  /** 制造本地 busy 视图（streaming 实体 → isActive=true）。真实时序下 turn 活跃（occupancy
   *  generating）必然伴随本地 turn 实体（turn 由本 renderer 的 send 发起）——行 2/3 用例
   *  须同步驱动本地视图，镜像真实派生视图时序。 */
  function seedLocalBusy(sid = 's1'): void {
    useChatStore().applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
  }

  describe('Composer 统一发送分发器（占用形态全部收敛 deps.send，u3b/D1）', () => {
    it('行 3：generating + compacting（threshold）⏎ → 统一提交（不本地转 steer）', async () => {
      setPhase('generating', true)
      seedLocalBusy()
      const wrapper = mountComposer()
      wrapper.findComponent(ComposerInputMock).vm.$emit('input', '补充：别忘了加测试')
      await wrapper.vm.$nextTick()

      await pressKey(wrapper, {})

      // [D1] 占用期照常提交（内核判 lane），renderer 不再本地转 steer
      expect(composerChatApiSpy.send).toHaveBeenCalledTimes(1)
      expect(composerChatApiSpy.send).toHaveBeenCalledWith('s1', textToSegments('补充：别忘了加测试'))
      // 输入已清空（提交语义完成）
      expect(wrapper.findComponent(ComposerInputMock).vm.clear).toHaveBeenCalled()
    })

    it('行 2：dispatching ⏎ → 统一提交（turn 活跃不再本地转 steer）', async () => {
      setPhase('dispatching')
      seedLocalBusy()
      const wrapper = mountComposer()
      wrapper.findComponent(ComposerInputMock).vm.$emit('input', '追加')
      await wrapper.vm.$nextTick()

      await pressKey(wrapper, {})

      expect(composerChatApiSpy.send).toHaveBeenCalledTimes(1)
    })

    it('行 4：settling ⏎ → 统一提交（不再本地 defer 入队，内核 queued 承接）', async () => {
      setPhase('settling')
      const wrapper = mountComposer()
      wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'settling 中发送')
      await wrapper.vm.$nextTick()

      await pressKey(wrapper, {})

      expect(composerChatApiSpy.send).toHaveBeenCalledWith('s1', textToSegments('settling 中发送'))
      expect(wrapper.findComponent(ComposerInputMock).vm.clear).toHaveBeenCalled()
    })

    it('行 6：bash=true 且 turn=idle ⏎ → 统一提交（占用期无特殊路径）', async () => {
      setPhase('idle', false, true)
      const wrapper = mountComposer()
      wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'bash 忙时发送')
      await wrapper.vm.$nextTick()

      await pressKey(wrapper, {})

      expect(composerChatApiSpy.send).toHaveBeenCalledWith('s1', textToSegments('bash 忙时发送'))
      expect(wrapper.findComponent(ComposerInputMock).vm.clear).toHaveBeenCalled()
    })

    it('行 1：全 idle ⏎ → 统一提交（与占用期同路径）', async () => {
      setPhase('idle')
      const wrapper = mountComposer()
      wrapper.findComponent(ComposerInputMock).vm.$emit('input', '普通消息')
      await wrapper.vm.$nextTick()

      await pressKey(wrapper, {})

      expect(composerChatApiSpy.send).toHaveBeenCalledTimes(1)
      // useChat mock 的 send 签名 = (sid, segments)（底层 RPC 的 clientUuid 透传在 core 编排内）
      expect(composerChatApiSpy.send).toHaveBeenCalledWith('s1', textToSegments('普通消息'))
    })

    it('Alt+⏎ 回合进行中（generating）→ followUp（下一轮语义保留，非 steer）', async () => {
      setPhase('generating')
      seedLocalBusy()
      const wrapper = mountComposer()
      wrapper.findComponent(ComposerInputMock).vm.$emit('input', '下一轮再说')
      await wrapper.vm.$nextTick()

      await pressKey(wrapper, { altKey: true })

      expect(composerChatApiSpy.followUp).toHaveBeenCalledTimes(1)
      expect(composerChatApiSpy.send).not.toHaveBeenCalled()
    })

    it('Alt+⏎ 回合进行中（settling，D1 判定集合成员）→ followUp（收尾期排队语义）', async () => {
      // [chat-flow-consistency D5] 六行预测表退役后 Alt 分流读 ACTIVE_TURN_PHASES——settling
      // 从「queued → onSend」变「集合成员 → followUp」，是 settling 纳入判定集合的设计语义
      setPhase('settling')
      const wrapper = mountComposer()
      wrapper.findComponent(ComposerInputMock).vm.$emit('input', '收尾期下一轮')
      await wrapper.vm.$nextTick()

      await pressKey(wrapper, { altKey: true })

      expect(composerChatApiSpy.followUp).toHaveBeenCalledTimes(1)
      expect(composerChatApiSpy.send).not.toHaveBeenCalled()
    })

    it('Alt+⏎ 非集合成员（compacting）→ 统一提交（压缩期 Alt 排队走分发器，非 followUp）', async () => {
      setPhase('idle', true)
      const wrapper = mountComposer()
      wrapper.findComponent(ComposerInputMock).vm.$emit('input', '压缩后发')
      await wrapper.vm.$nextTick()

      await pressKey(wrapper, { altKey: true })

      expect(composerChatApiSpy.followUp).not.toHaveBeenCalled()
      expect(composerChatApiSpy.send).toHaveBeenCalledWith('s1', textToSegments('压缩后发'))
    })

    it('回合进行中 + 空输入 ⏎ → 不提交（分发器空输入检查）', async () => {
      setPhase('generating')
      seedLocalBusy()
      const wrapper = mountComposer()
      await pressKey(wrapper, {})

      expect(composerChatApiSpy.send).not.toHaveBeenCalled()
    })
  })
}
