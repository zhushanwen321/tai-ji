// QueueStrip 队列可视化测试（remote-use D7 / impl-plan U10）。
//
// 背景：busy 期消息被 core morph 移出对话流（投递所有权内核 u3b），移动壳此前无队列
// 可视化——排队消息「消失」且触屏无撤销入口（设计 §2.3 A1）。D7 采用 = 投影数据源直连
// + 流尾内嵌轻量队列条；取消成功后全文回输入框草稿（不回填即静默丢输入，G5 同族）。
// 本测锁定三件事（验收条款逐条）：
//   ① 排队条目渲染：消费 core `deliveryQueueEntries` 谓词（U20 下沉唯一定义点）——
//     行集合/帧序/preview 与桌面 useQueueRows 同源（防壳内重写 lane 判定的第二定义点）
//   ② 点取消调 delivery.cancel（app-runtime 透传出口，内核收回-重投语义 runtime 单点）
//   ③ 取消成功后草稿回填：写入侧经 composerInjection 通道（core factory 单例）+ 消费端
//     MobileComposer insertTextAtCursor 落输入框——取消编排端到端闭合
//
// mock 策略（对齐 truncated-history.test.ts「仅 transport 出口 mock、全链真实」立场）：
// 仅 transport chat 域 cancelDelivery 出口模块级 vi.mock 隔离 WS；投影经 core 读口直写
// （帧消费链路由 core useChat handler 承担，本层只读投影——桌面 use-queue-rows.test.ts
// 同款立场）。消费端 DOM 断言：happy-dom 无 document.execCommand（insertTextAtCursor 的
// 写入原语），以 ComposerInput stub 的 expose spy 锁定「真消费链调用了哪个输入 API、携带
// 什么参数」——桌面 force-quit-draft-recovery-dom.test.ts 同款处置。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { getDeliveryProjectionRef, resetChatModuleStateForTest } from '@taiji/core'
import type { DeliveryFrameEntry } from '@taiji/core'
import QueueStrip from '../QueueStrip.vue'
import MobileComposer from '../MobileComposer.vue'
import { composerInjectionStore } from '../../shell/app-runtime'
import { i18n } from '../../i18n'

// vi.hoisted：mock 工厂被 hoist 到 import 前，工厂内引用的变量须经 vi.hoisted 创建
const { cancelDeliveryMock } = vi.hoisted(() => ({ cancelDeliveryMock: vi.fn() }))

vi.mock('@taiji/core/transport/api/domains/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/chat')>()
  return { ...actual, cancelDelivery: cancelDeliveryMock }
})

/** ComposerInput stub 的 expose spy（消费 API 断言面；仅「端到端回填」组消费） */
const inputCalls = { insertTextAtCursor: vi.fn() }

vi.mock('@taiji/ui/features/composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/ui/features/composer')>()
  return {
    ...actual,
    ComposerInput: defineComponent({
      name: 'ComposerInputStub',
      setup(_, { expose }) {
        expose({
          insertTextAtCursor: inputCalls.insertTextAtCursor,
          // 发送键路径的只读口（本测不触发送，给空实现防 undefined 调用）
          getText: () => '',
          getSegments: () => [],
        })
        return () => h('div', { role: 'textbox' })
      },
    }),
  }
})

const SID = 'sid-queue-strip'

function entry(
  clientUuid: string,
  state: DeliveryFrameEntry['state'],
  lane: DeliveryFrameEntry['lane'],
  preview = clientUuid,
): DeliveryFrameEntry {
  return { clientUuid, preview, state, lane }
}

/** 写 core 投影（state topic last-value 语义：每帧整体替换） */
function setProjection(sid: string, entries: DeliveryFrameEntry[]): void {
  const ref = getDeliveryProjectionRef()
  const next = new Map(ref.value)
  next.set(sid, entries)
  ref.value = next
}

function mountStrip(sessionId = SID) {
  return mount(QueueStrip, {
    props: { sessionId },
    global: { plugins: [i18n] },
  })
}

