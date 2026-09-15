/**
 * applySubagentEntries 单测（E-4，subagent-realtime-channel §6.1/§6.2）。
 *
 * 覆盖 session.subagentEntriesAppended 帧的 store 级消费语义：
 * - 帧到达 → 虚拟分区出现 entry 派生消息（message entry 经 applyEntry reducer 投影）
 * - toolCall overlay：running toolCall 挂末位 assistant；toolResult entry 回填后基线覆盖终态；
 *   同帧 [toolResult, toolCall] 交错下终态不被倒退回 running
 * - delta 中间态被 entry 定稿覆盖（§6.2：applySubagentStreamDelta 建的 sa-* streaming
 *   实体被 assistant 定稿 entry 的基线投影取代）
 * - 幂等：toolResult 重复帧 no-op（reducer deliveredToolResultIds）；「帧先于 drawer 打开 →
 *   快照替换 → 后续帧」不产生重复消息
 * - disposeSession 清理 reducer 累积态（后续帧从空分区重新累积）
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/subagent-entries.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { createChatStore } from '../store'
import type { ChatStoreInstance } from '../store'
import type { PiEntry, PiMessageEntry, PiToolCallEntryForm } from '@taiji/shared'

const VIRTUAL_ID = 'subagent:main-1:rec-1'

/** 构造独立 store 实例（effectScope 包裹 onScopeDispose 注册 + 测试隔离）。 */
function makeStore(): { store: ChatStoreInstance; dispose: () => void } {
  const scope = effectScope(true)
  const store = scope.run(() => createChatStore())!
  return { store, dispose: () => scope.stop() }
}

function messageEntry(message: PiMessageEntry['message']): PiMessageEntry {
  return { type: 'message', parentId: null, timestamp: '2026-08-25T00:00:00.000Z', message }
}

function toolCallForm(overrides: Partial<PiToolCallEntryForm> = {}): PiToolCallEntryForm {
  return {
    type: 'toolCall',
    parentId: null,
    timestamp: '2026-08-25T00:00:00.000Z',
    toolCallId: 'tc-1',
    toolName: 'read',
    arguments: { path: '/x' },
    ...overrides,
  }
}

