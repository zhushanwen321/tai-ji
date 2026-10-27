import { i18n } from '../i18n';
import MobileComposer from '../views/MobileComposer.vue';
import QueueStrip from '../views/QueueStrip.vue';
import { getDeliveryProjectionRef } from '@taiji/core';
import type { DeliveryFrameEntry } from '@taiji/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← mobile-queue-strip.spec.ts
// ======================================================================

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

// 簇内并集 mock：queue-strip 编辑通道出口 + composer 发送/锚定出口同表覆写
//（spread actual —— 未被覆写的其余 app-runtime 导出保持真实）。
vi.mock('../shell/app-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shell/app-runtime')>()
  return {
    ...actual,
    beginQueueEdit: beginQueueEditMock,
    queueEditAnchorOf: anchorOfMock,
    clearQueueEditFor: clearMock,
    peekDelivery: peekMock,
    cancelDelivery: cancelMock,
    composerInjectionStore: {
      pendingInjection: { value: null },
      requestInjection: vi.fn(),
    },
    chatStore: {
      ...actual.chatStore,
      // 乐观窗成分（D5-4）：sid-active 投影 dispatching → 无内容走停止分支，其余会话全 idle
      isActive: (sid: string) => sid === 'sid-active',
      getMessages: () => [],
      // 相位可控注入（stopTarget 两档断言源）：缺省全 idle（与真实现缺省同值）
      sessionPhase: (sid: string) =>
        sessionPhaseMock(sid) ?? { turn: 'idle', compacting: false, bash: false },
    },
    useChatInstance: {
      ...actual.useChatInstance,
      abort: abortMock,
      send: sendMock,
    },
    // 锚定编辑分流（chat-flow-consistency D6）：原位编辑 RPC 可控注入
    editDelivery: editDeliveryMock,
  }
})

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

// ======================================================================
// ← mobile-composer.spec.ts
// ======================================================================

// vi.hoisted：mock 工厂被 hoist 到 import 前，工厂内引用的变量须经 vi.hoisted 创建
const { abortMock, sendMock, editDeliveryMock, sessionPhaseMock, errorBarMock } = vi.hoisted(() => ({
  abortMock: vi.fn<(sid: string) => Promise<void>>(),
  sendMock: vi.fn<(sid: string, segments: unknown[]) => Promise<void>>(),
  editDeliveryMock: vi.fn<(sid: string, clientUuid: string, content: string) => Promise<unknown>>(),
  sessionPhaseMock: vi.fn<(sid: string) => { turn: string; compacting: boolean; bash: boolean }>(),
  errorBarMock: vi.fn<(message: string) => void>(),
}))

vi.mock('../shell/error-bar', () => ({ showErrorBar: errorBarMock }))

// app-runtime 并集 mock 见簇首（queue-strip 节顶部）：本节覆盖项已并入同一工厂。

function mountComposer(sessionId: string | null) {
  return mount(MobileComposer, {
    props: { sessionId },
    global: { plugins: [i18n] },
  })
}

