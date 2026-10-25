// QueueStrip 队列条编辑反馈通道测试（chat-flow-consistency D6 移动壳最小形态 / Q4 跨行拦截提示）。
//
// app-runtime 模块级 mock：隔离壳级锚定登记与投递 RPC（测试禁触网络）；core 派生视图走
// 真实单源（replaceDeliveryProjection 喂数 → deliveryQueueEntries 谓词过滤，禁壳内重写）。
// 覆盖（Q4「拦截 + 提示」两件套的提示件——修复前渲染门 v-if="editNotice && !editingClientUuid"
// 在 conflict 场景恒 false：拦截只发生在锚定在册时，提示被结构性吞掉，用户无任何反馈）：
// - 编辑 A 中点 B（conflict）：拦截提示行（mobile-queue-edit-notice）与编辑条并存可见
// - 每次新尝试清空旧提示（不跨条目残留）
// - peek 成功预填：提示行保持空
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import QueueStrip from '../views/QueueStrip.vue'
import { i18n } from '../i18n'
import { getDeliveryProjectionRef } from '@taiji/core'
import type { DeliveryFrameEntry } from '@taiji/core'

/** 喂数入口：主入口只导出派生视图读口 ref（写函数 replaceDeliveryProjection 不出桶）——
 *  对同一模块级单例 ref 整体赋值等效（响应式触发，测试隔离用空 Map 复位） */
function feedProjection(sid: string, entries: DeliveryFrameEntry[]): void {
  getDeliveryProjectionRef().value = new Map([[sid, entries]])
}

function resetProjection(): void {
  getDeliveryProjectionRef().value = new Map()
}

// vi.hoisted：mock 工厂被 hoist 到 import 前，工厂内引用的变量须经 vi.hoisted 创建
const { beginQueueEditMock, anchorOfMock, clearMock, peekMock, cancelMock } = vi.hoisted(() => ({
  beginQueueEditMock: vi.fn<(sid: string, clientUuid: string) => string>(),
  anchorOfMock: vi.fn<(sid: string) => string | null>(),
  clearMock: vi.fn<(sid: string) => void>(),
  peekMock: vi.fn<(sid: string, clientUuid: string) => Promise<unknown>>(),
  cancelMock: vi.fn<(sid: string, clientUuid: string) => Promise<unknown>>(),
}))

vi.mock('../shell/app-runtime', () => ({
  beginQueueEdit: beginQueueEditMock,
  queueEditAnchorOf: anchorOfMock,
  clearQueueEditFor: clearMock,
  peekDelivery: peekMock,
  cancelDelivery: cancelMock,
  composerInjectionStore: {
    pendingInjection: { value: null },
    requestInjection: vi.fn(),
  },
}))

/** 队列条目 fixture（queued 态可见，lane 走谓词非 direct） */
function entry(clientUuid: string): DeliveryFrameEntry {
  return { clientUuid, preview: `消息 ${clientUuid}`, state: 'queued', lane: 'queued' }
}

function mountStrip(sessionId = 'sid-1') {
  return mount(QueueStrip, {
    props: { sessionId },
    global: { plugins: [i18n] },
  })
}

beforeEach(() => {
  beginQueueEditMock.mockReset()
  anchorOfMock.mockReset()
  peekMock.mockReset()
  cancelMock.mockReset()
  clearMock.mockReset()
  resetProjection()
})

afterEach(() => {
  resetProjection()
})

describe('QueueStrip 编辑反馈通道（Q4 拦截 + 提示）', () => {
  it('编辑 A 中点 B（conflict）：拦截提示行与编辑条并存可见（修复前提示被渲染门结构性吞掉）', async () => {
    feedProjection('sid-1', [entry('u-a'), entry('u-b')])
    anchorOfMock.mockReturnValue('u-a') // 编辑态：A 锚定在册（编辑条在场）
    beginQueueEditMock.mockReturnValue('conflict') // 单锚定裁决：跨行拦截
    const wrapper = mountStrip()
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-queue-edit-banner"]').exists()).toBe(true)

    // 点第二行的 ✎（行序 = 帧序：u-a, u-b）
    const editButtons = wrapper.findAll('[data-testid="mobile-queue-edit"]')
    expect(editButtons).toHaveLength(2)
    await editButtons[1]!.trigger('click')
    await flushPromises()

    const notice = wrapper.find('[data-testid="mobile-queue-edit-notice"]')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toBe(i18n.global.t('mobile.queueStrip.editConflict'))
    // 编辑条不受影响（conflict 只拦截新锚定，不动 A 的既有锚定）
    expect(wrapper.find('[data-testid="mobile-queue-edit-banner"]').exists()).toBe(true)
  })

  it('新尝试清空旧提示：conflict 提示不跨条目残留（再次点击先清空再判定）', async () => {
    feedProjection('sid-1', [entry('u-a'), entry('u-b')])
    anchorOfMock.mockReturnValue('u-a')
    beginQueueEditMock.mockReturnValueOnce('conflict').mockReturnValueOnce('already-editing-same')
    const wrapper = mountStrip()
    await flushPromises()
    const editButtons = wrapper.findAll('[data-testid="mobile-queue-edit"]')
    await editButtons[1]!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-queue-edit-notice"]').exists()).toBe(true)

    // 再次点击（同行幂等场景）：旧 conflict 提示先被清空，无新提示则不渲染
    await editButtons[0]!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-queue-edit-notice"]').exists()).toBe(false)
  })

  it('peek 成功预填：提示行保持空（成功路径无噪声反馈），草稿经注入通道恢复', async () => {
    feedProjection('sid-1', [entry('u-b')])
    anchorOfMock.mockReturnValue(null) // 空闲态
    beginQueueEditMock.mockReturnValue('started')
    peekMock.mockResolvedValue({ found: true, content: '排队消息全文', segments: [] })
    const wrapper = mountStrip()
    await flushPromises()
    await wrapper.find('[data-testid="mobile-queue-edit"]').trigger('click')
    await flushPromises()
    expect(peekMock).toHaveBeenCalledWith('sid-1', 'u-b')
    expect(wrapper.find('[data-testid="mobile-queue-edit-notice"]').exists()).toBe(false)
  })
})