function rowsOf(wrapper: ReturnType<typeof mountStrip>) {
  return wrapper.findAll('[data-testid="mobile-queue-row"]')
}

function tOf(key: string, params?: Record<string, unknown>): string {
  return (i18n.global.t as (key: string, params?: Record<string, unknown>) => string)(key, params)
}

beforeEach(() => {
  resetChatModuleStateForTest()
  cancelDeliveryMock.mockReset()
  inputCalls.insertTextAtCursor.mockClear()
  composerInjectionStore.clearInjection()
})

// ── 验收①：排队条目渲染（消费 core 谓词非本地重写）─────────────────────────

describe('QueueStrip 条目渲染（D7 验收①：core 谓词单源）', () => {
  it('行集合 = core deliveryQueueEntries 谓词输出：非 direct 且未 delivered 三态可见、帧序保持、preview 直显', () => {
    setProjection(SID, [
      entry('d1', 'in-flight', 'direct', 'direct 气泡原位'), // direct 车道：乐观气泡原位保留 → 不进队列条
      entry('q1', 'queued', 'queued', '排队消息甲'),
      entry('f1', 'in-flight', 'steer', '投递中消息乙'),
      entry('x1', 'delivered', 'steer', '已入流消息'), // delivered：transcript 权威已入流 → 隐去
      entry('q2', 'failed', 'queued', '失败消息丙'),
    ])
    const wrapper = mountStrip()

    const rows = rowsOf(wrapper)
    expect(rows).toHaveLength(3)
    // 帧序 = 内核 FIFO 发送序（谓词只过滤不重排）
    expect(rows[0]!.text()).toContain('排队消息甲')
    expect(rows[1]!.text()).toContain('投递中消息乙')
    expect(rows[2]!.text()).toContain('失败消息丙')
    // 三态徽标可见（使用者视角：状态可区分）
    expect(wrapper.find('[data-testid="mobile-queue-state-queued"]').text()).toBe(
      tOf('mobile.queueStrip.stateQueued'),
    )
    expect(wrapper.find('[data-testid="mobile-queue-state-in-flight"]').text()).toBe(
      tOf('mobile.queueStrip.stateInFlight'),
    )
    expect(wrapper.find('[data-testid="mobile-queue-state-failed"]').text()).toBe(
      tOf('mobile.queueStrip.stateFailed'),
    )
    // direct / delivered 条目结构性不在渲染集（text 全域不含）
    expect(wrapper.text()).not.toContain('direct 气泡原位')
    expect(wrapper.text()).not.toContain('已入流消息')
    wrapper.unmount()
  })

  it('空投影 / 无分区 → 结构性不渲染（无占位空态，随投影帧出现/收敛即时翻转）', async () => {
    const wrapper = mountStrip()
    expect(wrapper.find('[data-testid="mobile-queue-strip"]').exists()).toBe(false)

    // 投影帧到达 → 条即时出现（响应式，非仅挂载期快照）
    setProjection(SID, [entry('q1', 'queued', 'queued', '排队消息')])
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-queue-strip"]').exists()).toBe(true)
    expect(rowsOf(wrapper)).toHaveLength(1)

    // 下一帧全量收敛（delivered → 队列区隐去）→ 条结构性消失
    setProjection(SID, [entry('q1', 'delivered', 'queued', '排队消息')])
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-queue-strip"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('跨会话分区隔离：只渲染 props.sessionId 的投影分区', () => {
    setProjection('sid-other', [entry('q0', 'queued', 'queued', '别的会话排队')])
    setProjection(SID, [entry('q1', 'queued', 'queued', '本会话排队')])
    const wrapper = mountStrip()

    const rows = rowsOf(wrapper)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('本会话排队')
    expect(wrapper.text()).not.toContain('别的会话排队')
    wrapper.unmount()
  })
})

// ── 验收②：点取消调 delivery.cancel ────────────────────────────────────────

