// QueueStrip v2 五态状态机测试（remote-use-mobile-v2 §6.22 / 验收条款 1）。
//
// §6.22 状态机契约逐条锁定：
//   queued    → 「排队中」+ 取消 × 可点（delivery.cancel）
//   in-flight → 「投递中」，取消钮结构性不在 DOM（受理后条目不可撤——显示与事实一致）
//   failed    → 「发送未确认」+ 重试钮 → delivery.resync(sid, [clientUuid])（复审 F6 移入）
//   delivered → 不渲染（core deliveryQueueEntries 谓词滤除）；cancelled 不在快照条目状态
//   词表（DeliveryFrameEntry.state 四值，取消即离场）——两者「不显示」均为结构性保证，
//   本测以 DOM 负断言锁定。
//
// mock 策略（对齐 v1 queue-strip.test.ts「仅 transport 出口 mock、派生视图经 core 读口直写」
// 立场）：cancelDelivery / resyncDelivery 两出口模块级 mock；行派生消费 core 派生视图真读口。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { getDeliveryProjectionRef, resetChatModuleStateForTest } from '@taiji/core'
import type { DeliveryFrameEntry } from '@taiji/core'
import QueueStrip from '../QueueStrip.vue'
import { i18n } from '../../i18n'

const { cancelDeliveryMock, resyncDeliveryMock } = vi.hoisted(() => ({
  cancelDeliveryMock: vi.fn(),
  resyncDeliveryMock: vi.fn(),
}))

vi.mock('@taiji/core/transport/api/domains/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/chat')>()
  return { ...actual, cancelDelivery: cancelDeliveryMock, resyncDelivery: resyncDeliveryMock }
})

const SID = 'sid-queue-strip-v2'

function entry(
  clientUuid: string,
  state: DeliveryFrameEntry['state'],
  lane: DeliveryFrameEntry['lane'],
  preview = clientUuid,
): DeliveryFrameEntry {
  return { clientUuid, preview, state, lane }
}

/** 写 core 派生视图（state topic last-value 语义：每帧整体替换） */
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
  resyncDeliveryMock.mockReset()
})

