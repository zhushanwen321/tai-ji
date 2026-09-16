/**
 * useQueueRows 单测（投递所有权内核 u3c / D7 队列区单源化）。
 *
 * 被测：composables/panel/useQueueRows.ts —— composer 队列区的**唯一数据源与操作面**：
 * - rows：session.delivery 帧投影（core getDeliveryProjectionRef）过滤「非 direct 且未 delivered」
 *   的条目（帧序 = 内核 FIFO 发送序），display 层剥内核出站裸标记
 * - hint：按占用分档的行 hover 文案（compacting > bash > settling > 默认，消费 chat store
 *   sessionPhase 同一真值）
 * - onCancelEntry：delivery.cancel RPC → 成功则全文 + segments 交 restoreDraft 回草稿；
 *   不可撤（cancelled=false）与 RPC 失败均出声（toast 文案断言 = 用户可见反馈）
 * - onRetryEntry：delivery.resync 单条重报（§3.4 重试耗尽行），失败出声
 *
 * [HISTORICAL] 前身（compact-defer-composer-queue u1）：useDeferQueueRows 读本地 useCompactQueue
 * 分区（peek/mode 过滤/remove），队列状态机已随投递所有权内核整体退役（设计 §3.1 删除面）。
 *
 * 覆盖：过滤口径（direct/delivered 排除 + 序保持）· null session 早退 · hint 四档 ·
 * 撤销三态（成功回草稿 / 不可撤 / RPC 失败）· 重试两态（成功 / 失败）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/panel/use-queue-rows.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computed } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { getDeliveryProjectionRef } from '@taiji/core'
import type { DeliveryFrameEntry } from '@taiji/core'

const deliveryMock = vi.hoisted(() => ({
  cancelDelivery: vi.fn(),
  resyncDelivery: vi.fn(),
  drainDelivery: vi.fn(),
}))
const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
const phaseMock = vi.hoisted(() => vi.fn(() => ({ compacting: false, bash: false, turn: 'idle' })))

vi.mock('@/api/domains/delivery', () => ({ delivery: deliveryMock }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toastMock }))
vi.mock('@/stores/chat', () => ({ useChatStore: () => ({ sessionPhase: phaseMock }) }))

import { useQueueRows, deliveryQueueEntries } from '@/composables/panel/useQueueRows'

function entry(
  clientUuid: string,
  state: DeliveryFrameEntry['state'],
  lane: DeliveryFrameEntry['lane'],
  preview = clientUuid,
): DeliveryFrameEntry {
  return { clientUuid, preview, state, lane }
}

/** 写 core 投影（帧消费链路由 core useChat handler 承担，本层只读投影） */
function setProjection(sid: string, entries: DeliveryFrameEntry[]): void {
  const ref = getDeliveryProjectionRef()
  const next = new Map(ref.value)
  next.set(sid, entries)
  ref.value = next
}

function setup(sessionId: string | null, restoreDraft = vi.fn()) {
  const rows = useQueueRows(computed(() => sessionId), { restoreDraft })
  return { ...rows, restoreDraft }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  getDeliveryProjectionRef().value = new Map()
  phaseMock.mockReturnValue({ compacting: false, bash: false, turn: 'idle' })
  deliveryMock.cancelDelivery.mockResolvedValue({ clientUuid: 'u-1', cancelled: true, content: '被撤销的文本' })
  deliveryMock.resyncDelivery.mockResolvedValue({ sessionId: 's1', deduped: [] })
})