describe('QueueStrip 取消（D7 验收②：delivery.cancel 出口）', () => {
  it('点取消钮 → delivery.cancel(sid, clientUuid)（app-runtime 透传出口命中 transport mock）', async () => {
    cancelDeliveryMock.mockResolvedValue({ clientUuid: 'q1', cancelled: true, content: '被撤销的文本' })
    setProjection(SID, [entry('q1', 'queued', 'queued', '排队消息')])
    const wrapper = mountStrip()

    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()

    expect(cancelDeliveryMock).toHaveBeenCalledTimes(1)
    expect(cancelDeliveryMock).toHaveBeenCalledWith(SID, 'q1')
    wrapper.unmount()
  })

  it('取消在途防重入：pending 期取消钮禁用，重复点击只走一次 RPC', async () => {
    let resolveRpc!: (v: { clientUuid: string; cancelled: boolean; content: string }) => void
    cancelDeliveryMock.mockImplementation(
      () => new Promise((resolve) => (resolveRpc = resolve)),
    )
    setProjection(SID, [entry('q1', 'queued', 'queued', '排队消息')])
    const wrapper = mountStrip()

    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    expect(
      rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').attributes('aria-disabled'),
    ).toBe('true')
    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    expect(cancelDeliveryMock).toHaveBeenCalledTimes(1)

    resolveRpc({ clientUuid: 'q1', cancelled: true, content: '被撤销的文本' })
    await flushPromises()
    expect(
      rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').attributes('aria-disabled'),
    ).toBe('false')
    wrapper.unmount()
  })

  it('不可撤（cancelled=false）→ 内联错误行可见（不静默），不写注入槽位', async () => {
    cancelDeliveryMock.mockResolvedValue({ clientUuid: 'q1', cancelled: false, reason: 'already delivered' })
    setProjection(SID, [entry('q1', 'queued', 'queued', '排队消息')])
    const wrapper = mountStrip()

    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()

    const errLine = wrapper.find('[data-testid="mobile-queue-strip-error"]')
    expect(errLine.exists()).toBe(true)
    expect(errLine.attributes('role')).toBe('alert')
    expect(errLine.text()).toBe(
      tOf('mobile.queueStrip.cancelUnavailableWithReason', { reason: 'already delivered' }),
    )
    expect(composerInjectionStore.pendingInjection.value).toBeNull()
    wrapper.unmount()
  })
})

// ── 验收③：取消成功后草稿回填 ─────────────────────────────────────────────

