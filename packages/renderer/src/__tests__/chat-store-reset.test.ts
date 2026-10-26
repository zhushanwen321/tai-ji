// @vitest-environment node
/**
 * 合并测试文件（renderer 测试提速 round5-d 分区 1 簇 1-9）。
 *
 * 本文件由以下 7 个测试文件原样搬运合并（describe/it 零改动，节内按来源分节；
 * 各节 import 已去重上提至文件头）；
 * 七个来源全部为 node 环境纯逻辑测试（store / composable / effect），无 DOM 依赖：
 *  - src/__tests__/chat-store-reset.test.ts（宿主）
 *  - src/__tests__/stores/toolcall-anchor.test.ts
 *  - src/__tests__/composables/useHandoffEffect.test.ts
 *  - src/__tests__/stores/m7-virtual-key-cleanup.test.ts
 *  - src/__tests__/composables/status-cache.test.ts
 *  - src/__tests__/stores/chat-bash-effects.test.ts
 *  - src/__tests__/effects/custom-start-details.test.ts
 *
 * vi.mock 说明：useHandoffEffect 节 mock useSidebar（其余节不消费 useSidebar）；
 * m7 节 mock '@taiji/core/transport/api/domains/session' 并以保留式覆写 '@/api' 的
 * session 域（其余节不消费该域），均经 [读码] 核实于合并时点。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia, storeToRefs } from 'pinia'
import { effectScope } from 'vue'
import { useChatStore } from '@/stores/chat'
import {
  subagentVirtualId,
  isSubagentVirtualId,
  extractSubagentId,
  extractMainSessionId,
  useSubagentStore,
} from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { findToolCallOwner, isVirtualKeyOf, markBashError, getExecutingBash } from '@taiji/core'
import { deriveStatus } from '@/composables/logic/sessionStatus'
import { useSessionDerivations } from '@/composables/features/chat/useSessionDerivations'
import { bindHandoffEffect } from '@/composables/effects/useHandoffEffect'
import * as events from '@taiji/core/transport/api'
import type { ServerMessage, Message, ToolCall } from '@taiji/shared'

// ══════════════════════════════════════════════════════════════════════════
// vi.mock 区（hoist 至文件顶部）
// ══════════════════════════════════════════════════════════════════════════

// ── 来源: src/__tests__/composables/useHandoffEffect.test.ts ──
// useSidebar mock：捕获 loadSessions/selectSession（不引入真实 useSidebar 的 30+ 依赖）
const sidebarMock = vi.hoisted(() => ({
  loadSessions: vi.fn(() => Promise.resolve()),
  selectSession: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({
    loadSessions: sidebarMock.loadSessions,
    selectSession: sidebarMock.selectSession,
  }),
}))

// ── 来源: src/__tests__/stores/m7-virtual-key-cleanup.test.ts ──
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

// ══════════════════════════════════════════════════════════════════════════
// 节 1/7 — 来源: src/__tests__/chat-store-reset.test.ts
// ══════════════════════════════════════════════════════════════════════════

/**
 * Chat store 复位回归测试（合并自 chat-streaming-reset + chat-transient-reset——
 * 同为 useChatStore 复位语义、import 集与 describe 内 beforeEach 结构完全一致，
 * 合并以减少测试文件的 fork/装载固定开销；describe 与用例名保持原样）。
 *
 * - 流式状态复位（AGENTS.md 规则 #3）：message.error 到达时的 streaming assistant 转态
 * - 瞬态状态收尾（W3）：断连 / runtime 重启下 compacting/retry/queue 由 resetTransientStates 全清
 */

describe('chat store message.error 流式状态复位（规则 #3）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('流中途 message.error：最后 streaming assistant 转为 error 并并入 errorText', () => {
    const store = useChatStore()
    const sid = 'sx'
    // 建一条 streaming assistant（流中途）
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '部分内容' },
    })
    const before = store.getMessages(sid)
    expect(before[0].status).toBe('streaming')

    // 流中途错误（event-adapter error / 进程崩溃）
    store.applyMessageEvent(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: '进程崩溃' },
    })

    const after = store.getMessages(sid)
    expect(after).toHaveLength(1) // 不新建气泡
    expect(after[0].id).toBe('a1') // 原流式消息被转态
    expect(after[0].status).toBe('error') // 关键：复位 streaming
    expect(after[0].content).toContain('部分内容') // 保留已生成内容
    // [M2 error-visibility] 追加形态双通道：errorText 写 msg.error，不拼进 content
    expect(after[0].error).toBe('进程崩溃')
    expect(after[0].content).not.toContain('进程崩溃')
  })

  it('prompt 级 message.error（无 streaming assistant）：新建独立 error 消息', () => {
    const store = useChatStore()
    const sid = 'sy'
    store.appendUser(sid, 'hi')
    // 无 assistant 流，直接 error
    store.applyMessageEvent(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: 'hook 拒绝' },
    })
    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(2) // user + 新建 error
    expect(msgs[1].role).toBe('assistant')
    expect(msgs[1].status).toBe('error')
    expect(msgs[1].content).toBe('') // [M2] 错误文本不拼进 content
    expect(msgs[1].error).toBe('hook 拒绝')
  })

  it('已 complete 的历史 assistant 遇 message.error：不回写历史，新建独立 error 消息', () => {
    const store = useChatStore()
    const sid = 'sz'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-old' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid },
    })
    const before = store.getMessages(sid)
    expect(before[0].status).toBe('complete')

    // 后续错误到达，历史 complete 消息不应被改写
    store.applyMessageEvent(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: '后置错误' },
    })

    const after = store.getMessages(sid)
    expect(after).toHaveLength(2)
    expect(after[0].status).toBe('complete') // 历史消息保持
    expect(after[0].content).toBe('') // 未被并入 errorText
    expect(after[1].status).toBe('error') // 新建 error 消息
    expect(after[1].content).toBe('') // [M2] 错误文本不拼进 content
    expect(after[1].error).toBe('后置错误')
  })

  it(`errorText 缺省时落 'Unknown error'（流中途仍复位 streaming）`, () => {
    const store = useChatStore()
    const sid = 'sw'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a2' },
    })
    // payload 无 message 字段
    store.applyMessageEvent(sid, { type: 'message.error', payload: { sessionId: sid } })
    const after = store.getMessages(sid)
    expect(after).toHaveLength(1)
    expect(after[0].status).toBe('error')
    expect(after[0].error).toBe('Unknown error') // 缺省文案落 msg.error 字段（不拼 content）
    expect(after[0].content).toBe('')
  })
})

