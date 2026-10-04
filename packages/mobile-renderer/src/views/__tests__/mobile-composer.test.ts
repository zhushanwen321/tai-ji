// MobileComposer 发送契约测试（remote-use D6/U8：发送失败草稿回填 + 内联错误行）。
//
// D6 契约（core useChat R2-A5 失败信号）：send 返回 false = RPC 失败（内部已消化、
// 契约内不 throw）→ ComposerInput 回填原文本（setSegments）+ 内联错误行（复用 form
// 通道 respondFailedId 范式：role=alert + 专用 testid + locale 文案）；comp.clear()
// 只在成功分支执行——失败不丢草稿（V5：飞行模式发送 → 文本恢复 + 错误可见）。
//
// app-runtime 模块级 mock：隔离 core WS 依赖（测试禁触网络）。失败用例经手工控
// resolve 时序构造「发送在途期间输入被清空」窗口，使 setSegments 回填成为可观察
// 行为（输入先空、失败后文本回来——区别于「从未清空」的平凡通过）。
//
// setSegments 接口存在性（设计 §5.4 检查点4）单独断言：ComposerInput 直挂，
// text + file 混合段回填后 getSegments 往返一致。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { HandleImagePasteResult } from '@taiji/dom-core/composer/input'
import type { Segment } from '@taiji/shared'
import MobileComposer from '../MobileComposer.vue'
import { ComposerInput, ComposerInputDepsKey } from '@taiji/ui/features/composer'
import type { ComposerInputDeps } from '@taiji/ui/features/composer'
import { i18n } from '../../i18n'

// vi.hoisted：mock 工厂被 hoist 到 import 前，工厂内引用的变量须经 vi.hoisted 创建
const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn<(sid: string, segments: unknown[]) => Promise<boolean>>(),
}))