describe('QueueStrip v2 五态状态机（§6.22 / 验收条款 1）', () => {
  it('queued：行渲染 + 状态徽标「排队中」+ 取消 × 在场可点 → delivery.cancel 透传', async () => {
    cancelDeliveryMock.mockResolvedValue({ clientUuid: 'q1', cancelled: true, content: '排队文本' })
    setProjection(SID, [entry('q1', 'queued', 'queued', '排队消息甲')])
    const wrapper = mountStrip()

    const row = rowsOf(wrapper)[0]!
    expect(row.find('[data-testid="mobile-queue-state-queued"]').text()).toBe(
      tOf('mobile.queueStrip.stateQueued'),
    )
    expect(row.text()).toContain('排队消息甲')

    const cancelBtn = row.get('[data-testid="mobile-queue-cancel"]')
    expect(cancelBtn.attributes('aria-label')).toBe(tOf('mobile.queueStrip.cancel'))
    await cancelBtn.trigger('click')
    await flushPromises()
    expect(cancelDeliveryMock).toHaveBeenCalledTimes(1)
    expect(cancelDeliveryMock).toHaveBeenCalledWith(SID, 'q1')
    wrapper.unmount()
  })

  it('in-flight：状态徽标「投递中」+ 取消钮结构性不在 DOM（§6.22 不可取消——渲染面即禁）', () => {
    setProjection(SID, [entry('f1', 'in-flight', 'steer', '投递中消息')])
    const wrapper = mountStrip()

    const row = rowsOf(wrapper)[0]!
    expect(row.find('[data-testid="mobile-queue-state-in-flight"]').text()).toBe(
      tOf('mobile.queueStrip.stateInFlight'),
    )
    expect(row.find('[data-testid="mobile-queue-cancel"]').exists()).toBe(false)
    // 重试钮同样仅 failed 态
    expect(row.find('[data-testid="mobile-queue-retry"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('failed：状态徽标「发送未确认」+ 重试钮在场 → 点重试 delivery.resync(sid,[uuid]) 透传（幂等去重 runtime 单点）', async () => {
    resyncDeliveryMock.mockResolvedValue({ sessionId: SID, deduped: [] })
    setProjection(SID, [entry('x1', 'failed', 'queued', '失败消息')])
    const wrapper = mountStrip()

    const row = rowsOf(wrapper)[0]!
    expect(row.find('[data-testid="mobile-queue-state-failed"]').text()).toBe(
      tOf('mobile.queueStrip.stateFailed'),
    )
    const retryBtn = row.get('[data-testid="mobile-queue-retry"]')
    expect(retryBtn.text()).toContain(tOf('mobile.queueStrip.retry'))
    await retryBtn.trigger('click')
    await flushPromises()
    expect(resyncDeliveryMock).toHaveBeenCalledTimes(1)
    expect(resyncDeliveryMock).toHaveBeenCalledWith(SID, ['x1'])
    wrapper.unmount()
  })

  it('failed 重试 RPC 失败 → 内联错误行可见（不静默），重试钮恢复可点', async () => {
    resyncDeliveryMock.mockRejectedValue(new Error('ws down'))
    setProjection(SID, [entry('x1', 'failed', 'queued', '失败消息')])
    const wrapper = mountStrip()

    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-retry"]').trigger('click')
    await flushPromises()

    const errLine = wrapper.find('[data-testid="mobile-queue-resync-error"]')
    expect(errLine.exists()).toBe(true)
    expect(errLine.attributes('role')).toBe('alert')
    expect(errLine.text()).toBe(tOf('mobile.queueStrip.resyncFailed', { msg: 'ws down' }))
    // 失败后重试钮恢复（aria-disabled 翻回 false——可重试）
    expect(
      rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-retry"]').attributes('aria-disabled'),
    ).toBe('false')
    wrapper.unmount()
  })

  it('重试在途防重入：resyncing 期重复点击只走一次 RPC', async () => {
    let resolveRpc!: (v: { sessionId: string; deduped: string[] }) => void
    resyncDeliveryMock.mockImplementation(() => new Promise((resolve) => (resolveRpc = resolve)))
    setProjection(SID, [entry('x1', 'failed', 'queued', '失败消息')])
    const wrapper = mountStrip()

    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-retry"]').trigger('click')
    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-retry"]').trigger('click')
    expect(resyncDeliveryMock).toHaveBeenCalledTimes(1)
    resolveRpc({ sessionId: SID, deduped: [] })
    await flushPromises()
    wrapper.unmount()
  })

  it('delivered 不渲染（core 谓词滤除）+ cancelled 不在快照条目状态词表（四值，取消即离场）——「不显示」由内核结构性保证', () => {
    setProjection(SID, [
      entry('d1', 'delivered', 'queued', '已入流消息'),
      entry('q1', 'queued', 'queued', '排队消息'),
    ])
    const wrapper = mountStrip()

    const rows = rowsOf(wrapper)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('排队消息')
    expect(wrapper.text()).not.toContain('已入流消息')
    wrapper.unmount()
  })

  it('混合帧：三态同行渲染互不干扰，行内动作按状态机分流（queued=×、failed=重试、in-flight=无动作钮）', () => {
    setProjection(SID, [
      entry('q1', 'queued', 'queued', '排队甲'),
      entry('f1', 'in-flight', 'steer', '投递乙'),
      entry('x1', 'failed', 'queued', '失败丙'),
    ])
    const wrapper = mountStrip()

    const rows = rowsOf(wrapper)
    expect(rows).toHaveLength(3)
    expect(rows[0]!.find('[data-testid="mobile-queue-cancel"]').exists()).toBe(true)
    expect(rows[0]!.find('[data-testid="mobile-queue-retry"]').exists()).toBe(false)
    expect(rows[1]!.find('[data-testid="mobile-queue-cancel"]').exists()).toBe(false)
    expect(rows[2]!.find('[data-testid="mobile-queue-retry"]').exists()).toBe(true)
    expect(rows[2]!.find('[data-testid="mobile-queue-cancel"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