describe('useQueueRows · 单源投影过滤（D7）', () => {
  it('只收「非 direct 且未 delivered」条目，帧序保持（内核 FIFO 发送序）', () => {
    setProjection('s1', [
      entry('d1', 'in-flight', 'direct'), // direct 车道：乐观气泡原位保留 → 不进队列区
      entry('q1', 'queued', 'queued', '排队消息'),
      entry('f1', 'in-flight', 'steer', '投递中消息'),
      entry('x1', 'delivered', 'steer'), // 已送达：transcript 已入流 → 隐去
      entry('q2', 'failed', 'queued', '失败消息'),
    ])
    const { rows } = setup('s1')
    expect(rows.value.map((r) => r.clientUuid)).toEqual(['q1', 'f1', 'q2'])
    expect(rows.value.map((r) => r.state)).toEqual(['queued', 'in-flight', 'failed'])
    expect(rows.value[0]!.preview).toBe('排队消息')
  })

  it('display 层剥内核出站裸标记（防御性同规则，SSOT = core apply-entry-convert）', () => {
    setProjection('s1', [
      entry('q1', 'queued', 'queued', '正文内容 <!--taiji:msg:11111111-2222-3333-4444-555555555555-->'),
    ])
    const { rows } = setup('s1')
    expect(rows.value[0]!.preview).toBe('正文内容')
  })

  it('deliveryQueueEntries 是过滤口径唯一定义点（QueueBubble 行渲染与 ActivityStrip 计数共用）', () => {
    const entries = [
      entry('d1', 'in-flight', 'direct'),
      entry('q1', 'queued', 'queued'),
      entry('x1', 'delivered', 'queued'),
    ]
    expect(deliveryQueueEntries(entries).map((e) => e.clientUuid)).toEqual(['q1'])
  })

  it('sessionId 为 null → 空行 + hint 走默认档（不触 store）', () => {
    setProjection('s1', [entry('q1', 'queued', 'queued')])
    const { rows, hint } = setup(null)
    expect(rows.value).toEqual([])
    expect(hint.value).toBe('占用结束后发送')
    expect(phaseMock).not.toHaveBeenCalled()
  })

  it('hint 分档：compacting > bash > settling（turn 非 idle）> 默认', () => {
    phaseMock.mockReturnValue({ compacting: true, bash: true, turn: 'idle' })
    expect(setup('s1').hint.value).toBe('等待上下文压缩完成后发送')
    phaseMock.mockReturnValue({ compacting: false, bash: true, turn: 'idle' })
    expect(setup('s1').hint.value).toBe('等待命令执行结束后发送')
    phaseMock.mockReturnValue({ compacting: false, bash: false, turn: 'settling' })
    expect(setup('s1').hint.value).toBe('等待当前回合结束后发送')
    phaseMock.mockReturnValue({ compacting: false, bash: false, turn: 'idle' })
    expect(setup('s1').hint.value).toBe('占用结束后发送')
  })
})

describe('useQueueRows · × 撤销（V9/V10：delivery.cancel）', () => {
  it('撤销成功 → cancelDelivery(sid, clientUuid) + 全文/segments 交 restoreDraft 回草稿', async () => {
    const segments = [{ type: 'text' as const, text: '被撤销的文本' }]
    deliveryMock.cancelDelivery.mockResolvedValueOnce({
      clientUuid: 'u-1',
      cancelled: true,
      content: '被撤销的文本',
      segments,
    })
    const { onCancelEntry, restoreDraft } = setup('s1')

    await onCancelEntry('u-1')

    expect(deliveryMock.cancelDelivery).toHaveBeenCalledWith('s1', 'u-1')
    expect(restoreDraft).toHaveBeenCalledWith({ text: '被撤销的文本', segments })
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('不可撤（cancelled=false）→ toast 明确反馈（含 runtime 给出的原因），不回草稿', async () => {
    deliveryMock.cancelDelivery.mockResolvedValueOnce({ clientUuid: 'u-2', cancelled: false, reason: 'already delivered' })
    const { onCancelEntry, restoreDraft } = setup('s1')

    await onCancelEntry('u-2')

    expect(toastMock.error).toHaveBeenCalledWith('无法撤销：already delivered')
    expect(restoreDraft).not.toHaveBeenCalled()
  })

  it('不可撤且无原因 → 兜底文案「消息已投递，无法撤销」', async () => {
    deliveryMock.cancelDelivery.mockResolvedValueOnce({ clientUuid: 'u-3', cancelled: false })
    const { onCancelEntry } = setup('s1')
    await onCancelEntry('u-3')
    expect(toastMock.error).toHaveBeenCalledWith('消息已投递，无法撤销')
  })

  it('RPC 失败 → toast「撤销失败：{原因}」（不吞错，用户可重试）', async () => {
    deliveryMock.cancelDelivery.mockRejectedValueOnce(new Error('ws disconnected'))
    const { onCancelEntry, restoreDraft } = setup('s1')

    await onCancelEntry('u-4')

    expect(toastMock.error).toHaveBeenCalledWith('撤销失败：ws disconnected')
    expect(restoreDraft).not.toHaveBeenCalled()
  })

  it('null session → no-op（不触 RPC，不触 toast）', async () => {
    const { onCancelEntry } = setup(null)
    await onCancelEntry('u-5')
    expect(deliveryMock.cancelDelivery).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()
  })
})

describe('useQueueRows · failed 行重试（delivery.resync 单条重报，§3.4）', () => {
  it('重试 → resyncDelivery(sid, [clientUuid])，成功静默（权威状态经帧收敛）', async () => {
    const { onRetryEntry } = setup('s1')

    await onRetryEntry('u-6')

    expect(deliveryMock.resyncDelivery).toHaveBeenCalledWith('s1', ['u-6'])
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('重试 RPC 失败 → toast「重试失败：{原因}」', async () => {
    deliveryMock.resyncDelivery.mockRejectedValueOnce(new Error('rpc timeout'))
    const { onRetryEntry } = setup('s1')

    await onRetryEntry('u-7')

    expect(toastMock.error).toHaveBeenCalledWith('重试失败：rpc timeout')
  })

  it('null session → no-op', async () => {
    const { onRetryEntry } = setup(null)
    await onRetryEntry('u-8')
    expect(deliveryMock.resyncDelivery).not.toHaveBeenCalled()
  })
})
