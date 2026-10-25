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
import { ref } from 'vue'
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

// ── 编辑路径补全（peek 失败 / 条目已离场 / 放弃编辑 / 键盘触发）──
//
// 覆盖 onEditEntry 与 onAbandonEdit 的剩余分支：peek RPC 异常（清锚定 + 失败提示）、
// 条目已不在内核活跃集（found=false → gone 提示）、peek 成功且锚定保持（注入通道预填）、
// 提示条「放弃编辑」按钮（解除锚定 + 提示条消失）、物理键盘 Enter 触发编辑/取消
//（role=button 无原生 button，键盘可达性靠 @keydown.enter 显式绑定）。
describe('QueueStrip 编辑路径补全（peek 失败 / gone / 放弃 / 键盘触发）', () => {
  /** 断言注入通道调用的 mock 句柄（与模块 mock 同一 vi.fn 实例） */
  async function requestInjectionMock(): Promise<ReturnType<typeof vi.fn>> {
    const { composerInjectionStore } = await import('../shell/app-runtime')
    return composerInjectionStore.requestInjection as unknown as ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    beginQueueEditMock.mockReset()
    anchorOfMock.mockReset()
    peekMock.mockReset()
    cancelMock.mockReset()
    clearMock.mockReset()
    resetProjection()
  })

  it('peek RPC 异常：清锚定 + 失败提示（错误 message 插值）', async () => {
    feedProjection('sid-1', [entry('u-b')])
    anchorOfMock.mockReturnValue('u-b')
    beginQueueEditMock.mockReturnValue('started')
    peekMock.mockRejectedValue(new Error('rpc boom'))
    const wrapper = mountStrip()
    await flushPromises()
    await wrapper.find('[data-testid="mobile-queue-edit"]').trigger('click')
    await flushPromises()
    expect(clearMock).toHaveBeenCalledWith('sid-1')
    expect(wrapper.find('[data-testid="mobile-queue-edit-notice"]').text()).toBe(
      i18n.global.t('mobile.queueStrip.editPeekFailed', { msg: 'rpc boom' }),
    )
    wrapper.unmount()
  })

  it('peek found=false（条目已不在内核活跃集）：清锚定 + gone 提示', async () => {
    feedProjection('sid-1', [entry('u-b')])
    anchorOfMock.mockReturnValue('u-b')
    beginQueueEditMock.mockReturnValue('started')
    peekMock.mockResolvedValue({ clientUuid: 'u-b', found: false })
    const wrapper = mountStrip()
    await flushPromises()
    await wrapper.find('[data-testid="mobile-queue-edit"]').trigger('click')
    await flushPromises()
    expect(clearMock).toHaveBeenCalledWith('sid-1')
    expect(wrapper.find('[data-testid="mobile-queue-edit-notice"]').text()).toBe(
      i18n.global.t('mobile.queueStrip.editGone'),
    )
    wrapper.unmount()
  })

  it('peek 成功且锚定保持：全文经注入通道预填（requestInjection 调用）', async () => {
    feedProjection('sid-1', [entry('u-b')])
    anchorOfMock.mockReturnValue('u-b')
    beginQueueEditMock.mockReturnValue('started')
    peekMock.mockResolvedValue({ clientUuid: 'u-b', found: true, content: '排队全文' })
    const requestInjection = await requestInjectionMock()
    ;(requestInjection as ReturnType<typeof vi.fn>).mockClear()
    const wrapper = mountStrip()
    await flushPromises()
    await wrapper.find('[data-testid="mobile-queue-edit"]').trigger('click')
    await flushPromises()
    expect(requestInjection).toHaveBeenCalledWith({
      target: 'current',
      sessionId: 'sid-1',
      text: '排队全文',
    })
    wrapper.unmount()
  })

  it('提示条「放弃编辑」：解除锚定 + 编辑条与提示一并消失', async () => {
    feedProjection('sid-1', [entry('u-a')])
    // 读口经 ref 承载：editingClientUuid computed 求值时读 anchorRef.value（响应式依赖
    // 被收集），置 null 后 banner 显隐随渲染更新——mockReturnValue 变化不触发重算
    const anchorRef = ref<string | null>('u-a')
    anchorOfMock.mockImplementation(() => anchorRef.value)
    const wrapper = mountStrip()
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-queue-edit-banner"]').exists()).toBe(true)
    // 放弃后锚定读口归 null（clearQueueEditFor 是 mock，读口状态由 stub 模拟真实清除）
    anchorRef.value = null
    await wrapper.find('[data-testid="mobile-queue-edit-abandon"]').trigger('click')
    await flushPromises()
    expect(clearMock).toHaveBeenCalledWith('sid-1')
    expect(wrapper.find('[data-testid="mobile-queue-edit-banner"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('物理键盘 Enter 触发编辑与取消（role=button 键盘可达性）', async () => {
    feedProjection('sid-1', [entry('u-a')])
    anchorOfMock.mockReturnValue(null)
    beginQueueEditMock.mockReturnValue('started')
    cancelMock.mockResolvedValue({ cancelled: true, content: 'cancel text' })
    const wrapper = mountStrip()
    await flushPromises()
    await wrapper.find('[data-testid="mobile-queue-edit"]').trigger('keydown.enter')
    await flushPromises()
    expect(beginQueueEditMock).toHaveBeenCalledWith('sid-1', 'u-a')
    await wrapper.find('[data-testid="mobile-queue-cancel"]').trigger('keydown.enter')
    await flushPromises()
    expect(cancelMock).toHaveBeenCalledWith('sid-1', 'u-a')
    wrapper.unmount()
  })
})
