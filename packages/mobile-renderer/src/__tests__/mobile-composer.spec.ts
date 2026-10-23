// MobileComposer 测试（remote-use U1.4c：中断键/发送键——发送正路 segments 形状 +
// 空输入检查；图片粘贴降级链以真实 paste 事件驱动，断言落 DOM 观察点）。
//
// [chat-flow-consistency D5] 发送位改内容驱动双形态：有内容=发送（排队去向叠角标）、
// 无内容+占用=停止、无内容+空闲=禁用占位（disabled 含 !hasInput）——发送/停止互斥分支
// 由 showStop 判定（occupancy 派生 + 乐观投影），不再是 isActive 单信号。
//
// app-runtime 模块级 mock：隔离 core WS 依赖（测试禁触网络），直接断言组件层对
// useChat.abort / useChat.send 的调用接线。MobileMessageStream 的 provide 链测试
// 在 mobile-ui.spec.ts（不 mock，走真实 core store）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MobileComposer from '../views/MobileComposer.vue'
import { i18n } from '../i18n'

// vi.hoisted：mock 工厂被 hoist 到 import 前，工厂内引用的变量须经 vi.hoisted 创建
const { abortMock, sendMock } = vi.hoisted(() => ({
  abortMock: vi.fn<(sid: string) => Promise<void>>(),
  sendMock: vi.fn<(sid: string, segments: unknown[]) => Promise<void>>(),
}))

vi.mock('../shell/app-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shell/app-runtime')>()
  return {
    ...actual,
    chatStore: {
      ...actual.chatStore,
      // 乐观窗成分（D5-4：本地 send 的乐观置位先于 occupancy 广播）：sid-active 投影
      // dispatching → 无内容走停止分支，其余会话全 idle（sessionPhase 走真实现缺省）
      isActive: (sid: string) => sid === 'sid-active',
      getMessages: () => [],
    },
    useChatInstance: {
      ...actual.useChatInstance,
      abort: abortMock,
      send: sendMock,
    },
  }
})

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
    abortMock.mockResolvedValue(undefined)
    sendMock.mockResolvedValue(undefined)
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
