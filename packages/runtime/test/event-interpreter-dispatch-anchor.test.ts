/**
 * EventInterpreter handle 分发特征锚定测试（复杂度债务偿还 W3 批）。
 *
 * 背景：handle（原 cyclo 33，22 case 单一 switch）按处理阶段拆为五段 switch
 * （handle 主 switch 结构编排 case + handleConversationEvent 对话内容流 +
 * handleTurnLifecycleEvent turn 生命周期 + handleRoutingEvent server 路由 +
 * handleMetaEvent 元数据与观测 hook，行为保持重构）。现有测试聚焦 turn-usage / turn-end /
 * subagent / workflow / watchdog / isolation 通路，本文件补齐路由类与流类 case 的
 * 直连分发断言（重构前即缺位的分支，补特征锚定用例防提取引入分发漂移）。
 *
 * 断言形态：单事件 → 恰好一次回调/帧、参数逐字段一致；跨分组批次 → 分发顺序保持。
 * 纯 mock，无 fs IO。
 *
 * 运行：cd packages/runtime && npx vitest run test/event-interpreter-dispatch-anchor.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventInterpreter } from '../src/services/session/event-interpreter.js'
import type { ServerMessage } from '@taiji/shared'
import type { PiTranslatedEvent } from '../src/services/session/types.js'

describe('EventInterpreter · handle 三段分发锚定（W3 复杂度债务偿还）', () => {
  let sent: ServerMessage[]
  let send: (msg: ServerMessage) => void

  beforeEach(() => {
    sent = []
    send = (msg) => { sent.push(msg) }
  })

  // ── handleRoutingEvent / handleMetaEvent：server 路由与元数据回调类（每 case 恰好一次、参数逐字段一致） ──

  it('R1: status-set → onStatusSetUpdate({sessionId,key,text,textRaw}) 恰好一次', () => {
    const onStatusSetUpdate = vi.fn()
    const interpreter = new EventInterpreter('sid-r1', { send, onStatusSetUpdate })

    interpreter.interpret([{ kind: 'status-set', sessionId: 'ignored-evt-sid', key: 'model', text: 'gpt', textRaw: 'gpt-x' }])

    expect(onStatusSetUpdate).toHaveBeenCalledTimes(1)
    // sessionId 取 interpreter 持有的 sid（非事件 payload 自报）
    expect(onStatusSetUpdate).toHaveBeenCalledWith({ sessionId: 'sid-r1', key: 'model', text: 'gpt', textRaw: 'gpt-x' })
  })

  it('R2: status-broadcast → WS 帧原样透传', () => {
    const interpreter = new EventInterpreter('sid-r2', { send })
    // 帧类型值取协议外占位（interpreter 对 status-broadcast 是零改写透传，类型值不参与语义）
    const frame: ServerMessage = { type: 'session.status' as ServerMessage['type'], payload: { sessionId: 'sid-r2', key: 'k' } }

    interpreter.interpret([{ kind: 'status-broadcast', message: frame }])

    expect(sent).toEqual([frame])
  })

  it('R3: bridge-ui → onBridgeUIRequest(requestId, sessionId, method, data)', () => {
    const onBridgeUIRequest = vi.fn()
    const interpreter = new EventInterpreter('sid-r3', { send, onBridgeUIRequest })
    const data = { marker: 'x' }

    interpreter.interpret([{ kind: 'bridge-ui', requestId: 'req-1', sessionId: 'evt-sid', method: 'select', data }])

    expect(onBridgeUIRequest).toHaveBeenCalledTimes(1)
    expect(onBridgeUIRequest).toHaveBeenCalledWith('req-1', 'evt-sid', 'select', data)
  })

  it('R4: session-manager-ui → onSessionManagerRequest(requestId, sessionId, action, params)', () => {
    const onSessionManagerRequest = vi.fn()
    const interpreter = new EventInterpreter('sid-r4', { send, onSessionManagerRequest })

    interpreter.interpret([{
      kind: 'session-manager-ui', requestId: 'req-2', sessionId: 'evt-sid',
      action: 'list' as never, params: { q: 1 },
    }])

    expect(onSessionManagerRequest).toHaveBeenCalledTimes(1)
    expect(onSessionManagerRequest).toHaveBeenCalledWith('req-2', 'evt-sid', 'list', { q: 1 })
  })

  it('R5: extension-ui → onExtensionUIRequest(requestId, sessionId, method, payload)', () => {
    const onExtensionUIRequest = vi.fn()
    const interpreter = new EventInterpreter('sid-r5', { send, onExtensionUIRequest })

    interpreter.interpret([{ kind: 'extension-ui', requestId: 'req-3', sessionId: 'evt-sid', method: 'confirm', payload: { m: 'confirm' } }])

    expect(onExtensionUIRequest).toHaveBeenCalledTimes(1)
    expect(onExtensionUIRequest).toHaveBeenCalledWith('req-3', 'evt-sid', 'confirm', { m: 'confirm' })
  })

  it('R6: thinking-level → thinkingLevelState()?.markDirty() 失效（事件 payload 不回写）', () => {
    const markDirty = vi.fn()
    const interpreter = new EventInterpreter('sid-r6', { send, thinkingLevelState: () => ({ markDirty }) })

    interpreter.interpret([{ kind: 'thinking-level', level: 'high' }])

    expect(markDirty).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([])
  })

  it('R7: session-renamed → onSessionRenamed(sessionId, name)', () => {
    const onSessionRenamed = vi.fn()
    const interpreter = new EventInterpreter('sid-r7', { send, onSessionRenamed })

    interpreter.interpret([{ kind: 'session-renamed', name: 'new-name' }])

    expect(onSessionRenamed).toHaveBeenCalledTimes(1)
    expect(onSessionRenamed).toHaveBeenCalledWith('sid-r7', 'new-name')
  })

  it('R8: hook → executeHooks("onPiEvent", {event, ...data})（fire-and-forget）', () => {
    const executeHooks = vi.fn(() => Promise.resolve({ blocked: false }))
    const interpreter = new EventInterpreter('sid-r8', { send, executeHooks })

    interpreter.interpret([{ kind: 'hook', eventType: 'agent_start', data: { extra: 1 } }])

    expect(executeHooks).toHaveBeenCalledTimes(1)
    expect(executeHooks).toHaveBeenCalledWith('onPiEvent', { event: 'agent_start', extra: 1 })
  })

  // ── handleConversationEvent / handleTurnLifecycleEvent：对话流与 turn 生命周期类 ──

  it('S1: subagent-stream → subagent.stream_delta WS 帧（sessionId/recordId/lines 透传）', () => {
    const interpreter = new EventInterpreter('sid-s1', { send })

    interpreter.interpret([{ kind: 'subagent-stream', sessionId: 'virt-1', recordId: 'rec-1', lines: ['a', 'b'] }])

    expect(sent).toEqual([{
      type: 'subagent.stream_delta',
      payload: { sessionId: 'virt-1', recordId: 'rec-1', lines: ['a', 'b'] },
    }])
  })

  it('S2: agent-settled → onAgentSettled(sessionId) 恰好一次', () => {
    const onAgentSettled = vi.fn()
    const interpreter = new EventInterpreter('sid-s2', { send, onAgentSettled })

    interpreter.interpret([{ kind: 'agent-settled' }])

    expect(onAgentSettled).toHaveBeenCalledTimes(1)
    expect(onAgentSettled).toHaveBeenCalledWith('sid-s2')
  })

  it('S3: trace-trigger → onTraceSync(sessionId, trigger)', () => {
    const onTraceSync = vi.fn()
    const interpreter = new EventInterpreter('sid-s3', { send, onTraceSync })

    interpreter.interpret([{ kind: 'trace-trigger', trigger: 'message_end' }])

    expect(onTraceSync).toHaveBeenCalledTimes(1)
    expect(onTraceSync).toHaveBeenCalledWith('sid-s3', 'message_end')
  })

  it('S4: noop → 零帧零回调（无产出）', () => {
    const onAgentSettled = vi.fn()
    const interpreter = new EventInterpreter('sid-s4', { send, onAgentSettled })

    interpreter.interpret([{ kind: 'noop' }])

    expect(sent).toEqual([])
    expect(onAgentSettled).not.toHaveBeenCalled()
  })

  // ── 跨分组分发顺序（批内顺序保持 = 单一 switch 等价性） ───────────

  it('O1: 混合批次 [status-set, turn-usage, message] → 分发顺序与批次顺序一致', () => {
    const callOrder: string[] = []
    const onStatusSetUpdate = vi.fn(() => { callOrder.push('status-set') })
    const onContextUpdate = vi.fn(() => { callOrder.push('turn-usage') })
    const interpreter = new EventInterpreter('sid-o1', { send, onStatusSetUpdate, onContextUpdate })
    const msgFrame: ServerMessage = { type: 'message.delta' as ServerMessage['type'], payload: { sessionId: 'sid-o1' } }

    interpreter.interpret([
      { kind: 'status-set', sessionId: 'x', key: 'k', text: 't' },
      // gen-stats D1/D2：turn-usage 携带样本六字段（composer-gen-stats 事件契约扩展）
      { kind: 'turn-usage', sessionId: 'x', inputTokens: 1, totalTokens: 1, outputTokens: null, cacheRead: null, cacheWrite: null, input: null, model: null, provider: null },
      { kind: 'message', message: msgFrame },
    ])

    expect(callOrder).toEqual(['status-set', 'turn-usage'])
    // message 帧最后透传（帧序保持）
    expect(sent).toEqual([msgFrame])
  })

  it('O2: 混合批次 [turn-start, tool-call-index, agent-settled] → 结构编排 case 与流 case 混排不乱序', () => {
    const onAgentSettled = vi.fn()
    const interpreter = new EventInterpreter('sid-o2', { send, onAgentSettled })

    interpreter.interpret([
      { kind: 'turn-start', messageId: 'm-1' },
      { kind: 'tool-call-index', toolCallId: 'tc-1', contentIndex: 3 },
      { kind: 'agent-settled' },
    ])

    // turn-start 副作用齐发（messageId 记录 + ping 循环启动，watchdog 通路另有专测）
    expect(onAgentSettled).toHaveBeenCalledTimes(1)
    // tool-call-index 锚点入缓存：随后 tool-call-start 可消费（分发落主 switch）
    interpreter.interpret([{
      kind: 'tool-call-start', toolCallId: 'tc-1', toolName: 'read', input: {},
      entry: { id: 'e1', type: 'toolCall' } as never,
    }])
    // 异步 handler flush
    return Promise.resolve().then(() => {
      const startFrame = sent.find(m => m.type === 'message.tool_call_start')
      expect(startFrame).toBeDefined()
      expect((startFrame!.payload as { entry: { contentIndex?: number } }).entry.contentIndex).toBe(3)
    })
  })
})
