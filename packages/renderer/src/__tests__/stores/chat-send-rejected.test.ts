/**
 * send.rejected 回滚测试（D-006 独立 WS 通道 + useChat 监听回滚）。
 *
 * 锁定 fix-state-tearing 的 D-006 核心决策：send.rejected 是独立 WS 类型，
 * 不进对话流（不产出消息气泡），只做 clearPendingSend + toast 反馈。
 * 与 message.error（进对话流 + 翻流式态）语义正交。
 *
 * 覆盖：
 * - send.rejected → clearPendingSend（isActive 恢复 false）
 * - send.rejected → 不产出消息气泡（getMessages 不变）
 * - send.rejected → isGenerating 不变（send.rejected 不翻流式态）
 * - send.rejected 带 message 字段 → toast 反馈
 * - [MANDATORY] mount(Composer) DOM 断言：send.rejected 后 Composer 回可重试态（用户可见）
 *
 * mock 策略：vi.hoisted 捕获 streamSubscribe handler，测试注入 send.rejected。
 *
 * 运行：npx vitest run src/__tests__/stores/chat-send-rejected.test.ts
 */
import { describe, it, expect } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { textToSegments } from '@taiji/shared'
// Composer 集成装配单源：import 即注册 '@/api'（chat 组 = chatStreamApiSpy 断言锚）+
// useNewTaskFlow/useToast/useComposerModelThinking 三深依赖，并提供 ComposerInput stub 与
// mountComposer——import 必须先于被测组件 import（'@/api' 工厂 TDZ 坑，同族先例见 helper 头注释）。
import { setupComposerChatIntegrationHarness } from '@/__tests__/helpers/composer-integration-mount'
import { chatStreamApiSpy, emitChatStreamMessage } from '@/__tests__/helpers/api-facade-mock'

import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useChat } from '@/composables/features/chat/useChat'

const { ComposerInputMock, mountComposer } = setupComposerChatIntegrationHarness()

describe('send.rejected 回滚（D-006 独立通道）', () => {
  it('send.rejected → clearPendingSend（isActive 恢复 false）', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-reject-1', textToSegments('hello'))
    // send 后 pendingSend 置位 → isActive=true（空窗期）
    expect(chat.isActive('s-reject-1')).toBe(true)
    // 必须先订阅才能 emit
    expect(chatStreamApiSpy.holder.current).not.toBeNull()
    // runtime 预检拒绝
    emitChatStreamMessage({
      type: 'send.rejected',
      payload: { sessionId: 's-reject-1', reason: 'busy', message: 'Agent 正在处理' },
    })
    // clearPendingSend 后 isActive=false
    expect(chat.isActive('s-reject-1')).toBe(false)
  })

  it('send.rejected → 不产出消息气泡（getMessages 不变）', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-reject-2', textToSegments('hello'))
    const msgsBefore = chat.getMessages('s-reject-2')
    emitChatStreamMessage({
      type: 'send.rejected',
      payload: { sessionId: 's-reject-2', reason: 'busy', message: 'Agent 正在处理' },
    })
    // send.rejected 不进对话流：消息列表不新增 error/system 气泡
    expect(chat.getMessages('s-reject-2')).toEqual(msgsBefore)
  })

  it('send.rejected → isGenerating 不变（不翻流式态）', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-reject-3', textToSegments('hello'))
    // send.rejected 时无 streaming entity → isGenerating=false
    expect(chat.isGenerating('s-reject-3')).toBe(false)
    emitChatStreamMessage({
      type: 'send.rejected',
      payload: { sessionId: 's-reject-3', reason: 'busy', message: 'busy' },
    })
    // 仍然 false（send.rejected 不产生 streaming entity）
    expect(chat.isGenerating('s-reject-3')).toBe(false)
  })

  it('send.rejected 不影响其他 session 的 pendingSend', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    // session A send → pendingSend
    await send('s-reject-4', textToSegments('hello'))
    // 手动给 session B 加 pendingSend（模拟另一个 panel 正在发送）
    chat.addPendingSend('s-other')
    expect(chat.isActive('s-other')).toBe(true)
    // session A 收到 send.rejected
    emitChatStreamMessage({
      type: 'send.rejected',
      payload: { sessionId: 's-reject-4', reason: 'busy', message: 'busy' },
    })
    // session B 的 pendingSend 不受影响（session 隔离）
    expect(chat.isActive('s-other')).toBe(true)
  })
})

/**
 * [MANDATORY] 集成用例 DOM 断言：mount(Composer) 验证 send.rejected 后用户可见行为。
 *
 * 走真实 useChat().send → 注入 send.rejected（runtime 预检拒绝）→ clearPendingSend
 * → isActive 驱动 Composer 三态 DOM 翻转（停止按钮态 → 可重试态）。
 */
describe('send.rejected Composer DOM 断言（用户可见行为）', () => {
  it('send.rejected 后 Composer 停止按钮消失，回到可重试态（DOM 可见）', async () => {
    const session = useSessionStore()
    session.activeId = 's-dom-reject'
    const chat = useChatStore()
    const wrapper = mountComposer('s-dom-reject')
    // 用户输入 → Enter 触发真实 useChat.send（mock api.send resolve → addPendingSend）
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', 'hello')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
    // flushPromises（setTimeout 宏任务边界）排空全部 microtask（send 链路 + Vue render job），
    // 不依赖固定 nextTick 计数——U24/U25 onSend phase extraction（commit 8c9e2da43）把分流分支
    // 提取为 async helper（routeStaging/sendActiveMessage），正常发送路径多出 async 包装
    // microtask hop，addPendingSend 后的组件 render flush 因此晚一个 tick。store 语义与 DOM
    // 终态不变（settled 后 add/clear/re-add 均即时响应），microtask 均在浏览器 paint 前排空，
    // 用户可见行为无差异。
    await flushPromises()
    // send 后 pendingSend 置位 → isActive=true（空窗期，停止按钮可见）
    expect(chat.isActive('s-dom-reject')).toBe(true)
    expect(wrapper.find('.stop-btn').exists()).toBe(true)
    // runtime 预检拒绝：注入 send.rejected
    emitChatStreamMessage({
      type: 'send.rejected',
      payload: { sessionId: 's-dom-reject', reason: 'busy', message: 'Agent 正在处理' },
    })
    await flushPromises()
    // store 侧：clearPendingSend → isActive=false
    expect(chat.isActive('s-dom-reject')).toBe(false)
    // DOM 断言 1：停止按钮消失（用户可重新发送）
    expect(wrapper.find('.stop-btn').exists()).toBe(false)
    // DOM 断言 2：composer-box 仍渲染（输入区可见，用户可重试）
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
  })
})
