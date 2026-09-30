/**
 * Composer defer 队列 UI 集成测试（compact-queued-messages W2 → session-occupancy u4b/u6b）。
 *
 * 验证（入队行为 + 发送位 queue 态；队列可见性由 composer 上方 QueueBubble 的 defer 行承接——独立 badge
 * 组件已随 u6b/D7 展示统一移除，撤销/预览 UI 由 __tests__/panel/queue-bubble-s8.test.ts 的 defer 行分支覆盖）：
 * - TC11: compact 期间 ⏎ 发送 → 入队 + 输入清空 + 发送位 queue 态（时钟角标按钮）
 * - TC12: compact 期间发送按钮点击 → 入队（按钮可点非 spinner，title=「排队发送 · ⏎」）
 * - TC13: compact 期间 `/` 前缀文本 → 拒绝入队 + toast + draft 保留
 * - TC13b: compact 期间 `!`/`!!` 前缀 bash 命令 → 拒绝入队 + toast + draft 保留（对称于 `/`）
 * - TC15: compacted 成功（flush 清空）→ 提交确认驱动出队
 * - TC16: compacted 失败（队列保留）→ 队列不清
 * - TC17: compact 态无输入 → 发送按钮 disabled + title=sendHint + 点击不入队
 * - TC18: compact 期间 Alt+⏎ → 入队而非 followUp
 * （原 TC14 badge 条数/预览/逐条取消为 badge 专属 UI，随组件移除；× 撤销在
 *   queue-bubble-s8.test.ts 的 defer 行分支覆盖）
 *
 * 策略（对齐 composer-bash-mode.test.ts 结构范本）：
 * - 真 pinia + 真 chatStore（[u5b] isCompacting 由 occupancy 投影派生——驱动方式 =
 *   chat.setOccupancy(sid, { turn:'idle', compacting:true, bash:false })，D6 defer 路由同源）
 * - mock useChat / api（chat 组）/ useToast / ComposerInput + 壳 stub + 逐用例重置
 *   统一经 composer-queue-mount.ts 装配（断言引用 composerChatApiSpy / toastSpyMock）
 * - stub 子组件；queue 单例隔离在 harness beforeEach（W1 契约：scope 内首建 + 逐用例清零）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-compact-queue.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
// harness import 先于 useCompactQueue：其链上 import '@/api' 触发 api mock 工厂执行
// （该注册在 composer-queue-mount 顶层），helper 绑定彼时须已初始化
import { composerChatApiSpy, setupComposerQueueHarness, toastSpyMock } from '../helpers/composer-queue-mount'
import { makeTypeAndEnter } from '../helpers/composer-mount'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'
import { useChatStore } from '@/stores/chat'

const { ComposerInputMock, otherStubs } = setupComposerQueueHarness()
const typeAndEnter = makeTypeAndEnter(ComposerInputMock)

import Composer from '@/components/panel/Composer.vue'

function mountComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }) {
  return mount(Composer, { props, global: { stubs: otherStubs } })
}

/** TC13/TC13b 共用断言尾：拒绝 toast 文案（zh-CN commandQueuedRejected，R3-doc1 泛化：
 *  占用维度中性措辞）+ draft 保留（clear 未被调）。 */
function expectQueueRejectToastAndDraftKept(wrapper: ReturnType<typeof mountComposer>): void {
  expect(toastSpyMock.error).toHaveBeenCalledWith('会话占用中，命令请等待完成后使用')
  expect(wrapper.findComponent(ComposerInputMock).vm.clear).not.toHaveBeenCalled()
}