vi.mock('../../shell/app-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shell/app-runtime')>()
  return {
    ...actual,
    chatStore: {
      ...actual.chatStore,
      // 组件模板按 isActive 分支渲染中断/发送键；非活跃 sid 走发送分支
      isActive: (sid: string) => sid === 'sid-active',
      getMessages: () => [],
    },
    useChatInstance: {
      ...actual.useChatInstance,
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

/** 输入注入参照 ui composer-input-get-text.test.ts：直接写 [role="textbox"] 的 innerHTML
 * （getSegments 从 DOM 遍历提取，与 input 事件无关）；纯文本产出 { type:'text', text } 段 */
function writeDraft(wrapper: ReturnType<typeof mountComposer>, text: string): void {
  ;(wrapper.get('[role="textbox"]').element as HTMLDivElement).innerHTML = text
}

function readDraft(wrapper: ReturnType<typeof mountComposer>): string {
  return (wrapper.get('[role="textbox"]').element as HTMLDivElement).innerHTML
}

function tOf(key: string): string {
  return (i18n.global.t as (key: string) => string)(key)
}

beforeEach(() => {
  sendMock.mockClear()
  sendMock.mockResolvedValue(true)
})

describe('MobileComposer 发送失败契约（D6：false → 草稿回填 + 内联错误行）', () => {
  it('send false：草稿回填（setSegments 通路）+ 内联错误行可见（role=alert + 文案）', async () => {
    // 手工控 resolve：send 在途期间模拟用户清空输入，回填才可观察
    let resolveSend!: (delivered: boolean) => void
    sendMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve
        }),
    )
    const wrapper = mountComposer('sid-idle')
    await flushPromises()
    writeDraft(wrapper, 'hello draft')
    await wrapper.get('[data-testid="mobile-composer-send"]').trigger('click')
    // 发送在途（send 未 resolve）：输入被清空
    writeDraft(wrapper, '')
    expect(readDraft(wrapper)).toBe('')

    resolveSend(false)
    await flushPromises()

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('sid-idle', [{ type: 'text', text: 'hello draft' }])
    // D6 用户可见面①：原文回填（可重发，不静默丢输入）
    expect(readDraft(wrapper)).toBe('hello draft')
    // D6 用户可见面②：内联错误行（form 通道 respondFailedId 范式）
    const errLine = wrapper.find('[data-testid="mobile-composer-send-error"]')
    expect(errLine.exists()).toBe(true)
    expect(errLine.attributes('role')).toBe('alert')
    expect(errLine.text()).toBe(tOf('mobile.composer.sendFailed'))
    wrapper.unmount()
  })

  it('send false 后重发成功：clear 照常执行 + 旧错误行不残留（respondFailedId 范式：新尝试不残留）', async () => {
    sendMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const wrapper = mountComposer('sid-idle')
    await flushPromises()
    writeDraft(wrapper, 'retry me')
    await wrapper.get('[data-testid="mobile-composer-send"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-composer-send-error"]').exists()).toBe(true)
    expect(readDraft(wrapper)).toBe('retry me')

    // 第二次尝试（成功）：清空 + 错误行摘除
    await wrapper.get('[data-testid="mobile-composer-send"]').trigger('click')
    await flushPromises()
    expect(sendMock).toHaveBeenCalledTimes(2)
    expect(readDraft(wrapper)).toBe('')
    expect(wrapper.find('[data-testid="mobile-composer-send-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('切换 session：旧会话的错误行不残留（错误归属被失败的发送尝试，不跨会话跟随）', async () => {
    sendMock.mockResolvedValue(false)
    const wrapper = mountComposer('sid-a')
    await flushPromises()
    writeDraft(wrapper, 'lost in flight')
    await wrapper.get('[data-testid="mobile-composer-send"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-composer-send-error"]').exists()).toBe(true)

    await wrapper.setProps({ sessionId: 'sid-b' })
    expect(wrapper.find('[data-testid="mobile-composer-send-error"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('MobileComposer 发送成功契约（D6：true → clear 照常）', () => {
  it('send true：发送后输入区清空 + 不出现错误行', async () => {
    sendMock.mockResolvedValue(true)
    const wrapper = mountComposer('sid-idle')
    await flushPromises()
    writeDraft(wrapper, 'hello mobile')
    await wrapper.get('[data-testid="mobile-composer-send"]').trigger('click')
    await flushPromises()
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('sid-idle', [{ type: 'text', text: 'hello mobile' }])
    expect(readDraft(wrapper)).toBe('')
    expect(wrapper.find('[data-testid="mobile-composer-send-error"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

// ── ComposerInput setSegments 接口（设计 §5.4 检查点4：无则补接口，此处断言存在 + 回填语义）──
describe('ComposerInput.setSegments 接口（§5.4 检查点4）', () => {
  const deps: ComposerInputDeps = {
    pasteImage: async (): Promise<HandleImagePasteResult> => ({ kind: 'text', text: '[图片粘贴：需桌面环境]' }),
    renderIcon: () => false,
    t: (key: string) => key,
  }

  /** expose 方法在 vm 上运行时可用，TS 类型需断言（defineExpose 不产生公开类型） */
  function exposed(wrapper: ReturnType<typeof mount>) {
    return wrapper.vm as unknown as {
      setSegments: (segments: Segment[]) => void
      getSegments: () => Segment[]
      getText: () => string
    }
  }

  it('接口存在：text + file 混合段回填后 getSegments 往返一致（file 段还原为真 chip）', () => {
    const wrapper = mount(ComposerInput, {
      global: { provide: { [ComposerInputDepsKey as symbol]: deps } },
    })
    const vm = exposed(wrapper)
    expect(typeof vm.setSegments).toBe('function')
    const segments: Segment[] = [
      { type: 'text', text: 'see ' },
      { type: 'file', path: '/a.ts', lineRange: [1, 2] },
    ]
    vm.setSegments(segments)
    // getText 按发送序列化形态返回（file 段拍平为 path 范围文本，segmentsToText 契约）
    expect(vm.getText()).toBe('see /a.ts:L1-L2')
    // 回填语义的核心断言：getSegments 往返一致（file 段还原为真 chip，非拍平文本）
    expect(vm.getSegments()).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'file', path: '/a.ts', lineRange: [1, 2] },
    ])
    wrapper.unmount()
  })

  it('多行文本回填：\\n 还原为换行（失败草稿不丢软换行）', () => {
    const wrapper = mount(ComposerInput, {
      global: { provide: { [ComposerInputDepsKey as symbol]: deps } },
    })
    const vm = exposed(wrapper)
    vm.setSegments([{ type: 'text', text: 'line1\nline2' }])
    expect(vm.getText()).toBe('line1\nline2')
    wrapper.unmount()
  })
})
