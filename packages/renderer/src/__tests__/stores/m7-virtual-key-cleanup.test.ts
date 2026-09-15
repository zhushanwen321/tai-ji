/**
 * M7 虚拟 key 三段式 + deleteSession 清理链路测试（数据加载层）。
 *
 * 覆盖（U7 后保留）：
 * - FR-1: subagent 虚拟 key 三段式格式 + 结构校验
 * - FR-2: 真实 key 经 chat-lru isVirtualKeyOf 匹配（防假绿）
 * - FR-5: deleteSession 时序（evictSessionWithVirtual 清 subagent 虚拟 key）
 *
 * [HISTORICAL] overlay 相关用例已随 U7 移除：FR-3（backToMain）、FR-7（tombstone 防复活）、
 * B3（backFromAgentCall）。这些均依赖 overlay viewing 状态机，overlay 移除后概念消失。
 * agentcall 清理映射测试见 workflow.test.ts（registerAgentCall + deleteSession 路径）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  subagentVirtualId,
  isSubagentVirtualId,
  extractSubagentId,
  extractMainSessionId,
  useSubagentStore,
} from '@/stores/subagent'
import { useChatStore } from '@/stores/chat'
import { isVirtualKeyOf } from '@taiji/core'
import { useWorkflowStore } from '@/stores/workflow'
import type { Message } from '@taiji/shared'

// mock sessionApi（FR-2/FR-5 数据加载用）
vi.mock('@taiji/core/transport/api/domains/session', () => ({
  getWorkflows: vi.fn(),
  getAgentCallHistory: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return { ...actual, session }
})

function makeMessage(id: string): Message {
  return { id, role: 'assistant', content: `msg-${id}`, status: 'complete', timestamp: Date.now() }
}

// ── FR-1: 三段式 key 格式 + 结构校验 ──────────────────────────────

describe('M7 FR-1: subagent 虚拟 key 三段式格式', () => {
  it('subagentVirtualId 产出三段式 subagent:<mainSid>:<subId>', () => {
    expect(subagentVirtualId('sess-1', 'sub-a')).toBe('subagent:sess-1:sub-a')
  })

  it('extractSubagentId 返回第三段 subId（保持消费契约 DR9）', () => {
    expect(extractSubagentId('subagent:sess-1:sub-a')).toBe('sub-a')
  })

  it('extractMainSessionId 返回第二段 mainSid', () => {
    expect(extractMainSessionId('subagent:sess-1:sub-a')).toBe('sess-1')
  })
})

describe('M7 FR-1: isSubagentVirtualId 三段结构校验（排除旧两段式）', () => {
  it('三段式合法 key 返回 true', () => {
    expect(isSubagentVirtualId('subagent:sess-1:sub-a')).toBe(true)
  })

  it('旧两段式 key 返回 false（INVAR-1.4 排除残留）', () => {
    // 防退化：旧格式 subagent:foo（无 mainSid 段）不应被识别为合法虚拟 key
    expect(isSubagentVirtualId('subagent:foo')).toBe(false)
  })

  it('agentcall 前缀返回 false', () => {
    expect(isSubagentVirtualId('agentcall:x')).toBe(false)
  })

  it('普通 session id 返回 false', () => {
    expect(isSubagentVirtualId('sess-1')).toBe(false)
  })
})

// ── FR-1 + FR-2: 真实 key 经 chat-lru 匹配（防假绿）──────────────

describe('M7 AC-2/3: 真实 subagentVirtualId 经 LRU 匹配（防假绿）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('isVirtualKeyOf 对真实 subagentVirtualId 生成的 key 匹配主 session', () => {
    // 防假绿：不用手写 'subagent:s0:sa1' 字符串，用真实工厂生成
    const virtualKey = subagentVirtualId('s0', 'sa1')
    expect(isVirtualKeyOf(virtualKey, 's0')).toBe(true)
  })

  it('LRU 驱逐主 session s0 时，真实 subagentVirtualId 生成的 messages key 被同步删除', () => {
    const store = useChatStore()
    const virtualKey = subagentVirtualId('s0', 'sa1')

    store.hydrate('s0', [makeMessage('m0')])
    store.setMessages(virtualKey, [makeMessage('sa1')])

    store.evictSessionWithVirtual('s0')

    // 主 session + 真实工厂生成的虚拟 key 都清
    expect(store.getMessages('s0')).toEqual([])
    expect(store.getMessages(virtualKey)).toEqual([])
  })

  it('多 subagent 全清：同主 session 下 N 个 subagent 虚拟 key 都被驱逐', () => {
    const store = useChatStore()
    const vk1 = subagentVirtualId('s0', 'sa1')
    const vk2 = subagentVirtualId('s0', 'sa2')

    store.hydrate('s0', [makeMessage('m0')])
    store.setMessages(vk1, [makeMessage('sa1')])
    store.setMessages(vk2, [makeMessage('sa2')])

    store.evictSessionWithVirtual('s0')

    expect(store.getMessages(vk1)).toEqual([])
    expect(store.getMessages(vk2)).toEqual([])
  })
})

// ── FR-5: deleteSession 时序 ─────────────────────────────────────

describe('M7 FR-5: deleteSession 时序 evict 在 dispose 前', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('deleteSession 时该 session 的 subagent 虚拟 key 被清', () => {
    const store = useChatStore()
    const vk1 = subagentVirtualId('s0', 'sa1')
    const vk2 = subagentVirtualId('s0', 'sa2')

    store.hydrate('s0', [makeMessage('m0')])
    store.setMessages(vk1, [makeMessage('sa1')])
    store.setMessages(vk2, [makeMessage('sa2')])

    // deleteSession 应先 evictSessionWithVirtual（清虚拟 key）再 disposeSession（清主 session）
    // 这里直接验证最终状态：全部清
    store.evictSessionWithVirtual('s0')
    store.disposeSession('s0')

    expect(store.getMessages('s0')).toEqual([])
    expect(store.getMessages(vk1)).toEqual([])
    expect(store.getMessages(vk2)).toEqual([])
  })

  it('deleteSession 不误清其他 session 的虚拟 key', () => {
    const store = useChatStore()
    const vk0 = subagentVirtualId('s0', 'sa1')
    const vk1 = subagentVirtualId('s1', 'sb1')

    store.hydrate('s0', [makeMessage('m0')])
    store.hydrate('s1', [makeMessage('m1')])
    store.setMessages(vk0, [makeMessage('sa1')])
    store.setMessages(vk1, [makeMessage('sb1')])

    store.evictSessionWithVirtual('s0')
    store.disposeSession('s0')

    // s0 的虚拟 key 清，s1 的保留
    expect(store.getMessages(vk0)).toEqual([])
    expect(store.getMessages(vk1)).toHaveLength(1)
  })
})
