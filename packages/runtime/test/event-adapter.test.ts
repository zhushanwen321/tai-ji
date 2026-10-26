/**
 * EventAdapter（extension 事件翻译 / message_update 矩阵与畸形检查 / FR-1~6 新事件 / toolResult 修正）合并测试。
 *
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper/mock 随节下沉）：
 * - event-adapter-new-events.test.ts
 * - event-adapter-extension.test.ts
 * - event-adapter-message-stream.test.ts
 * - event-adapter-toolresult.test.ts
 *
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run test/event-adapter.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServerMessage, ServerMessageUnion } from '@taiji/shared'
import { EventAdapter } from '../src/infra/pi/event-adapter.js'
import type { PiMessage } from '../src/infra/pi/rpc-client.js'
import type { WsSender, EventAdapterOptions } from './helpers/event-adapter-test-fixture.js'
import { createEventAdapter } from './helpers/event-adapter-test-fixture.js'

describe('event-adapter-new-events', () => {
/**
 * Task 2 tests: EventAdapter new event translations (FR-1 through FR-6).
 *
 * Covers new pi → WS event mappings added in Phase 0 of the TUI Bridge:
 *  - FR-1: extension_ui_request additions (editor / set_editor_text / setTitle),
 *          extension_error field rename (extensionName ← extensionPath) + errorEvent
 *  - FR-2: message_start role-based routing (bashExecution / compactionSummary /
 *          branchSummary) and customType passthrough of details/display
 *  - FR-3: new event types (auto_retry_start, auto_retry_end, queue_update,
 *          session_info_changed, thinking_level_changed)
 *  - FR-4: tool_execution_end image extraction, tool_execution_update object detail,
 *          agent_end responseModel + diagnostics
 *  - FR-5: message_update error → message.stream_error
 *  - FR-6: extension_ui_request setTitle
 *
 * Each test sends a flat pi event to the adapter and asserts the resulting
 * ServerMessage via toMatchObject (existing fields like sessionId are preserved).
 */

/** Pi extension events carry extra fields not in PiMessage, so we widen for tests */
type PiTestEvent = PiMessage & Record<string, unknown>

/** Helper to create event objects that satisfy PiMessage + extra pi fields */
function piEvent(fields: PiTestEvent): PiTestEvent {
  return fields
}

function createAdapter(options?: EventAdapterOptions): { adapter: EventAdapter; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const send: WsSender = (msg) => { sent.push(msg) }
  const adapter = createEventAdapter('test-session-1', send, options)
  return { adapter, sent }
}

/** Wait for async handleEvent to flush */
const flushAsync = () => new Promise<void>(r => setTimeout(r, 0))

/** Attach adapter and dispatch a single pi event through the listener */
function dispatchOne(adapter: EventAdapter, event: PiTestEvent): void {
  adapter.attach({
    onEvent: (listener) => {
      listener(piEvent(event))
      return () => {}
    },
  })
}

