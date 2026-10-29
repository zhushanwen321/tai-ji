// effect-types.test.ts —— core C01 簇合并产物（round5-G）。
// 共同被测业务模块：`src/domain/chat/effect-types.ts`、`src/domain/chat/effects/registry.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/domain/chat/__tests__/effects.test.ts（60 用例，skip 0）
//   - src/domain/chat/effects/__tests__/finalized-rebuild.test.ts（11 用例，skip 0）
//   - src/domain/chat/effects/__tests__/registry.test.ts（5 用例，skip 0）
//   - src/domain/chat/effects/__tests__/text-finalized.test.ts（6 用例，skip 0）
//   - src/domain/chat/effects/__tests__/thinking-start-idempotent.test.ts（4 用例，skip 0）
//   - src/domain/chat/effects/__tests__/tool-call-start-anchor.test.ts（6 用例，skip 0）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { dispatchMessageEvent, __clearUnhandledFrameTypeWarnForTest } from '../registry'
import { provideDevMode, __resetDevModeForTesting } from '../../../../platform/dev-mode'
import { makeCtx, msg as serverMsg, msg, msgEntry } from '../../__tests__/helpers/fixtures'
import { type MessageEffectContext } from '../../effect-types'
import { type Message, type PiBranchSummaryEntry, type PiCompactionEntry, type PiCustomMessageEntry, type Segment, type ServerMessage, type PiMessageEntry } from '@taiji/shared'