describe('chat store message.complete 多 assistant 气泡收尾', () => {
  beforeEach(() => setActivePinia(createPinia()))

  // [HISTORICAL] handoff 2026-07-04 L3：一个 turn 可能产生多个 streaming assistant 气泡
  // （如工具调用气泡 + 文字总结气泡，或历史/fork 路径残留）。旧实现用 findLastAssistantIndex
  // 只收尾最后一条，前面的 toolCall 气泡永远 streaming——内部状态机不一致，影响后续定位逻辑。
  // 修复后 message.complete 收尾所有 status==='streaming' 的 assistant。usage 不由 complete
  // 回填（chat-flow-consistency D3 规则 5 退役回合级覆盖），per-message usage 由
  // message_end(assistant) 帧载荷承担（同款锚见 fg5-message-stream.test.ts）。
  it('message.complete 收尾所有 streaming assistant 气泡（不只最后一条）', () => {
    const store = useChatStore()
    const sid = 'multi'
    // 模拟一个 turn 产生两条 streaming assistant（如 toolCall 气泡 + 文字气泡）
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'tool-bubble' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'text-bubble' },
    })
    const before = store.getMessages(sid)
    expect(before).toHaveLength(2)
    expect(before[0].status).toBe('streaming')
    expect(before[1].status).toBe('streaming')

    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    })

    const after = store.getMessages(sid)
    // 关键：两条 assistant 都收尾（旧行为只收最后一条，前一条卡 streaming）
    expect(after[0].status).toBe('complete')
    expect(after[1].status).toBe('complete')
  })

  it('complete.usage 不再回填任何 assistant（D3 规则 5 退役）；per-message usage 由 message_end 载荷承担', () => {
    const store = useChatStore()
    const sid = 'usage'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'bubble-a' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'bubble-b' },
    })

    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: {
        sessionId: sid,
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    })

    // 回合级 complete.usage 不再覆盖末位 assistant（定稿重建按每条消息的 entry 载荷写入，
    // 覆盖会把 turn 聚合值错误摊到单条消息——规则 5 退役锚）
    const afterComplete = store.getMessages(sid)
    expect(afterComplete[0].usage).toBeUndefined()
    expect(afterComplete[1].usage).toBeUndefined()

    // message_end(assistant) 帧载荷回填各条消息自己的 usage（live 与 reload 同源同值）
    store.applyMessageEvent(sid, {
      type: 'message.message_end',
      payload: {
        sessionId: sid,
        messageId: 'bubble-a',
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: 'a' }], usage: { input: 10, output: 5 }, stopReason: 'stop', timestamp: 0 },
        },
      },
    } as never)
    store.applyMessageEvent(sid, {
      type: 'message.message_end',
      payload: {
        sessionId: sid,
        messageId: 'bubble-b',
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: 'b' }], usage: { input: 100, output: 50 }, stopReason: 'stop', timestamp: 0 },
        },
      },
    } as never)

    const after = store.getMessages(sid)
    expect(after[0].usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(after[1].usage).toEqual({ inputTokens: 100, outputTokens: 50 })
  })

  it('message.complete stopReason error 时所有 streaming assistant 收尾为 error', () => {
    const store = useChatStore()
    const sid = 'err-multi'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'e-a' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'e-b' },
    })

    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'error' },
    })

    const after = store.getMessages(sid)
    expect(after[0].status).toBe('error')
    expect(after[1].status).toBe('error')
  })
})

describe('chat store markSessionError —— session 级错误统一入口', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('无 streaming assistant 时：新建独立 error 消息', () => {
    const store = useChatStore()
    const sid = 'me-1'
    store.appendUser(sid, 'hi')
    store.markSessionError(sid, '进程退出')

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(2) // user + 新建 error
    expect(msgs[1].role).toBe('assistant')
    expect(msgs[1].status).toBe('error')
    expect(msgs[1].content).toBe('') // [M2] 错误文本不拼进 content
    expect(msgs[1].error).toBe('进程退出')
  })

  it('有 streaming assistant 时：并入该消息并转 error 态（不新建气泡）', () => {
    const store = useChatStore()
    const sid = 'me-2'
    // 建一条 streaming assistant
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-me' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '流中内容' },
    })
    expect(store.getMessages(sid)[0].status).toBe('streaming')

    store.markSessionError(sid, '进程崩溃')

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(1) // 不新建气泡，原消息转态
    expect(msgs[0].id).toBe('a-me')
    expect(msgs[0].status).toBe('error')
    expect(msgs[0].content).toContain('流中内容') // 保留已生成内容
    // [M2 error-visibility] 追加形态双通道：errorText 写 msg.error，不拼进 content
    expect(msgs[0].error).toBe('进程崩溃')
    expect(msgs[0].content).not.toContain('进程崩溃')
  })

  it('finalizeSession 收尾所有活跃态：streaming entity + pendingSend', () => {
    const store = useChatStore()
    const sid = 'me-3'

    // 先设为 streaming + pendingSend 态（模拟流式中进程崩溃）
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-me3' },
    })
    store.addPendingSend(sid)
    expect(store.isGenerating(sid)).toBe(true)
    expect(store.isActive(sid)).toBe(true)

    store.markSessionError(sid, '崩溃')

    // 关键：所有活跃态复位（规则 #3），避免 UI 卡「思考中」
    expect(store.isGenerating(sid)).toBe(false)
    expect(store.isActive(sid)).toBe(false)
  })

  it('空 messages 的 session：新建首条 error 消息', () => {
    const store = useChatStore()
    const sid = 'me-4'
    // 进程在首条消息前就退出（如 extension 加载失败）
    store.markSessionError(sid, 'extension 加载失败')

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('assistant')
    expect(msgs[0].status).toBe('error')
    expect(msgs[0].content).toBe('') // [M2] 错误文本不拼进 content
    expect(msgs[0].error).toBe('extension 加载失败')
  })
})

