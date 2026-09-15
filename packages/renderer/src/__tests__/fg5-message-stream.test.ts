/**
 * FG5 单测 —— message-stream 回合分组纯逻辑 + chat store 块类型扩展。
 *
 * 覆盖：
 * - groupTurns：扁平 messages → 回合（user 开启 + assistant 归入，纯文字无折叠条）
 * - countThinking/countToolCalls/hasFailedTool：badge 统计 + 失败检测
 * - chat store：thinking/tool_call 流式块追加、hydrate 历史注入、error 块
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/fg5-message-stream.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  groupTurns,
  toRenderItems,
  countThinking,
  countToolCalls,
  hasFailedTool,
} from '@/composables/logic/messageTurns'
import { useChatStore } from '@/stores/chat'
import * as mockApi from '@taiji/core/transport/mock'
import type { Message } from '@taiji/shared'
import { textToSegments } from '@taiji/shared'

const NOW = Date.now()

function userMsg(id: string, content: string): Message {
  return { id, role: 'user', content, status: 'complete', timestamp: NOW }
}
function assistantMsg(id: string, content: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content, status: 'complete', timestamp: NOW, ...extra }
}
function systemMsg(id: string, content: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'system', content, status: 'complete', timestamp: NOW, ...extra }
}

describe('FG5 groupTurns 回合分组', () => {
  it('user + assistant → 单回合（含 user 起点与 assistant 收尾）', () => {
    const turns = groupTurns([userMsg('u1', 'hi'), assistantMsg('a1', 'hello')])
    expect(turns).toHaveLength(1)
    expect(turns[0].user?.id).toBe('u1')
    expect(turns[0].assistants).toHaveLength(1)
    expect(turns[0].assistants[0].content).toBe('hello')
  })

  it('多 user 消息 → 每个 user 开启新回合', () => {
    const turns = groupTurns([
      userMsg('u1', 'q1'),
      assistantMsg('a1', 'r1'),
      userMsg('u2', 'q2'),
      assistantMsg('a2', 'r2'),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[0].user?.id).toBe('u1')
    expect(turns[1].user?.id).toBe('u2')
  })

  it('纯文字回合（无 thinking/tool）→ hasFoldable=false（无折叠条）', () => {
    const turns = groupTurns([userMsg('u1', 'q'), assistantMsg('a1', '纯文字回答')])
    expect(turns[0].hasFoldable).toBe(false)
  })

  it('含 toolCalls 的回合 → hasFoldable=true', () => {
    const turns = groupTurns([
      userMsg('u1', '读文件'),
      assistantMsg('a1', '已读', {
        toolCalls: [
          {
            id: 'tc1',
            toolName: 'read',
            input: {},
            status: 'completed',
            startTime: NOW,
          },
        ],
      }),
    ])
    expect(turns[0].hasFoldable).toBe(true)
    expect(countToolCalls(turns[0])).toBe(1)
  })

  it('含 thinking 块 → countThinking 统计', () => {
    const turns = groupTurns([
      userMsg('u1', '思考'),
      assistantMsg('a1', '结论', {
        thinking: [{ id: 'th1', content: '推理过程', collapsed: true }],
      }),
    ])
    expect(turns[0].hasFoldable).toBe(true)
    expect(countThinking(turns[0])).toBe(1)
  })

  it('失败的 tool → hasFailedTool=true', () => {
    const turns = groupTurns([
      userMsg('u1', '提交'),
      assistantMsg('a1', '失败', {
        toolCalls: [
          {
            id: 'tc1',
            toolName: 'bash',
            input: {},
            output: 'EBUSY',
            status: 'error',
            startTime: NOW,
          },
        ],
      }),
    ])
    expect(hasFailedTool(turns[0])).toBe(true)
  })

  it('最后一条 assistant streaming → isStreaming=true（其余 false）', () => {
    const turns = groupTurns([
      userMsg('u1', 'q1'),
      assistantMsg('a1', 'r1'),
      userMsg('u2', 'q2'),
      assistantMsg('a2', '正在', { status: 'streaming' }),
    ])
    expect(turns[0].isStreaming).toBe(false)
    expect(turns[1].isStreaming).toBe(true)
  })

  // CW wave session-active-ssot T4：forceWorking（subagent 虚拟 session 强制 streaming 态）
  // 映射到最后一个 turn 的 isStreaming（重命名自 isWorking）。
  it('toRenderItems forceWorking=true → 最后一个 turn isStreaming=true（subagent 强制态）', () => {
    const items = toRenderItems(
      [
        userMsg('u1', 'q1'),
        assistantMsg('a1', 'r1', { status: 'complete' }), // status complete，靠 forceWorking 强制
      ],
      /* forceWorking */ true,
    )
    const turn = items[0]
    expect(turn.kind).toBe('turn')
    if (turn.kind === 'turn') {
      // forceWorking 让最后 turn 的 isStreaming=true，即便 status 非 streaming
      expect(turn.turn.isStreaming).toBe(true)
    }
  })

  it('首条 assistant 无前置 user → 自启回合（边缘情况）', () => {
    const turns = groupTurns([assistantMsg('a1', '无前置')])
    expect(turns).toHaveLength(1)
    expect(turns[0].user).toBeNull()
    expect(turns[0].assistants[0].id).toBe('a1')
  })

  // P2-1（WP-L3-08）：steer 续轮产生多 assistant 同回合，
  // Turn.vue 仅最后一条作收尾 summary，前序 content 折进 trace（isMidAssistant）。
  it('多 assistant 同回合（steer 续轮）→ 前序归入，末条作收尾', () => {
    const turns = groupTurns([
      userMsg('u1', '改一下登录'),
      assistantMsg('a1', '正在处理 schema…'), // steer 前的中间产出
      assistantMsg('a2', '已将 AuthService.login 改为 async。'), // 收尾
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].assistants).toHaveLength(2)
    // Turn.vue 的 isMidAssistant(idx) = idx < length-1 → a1 是中间，a2 是收尾
    const last = turns[0].assistants[turns[0].assistants.length - 1]
    expect(last.id).toBe('a2')
    expect(last.content).toBe('已将 AuthService.login 改为 async。')
    // 收尾 summary 恒显（draft §4：收尾位固定不折叠）
    expect(turns[0].assistants[0].content).toBe('正在处理 schema…')
  })

  // W07-C：system 消息（compaction/branch）作独立项穿插，不归入 turn
  it('toRenderItems：system 消息穿插在 turn 之间，groupTurns 过滤掉 system', () => {
    const items = toRenderItems([
      userMsg('u1', 'q'),
      assistantMsg('a1', 'r'),
      systemMsg('s1', 'system notice'),
      userMsg('u2', 'q2'),
      assistantMsg('a2', 'r2'),
    ])
    // 顺序：turn(u1+a1) → systemNotice(s1) → turn(u2+a2)
    expect(items.map((i) => i.kind)).toEqual(['turn', 'systemNotice', 'turn'])
    const sysItem = items[1]
    if (sysItem.kind !== 'systemNotice') throw new Error('expected systemNotice item')
    expect(sysItem.message.content).toBe('system notice')
    // groupTurns 过滤掉 system，只剩 2 个 turn
    const turns = groupTurns([
      userMsg('u1', 'q'),
      assistantMsg('a1', 'r'),
      systemMsg('s1', 'bash'),
      userMsg('u2', 'q2'),
      assistantMsg('a2', 'r2'),
    ])
    expect(turns).toHaveLength(2)
  })
})