// ======== 来源：effects.test.ts ========
describe("effects", () => {
  const SID = 's-test'

  // makeCtx 用 helpers/fixtures 共享版（u3b 后 ctx 终态形态）；本文件 makeCtx(initial)
  // 单参调用与共享版默认 sid 's-test' 同值，行为等价。

  function msg(type: string, payload: Record<string, unknown> = {}): ServerMessage {
    return serverMsg(SID, type, payload)
  }

  /** [w21] toolCall entry 形态构造（payload.entry——event-adapter 重构载体） */
  function toolCallEntry(fields: { toolCallId: string; toolName: string; arguments: Record<string, unknown>; contentIndex?: number }): Record<string, unknown> {
    return {
      type: 'toolCall',
      toolCallId: fields.toolCallId,
      toolName: fields.toolName,
      arguments: fields.arguments,
      ...(fields.contentIndex !== undefined ? { contentIndex: fields.contentIndex } : {}),
      timestamp: new Date(0).toISOString(),
    }
  }

  /** [w21] toolResult message entry 形态构造（payload.entry——与 pi 持久化 toolResult entry 同构） */
  function toolResultEntry(fields: { toolCallId: string; toolName: string; content: unknown; isError: boolean; details?: Record<string, unknown> }): Record<string, unknown> {
    return {
      type: 'message',
      parentId: null,
      timestamp: new Date(0).toISOString(),
      // content 包 text block 数组（pi 持久化形态，W21 契约）
      message: { role: 'toolResult', toolCallId: fields.toolCallId, toolName: fields.toolName, content: [{ type: 'text', text: String(fields.content) }], isError: fields.isError, ...(fields.details !== undefined ? { details: fields.details } : {}), timestamp: 0 },
    }
  }

  /**
 * [steer-bubble u1] message_end(user) 帧的 entry 构造（payload.entry——event-adapter
 * 重构形态）。content 用 content parts 数组（P2 探针实证的 pi 投递形态，pi 不 trim）。
 */
  function userEndEntry(text: string): Record<string, unknown> {
    return {
      type: 'message',
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 },
    }
  }

  function getMsgs(ctx: MessageEffectContext): Message[] {
    return ctx.messages.value.get(SID)?.value ?? []
  }

  function lastAssistant(ctx: MessageEffectContext): Message {
    const list = getMsgs(ctx)
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].role === 'assistant') return list[i]
    }
    throw new Error('no assistant')
  }

  describe('dispatchMessageEvent 流式 contentBlocks 填充', () => {
    beforeEach(() => setActivePinia(createPinia()))

    it('message_start → 新 streaming assistant（contentBlocks:[]）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      const list = getMsgs(ctx)
      expect(list).toHaveLength(1)
      expect(list[0].role).toBe('assistant')
      expect(list[0].status).toBe('streaming')
      expect(list[0].contentBlocks).toEqual([])
    })

    it('text_delta append content + 首次 push text 块（幂等不重复）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'hel' }))
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'lo' }))
      const a = lastAssistant(ctx)
      expect(a.content).toBe('hello')
      expect(a.contentBlocks).toEqual([{ type: 'text', refId: 'text' }])
    })

    it('thinking_start/delta/end：thinking block 墌量 + endTime', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.thinking_start', { thinkingId: 'th1' }))
      dispatchMessageEvent(ctx, SID, msg('message.thinking_delta', { delta: 'reasoning' }))
      dispatchMessageEvent(ctx, SID, msg('message.thinking_end'))
      const a = lastAssistant(ctx)
      expect(a.thinking).toHaveLength(1)
      expect(a.thinking![0].content).toBe('reasoning')
      expect(a.thinking![0].endTime).toBeDefined()
      expect(a.contentBlocks).toContainEqual({ type: 'thinking', refId: 'th1' })
    })

    it('tool_call_start/end：ID 锚定更新 status + output', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: { path: '/x' } }) }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: toolResultEntry({ toolCallId: 'tc1', toolName: 'read', content: 'data', isError: false }) }))
      const a = lastAssistant(ctx)
      expect(a.toolCalls).toHaveLength(1)
      expect(a.toolCalls![0].status).toBe('completed')
      expect(a.toolCalls![0].output).toBe('data')
    })

    it('tool_call_update：ID 锚定更新 detail；缺 toolCallId 静默丢弃（W05-A）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'npm test' } }) }))

      // 进度更新：detail 写到 ID 锚定的 toolCall 上
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', detail: 'running 3/10' }))
      expect(lastAssistant(ctx).toolCalls![0].detail).toBe('running 3/10')

      // 缺 toolCallId 的坏帧：不抛错、不改既有 toolCalls
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { detail: 'orphan' }))
      expect(lastAssistant(ctx).toolCalls).toHaveLength(1)
      expect(lastAssistant(ctx).toolCalls![0].detail).toBe('running 3/10')
    })

    // ── [bash-running-stream-output U2] output/outputRaw 条件写入 ──
    it('tool_call_update：output/outputRaw 条件写入；字段缺省不触碰既有值', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'npm test' } }) }))

      dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', detail: 'running', output: 'step-1\n', outputRaw: '\x1b[32mstep-1\x1b[0m\n' }))
      const tc = lastAssistant(ctx).toolCalls![0]
      expect(tc.output).toBe('step-1\n')
      expect(tc.outputRaw).toBe('\x1b[32mstep-1\x1b[0m\n')

      // 缺 output/outputRaw 的帧（mock string detail）：条件写入不触发，既有值保留
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', detail: 'running 3/10' }))
      const tc2 = lastAssistant(ctx).toolCalls![0]
      expect(tc2.output).toBe('step-1\n')
      expect(tc2.outputRaw).toBe('\x1b[32mstep-1\x1b[0m\n')
      expect(tc2.detail).toBe('running 3/10')

      // 畸形 payload（output 非字符串）：readString 降级 undefined → 不写
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', output: 123, outputRaw: { bad: true } }))
      const tc3 = lastAssistant(ctx).toolCalls![0]
      expect(tc3.output).toBe('step-1\n')
      expect(tc3.outputRaw).toBe('\x1b[32mstep-1\x1b[0m\n')
    })

    it('tool_call_update：detail 保持现状无条件覆盖语义（缺 detail 帧清空旧值）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'ls' } }) }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', detail: 'old detail' }))
      expect(lastAssistant(ctx).toolCalls![0].detail).toBe('old detail')
      // 缺 detail 的帧：无条件 spread 写 undefined（清空），与改动前现状一致
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', output: 'x' }))
      const tc = lastAssistant(ctx).toolCalls![0]
      expect(tc.detail).toBeUndefined()
      expect(tc.output).toBe('x')
    })

    it('tool_call_update → tool_call_end：end 无条件覆盖 output（running output 不影响终态）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'npm test' } }) }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', detail: 'running', output: 'partial output', outputRaw: 'partial raw' }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: toolResultEntry({ toolCallId: 'tc1', toolName: 'bash', content: 'final full output', isError: false }) }))
      const tc = lastAssistant(ctx).toolCalls![0]
      expect(tc.status).toBe('completed')
      expect(tc.output).toBe('final full output')
    })

    // [bash-running-stream-output U2 fix] end 无 ANSI 时清空 running outputRaw
    it('tool_call_update → tool_call_end：end 无 ANSI 清空 running outputRaw（live ≡ reload）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'npm test' } }) }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', detail: 'running', output: 'partial\n', outputRaw: '\x1b[31mred\x1b[0m\n' }))
      // end 文本无 ANSI：normalizePiToolResult 不产出 outputRaw，但 end 有 content 须显式清空残留
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: toolResultEntry({ toolCallId: 'tc1', toolName: 'bash', content: 'Error: command failed', isError: true }) }))
      const tc = lastAssistant(ctx).toolCalls![0]
      expect(tc.outputRaw).toBeUndefined()
      expect(tc.output).toBe('Error: command failed')
    })

    it('tool_call_update → tool_call_end：end 带 ANSI 时 outputRaw 正常写入', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'npm test' } }) }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', detail: 'running', output: 'partial\n', outputRaw: '\x1b[31mred\x1b[0m\n' }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: toolResultEntry({ toolCallId: 'tc1', toolName: 'bash', content: '\x1b[32mok done\x1b[0m\n', isError: false }) }))
      const tc = lastAssistant(ctx).toolCalls![0]
      expect(tc.outputRaw).toBe('\x1b[32mok done\x1b[0m\n')
      expect(tc.output).toBe('ok done\n')
    })

    // ── [diff-stat-chip] edit 工具 diff 统计：live overlay 路径（与 reducer computeToolCallFill 同口径）──
    it('tool_call_end：edit details.diff → tc.diffStat 写入（live 路径与 reload 同口径）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'edit', arguments: { path: '/a.ts' } }) }))
      const diff = '+ 3 const b = 2\n  1 ctx\n- 2 const b = old\n+ 5 const c = 3'
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', {
        entry: toolResultEntry({
          toolCallId: 'tc1', toolName: 'edit', content: 'Successfully replaced 1 block(s)', isError: false,
          details: { diff, patch: '---', firstChangedLine: 3 },
        }),
      }))
      const tc = lastAssistant(ctx).toolCalls![0]
      expect(tc.diffStat).toEqual({ additions: 2, deletions: 1 })
    })

    it('tool_call_end：无 details（write / 畸形帧）→ tc.diffStat 缺省（渲染侧不显示统计段）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'write', arguments: { path: '/a.ts' } }) }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: toolResultEntry({ toolCallId: 'tc1', toolName: 'write', content: 'ok', isError: false }) }))
      const tc = lastAssistant(ctx).toolCalls![0]
      expect('diffStat' in tc).toBe(false)
    })

    it('sealed 检查：finalizeSession 收尾后 text_delta 幂等丢弃（D-010）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'before' }))
      // 模拟 finalizeSession 把 assistant 改为 complete（sealed）——同 sid 走内层 ref 数组替换
      const list = getMsgs(ctx)
      ctx.messages.value.get(SID)!.value = list.map(m => m.role === 'assistant' ? { ...m, status: 'complete' as const } : m)
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'AFTER' }))
      // 收尾后 delta 被丢弃，content 不变
      expect(lastAssistant(ctx).content).toBe('before')
    })

    // ── §11 检查点 3：两条 contentBlocks 填充路径顺序语义统一 ──
    // streaming 事件序列（本文件）与持久化 content array（runtime message-converter 测试）
    // 对同一消息内容必须产生一致顺序。真实 pi 事件流：模型输出 tool_use 时发 toolcall_start
    // （带 contentIndex），text_delta 实时到达，tool_execution_start（工具执行）最后到——
    // 故「text 在 tool 之后」时事件到达顺序是 [thinking, text, tool]，但 contentIndex 顺序是
    // [thinking(0), toolCall(1), text(2)]。前端按 contentIndex 有序插入，结果与持久化路径一致。

    it('顺序统一：text 在 tool 之后时按 contentIndex 插入（与持久化路径一致）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      // 事件到达顺序：thinking → text（模型先输出 thinking，再输出 tool_use，turn 结束后才执行工具）
      dispatchMessageEvent(ctx, SID, msg('message.thinking_start', { thinkingId: 'th1', contentIndex: 0 }))
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'answer', contentIndex: 2 }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: { path: '/x' }, contentIndex: 1 }) }))
      const a = lastAssistant(ctx)
      expect(a.contentBlocks).toEqual([
        { type: 'thinking', refId: 'th1', contentIndex: 0 },
        { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
        { type: 'text', refId: 'text', contentIndex: 2 },
      ])
    })

    it('顺序统一：text 在 tool 之前时按 contentIndex 插入（append 等价，行为不变）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'let me check', contentIndex: 0 }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: { path: '/x' }, contentIndex: 1 }) }))
      const a = lastAssistant(ctx)
      expect(a.contentBlocks).toEqual([
        { type: 'text', refId: 'text', contentIndex: 0 },
        { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
      ])
    })

    it('顺序统一：无 contentIndex 时退化为 append（旧事件兼容）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.thinking_start', { thinkingId: 'th1' }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: {} }) }))
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'text' }))
      const a = lastAssistant(ctx)
      expect(a.contentBlocks).toEqual([
        { type: 'thinking', refId: 'th1' },
        { type: 'toolCall', refId: 'tc1' },
        { type: 'text', refId: 'text' },
      ])
    })

    it('顺序统一：多 tool 交错的 contentIndex 插入（thinking0/tool1/text2/tool3）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.thinking_start', { thinkingId: 'th1', contentIndex: 0 }))
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'mid', contentIndex: 2 }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: {}, contentIndex: 1 }) }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc2', toolName: 'grep', arguments: {}, contentIndex: 3 }) }))
      const a = lastAssistant(ctx)
      expect(a.contentBlocks).toEqual([
        { type: 'thinking', refId: 'th1', contentIndex: 0 },
        { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
        { type: 'text', refId: 'text', contentIndex: 2 },
        { type: 'toolCall', refId: 'tc2', contentIndex: 3 },
      ])
    })
  })

  describe('message.queue_update handler 退役（投递所有权内核 u3b / D7）', () => {
    beforeEach(() => setActivePinia(createPinia()))

    // queue_update 帧降级为内核内部回执（runtime 侧消费），不再直驱 renderer UI：
    // 前身计数路径（countDrained 差集 → drainN 计数 FIFO → appendUser + inflight +m）与
    // queueStates 快照写入整体退役；队列区数据源 = session.delivery 状态帧（内核 state
    // topic 快照，useChat.handleSessionDelivery 消费）。未注册 type 经 dispatchMessageEvent
    // 直接 no-op——本 describe 锁定「零消费」的退役终态。

    it('RET-1: queue_update 帧零消费（appendUser/inflight 全不触）', () => {
      const ctx = makeCtx()

      dispatchMessageEvent(ctx, SID, msg('message.queue_update', { steering: [] }))

      expect(ctx.appendUser).not.toHaveBeenCalled()
      // 前身断言「incrementInflight 不被调用」已随 ctx 成员删除一并退役：增量入口收敛到
      // store 方法侧后，effect 结构上无法触碰该操作（缺成员 = 结构性保证，同上 RET-2 注）。
    })
    // [u5a 退役] 前身 RET-2「queueStates 快照不再被写入/删除」已删：快照分区本尊随 u5a 删除
    // （ctx 无该字段、store 无该分区），「无生产写方」由缺字段结构性保证，用例主体消失。
  })

  describe('dispatchMessageEvent message.customStart 完成通知 display 覆写（M2 display 前置）', () => {
    beforeEach(() => setActivePinia(createPinia()))

    /** customStart 追加消息的便捷断言：返回最后一条 system 消息 */
    function lastSystem(ctx: MessageEffectContext): Message {
      const list = getMsgs(ctx)
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].role === 'system') return list[i]
      }
      throw new Error('no system message')
    }

    it('TC1: subagent-bg-notify（完成通知）→ display 覆写为 false（即使 pi 扩展透传 display:true）', () => {
      const ctx = makeCtx()
      // pi-subagent-workflow notifier 生产端写 display:true（pi 原生语义）——消费端必须覆写
      dispatchMessageEvent(ctx, SID, msg('message.customStart', {
        customType: 'subagent-bg-notify',
        content: '子代理完成',
        display: true,
        details: { id: 'job-1', status: 'done', agent: 'coder', startedAt: 1000, endedAt: 2000 },
      }))

      const m = lastSystem(ctx)
      expect(m.customType).toBe('subagent-bg-notify')
      expect(m.display).toBe(false)
      // details 原始字段仍保留（消息进 store 供 fork/compact/replay 等其他消费）
      expect(m.details).toEqual({ id: 'job-1', status: 'done', agent: 'coder', startedAt: 1000, endedAt: 2000 })
    })

    it('TC2: workflow-result（完成通知）→ display 覆写为 false', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.customStart', {
        customType: 'workflow-result',
        content: 'run done',
        display: true,
      }))

      const m = lastSystem(ctx)
      expect(m.customType).toBe('workflow-result')
      expect(m.display).toBe(false)
    })

    it('TC3: 非完成通知 customType → display 原样透传（三态保留，undefined 安全显示）', () => {
      const ctx = makeCtx()
      // goal/todo context 类：pi 扩展声明 display:false → 透传隐藏
      dispatchMessageEvent(ctx, SID, msg('message.customStart', {
        customType: 'goal-context',
        content: '<goal_context>...',
        display: false,
      }))
      // 普通通知：display:true → 透传显示
      dispatchMessageEvent(ctx, SID, msg('message.customStart', {
        customType: 'future-extension-notify',
        content: '显示',
        display: true,
      }))
      // 无 display 字段 → undefined（!== false 即显示）
      dispatchMessageEvent(ctx, SID, msg('message.customStart', {
        customType: 'legacy-notify',
        content: 'legacy',
      }))

      const list = getMsgs(ctx)
      const sys = list.filter((m) => m.role === 'system')
      expect(sys[0].display).toBe(false)
      expect(sys[1].display).toBe(true)
      expect(sys[2].display).toBeUndefined()
    })

    it('TC4: entry 路径——customStart 构造 custom_message entry 喂 applyEntryFrame（与重开重放同构）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.customStart', {
        customType: 'subagent-bg-notify',
        content: 'x',
        display: true,
        details: { id: 'job-9' },
      }))
      // 喂入点：与文件重放（get_entries → replayEntries）同一个 applyEntry reducer
      expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
      const entry = vi.mocked(ctx.applyEntryFrame).mock.calls[0][1] as PiCustomMessageEntry
      expect(entry.type).toBe('custom_message')
      expect(entry.customType).toBe('subagent-bg-notify')
      expect(entry.content).toBe('x')
      expect(entry.display).toBe(true)
      expect(entry.details).toEqual({ id: 'job-9' })
      // ref 消息来自同一 entry 的 applyEntry 派生（display:false 覆写在 reducer 单点生效——
      // live ≡ reload 等价由 custom-start-equivalence.test.ts 全量锁定）
      expect(lastSystem(ctx).display).toBe(false)
    })
  })

  describe('dispatchMessageEvent message.stream_warn（W2 liveOnly 标记）', () => {
    beforeEach(() => setActivePinia(createPinia()))

    it('stream_warn → system 提示行入消息流 + liveOnly:true（pi 无 entry、重开即消失）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.stream_warn', { content: 'pi 静默卡死预警' }))
      const list = getMsgs(ctx)
      expect(list).toHaveLength(1)
      expect(list[0].role).toBe('system')
      expect(list[0].content).toBe('pi 静默卡死预警')
      expect(list[0].status).toBe('complete')
      // liveOnly（全仓唯一写入点）：分组层据此归 turn 内 notice（W3 消费），不参与
      // live≡reload 等价性断言——pi 无对应 entry，直插即本类消息的正确入流路径
      expect(list[0].liveOnly).toBe(true)
    })

    it('payload 无 content → 兜底文案；liveOnly 仍置位', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.stream_warn'))
      const list = getMsgs(ctx)
      expect(list).toHaveLength(1)
      expect(list[0].content).toBe('长时间无响应')
      expect(list[0].liveOnly).toBe(true)
    })

    it('[MF-1-13] streaming 期到达 → 不 finalizeSession，assistant 保持 streaming，turn 可被后续 complete 正常收尾', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'partial' }))

      // 单帧翻译失败经 adapter 显形为 stream_warn（MF-1-13）：非终结——不得收尾 session
      dispatchMessageEvent(ctx, SID, msg('message.stream_warn', { content: '事件翻译失败，本帧已跳过：x' }))
      expect(ctx.finalizeSession).not.toHaveBeenCalled()
      expect(lastAssistant(ctx).status).toBe('streaming')
      expect(lastAssistant(ctx).content).toBe('partial')

      // pi 实际成功的 turn：后续 message.complete 正常走完（不被提前 seal 成 error 终态）
      dispatchMessageEvent(ctx, SID, msg('message.complete', { stopReason: 'stop', content: 'partial + done' }))
      expect(lastAssistant(ctx).status).toBe('complete')
      expect(lastAssistant(ctx).error).toBeUndefined()
      expect(getMsgs(ctx).some((m) => m.status === 'error')).toBe(false)
    })
  })

  describe('dispatchMessageEvent message.compactionSummary（W6 entry 化——消灭最后一条直插双路径）', () => {
    beforeEach(() => setActivePinia(createPinia()))

    it('帧 → 构造 compaction entry 喂 applyEntryFrame（与重开 compaction entry 同构）+ overlay system 行', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.compactionSummary', {
        summary: '压缩摘要',
        tokensBefore: 12345,
        timestamp: 8000,
      }))
      // 喂入点：与文件重放（get_entries → replayEntries）同一个 applyEntry reducer
      expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
      const entry = vi.mocked(ctx.applyEntryFrame).mock.calls[0][1] as PiCompactionEntry
      expect(entry.type).toBe('compaction')
      expect(entry.id).toMatch(/^cmp-/)
      expect(entry.summary).toBe('压缩摘要')
      expect(entry.tokensBefore).toBe(12345)
      // 帧 timestamp（ms）→ entry ISO（reducer compaction case toMs 往返）
      expect(entry.timestamp).toBe(new Date(8000).toISOString())
      // overlay 派生视图：system 压缩行（用户可见行为——live 与重开同款，live≡reload 归一
      // deep-equal 由 apply-entry-merged.test.ts 的 apply-entry-equivalence 合并节 E4 锁定）
      const list = getMsgs(ctx)
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({
        role: 'system',
        content: '压缩摘要',
        status: 'complete',
        timestamp: 8000,
        compactionSummary: { summary: '压缩摘要', tokensBefore: 12345 },
      })
    })

    it('帧缺 summary/tokensBefore → entry 不含可选字段，overlay 走 reducer 中文 fallback（W6 由英文占位收敛，与重开一致）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.compactionSummary', {}))
      expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
      const entry = vi.mocked(ctx.applyEntryFrame).mock.calls[0][1] as PiCompactionEntry
      expect(entry.type).toBe('compaction')
      expect(entry.summary).toBeUndefined()
      expect(entry.tokensBefore).toBeUndefined()
      // reducer compaction case 的 fallback：'上下文已压缩'（旧直插路径为英文占位
      // 'Context compacted'——entry 化后两路径共用 reducer，文案归一）
      const list = getMsgs(ctx)
      expect(list[0].content).toBe('上下文已压缩')
      expect(list[0].compactionSummary).toMatchObject({ summary: undefined, tokensBefore: undefined })
    })
  })

  describe('dispatchMessageEvent message.branchSummary（D13 renderer-deepening entry 化——fallback 与 reducer 收敛一致）', () => {
    beforeEach(() => setActivePinia(createPinia()))

    it('帧 → 构造 branch_summary entry 喂 applyEntryFrame（与重开 branch_summary entry 同构）+ overlay system 行', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.branchSummary', {
        summary: '分支摘要',
        fromId: 'msg-9',
        timestamp: 6000,
      }))
      // 喂入点：与文件重放（get_entries → replayEntries）同一个 applyEntry reducer
      expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
      const entry = vi.mocked(ctx.applyEntryFrame).mock.calls[0][1] as PiBranchSummaryEntry
      expect(entry.type).toBe('branch_summary')
      expect(entry.id).toMatch(/^br-/)
      expect(entry.summary).toBe('分支摘要')
      expect(entry.fromId).toBe('msg-9')
      // 帧 timestamp（ms）→ entry ISO（reducer branch_summary case toMs 往返）
      expect(entry.timestamp).toBe(new Date(6000).toISOString())
      // overlay 派生视图：system 分支行（用户可见行为——live 与重开同款，live≡reload 归一
      // deep-equal 由 branch-summary-equivalence.test.ts 全量锁定）
      const list = getMsgs(ctx)
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({
        role: 'system',
        content: '分支摘要',
        status: 'complete',
        timestamp: 6000,
        branchSummary: { summary: '分支摘要', fromId: 'msg-9', timestamp: 6000 },
      })
    })

    it('帧缺 summary → entry 不含可选字段，overlay 走 reducer fallback 空串（旧直插路径英文占位 Branched 由 D13 声明收敛，live ≡ reload）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.branchSummary', { fromId: 'n-1' }))
      expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
      const entry = vi.mocked(ctx.applyEntryFrame).mock.calls[0][1] as PiBranchSummaryEntry
      expect(entry.type).toBe('branch_summary')
      expect(entry.summary).toBeUndefined()
      // reducer branch_summary case 的 fallback：空串（与重开 `rawSummary ?? ''` 一致）
      const list = getMsgs(ctx)
      expect(list).toHaveLength(1)
      expect(list[0].content).toBe('')
      expect(list[0].branchSummary).toMatchObject({ summary: undefined, fromId: 'n-1' })
    })

    it('空串 summary 透传（readBranchSummary 空串门）→ content 保留空行（compaction E4c 同族分叉预防）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.branchSummary', { summary: '', timestamp: 7000 }))
      const entry = vi.mocked(ctx.applyEntryFrame).mock.calls[0][1] as PiBranchSummaryEntry
      expect(entry.summary).toBe('')
      const list = getMsgs(ctx)
      expect(list[0].content).toBe('')
      expect(list[0].branchSummary).toMatchObject({ summary: '' })
    })
  })

  describe('message.complete error 路径的 errorMessage 可见性（模型 400 秒败回归）', () => {
    beforeEach(() => setActivePinia(createPinia()))

    it('streaming 气泡收尾：errorMessage 写入最后一条 assistant 的 error 字段（追加形态）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: '部分正文' }))
      dispatchMessageEvent(ctx, SID, msg('message.complete', {
        stopReason: 'error',
        errorMessage: '400: {"code":"400","message":"Unsupported model mimo-v2-pro"}',
      }))
      const a = lastAssistant(ctx)
      expect(a.status).toBe('error')
      expect(a.content).toBe('部分正文')
      expect(a.error).toBe('400: {"code":"400","message":"Unsupported model mimo-v2-pro"}')
    })

    it('无 streaming 气泡（message_start 丢失）：errorMessage 追加为纯 error 气泡', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.complete', {
        stopReason: 'error',
        errorMessage: '400: Unsupported model mimo-v2-pro',
      }))
      const list = getMsgs(ctx)
      expect(list).toHaveLength(1)
      expect(list[0].role).toBe('assistant')
      expect(list[0].status).toBe('error')
      // [M2 形态统一] 错误文本只住 error 字段，content 恒为崩溃前正文（无=空）
      expect(list[0].content).toBe('')
      expect(list[0].error).toBe('400: Unsupported model mimo-v2-pro')
    })

    // [M2 不变量·terminalMessagePatch 出口] pi error stop 但 errorMessage 缺失
    // （extras.errorMessage 可 undefined）：error 字段走兜底——缺失会让崩溃前正文
    // 被 Block.vue 误判纯 error 整条染红。
    it('streaming 气泡收尾且 errorMessage 缺失：error 字段写 reason 兜底文案（不变量）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: '崩溃前正文' }))
      dispatchMessageEvent(ctx, SID, msg('message.complete', {
        stopReason: 'error',
        errorMessage: undefined,
      }))
      const a = lastAssistant(ctx)
      expect(a.status).toBe('error')
      expect(a.content).toBe('崩溃前正文')
      expect(a.error).toBe('会话出错，回复已中断。')
    })

    // [错误可见性] 秒败 turn 且 errorMessage 缺失：仍追加纯 error 气泡（兜底文案）——
    // 旧条件 isErrorStop && errorMessage && !changed 在此场景什么都不追加，错误完全静默。
    it('无 streaming 气泡且 errorMessage 缺失：仍追加兜底纯 error 气泡（错误不得静默）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.complete', {
        stopReason: 'error',
        errorMessage: undefined,
      }))
      const list = getMsgs(ctx)
      expect(list).toHaveLength(1)
      expect(list[0].status).toBe('error')
      expect(list[0].content).toBe('')
      expect(list[0].error).toBe('会话出错，回复已中断。')
    })

    it('非 error stopReason 不消费 errorMessage 字段（正常完成不受影响）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'ok' }))
      dispatchMessageEvent(ctx, SID, msg('message.complete', {
        stopReason: 'stop',
        content: 'ok',
        errorMessage: undefined,
      }))
      const a = lastAssistant(ctx)
      expect(a.status).toBe('complete')
      expect(a.error).toBeUndefined()
    })
  })

  // ── message.complete 收尾矩阵（registry next 回调检查目标：多气泡收尾 / 权威 content 末条定位）──
  //
  // [HISTORICAL] 一个 turn 可产出多个 streaming assistant 气泡（工具调用气泡 + 文字总结气泡）：
  // handler 的 map 回调必须收尾**所有** status==='streaming' 的 assistant，而权威
  // content / errorMessage 只落最后一条（turn 级聚合）。只收最后一条的历史形态会让前面的
  // toolCall 气泡永远 streaming。[chat-flow-consistency D3 规则 5] usage/endedAt 已退役出
  // 收尾 patch——live 写入点 = 各自 message_end 的定稿重建（逐条载荷唯一承担）。

  describe('message.complete 收尾矩阵：多 streaming 气泡全收尾 + 定稿重建字段不在收尾覆盖', () => {
    beforeEach(() => setActivePinia(createPinia()))

    it('多 streaming 气泡（toolCall 气泡 + 文字气泡）全部收尾；usage/endedAt 逐条由定稿重建承担、complete 不再覆盖（D3 规则 5）', () => {
      const ctx = makeCtx()
      // 气泡 1：含 running toolCall 的 assistant（工具调用气泡）
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: { path: '/x' } }) }))
      dispatchMessageEvent(ctx, SID, msg('message.message_end', {
        messageId: 'a1',
        entry: {
          type: 'message', parentId: null, timestamp: new Date(1700000001000).toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/x' } }],
            timestamp: 1700000001000,
            usage: { input: 10, output: 20 },
          },
        },
      }))
      // 气泡 2：文字总结气泡（同 turn 第二个 assistant）
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a2' }))
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: '总结' }))
      dispatchMessageEvent(ctx, SID, msg('message.message_end', {
        messageId: 'a2',
        entry: {
          type: 'message', parentId: null, timestamp: new Date(1700000002000).toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '总结' }],
            timestamp: 1700000002000,
            usage: { input: 30, output: 40 },
          },
        },
      }))

      // [chat-flow-consistency D3 规则 5] complete 的 usage/endedAt 覆盖已退役：payload.usage
      // （回合级累计）若覆盖末位，deriveTurnAggregates 逐条求和会把末位双计。usage/endedAt 的
      // live 写入点 = 各自 message_end 的定稿重建（rebuildAssistantOnFinalize）。
      dispatchMessageEvent(ctx, SID, msg('message.complete', {
        stopReason: 'stop',
        usage: { inputTokens: 999, outputTokens: 999 },
      }))

      const list = getMsgs(ctx)
      expect(list).toHaveLength(2)
      // 两个气泡都收尾（历史 bug：只收最后一条 → toolCall 气泡永远 streaming）
      expect(list[0].status).toBe('complete')
      expect(list[1].status).toBe('complete')
      // usage 逐条 = 各自 message_end 载荷值；complete 的回合级值不覆盖
      expect(list[0].usage).toEqual({ inputTokens: 10, outputTokens: 20 })
      expect(list[1].usage).toEqual({ inputTokens: 30, outputTokens: 40 })
      // endedAt 逐条 = 各自 entry 落盘时刻（与 reload 侧 applyEntryEndTimes 同源）；complete 不写
      expect(list[0].endedAt).toBe(1700000001000)
      expect(list[1].endedAt).toBe(1700000002000)
    })

    it('权威 content 覆盖最后一条 assistant（末 delta 异步渲染竞态防线）；非末气泡 content 不动', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: '部分正文未封口' }))
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a2' }))
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: '流式累积' }))

      dispatchMessageEvent(ctx, SID, msg('message.complete', {
        stopReason: 'stop',
        content: '权威完整正文 **已封口**',
      }))

      const list = getMsgs(ctx)
      // 末条被权威源覆盖（强制 MarkdownRenderer watch 重新渲染）
      expect(list[1].content).toBe('权威完整正文 **已封口**')
      // 非末条不在覆盖范围（finalContent 只定位 lastAssistantIdx）
      expect(list[0].content).toBe('部分正文未封口')
    })

    it('abort 路径 payload 无 content → 保留客户端流式累积值（空串不覆盖）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: '中断前正文' }))
      // abort：runtime 不带 content（权威覆盖仅在非空时生效）
      dispatchMessageEvent(ctx, SID, msg('message.complete', { stopReason: 'aborted', content: '' }))
      const a = lastAssistant(ctx)
      expect(a.content).toBe('中断前正文')
      expect(a.status).toBe('complete')
    })
  })

  // ── tool_call_end 降级与错误形态（registry message.tool_call_end 检查目标）──

  describe('dispatchMessageEvent tool_call_end 异常帧降级与错误收尾', () => {
    beforeEach(() => setActivePinia(createPinia()))

    it('entry 缺失 / type 非 message → 整帧降级丢弃（reducer 不喂、消息流不动）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: {} }) }))

      dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', {}))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: { type: 'compaction', summary: 'x' } }))

      // 两帧都静默丢弃：reducer 未喂、toolCall 保持 running
      expect(ctx.applyEntryFrame).not.toHaveBeenCalled()
      expect(lastAssistant(ctx).toolCalls![0].status).toBe('running')
    })

    it('isError toolResult → status:"error" + error 字段（实时失败必须可见，Block.vue isFailed 判定输入）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'exit 1' } }) }))

      dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: toolResultEntry({ toolCallId: 'tc1', toolName: 'bash', content: 'command failed', isError: true }) }))

      const tc = lastAssistant(ctx).toolCalls![0]
      // [HISTORICAL] 实时失败的 tool call 必须带 status:'error'（与重放路径 reducer 一致），
      // 否则前端 isFailed 恒 false（恒显示成功）；error 字段承载失败正文
      expect(tc.status).toBe('error')
      expect(tc.output).toBe('command failed')
      expect(tc.error).toBe('command failed')
    })

    it('entry.message.content 缺失 → 保留 running 期间旧 output（异常帧不抹掉已见数据）', () => {
      // 预置：带过程 output 的 running toolCall（progress/前序 update 场景的既有形态）
      const initial: Message[] = [{
        id: 'a1',
        role: 'assistant',
        content: '',
        status: 'streaming',
        timestamp: 0,
        toolCalls: [{ id: 'tc1', toolName: 'read', input: {}, status: 'running', startTime: 0, output: 'progress-1' }],
      }]
      const ctx = makeCtx(initial)

      const noContentEntry = {
        type: 'message',
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'read', isError: false, timestamp: 0 },
      }
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: noContentEntry }))

      const tc = lastAssistant(ctx).toolCalls![0]
      // content undefined（mock/异常帧）→ 不覆盖已有 output，但 status 照常收尾
      expect(tc.status).toBe('completed')
      expect(tc.output).toBe('progress-1')
    })

    it('toolCallId 缺失 → 降级定位最后一条 assistant 回填（防御：兼容异常事件不断流）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: {} }) }))

      // 异常帧：toolCallId 缺失（无 ID 锚点）→ fallback findLastAssistantIndex 定位
      const noCallIdEntry = {
        type: 'message',
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'data' }], isError: false, timestamp: 0 },
      }
      dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: noCallIdEntry }))

      // toolCall 气泡本身收尾为 complete（callId 匹配分支不命中则 status 不变——
      // 降级路径只保证不崩、reducer 照常喂入；此处锚定「不抛 + 帧被消费」的用户可见行为）
      expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
      expect(getMsgs(ctx)).toHaveLength(1)
    })
  })

  // ── [投递所有权内核 u3b] message_end(user) 投递确认收敛（原三分支 → 两分支）──
  // ① 内核送达回执（标记 id 匹配派生视图条目）→ ② 纯计数兜底。① 的正测在
  // domain/chat/__tests__/effect-types.test.ts 的 effects-delivery-receipt 合并节
  // （含派生视图/morph 段/inflight 回收/幂等），此处锁定
  // ② 计数兜底与「③ includes 兜底已退役」的零消费终态（[B1] 其消费方计数路径已删除）。

  describe('dispatchMessageEvent message_end(user) 投递确认收敛（u3b：①回执 + ②计数兜底）', () => {
    beforeEach(() => setActivePinia(createPinia()))

    it('无标记帧 + inflight > 0 → ② 纯计数 decrement（乐观气泡已显示，防重复入流）', () => {
      const ctx = makeCtx()
      vi.mocked(ctx.getInflight).mockReturnValue(1)

      dispatchMessageEvent(ctx, SID, msg('message.message_end', { entry: userEndEntry('T') }))

      expect(ctx.decrementInflight).toHaveBeenCalledWith(SID, 1)
      expect(ctx.appendUser).not.toHaveBeenCalled()
      // [u5a] 前身「快照内容原样保留」哨兵随 queueStates 分区删除而移除（ctx 无该字段）
      // 权威 reducer 喂入无条件保留
      expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
    })

    it('无标记帧 + inflight == 0 → 零消费（外来/历史帧静默终止）', () => {
      const ctx = makeCtx()

      dispatchMessageEvent(ctx, SID, msg('message.message_end', { entry: userEndEntry('any') }))

      expect(ctx.appendUser).not.toHaveBeenCalled()
      expect(ctx.decrementInflight).not.toHaveBeenCalled()
      expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
    })

    it('RET: ③ includes 兜底已退役——无标记帧即使 inflight == 0 也不产生任何入流', () => {
      const ctx = makeCtx()
      vi.mocked(ctx.getInflight).mockReturnValue(0)

      dispatchMessageEvent(ctx, SID, msg('message.message_end', { entry: userEndEntry('T') }))

      // 前身：includes 命中 → drainN(1) + appendUser + 剔快照——整体退役（计数路径 D7 + [B1]
      // 计数路径删除；[u5a] 快照分区删除后不在 ctx 上），断言范围收敛为 appendUser 零调用。
      expect(ctx.appendUser).not.toHaveBeenCalled()
    })
  })

  // ── [投递所有权内核 u3b 退役] message_start 的 G-023 条件清 + 僵尸清理 ──
  // queueStates 快照与 pendingBuffer 计数路径已随内核退役（队列区数据源 = session.delivery
  // 状态帧）；message_start 只保留 streaming assistant 建立 + clearPendingSend（streaming timer 已随上游移除）。

  describe('dispatchMessageEvent message_start（u3b：快照/僵尸清理路径退役，streaming 链路不变）', () => {
    beforeEach(() => setActivePinia(createPinia()))

    // [u5a 退役] 前身 RET「不再调 reconcilePending」已删：僵尸清理路径本尊随 u5b 删除
    // （ctx 无该字段），「无调用方」由缺字段结构性保证，用例主体消失。

    it('streaming assistant 照常建立（contentBlocks:[]）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      expect(getMsgs(ctx)).toHaveLength(1)
      expect(lastAssistant(ctx).status).toBe('streaming')
      expect(lastAssistant(ctx).contentBlocks).toEqual([])
    })
  })

  describe('dispatchMessageEvent message.complete abort 清理（u3b：确认基线复位，D10 队列不取消）', () => {
    beforeEach(() => setActivePinia(createPinia()))

    it('stopReason=aborted → 只 clearInflight；pendingBuffer 保留（pi 队列跨 abort 存活）', () => {
      const ctx = makeCtx()

      dispatchMessageEvent(ctx, SID, msg('message.complete', { stopReason: 'aborted' }))

      // D4 修订（Gate B 实测 2026-08-30）：pi abort() 不清队列，残余在下一 prompt 投递——
      // buffer 与快照是 pi 存活队列的前端镜像，保留供两路径消费；只清确认计数（已显示未
      // 确认条目不会再有 message_end，残留会吞掉后续确认配额）。
      expect(ctx.clearInflight).toHaveBeenCalledWith(SID)
      // [u5a] 前身「快照原样保留」哨兵随 queueStates 分区删除而移除
      // 通用收尾照常（清理在 finalizeSession 之外显式做，不替代收尾）
      expect(ctx.finalizeSession).toHaveBeenCalledWith(SID, 'aborted')
    })

    it('aborted 幂等：重复收尾无额外副作用', () => {
      const ctx = makeCtx()

      dispatchMessageEvent(ctx, SID, msg('message.complete', { stopReason: 'aborted' }))

      expect(ctx.clearInflight).toHaveBeenCalledWith(SID)
    })

    it('normal（stopReason=stop）不触发清理（finalizeSession 是通用收尾，normal/error 不清）', () => {
      const ctx = makeCtx()

      dispatchMessageEvent(ctx, SID, msg('message.complete', { stopReason: 'stop' }))

      expect(ctx.clearInflight).not.toHaveBeenCalled()
    })

    it('error stopReason 同样不清（abort 是唯一清理出口）', () => {
      const ctx = makeCtx()

      dispatchMessageEvent(ctx, SID, msg('message.complete', { stopReason: 'error', errorMessage: 'x' }))

      expect(ctx.clearInflight).not.toHaveBeenCalled()
    })
  })

  describe('dispatchMessageEvent 坏帧静默丢弃（A5 设计裁决锁定：异常帧不断流）', () => {
    // [设计裁决登记（registry.ts 三处检查，2026-09-17 错误处理审查 A5）] 正常流经
    // event-adapter 构造的帧不会产生 undefined/形态不符 entry；检查静默 return 是
    // 有意取舍（单帧异常不中断主对话流、不加 warn）。本组用例锁定该行为范围：坏帧
    // 喂入 → 不抛错、零副作用（reducer 喂入 / overlay / 确认路径均不触发）。
    beforeEach(() => setActivePinia(createPinia()))

    it('tool_call_start 缺 entry → 不抛错、streaming assistant 无 toolCall/contentBlocks 增量', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      expect(() => dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', {}))).not.toThrow()
      const a = lastAssistant(ctx)
      expect(a.toolCalls ?? []).toHaveLength(0)
      expect(a.contentBlocks ?? []).toHaveLength(0)
      expect(ctx.applyEntryFrame).not.toHaveBeenCalled()
    })

    it('tool_call_end 缺 entry / entry 非 message 形态 → 不抛错、reducer 喂入与 overlay 双零副作用', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      expect(() => dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', {}))).not.toThrow()
      expect(() => dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: { type: 'toolCall' } }))).not.toThrow()
      expect(ctx.applyEntryFrame).not.toHaveBeenCalled()
      expect(lastAssistant(ctx).toolCalls ?? []).toHaveLength(0)
    })

    it('message_end 缺 entry / entry 非 message 形态 → 不抛错、reducer 喂入与路径 2 确认双零副作用', () => {
      const ctx = makeCtx()
      expect(() => dispatchMessageEvent(ctx, SID, msg('message.message_end', {}))).not.toThrow()
      expect(() => dispatchMessageEvent(ctx, SID, msg('message.message_end', { entry: { type: 'compaction' } }))).not.toThrow()
      expect(ctx.applyEntryFrame).not.toHaveBeenCalled()
      expect(getMsgs(ctx)).toHaveLength(0)
      // 路径 2（user 投递确认）在形态检查处短路：确认计数只减不增（increment 入口已在
      // ctx 方法侧删除，结构性不可触——原负向断言随之退役）
      expect(ctx.decrementInflight).not.toHaveBeenCalled()
    })
  })

  describe('dispatchMessageEvent — 单帧异常隔离与终态安全网（RD-1#5）', () => {
    beforeEach(() => setActivePinia(createPinia()))
    afterEach(() => vi.restoreAllMocks())

    it('非终态帧 handler 中途抛错：不逆传调用方 + console.error 记录半执行帧，后续帧继续处理', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const ctx = makeCtx()
      // message_start handler 的最后一步 clearPendingSend 抛错（前序副作用已完成：streaming 气泡已 commit）
      vi.mocked(ctx.clearPendingSend).mockImplementation(() => { throw new Error('effect boom') })
      expect(() => dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'm-1' }))).not.toThrow()
      expect(errSpy).toHaveBeenCalledTimes(1)
      expect(String(errSpy.mock.calls[0]?.[0])).toContain('message.message_start')
      // 半执行帧的前序副作用保留（streaming 气泡已落），不回滚不重放
      expect(getMsgs(ctx)).toHaveLength(1)
      expect(lastAssistant(ctx).status).toBe('streaming')
      // 后续帧照常处理：text_delta 正常累积
      vi.mocked(ctx.clearPendingSend).mockImplementation(() => {})
      dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'a' }))
      expect(lastAssistant(ctx).content).toBe('a')
    })

    it('终态帧（message.error）异常截断收尾：安全网按帧语义补 finalizeSession（error + 原始错误文本）', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const ctx = makeCtx()
      const finalize = vi.mocked(ctx.finalizeSession)
      // 首次 finalize（handler 内）抛错 → 安全网第二次调用成功
      finalize.mockImplementationOnce(() => { throw new Error('finalize boom') })
      expect(() => dispatchMessageEvent(ctx, SID, msg('message.error', { message: 'pi exploded' }))).not.toThrow()
      expect(finalize).toHaveBeenCalledTimes(2)
      expect(finalize).toHaveBeenLastCalledWith(SID, 'error', 'pi exploded')
    })

    it('终态帧（message.complete aborted）安全网保留 aborted 语义（不误标 error）', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const ctx = makeCtx()
      const finalize = vi.mocked(ctx.finalizeSession)
      finalize.mockImplementationOnce(() => { throw new Error('finalize boom') })
      dispatchMessageEvent(ctx, SID, msg('message.complete', { stopReason: 'aborted' }))
      expect(finalize).toHaveBeenLastCalledWith(SID, 'aborted', undefined)
    })

    it('非终态帧不触发安全网（delta 帧异常不收尾进行中的流）', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const initial: Message[] = [{ id: 'a1', role: 'assistant', content: '', status: 'streaming', timestamp: 0 }]
      const ctx = makeCtx(initial)
      // text_delta handler 经 updateStreamingAssistant 检查不会自然抛错——用 ctx.messages 只读
      // 视角注入异常帧：构造 handler 必经的抛错点（queueStates 代理）成本高，改用 message_start
      // 同款注入：clearPendingSend 抛错 + 断言 finalizeSession 全程零调用
      vi.mocked(ctx.clearPendingSend).mockImplementation(() => { throw new Error('effect boom') })
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'm-2' }))
      expect(ctx.finalizeSession).not.toHaveBeenCalled()
    })
  })

  describe('dispatchMessageEvent 未注册 message.* 类型的 dev 观测（RD-1#9）', () => {
    beforeEach(() => {
      setActivePinia(createPinia())
      __clearUnhandledFrameTypeWarnForTest()
      __resetDevModeForTesting()
    })

    afterEach(() => {
      vi.restoreAllMocks()
      __resetDevModeForTesting()
      __clearUnhandledFrameTypeWarnForTest()
    })

    it('dev 下未注册 type → console.warn 一次/类型（协议漂移可见），行为仍为 no-op 不抛错', () => {
      provideDevMode(true)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ctx = makeCtx()

      // 同一未知类型两次：去重后只 warn 一次（防刷屏）
      expect(() => dispatchMessageEvent(ctx, SID, msg('message.future_frame', { x: 1 }))).not.toThrow()
      expect(() => dispatchMessageEvent(ctx, SID, msg('message.future_frame', { x: 2 }))).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('unhandled frame type message.future_frame')

      // no-op 语义不变：无消息副作用、不收尾
      expect(getMsgs(ctx)).toHaveLength(0)
      expect(ctx.finalizeSession).not.toHaveBeenCalled()

      // 另一类型独立计数（去重键 = 帧类型）
      dispatchMessageEvent(ctx, SID, msg('message.another_unknown'))
      expect(warn).toHaveBeenCalledTimes(2)
    })

    it('非 dev（未注入 provideDevMode，默认 false）→ 零 warn（生产零噪音）', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.future_frame'))
      expect(warn).not.toHaveBeenCalled()
    })

    it('已注册类型不触发 warn（不污染正常流的观测信号）', () => {
      provideDevMode(true)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
      expect(warn).not.toHaveBeenCalled()
    })
  })
});

