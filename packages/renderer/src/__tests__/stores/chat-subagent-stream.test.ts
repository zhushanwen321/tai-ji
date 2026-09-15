/**
 * W4 —— chat store subagent streaming 收口测试（U8/U9）。
 *
 * 背景：subagent store 原 applyStreamDelta 绕过 chat store 直调 setMessages，
 * chat store 应成为所有 assistant content mutation 的唯一入口。本测试覆盖
 * 从 subagent store 迁入的两个新 action：
 * - applySubagentStreamDelta(virtualId, lines)：全量替换 content + 幂等补 contentBlock
 * - finalizeSubagentStream(virtualId)：streaming → complete 收口
 *
 * virtualId = 'subagent:<subagentId>'，是 chat store messages Map 的 key，
 * 与主 session 共用同一 Map（仅 key 不同）。
 *
 * E3（mount Panel 组件树 + WS subagent.stream_delta 端到端）需手工验证：
 * 这里降级为对 chat store action 的直接断言（store action 是组件树渲染的
 * 数据源，断言 action 行为即可锁定渲染契约）。
 *
 * 运行：npx vitest run src/__tests__/stores/chat-subagent-stream.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import type { Message } from '@taiji/shared'

describe('W4 chat store — subagent streaming 收口（U8/U9）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  const VIRTUAL_ID = 'subagent:bg-1'

  // ── U8：applySubagentStreamDelta ──

  it('U8.1: 无 streaming assistant → push 新 assistant（status:streaming + contentBlocks:[text]）', () => {
    const store = useChatStore()
    // 预置一条 user 消息（模拟 subagent 历史）
    store.setMessages(VIRTUAL_ID, [
      { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: 1 },
    ])

    store.applySubagentStreamDelta(VIRTUAL_ID, ['line1', 'line2'])

    const list = store.getMessages(VIRTUAL_ID)
    expect(list).toHaveLength(2)
    const assistant = list[1]
    expect(assistant.role).toBe('assistant')
    expect(assistant.status).toBe('streaming')
    expect(assistant.content).toBe('line1\nline2')
    expect(assistant.id).toMatch(/^sa-/)
    expect(assistant.contentBlocks).toEqual([{ type: 'text', refId: 'text' }])
  })

  it('U8.2: 有 streaming assistant → 全量替换 content（lines.join(chr(10))）', () => {
    const store = useChatStore()
    // 预置 streaming assistant（首次 delta 后的状态）
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-1',
        role: 'assistant',
        content: '旧文本',
        status: 'streaming',
        contentBlocks: [{ type: 'text', refId: 'text' }],
        timestamp: 1,
      },
    ])

    // 扩展层传的是 buffer 的 split('\n')，每次都是完整文本
    store.applySubagentStreamDelta(VIRTUAL_ID, ['第一行', '第二行', '第三行'])

    const list = store.getMessages(VIRTUAL_ID)
    expect(list).toHaveLength(1) // 不新增
    const assistant = list[0]
    expect(assistant.content).toBe('第一行\n第二行\n第三行')
    expect(assistant.status).toBe('streaming')
  })

  it('U8.3: 幂等补 contentBlock —— 首次补 text 块，再次不重复 push', () => {
    const store = useChatStore()
    // 预置 streaming assistant 但 contentBlocks 为空（首次 delta 前状态）
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-1',
        role: 'assistant',
        content: '',
        status: 'streaming',
        contentBlocks: [],
        timestamp: 1,
      },
    ])

    // 首次 delta：补 text 块
    store.applySubagentStreamDelta(VIRTUAL_ID, ['first'])
    let assistant = store.getMessages(VIRTUAL_ID)[0]
    expect(assistant.contentBlocks).toEqual([{ type: 'text', refId: 'text' }])

    // 再次 delta：不重复 push
    store.applySubagentStreamDelta(VIRTUAL_ID, ['first', 'second'])
    assistant = store.getMessages(VIRTUAL_ID)[0]
    expect(assistant.contentBlocks).toEqual([{ type: 'text', refId: 'text' }])
    expect(assistant.content).toBe('first\nsecond')
  })

  it('U8.4: 已含非 text contentBlocks → 补 text 块到尾部（不破坏已有顺序）', () => {
    const store = useChatStore()
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-1',
        role: 'assistant',
        content: '',
        status: 'streaming',
        contentBlocks: [{ type: 'thinking', refId: 'th1' }],
        timestamp: 1,
      },
    ])

    store.applySubagentStreamDelta(VIRTUAL_ID, ['text'])

    const assistant = store.getMessages(VIRTUAL_ID)[0]
    expect(assistant.contentBlocks).toEqual([
      { type: 'thinking', refId: 'th1' },
      { type: 'text', refId: 'text' },
    ])
  })

  it('U8.5: 最后一条 assistant 非 streaming（已 complete）→ push 新 streaming assistant', () => {
    const store = useChatStore()
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-old',
        role: 'assistant',
        content: '已收口',
        status: 'complete',
        contentBlocks: [{ type: 'text', refId: 'text' }],
        timestamp: 1,
      },
    ])

    store.applySubagentStreamDelta(VIRTUAL_ID, ['新回合'])

    const list = store.getMessages(VIRTUAL_ID)
    expect(list).toHaveLength(2)
    const newAssistant = list[1]
    expect(newAssistant.status).toBe('streaming')
    expect(newAssistant.content).toBe('新回合')
    // 旧的保持不变
    expect(list[0].status).toBe('complete')
  })

  // ── U9：finalizeSubagentStream ──

  it('U9.1: streaming assistant → finalize 后翻 complete（sealed 收口）', () => {
    const store = useChatStore()
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-1',
        role: 'assistant',
        content: '流式内容',
        status: 'streaming',
        contentBlocks: [{ type: 'text', refId: 'text' }],
        timestamp: 1,
      },
    ])

    store.finalizeSubagentStream(VIRTUAL_ID)

    const list = store.getMessages(VIRTUAL_ID)
    expect(list[0].status).toBe('complete')
    expect(list[0].content).toBe('流式内容') // content 不变
  })

  it('U9.2: 多条 assistant，只翻最后一条 streaming', () => {
    const store = useChatStore()
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-1',
        role: 'assistant',
        content: '回合1',
        status: 'complete',
        timestamp: 1,
      },
      {
        id: 'sa-2',
        role: 'assistant',
        content: '回合2',
        status: 'streaming',
        contentBlocks: [{ type: 'text', refId: 'text' }],
        timestamp: 2,
      },
    ])

    store.finalizeSubagentStream(VIRTUAL_ID)

    const list = store.getMessages(VIRTUAL_ID)
    expect(list[0].status).toBe('complete') // 第一条不变
    expect(list[1].status).toBe('complete') // 第二条收口
  })

  it('U9.3: 无 streaming assistant → 幂等 no-op（不抛错，不改已有 complete 消息）', () => {
    const store = useChatStore()
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-1',
        role: 'assistant',
        content: '已收口',
        status: 'complete',
        timestamp: 1,
      },
    ])

    expect(() => store.finalizeSubagentStream(VIRTUAL_ID)).not.toThrow()
    expect(store.getMessages(VIRTUAL_ID)[0].status).toBe('complete')
  })

  it('U9.4: virtualId 无消息分区 → 幂等 no-op（不抛错）', () => {
    const store = useChatStore()
    expect(() => store.finalizeSubagentStream('subagent:never-exists')).not.toThrow()
  })

  // ── sealed 守卫对齐（D-010 parity）──

  it('sealed parity: finalize 后再 applySubagentStreamDelta → push 新 streaming（不污染已 complete 实体）', () => {
    const store = useChatStore()
    store.setMessages(VIRTUAL_ID, [
      {
        id: 'sa-1',
        role: 'assistant',
        content: '回合1',
        status: 'streaming',
        contentBlocks: [{ type: 'text', refId: 'text' }],
        timestamp: 1,
      },
    ])

    store.finalizeSubagentStream(VIRTUAL_ID)
    // 收口后再来 delta（如迟到的 WS 帧）
    store.applySubagentStreamDelta(VIRTUAL_ID, ['新回合'])

    const list = store.getMessages(VIRTUAL_ID)
    expect(list).toHaveLength(2)
    // 旧的保持 complete 不被污染
    expect(list[0].status).toBe('complete')
    expect(list[0].content).toBe('回合1')
    // 新建 streaming
    expect(list[1].status).toBe('streaming')
  })

  // ── E3 降级断言：chat store action 是组件树渲染的数据源 ──

  it('E3 (degraded): subagent 虚拟 session 与主 session 共用 messages Map（key 隔离）', () => {
    const store = useChatStore()
    const MAIN_SID = 'session-main'

    // 主 session 与 subagent 虚拟 session 各写各的，互不干扰
    store.appendUser(MAIN_SID, '主会话消息')
    store.applySubagentStreamDelta(VIRTUAL_ID, ['subagent 流式'])

    expect(store.getMessages(MAIN_SID)).toHaveLength(1)
    expect(store.getMessages(MAIN_SID)[0].role).toBe('user')
    expect(store.getMessages(VIRTUAL_ID)).toHaveLength(1)
    expect(store.getMessages(VIRTUAL_ID)[0].role).toBe('assistant')
    expect(store.getMessages(VIRTUAL_ID)[0].status).toBe('streaming')
  })
})
