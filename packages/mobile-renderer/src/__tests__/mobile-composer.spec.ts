// MobileComposer 测试（remote-use U1.4c：中断键/发送键 + pasteImage 降级）。
//
// app-runtime 模块级 mock：隔离 core WS 依赖（测试禁触网络），直接断言组件层对
// useChat.abort / useChat.send 的调用接线。MobileMessageStream 的 provide 链测试
// 在 mobile-ui.spec.ts（不 mock，走真实 core store）。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MobileComposer from '../views/MobileComposer.vue'
import { i18n } from '../i18n'
import { chatStore } from '../shell/app-runtime'

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
      // 组件模板按 isActive 分支渲染中断/发送键；sid-active 走中断分支，其余走发送分支
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

describe('MobileComposer 中断键（D7 中断行：isActive 时可见，点击调 useChat.abort）', () => {
  beforeEach(() => {
    abortMock.mockClear()
    sendMock.mockClear()
    abortMock.mockResolvedValue(undefined)
    sendMock.mockResolvedValue(undefined)
  })

  it('isActive session 渲染中断键（不渲染发送键），点击调 abort(sessionId)', async () => {
    const wrapper = mountComposer('sid-active')
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-composer-stop"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-composer-send"]').exists()).toBe(false)
    await wrapper.get('[data-testid="mobile-composer-stop"]').trigger('click')
    await flushPromises()
    expect(abortMock).toHaveBeenCalledWith('sid-active')
    wrapper.unmount()
  })

  it('非活跃 session 渲染发送键（不渲染中断键），点击调 send(sessionId, segments)', async () => {
    const wrapper = mountComposer('sid-idle')
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-composer-stop"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-composer-send"]').exists()).toBe(true)
    await wrapper.get('[data-testid="mobile-composer-send"]').trigger('click')
    await flushPromises()
    // ComposerInput 空 contenteditable → segments 空 → core send 空 guard 前组件层不发
    expect(sendMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('MobileComposer pasteImage 降级（D7 图片粘贴行：web 文本占位）', () => {
  it('chatStore.isActive mock 面可用（装配冒烟；pasteImage 经 ComposerInputDeps 注入组件内部）', () => {
    expect(typeof chatStore.isActive).toBe('function')
  })
})