// ======== 来源：finalized-rebuild.test.ts ========
describe("finalized-rebuild", () => {
  const SID = 's-test'
  const T_LOAD = 1_700_000_000_000

  function listOf(ctx: MessageEffectContext): Message[] {
    return ctx.messages.value.get(SID)?.value ?? []
  }

  /** message_end(assistant) 帧（载荷 = probe-P2 实测的 pi entry 形态：content parts + usage + timestamp）。 */
  function assistantEndFrame(
    parts: Array<Record<string, unknown>>,
    over: { messageId?: string; usage?: Record<string, unknown>; timestampMs?: number } = {},
  ): ServerMessage {
    const tsMs = over.timestampMs ?? T_LOAD
    const entry: PiMessageEntry = {
      type: 'message',
      parentId: null,
      timestamp: new Date(tsMs).toISOString(),
      message: {
        role: 'assistant',
        content: parts,
        timestamp: tsMs,
        ...(over.usage !== undefined ? { usage: over.usage } : {}),
      },
    } as PiMessageEntry
    return msg(SID, 'message.message_end', {
      entry,
      ...(over.messageId !== undefined ? { messageId: over.messageId } : {}),
    })
  }

  /** thinking part 载荷形态（probe-P2 键集合：thinking,type）。 */
  const thinkPart = (text: string): Record<string, unknown> => ({ type: 'thinking', thinking: text })

  /** text part 载荷形态（键集合：text,type）。 */
  const textPart = (text: string): Record<string, unknown> => ({ type: 'text', text })

  /** toolCall part 载荷形态（键集合：arguments,id,name,type）。 */
  const toolPart = (id: string, name: string): Record<string, unknown> => ({ type: 'toolCall', id, name, arguments: {} })

  afterEach(() => {
    __resetDevModeForTesting()
  })

  describe('message_end(assistant) 定稿权威重建（D3）', () => {
    it('R1: 基础重建——载荷全文/usage/endedAt 覆写 delta 累积，status 保持 streaming，textFinalized 打标', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a-1' }))
      // delta 累积不完整（模拟丢 delta——权威载荷随后校正）
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.text_delta', { delta: 'hel' }))
      dispatchMessageEvent(ctx, SID, assistantEndFrame(
        [textPart('hello 完整正文')],
        { usage: { input: 400, output: 500, totalTokens: 900 } },
      ))
      const list = listOf(ctx)
      expect(list).toHaveLength(1)
      const m = list[0]
      expect(m.id).toBe('a-1')
      expect(m.content).toBe('hello 完整正文')
      expect(m.contentBlocks).toEqual([{ type: 'text', refId: 'text', contentIndex: 0 }])
      expect(m.usage).toEqual({ inputTokens: 400, outputTokens: 500 })
      expect(m.endedAt).toBe(T_LOAD)
      expect(m.textFinalized).toBe(true)
      // status 不动（规则 2）：sealed guard 与后续消息定位依赖 streaming 态
      expect(m.status).toBe('streaming')
    })

    it('R2: 交错多段块序按 parts 下标重建（probe-P2 F5 形态）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a-1' }))
      dispatchMessageEvent(ctx, SID, assistantEndFrame([
        thinkPart('第一段思考'),
        textPart('第一段正文'),
        thinkPart('第二段思考'),
        textPart('第二段正文'),
      ]))
      const m = listOf(ctx)[0]
      expect(m.content).toBe('第一段正文第二段正文')
      // text 块单块哨兵是 collectContentParts 权威语义（多次 text part 累加合并、contentIndex
      // 取首个 text 下标）——与 reload 侧同构
      expect(m.contentBlocks).toEqual([
        { type: 'thinking', refId: 'a-1-th0', contentIndex: 0 },
        { type: 'text', refId: 'text', contentIndex: 1 },
        { type: 'thinking', refId: 'a-1-th2', contentIndex: 2 },
      ])
      // 关联不变量（规则 4）：contentBlocks 引用 id 与思考对象 id 一一对应
      expect(m.thinking).toEqual([
        { id: 'a-1-th0', content: '第一段思考', collapsed: true },
        { id: 'a-1-th2', content: '第二段思考', collapsed: true },
      ])
    })

    it('R3: 重复思考定稿消除（GLM P3a）——实时多块，载荷单 thinking part → 重建后单块', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a-1' }))
      // 实时通道：首段正常产出 + GLM 重复/空条目轮（不同 thinkingId 的空块——幂等只拦同 id）
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th-real', contentIndex: 0 }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_delta', { delta: '真思考内容' }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_end'))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th-echo-1', contentIndex: 0 }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_end'))
      expect(listOf(ctx)[0].thinking).toHaveLength(2)
      // 定稿：载荷只有一份思考条目 → 重建后单块（重复消除；join 复用保留实时起止时刻）
      dispatchMessageEvent(ctx, SID, assistantEndFrame([thinkPart('真思考内容'), textPart('正文')]))
      const m = listOf(ctx)[0]
      expect(m.thinking).toEqual([
        { id: 'a-1-th0', content: '真思考内容', collapsed: true, startTime: expect.any(Number), endTime: expect.any(Number) },
      ])
      expect(m.contentBlocks).toEqual([
        { type: 'thinking', refId: 'a-1-th0', contentIndex: 0 },
        { type: 'text', refId: 'text', contentIndex: 1 },
      ])
    })

    it('R4: id 锚定定位——多气泡在场时锚点命中目标气泡（末条非锚点）', () => {
      const ctx = makeCtx()
      // 旧气泡（mid-turn 已定稿、保持 streaming）+ 新气泡
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-1' }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-2' }))
      // 迟到的旧 message_end 帧带锚点（interpreter 附加 currentMessageId）
      dispatchMessageEvent(ctx, SID, assistantEndFrame([textPart('旧消息全文')], { messageId: 'm-1' }))
      const list = listOf(ctx)
      expect(list).toHaveLength(2)
      expect(list[0]).toMatchObject({ id: 'm-1', content: '旧消息全文', textFinalized: true })
      // 未定稿气泡不携带标记（键不存在）
      expect(list[1].id).toBe('m-2')
      expect(list[1]).not.toHaveProperty('textFinalized')
    })

    it('R5: C2 顺序不变量 dev 断言——锚定命中 ≠ 末条 streaming 时 dev warn 不阻断', () => {
      provideDevMode(true)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-1' }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-2' }))
      dispatchMessageEvent(ctx, SID, assistantEndFrame([textPart('旧消息全文')], { messageId: 'm-1' }))
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('anchor/position mismatch')
      // 不阻断：重建照常落锚点气泡
      expect(listOf(ctx)[0]).toMatchObject({ id: 'm-1', content: '旧消息全文' })
      warnSpy.mockRestore()
    })

    it('R6: 中断态复原——已收尾气泡（error 文案在场）按载荷覆写，status 复原 complete、error 退役、isInterrupted 保留', () => {
      // C2 断言只针对「末条 streaming 在场时锚定 ≠ 它」的真错挂：本场景（断连收尾后无
      // streaming 气泡的合法迟到定稿覆写，D3 规则 1）不触发 anchor/position mismatch warn。
      provideDevMode(true)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ctx = makeCtx([
        {
          id: 'm-1', role: 'assistant', content: '', status: 'error', timestamp: 1000,
          error: '与运行时的连接已断开，回复已中断。重新连接后可继续。', isInterrupted: true,
        },
      ])
      // 断连收尾后的权威载荷到达（带锚点）：不做 sealed 丢弃（规则 1）
      dispatchMessageEvent(ctx, SID, assistantEndFrame([textPart('完整正文')], { messageId: 'm-1' }))
      const m = listOf(ctx)[0]
      expect(m.status).toBe('complete')
      expect(m.error).toBeUndefined()
      expect(m.content).toBe('完整正文')
      expect(m.isInterrupted).toBe(true)
      expect(m.textFinalized).toBe(true)
      expect(warnSpy).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('R7: 工具补建置 running + 关联不变量 + tool_call_start 幂等衔接（规则 3）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a-1' }))
      // pi 事件序：工具执行严格晚于所属 message_end——重建时刻 tool_call_start 帧未到
      dispatchMessageEvent(ctx, SID, assistantEndFrame(
        [toolPart('tc-1', 'bash')],
        { usage: { input: 10, output: 20 } },
      ))
      let m = listOf(ctx)[0]
      // 补建置 running（非 reload 侧终态 completed）
      expect(m.toolCalls).toEqual([{ id: 'tc-1', toolName: 'bash', input: {}, status: 'running', startTime: expect.any(Number) }])
      expect(m.contentBlocks).toEqual([{ type: 'toolCall', refId: 'tc-1', contentIndex: 0 }])
      // 随后 tool_call_start 到达：同 id 幂等不重插、不倒退 running
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.tool_call_start', {
        entry: { type: 'toolCall', toolCallId: 'tc-1', toolName: 'bash', arguments: { cmd: 'ls' }, messageId: 'a-1' },
      }))
      m = listOf(ctx)[0]
      expect(m.toolCalls).toHaveLength(1)
      expect(m.toolCalls![0]).toMatchObject({ id: 'tc-1', status: 'running', input: { cmd: 'ls' } })
      expect(m.contentBlocks ?? []).toHaveLength(1)
    })

    it('R8: join 复用保实时 live 状态（thinking 起止时刻），content 为载荷权威全文', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a-1' }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th-live', contentIndex: 0 }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_delta', { delta: '实时累积（可能不完整）' }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_end'))
      const liveStart = listOf(ctx)[0].thinking![0].startTime
      dispatchMessageEvent(ctx, SID, assistantEndFrame([thinkPart('载荷权威全文'), textPart('正文')]))
      const m = listOf(ctx)[0]
      // 序位兜底 join：id 重写为载荷派生 id、content 换载荷全文；collapsed/startTime/endTime 保留实时值
      expect(m.thinking).toEqual([
        { id: 'a-1-th0', content: '载荷权威全文', collapsed: true, startTime: liveStart, endTime: expect.any(Number) },
      ])
      expect(m.contentBlocks?.[0]).toEqual({ type: 'thinking', refId: 'a-1-th0', contentIndex: 0 })
    })

    it('R9: 载荷无 thinking/toolCall → 重建清空 delta 阶段残留（权威整条覆写）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a-1' }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th-x' }))
      dispatchMessageEvent(ctx, SID, assistantEndFrame([textPart('纯正文')]))
      const m = listOf(ctx)[0]
      expect(m.thinking).toBeUndefined()
      expect(m.toolCalls).toBeUndefined()
      expect(m.contentBlocks).toEqual([{ type: 'text', refId: 'text', contentIndex: 0 }])
    })

    it('R10: 无 streaming 气泡且无锚点 → no-op 不崩（空态行为与升级前一致）', () => {
      const settled = makeCtx([{ id: 'm-1', role: 'assistant', content: 'done', status: 'complete', timestamp: 1000 }])
      expect(() => dispatchMessageEvent(settled, SID, assistantEndFrame([textPart('x')]))).not.toThrow()
      expect(listOf(settled)[0].content).toBe('done')
      expect(listOf(settled)[0]).not.toHaveProperty('textFinalized')

      const empty = makeCtx([])
      expect(() => dispatchMessageEvent(empty, SID, assistantEndFrame([textPart('x')]))).not.toThrow()
      expect(listOf(empty)).toHaveLength(0)
    })

    it('R11: D3 补建留痕 dev warn——载荷条目无实时对象时 warn 一次', () => {
      provideDevMode(true)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a-1' }))
      dispatchMessageEvent(ctx, SID, assistantEndFrame([toolPart('tc-9', 'read')]))
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('backfilled')
      warnSpy.mockRestore()
    })
  })
});

