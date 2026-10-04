/**
 * Composer 三态 UI + B 策略 E2E 测试（T2.2/T2.3/T2.5/T9.14）。
 *
 * 锁定 fix-state-tearing 的 UI 层核心：
 * - u3c/D1 统一提交：busy 时 Enter / 点发送位 → 调 send（lane 判定归 runtime 内核；
 *   曾有的「busy Enter 本地转 steer」B 策略已随统一提交退役）
 * - T2.5：busy 时停止按钮始终可见（isActive 驱动 v-if="isActive"）
 * - T9.14：Composer 三态渲染回归（idle=发送按钮 / sending=spinner / busy=停止按钮）
 *
 * 策略：
 * - 真实 chat store（测的就是 store 的派生 isActive 行为）
 * - mock 骨架单源 helpers/composer-mount.ts（@/api 工厂 + ComposerInput mock + 壳 stub），
 *   useChat / useNewTaskFlow / stores/session 经 composer-shell-mount 注册；useChat spy
 *   断言引用 composerChatApiSpy 单例
 * - 子组件 stub（CommandPopover 保留 slot，其余空 div）
 * - ComposerInput mock：defineExpose + emit keydown/input（用于触发 Enter 提交）
 *
 * 运行：npx vitest run src/__tests__/panel/composer-three-states.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@taiji/shared'
// helper import 必须先于组件链（vi.mock 只 hoist 注册不重排 import，工厂执行期 helper
// 绑定须已初始化）；composer-shell-mount import 即注册壳 mock（useChat/flow/session 三枚单源）
import '../helpers/composer-shell-mount'
import { composerApiModule, composerChatApiSpy, composerChildStubs, makeComposerInputMock } from '../helpers/composer-mount'
import Composer from '@/components/panel/Composer.vue'
import { useChatStore } from '@/stores/chat'

// ── api mock 单源 helpers/composer-mount.ts；useChat 断言引用 composerChatApiSpy 单例 ──
vi.mock('@/api', () => composerApiModule())

// ── ComposerInput mock：defineExpose + emit（共用面工厂单源 helpers/composer-mount）──
// 追踪 input 事件携带的文本（Composer.onSend 调 inputRef.getSegments() 取结构化 segments）。
// 通过 emits 验证器捕获 input payload，getSegments 用 textToSegments 还原（ADR-0043）。
const { lastInputText, ComposerInputMock } = makeComposerInputMock()

const otherStubs = { ComposerInput: ComposerInputMock, ...composerChildStubs }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  lastInputText.value = ''
})

/** 经 ComposerInput mock 发键盘事件（IME 用例经 isComposing 驱动 composition 态） */
function emitKeydown(wrapper: VueWrapper, key: string, isComposing = false): void {
  wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key, isComposing }))
}

function mountComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }): VueWrapper {
  return mount(Composer, { props, global: { stubs: otherStubs } })
}

describe('T9.14 Composer 三态渲染回归', () => {
  it('idle 态：显示发送按钮（ArrowUp），无停止按钮', () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    // idle：无 stop-btn，有发送按钮
    expect(wrapper.find('.stop-btn').exists()).toBe(false)
    // 发送位是 Button（最后一个 Button）
    const sendBtn = wrapper.findAll('button').at(-1)
    expect(sendBtn?.attributes('title')).toContain('发送')
  })

  it('busy 态（isActive=true）：显示停止按钮，无发送按钮', () => {
    const chat = useChatStore()
    const sid = 's-busy'
    // 制造 streaming entity → isGenerating=true → isActive=true
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    const wrapper = mountComposer({ sessionId: sid })
    expect(chat.isActive(sid)).toBe(true)
    // 停止按钮存在
    expect(wrapper.find('.stop-btn').exists()).toBe(true)
    // 无发送按钮（v-if isActive 互斥）
    const buttons = wrapper.findAll('button')
    const sendBtns = buttons.filter((b) => b.attributes('title')?.includes('发送'))
    expect(sendBtns.length).toBe(0)
  })

  it('pendingSend 态（isActive=true via pendingSend）：停止按钮也可见', () => {
    const chat = useChatStore()
    const sid = 's-pending'
    chat.addPendingSend(sid)
    const wrapper = mountComposer({ sessionId: sid })
    expect(chat.isActive(sid)).toBe(true)
    expect(wrapper.find('.stop-btn').exists()).toBe(true)
  })
})