describe('QueueStrip 草稿回填（D7 验收③：全文回输入框）', () => {
  it('取消成功 → 注入槽位收到 { target:current, sessionId, text=全文 }（消费端通道写入侧）', async () => {
    const segments = [{ type: 'text' as const, text: '被撤销的文本' }]
    cancelDeliveryMock.mockResolvedValue({ clientUuid: 'q1', cancelled: true, content: '被撤销的文本', segments })
    setProjection(SID, [entry('q1', 'queued', 'queued', '排队消息')])
    const wrapper = mountStrip()

    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()

    const pending = composerInjectionStore.pendingInjection.value
    expect(pending).not.toBeNull()
    expect(pending!.target).toBe('current')
    expect(pending!.sessionId).toBe(SID)
    expect(pending!.text).toBe('被撤销的文本')
    wrapper.unmount()
  })

  it('槽位已有同会话待消费文本 → 追加不覆盖（\\n\\n 累积，桌面 restoreToDraft 同款）', async () => {
    composerInjectionStore.requestInjection({ target: 'current', sessionId: SID, text: '正在输入的内容' })
    cancelDeliveryMock.mockResolvedValue({ clientUuid: 'q1', cancelled: true, content: '被撤销的文本' })
    setProjection(SID, [entry('q1', 'queued', 'queued', '排队消息')])
    const wrapper = mountStrip()

    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()

    expect(composerInjectionStore.pendingInjection.value!.text).toBe('正在输入的内容\n\n被撤销的文本')
    wrapper.unmount()
  })

  it('槽位残留他分会话文本 → 覆盖不累积（跨会话槽位串文本是错误语义）', async () => {
    composerInjectionStore.requestInjection({ target: 'current', sessionId: 'sid-stale', text: '别的会话残留' })
    cancelDeliveryMock.mockResolvedValue({ clientUuid: 'q1', cancelled: true, content: '被撤销的文本' })
    setProjection(SID, [entry('q1', 'queued', 'queued', '排队消息')])
    const wrapper = mountStrip()

    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()

    expect(composerInjectionStore.pendingInjection.value!.text).toBe('被撤销的文本')
    expect(composerInjectionStore.pendingInjection.value!.sessionId).toBe(SID)
    wrapper.unmount()
  })

  it('cancelled=true 但 content 缺失/空白（runtime 契约违规）→ 出声不静默，不写槽位', async () => {
    cancelDeliveryMock.mockResolvedValueOnce({ clientUuid: 'q1', cancelled: true })
    cancelDeliveryMock.mockResolvedValueOnce({ clientUuid: 'q2', cancelled: true, content: '   ' })
    setProjection(SID, [
      entry('q1', 'queued', 'queued', '无全文条目'),
      entry('q2', 'queued', 'queued', '空白全文条目'),
    ])
    const wrapper = mountStrip()

    const rows = rowsOf(wrapper)
    await rows[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-queue-strip-error"]').text()).toBe(
      tOf('mobile.queueStrip.restoreContentMissing'),
    )
    expect(composerInjectionStore.pendingInjection.value).toBeNull()

    await rows[1]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()
    expect(composerInjectionStore.pendingInjection.value).toBeNull()
    wrapper.unmount()
  })

  it('RPC 失败 → 内联错误行（含原因，用户可重试），不写槽位', async () => {
    cancelDeliveryMock.mockRejectedValue(new Error('ws disconnected'))
    setProjection(SID, [entry('q1', 'queued', 'queued', '排队消息')])
    const wrapper = mountStrip()

    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="mobile-queue-strip-error"]').text()).toBe(
      tOf('mobile.queueStrip.cancelFailed', { msg: 'ws disconnected' }),
    )
    expect(composerInjectionStore.pendingInjection.value).toBeNull()
    // 失败后取消钮恢复可用（可重试）
    expect(
      rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').attributes('aria-disabled'),
    ).toBe('false')
    wrapper.unmount()
  })

  it('端到端：取消成功 → MobileComposer 消费端 insertTextAtCursor(text) 落输入框 + 槽位清空（一次性通道闭合）', async () => {
    cancelDeliveryMock.mockResolvedValue({ clientUuid: 'q1', cancelled: true, content: '被撤销的文本' })
    setProjection(SID, [entry('q1', 'queued', 'queued', '排队消息')])

    // 消费端先挂载（watch 注册 + onMounted 补检查），写入发生在挂载之后 → watch 时序
    const composer = mount(MobileComposer, {
      props: { sessionId: SID },
      global: { plugins: [i18n] },
    })
    const strip = mountStrip()
    await flushPromises()
    expect(inputCalls.insertTextAtCursor).not.toHaveBeenCalled()

    await rowsOf(strip)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()

    expect(inputCalls.insertTextAtCursor).toHaveBeenCalledTimes(1)
    expect(inputCalls.insertTextAtCursor).toHaveBeenCalledWith('被撤销的文本')
    expect(composerInjectionStore.pendingInjection.value).toBeNull()
    composer.unmount()
    strip.unmount()
  })

  it('端到端：他分会话的注入请求不消费（sessionId 匹配门——取消 A 会话条目不落 B 会话输入框）', async () => {
    setProjection(SID, [])
    const composer = mount(MobileComposer, {
      props: { sessionId: 'sid-b' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    composerInjectionStore.requestInjection({ target: 'current', sessionId: SID, text: 'A 会话的文本' })
    await flushPromises()

    expect(inputCalls.insertTextAtCursor).not.toHaveBeenCalled()
    expect(composerInjectionStore.pendingInjection.value!.text).toBe('A 会话的文本')
    composer.unmount()
  })
})