// ======== 来源：registry.test.ts ========
describe("registry", () => {
  const SID = 's-test'

  const startFrame = (messageId: string) => msg(SID, 'message.message_start', { messageId })

  /** 构造既有 assistant 气泡（预置分区用；默认 streaming 形态，字段与 handler 新建气泡同构）。 */
  function assistantBubble(over: Partial<Message> = {}): Message {
    return {
      id: 'm-1',
      role: 'assistant',
      content: '',
      status: 'streaming',
      timestamp: 1000,
      contentBlocks: [],
      ...over,
    }
  }

  function listOf(ctx: MessageEffectContext): Message[] {
    return ctx.messages.value.get(SID)?.value ?? []
  }

  describe('message_start 幂等查重（D1：同源重复帧复用不 append）', () => {
    it('AC1: 同 messageId 双投只产一气泡（第二条复用已有气泡）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, startFrame('m-1'))
      dispatchMessageEvent(ctx, SID, startFrame('m-1'))
      const list = listOf(ctx)
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe('m-1')
      expect(list[0].status).toBe('streaming')
    })

    it('AC2a: 查重命中·已终结形态——complete 气泡保持终态（status/内容/终态字段逐项不动）', () => {
      const sealedBubble = assistantBubble({ content: '已完成回复', status: 'complete', endedAt: 2000 })
      const ctx = makeCtx([sealedBubble])
      dispatchMessageEvent(ctx, SID, startFrame('m-1'))
      const list = listOf(ctx)
      expect(list).toHaveLength(1)
      expect(list[0]).toEqual(sealedBubble)
      expect(list[0].status).toBe('complete')
      expect(list[0].content).toBe('已完成回复')
      expect(list[0].endedAt).toBe(2000)
    })

    it('AC2b: 查重命中·流式中形态——保持 streaming，后续 delta 继续累积到原气泡', () => {
      const ctx = makeCtx([assistantBubble({ content: 'partial' })])
      dispatchMessageEvent(ctx, SID, startFrame('m-1'))
      let list = listOf(ctx)
      expect(list).toHaveLength(1)
      expect(list[0].status).toBe('streaming')
      // start 帧复用不清空既有累积内容（不重置气泡）
      expect(list[0].content).toBe('partial')
      // delta 累积目标由「最后一条 streaming assistant」定位——复用后自然落到原气泡
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.text_delta', { delta: ' more' }))
      list = listOf(ctx)
      expect(list).toHaveLength(1)
      expect(list[0].content).toBe('partial more')
    })

    it('AC3: pendingSend 未清窗口——查重命中帧 clearPendingSend 照常执行（不卡乐观态）', () => {
      // 场景：重订回放/重叠段双投，分区已有同 id 气泡（首轮投递或基线已建），乐观气泡
      // pending 窗口尚未清——查重命中仍必须执行 clear（早返回实现会跳过 clear 卡住乐观态）
      const ctx = makeCtx([assistantBubble({ status: 'complete' })])
      dispatchMessageEvent(ctx, SID, startFrame('m-1'))
      expect(ctx.clearPendingSend).toHaveBeenCalledTimes(1)
      expect(ctx.clearPendingSend).toHaveBeenCalledWith(SID)
      // 第二帧（同 messageId 重复帧）查重命中同样不早返回，clear 照常
      dispatchMessageEvent(ctx, SID, startFrame('m-1'))
      expect(ctx.clearPendingSend).toHaveBeenCalledTimes(2)
    })

    it('回归锚: 未命中（新 messageId）照常 append 新 streaming 气泡 + clearPendingSend', () => {
      const ctx = makeCtx([assistantBubble({ id: 'm-0', status: 'complete' })])
      dispatchMessageEvent(ctx, SID, startFrame('m-1'))
      const list = listOf(ctx)
      expect(list).toHaveLength(2)
      expect(list[1].id).toBe('m-1')
      expect(list[1].status).toBe('streaming')
      expect(ctx.clearPendingSend).toHaveBeenCalledWith(SID)
    })
  })
});

