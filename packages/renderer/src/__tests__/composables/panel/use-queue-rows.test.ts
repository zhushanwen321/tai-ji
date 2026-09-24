/**
 * useQueueRows 单测（投递所有权内核 u3c / D7 队列区单源化）。
 *
 * 被测：composables/panel/useQueueRows.ts —— composer 队列区的**唯一数据源与操作面**：
 * - rows：session.delivery 帧投影（core getDeliveryProjectionRef）过滤「非 direct 且未 delivered」
 *   的条目（帧序 = 内核 FIFO 发送序），preview 直用帧值（runtime 装配已剥标记截断，
 *   帧契约测试 session-message-handler-delivery 断言无标记——显示层不二次加工）
 * - foldQueueRows：队列区折叠口径唯一定义点——failed 行置顶且恒可见（重试入口不折叠），
 *   「+N」只计被折叠的非 failed 行（§3.4 重试耗尽行必须可操作）
 * - hint：按占用分档的行 hover 文案（compacting > bash > settling > 默认，消费 chat store
 *   sessionPhase 同一真值）
 * - onCancelEntry：delivery.cancel RPC → 成功且携带全文则交 restoreDraft 回草稿；
 *   三个失败域各自出声各自文案（RPC 异常 = 撤销失败 / 回草稿抛错 = 恢复失败 /
 *   cancelled=true 但 content 缺失 = 原文未取回），不可撤（cancelled=false）同样出声
 * - onRetryEntry：delivery.resync 单条重报（§3.4 重试耗尽行），失败出声
 *
 * [HISTORICAL] 前身（compact-defer-composer-queue u1）：useDeferQueueRows 读本地 useCompactQueue
 * 分区（peek/mode 过滤/remove），队列状态机已随投递所有权内核整体退役（设计 §3.1 删除面）。
 *
 * 覆盖：过滤口径（direct/delivered 排除 + 序保持）· 折叠口径（failed 置顶恒可见 + +N 不含
 * failed）· null session 早退 · hint 四档 · 撤销四态（成功回草稿 / 不可撤 / RPC 失败 /
 * 成功但回草稿或全文缺失分型出声）· 重试两态（成功 / 失败）。
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

import { useQueueRows, deliveryQueueEntries, foldQueueRows, QUEUE_VISIBLE_MAX } from '@/composables/panel/useQueueRows'

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

  it('preview 直用帧值不二次加工（剥标记 SSOT = runtime 装配 deliveryPreview，帧契约测试断言无标记）', () => {
    setProjection('s1', [
      entry('q1', 'queued', 'queued', '排队消息 帧侧已剥标记'),
    ])
    const { rows } = setup('s1')
    expect(rows.value[0]!.preview).toBe('排队消息 帧侧已剥标记')
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

describe('foldQueueRows · 折叠口径唯一定义点（failed 置顶恒可见，QueueBubble 消费）', () => {
  it('failed 行置顶（组内保持帧序），其余行保持帧序跟随', () => {
    const rows = [
      { clientUuid: 'q1', preview: 'm1', state: 'queued' as const },
      { clientUuid: 'f1', preview: 'm2', state: 'failed' as const },
      { clientUuid: 'i1', preview: 'm3', state: 'in-flight' as const },
    ]
    const { visible, overflowCount } = foldQueueRows(rows)
    expect(visible.map((r) => r.clientUuid)).toEqual(['f1', 'q1', 'i1'])
    expect(overflowCount).toBe(0)
  })

  it('failed 行不折叠（恒可见可重试）：failed 数超可见上限仍全显，可见位全给 failed', () => {
    const rows = [
      { clientUuid: 'f1', preview: 'm1', state: 'failed' as const },
      { clientUuid: 'f2', preview: 'm2', state: 'failed' as const },
      { clientUuid: 'f3', preview: 'm3', state: 'failed' as const },
      { clientUuid: 'f4', preview: 'm4', state: 'failed' as const },
      { clientUuid: 'q1', preview: 'm5', state: 'queued' as const },
    ]
    const { visible, overflowCount } = foldQueueRows(rows)
    expect(visible.map((r) => r.clientUuid)).toEqual(['f1', 'f2', 'f3', 'f4'])
    expect(overflowCount).toBe(1)
  })

  it('「+N」只计被折叠的非 failed 行（failed 恒可见 → 溢出计数不含 failed）', () => {
    const rows = [
      { clientUuid: 'f1', preview: 'm1', state: 'failed' as const },
      { clientUuid: 'q1', preview: 'm2', state: 'queued' as const },
      { clientUuid: 'q2', preview: 'm3', state: 'queued' as const },
      { clientUuid: 'q3', preview: 'm4', state: 'queued' as const },
      { clientUuid: 'i1', preview: 'm5', state: 'in-flight' as const },
    ]
    const { visible, overflowCount } = foldQueueRows(rows)
    // failed 行全量可见（f1 在首位的置顶序），「+N」= 被折叠的 q3/i1 两行（不含 failed）
    expect(visible.map((r) => r.clientUuid)).toEqual(['f1', 'q1', 'q2'])
    expect(overflowCount).toBe(2)
  })

  it('无 failed → 前 N 条按帧序（与既有 v6 §8.5 行为一致，回归锚）', () => {
    const rows = [
      { clientUuid: 'q1', preview: 'm1', state: 'queued' as const },
      { clientUuid: 'q2', preview: 'm2', state: 'queued' as const },
      { clientUuid: 'q3', preview: 'm3', state: 'queued' as const },
      { clientUuid: 'q4', preview: 'm4', state: 'queued' as const },
    ]
    const { visible, overflowCount } = foldQueueRows(rows)
    expect(visible.map((r) => r.clientUuid)).toEqual(['q1', 'q2', 'q3'])
    expect(overflowCount).toBe(1)
    expect(QUEUE_VISIBLE_MAX).toBe(3)
  })

  it('空输入 → 空可见 + 零溢出', () => {
    expect(foldQueueRows([])).toEqual({ visible: [], overflowCount: 0 })
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

  it('回草稿抛错 → 独立文案「已撤销，但恢复到输入框失败」（不误标撤销失败——撤销已成功）', async () => {
    const { onCancelEntry, restoreDraft } = setup('s1')
    restoreDraft.mockImplementationOnce(() => {
      throw new Error('input readonly')
    })

    await onCancelEntry('u-9')

    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error).toHaveBeenCalledWith('已撤销，但恢复到输入框失败：input readonly')
    expect(toastMock.error).not.toHaveBeenCalledWith(expect.stringContaining('撤销失败'))
  })

  it('cancelled=true 但 content 缺失（runtime 契约违规）→ 出声「原文未能取回」，不静默回空草稿', async () => {
    deliveryMock.cancelDelivery.mockResolvedValueOnce({ clientUuid: 'u-10', cancelled: true })
    const { onCancelEntry, restoreDraft } = setup('s1')

    await onCancelEntry('u-10')

    expect(toastMock.error).toHaveBeenCalledWith('消息已撤销，但原文未能取回——请重新输入')
    expect(restoreDraft).not.toHaveBeenCalled()
  })

  it('cancelled=true 但 content 空串/空白 → 同样出声（不把空文本当合法草稿恢复）', async () => {
    deliveryMock.cancelDelivery.mockResolvedValueOnce({ clientUuid: 'u-11', cancelled: true, content: '   ' })
    const { onCancelEntry, restoreDraft } = setup('s1')

    await onCancelEntry('u-11')

    expect(toastMock.error).toHaveBeenCalledWith('消息已撤销，但原文未能取回——请重新输入')
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