describe('FG5 chat store 块类型扩展', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('hydrate 注入历史且标记（重复调用幂等）', () => {
    const store = useChatStore()
    const history = [userMsg('u1', '历史'), assistantMsg('a1', '历史回答')]
    store.hydrate('s1', history)
    store.hydrate('s1', history) // 重复不覆盖
    expect(store.isHydrated('s1')).toBe(true)
    expect(store.getMessages('s1')).toHaveLength(2)
  })

  it('hydrate 深拷贝：外部突变不污染 store', () => {
    const store = useChatStore()
    const history = [userMsg('u1', '原内容')]
    store.hydrate('s1', history)
    history[0].content = '改了'
    expect(store.getMessages('s1')[0].content).toBe('原内容')
  })

  it('applyMessageEvent 处理 thinking 块（start + delta）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.message_start',
      payload: { sessionId: 'sx', messageId: 'a1' },
    })
    store.applyMessageEvent('sx', {
      type: 'message.thinking_start',
      payload: { sessionId: 'sx', thinkingId: 'th1' },
    })
    store.applyMessageEvent('sx', {
      type: 'message.thinking_delta',
      payload: { sessionId: 'sx', delta: '推理' },
    })
    const msgs = store.getMessages('sx')
    expect(msgs[0].thinking).toHaveLength(1)
    expect(msgs[0].thinking?.[0].content).toBe('推理')
  })

  it('applyMessageEvent 处理 tool_call 块（start + end）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.message_start',
      payload: { sessionId: 'sx', messageId: 'a1' },
    })
    store.applyMessageEvent('sx', {
      type: 'message.tool_call_start',
      payload: { sessionId: 'sx', entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() } },
    })
    store.applyMessageEvent('sx', {
      type: 'message.tool_call_end',
      payload: { sessionId: 'sx', entry: { type: 'message', parentId: null, timestamp: new Date(0).toISOString(), message: { role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: 'done' }], isError: false, timestamp: 0 } } },
    })
    const msgs = store.getMessages('sx')
    expect(msgs[0].toolCalls).toHaveLength(1)
    expect(msgs[0].toolCalls?.[0].status).toBe('completed')
  })

  it('complete with stopReason:error → status:error（错误块）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.message_start',
      payload: { sessionId: 'sx', messageId: 'a1' },
    })
    store.applyMessageEvent('sx', {
      type: 'message.complete',
      payload: { sessionId: 'sx', stopReason: 'error' },
    })
    expect(store.getMessages('sx')[0].status).toBe('error')
  })

  // ── W05-A: 4 个新 case（纯字段）─────────────────────────────────

  it('thinking_end 给最后 ThinkingBlock 设 endTime', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    store.applyMessageEvent('sx', { type: 'message.thinking_start', payload: { sessionId: 'sx', thinkingId: 'th1' } })
    store.applyMessageEvent('sx', { type: 'message.thinking_delta', payload: { sessionId: 'sx', delta: '推理' } })
    expect(store.getMessages('sx')[0].thinking?.[0].endTime).toBeUndefined()
    store.applyMessageEvent('sx', { type: 'message.thinking_end', payload: { sessionId: 'sx' } })
    expect(store.getMessages('sx')[0].thinking?.[0].endTime).toBeTypeOf('number')
  })

  it('tool_call_update 更新 ToolCall.detail（对齐生产端，只读 detail）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    store.applyMessageEvent('sx', { type: 'message.tool_call_start', payload: { sessionId: 'sx', entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'bash', arguments: {}, timestamp: new Date(0).toISOString() } } })
    // string detail
    store.applyMessageEvent('sx', { type: 'message.tool_call_update', payload: { sessionId: 'sx', toolCallId: 'tc1', detail: '执行中…' } })
    expect(store.getMessages('sx')[0].toolCalls?.[0].detail).toBe('执行中…')
    // object detail
    store.applyMessageEvent('sx', { type: 'message.tool_call_update', payload: { sessionId: 'sx', toolCallId: 'tc1', detail: { progress: 50 } } })
    expect(store.getMessages('sx')[0].toolCalls?.[0].detail).toEqual({ progress: 50 })
  })

  it('complete.usage 回填 Message.usage（inputTokens/outputTokens）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    store.applyMessageEvent('sx', {
      type: 'message.complete',
      payload: { sessionId: 'sx', stopReason: 'complete', usage: { inputTokens: 120, outputTokens: 80, totalTokens: 200 } },
    })
    expect(store.getMessages('sx')[0].usage).toEqual({ inputTokens: 120, outputTokens: 80 })
  })

  it('message.status 接收不崩（运行态，不改 Message.status）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    store.applyMessageEvent('sx', { type: 'message.status', payload: { sessionId: 'sx', status: 'steered', detail: '已转向' } })
    // status 仍是 streaming（message.status 是运行过程态，与 Message.status 正交）
    expect(store.getMessages('sx')[0].status).toBe('streaming')
  })

  // ── W06-B: store 级状态（retry/queue）───────────────────────────

  it('auto_retry_start 设置 retryState，auto_retry_end 清空', () => {
    const store = useChatStore()
    expect(store.getRetryState('sx')).toBeUndefined()
    store.applyMessageEvent('sx', {
      type: 'message.auto_retry_start',
      payload: { sessionId: 'sx', attempt: 2, maxAttempts: 3, delayMs: 500, errorMessage: 'timeout' },
    })
    expect(store.getRetryState('sx')).toEqual({ attempt: 2, maxAttempts: 3, delayMs: 500, errorMessage: 'timeout' })
    store.applyMessageEvent('sx', {
      type: 'message.auto_retry_end',
      payload: { sessionId: 'sx', success: true, attempt: 2 },
    })
    expect(store.getRetryState('sx')).toBeUndefined()
  })

  it('queue_update 设置 queueState（steering/followUp）', () => {
    const store = useChatStore()
    expect(store.getQueueState('sx')).toBeUndefined()
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', steering: ['再快一点'], followUp: ['下一步'] },
    })
    expect(store.getQueueState('sx')).toEqual({ steering: ['再快一点'], followUp: ['下一步'] })
    // 两字段都缺 → 清空
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx' },
    })
    expect(store.getQueueState('sx')).toBeUndefined()
  })

  it('queue_update 空数组 [] 视为无内容（pi 发 []，需清 queueState）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', steering: ['x'] },
    })
    expect(store.getQueueState('sx')?.steering).toEqual(['x'])
    // pi 发空数组（drain 完成后 _emitQueueUpdate 展开为 []）
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', steering: [], followUp: [] },
    })
    expect(store.getQueueState('sx')).toBeUndefined()
  })

  it('queue_update drain 驱动 appendUser（steer 投递，m1/m2 新 API）', () => {
    const store = useChatStore()
    // steer 入队：pushPending 暂存到 buffer（不进 messages）
    store.pushPending('sx', textToSegments('补充注册页'), 'steer')
    expect(store.getMessages('sx')).toHaveLength(0)
    expect(store.pendingBuffer.get('sx')).toHaveLength(1)
    // queue_update 入队（设置 queueState，prev 空故不 drain）
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', steering: ['补充注册页'] },
    })
    expect(store.getMessages('sx')).toHaveLength(0) // 仍未投递
    // pi drain 投递：queue_update 移除该项 → drainPending + appendUser 追加 complete user
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', steering: [] },
    })
    const msgs = store.getMessages('sx')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].status).toBe('complete')
    expect(store.pendingBuffer.get('sx') ?? []).toHaveLength(0)
  })

  it('queue_update drain 驱动 appendUser（followUp 投递）', () => {
    const store = useChatStore()
    store.pushPending('sx', textToSegments('下轮任务'), 'follow-up')
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', followUp: ['下轮任务'] },
    })
    // drain
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', followUp: [] },
    })
    const msgs = store.getMessages('sx')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].status).toBe('complete')
    expect(store.pendingBuffer.get('sx') ?? []).toHaveLength(0)
  })

  it('queue_update 重复文本 drain（B1 回归：计数 diff 精确匹配）', () => {
    const store = useChatStore()
    // 连发两条相同文本的 steer（pushPending 两条到 buffer）
    store.pushPending('sx', textToSegments('继续'), 'steer')
    store.pushPending('sx', textToSegments('继续'), 'steer')
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', steering: ['继续', '继续'] },
    })
    // pi drain 一条 → 队列剩一条
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', steering: ['继续'] },
    })
    let msgs = store.getMessages('sx')
    expect(msgs).toHaveLength(1) // 恰好 appendUser 一条
    expect(store.pendingBuffer.get('sx') ?? []).toHaveLength(1) // buffer 剩一条
    // 再 drain 最后一条
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', steering: [] },
    })
    msgs = store.getMessages('sx')
    expect(msgs).toHaveLength(2)
    expect(store.pendingBuffer.get('sx') ?? []).toHaveLength(0)
  })

  it('message_start 不干预 drain 结果（pi 保证 queue_update(drain) 先到）', () => {
    const store = useChatStore()
    // steer 入队
    store.pushPending('sx', textToSegments('补充'), 'steer')
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', steering: ['补充'] },
    })
    // pi 保证的真实时序：queue_update(drain) 先到 → drainPending + appendUser（complete user）
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', steering: [] },
    })
    let msgs = store.getMessages('sx')
    expect(msgs.some((m) => m.role === 'user' && m.status === 'complete')).toBe(true)
    expect(store.pendingBuffer.get('sx') ?? []).toHaveLength(0)
    // message_start 随后到达：建 streaming assistant，不干预已 complete 的 user 消息。
    // pi 源码（agent-session.ts 注释 "remove it BEFORE emitting"）保证 drain 不晚于 message_start。
    store.applyMessageEvent('sx', {
      type: 'message.message_start',
      payload: { sessionId: 'sx', messageId: 'a1' },
    })
    msgs = store.getMessages('sx')
    // user 消息仍 complete（未被误改）+ message_start 建 streaming assistant
    expect(msgs.some((m) => m.role === 'user' && m.status === 'complete')).toBe(true)
    expect(msgs.some((m) => m.role === 'assistant' && m.status === 'streaming')).toBe(true)
    // queueStates 已清（queue_update 空载删除，message_start 不重加）
    expect(store.getQueueState('sx')).toBeUndefined()
  })

  it('跨类型同文本 drain（W5：sendMode 精确匹配，steer 与 followUp 不互误）', () => {
    const store = useChatStore()
    // steer「补」和 followUp「补」文本相同（buffer 各一条）
    store.pushPending('sx', textToSegments('补'), 'steer')
    store.pushPending('sx', textToSegments('补'), 'follow-up')
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', steering: ['补'], followUp: ['补'] },
    })
    // 只 drain steer 那条（followUp 队列不动）
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', steering: [], followUp: ['补'] },
    })
    const msgs = store.getMessages('sx')
    // steer 那条 appendUser 入流（complete user，无 sendMode——m3 后不驱动配色），
    // followUp 那条仍在 buffer（sendMode 精确匹配，不误取）
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].status).toBe('complete')
    const buf = store.pendingBuffer.get('sx') ?? []
    expect(buf).toHaveLength(1)
    expect(buf[0].sendMode).toBe('follow-up')
  })

  it('retry/queue 状态按 session 隔离（互不串扰）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sa', { type: 'message.auto_retry_start', payload: { sessionId: 'sa', attempt: 1 } })
    store.applyMessageEvent('sb', { type: 'message.queue_update', payload: { sessionId: 'sb', steering: ['x'] } })
    expect(store.getRetryState('sa')?.attempt).toBe(1)
    expect(store.getRetryState('sb')).toBeUndefined()
    expect(store.getQueueState('sb')?.steering).toEqual(['x'])
    expect(store.getQueueState('sa')).toBeUndefined()
  })

  // ── W07-C: shared 类型扩展（compaction/branch 作 system 提示行）──

  it('compactionSummary 作 system 消息追加', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.compactionSummary',
      payload: { sessionId: 'sx', summary: '压缩完成', tokensBefore: 50000 },
    })
    const msg = store.getMessages('sx')[0]
    expect(msg.role).toBe('system')
    // [W6] compactionSummary 直插已 entry 化（与 replay 同路径）——compactionSummary 携带
    // timestamp（帧缺省时取当前时刻），与文件侧重放形态一致
    expect(msg.compactionSummary).toMatchObject({ summary: '压缩完成', tokensBefore: 50000 })
    expect(typeof msg.compactionSummary?.timestamp).toBe('number')
  })

  it('branchSummary 作 system 消息追加', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.branchSummary',
      payload: { sessionId: 'sx', summary: '新分支', fromId: 'msg-9' },
    })
    const msg = store.getMessages('sx')[0]
    expect(msg.role).toBe('system')
    // [D13 renderer-deepening] branchSummary 直插已 entry 化（与 replay 同路径）——
    // branchSummary 恒带 timestamp（帧缺省时取当前时刻），与文件侧重放形态一致；
    // content fallback 收敛 reducer 语义（summary 缺失 → 空串，原 'Branched' 占位消灭）
    expect(msg.content).toBe('新分支')
    expect(msg.branchSummary).toMatchObject({ summary: '新分支', fromId: 'msg-9' })
    expect(typeof msg.branchSummary?.timestamp).toBe('number')
  })

  it('mock getHistory 返回 fixture 全字段（G2-006 契约；[u6] 窗口契约三字段）', async () => {
    const s1 = await mockApi.chat.getHistory('s1')
    // N1 修复：getHistory 返回窗口契约（[u6] legacy historyTruncated 退役，truncated 唯一标志）
    expect(s1.truncated).toBe(false)
    expect(s1.messages.length).toBeGreaterThanOrEqual(2)
    // 含 user / assistant text / tool_call / 失败 tool
    const roles = s1.messages.map((m) => m.role)
    expect(roles).toContain('user')
    expect(roles).toContain('assistant')
    const withTools = s1.messages.find((m) => (m.toolCalls?.length ?? 0) > 0)
    expect(withTools).toBeTruthy()
  })

  it('mock getHistory 空会话返回空数组', async () => {
    const s3 = await mockApi.chat.getHistory('s3')
    expect(s3.truncated).toBe(false)
    expect(s3.messages).toEqual([])
  })

  // ── W10: FileChanges 通道（applyFileChanges + message.file_changes case）──
  // ADR-0024 D5 重构：baseline diff，isFullSet 恒 true（每次 diff 都是全量结果，全集替换不增量合并）。

  it('message.file_changes accumulating 全集替换（baseline diff 每次 diff 是全量结果）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    // 第一次 diff：写了一个文件
    store.applyMessageEvent('sx', {
      type: 'message.file_changes',
      payload: {
        sessionId: 'sx', messageId: 'a1',
        fileChanges: [{ filePath: 'src/a.ts', status: 'added', addLines: 10 }],
        changeSetStatus: 'accumulating', isFullSet: true,
      },
    })
    // 第二次 diff：写了两个文件（包含第一次的）—— isFullSet=true 全集替换
    store.applyMessageEvent('sx', {
      type: 'message.file_changes',
      payload: {
        sessionId: 'sx', messageId: 'a1',
        fileChanges: [
          { filePath: 'src/a.ts', status: 'added', addLines: 10 },
          { filePath: 'src/b.ts', status: 'modified', addLines: 3, delLines: 1 },
        ],
        changeSetStatus: 'accumulating', isFullSet: true,
      },
    })
    const msg = store.getMessages('sx')[0]
    // 全集替换：最终结果是第二次的两条，不是增量合并
    expect(msg.fileChanges).toHaveLength(2)
    expect(msg.fileChanges?.map((c) => c.filePath).sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(store.getChangeSetStatus('sx', 'a1')).toBe('accumulating')
  })

  it('message.file_changes ready 全集替换（agent_end 最终对账）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    // accumulating（agent 还在跑）
    store.applyMessageEvent('sx', {
      type: 'message.file_changes',
      payload: {
        sessionId: 'sx', messageId: 'a1',
        fileChanges: [{ filePath: 'old.ts', status: 'modified' }],
        changeSetStatus: 'accumulating', isFullSet: true,
      },
    })
    // ready 全集替换（agent_end 最终 diff 发现完全不同的文件集）
    store.applyMessageEvent('sx', {
      type: 'message.file_changes',
      payload: {
        sessionId: 'sx', messageId: 'a1',
        fileChanges: [{ filePath: 'new1.ts', status: 'added' }, { filePath: 'new2.ts', status: 'deleted' }],
        changeSetStatus: 'ready', isFullSet: true,
      },
    })
    const msg = store.getMessages('sx')[0]
    expect(msg.fileChanges).toHaveLength(2)
    expect(msg.fileChanges?.map((c) => c.filePath).sort()).toEqual(['new1.ts', 'new2.ts'])
    expect(store.getChangeSetStatus('sx', 'a1')).toBe('ready')
  })

  it('message.changeSetInvalidated 把该 session 的 changeSet 推 superseded（commit 后过期）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    // 先有一条 ready changeSet
    store.applyMessageEvent('sx', {
      type: 'message.file_changes',
      payload: {
        sessionId: 'sx', messageId: 'a1',
        fileChanges: [{ filePath: 'src/a.ts', status: 'added', addLines: 10 }],
        changeSetStatus: 'ready', isFullSet: true,
      },
    })
    expect(store.getChangeSetStatus('sx', 'a1')).toBe('ready')
    // git commit 成功 → runtime 广播 changeSetInvalidated
    store.applyMessageEvent('sx', {
      type: 'message.changeSetInvalidated',
      payload: { sessionId: 'sx', reason: 'committed' },
    })
    expect(store.getChangeSetStatus('sx', 'a1')).toBe('superseded')
  })

  it('message.changeSetInvalidated 不覆盖已 resolved 的 changeSet（保留审查记录）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    store.applyMessageEvent('sx', {
      type: 'message.file_changes',
      payload: {
        sessionId: 'sx', messageId: 'a1',
        fileChanges: [{ filePath: 'src/a.ts', status: 'added', addLines: 10 }],
        changeSetStatus: 'ready', isFullSet: true,
      },
    })
    // 用户已 accept（标 resolved）
    store.setChangeSetStatus('sx', 'a1', 'resolved')
    expect(store.getChangeSetStatus('sx', 'a1')).toBe('resolved')
    // commit 后广播失效 —— resolved 不应被覆盖
    store.applyMessageEvent('sx', {
      type: 'message.changeSetInvalidated',
      payload: { sessionId: 'sx', reason: 'committed' },
    })
    expect(store.getChangeSetStatus('sx', 'a1')).toBe('resolved')
  })

  it('setChangeSetStatus 驱动审查态（partially-reviewed/resolved）', () => {
    const store = useChatStore()
    store.setChangeSetStatus('sx', 'a1', 'partially-reviewed')
    expect(store.getChangeSetStatus('sx', 'a1')).toBe('partially-reviewed')
    store.setChangeSetStatus('sx', 'a1', 'resolved')
    expect(store.getChangeSetStatus('sx', 'a1')).toBe('resolved')
  })

  // ── customStart（pi CustomMessage 注入，如 subagent-bg-notify）──
  it('customStart: subagent-bg-notify 单条 → system 消息 + customType + 原始 details 保留', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.customStart',
      payload: {
        sessionId: 'sx',
        customType: 'subagent-bg-notify',
        content: 'Subagent "coder" (job-1) completed.',
        details: {
          id: 'job-1',
          status: 'done',
          agent: 'coder',
          model: 'claude-4.5',
          result: 'Done.',
          startedAt: 1000,
          endedAt: 13000,
        },
      },
    })
    const msgs = store.getMessages('sx')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].customType).toBe('subagent-bg-notify')
    // bgNotify 字段已删（§3.3.6），details 原始透传保留
    expect(msgs[0].details).toEqual({
      id: 'job-1',
      status: 'done',
      agent: 'coder',
      model: 'claude-4.5',
      result: 'Done.',
      startedAt: 1000,
      endedAt: 13000,
    })
  })

  it('customStart: 其他 customType → system 消息 + customType，无 details 透传外字段', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.customStart',
      payload: {
        sessionId: 'sx',
        customType: 'other-extension',
        content: 'hello',
        details: { foo: 'bar' },
      },
    })
    const msgs = store.getMessages('sx')
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].customType).toBe('other-extension')
  })

  it('customStart 产出的 system 消息经 toRenderItems 穿插为独立项（不并入 turn）', () => {
    const store = useChatStore()
    // 先建一个 user turn
    store.applyMessageEvent('sx', { type: 'message.customStart', payload: { sessionId: 'sx', customType: 'x', content: '' } })
    const items = toRenderItems(store.getMessages('sx'))
    expect(items.map((i) => i.kind)).toEqual(['systemNotice'])
  })
})