// ======== 来源：text-finalized.test.ts ========
describe("text-finalized", () => {
  const SID = 's-test'

  function listOf(ctx: MessageEffectContext): Message[] {
    return ctx.messages.value.get(SID)?.value ?? []
  }

  /** 预置 streaming assistant 气泡（字段与 message_start handler 新建气泡同构）。 */
  function streamingBubble(id: string, over: Partial<Message> = {}): Message {
    return {
      id,
      role: 'assistant',
      content: '',
      status: 'streaming',
      timestamp: 1000,
      contentBlocks: [],
      ...over,
    }
  }

  /** message_end 帧（assistant/user/toolResult role，content 落盘形态）。 */
  function endFrame(role: string, text: string): ServerMessage {
    return msg(SID, 'message.message_end', {
      entry: msgEntry(`entry-${role}-${Math.random().toString(36).slice(2, 8)}`, {
        role,
        content: text ? [{ type: 'text', text }] : [],
        timestamp: Date.now(),
      }),
    })
  }

  describe('message_end 文本定稿标记（chat-flow-text-color D1）', () => {
    it('AC1: assistant end 打标末条 streaming 气泡，status 保持 streaming（sealed guard 依赖）', () => {
      const ctx = makeCtx([streamingBubble('m-1', { content: '已写完的分析' })])
      dispatchMessageEvent(ctx, SID, endFrame('assistant', '已写完的分析'))
      const list = listOf(ctx)
      expect(list).toHaveLength(1)
      expect(list[0].textFinalized).toBe(true)
      expect(list[0].status).toBe('streaming')
    })

    it('AC2: 两条消息序列——各自在自己的 end 时刻被打标', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-1' }))
      dispatchMessageEvent(ctx, SID, endFrame('assistant', '第一段'))
      expect(listOf(ctx)[0]).toMatchObject({ id: 'm-1', textFinalized: true, status: 'streaming' })

      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-2' }))
      // m-2 start 后、m-2 end 前：m-1 已定稿，m-2 未定稿（无 textFinalized 键）
      expect(listOf(ctx)[1].id).toBe('m-2')
      expect(listOf(ctx)[1]).not.toHaveProperty('textFinalized')
      dispatchMessageEvent(ctx, SID, endFrame('assistant', '第二段'))
      expect(listOf(ctx)[1]).toMatchObject({ id: 'm-2', textFinalized: true, status: 'streaming' })
    })

    it('AC3: user role end 不打标', () => {
      const ctx = makeCtx([streamingBubble('m-1')])
      dispatchMessageEvent(ctx, SID, endFrame('user', '用户消息'))
      expect(listOf(ctx)[0].textFinalized).toBeUndefined()
    })

    it('AC4: toolResult role end 不打标', () => {
      const ctx = makeCtx([streamingBubble('m-1')])
      dispatchMessageEvent(ctx, SID, endFrame('toolResult', '工具结果'))
      expect(listOf(ctx)[0].textFinalized).toBeUndefined()
    })

    it('AC5: 无 streaming 气泡（终态/空分区）→ no-op 不崩', () => {
      const settled = makeCtx([streamingBubble('m-1', { status: 'complete', content: 'done' })])
      expect(() => dispatchMessageEvent(settled, SID, endFrame('assistant', 'x'))).not.toThrow()
      expect(listOf(settled)[0].textFinalized).toBeUndefined()

      const empty = makeCtx([])
      expect(() => dispatchMessageEvent(empty, SID, endFrame('assistant', 'x'))).not.toThrow()
      expect(listOf(empty)).toHaveLength(0)
    })

    it('AC6: 已打标气泡幂等——重复 assistant end 不再改动列表', () => {
      const ctx = makeCtx([streamingBubble('m-1')])
      dispatchMessageEvent(ctx, SID, endFrame('assistant', '正文'))
      const after = listOf(ctx)
      dispatchMessageEvent(ctx, SID, endFrame('assistant', '正文'))
      expect(listOf(ctx)).toEqual(after)
    })
  })
});

