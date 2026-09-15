/**
 * composer-shell deriveHistoryFromChatStore 引用键缓存测试（perf：↑/↓ 历史导航全量重建
 * 加 WeakMap 引用键缓存）。
 *
 * 缓存正确性基础（ADR-0039，chat store commitMessages 不可变替换）：源数组引用同 ⇒ 内容同。
 * 本文件锁定：
 * ① 派生语义不变（倒序 + role==='user' + status==='complete' + 去重连续相同文本）
 * ② 同引用复用缓存实例（toBe 同一数组）
 * ③ 源数组引用变化后结果刷新（新引用 → 重算 → 新实例新内容）
 * ④ 空分区（getMessages 每次新建 []）行为与无缓存时一致
 *
 * mock 策略参照 composer-model-reasoning.test.ts：composer-shell.ts 模块加载链含
 * useChat/useNewTaskFlow/api 等 renderer 重依赖，vi.mock 隔离（本文件只触达纯派生函数，
 * 不 mount 组件、不需要 pinia）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-history-cache.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { Message } from '@taiji/shared'
import { deriveHistoryFromChatStore } from '@/composables/panel/composer-shell'
import type { useChatStore } from '@/stores/chat'

vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    send: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    abort: vi.fn(),
    compact: vi.fn(),
    sendBash: vi.fn(),
  }),
}))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ submitFirstMessage: vi.fn(), currentModel: { value: null }, setPendingModel: vi.fn() }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({
  project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn() },
  composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ forkSessionAsk: vi.fn(), forkSession: vi.fn() }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn() }),
}))

type ChatStore = ReturnType<typeof useChatStore>

/** 最小 user/assistant 消息构造（派生只读 role/status/content） */
function userMsg(id: string, text: string, status: Message['status'] = 'complete'): Message {
  return { id, role: 'user', content: text, status, timestamp: 0 }
}
function assistantMsg(id: string, text: string): Message {
  return { id, role: 'assistant', content: text, status: 'complete', timestamp: 0 }
}

/** 结构化 chatStore stub：deriveHistoryFromChatStore 只消费 getMessages（固定数组引用） */
function fakeStore(msgs: Message[]): ChatStore {
  return { getMessages: (_sid: string) => msgs } as unknown as ChatStore
}

/** 每次调用返回新数组实例的 stub（对齐真实 store 空分区 `?? []` 每调新建的形态） */
function fakeStorePerCall(msgs: Message[]): ChatStore {
  return { getMessages: (_sid: string) => [...msgs] } as unknown as ChatStore
}

describe('deriveHistoryFromChatStore 派生语义（无缓存时的基线行为不变）', () => {
  it('倒序 + 仅 user+complete + 连续相同文本去重', () => {
    const msgs = [
      userMsg('u1', 'first'),
      assistantMsg('a1', 'reply'),
      userMsg('u2', 'second'),
      userMsg('u3', 'second'), // 连续重复 → 去重
      userMsg('u4', 'draft', 'streaming'), // 未 complete → 排除
      assistantMsg('a2', 'as text'),
    ]
    expect(deriveHistoryFromChatStore(fakeStore(msgs), 's1')).toEqual(['second', 'first'])
  })

  it('非连续相同文本不去重', () => {
    const msgs = [userMsg('u1', 'same'), userMsg('u2', 'other'), userMsg('u3', 'same')]
    expect(deriveHistoryFromChatStore(fakeStore(msgs), 's1')).toEqual(['same', 'other', 'same'])
  })

  it('Segment[] content 经 normalizeContent 归一为纯文本', () => {
    const msgs: Message[] = [
      {
        id: 'u1',
        role: 'user',
        content: [
          { type: 'text', text: '带结构 ' },
          { type: 'text', text: '分段' },
        ],
        status: 'complete',
        timestamp: 0,
      },
    ]
    expect(deriveHistoryFromChatStore(fakeStore(msgs), 's1')).toEqual(['带结构 分段'])
  })
})

describe('引用键缓存（ADR-0039：引用同 ⇒ 内容同）', () => {
  it('同源数组引用二次调用：返回同一缓存实例（跳过重遍历）', () => {
    const msgs = [userMsg('u1', 'hello'), userMsg('u2', 'world')]
    const store = fakeStore(msgs)
    const first = deriveHistoryFromChatStore(store, 's1')
    const second = deriveHistoryFromChatStore(store, 's1')
    expect(second).toBe(first) // 实例同一 = 命中缓存
    expect(second).toEqual(['world', 'hello'])
  })

  it('源数组引用变化（commitMessages 不可变替换形态）：结果刷新为新内容 + 新实例', () => {
    const oldMsgs = [userMsg('u1', 'old message')]
    const store = fakeStore(oldMsgs)
    const first = deriveHistoryFromChatStore(store, 's1')
    expect(first).toEqual(['old message'])

    // 模拟 commitMessages：整体替换分区内层 ref.value（新数组引用），旧数组不再被 store 持有
    const newMsgs = [...oldMsgs, userMsg('u2', 'new message')]
    store.getMessages = (_sid: string) => newMsgs
    const second = deriveHistoryFromChatStore(store, 's1')
    expect(second).toEqual(['new message', 'old message'])
    expect(second).not.toBe(first) // 新引用 → 重算 → 新实例
  })

  it('引用变化但派生结果相同时：内容相等（刷新语义正确，不返回陈旧引用）', () => {
    const store = fakeStore([userMsg('u1', 'stable')])
    const first = deriveHistoryFromChatStore(store, 's1')
    store.getMessages = (_sid: string) => [userMsg('u9', 'stable')]
    const second = deriveHistoryFromChatStore(store, 's1')
    expect(second).toEqual(first) // 内容一致
    expect(second).not.toBe(first) // 但走的是重算（新数组引用不命中旧缓存）
  })

  it('空分区（getMessages 每次新建 []，对齐真实 store ?? [] 行为）：结果为空数组，各次重算', () => {
    // 每次 getMessages 返回新 [] 实例（真实 chat store 空分区 `?? []` 同形态）→ WeakMap 永远 miss
    const store = fakeStorePerCall([])
    const first = deriveHistoryFromChatStore(store, 's1')
    const second = deriveHistoryFromChatStore(store, 's1')
    expect(first).toEqual([])
    expect(second).toEqual([])
    expect(second).not.toBe(first) // 每次新 [] 引用 → 各自 miss 重算（O(1)），行为与无缓存一致
  })
})