describe('EventAdapter: new event translations (FR-1~FR-6)', () => {
  let adapter: EventAdapter
  let sent: ServerMessage[]

  beforeEach(() => {
    const result = createAdapter()
    adapter = result.adapter
    sent = result.sent
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-1: extension_ui_request additions + extension_error field rename
  // ════════════════════════════════════════════════════════════════════

  describe('FR-1: extension_ui_request — editor method', () => {
    it('translates editor method to extension.dialog with prefill', async () => {
      dispatchOne(adapter, {
        type: 'extension_ui_request',
        method: 'editor',
        id: 'r1',
        title: 'Edit',
        prefill: 'hello',
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.dialog')
      expect(sent[0].payload).toMatchObject({
        dialogKind: 'editor',
        title: 'Edit',
        prefill: 'hello',
      })
    })
  })

  describe('FR-1: extension_ui_request — set_editor_text', () => {
    it('translates set_editor_text to extension:setEditorText', async () => {
      dispatchOne(adapter, {
        type: 'extension_ui_request',
        method: 'set_editor_text',
        text: 'new text',
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension:setEditorText')
      expect(sent[0].payload).toMatchObject({
        text: 'new text',
      })
    })
  })

  describe('FR-1: extension_error — extensionPath field rename + errorEvent', () => {
    it('reads extensionPath (not extensionName) and forwards errorEvent', async () => {
      dispatchOne(adapter, {
        type: 'extension_error',
        extensionPath: 'a/b/c.ts',
        error: 'fail',
        event: 'tool_execution',
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.error')
      expect(sent[0].payload).toMatchObject({
        extensionName: 'a/b/c.ts',
        error: 'fail',
        errorEvent: 'tool_execution',
      })
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-2: message_start role-based routing
  // [M5 删除] role=compactionSummary/branchSummary 的 message_start 分支已删（411608945）：
  // grep 历史 session JSONL 确认 pi 从不 emit 这两种 role（死分支）。压缩/分支摘要由
  // compaction_end 事件 + entry 树重建两条通路覆盖，不经 message_start。
  // ════════════════════════════════════════════════════════════════════

  describe('FR-2: message_start — customType with details/display', () => {
    it('passes through details and display for customType messages', async () => {
      dispatchOne(adapter, {
        type: 'message_start',
        message: {
          customType: 'info',
          content: 'hi',
          details: { k: 'v' },
          display: false,
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      // customType 消息用独立 type 'message.customStart'（区别于 assistant turn 的 message_start）
      expect(sent[0].type).toBe('message.customStart')
      expect(sent[0].payload).toMatchObject({
        customType: 'info',
        content: 'hi',
        details: { k: 'v' },
        display: false,
      })
    })
  })

  // [HISTORICAL] pi 0.80.3 agent-loop 在每个 turn 末尾 emit message_start{role:'user'}
  // （agent-loop.ts:112）。若不过滤，前端为 user prompt 再建空气泡（渲染撕裂 +
  // findLastAssistantIndex 错位）。切 upstream 0.80.3（ac83b578）后出现。与 toolResult 同语义。
  describe('FR-2: message_start — user/toolResult roles ignored (pi 0.80.3)', () => {
    it('ignores role=user message_start (no message_start WS sent)', async () => {
      dispatchOne(adapter, {
        type: 'message_start',
        message: { role: 'user', content: 'hi' },
      })
      await flushAsync()

      expect(sent).toHaveLength(0)
    })

    it('ignores role=toolResult message_start (no message_start WS sent)', async () => {
      dispatchOne(adapter, {
        type: 'message_start',
        message: { role: 'toolResult', content: 'result' },
      })
      await flushAsync()

      expect(sent).toHaveLength(0)
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-3: new event types
  // ════════════════════════════════════════════════════════════════════

  describe('FR-3: auto_retry_start', () => {
    it('translates auto_retry_start to message.auto_retry_start', async () => {
      dispatchOne(adapter, {
        type: 'auto_retry_start',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: 'timeout',
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.auto_retry_start')
      expect(sent[0].payload).toMatchObject({
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: 'timeout',
      })
    })
  })

  describe('FR-3: auto_retry_end', () => {
    it('translates auto_retry_end to message.auto_retry_end', async () => {
      dispatchOne(adapter, {
        type: 'auto_retry_end',
        success: true,
        attempt: 3,
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.auto_retry_end')
      expect(sent[0].payload).toMatchObject({
        success: true,
        attempt: 3,
      })
    })
  })

  describe('FR-3: queue_update', () => {
    it('queue_update 已退役（u5a/R1-A5）→ NULL_EVENTS no-op，不出帧也不落 Unhandled warn', async () => {
      dispatchOne(adapter, {
        type: 'queue_update',
        steering: ['s1'],
        followUp: ['f1'],
      })
      await flushAsync()

      expect(sent).toHaveLength(0)
    })
  })

  describe('FR-3: session_info_changed', () => {
    it('translates session_info_changed to session.renamed', async () => {
      dispatchOne(adapter, {
        type: 'session_info_changed',
        name: 'new-name',
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('session.renamed')
      expect(sent[0].payload).toMatchObject({
        name: 'new-name',
      })
    })

    it('U-session-0：翻译产出中间事件 {kind:"session-renamed", name}（MF-3 ①，interpreter 回写链入口）', async () => {
      // 直接捕获 EventAdapter 的 PiTranslatedEvent[] 产出——钉住 session_info_changed
      // → session-renamed 中间事件翻译（label 回写链的第一段，丢失则 runtime 内存
      // label 过期覆盖前端 rename，即本批修复的核心 bug）
      const translated: Array<Record<string, unknown>> = []
      const rawAdapter = new EventAdapter('test-session-1', (events) => {
        translated.push(...(events as Array<Record<string, unknown>>))
      })
      dispatchOne(rawAdapter, { type: 'session_info_changed', name: 'new-name' })
      await flushAsync()

      expect(translated).toContainEqual({ kind: 'session-renamed', name: 'new-name' })
    })

    it('U-session-1：session_info_changed 触发 onSessionRenamed 回调并广播 session.renamed（MF-3 ②，对齐 thinking-level 模式）', async () => {
      const onSessionRenamed = vi.fn()
      const { adapter, sent } = createAdapter({ onSessionRenamed })
      dispatchOne(adapter, { type: 'session_info_changed', name: 'new-name' })
      await flushAsync()

      // 回调被调用，参数为 (sessionId, 'new-name')——组合根（index.ts）在此回写
      // sessionService.setLabelCache 同步内存态 label
      expect(onSessionRenamed).toHaveBeenCalledTimes(1)
      expect(onSessionRenamed).toHaveBeenCalledWith('test-session-1', 'new-name')
      // 产出 session.renamed 消息（前端侧栏改名）
      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('session.renamed')
      expect(sent[0].payload).toMatchObject({ name: 'new-name' })
    })
  })

  describe('FR-3: thinking_level_changed', () => {
    it('translates thinking_level_changed to session.thinkingLevelSet', async () => {
      dispatchOne(adapter, {
        type: 'thinking_level_changed',
        level: 'high',
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('session.thinkingLevelSet')
      expect(sent[0].payload).toMatchObject({
        level: 'high',
      })
    })

    it('U-adapter-1：thinking_level_changed 广播 session.thinkingLevelSet，无旧缓存回写回调（W9）', async () => {
      const { adapter, sent } = createAdapter()
      dispatchOne(adapter, { type: 'thinking_level_changed', level: 'high' })
      await flushAsync()

      // W9：onThinkingLevelChanged 旧缓存回写回调已删（事件只做实例 markDirty，实例解析器
      // 由组合根注入，fixture 不接线）——回归断言帧翻译路径不受回调删除影响。
      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('session.thinkingLevelSet')
      expect(sent[0].payload).toMatchObject({ level: 'high' })
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-4: image extraction + structured partialResult + agent_end extras
  // ════════════════════════════════════════════════════════════════════

  describe('FR-4: tool_execution_end — image extraction', () => {
    it('extracts image blocks alongside text into images array', async () => {
      dispatchOne(adapter, {
        type: 'tool_execution_end',
        toolCallId: 'tc1',
        result: {
          content: [
            { type: 'text', text: 'ok' },
            { type: 'image', data: 'base64', mimeType: 'image/png' },
          ],
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_end')
      // [w21] payload 换 toolResult message entry 形态：content 是原始 result（含 image 块，
      // 归一化 output/images 提取移到消费侧——adapter 中间事件仍 normalize 供 hook 上下文）。
      // image 块保留在 entry.message.content 中不丢（规则 #9）。
      const payload = sent[0].payload as { entry: { toolCallId?: string; message: { toolCallId?: unknown; content?: unknown } } }
      expect(payload.entry.message.toolCallId).toBe('tc1')
      // [w21] content 已归一为 pi 持久化数组形态（.content 数组透传，image 块保留不丢）
      expect(payload.entry.message.content).toEqual([
        { type: 'text', text: 'ok' },
        { type: 'image', data: 'base64', mimeType: 'image/png' },
      ])
    })
  })

  describe('FR-4: tool_execution_update — structured partialResult', () => {
    it('extracts partialResult.details as detail (S5 fix: aligned with tool_execution_end)', async () => {
      dispatchOne(adapter, {
        type: 'tool_execution_update',
        toolCallId: 'tc1',
        partialResult: {
          content: 'running',
          details: { truncated: true },
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_update')
      // S5 修复：detail 提取 partialResult.details（与 tool_execution_end 路径对齐），
      // 不再透传整个 partialResult。无 details 时 fallback 用整个对象。
      expect(sent[0].payload).toMatchObject({
        toolCallId: 'tc1',
        detail: { truncated: true },
      })
    })

    it('falls back to whole object when partialResult has no details (subagent progress shape)', async () => {
      dispatchOne(adapter, {
        type: 'tool_execution_update',
        toolCallId: 'tc2',
        partialResult: {
          currentTool: 'bash',
          turnCount: 3,
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      // 无 details 字段时，detail fallback 到整个 partialResult（兼容 subagent 扁平 progress 形态）
      expect(sent[0].payload).toMatchObject({
        toolCallId: 'tc2',
        detail: { currentTool: 'bash', turnCount: 3 },
      })
    })
  })

  describe('FR-4: agent_end — responseModel + diagnostics', () => {
    it('forwards responseModel and diagnostics in message.complete', async () => {
      dispatchOne(adapter, {
        type: 'agent_end',
        messages: [
          {
            stopReason: 'stop',
            usage: { input: 100, output: 50 },
            responseModel: 'gpt-4o',
            diagnostics: { latency: 1.2 },
          },
        ],
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.complete')
      expect(sent[0].payload).toMatchObject({
        stopReason: 'end_turn',
        responseModel: 'gpt-4o',
        diagnostics: { latency: 1.2 },
      })
      // payload.usage 已随 chat-flow-consistency D3 规则 5 退役：usage 由 message_end(assistant)
      // 逐条载荷唯一承担（event-adapter-turn-usage-sum.test.ts 同口径锁定）。
      expect((sent[0].payload as Record<string, unknown>).usage).toBeUndefined()
    })
  })

  // 复杂度债务重构锚定：handleAgentEnd 的 errorMessage 条件透出与 finalContent 提取
  // 已提取为独立 helper（extractAgentEndFields / extractFinalContent），本套件锚定原分支语义。
  describe('FR-4: agent_end — errorMessage passthrough + finalContent extraction', () => {
    it('stopReason=error exposes errorMessage and joins text content blocks', async () => {
      dispatchOne(adapter, {
        type: 'agent_end',
        messages: [
          {
            stopReason: 'error',
            usage: { input: 10, output: 5, totalTokens: 15 },
            errorMessage: 'provider overloaded',
            content: [
              { type: 'text', text: 'part1 ' },
              { type: 'image', source: 'ignored' }, // 非 text block 被过滤
              { type: 'text', text: 'part2' },
            ],
          },
        ],
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.complete')
      expect(sent[0].payload).toMatchObject({
        stopReason: 'error',
        errorMessage: 'provider overloaded',
        content: 'part1 part2',
      })
      // 同上：payload.usage 退役（D3 规则 5），turn-end 顶层 totalTokens 仍 = 末次调用总量。
      expect((sent[0].payload as Record<string, unknown>).usage).toBeUndefined()
    })

    it('stopReason=stop drops errorMessage (field stays absent from payload)', async () => {
      dispatchOne(adapter, {
        type: 'agent_end',
        messages: [{ stopReason: 'stop', errorMessage: 'should be dropped' }],
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.complete')
      expect((sent[0].payload as Record<string, unknown>).errorMessage).toBeUndefined()
    })

    // W1 空消息防御（自 handle-agent-end-empty-messages.test.ts 并入）：
    // messages 为空数组/undefined 时旧实现取 messages[len-1] 访问 .stopReason 抛 TypeError，
    // 被整批 try-catch 吞掉 → agent_end 整批事件丢失 → isGenerating 永不复位。
    // 防御语义：降级为 turn-end { stopReason: 'error' }，保证 onTurnFinalize 仍能触发。
    it('AE1: agent_end with empty messages array → no throw, onTurnFinalize still fires', async () => {
      const onTurnFinalize = vi.fn()
      const defensive = createAdapter({ onTurnFinalize })

      expect(() =>
        dispatchOne(defensive.adapter, { type: 'agent_end', messages: [] }),
      ).not.toThrow()
      await flushAsync()

      expect(onTurnFinalize).toHaveBeenCalledTimes(1)
    })

    it('AE2: agent_end with undefined messages → no throw, onTurnFinalize still fires', async () => {
      const onTurnFinalize = vi.fn()
      const defensive = createAdapter({ onTurnFinalize })

      expect(() =>
        dispatchOne(defensive.adapter, { type: 'agent_end', messages: undefined }),
      ).not.toThrow()
      await flushAsync()

      expect(onTurnFinalize).toHaveBeenCalledTimes(1)
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-4b: turn_end — 每 turn 用量更新（不转发 message.complete）
  // pi 0.80.3：1 agent 循环 = N 个 turn，每 turn_end 带 usage。
  // turn_end 经 handleTurnEndPi 提取 usage → turn-usage → onContextUpdate，
  // 不产 message.complete（避免每 turn 触发前端 setStreaming 闪烁）。
  // ════════════════════════════════════════════════════════════════════

  describe('FR-4b: turn_end — 每 turn 用量更新（不发 message.complete）', () => {
    it('turn_end 带 usage → 调 onContextUpdate，不发 message.complete', async () => {
      const onContextUpdate = vi.fn()
      const { adapter, sent } = createAdapter({ onContextUpdate })
      dispatchOne(adapter, {
        type: 'turn_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          usage: { input: 163418, output: 82, totalTokens: 163628 },
        },
        toolResults: [],
      })
      await flushAsync()

      // onContextUpdate 被调，带本 turn 的 context 占用（totalTokens，非单 turn 增量 input）
      expect(onContextUpdate).toHaveBeenCalledTimes(1)
      expect(onContextUpdate).toHaveBeenCalledWith('test-session-1', {
        inputTokens: 163628,
        totalTokens: 163628,
      })
      // 不转发 message.complete（避免每 turn 触发 setStreaming 闪烁）
      expect(sent.find(m => m.type === 'message.complete')).toBeUndefined()
    })

    it('turn_end 无 usage.totalTokens → 不触发 onContextUpdate（检查）', async () => {
      const onContextUpdate = vi.fn()
      const { adapter } = createAdapter({ onContextUpdate })
      dispatchOne(adapter, {
        type: 'turn_end',
        message: { role: 'assistant', stopReason: 'stop' }, // 无 usage
        toolResults: [],
      })
      await flushAsync()

      expect(onContextUpdate).not.toHaveBeenCalled()
    })

    it('多 turn 循环：每 turn_end 独立触发 onContextUpdate（用量逐 turn 更新）', async () => {
      const onContextUpdate = vi.fn()
      const { adapter } = createAdapter({ onContextUpdate })
      // 模拟 3 个 turn 的循环
      for (const input of [1000, 2000, 3000]) {
        adapter.attach({
          onEvent: (listener) => {
            listener(piEvent({
              type: 'turn_end',
              message: { role: 'assistant', usage: { input, output: 10, totalTokens: input + 10 } },
              toolResults: [],
            }))
            return () => {}
          },
        })
      }
      await flushAsync()

      expect(onContextUpdate).toHaveBeenCalledTimes(3)
      // 最后一次带最新用量（inputTokens = totalTokens，context 占用非增量 input）
      expect(onContextUpdate).toHaveBeenLastCalledWith('test-session-1', {
        inputTokens: 3010,
        totalTokens: 3010,
      })
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-5 / RT-2#2: message_update error（pi wire 真实形状）
  // wire 实发 = {type:'error', reason:'aborted'|'error', error:AssistantMessage}
  // （权威源 pi-ai 0.84.4 dist/types.d.ts AssistantMessageEvent error 变体；json-event.js
  // 只剥 partial）。fixture 的 error 子对象只带 adapter 消费的 errorMessage 子集——完整
  // AssistantMessage 另有 role/content/usage 等字段（PiErrorSubEvent 局部形态同款取舍）。
  // reason 分流：error（provider 真错）→ message.stream_error；aborted（用户中止）→ noop
  // （中止由 message_end/agent_end 的 stopReason='aborted' 通路收尾，非 error 终态）。
  // [HISTORICAL] 旧 fixture `{type:'error', content:'...'}` 是 pi 从不发送的形状：生产读
  // sub.content 恒 undefined，测试绿而 provider 真错文本（401/限流/上下文溢出）永不显形。
  // ════════════════════════════════════════════════════════════════════

  describe('FR-5: message_update — error sub-type (real pi wire shape)', () => {
    it('error 分支：error.errorMessage 透传为 content，kind=error（provider 真错）', async () => {
      dispatchOne(adapter, {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'error',
          reason: 'error',
          error: { errorMessage: '401 Unauthorized: invalid api key' },
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.stream_error')
      // payload 形状与 shared/protocol 契约对齐：kind（分类）+ content（人类可读）
      expect(sent[0].payload).toMatchObject({
        kind: 'error',
        content: '401 Unauthorized: invalid api key',
      })
    })

    it('aborted 分支：降级 noop 不产 stream_error 帧（中止由 agent_end stopReason 通路收尾）', async () => {
      dispatchOne(adapter, {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'error',
          reason: 'aborted',
          error: {},
        },
      })
      await flushAsync()

      // 中止不是流错误：不产帧 = 前端不 finalizeSession('stream_error')（主动中止不翻 error
      // 红条），枚举串 'aborted' 也无从经 content 进用户可见错误文本
      expect(sent).toHaveLength(0)
    })
  })

  // ════════════════════════════════════════════════════════════════════
})
})

describe('event-adapter-extension', () => {
/**
 * Task 2 tests: EventAdapter extension event translation.
 *
 * Verifies that:
 * 1. extension_ui_request dialog 族（confirm/select/input/editor）→ extension.dialog 帧
 *    （pi1-disposition-chat-flow D6：载荷判别字段 dialogKind，taiji 词表）
 * 2. extension_ui_request with setStatus/setWidget → 各自独立帧（不进 dialog 族）
 * 3. extension_error → extension.error ServerMessage
 * 4. tool_execution_update → message.tool_call_update ServerMessage
 * 5. Original mapping of confirm/select to a tool-call-pending message is REMOVED
 *    (asserted positively: confirm/select produce ONLY extension.dialog, no other types)
 * 6. All ServerMessages include sessionId
 */

/** Pi extension events carry extra fields not in PiMessage, so we widen for tests */
type PiTestEvent = PiMessage & Record<string, unknown>

/** Helper to create event objects that satisfy PiMessage + extra pi fields */
function piEvent(fields: PiTestEvent): PiTestEvent {
  return fields
}

function createAdapter(): { adapter: EventAdapter; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const send: WsSender = (msg) => { sent.push(msg) }
  const adapter = createEventAdapter('test-session-1', send)
  return { adapter, sent }
}

/** Wait for async handleEvent to flush */
const flushAsync = () => new Promise<void>(r => setTimeout(r, 0))

describe('EventAdapter: extension event translation', () => {
  let adapter: EventAdapter
  let sent: ServerMessage[]

  beforeEach(() => {
    const result = createAdapter()
    adapter = result.adapter
    sent = result.sent
  })

  // ── extension_ui_request → extension.dialog ──────────────

  describe('extension_ui_request (dialog family)', () => {
    it('translates confirm method to extension.dialog (dialogKind=confirm)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'confirm',
            id: 'req-1',
            title: 'Allow file access?',
            message: 'Extension wants to read /tmp/test.txt',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.dialog')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        requestId: 'req-1',
        dialogKind: 'confirm',
        title: 'Allow file access?',
        message: 'Extension wants to read /tmp/test.txt',
      })
    })

    it('translates select method to extension.dialog (dialogKind=select)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'select',
            id: 'req-2',
            title: 'Pick an option',
            // pi select 严格传 string[]（types.ts select 签名 + rpc-mode.js 原样透传）
            options: ['A', 'B'],
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.dialog')
      const payload = sent[0].payload as Record<string, unknown>
      expect(payload.dialogKind).toBe('select')
      // options 透传 string[]（.map(String)，不再 .map(o=>o.label) 拍扁）
      expect(payload.options).toEqual(['A', 'B'])
    })

    it('translates input method to extension.dialog (dialogKind=input)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'input',
            id: 'req-3',
            title: 'Enter a value',
            default: 'placeholder text',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.dialog')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        requestId: 'req-3',
        dialogKind: 'input',
        title: 'Enter a value',
        default: 'placeholder text',
      })
    })

    it('translates notify method to extension:notify (fire-and-forget, separate family)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'notify',
            id: 'req-4',
            message: 'Operation completed',
            notifyType: 'warning',
          }))
          return () => {}
        },
      })
      await flushAsync()

      // notify 是 fire-and-forget（pi 不等回复），走独立 extension:notify WS 帧
      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension:notify')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        message: 'Operation completed',
        level: 'warn',
      })
    })

    it('produces ONLY extension.dialog for confirm (no tool-call-pending mapping)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'confirm',
            id: 'req-5',
            title: 'Allow?',
          }))
          return () => {}
        },
      })
      await flushAsync()

      // 正向断言：confirm 只产出 extension.dialog，不调染 tool-call 状态（旧 pending 映射已移除）
      expect(sent.map((m) => m.type)).toEqual(['extension.dialog'])
    })

    it('produces ONLY extension.dialog for select (no tool-call-pending mapping)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'select',
            id: 'req-6',
            options: [{ label: 'X', value: 'x' }],
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent.map((m) => m.type)).toEqual(['extension.dialog'])
    })
  })

  // ── extension_ui_request (fire-and-forget methods) ─────────────────────

  describe('extension_ui_request (fire-and-forget methods)', () => {
    it('ignores setStatus (status bar retired, silent noop, no WS frame)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'setStatus',
            id: 'req-d1',
            statusKey: 'status-key',
            statusText: 'some status',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(0)
    })

    it('bridges setWidget to extension.widget WS event', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'setWidget',
            id: 'req-d2',
            widgetKey: 'widget-key',
            widgetLines: ['line1', 'line2'],
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension:widget')
      const widgetPayload = sent[0].payload as { widgetKey: string; lines: string[] }
      expect(widgetPayload.widgetKey).toBe('widget-key')
      expect(widgetPayload.lines).toEqual(['line1', 'line2'])
    })
  })

  // ── extension_error → extension.error ─────────────────────────

  describe('extension_error', () => {
    it('translates extension_error to extension.error', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_error',
            extensionPath: 'my-extension',
            error: 'Extension crashed unexpectedly',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.error')
      expect(sent[0].payload).toEqual({
        sessionId: 'test-session-1',
        extensionName: 'my-extension',
        error: 'Extension crashed unexpectedly',
      })
    })

    it('handles extension_error without sessionId in raw event', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_error',
            extensionPath: 'ext-2',
            error: 'some error',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        extensionName: 'ext-2',
      })
    })
  })

  // ── tool_execution_update → message.tool_call_update ──────────

  describe('tool_execution_update', () => {
    it('translates tool_execution_update to message.tool_call_update', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'tool_execution_update',
            toolCallId: 'tc-1',
            toolName: 'read_file',
            partialResult: 'partial content here',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_update')
      expect(sent[0].payload).toEqual({
        sessionId: 'test-session-1',
        toolCallId: 'tc-1',
        detail: 'partial content here',
      })
    })

    it('handles tool_execution_update without partialResult', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'tool_execution_update',
            toolCallId: 'tc-2',
            toolName: 'search',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_update')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        toolCallId: 'tc-2',
      })
    })
  })

  // ── SessionId injection ────────────────────────────────────────

  describe('sessionId injection', () => {
    it('injects constructor sessionId into all extension messages', async () => {
      const localSent: ServerMessage[] = []
      const localSend: WsSender = (msg) => { localSent.push(msg) }
      const localAdapter = createEventAdapter('custom-session-42', localSend)

      localAdapter.attach({
        onEvent: (listener) => {
          listener(piEvent({ type: 'extension_error', extensionPath: 'e', error: 'err' }))
          listener(piEvent({ type: 'extension_ui_request', method: 'confirm', id: 'r1' }))
          listener(piEvent({ type: 'tool_execution_update', toolCallId: 'tc1', toolName: 't' }))
          return () => {}
        },
      })
      await flushAsync()

      for (const msg of localSent) {
        expect((msg.payload as Record<string, unknown>).sessionId).toBe('custom-session-42')
      }
    })
  })

  // ── Non-extension events unchanged ─────────────────────────────

  describe('non-extension events (regression)', () => {
    it('still translates tool_execution_start correctly', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'tool_execution_start',
            toolCallId: 'tc-reg',
            toolName: 'write_file',
            args: { path: '/tmp/x' },
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_start')
      // [w21] payload 换 toolCall entry 形态（event-adapter 翻译时重构）
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        entry: {
          type: 'toolCall',
          toolCallId: 'tc-reg',
          toolName: 'write_file',
        },
      })
    })

    it('still translates status events correctly', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'status',
            status: 'thinking',
            detail: 'processing',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.status')
    })
  })
})
})

describe('event-adapter-message-stream', () => {
/**
 * EventAdapter message_update / message_start / message_end 定向测试（CRAP 检查清单：
 * handleMessageUpdate / handleMessageStart / handleMessageEnd）。
 *
 * 已有覆盖：FR-5 error sub-type、FR-2 customType 透传、toolResult/user role 忽略、
 * toolcall_end 锚点（equivalence/tool-call-index）。本文件补齐 sub-type 翻译矩阵的
 * 其余分支与 message_start 的畸形字段检查（type-safety review：来源是 extension 第三方
 * 代码，畸形值不得以谎报类型进 wire 帧）：
 * - text_delta / thinking_delta：delta 缺省空串 + contentIndex 锚点透传（D-2 合帧依据）
 * - thinking_start / thinking_end：载荷形态（含 contentIndexAnchor 缺省不产字段）
 * - toolcall_start / toolcall_delta / text_start / text_end：noop（噪声抑制）
 * - 未知 sub-type：warn + noop（不崩）
 * - customStart 畸形检查：customType 非字符串不误入 custom 分支、details 数组/原始值 →
 *   undefined、content 非字符串 → undefined、display 非布尔 → undefined
 * - message_end role 白名单（R3 business-logic INFO）：allowed role 通过（user/assistant/
 *   toolResult 全量下发）、未建模 role（bashExecution 等）warn + 跳过（双计防线）、
 *   customType 判定优先于白名单（对齐 handleMessageStart）、畸形 message warn + 降级丢弃
 *
 * 运行：cd packages/runtime && npx vitest run test/event-adapter-message-stream.test.ts
 */
// 帧收窄：sent 元素是宽联合 ServerMessage（payload 全联合），按 type 断言到判别联合
// 成员后 payload 形状取自 protocol SSOT（ServerMessageMap），不手写字段形状。
type CustomStartFrame = Extract<ServerMessageUnion, { type: 'message.customStart' }>
type MessageStartFrame = Extract<ServerMessageUnion, { type: 'message.message_start' }>

type PiTestEvent = PiMessage & Record<string, unknown>

function createAdapter(options?: EventAdapterOptions): { adapter: EventAdapter; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const send: WsSender = (msg) => { sent.push(msg) }
  const adapter = createEventAdapter('test-session-1', send, options)
  return { adapter, sent }
}

const flushAsync = () => new Promise<void>(r => setTimeout(r, 0))

function dispatchOne(adapter: EventAdapter, event: PiTestEvent): void {
  adapter.attach({
    onEvent: (listener) => {
      listener(event)
      return () => {}
    },
  })
}

function messageUpdate(sub: Record<string, unknown>): PiTestEvent {
  return { type: 'message_update', assistantMessageEvent: sub }
}

const SID = 'test-session-1'

describe('message_update sub-type 翻译矩阵（handleMessageUpdate）', () => {
  let adapter: EventAdapter
  let sent: ServerMessage[]

  beforeEach(() => {
    const r = createAdapter()
    adapter = r.adapter
    sent = r.sent
  })

  it('text_delta：delta 透传 + contentIndex 锚点透传（有序插入锚点）', async () => {
    dispatchOne(adapter, messageUpdate({ type: 'text_delta', delta: 'hel', contentIndex: 2 }))
    await flushAsync()
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('message.text_delta')
    expect(sent[0].payload).toEqual({ sessionId: SID, delta: 'hel', contentIndex: 2 })
  })

  it('text_delta：delta 缺省空串 + 无 contentIndex 不产锚点字段（payload 形态稳定）', async () => {
    dispatchOne(adapter, messageUpdate({ type: 'text_delta' }))
    await flushAsync()
    expect(sent[0].payload).toEqual({ sessionId: SID, delta: '' })
  })

  it('thinking_delta：delta + contentIndex 同构透传（W07 微项 1：与 text_delta 对齐）', async () => {
    dispatchOne(adapter, messageUpdate({ type: 'thinking_delta', delta: 'reason', contentIndex: 0 }))
    await flushAsync()
    expect(sent[0].type).toBe('message.thinking_delta')
    expect(sent[0].payload).toEqual({ sessionId: SID, delta: 'reason', contentIndex: 0 })
  })

  it('thinking_start：contentIndex 有则透传、无则不产字段；thinking_end：无锚点字段', async () => {
    dispatchOne(adapter, messageUpdate({ type: 'thinking_start', contentIndex: 1 }))
    await flushAsync()
    expect(sent[0].type).toBe('message.thinking_start')
    expect(sent[0].payload).toEqual({ sessionId: SID, contentIndex: 1 })

    const r2 = createAdapter()
    dispatchOne(r2.adapter, messageUpdate({ type: 'thinking_start' }))
    await flushAsync()
    expect(r2.sent[0].payload).toEqual({ sessionId: SID })

    const r3 = createAdapter()
    dispatchOne(r3.adapter, messageUpdate({ type: 'thinking_end' }))
    await flushAsync()
    expect(r3.sent[0].type).toBe('message.thinking_end')
    expect(r3.sent[0].payload).toEqual({ sessionId: SID })
  })

  it('噪声 sub-type（toolcall_start/delta、text_start/end）→ noop：零 WS 帧产出', async () => {
    for (const type of ['toolcall_start', 'toolcall_delta', 'text_start', 'text_end']) {
      dispatchOne(adapter, messageUpdate({ type }))
    }
    await flushAsync()
    expect(sent).toEqual([])
  })

  it('未知 sub-type → warn + noop（不崩、不断流）', async () => {
    expect(() => dispatchOne(adapter, messageUpdate({ type: 'future_subtype' }))).not.toThrow()
    await flushAsync()
    expect(sent).toEqual([])
  })

  it('assistantMessageEvent 缺失 → noop（防御：异常帧不产 WS 消息）', async () => {
    dispatchOne(adapter, { type: 'message_update' })
    await flushAsync()
    expect(sent).toEqual([])
  })
})

describe('message_start 畸形字段检查（handleMessageStart custom 分支）', () => {
  it('customType 非字符串（number / null）→ 不走 custom 分支，按 assistant turn 产 message_start', async () => {
    const { adapter, sent } = createAdapter()
    dispatchOne(adapter, { type: 'message_start', message: { customType: 123, content: 'x' } })
    await flushAsync()
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('message.message_start') // fallback 分支（非 customStart）
    const start = sent[0] as MessageStartFrame
    expect(start.payload.messageId).toMatch(/^a-/) // 生成 messageId 供 file_changes 挂载
  })

  it('details 畸形（数组 / 原始值）→ customStart 帧 details 缺省（不透传谎报类型）', async () => {
    for (const bad of [[1, 2], 'string-details', 42]) {
      const { adapter, sent } = createAdapter()
      dispatchOne(adapter, { type: 'message_start', message: { customType: 'subagent-bg-notify', details: bad } })
      await flushAsync()
      expect(sent[0].type).toBe('message.customStart')
      const custom = sent[0] as CustomStartFrame
      expect(custom.payload.details).toBeUndefined()
    }
  })

  it('content 非字符串 / display 非布尔 → 对应字段缺省（customType 合法仍走 custom 分支）', async () => {
    const { adapter, sent } = createAdapter()
    dispatchOne(adapter, {
      type: 'message_start',
      message: { customType: 'workflow-result', content: 99, display: 'yes' },
    })
    await flushAsync()
    expect(sent[0].type).toBe('message.customStart')
    const custom = sent[0] as CustomStartFrame
    expect(custom.payload.customType).toBe('workflow-result')
    expect(custom.payload.content).toBeUndefined()
    expect(custom.payload.display).toBeUndefined()
  })

  it('msg 有但无 role 且无 customType（assistant turn 变体）→ fallback messageId 路径', async () => {
    const { adapter, sent } = createAdapter()
    dispatchOne(adapter, { type: 'message_start', message: { summary: 'partial' } })
    await flushAsync()
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('message.message_start')
    const start = sent[0] as MessageStartFrame
    expect(start.payload.messageId).toMatch(/^a-/)
  })
})

// ── message_end role 白名单（R3 business-logic INFO：S2 双计防线直接断言）──
// pi 0.84.1 实证未建模 role（bashExecution/compactionSummary/branchSummary）不经 message_end，
// 但该假设此前只存在于注释——白名单把它升级为结构防线：若未来 pi 行为漂移补发这些 role，
// 未列 role 必须被跳过（否则 registry applyEntry 与 bashResultEffect 等既有 effect 双计）。

describe('message_end role 白名单（handleMessageEnd）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('allowed role（user/assistant/toolResult）→ message.message_end 帧（entry 实时 feed 载体）', async () => {
    for (const role of ['user', 'assistant', 'toolResult']) {
      const { adapter, sent } = createAdapter()
      const ts = 1_755_000_000_000
      const message = { role, content: 'hello', timestamp: ts }
      dispatchOne(adapter, { type: 'message_end', message })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.message_end')
      // entry 形状：type message / parentId null / message 原样透传（reducer 输入 = 持久化
      // entry 同构）。timestamp = 到达时刻（live ≡ reload 同源语义，8e844eaa9）：pi message
      // 级 timestamp 是消息开始时刻，JSONL entry 级是追加时刻，合成 entry 镜像后者
      const payload = sent[0].payload as { sessionId: string; entry: { type: string; parentId: null; timestamp: string; message: unknown } }
      expect(payload).toEqual({
        sessionId: SID,
        entry: { type: 'message', parentId: null, timestamp: expect.any(String), message },
      })
      expect(Math.abs(Date.parse(payload.entry.timestamp) - Date.now())).toBeLessThan(5000)
    }
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('未建模 role（bashExecution/compactionSummary）→ warn + 跳过：零 WS 帧（双计防线）', async () => {
    const { adapter, sent } = createAdapter()
    for (const role of ['bashExecution', 'compactionSummary', 'branchSummary']) {
      dispatchOne(adapter, { type: 'message_end', message: { role, content: 'x' } })
    }
    await flushAsync()

    expect(sent).toEqual([]) // 不产任何 WS 帧（含 noop 帧也不上 wire）
    for (const role of ['bashExecution', 'compactionSummary', 'branchSummary']) {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`message_end with unmodeled role '${role}', skipping (dual-count guard`),
      )
    }
  })

  it('customType 判定：role 不在白名单但 customType 存在 → 放行（custom 以 customType 为权威标识，对齐 handleMessageStart）', async () => {
    const { adapter, sent } = createAdapter()
    // pi custom message 的 role 形如 'custom'（不在白名单），权威标识是 customType 字段
    const message = { role: 'custom', customType: 'subagent-bg-notify', content: 'bg done' }
    dispatchOne(adapter, { type: 'message_end', message })
    await flushAsync()

    expect(sent).toHaveLength(1)
    const end = sent[0] as Extract<ServerMessageUnion, { type: 'message.message_end' }>
    expect(sent[0].type).toBe('message.message_end')
    expect(end.payload.entry.message).toEqual(message)
    expect(warnSpy).not.toHaveBeenCalled() // custom 放行不是告警路径
  })

  it('畸形 message（缺失 / role 非字符串）→ warn + noop 降级丢弃（不中断事件流）', async () => {
    const { adapter, sent } = createAdapter()
    dispatchOne(adapter, { type: 'message_end' }) // message 缺失（pi 契约外）
    dispatchOne(adapter, { type: 'message_end', message: { role: 42 } }) // role 非字符串
    await flushAsync()

    expect(sent).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('message_end without message or role, skipping'))
  })
})
})

describe('event-adapter-toolresult', () => {
/**
 * EventAdapter: toolResult message_start 语义修正测试。
 *
 * 根因：pi agent-core 每个工具执行完会 emit message_start{message:{role:'toolResult'}} +
 * message_end{message:{role:'toolResult'}}（agent-loop.js emitToolResultMessage）。
 * event-adapter 的 handleMessageStart 兜底分支把 toolResult 当 assistant turn 翻译，
 * 产出无意义的 message.message_start（前端建空 assistant message），
 * 干扰 findLastAssistantIndex 导致后续 tool_call_end 匹配错位。
 *
 * 修正：role==='toolResult' 不转发（return null）——前端已通过 tool_execution_end
 * 拿到 output，toolResult message_start 是 pi 内部记账，对前端是噪声。
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/event-adapter-toolresult.test.ts
 */
type PiTestEvent = PiMessage & Record<string, unknown>

function createAdapter(): { adapter: EventAdapter; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const send: WsSender = (msg) => { sent.push(msg) }
  const adapter = createEventAdapter('test-session-1', send)
  return { adapter, sent }
}

const flushAsync = () => new Promise<void>(r => setTimeout(r, 0))

function dispatchOne(adapter: EventAdapter, event: PiTestEvent): void {
  adapter.attach({
    onEvent: (listener) => {
      listener(event)
      return () => {}
    },
  })
}

describe('EventAdapter: toolResult message_start 语义修正', () => {
  let adapter: EventAdapter
  let sent: ServerMessage[]

  beforeEach(() => {
    const result = createAdapter()
    adapter = result.adapter
    sent = result.sent
  })

  it('U1: role=toolResult 的 message_start 不转发到前端', async () => {
    dispatchOne(adapter, {
      type: 'message_start',
      message: {
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'read',
        content: [{ type: 'text', text: '文件内容' }],
        isError: false,
        timestamp: Date.now(),
      },
    })
    await flushAsync()

    // toolResult 是 pi 内部记账（agent-loop emitToolResultMessage），
    // 前端已通过 tool_execution_end 拿到 output，不应再建空 assistant message
    expect(sent).toHaveLength(0)
  })

  it('U2: 无 role 的 assistant turn message_start 仍正常产出（回归保护）', async () => {
    dispatchOne(adapter, {
      type: 'message_start',
      message: undefined,
    })
    await flushAsync()

    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('message.message_start')
    expect(sent[0].payload).toHaveProperty('messageId')
  })

  it('U4: tool_execution_end → message_start(toolResult) → message_start(assistant) 序列', async () => {
    // 模拟 agent-loop.js:261-266 的真实事件序列：
    // tool_execution_end（带 output）→ message_start(toolResult) → message_start(assistant turn)
    dispatchOne(adapter, {
      type: 'tool_execution_end',
      toolCallId: 'tc-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'done' }] },
      isError: false,
    })
    dispatchOne(adapter, {
      type: 'message_start',
      message: {
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'done' }],
        isError: false,
      },
    })
    dispatchOne(adapter, {
      type: 'message_start',
      message: undefined, // 下一个 assistant turn
    })
    await flushAsync()

    // tool_execution_end 产出 message.tool_call_end（带 output，前端据此更新 toolCall）
    // toolResult message_start 不产出（噪声过滤）
    // assistant turn message_start 产出 message.message_start
    expect(sent).toHaveLength(2)
    expect(sent[0].type).toBe('message.tool_call_end')
    // [w21] payload 换 toolResult message entry 形态（isError:false ≡ status:'completed'）
    expect(sent[0].payload).toMatchObject({ entry: { type: 'message', message: { toolCallId: 'tc-1', isError: false } } })
    expect(sent[1].type).toBe('message.message_start')
  })
})
})
