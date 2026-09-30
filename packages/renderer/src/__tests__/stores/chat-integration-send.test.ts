/**
 * useChat 集成测试（T1.4/T1.5/T5.1）—— send 全链 + 失败回滚 + editAndResend pendingSend 对称。
 *
 * T1.4: idle + send(text) → appendUser + addPendingSend + api.send → message_start → clearPendingSend
 * T1.5: send + api.send reject → clearPendingSend（[W2] 不 throw，toast 消化错误）
 * T5.1: editAndResend → truncate + appendUser + addPendingSend + send, catch → clearPendingSend
 *
 * [MANDATORY] 集成用例补 DOM 断言：mount(Composer) 验证 send 全链/失败后 composer-box 可见 + 用户可重试态。
 *
 * 运行：npx vitest run src/__tests__/stores/chat-integration-send.test.ts
 */
import { describe, it, expect } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { textToSegments, normalizeContent } from '@taiji/shared'
// Composer 集成装配单源：import 即注册 '@/api'（chat 组 = chatStreamApiSpy 断言锚）+
// useNewTaskFlow/useToast/useComposerModelThinking 三深依赖，并提供 ComposerInput stub 与
// mountComposer——import 必须先于被测组件 import（'@/api' 工厂 TDZ 坑，同族先例见 helper 头注释）。
import { setupComposerChatIntegrationHarness } from '@/__tests__/helpers/composer-integration-mount'
import { chatStreamApiSpy, emitChatStreamMessage } from '@/__tests__/helpers/api-facade-mock'

import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useChat } from '@/composables/features/chat/useChat'

const { ComposerInputMock, mountComposer } = setupComposerChatIntegrationHarness()

describe('T1.4 useChat.send 全链', () => {
  it('send(text) → appendUser + addPendingSend + api.send → message_start → clearPendingSend', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-fullchain', textToSegments('hello'))
    // 1. appendUser：消息列表有 user 气泡
    const msgs = chat.getMessages('s-fullchain')
    expect(msgs.some((m) => m.role === 'user' && normalizeContent(m.content) === 'hello')).toBe(true)
    // 2. addPendingSend：isActive=true（空窗期）
    expect(chat.isActive('s-fullchain')).toBe(true)
    // 3. api.send 被调（图片走路径模式，send 第二参数 promptText，无 images 通道）
    // 纯文本轮不加 clientUuid 标记后缀（最小写入：textToSegments 降级渲染等价，无需映射）
    // 第 4 参 options.clientUuid（session-occupancy D2）经 ChatApiPort 适配转发，等于乐观气泡 id
    expect(chatStreamApiSpy.send).toHaveBeenCalledWith(
      's-fullchain',
      'hello',
      undefined,
      { clientUuid: msgs.find((m) => m.role === 'user')!.id },
    )
    // 4. message_start 到达 → clearPendingSend
    emitChatStreamMessage({ type: 'message.message_start', payload: { sessionId: 's-fullchain', messageId: 'a1' } })
    // message_start 后 isGenerating=true（streaming entity 存在），isActive 仍 true
    expect(chat.isGenerating('s-fullchain')).toBe(true)
    expect(chat.isActive('s-fullchain')).toBe(true)
  })
})

describe('T1.5 send api.send 失败回滚', () => {
  it('api.send reject → clearPendingSend（[W2] 不 throw，toast 消化错误）', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    chatStreamApiSpy.send.mockRejectedValueOnce(new Error('ws disconnected'))
    // [W2] send 失败不再 throw（与 steer/followUp/abort 对齐：clearPendingSend + toast，不 throw）；
    // [form-hang-fix] send 契约 Promise<boolean>：直发失败已 toast 消化 → true（false 仅属 B 策略）
    await expect(send('s-fail', textToSegments('hello'))).resolves.toBe(true)
    // clearPendingSend：isActive 恢复 false（无 streaming entity + 无 pendingSend）
    expect(chat.isActive('s-fail')).toBe(false)
  })
})