// ======== 来源：thinking-start-idempotent.test.ts ========
describe("thinking-start-idempotent", () => {
  const SID = 's-test'

  function lastAssistant(ctx: MessageEffectContext): Message {
    const list = ctx.messages.value.get(SID)?.value ?? []
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].role === 'assistant') return list[i]
    }
    throw new Error('no assistant')
  }

  describe('thinking_start 同 id 幂等（D3 规则 6）', () => {
    it('I1: 同 thinkingId 重复 start → 单块（thinking 与 contentBlocks 均不重复）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th1', contentIndex: 0 }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_delta', { delta: '思考中' }))
      // 重复投递的 start（同 id）：跳过建块
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th1', contentIndex: 0 }))
      const a = lastAssistant(ctx)
      expect(a.thinking).toHaveLength(1)
      expect(a.thinking![0]).toMatchObject({ id: 'th1', content: '思考中' })
      expect(a.contentBlocks).toEqual([{ type: 'thinking', refId: 'th1', contentIndex: 0 }])
    })

    it('I2: 不同 thinkingId → 各建一块（正常多段思考不受幂等影响）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th1', contentIndex: 0 }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th2', contentIndex: 2 }))
      const a = lastAssistant(ctx)
      expect(a.thinking).toHaveLength(2)
      expect(a.thinking!.map((t) => t.id)).toEqual(['th1', 'th2'])
      expect(a.contentBlocks).toHaveLength(2)
    })

    it('I3: 缺 thinkingId（fallback 随机 id）→ 重复帧照建（查重不影响缺省分支）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', {}))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', {}))
      expect(lastAssistant(ctx).thinking).toHaveLength(2)
    })

    it('I4: 幂等命中后 delta 累积照常进原块', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a1' }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th1' }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th1' }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_delta', { delta: 'A' }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_delta', { delta: 'B' }))
      const a = lastAssistant(ctx)
      expect(a.thinking).toHaveLength(1)
      expect(a.thinking![0].content).toBe('AB')
    })
  })
});