describe('chat store 瞬态状态收尾（W3：finalizeAllStreaming 应全收尾）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('断连时 finalizeAllStreaming 清理 compactingSessions（不只 streaming）', () => {
    const store = useChatStore()
    const sid = 's-compacting'

    // 把 session 标为「压缩中」（session.compacting 驱动）
    store.setOccupancy(sid, { turn: 'idle', compacting: true, bash: false })
    expect(store.isCompacting(sid)).toBe(true)

    // 模拟 runtime 重启 / 断连：useConnection 会调 finalizeAllStreaming('restart')
    // W3：finalizeAllStreaming 应同时清掉 compacting（当前实现不清，红灯预期）
    store.finalizeAllStreaming('restart')

    // 关键断言：断连后 compacting 态应被清，否则 UI 永久卡「压缩中」
    expect(store.isCompacting(sid)).toBe(false)
  })

  it('断连时 finalizeAllStreaming 清理 retryStates', () => {
    const store = useChatStore()
    const sid = 's-retry'

    // 把 session 标为「自动重试中」（message.auto_retry_start 驱动）
    store.applyMessageEvent(sid, {
      type: 'message.auto_retry_start',
      payload: { sessionId: sid, attempt: 1, maxAttempts: 3 },
    })
    expect(store.getRetryState(sid)).toBeDefined()
    expect(store.getRetryState(sid)?.attempt).toBe(1)

    // 模拟断连：finalizeAllStreaming('disconnect')
    // W3：应清掉 retryStates（当前实现不清，红灯预期）
    store.finalizeAllStreaming('disconnect')

    // 关键断言：断连后重试指示位应被清
    expect(store.getRetryState(sid)).toBeUndefined()
  })

  it('[u3c/u5a 退役] queue_update 帧零落点——瞬态收尾点收敛为 occupancy/retry/streaming', () => {
    // [HISTORICAL] 前身「断连时 finalizeAllStreaming 清理 queueStates」用例：queue_update 帧
    // 已随投递所有权内核降级为内核内部回执（u3b 退役 queueStates 写入路径；u5a 结清分区与
    // 读写 API 本身），本用例前提（queue_update 能置 queueStates）结构性不成立。
    // 断言范围保留「帧到达不产生任何瞬态」：messages 与 retry 分区零写入。
    // 替代覆盖：内核派生视图随 session 销毁/disposeSession 清理（core clearDeliveryProjection，
    // 见 core chat __tests__/effects-delivery-receipt.test.ts）+ 本文件其余瞬态收尾用例。
    const store = useChatStore()
    const sid = 's-queue'
    store.applyMessageEvent(sid, {
      type: 'message.queue_update',
      payload: { sessionId: sid, steering: ['补一条'] },
    })
    expect(store.getMessages(sid)).toHaveLength(0)
    expect(store.getRetryState(sid)).toBeUndefined()
  })

  it('正常 message.complete 不清 compacting（只有 finalizeAllStreaming 全收尾）', () => {
    const store = useChatStore()
    const sid = 's-normal'

    // session 正在压缩 + 一条 streaming 消息
    store.setOccupancy(sid, { turn: 'idle', compacting: true, bash: false })
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })

    // 正常收尾：message.complete 收尾 streaming 实体
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    })

    // 关键：message.complete 只收 streaming 实体，不应顺手清 compacting
    // （compaction 是独立的 session 级状态，由 session.compacted 事件清，不能被消息收尾误清）
    expect(store.isCompacting(sid)).toBe(true)
    expect(store.isGenerating(sid)).toBe(false)
  })

  it('resetTransientStates helper 存在并清理全部瞬态', () => {
    const store = useChatStore()
    const sid = 's-reset'

    // 置满所有瞬态：streaming + compacting + retry + pendingSend
    // （[u3c] queueStates 置位路径已随 queue_update 退役，不再计入瞬态面）
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.setOccupancy(sid, { turn: 'idle', compacting: true, bash: false })
    store.applyMessageEvent(sid, {
      type: 'message.auto_retry_start',
      payload: { sessionId: sid, attempt: 1 },
    })
    store.addPendingSend(sid)

    expect(store.isGenerating(sid)).toBe(true)
    expect(store.isCompacting(sid)).toBe(true)
    expect(store.getRetryState(sid)).toBeDefined()
    expect(store.isActive(sid)).toBe(true)

    // W3：调用统一收尾 helper（resetTransientStates 已在 store API 暴露）
    store.resetTransientStates(sid)

    // 关键：全部瞬态一次性清零
    expect(store.isCompacting(sid)).toBe(false)
    expect(store.getRetryState(sid)).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 节 2/7 — 来源: src/__tests__/stores/toolcall-anchor.test.ts
// ══════════════════════════════════════════════════════════════════════════

/**
 * ToolCall ID 锚定 + 流结束收尾测试。
 *
 * 根因：event-adapter 并行处理 pi 事件（void this.handleEvent 不 await），
 * tool_execution_end 的 async handler（含 hook + git 对账）可能晚于下一个
 * message_start 发送。旧实现用 findLastAssistantIndex（位置定位）会被乱序干扰——
 * end 命中错误的空 assistant message，更新静默失败，toolCall 永久卡 running。
 *
 * 修复：tool_call_end/update 用 findToolCallOwner（按 toolCallId 全局查找）锚定；
 * message.complete 把残留 running 收尾为 end_not_received（正常 stop）/ error（error stop）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/stores/toolcall-anchor.test.ts
 */

describe('findToolCallOwner — ID 锚定查找', () => {
  it('按 toolCallId 精确命中所属 assistant message（跨多 message）', () => {
    const list = [
      { id: 'a1', role: 'assistant', toolCalls: [{ id: 'tc-old', toolName: 'read', input: {}, status: 'completed', startTime: 0 }] },
      { id: 'a2', role: 'assistant', toolCalls: [{ id: 'tc-1', toolName: 'edit', input: {}, status: 'running', startTime: 0 }] },
    ] as never
    expect(findToolCallOwner(list, 'tc-1')).toBe(1)
    expect(findToolCallOwner(list, 'tc-old')).toBe(0)
  })

  it('从后往前扫，命中最新含该 toolCall 的 message', () => {
    const list = [
      { id: 'a1', role: 'assistant', toolCalls: [{ id: 'tc-dup', toolName: 'read', input: {}, status: 'completed', startTime: 0 }] },
      { id: 'a2', role: 'assistant', toolCalls: [{ id: 'tc-dup', toolName: 'read', input: {}, status: 'running', startTime: 0 }] },
    ] as never
    expect(findToolCallOwner(list, 'tc-dup')).toBe(1)
  })

  it('未命中返回 -1（含非 assistant message 跳过）', () => {
    const list = [
      { id: 'u1', role: 'user', toolCalls: [{ id: 'tc-x', toolName: 'read', input: {}, status: 'running', startTime: 0 }] },
      { id: 'a1', role: 'assistant', toolCalls: [] },
    ] as never
    expect(findToolCallOwner(list, 'tc-x')).toBe(-1)
    expect(findToolCallOwner(list, 'nope')).toBe(-1)
  })
})

describe('tool_call_end/update — ID 锚定（乱序免疫）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('U5: tool_call_end 命中正确 toolCall（即使空 assistant message 插在后面）', () => {
    const store = useChatStore()
    const sid = 's5'
    // assistant#0 建 tc-1(running)
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a0' } })
    store.applyMessageEvent(sid, { type: 'message.tool_call_start', payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc-1', toolName: 'read', arguments: { path: '/f' }, timestamp: new Date(0).toISOString() } } })

    // 模拟 toolResult 噪声：空 assistant#1 插在后面（虽然 W1 已在 runtime 侧过滤，
    // 但防御：万一漏网，前端 ID 锚定仍应正确命中）
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a1' } })

    // tool_call_end(tc-1) 必须命中 assistant#0（ID 锚定），不能落在空 assistant#1
    store.applyMessageEvent(sid, { type: 'message.tool_call_end', payload: { sessionId: sid, entry: { type: 'message', parentId: null, timestamp: new Date(0).toISOString(), message: { role: 'toolResult', toolCallId: 'tc-1', content: [{ type: 'text', text: 'done' }], isError: false, timestamp: 0 } } } })

    const msgs = store.getMessages(sid)
    const owner = msgs[0] // assistant#0
    expect(owner.id).toBe('a0')
    expect(owner.toolCalls![0].status).toBe('completed')
    expect(owner.toolCalls![0].output).toBe('done')
    // 空 assistant#1 无 toolCalls
    expect(msgs[1].toolCalls).toBeUndefined()
  })

  it('U8: tool_call_update 命中正确 toolCall（ID 锚定，非位置）', () => {
    const store = useChatStore()
    const sid = 's8'
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a0' } })
    store.applyMessageEvent(sid, { type: 'message.tool_call_start', payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc-1', toolName: 'bash', arguments: {}, timestamp: new Date(0).toISOString() } } })
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a1' } })

    store.applyMessageEvent(sid, { type: 'message.tool_call_update', payload: { sessionId: sid, toolCallId: 'tc-1', detail: '读取中' } })

    const msgs = store.getMessages(sid)
    expect(msgs[0].toolCalls![0].detail).toBe('读取中')
    expect(msgs[1].toolCalls).toBeUndefined()
  })

  it('U9: toolCallId 未命中任何 message 时安全 return（不崩溃、不误改其它 toolCall）', () => {
    const store = useChatStore()
    const sid = 's9'
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a0' } })
    store.applyMessageEvent(sid, { type: 'message.tool_call_start', payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc-1', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() } } })

    // toolCallId 'tc-ghost' 不存在任何 message（历史消息无索引 / 已归档场景）
    store.applyMessageEvent(sid, { type: 'message.tool_call_end', payload: { sessionId: sid, entry: { type: 'message', parentId: null, timestamp: new Date(0).toISOString(), message: { role: 'toolResult', toolCallId: 'tc-ghost', content: [{ type: 'text', text: 'ghost' }], isError: false, timestamp: 0 } } } })

    const msgs = store.getMessages(sid)
    // tc-1 不被误改（仍 running，未被 ghost 的 end 污染）
    expect(msgs[0].toolCalls![0].id).toBe('tc-1')
    expect(msgs[0].toolCalls![0].status).toBe('running')
  })
})

describe('message.complete — 残留 running toolCall 收尾', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('U6: 正常 stopReason，残留 running 收尾为 end_not_received', () => {
    const store = useChatStore()
    const sid = 's6'
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a0' } })
    store.applyMessageEvent(sid, { type: 'message.tool_call_start', payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc-1', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() } } })
    // 跳过 tool_call_end（模拟丢失），直接 complete
    store.applyMessageEvent(sid, { type: 'message.complete', payload: { sessionId: sid, stopReason: 'end_turn' } })

    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('complete')
    expect(msgs[0].toolCalls![0].status).toBe('end_not_received')
  })

  it('U7: error stopReason，残留 running 收尾为 error', () => {
    const store = useChatStore()
    const sid = 's7'
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a0' } })
    store.applyMessageEvent(sid, { type: 'message.tool_call_start', payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc-1', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() } } })
    store.applyMessageEvent(sid, { type: 'message.complete', payload: { sessionId: sid, stopReason: 'error' } })

    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('error')
    expect(msgs[0].toolCalls![0].status).toBe('error')
  })

  it('U11: 正常到达的 tool_call_end 不被收尾覆盖（仍是 completed）', () => {
    const store = useChatStore()
    const sid = 's11'
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a0' } })
    store.applyMessageEvent(sid, { type: 'message.tool_call_start', payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc-1', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() } } })
    store.applyMessageEvent(sid, { type: 'message.tool_call_end', payload: { sessionId: sid, entry: { type: 'message', parentId: null, timestamp: new Date(0).toISOString(), message: { role: 'toolResult', toolCallId: 'tc-1', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 0 } } } })
    store.applyMessageEvent(sid, { type: 'message.complete', payload: { sessionId: sid, stopReason: 'end_turn' } })

    const msgs = store.getMessages(sid)
    expect(msgs[0].toolCalls![0].status).toBe('completed') // 未被收尾覆盖
    expect(msgs[0].toolCalls![0].output).toBe('ok')
  })
})

describe('end_not_received — 下游消费点', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('U15: deriveStatus 遇 end_not_received 不返回 waiting（已结束，非进行中）', () => {
    const store = useChatStore()
    const sid = 's15'
    // 最后一条 toolCall 是 end_not_received（已收尾，非 running）
    store.hydrate(sid, [{
      id: 'a1', role: 'assistant', content: 'done', status: 'complete',
      toolCalls: [{ id: 'tc-1', toolName: 'read', input: {}, status: 'end_not_received', startTime: 0 }],
      timestamp: Date.now(),
    }])
    // isActive=false（流已结束）
    const status = deriveStatus(sid, store, false)
    expect(status).not.toBe('waiting') // end_not_received 不当 waiting
  })
})

describe('W1: isActive 作为 UI 层 SSOT — deriveStatus 消费 isActive（含 pendingSend 空窗）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('pendingSend 空窗期 deriveStatus 应返回 pending（isActive=true）', () => {
    const store = useChatStore()
    const sid = 's-pending'
    // 用户已提交但 message_start 未到（空窗期）
    store.addPendingSend(sid)
    expect(store.isActive(sid)).toBe(true)
    // deriveStatus 消费 isActive 应返回 pending（已提交待确认，8 态 SSOT）
    const status = deriveStatus(sid, store, true)
    expect(status).toBe('pending')
  })

  it('isActive 不再受 activeId 限定：非活跃 session 的 pendingSend 也应驱动状态', () => {
    // 这个测试验证：即使 session 不是 activeId，只要有 pendingSend，
    // deriveStatus 也应该返回 pending（通过 isActive）
    const store = useChatStore()
    const sid = 's-other'
    // 模拟非活跃 session 有 pendingSend
    store.addPendingSend(sid)
    expect(store.isActive(sid)).toBe(true)
    // 关键：deriveStatus 的第三个参数应该用 isActive，而不是 isGenerating && activeId
    // 修复后：调用方应该传入 isActive，而不是手动计算 isStreaming
    const status = deriveStatus(sid, store, store.isActive(sid))
    // 预期：应返回 pending（因为 isActive=true）
    expect(status).toBe('pending')
  })

  it('isCompacting 独立于 deriveStatus：compact 期间 isActive 仍可驱动 pending', () => {
    const store = useChatStore()
    const sid = 's-compact'
    // 设置 compacting 态
    store.setOccupancy(sid, { turn: 'idle', compacting: true, bash: false })
    expect(store.isCompacting(sid)).toBe(true)
    // 同时有 pendingSend（用户在 compact 期间提交了新消息）
    store.addPendingSend(sid)
    expect(store.isActive(sid)).toBe(true)
    // deriveStatus 第三参数 isActive=true（isCompacting 默认 false 未透传）→ 返回 pending
    const status = deriveStatus(sid, store, true)
    expect(status).toBe('pending')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 节 3/7 — 来源: src/__tests__/composables/useHandoffEffect.test.ts
// ══════════════════════════════════════════════════════════════════════════

/**
 * useHandoffEffect 单测 —— fast-handoff 全局订阅（agent-driven 模式 wave2 简化版）。
 *
 * bindHandoffEffect（[chat-flow-consistency §6 裁决表「状态机｜交接在途状态归属」行] Set 退役后）只做一件事（刷新 + 跳转）：
 * - 订阅 session.handoffComplete → loadSessions().catch(warn)
 *   .then(() => selectSession(newSessionId)).catch(warn)。
 * - session.handoffAborted 订阅已移除（唯一副作用是旧 handingOffSessions Set 复位；
 *   handingOff membership 现归 occupancy 派生视图，复位 = runtime 'handingOff-end' 原语
 *   经 session.occupancy 帧到达——本效果不再写任何状态）。
 * onScopeDispose 时退订订阅。
 *
 * wave2 删除了所有 doc/reply 注入逻辑（appendUser / chatApi.send / ensureStreamSubscription /
 * disposeSession / hydrate 预标记 / 回滚）——这些都归 runtime HandoffService（newClient.prompt(doc)
 * 把文档注入新 session 触发新 turn）。广播 payload 因此移除 doc / reply 字段。
 *
 * 覆盖用例（AGENTS #5：每用例含用户可见/状态断言）：
 * - TC1 正常路径：handoffComplete → loadSessions + selectSession(NEW)；不写本地 handingOff 状态
 *   （置位/复位权威在 runtime occupancy 帧，效果层零状态写）
 * - TC2 loadSessions 失败降级：loadSessions reject → console.warn('loadSessions failed') + selectSession 仍调
 * - TC3 selectSession 失败兜底：selectSession reject → console.warn('selectSession failed')（.catch 兜底，无 unhandled rejection）
 * - TC4 handoffAborted：订阅已移除 → 零副作用（loadSessions/selectSession 不调，occupancy 状态不动）
 * - TC5 scope.stop() 退订：广播不再触发任何副作用
 *
 * mock 策略（收窄，删除 wave1 时代的 doc 注入 mock）：
 * - vi.mock('@/composables/features/sidebar/useSidebar')：loadSessions / selectSession 用 vi.fn（可 reject 测失败路径）。
 * - events / useChatStore 用**真实**实现（验 isHandingOff 读 occupancy 派生视图的真实读口，
 *   AGENTS #5 用户可见断言）。events 不 mock，用真实 dispatchGlobal 派发。
 *
 * 生命周期：bindHandoffEffect 用 effectScope 包裹（onScopeDispose 需 active scope），
 * scope.stop() 触发 onScopeDispose 退订。beforeEach 重建 scope + afterEach stop 兜底清干净
 * （events.ts 的 globalTypeHandlers 是模块级 Map，scope.stop 经 onScopeDispose 从中删除 handler）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useHandoffEffect.test.ts
 */


const SRC = 'src-1'
const NEW = 'new-1'
const SOURCE_LABEL = 'src-session'

let scope: ReturnType<typeof effectScope> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 重置默认 resolve（个别用例 mockRejectedValueOnce 后清 mock 恢复默认）
  sidebarMock.loadSessions.mockResolvedValue(undefined)
  sidebarMock.selectSession.mockResolvedValue(undefined)

  // 在独立 effectScope 内 bind：满足 onScopeDispose 需 active scope（无则 warn），
  // scope.stop() 触发 onScopeDispose 退订，作 afterEach 兜底。
  scope = effectScope()
  scope.run(() => bindHandoffEffect())
})

afterEach(() => {
  // scope.stop() 触发 onScopeDispose → off 退订（TC5 也依赖此；其它用例防 handler 残留到下一用例）
  scope?.stop()
  scope = null
})

/** 构造一条 session.handoffComplete 消息并经 global 通道派发（走真实 events 路径）。 */
function emitHandoffComplete(
  overrides: Partial<{ srcSessionId: string; newSessionId: string; sourceLabel: string }> = {},
): void {
  const payload = {
    srcSessionId: overrides.srcSessionId ?? SRC,
    newSessionId: overrides.newSessionId ?? NEW,
    sourceLabel: overrides.sourceLabel ?? SOURCE_LABEL,
  }
  events.dispatchGlobal({ type: 'session.handoffComplete', payload } as unknown as ServerMessage)
}

/** 构造一条 session.handoffAborted 消息并经 global 通道派发。 */
function emitHandoffAborted(srcSessionId: string = SRC): void {
  events.dispatchGlobal({ type: 'session.handoffAborted', payload: { srcSessionId } } as unknown as ServerMessage)
}

/** 经权威通路（session.occupancy 帧）把源 session 置交接在途（裁决表行：membership 唯一来源）。 */
function seedHandingOff(): void {
  const chat = useChatStore()
  chat.setOccupancy(SRC, { turn: 'idle', compacting: false, bash: false, handingOff: true })
  expect(chat.isHandingOff(SRC)).toBe(true)
}

describe('useHandoffEffect.bindHandoffEffect', () => {
  it('TC1 正常路径：handoffComplete → loadSessions + selectSession(NEW)；不写本地 handingOff 状态', async () => {
    const chat = useChatStore()
    seedHandingOff()

    emitHandoffComplete()
    await vi.waitFor(() => { expect(sidebarMock.loadSessions).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(sidebarMock.selectSession).toHaveBeenCalledWith(NEW) })

    // [§6 裁决表行] 效果层零状态写：handingOff 复位归 runtime 'handingOff-end' 原语（occupancy 帧），
    // 本订阅只编排刷新 + 跳转——本地派生视图未被本效果改动
    expect(chat.isHandingOff(SRC)).toBe(true)
    // loadSessions 调 1 次
    expect(sidebarMock.loadSessions).toHaveBeenCalledTimes(1)
    // 跳转到新 session
    expect(sidebarMock.selectSession).toHaveBeenCalledTimes(1)
    expect(sidebarMock.selectSession).toHaveBeenCalledWith(NEW)
  })

  it('TC2 loadSessions 失败降级：reject → .catch 兜底 warn（selectSession 不调，loadSessions 内部 try/catch 不会 reject，此路径仅 mock 验证兜底健壮性）', async () => {
    sidebarMock.loadSessions.mockRejectedValue(new Error('network'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    emitHandoffComplete()
    // loadSessions reject → .then 不执行 → selectSession 不调；rejection 传播到末尾 .catch
    await vi.waitFor(() => {
      const selectWarn = warnSpy.mock.calls.find((c) =>
        String(c[0]).includes('selectSession failed'),
      )
      expect(selectWarn).toBeDefined()
    })

    // [兜底] loadSessions reject 被末尾 .catch 捕获（warn 'selectSession failed'）
    const selectWarn = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('selectSession failed'),
    )
    expect(selectWarn).toBeDefined()
    // selectSession 未调用（.then 未执行）
    expect(sidebarMock.selectSession).not.toHaveBeenCalled()

    // 排空 microtask 队列，确认 .catch 已兜底无 unhandledRejection
    await new Promise((r) => setTimeout(r, 0))

    warnSpy.mockRestore()
  })

  it('TC3 selectSession 失败兜底：reject → console.warn(selectSession failed)，无 unhandled rejection', async () => {
    sidebarMock.selectSession.mockRejectedValue(new Error('boom'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    emitHandoffComplete()
    // 等 .catch 链跑完（loadSessions resolve → then(selectSession reject) → catch warn）
    await vi.waitFor(() => {
      const selectWarn = warnSpy.mock.calls.find((c) =>
        String(c[0]).includes('selectSession failed'),
      )
      expect(selectWarn).toBeDefined()
    })

    // [兜底] selectSession 失败已 warn（.catch 吞掉异常，保留排查线索）
    const selectWarn = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('selectSession failed'),
    )
    expect(selectWarn).toBeDefined()

    // 排空 microtask 队列，确认 .catch 已兜底无 unhandledRejection
    await new Promise((r) => setTimeout(r, 0))

    warnSpy.mockRestore()
  })

  it('TC4 handoffAborted：订阅已移除（裁决表行）→ 零副作用，occupancy 状态不动', async () => {
    const chat = useChatStore()
    seedHandingOff()

    emitHandoffAborted(SRC)
    await new Promise((r) => setTimeout(r, 0))

    // [§6 裁决表行] handoffAborted 订阅随 Set 复位职责退役：无列表刷新、无跳转、状态不写
    //（aborted 形态的 handingOff 复位由 runtime cleanupInflight 的 'handingOff-end' 原语
    // 经 session.occupancy 帧承担）
    expect(chat.isHandingOff(SRC)).toBe(true)
    expect(sidebarMock.loadSessions).not.toHaveBeenCalled()
    expect(sidebarMock.selectSession).not.toHaveBeenCalled()
  })

  it('TC5 scope.stop() 退订：handoffComplete 不再触发任何副作用', async () => {
    const chat = useChatStore()
    seedHandingOff()

    // 先停 scope（触发 onScopeDispose → off 退订）
    scope!.stop()
    scope = null

    emitHandoffComplete()
    emitHandoffAborted(SRC)
    // 兜底等待，确认副作用从未发生
    await new Promise((r) => setTimeout(r, 0))

    // 退订后广播不触发任何副作用：handingOff 状态未变 + 无刷新/跳转
    expect(chat.isHandingOff(SRC)).toBe(true)
    expect(sidebarMock.loadSessions).not.toHaveBeenCalled()
    expect(sidebarMock.selectSession).not.toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 节 4/7 — 来源: src/__tests__/stores/m7-virtual-key-cleanup.test.ts
// ══════════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════════
// 节 5/7 — 来源: src/__tests__/composables/status-cache.test.ts
// ══════════════════════════════════════════════════════════════════════════

/**
 * W3: useSessionDerivations statusOf 缓存化 + invalidateStatusCache。
 *
 * 覆盖：
 * - AC-2：同 id 多次调用 derivedStatus 返回同一 ComputedRef 实例（缓存命中）
 * - 不同 id 返回不同实例
 * - invalidateStatusCache(sessionId) 清除指定 id 缓存，下次调用新建
 * - invalidateStatusCache() 无参清除全部
 * - deleteSession 集成：disposeSession 后调 invalidate 清理
 *
 * 运行：npx vitest run src/__tests__/composables/status-cache.test.ts
 */

describe('W3: derivedStatus 缓存复用（AC-2）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('同 id 多次调用返回同一 ComputedRef 实例', () => {
    const { derivedStatus } = useSessionDerivations()
    const c1 = derivedStatus('s1')
    const c2 = derivedStatus('s1')
    expect(c1).toBe(c2) // 同一引用 = 缓存命中
  })

  it('不同 id 返回不同 ComputedRef 实例', () => {
    const { derivedStatus } = useSessionDerivations()
    const c1 = derivedStatus('s1')
    const c2 = derivedStatus('s2')
    expect(c1).not.toBe(c2)
  })

  it('缓存值正确反映 session 状态', () => {
    const chat = useChatStore()
    const { derivedStatus } = useSessionDerivations()
    // 未 hydrate session → done
    const c = derivedStatus('s-empty')
    expect(c.value).toBe('done')
    // hydrate 一条 error 消息
    chat.hydrate('s-empty', [
      { id: 'm1', role: 'assistant', content: 'err', status: 'error', timestamp: 1 },
    ])
    // 缓存的 computed 应响应式更新（依赖 messages 变化）
    expect(c.value).toBe('error')
  })
})

describe('W3: invalidateStatusCache', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('invalidateStatusCache(id) 清除指定 id，下次调用新建实例', () => {
    const { derivedStatus, invalidateStatusCache } = useSessionDerivations()
    const c1 = derivedStatus('s1')
    invalidateStatusCache('s1')
    const c2 = derivedStatus('s1')
    expect(c1).not.toBe(c2) // 清除后新建
  })

  it('invalidateStatusCache(id) 不影响其他 id 缓存', () => {
    const { derivedStatus, invalidateStatusCache } = useSessionDerivations()
    const c1 = derivedStatus('s1')
    const c2 = derivedStatus('s2')
    invalidateStatusCache('s1')
    expect(derivedStatus('s2')).toBe(c2) // s2 缓存仍在
  })

  it('invalidateStatusCache() 无参清除全部', () => {
    const { derivedStatus, invalidateStatusCache } = useSessionDerivations()
    const c1 = derivedStatus('s1')
    const c2 = derivedStatus('s2')
    invalidateStatusCache()
    expect(derivedStatus('s1')).not.toBe(c1)
    expect(derivedStatus('s2')).not.toBe(c2)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 节 6/7 — 来源: src/__tests__/stores/chat-bash-effects.test.ts
// ══════════════════════════════════════════════════════════════════════════

/**
 * w1 timer-decouple 回归测试（bash-align-pi-tui-w4::w1-timer-decouple；
 * W1 fix-chat-flow-order entry 化后种子方式更新）。
 *
 * 锁定行为（[timeout-streaming-ui-idle u-s3] dormant bash timer 契约整链删除后，
 * bash 收尾只剩 bashResult entry 化 + markBashError 兜底两条真实路径）：
 * - W1T2：bashResult entry 化后消息恒 complete，推进 300s 无任何 timer 再触碰
 *   （原 W1T1 的 300s bash timer 随 dormant 契约删除，本用例检查「无 timer 误触」不变式）。
 * - W1T3：markBashError 清 executingBash（abortBash RPC 失败兜底）。
 * - W1T3b：markBashError 对手动种子的 streaming bash 消息仍推 error 态（防御路径保留）。
 *
 * [W1 fix-chat-flow-order] bashStart 不再创建 streaming bash 消息（改写 ephemeral
 * executingBash）——W1T3b 的「streaming bash 消息」种子改为手动 setMessages 注入
 * （防御场景：entry 化后正常流转不产生 streaming bash 消息，仅手动种子可触发该路径）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/chat-bash-effects.test.ts
 */

/** 手动种子：streaming bash 消息（entry 化后正常流转不产生，仅手动注入可达） */
function streamingBashMsg(command: string): Message {
  return {
    id: `bash-${command}`,
    role: 'system',
    content: '',
    status: 'streaming',
    bashExecution: {
      command,
      output: '',
      exitCode: null,
      cancelled: false,
      truncated: false,
      excludeFromContext: false,
      timestamp: 0,
    },
  } as Message
}

describe('w1 bash 收尾链（entry 化 + markBashError 兜底，bash timer 契约已删除）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })
  afterEach(() => vi.useRealTimers())

  it('W1T2: bashStart→bashResult entry 化后消息恒 complete，推进 300s 无 timer 再触碰', () => {
    const store = useChatStore()
    const sid = 's-w1t2'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'echo hi', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    // [W1 fix-chat-flow-order] bashStart 不建消息项（ephemeral 执行态；bash timer 挂点已随
    // dormant 契约删除）
    expect(store.getMessages(sid)).toHaveLength(0)

    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: {
        sessionId: sid,
        command: 'echo hi',
        output: 'hi',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 2000,
      },
    } as ServerMessage)

    // 消息经 entry 入流即为 complete（无 streaming 中间态）
    expect(store.getMessages(sid)[0].status).toBe('complete')

    // 推进 300s：无任何 timer 回调触碰这条已 complete 的消息（bash timer 契约已删除）
    vi.advanceTimersByTime(300_000)
    const after = store.getMessages(sid)
    expect(after[0].status).toBe('complete')
    expect(after[0].bashExecution?.cancelled).toBe(false)
  })

  it('W1T3: markBashError 清 executingBash（abortBash RPC 失败兜底）', () => {
    const store = useChatStore()
    const sid = 's-w1t3'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'sleep 5', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    expect(getExecutingBash(sid)).toBeDefined()

    // messagesRef 用 storeToRefs 拿真 ref：markBashError 内 commitMessages 整体替换写回 store。
    const messagesRef = storeToRefs(store).messages
    markBashError(messagesRef, sid, 'abort rpc failed')

    // executingBash 已清（abortBash RPC 失败时无 bashResult 帧到达的唯一兜底清点）
    expect(getExecutingBash(sid)).toBeUndefined()
  })

  it('W1T3b: markBashError 对手动种子的 streaming bash 消息仍推 error 态（防御路径保留）', () => {
    const store = useChatStore()
    const sid = 's-w1t3b'
    store.setMessages(sid, [streamingBashMsg('sleep 5')])
    const messagesRef = storeToRefs(store).messages

    markBashError(messagesRef, sid, 'abort rpc failed')

    const m = store.getMessages(sid)[0]
    expect(m.status).toBe('error')
    expect(m.bashExecution?.cancelled).toBe(true)
    expect(m.error).toBe('abort rpc failed')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 节 7/7 — 来源: src/__tests__/effects/custom-start-details.test.ts
// ══════════════════════════════════════════════════════════════════════════

/**
 * customStart details 保留单测（审计项 A）。
 *
 * 验证：extension 通过 message.customMessage/customStart 推送的 `__gui__` 结构化
 * 渲染数据，经 customStart effect 构造的 system Message 时，details 字段被原样保留，
 * 前端可据此路由到 GuiComponentRenderer。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/custom-start-details.test.ts
 */

describe('customStart details 保留（审计项 A）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('customStart 带 details.__gui__ → msg.details 原样保留', () => {
    const store = useChatStore()
    const guiDetails = {
      __gui__: {
        v: 1,
        component: { type: 'stats-line', props: { items: [] } },
      },
    }
    store.applyMessageEvent('sx', {
      type: 'message.customStart',
      payload: {
        sessionId: 'sx',
        customType: 'gui-component',
        content: 'GUI 组件渲染',
        details: guiDetails,
      },
    })
    const msgs = store.getMessages('sx')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].customType).toBe('gui-component')
    // 关键断言：details 字段被保留（含 __gui__）
    expect(msgs[0].details).toBeDefined()
    expect(msgs[0].details).toEqual(guiDetails)
    expect((msgs[0].details as Record<string, unknown>).__gui__).toBeDefined()
  })

  it('customStart 无 details → msg.details 无 __gui__（不触发 GUI 路由）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.customStart',
      payload: {
        sessionId: 'sx',
        customType: 'plain',
        content: '无 details',
      },
    })
    const msgs = store.getMessages('sx')
    expect(msgs).toHaveLength(1)
    // readRecord 缺省返回 {}，details 为空对象，不携带 __gui__，前端不会误路由
    const details = msgs[0].details as Record<string, unknown> | undefined
    expect(details?.__gui__).toBeUndefined()
  })

  it('customStart subagent-bg-notify 保留原始 details（bgNotify 字段已删，§3.3.6）', () => {
    const store = useChatStore()
    const bgDetails = {
      id: 'job-1',
      status: 'done',
      agent: 'coder',
      model: 'claude-4.5',
      result: 'Done.',
      startedAt: 1000,
      endedAt: 13000,
    }
    store.applyMessageEvent('sx', {
      type: 'message.customStart',
      payload: {
        sessionId: 'sx',
        customType: 'subagent-bg-notify',
        content: 'Subagent done.',
        details: bgDetails,
      },
    })
    const msgs = store.getMessages('sx')
    expect(msgs).toHaveLength(1)
    // details 原始字段被保留
    expect(msgs[0].details).toEqual(bgDetails)
  })
})

// ══════════════════════════════════════════════════════════════════════════