/**
 * EventAdapter message_update / message_start / message_end 定向测试（CRAP 靶子：
 * handleMessageUpdate / handleMessageStart / handleMessageEnd）。
 *
 * 已有覆盖：FR-5 error sub-type、FR-2 customType 透传、toolResult/user role 忽略、
 * toolcall_end 锚点（equivalence/tool-call-index）。本文件补齐 sub-type 翻译矩阵的
 * 其余分支与 message_start 的畸形字段守卫（type-safety review：来源是 extension 第三方
 * 代码，畸形值不得以谎报类型进 wire 帧）：
 * - text_delta / thinking_delta：delta 缺省空串 + contentIndex 锚点透传（D-2 合帧依据）
 * - thinking_start / thinking_end：载荷形态（含 contentIndexAnchor 缺省不产字段）
 * - toolcall_start / toolcall_delta / text_start / text_end：noop（噪声抑制）
 * - 未知 sub-type：warn + noop（不崩）
 * - customStart 畸形守卫：customType 非字符串不误入 custom 分支、details 数组/原始值 →
 *   undefined、content 非字符串 → undefined、display 非布尔 → undefined
 * - message_end role 白名单（R3 business-logic INFO）：allowed role 通过（user/assistant/
 *   toolResult 全量下发）、未建模 role（bashExecution 等）warn + 跳过（双计防线）、
 *   customType 判定优先于白名单（对齐 handleMessageStart）、畸形 message warn + 降级丢弃
 *
 * 运行：cd packages/runtime && npx vitest run test/event-adapter-message-stream.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createEventAdapter, type WsSender, type EventAdapterOptions } from './helpers/event-adapter-test-fixture.js'
import { EventAdapter } from '../src/infra/pi/event-adapter.js'
import type { ServerMessage, ServerMessageUnion } from '@taiji/shared'
import type { PiMessage } from '../src/infra/pi/rpc-client.js'

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

describe('message_start 畸形字段守卫（handleMessageStart custom 分支）', () => {
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
      // entry 形状：type message / parentId null / timestamp 由 message.timestamp 派生 ISO /
      // message 原样透传（reducer 输入 = 持久化 entry 同构）
      expect(sent[0].payload).toEqual({
        sessionId: SID,
        entry: { type: 'message', parentId: null, timestamp: new Date(ts).toISOString(), message },
      })
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