describe('Composer compact 待发队列（TC11-TC18）', () => {
  it('TC11: compact 期间 ⏎ 发送 → 入队 + 输入清空 + 发送位 queue 态', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's1' })
    await typeAndEnter(wrapper, 'hello')

    // 入队 'hello'（peek 含该文本）
    expect(useCompactQueue().peek('s1').map((m) => m.text)).toContain('hello')
    // 输入已清空（clearInput → ComposerInput.clear）
    expect(wrapper.findComponent(ComposerInputMock).vm.clear).toHaveBeenCalled()
    // DOM：发送位为 queue 态（时钟角标按钮）
    expect(wrapper.find('.queue-send-btn').exists()).toBe(true)
    // 未走真实发送（send 未被调）
    expect(composerChatApiSpy.send).not.toHaveBeenCalled()
  })

  it('TC12: compact 期间发送按钮点击 → 入队（按钮可点非 spinner，title=排队发送 · ⏎）', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's1' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'world')
    await wrapper.vm.$nextTick()

    // 发送位在 compact 态是可点击 queue 按钮（title=queueSend「排队发送 · ⏎」），非 disabled
    const sendBtn = wrapper.find('.queue-send-btn')
    expect(sendBtn.exists()).toBe(true)
    expect(sendBtn.attributes('title')).toBe('排队发送 · ⏎')
    expect(sendBtn.attributes('disabled')).toBeUndefined()

    await sendBtn.trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // 入队 'world'
    expect(useCompactQueue().peek('s1').map((m) => m.text)).toContain('world')
  })

  it('TC13: compact 期间 `/` 前缀文本 → 拒绝入队 + toast + draft 保留', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's1' })
    await typeAndEnter(wrapper, '/compact')

    // 队列为空（enqueue 未被调）+ compact RPC 未被调
    expect(useCompactQueue().count('s1')).toBe(0)
    expect(composerChatApiSpy.compact).not.toHaveBeenCalled()
    expectQueueRejectToastAndDraftKept(wrapper)
  })

  it('TC13b: compact 期间 `!` 前缀 bash 命令 → 拒绝入队 + toast + draft 保留', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's1' })
    await typeAndEnter(wrapper, '!ls')

    // 队列为空（enqueue 未被调）+ sendBash 未被调（未静默降级为纯文本，也未执行 bash）
    expect(useCompactQueue().count('s1')).toBe(0)
    expect(composerChatApiSpy.sendBash).not.toHaveBeenCalled()
    expectQueueRejectToastAndDraftKept(wrapper)
  })

  it('TC15: compacted 成功 → flush 提交（确认帧驱动出队）', async () => {
    const chat = useChatStore()
    const queue = useCompactQueue()
    const wrapper = mountComposer({ sessionId: 's1' })
    queue.enqueue('s1', 'm1')
    await wrapper.vm.$nextTick()

    // compacted 成功链路：flush 提交成功（send mock resolve）——[u4b] 提交 ≠ 出队（E2 退役），
    // 条目等确认帧；压缩态结束（[u5b] occupancy compacting=false 驱动）
    await expect(queue.flush('s1')).resolves.toBe(true)
    chat.setOccupancy('s1', { turn: 'idle', compacting: false, bash: false })
    await wrapper.vm.$nextTick()

    expect(queue.count('s1')).toBe(1)

    // 投递确认帧（core ① → confirmDelivery 出队）→ 队列清空
    chat.applyMessageEvent('s1', { type: 'message.message_end', payload: { sessionId: 's1', entry: {
      type: 'message', id: `e-${crypto.randomUUID()}`, parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'm1' }], timestamp: Date.now() },
    } } })
    await wrapper.vm.$nextTick()

    expect(queue.count('s1')).toBe(0)
  })

  it('TC16: compacted 失败（队列保留）→ 队列不清', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const queue = useCompactQueue()
    const wrapper = mountComposer({ sessionId: 's1' })
    queue.enqueue('s1', 'm1')
    await wrapper.vm.$nextTick()
    expect(queue.count('s1')).toBe(1)

    // compacted 失败：压缩态结束但队列未 flush（保留待下次重试；[u5b] 本用例直接驱动
    // store 投影不经 useChat handler，occupancy idle 的 flush 触发在 handler 集成测试覆盖）
    chat.setOccupancy('s1', { turn: 'idle', compacting: false, bash: false })
    await wrapper.vm.$nextTick()

    expect(queue.count('s1')).toBe(1)
  })

  it('TC17: compact 态无输入 → 发送按钮 disabled + title=sendHint + 点击不入队', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's1' })
    await wrapper.vm.$nextTick()

    // 无输入时 canSend=false：发送位为 disabled Button，title 为 sendHint「输入内容后发送」
    // （TC12 覆盖有输入可点击态 title=queueSend，本用例是负分支）
    const sendBtn = wrapper.find('[title="输入内容后发送"]')
    expect(sendBtn.exists()).toBe(true)
    expect(sendBtn.attributes('disabled')).toBeDefined()

    // 点击不入队（onSend 入口 !canSend 守卫拦截）：count 0
    await sendBtn.trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(useCompactQueue().count('s1')).toBe(0)
  })

  it('TC18: compact 期间 Alt+⏎ → 入队而非 followUp', async () => {
    const chat = useChatStore()
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer({ sessionId: 's1' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'alt-msg')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter', altKey: true }))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // followUp 未被调（重路由到 onSend → 入队）
    expect(composerChatApiSpy.followUp).not.toHaveBeenCalled()
    expect(useCompactQueue().peek('s1').map((m) => m.text)).toContain('alt-msg')
  })
})