describe('T2.5 busy 时停止按钮始终可见', () => {
  it('streaming + pendingSend 同时存在：停止按钮仍只有一个', () => {
    const chat = useChatStore()
    const sid = 's-both'
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    chat.addPendingSend(sid)
    const wrapper = mountComposer({ sessionId: sid })
    expect(wrapper.findAll('.stop-btn')).toHaveLength(1)
  })
})

describe('[u3c/D1] busy 时 Enter → 统一提交（B 策略本地转 steer 已退役）', () => {
  it('busy 时 Enter → 调 send（lane 判定收归内核），不调 steer', async () => {
    const chat = useChatStore()
    const sid = 's-steer-enter'
    // 制造 busy 态
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    const wrapper = mountComposer({ sessionId: sid })
    expect(chat.isActive(sid)).toBe(true)

    // 输入文本（让 hasInput=true）
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '补充内容')
    await wrapper.vm.$nextTick()

    // 模拟 Enter 键
    emitKeydown(wrapper, 'Enter')
    // onSend 是多层 async 链（core D6 分发器），统一单 flushPromises 清空整条 microtask
    // 链后再断言（拍数式 nextTick 不够 flush，全文件断言前统一此形态）
    await flushPromises()

    expect(composerChatApiSpy.send).toHaveBeenCalledWith(sid, textToSegments('补充内容'))
  })
})

describe('T2.3 B 策略：idle 时 Enter → send', () => {
  it('idle 时 Enter → 调 send，不调 steer', async () => {
    const wrapper = mountComposer({ sessionId: 's-send-enter' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '第一条消息')
    await wrapper.vm.$nextTick()

    emitKeydown(wrapper, 'Enter')
    // 同 [u3c/D1] 用例：单 flushPromises 清空 D6 分发器整条 async 链后再断言
    await flushPromises()

    expect(composerChatApiSpy.send).toHaveBeenCalledWith('s-send-enter', textToSegments('第一条消息'))
  })
})

describe('T2.x IME composition 中 Enter 不触发 send/steer', () => {
  it('idle 态 composition 中 Enter 不触发 send', async () => {
    const wrapper = mountComposer({ sessionId: 's-ime-idle' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '你好')
    await wrapper.vm.$nextTick()

    // compositionstart（模拟中文输入法开始）
    emitKeydown(wrapper, 'Process')
    // Enter + isComposing: true（拼音未确认）
    emitKeydown(wrapper, 'Enter', true)
    await flushPromises()

    // 不应调 send
    expect(composerChatApiSpy.send).not.toHaveBeenCalled()
  })

  it('idle 态 composition 结束后 Enter 正常 send', async () => {
    const wrapper = mountComposer({ sessionId: 's-ime-idle-end' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '你好世界')
    await wrapper.vm.$nextTick()

    // compositionstart → Enter (isComposing, 不触发)
    emitKeydown(wrapper, 'Enter', true)
    await wrapper.vm.$nextTick()
    expect(composerChatApiSpy.send).not.toHaveBeenCalled()

    // compositionend → 正常 Enter (isComposing=false, 触发 send)
    emitKeydown(wrapper, 'Enter', false)
    // 同 [u3c/D1] 用例：单 flushPromises 清空 D6 分发器整条 async 链后再断言
    await flushPromises()

    expect(composerChatApiSpy.send).toHaveBeenCalledWith('s-ime-idle-end', textToSegments('你好世界'))
  })

  it('busy 态 composition 中 Enter 不触发 steer', async () => {
    const chat = useChatStore()
    const sid = 's-ime-busy'
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    const wrapper = mountComposer({ sessionId: sid })
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '补充')
    await wrapper.vm.$nextTick()

    // composition 中 Enter → 不触发提交
    emitKeydown(wrapper, 'Enter', true)
    await flushPromises()

    expect(composerChatApiSpy.send).not.toHaveBeenCalled()
  })
})

describe('停止按钮点击 → abort', () => {
  it('busy 态点停止按钮 → 调 abort', async () => {
    const chat = useChatStore()
    const sid = 's-abort'
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    const wrapper = mountComposer({ sessionId: sid })
    await wrapper.find('.stop-btn').trigger('click')
    expect(composerChatApiSpy.abort).toHaveBeenCalled()
  })
})