describe('T5.1 editAndResend pendingSend 对称', () => {
  it('editAndResend → truncate + appendUser + addPendingSend + send', async () => {
    const session = useSessionStore()
    session.activeId = 's-edit'
    const chat = useChatStore()
    // 先注入历史消息（供 truncateFrom 操作）
    chat.appendUser('s-edit', textToSegments('原问题'))
    const userMsg = chat.getMessages('s-edit').find((m) => m.role === 'user')!
    const { editAndResend } = useChat()
    // 阶段 3a：editAndResend 签名从 (sid, id, text: string) 改为 (sid, id, segments: Segment[])，
    // 内部委托 submitSegments（走 segmentsToPrompt + chatApi.send）。
    await editAndResend('s-edit', userMsg.id, textToSegments('edited text'))
    // api.send 被调（editAndResend 内部走 submitSegments → chatApi.send）
    // 纯文本轮不加 clientUuid 标记后缀（最小写入，与 send 同通路）
    // 第 4 参 options.clientUuid（session-occupancy D2）= 编辑重发的新乐观气泡 id
    const resentUserMsg = chat.getMessages('s-edit').filter((m) => m.role === 'user').at(-1)!
    expect(chatStreamApiSpy.send).toHaveBeenCalledWith('s-edit', 'edited text', undefined, {
      clientUuid: resentUserMsg.id,
    })
    // addPendingSend：isActive=true（空窗期）
    expect(chat.isActive('s-edit')).toBe(true)
  })

  it('editAndResend api.send 失败 → clearPendingSend（[W2] 不 throw，不留孤儿）', async () => {
    const session = useSessionStore()
    session.activeId = 's-edit-fail'
    const chat = useChatStore()
    chat.appendUser('s-edit-fail', textToSegments('原问题'))
    const userMsg = chat.getMessages('s-edit-fail').find((m) => m.role === 'user')!
    chatStreamApiSpy.send.mockRejectedValueOnce(new Error('ws disconnected'))
    const { editAndResend } = useChat()
    // [W2] editAndResend 失败不再 throw（与 steer/followUp/abort 对齐）
    await expect(editAndResend('s-edit-fail', userMsg.id, textToSegments('text'))).resolves.toBeUndefined()
    // 失败后 pendingSend 被清（isActive=false，无 streaming）
    expect(chat.isActive('s-edit-fail')).toBe(false)
  })

  it('editAndResend guard：busy 时早退（isActive=true 不执行）', async () => {
    const session = useSessionStore()
    session.activeId = 's-edit-busy'
    const chat = useChatStore()
    chat.addPendingSend('s-edit-busy')
    expect(chat.isActive('s-edit-busy')).toBe(true)
    const { editAndResend } = useChat()
    // busy 时早退，不 throw，不调 send
    await expect(editAndResend('s-edit-busy', 'msg-id', textToSegments('text'))).resolves.toBeUndefined()
    expect(chatStreamApiSpy.send).not.toHaveBeenCalled()
  })
})

/**
 * [MANDATORY] 集成用例 DOM 断言：mount(Composer) 验证 send 全链/失败的用户可见行为。
 *
 * 走真实 useChat().send → Composer.onSend → store 状态驱动 DOM 三态渲染。
 * 断言用户可见 DOM（composer-box / stop-btn / 发送按钮）随 store 状态变化。
 */
describe('T1.4/T1.5 send 全链 Composer DOM 断言（用户可见行为）', () => {
  it('send 后 message_start 到达 → Composer 转停止按钮态（DOM 可见）', async () => {
    const session = useSessionStore()
    session.activeId = 's-dom-start'
    // idle 态先挂载：显示发送按钮、无停止按钮
    const wrapper = mountComposer('s-dom-start')
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    expect(wrapper.find('.stop-btn').exists()).toBe(false)
    // 用户输入 → Enter 触发真实 useChat.send（走 mock api.send → resolve）
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '第一条消息')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
    // flushPromises 排空全部 microtask（send 链路 + Vue render job），不依赖固定 nextTick 计数
    // ——U24/U25 onSend phase extraction（commit 8c9e2da43）的 async helper 包装使 render flush
    // 晚一个 microtask hop（详见 chat-send-rejected.test.ts 同注释）。
    await flushPromises()
    // message_start 到达 → isGenerating=true → isActive=true
    emitChatStreamMessage({ type: 'message.message_start', payload: { sessionId: 's-dom-start', messageId: 'a1' } })
    await flushPromises()
    // DOM 断言：停止按钮可见（用户可中断当前回合）
    expect(wrapper.find('.stop-btn').exists()).toBe(true)
  })

  it('send 失败后 Composer 回到可重试态（composer-box 可见 + 无停止按钮）', async () => {
    const session = useSessionStore()
    session.activeId = 's-dom-fail'
    const chat = useChatStore()
    // api.send reject（useChat.send 内部 catch + clearPendingSend，[W2] 不 throw）
    chatStreamApiSpy.send.mockRejectedValueOnce(new Error('ws disconnected'))
    const wrapper = mountComposer('s-dom-fail')
    // 用户输入 → Enter 触发 send
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '要发的消息')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
    // flushPromises 排空全部 microtask（含 submitSegments await chatApi.send 的 reject + catch
    // + clearPendingSend 后的 render flush），不依赖固定 nextTick 计数（同上注释）。
    await flushPromises()
    // store 侧：pendingSend 已清，无 streaming → isActive=false（用户可重试）
    expect(chat.isActive('s-dom-fail')).toBe(false)
    await flushPromises()
    // DOM 断言 1：composer-box 仍渲染（输入区未消失）
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    // DOM 断言 2：无停止按钮（非活跃态，用户可重新发送）
    expect(wrapper.find('.stop-btn').exists()).toBe(false)
  })
})