describe('MobileComposer 发送位双形态（D5 裁剪集：停止键/发送键/禁用占位）', () => {
  beforeEach(() => {
    abortMock.mockClear()
    sendMock.mockClear()
    editDeliveryMock.mockClear()
    anchorOfMock.mockReset()
    clearMock.mockClear()
    abortMock.mockResolvedValue(undefined)
    sendMock.mockResolvedValue(undefined)
    anchorOfMock.mockReturnValue(null)
  })

  it('乐观占用 session（isActive，无内容）渲染停止键（不渲染发送键），点击调 abort(sessionId)', async () => {
    const wrapper = mountComposer('sid-active')
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-composer-stop"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-composer-send"]').exists()).toBe(false)
    await wrapper.get('[data-testid="mobile-composer-stop"]').trigger('click')
    await flushPromises()
    expect(abortMock).toHaveBeenCalledWith('sid-active')
    wrapper.unmount()
  })

  it('空闲 session 渲染发送键；输入文本（input 事件驱动 hasInput）后点击调 send(sessionId, segments) 并清空输入', async () => {
    const wrapper = mountComposer('sid-idle')
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-composer-stop"]').exists()).toBe(false)
    const sendBtn = wrapper.get('[data-testid="mobile-composer-send"]')
    // 无内容 = 禁用态发送占位（D5：disabled 含 !hasInput，title 提示输入）
    expect(sendBtn.attributes('disabled')).toBeDefined()
    // 输入注入参照 ui composer-input-get-text.test.ts：直接写 [role="textbox"] 的 innerHTML
    //（getSegments 从 DOM 遍历提取，与 input 事件无关）；再 trigger('input') 走组件真实
    // onInput → 解析 segments + emit('input') → 组件 hasInput 置真解锁按钮。纯文本产出
    // { type:'text', text } 段
    const editable = wrapper.get('[role="textbox"]')
    ;(editable.element as HTMLDivElement).innerHTML = 'hello mobile'
    await editable.trigger('input')
    await wrapper.get('[data-testid="mobile-composer-send"]').trigger('click')
    await flushPromises()
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('sid-idle', [{ type: 'text', text: 'hello mobile' }])
    // onSend 的 comp.clear() 契约：发送后输入区清空
    expect((editable.element as HTMLDivElement).innerHTML).toBe('')
    wrapper.unmount()
  })

  it('无内容点击发送键：禁用态拦截（disabled 含 !hasInput），组件层不发（sendMock 不被调）', async () => {
    const wrapper = mountComposer('sid-idle')
    await flushPromises()
    expect(wrapper.get('[data-testid="mobile-composer-send"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="mobile-composer-send"]').trigger('click')
    await flushPromises()
    expect(sendMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

// ── 图片粘贴降级链（真实 paste 事件 → dom-core onPaste → pasteImage 文本降级）──
//
// 链路（消费点在 dom-core 组件内部，非 deps 直调可观测）：MobileComposer provide 的
// pasteImage（remote-use-mobile D7 图片粘贴行降级：返回文本占位）经 ComposerInput inject 转发进 dom-core
// useContenteditableInput.onPaste → pickClipboardImageItem 取剪贴板图片 File（入参 File 的
// 判据：占位 badge 只在 getAsFile() 产出 File 后插入，纯文本粘贴不触发）→ await pasteImage →
// kind:'text' 移除占位 + insertText 降级。断言落最近可观察点：占位 badge 生命周期 +
// insertText 降级文案（happy-dom 无 document.execCommand，stub spy 兼作观察点）。
// 环境说明：happy-dom 已支持 DataTransfer/ClipboardEvent/DataTransferItem.getAsFile（探针实测），
// 粘贴链所需事件范围齐备，无需 per-file 切 jsdom。
describe('图片粘贴降级链（真实 paste 事件驱动）', () => {
  const execSpy = vi.fn<(command: string, showUI?: boolean, value?: string) => boolean>(() => true)

  beforeEach(() => {
    execSpy.mockClear()
    document.execCommand = execSpy
  })

  afterEach(() => {
    delete (document as { execCommand?: unknown }).execCommand
  })

  function dispatchPaste(target: Element, dt: DataTransfer): void {
    // native dispatch 而非 test-utils trigger：保真传递构造好的 clipboardData
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }

  function expectedFallbackText(): string {
    return (i18n.global.t as (key: string) => string)('mobile.pasteImageFallback')
  }

  it('粘贴图片文件：占位 badge 出现（pasteImage 收到 File）→ 降级后移除并 insertText 占位文案', async () => {
    const wrapper = mountComposer('sid-paste')
    await flushPromises()
    const editable = wrapper.get('[role="textbox"]')
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)

    // 同步阶段：仅当剪贴板图片 item 产出 File 后才插「粘贴中」占位 badge（dom-core 检查）
    dispatchPaste(editable.element, dt)
    const pending = wrapper.find('.image-chip')
    expect(pending.exists()).toBe(true)
    expect(pending.text()).toContain('粘贴中')

    await flushPromises()

    // 降级完成（用户可见部分）：占位 badge 移除，pasteImage 的文本占位经 insertText 进输入通路
    expect(wrapper.find('.image-chip').exists()).toBe(false)
    expect(execSpy).toHaveBeenCalledWith('insertText', false, expectedFallbackText())
    wrapper.unmount()
  })

  it('粘贴纯文本（无图片 item）：不走 pasteImage 降级链，按原文 insertText', async () => {
    const wrapper = mountComposer('sid-paste')
    await flushPromises()
    const editable = wrapper.get('[role="textbox"]')
    const dt = new DataTransfer()
    dt.setData('text/plain', 'plain note')

    dispatchPaste(editable.element, dt)
    await flushPromises()

    expect(wrapper.find('.image-chip').exists()).toBe(false)
    expect(execSpy).toHaveBeenCalledWith('insertText', false, 'plain note')
    expect(execSpy).not.toHaveBeenCalledWith('insertText', false, expectedFallbackText())
    wrapper.unmount()
  })
})

// ── 锚定编辑发送分流（chat-flow-consistency D6 移动壳）与 stopTarget 两档 ──
//
// 覆盖：onSend 锚定在册 → editDelivery 原位替换（成功无乐观气泡）/ edited=false 四值降级
// （内容按普通新消息发出 + showErrorBar 分型）/ 清空草稿解除锚定 watch（Q4 解除路径 2，
// sid 守卫）/ stopTarget compacting 与 settling 档（对齐桌面 sendButtonStopTarget 规则）。
describe('锚定编辑发送分流 + stopTarget 两档（D6）', () => {
  beforeEach(() => {
    abortMock.mockClear()
    sendMock.mockClear()
    editDeliveryMock.mockClear()
    anchorOfMock.mockReset()
    clearMock.mockClear()
    sessionPhaseMock.mockReset()
    errorBarMock.mockClear()
    abortMock.mockResolvedValue(undefined)
    sendMock.mockResolvedValue(undefined)
    anchorOfMock.mockReturnValue(null)
  })

  /** 输入注入（复用上文 input 事件驱动手法）：写 innerHTML + trigger('input') */
  async function typeInput(wrapper: ReturnType<typeof mountComposer>, text: string): Promise<void> {
    const editable = wrapper.get('[role="textbox"]')
    ;(editable.element as HTMLDivElement).innerHTML = text
    await editable.trigger('input')
  }

  it('锚定在册 + editDelivery edited=true：原位替换收尾（无 send、锚定解除、输入清空）', async () => {
    anchorOfMock.mockReturnValue('u-1')
    editDeliveryMock.mockResolvedValue({ clientUuid: 'u-1', edited: true })
    const wrapper = mountComposer('sid-edit')
    await flushPromises()
    await typeInput(wrapper, 'edited text')
    await wrapper.get('[data-testid="mobile-composer-send"]').trigger('click')
    await flushPromises()
    expect(editDeliveryMock).toHaveBeenCalledWith('sid-edit', 'u-1', 'edited text')
    expect(clearMock).toHaveBeenCalledWith('sid-edit')
    expect(sendMock).not.toHaveBeenCalled()
    expect((wrapper.get('[role="textbox"]').element as HTMLDivElement).innerHTML).toBe('')
    wrapper.unmount()
  })

  it.each([
    ['delivered', 'mobile.queueStrip.editDelivered'],
    ['cancelled', 'mobile.queueStrip.editCancelled'],
    ['not-found', 'mobile.queueStrip.editNotFound'],
    [undefined, 'mobile.queueStrip.editUnconfirmed'],
  ] as const)('edited=false（reason=%s）四值降级：错误条分型 + 内容按普通新消息发出', async (reason, noticeKey) => {
    anchorOfMock.mockReturnValue('u-1')
    editDeliveryMock.mockResolvedValue({ clientUuid: 'u-1', edited: false, reason })
    const wrapper = mountComposer('sid-edit')
    await flushPromises()
    await typeInput(wrapper, 'still here')
    await wrapper.get('[data-testid="mobile-composer-send"]').trigger('click')
    await flushPromises()
    expect(errorBarMock).toHaveBeenCalledWith(i18n.global.t(noticeKey))
    expect(sendMock).toHaveBeenCalledWith('sid-edit', [{ type: 'text', text: 'still here' }])
    expect(clearMock).toHaveBeenCalledWith('sid-edit')
    wrapper.unmount()
  })

  it('清空草稿解除锚定（Q4 解除路径 2）：同会话「有内容 → 空」边沿触发 clearQueueEditFor', async () => {
    anchorOfMock.mockReturnValue('u-1')
    const wrapper = mountComposer('sid-edit')
    await flushPromises()
    await typeInput(wrapper, 'draft')
    ;(wrapper.get('[role="textbox"]').element as HTMLDivElement).innerHTML = ''
    await wrapper.get('[role="textbox"]').trigger('input')
    await flushPromises()
    expect(clearMock).toHaveBeenCalledWith('sid-edit')
    wrapper.unmount()
  })

  it('无内容 + 压缩中（compacting）：停止键渲染且档位 = 终止压缩', async () => {
    sessionPhaseMock.mockReturnValue({ turn: 'idle', compacting: true, bash: false })
    const wrapper = mountComposer('sid-compacting')
    await flushPromises()
    const stop = wrapper.get('[data-testid="mobile-composer-stop"]')
    expect(stop.attributes('aria-label')).toBe(i18n.global.t('mobile.composer.stopCompacting'))
    wrapper.unmount()
  })

  it('无内容 + settling（收尾期）：停止键渲染且档位 = 回合中止（settlement 属活跃回合）', async () => {
    sessionPhaseMock.mockReturnValue({ turn: 'settling', compacting: false, bash: false })
    const wrapper = mountComposer('sid-settling')
    await flushPromises()
    const stop = wrapper.get('[data-testid="mobile-composer-stop"]')
    expect(stop.attributes('aria-label')).toBe(i18n.global.t('mobile.composer.stop'))
    wrapper.unmount()
  })
})