describe('applySubagentEntries（E-4 entry 帧消费）', () => {
  let sut: { store: ChatStoreInstance; dispose: () => void }

  beforeEach(() => {
    sut = makeStore()
  })
  afterEach(() => {
    sut.dispose()
  })

  it('帧到达 → 虚拟分区出现 entry 派生消息（reducer 投影，user/assistant 顺序保留）', () => {
    sut.store.applySubagentEntries(VIRTUAL_ID, [
      messageEntry({ role: 'user', content: [{ type: 'text', text: '任务' }], timestamp: 1000 }),
      messageEntry({ role: 'assistant', content: [{ type: 'text', text: '产出' }], timestamp: 2000 }),
    ])

    const messages = sut.store.getMessages(VIRTUAL_ID)
    expect(messages).toHaveLength(2)
    // user 消息 content 保留 Segment[] 原样（apply-entry user 分支语义，appendUser 注释同源）
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: '任务' }],
      status: 'complete',
    })
    expect(messages[1]).toMatchObject({ role: 'assistant', content: '产出', status: 'complete' })
  })

  it('toolCall overlay → running toolCall 挂末位 assistant；toolResult entry 到达后基线回填终态', () => {
    const assistantWithTool = messageEntry({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: '/x' } }],
      timestamp: 1000,
    })
    // 帧 1：assistant 定稿（基线 toolCalls 提取版 status:'completed'）
    sut.store.applySubagentEntries(VIRTUAL_ID, [assistantWithTool])
    // 帧 2：tool_execution_start → running overlay（修正重放视角的终态假设）
    sut.store.applySubagentEntries(VIRTUAL_ID, [toolCallForm()])
    let messages = sut.store.getMessages(VIRTUAL_ID)
    expect(messages[0]?.toolCalls?.[0]).toMatchObject({ id: 'tc-1', status: 'running' })

    // 帧 3：tool_execution_end → toolResult entry 喂 reducer 回填 → 基线投影覆盖 running
    sut.store.applySubagentEntries(VIRTUAL_ID, [
      messageEntry({
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'file body' }],
        timestamp: 3000,
      }),
    ])
    messages = sut.store.getMessages(VIRTUAL_ID)
    expect(messages[0]?.toolCalls?.[0]).toMatchObject({ id: 'tc-1', status: 'completed', output: 'file body' })
  })

  it('同帧 [toolResult, toolCall] 交错 → toolResult 先投影，overlay 不把终态倒退回 running', () => {
    sut.store.applySubagentEntries(VIRTUAL_ID, [
      messageEntry({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: '/x' } }],
        timestamp: 1000,
      }),
    ])
    sut.store.applySubagentEntries(VIRTUAL_ID, [
      messageEntry({
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'done' }],
        timestamp: 3000,
      }),
      toolCallForm(),
    ])
    const messages = sut.store.getMessages(VIRTUAL_ID)
    expect(messages[0]?.toolCalls?.[0]).toMatchObject({ status: 'completed', output: 'done' })
  })

  it('delta 中间态被 entry 定稿覆盖（§6.2：sa-* streaming 实体被基线投影取代）', () => {
    // delta 打字机：streaming 中间态（applySubagentStreamDelta 建的 sa-<uuid> 实体）
    sut.store.applySubagentStreamDelta(VIRTUAL_ID, ['Hello wor'])
    expect(sut.store.getMessages(VIRTUAL_ID)[0]).toMatchObject({ status: 'streaming', content: 'Hello wor' })

    // entry 帧：assistant 定稿 → reducer 基线整体替换分区
    sut.store.applySubagentEntries(VIRTUAL_ID, [
      messageEntry({ role: 'assistant', content: [{ type: 'text', text: 'Hello world' }], timestamp: 2000 }),
    ])

    const messages = sut.store.getMessages(VIRTUAL_ID)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'assistant', content: 'Hello world', status: 'complete' })
    // delta 中间态实体（sa- 前缀 id）被定稿消息取代，不重复渲染
    expect(messages[0]?.id.startsWith('sa-')).toBe(false)
  })

  it('幂等：toolResult 重复帧 no-op（reducer deliveredToolResultIds 去重继承）', () => {
    const toolResultEntry = messageEntry({
      role: 'toolResult',
      toolCallId: 'tc-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'file body' }],
      timestamp: 3000,
    })
    sut.store.applySubagentEntries(VIRTUAL_ID, [
      messageEntry({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: '/x' } }],
        timestamp: 1000,
      }),
    ])
    sut.store.applySubagentEntries(VIRTUAL_ID, [toolResultEntry])
    const afterFirst = sut.store.getMessages(VIRTUAL_ID)

    // 同 toolResult 帧重复投递 → reducer 二次喂入 no-op（孤儿不重复收集，消息不变）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      sut.store.applySubagentEntries(VIRTUAL_ID, [toolResultEntry])
    } finally {
      warnSpy.mockRestore()
    }
    expect(sut.store.getMessages(VIRTUAL_ID)).toEqual(afterFirst)
    expect(afterFirst[0]?.toolCalls?.[0]?.output).toBe('file body')
  })

  it('toolCall overlay 重复帧 no-op（同 toolCallId 已 running 不重复 push）', () => {
    sut.store.applySubagentEntries(VIRTUAL_ID, [
      messageEntry({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: '/x' } }],
        timestamp: 1000,
      }),
      toolCallForm(),
    ])
    const afterFirst = sut.store.getMessages(VIRTUAL_ID)
    expect(afterFirst[0]?.toolCalls).toHaveLength(1)

    sut.store.applySubagentEntries(VIRTUAL_ID, [toolCallForm()])
    expect(sut.store.getMessages(VIRTUAL_ID)[0]?.toolCalls).toHaveLength(1)
  })

  it('「帧先于打开 → 打开即完整」：帧累积 → 快照替换（fetchAndInject 形态）→ 后续帧不产生重复', () => {
    // 帧先于 drawer 打开到达（分区惰性创建，§6.1-2）
    sut.store.applySubagentEntries(VIRTUAL_ID, [
      messageEntry({ role: 'user', content: [{ type: 'text', text: '任务' }], timestamp: 1000 }),
      messageEntry({
        role: 'assistant',
        content: [{ type: 'text', text: '第一段产出' }],
        timestamp: 2000,
      }),
    ])
    // drawer 打开：fetchAndInject 快照整体替换（setMessages，文件直读全量；user content
    // 在快照形态是 segments——直读链同派生规则）
    sut.store.setMessages(VIRTUAL_ID, [
      { id: 'uuid-u1', role: 'user', content: [{ type: 'text', text: '任务' }], status: 'complete', timestamp: 1000 },
      { id: 'uuid-a1', role: 'assistant', content: '第一段产出', status: 'complete', timestamp: 2000 },
    ])
    expect(sut.store.getMessages(VIRTUAL_ID)).toHaveLength(2)

    // 后续新帧：reducer 基线全量投影替换（live 累积 ⊇ 快照期内容），无重复消息
    sut.store.applySubagentEntries(VIRTUAL_ID, [
      messageEntry({
        role: 'assistant',
        content: [{ type: 'text', text: '第二段产出' }],
        timestamp: 4000,
      }),
    ])
    const messages = sut.store.getMessages(VIRTUAL_ID)
    expect(messages).toHaveLength(3)
    expect(messages.map((m) => (typeof m.content === 'string' ? m.content : ''))).toEqual(['', '第一段产出', '第二段产出'])
    expect((messages[0]?.content as Array<{ type: string; text: string }>)[0]?.text).toBe('任务')
  })

  it('基线投影截断：超限 toolResult 截断后，后续帧再投影截断值逐字节稳定（引用短路不改输出）', () => {
    const bigOutput = 'x'.repeat(10_000)
    sut.store.applySubagentEntries(VIRTUAL_ID, [
      messageEntry({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: '/x' } }],
        timestamp: 1000,
      }),
    ])
    sut.store.applySubagentEntries(VIRTUAL_ID, [
      messageEntry({
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'read',
        content: [{ type: 'text', text: bigOutput }],
        timestamp: 3000,
      }),
    ])
    // reducer 回填保留全量原文，基线投影负责截断（含标记 ≤ 4KB）
    const truncated = sut.store.getMessages(VIRTUAL_ID)[0]?.toolCalls?.[0]?.output
    expect(truncated).toBeDefined()
    expect(new TextEncoder().encode(truncated!).length).toBeLessThanOrEqual(4096)
    expect(truncated!.endsWith('\n\n[...output truncated...]')).toBe(true)

    // 后续帧（新 user entry，历史消息 reducer 引用不变）触发全量投影：历史消息
    // 截断值不二次截断、marker 不叠加、逐字节等于首次投影结果
    sut.store.applySubagentEntries(VIRTUAL_ID, [
      messageEntry({ role: 'user', content: [{ type: 'text', text: '下一轮' }], timestamp: 4000 }),
    ])
    const messages = sut.store.getMessages(VIRTUAL_ID)
    expect(messages).toHaveLength(2)
    expect(messages[0]?.toolCalls?.[0]?.output).toBe(truncated)
  })

  it('重复投影幂等：无新 entry 的重复触发输出与上次逐值一致（已见引用短路语义）', () => {
    sut.store.applySubagentEntries(VIRTUAL_ID, [
      messageEntry({ role: 'user', content: [{ type: 'text', text: '任务' }], timestamp: 1000 }),
      messageEntry({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { cmd: 'ls' } }],
        timestamp: 2000,
      }),
    ])
    sut.store.applySubagentEntries(VIRTUAL_ID, [
      messageEntry({
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'out'.repeat(2000) }],
        timestamp: 3000,
      }),
    ])
    const afterEntries = sut.store.getMessages(VIRTUAL_ID)

    // 空帧（无 entry 无 toolCall form）= 纯重投影：输出 deep equal，历史值不漂移
    sut.store.applySubagentEntries(VIRTUAL_ID, [])
    expect(sut.store.getMessages(VIRTUAL_ID)).toEqual(afterEntries)
  })

  it('disposeSession 清理 reducer 累积态：后续帧从空分区重新累积', () => {
    sut.store.applySubagentEntries(VIRTUAL_ID, [
      messageEntry({ role: 'user', content: [{ type: 'text', text: '任务' }], timestamp: 1000 }),
    ])
    expect(sut.store.getMessages(VIRTUAL_ID)).toHaveLength(1)

    sut.store.disposeSession(VIRTUAL_ID)
    expect(sut.store.getMessages(VIRTUAL_ID)).toHaveLength(0)

    // 清理后新帧：reducer state 一并清空（否则投影会带出清理前的累积，分区复活旧消息）
    sut.store.applySubagentEntries(VIRTUAL_ID, [
      messageEntry({ role: 'user', content: [{ type: 'text', text: '新任务' }], timestamp: 9000 }),
    ])
    expect(sut.store.getMessages(VIRTUAL_ID)).toHaveLength(1)
    expect(sut.store.getMessages(VIRTUAL_ID)[0]?.content).toEqual([{ type: 'text', text: '新任务' }])
  })
})
