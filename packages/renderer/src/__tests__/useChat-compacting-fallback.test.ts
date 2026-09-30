// @vitest-environment node

/**
 * useChat × useCompactQueue 集成单测 —— send.rejected compacting 兜底入队
 * （session-occupancy-send-closure——已删除，git 可追溯——u3-p1-renderer）。
 *
 * 与 core 侧 useChat.test.ts（mock compactQueue）互补：本文件走 renderer 薄包装
 * （createUseChat + 真实 useCompactQueue 单例 + 真实 chat store），锁定接线层：
 * - 验收① compacting 拒绝 → 真实 compactQueue 入队恰一次（text 为原文）+ 乐观气泡回滚
 *   + inflight 回滚（store/composable 层状态断言）
 * - 验收② busy 拒绝 → 静默入队（[u5b] P3 全 reason——flush 触发源已切 occupancy idle，
 *   busy 拒绝入队等 bash/turn 结束即投递，不再有「等不到触发源」滞留）
 * - 验收④ clientUuid 经 renderer chatApi 实现透传（options.clientUuid = 乐观气泡 id）
 *
 * mock 策略对齐 src/__tests__/useChat.test.ts：chatStreamApiSpy 单例捕获 streamSubscribe
 * 回调，测试经 emitChatStreamMessage 注入 ServerMessage。时序模拟 WS FIFO：rejected 广播先于
 * RPC reply（emit 在 send await 收口前）。每用例唯一 sid + beforeEach 清队列分区与模块级状态（测试隔离）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/useChat-compacting-fallback.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage } from '@taiji/shared'
import { textToSegments } from '@taiji/shared'
// '@/api' mock 工厂解引用的 helper import 必须先于触发工厂执行的 import（useChat 链）求值
import { apiProjectMock, chatApiStreamGroup, chatStreamApiSpy, emitChatStreamMessage, sessionSubscribeBaselineMock } from './helpers/api-facade-mock'

vi.mock('@/api', () => ({
  project: apiProjectMock(),
  chat: chatApiStreamGroup(),
  session: sessionSubscribeBaselineMock(),
}))

import { useChatStore } from '@/stores/chat'
import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'

beforeEach(() => {
  setActivePinia(createPinia())
  resetChatModuleState()
  vi.clearAllMocks()
  chatStreamApiSpy.holder.current = null
  // 预创建 compactQueue 单例（绑定测试 effect scope——App.vue setup 是生产作用域，
  // 测试内显式 scope 等价），并清空分区防跨用例泄漏
  effectScope(true).run(() => useCompactQueue())!._clearAllForTest()
})

describe('send.rejected compacting 兜底入队（renderer 集成）', () => {
  it('验收① compacting 拒绝 → 真实队列入队恰一次 + 乐观气泡/inflight 回滚', async () => {
    const chat = useChatStore()
    const queue = useCompactQueue()
    const { send } = useChat()

    // WS FIFO 时序：send 同步段（乐观插入 + 记录 + 订阅）完成后、RPC reply 前注入 rejected
    const p = send('f1', textToSegments('压缩结束后再发'))
    emitChatStreamMessage({
      type: 'send.rejected',
      payload: { sessionId: 'f1', reason: 'compacting', message: 'Agent 正在处理' },
    } as ServerMessage)
    await p

    // 真实 compactQueue：入队恰一次、原文入队（flush 重放直发原文）。
    // [簇 A2] 提交 ≠ 投递（decf7d289）：send.rejected 前该条目已经历一次 flush 提交
    //（提交即写 mode='send'），拒绝后条目留队等 occupancy idle 重投，mode 不回滚。
    // [defer segments 化] rejected 重入队包 text 单段 + 同步写 submitText（u1 契约）。
    expect(queue.peek('f1')).toEqual([{
      id: expect.any(String),
      text: '压缩结束后再发',
      mode: 'send',
      segments: [{ type: 'text', text: '压缩结束后再发' }],
      submitText: '压缩结束后再发',
    }])
    // 乐观气泡回滚：对话流无残留 user 气泡
    expect(chat.getMessages('f1').length).toBe(0)
    // inflight：乐观发送占位经 rejected 回滚后，flush 重投挂上 send 占位（[簇 A2] 提交 ≠
    // 投递，u4b/F5：占位挂着等 message_end(user) 确认回收）——与条目 mode='send' 一致
    expect(chat.getInflight('f1')).toBe(1)
  })

  it('验收② busy 拒绝 → 回滚生效 + 静默入队（P3 全 reason，无 toast）', async () => {
    const chat = useChatStore()
    const queue = useCompactQueue()
    const { send } = useChat()

    const p = send('f2', textToSegments('hi'))
    emitChatStreamMessage({
      type: 'send.rejected',
      payload: { sessionId: 'f2', reason: 'busy', message: 'Agent 正在处理' },
    } as ServerMessage)
    await p

    // [u5b / D2 P3] busy 拒绝静默入队（原文入队，occupancy 回 idle 自动投递）；
    // [簇 A2] mode='send' = 已经历 flush 提交的标记（提交 ≠ 投递，同验收①）；
    // [defer segments 化] segments/submitText 字段同验收①（u1 契约）。
    expect(queue.peek('f2')).toEqual([{
      id: expect.any(String),
      text: 'hi',
      mode: 'send',
      segments: [{ type: 'text', text: 'hi' }],
      submitText: 'hi',
    }])
    expect(chat.getMessages('f2').length).toBe(0)
    // inflight：同验收①——rejected 回滚乐观占位后，flush 重投挂 send 占位在途（等确认回收）
    expect(chat.getInflight('f2')).toBe(1)
  })

  it('验收④ 正常发送 → clientUuid 经 renderer chatApi 透传（= 乐观气泡 id）', async () => {
    const chat = useChatStore()
    const { send } = useChat()

    await send('f3', textToSegments('hello'))

    expect(chatStreamApiSpy.send).toHaveBeenCalledTimes(1)
    // 域函数 4 参形态（sessionId, text, images, options）：images 位不传，options.clientUuid
    // 经 ChatApiPort 适配转发（薄包装 chatApiPort.send）
    const [sid, text, images, options] = chatStreamApiSpy.send.mock.calls[0] as unknown as [
      string, string, Array<unknown> | undefined, { clientUuid?: string },
    ]
    expect(sid).toBe('f3')
    expect(text).toBe('hello')
    expect(images).toBeUndefined()
    const userMsgId = chat.getMessages('f3').find((m) => m.role === 'user')!.id
    expect(options?.clientUuid).toBe(userMsgId)
    expect(userMsgId).toMatch(/^u-[0-9a-fA-F-]{36}$/)
  })
})