// ======== 来源：tool-call-start-anchor.test.ts ========
describe("tool-call-start-anchor", () => {
  const SID = 's-test'

  function listOf(ctx: MessageEffectContext): Message[] {
    return ctx.messages.value.get(SID)?.value ?? []
  }

  function assistantAt(ctx: MessageEffectContext, id: string): Message {
    const found = listOf(ctx).find((m) => m.id === id)
    if (!found) throw new Error(`no assistant ${id}`)
    return found
  }

  /** tool_call_start 帧（entry 形态，messageId 锚点可选）。 */
  function startFrame(toolCallId: string, opts: { messageId?: string; contentIndex?: number } = {}): ServerMessage {
    return msg(SID, 'message.tool_call_start', {
      entry: {
        type: 'toolCall',
        toolCallId,
        toolName: 'bash',
        arguments: { cmd: 'ls' },
        ...(opts.contentIndex !== undefined ? { contentIndex: opts.contentIndex } : {}),
        ...(opts.messageId !== undefined ? { messageId: opts.messageId } : {}),
      },
    })
  }

  afterEach(() => {
    __resetDevModeForTesting()
  })

  describe('tool_call_start 三级定位（C1）', () => {
    it('A1: ① 级——D3 重建补建的 running 条目 + 新气泡在场 + 迟到 start → 幂等不重插、落旧气泡', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-1' }))
      // 定稿重建补建 tc-1（工具执行严格晚于 message_end，补建置 running）
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_end', {
        messageId: 'm-1',
        entry: {
          type: 'message', parentId: null, timestamp: new Date(1700000000000).toISOString(),
          message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1', name: 'bash', arguments: {} }], timestamp: 1700000000000 },
        },
      }))
      // 下一回合新气泡开（迟到窗口）：末条 assistant 已是 m-2
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-2' }))
      // 迟到的 tool_call_start（锚点 = m-1）：① findToolCallOwner 命中 m-1 已建条目
      dispatchMessageEvent(ctx, SID, startFrame('tc-1', { messageId: 'm-1' }))
      expect(assistantAt(ctx, 'm-1').toolCalls).toHaveLength(1)
      expect(assistantAt(ctx, 'm-1').toolCalls![0]).toMatchObject({ id: 'tc-1', status: 'running' })
      // 不挂新气泡
      expect(assistantAt(ctx, 'm-2').toolCalls).toBeUndefined()
      expect(assistantAt(ctx, 'm-2').contentBlocks).toEqual([])
    })

    it('A2: ② 级——条目不在场 + 锚点命中旧 streaming 气泡 → 挂旧气泡', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-1' }))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-2' }))
      dispatchMessageEvent(ctx, SID, startFrame('tc-2', { messageId: 'm-1', contentIndex: 1 }))
      expect(assistantAt(ctx, 'm-1').toolCalls).toHaveLength(1)
      expect(assistantAt(ctx, 'm-1').toolCalls![0]).toMatchObject({ id: 'tc-2' })
      expect(assistantAt(ctx, 'm-1').contentBlocks).toEqual([{ type: 'toolCall', refId: 'tc-2', contentIndex: 1 }])
      expect(assistantAt(ctx, 'm-2').toolCalls).toBeUndefined()
    })

    it('A3: ② 级防御——锚点属主已终态且条目不在场 → 丢弃 + dev warn', () => {
      provideDevMode(true)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ctx = makeCtx([
        { id: 'm-1', role: 'assistant', content: 'done', status: 'complete', timestamp: 1000 },
        { id: 'm-2', role: 'assistant', content: '', status: 'streaming', timestamp: 2000, contentBlocks: [] },
      ])
      dispatchMessageEvent(ctx, SID, startFrame('tc-late', { messageId: 'm-1' }))
      // 终态气泡不复活 running 块、streaming 新气泡不误挂
      expect(assistantAt(ctx, 'm-1').toolCalls).toBeUndefined()
      expect(assistantAt(ctx, 'm-2').toolCalls).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('refusing to revive running block')
      warnSpy.mockRestore()
    })

    it('A4: ③ 级——锚点缺失 → 末条命中（现状行为逐字不变）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-1' }))
      dispatchMessageEvent(ctx, SID, startFrame('tc-1'))
      expect(assistantAt(ctx, 'm-1').toolCalls).toHaveLength(1)
      expect(assistantAt(ctx, 'm-1').toolCalls![0]).toMatchObject({ id: 'tc-1', status: 'running' })
    })

    it('A5: 同气泡幂等——同 callId 重复 start 不重复追加（toolCalls 与 contentBlocks）', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-1' }))
      dispatchMessageEvent(ctx, SID, startFrame('tc-1', { contentIndex: 0 }))
      dispatchMessageEvent(ctx, SID, startFrame('tc-1', { contentIndex: 0 }))
      const m = assistantAt(ctx, 'm-1')
      expect(m.toolCalls).toHaveLength(1)
      expect(m.contentBlocks).toHaveLength(1)
    })

    it('A6: 已收尾条目不倒退——tool_call_end 终态回填后迟到 start → 保持终态', () => {
      const ctx = makeCtx()
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-1' }))
      dispatchMessageEvent(ctx, SID, startFrame('tc-1'))
      dispatchMessageEvent(ctx, SID, msg(SID, 'message.tool_call_end', {
        entry: {
          type: 'message', parentId: null, timestamp: new Date(0).toISOString(),
          message: { role: 'toolResult', toolCallId: 'tc-1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 0 },
        },
      }))
      expect(assistantAt(ctx, 'm-1').toolCalls![0]).toMatchObject({ status: 'completed', output: 'ok' })
      // 迟到的重复 start：① 命中已终态条目 → 幂等 no-op，不倒退回 running
      dispatchMessageEvent(ctx, SID, startFrame('tc-1', { messageId: 'm-1' }))
      expect(assistantAt(ctx, 'm-1').toolCalls).toHaveLength(1)
      expect(assistantAt(ctx, 'm-1').toolCalls![0]).toMatchObject({ status: 'completed', output: 'ok' })
    })
  })
});
