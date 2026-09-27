/**
 * relay-tee 单测（E-2，验收 1 的 tee 部分）。
 *
 * 覆盖：entry 化产出（message_end / toolCall 两形态 + 锚点补齐）、stream_delta 中间态
 * （累积全文 + 虚拟分区归属 + 定稿清除）、单事件隔离（坏字节丢弃不连坐）、连续 50
 * 失败放弃、大 payload tool result 截断（>256KB 摘要）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RelayTee, TEE_MAX_CONSECUTIVE_FAILURES, TEE_TOOL_RESULT_MAX_BYTES } from '../../../infra/relay/relay-tee.js'
import type { ServerMessage } from '@taiji/shared'
import { subagentVirtualId, isSubagentVirtualId, extractMainSessionId } from '@taiji/shared'

function createTee() {
  const published: Array<{ sid: string; msg: ServerMessage }> = []
  const publish = vi.fn((sid: string, msg: ServerMessage) => {
    published.push({ sid, msg })
  })
  const tee = new RelayTee({ mainSessionId: 'main-1', recordId: 'rec-1', publish })
  return { tee, publish, published }
}

/** 便捷：把若干 JSON 行拼成 Buffer 喂入。 */
function feedLines(tee: RelayTee, lines: unknown[]): void {
  const chunk = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  tee.feed(Buffer.from(chunk, 'utf-8'))
}

function entryFrames(published: Array<{ sid: string; msg: ServerMessage }>) {
  return published
    .filter((p) => p.msg.type === 'session.subagentEntriesAppended')
    .map((p) => p.msg.payload as { sessionId: string; subagentId: string; entries: Array<{ type: string; [k: string]: unknown }> })
}

function deltaFrames(published: Array<{ sid: string; msg: ServerMessage }>) {
  return published
    .filter((p) => p.msg.type === 'subagent.stream_delta')
    .map((p) => p.msg.payload as { sessionId: string; recordId: string; lines: string[] | undefined })
}

describe('RelayTee entry 化产出', () => {
  it('message_end → session.subagentEntriesAppended（bus key = 主 sid，payload 归属主 sid + recordId）', () => {
    const { tee, published } = createTee()
    feedLines(tee, [
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 123 } },
    ])
    const frames = entryFrames(published)
    expect(frames).toHaveLength(1)
    expect(frames[0].sessionId).toBe('main-1')
    expect(frames[0].subagentId).toBe('rec-1')
    expect(frames[0].entries).toHaveLength(1)
    expect(frames[0].entries[0].type).toBe('message')
    // publish 的第一参数（bus 路由 key）是主 session id
    expect(published.find((p) => p.msg.type === 'session.subagentEntriesAppended')?.sid).toBe('main-1')
  })

  it('tool_execution_start/end → toolCall overlay + toolResult entry，contentIndex/messageId 锚点补齐', () => {
    const { tee, published } = createTee()
    feedLines(tee, [
      // assistant 消息开始（messageId 锚点）
      { type: 'message_start' },
      // toolcall_end 提供 contentIndex 顺序锚点
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 2, toolCall: { id: 'tc-1', name: 'read', arguments: { path: '/x' } } } },
      { type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'read', args: { path: '/x' } },
      { type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'read', result: { content: [{ type: 'text', text: 'file body' }] }, isError: false },
    ])
    const entries = entryFrames(published).flatMap((f) => f.entries)
    const toolCall = entries.find((e) => e.type === 'toolCall')
    expect(toolCall).toBeDefined()
    expect(toolCall?.toolCallId).toBe('tc-1')
    expect(toolCall?.contentIndex).toBe(2)
    expect(toolCall?.messageId).toMatch(/^a-/)
    const toolResult = entries.find((e) => e.type === 'message' && (e.message as { role?: string }).role === 'toolResult')
    expect(toolResult).toBeDefined()
    expect((toolResult?.message as { toolCallId?: string }).toolCallId).toBe('tc-1')
  })

  it('非 GUI 载体事件（agent_start/turn_end 等）不产 entry 帧', () => {
    const { tee, published } = createTee()
    feedLines(tee, [
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'turn_end', message: { role: 'assistant', content: [], usage: { totalTokens: 10 } }, toolResults: [] },
    ])
    expect(published).toHaveLength(0)
  })

  it('字节跨 read 边界的行重组（半个 JSON 行分两次 feed）', () => {
    const { tee, published } = createTee()
    const line = JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } })
    const half = Math.floor(line.length / 2)
    tee.feed(Buffer.from(line.slice(0, half), 'utf-8'))
    tee.feed(Buffer.from(line.slice(half) + '\n', 'utf-8'))
    expect(entryFrames(published)).toHaveLength(1)
  })
})

describe('RelayTee stream_delta 中间态', () => {
  it('text_delta 累积全文（lines 语义对齐 A-1），sessionId 是虚拟分区 id', () => {
    const { tee, published } = createTee()
    feedLines(tee, [
      { type: 'message_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello ' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'world' } },
    ])
    const deltas = deltaFrames(published)
    expect(deltas).toHaveLength(2)
    const virtualId = subagentVirtualId('main-1', 'rec-1')
    expect(deltas.every((d) => d.sessionId === virtualId)).toBe(true)
    expect(deltas[0].lines).toEqual(['hello '])
    expect(deltas[1].lines).toEqual(['hello world'])
  })

  it('assistant message_end 定稿 → 发清除帧（lines undefined）+ 重置累积', () => {
    const { tee, published } = createTee()
    feedLines(tee, [
      { type: 'message_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } },
      // 下一轮 assistant 消息的 delta 从空累积重新开始
      { type: 'message_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'b' } },
    ])
    const deltas = deltaFrames(published)
    expect(deltas.map((d) => d.lines)).toEqual([['a'], undefined, ['b']])
  })
})

describe('RelayTee 隔离与放弃', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('单事件坏字节丢弃不连坐：后续好事件照常产出', () => {
    const { tee, published } = createTee()
    tee.feed(Buffer.from('this is not json\n', 'utf-8'))
    feedLines(tee, [
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ])
    expect(entryFrames(published)).toHaveLength(1)
    expect(tee.abandoned).toBe(false)
  })

  it('非对象/无 type 的 JSON 行同样隔离丢弃', () => {
    const { tee } = createTee()
    tee.feed(Buffer.from('42\n"str"\nnull\n{}\n', 'utf-8'))
    expect(tee.abandoned).toBe(false)
  })

  it(`连续 ${TEE_MAX_CONSECUTIVE_FAILURES} 失败 → 放弃 tee 分支（后续 feed no-op）`, () => {
    const { tee, published } = createTee()
    for (let i = 0; i < TEE_MAX_CONSECUTIVE_FAILURES; i++) {
      tee.feed(Buffer.from(`bad line ${i}\n`, 'utf-8'))
    }
    expect(tee.abandoned).toBe(true)
    // 放弃后好事件也不再产出（drawer 降级快照 + reload）
    feedLines(tee, [
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'after' }] } },
    ])
    expect(entryFrames(published)).toHaveLength(0)
  })

  it('失败计数是连续语义：好坏交替永不放弃', () => {
    const { tee } = createTee()
    for (let i = 0; i < TEE_MAX_CONSECUTIVE_FAILURES + 10; i++) {
      tee.feed(Buffer.from('bad\n', 'utf-8'))
      feedLines(tee, [
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: String(i) }] } },
      ])
    }
    expect(tee.abandoned).toBe(false)
  })

  it('dispose 幂等，dispose 后 feed no-op', () => {
    const { tee, published } = createTee()
    tee.dispose()
    tee.dispose()
    feedLines(tee, [
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } },
    ])
    expect(published).toHaveLength(0)
  })
})

describe('RelayTee 大 payload 截断', () => {
  it(`tool result 超 ${TEE_TOOL_RESULT_MAX_BYTES} 字节 → 只投截断摘要`, () => {
    const { tee, published } = createTee()
    const big = 'x'.repeat(TEE_TOOL_RESULT_MAX_BYTES + 4096)
    feedLines(tee, [
      { type: 'tool_execution_end', toolCallId: 'tc-big', toolName: 'bash', result: { content: [{ type: 'text', text: big }] }, isError: false },
    ])
    const frames = entryFrames(published)
    expect(frames).toHaveLength(1)
    const entry = frames[0].entries[0] as unknown as { message: { role: string; content: Array<{ type: string; text: string }>; toolCallId: string } }
    expect(entry.message.role).toBe('toolResult')
    expect(entry.message.content[0].text).toContain('[relay tee truncated]')
    expect(entry.message.toolCallId).toBe('tc-big')
    // 结构字段保留、大体丢弃
    expect(entry.message.content[0].text.length).toBeLessThan(500)
  })

  it('阈值内的 tool result 原样透传', () => {
    const { tee, published } = createTee()
    feedLines(tee, [
      { type: 'tool_execution_end', toolCallId: 'tc-ok', toolName: 'read', result: { content: [{ type: 'text', text: 'small body' }] }, isError: false },
    ])
    const entry = entryFrames(published)[0].entries[0] as unknown as { message: { content: Array<{ type: string; text: string }> } }
    expect(entry.message.content[0].text).toBe('small body')
  })

  it('assistant 大文本不截断（截断只针对 toolResult）', () => {
    const { tee, published } = createTee()
    const big = 'y'.repeat(TEE_TOOL_RESULT_MAX_BYTES + 4096)
    feedLines(tee, [
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: big }] } },
    ])
    const entry = entryFrames(published)[0].entries[0] as unknown as { message: { role: string; content: Array<{ type: string; text: string }> } }
    expect(entry.message.content[0].text).toBe(big)
  })
})

describe('[B1 / btw-question D9③] 生产半边：btw 线归属的键中段翻译（M1-a 键中段位约定）', () => {
  it('mainSessionId=btw vid：构造不 throw；键 = subagent:<线piSid>:<recordId>（vid 不入键、三段式）；bus 路由键保持 vid', () => {
    const published: Array<{ sid: string; msg: ServerMessage }> = []
    const publish = vi.fn((sid: string, msg: ServerMessage) => { published.push({ sid, msg }) })
    const vid = 'btw:line-rt-b1'
    expect(() => new RelayTee({ mainSessionId: vid, recordId: 'rec-b1', publish })).not.toThrow()
    const tee = new RelayTee({ mainSessionId: vid, recordId: 'rec-b1', publish })
    feedLines(tee, [
      { type: 'message_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } },
    ])
    const deltas = deltaFrames(published)
    expect(deltas).toHaveLength(1)
    // ① 三段键、不 throw，与 shared 工厂按线 piSessionId 构造逐字一致（INVAR-1.1 键契约闭环）
    expect(deltas[0].sessionId).toBe(subagentVirtualId('line-rt-b1', 'rec-b1'))
    expect(isSubagentVirtualId(deltas[0].sessionId)).toBe(true)
    // ② 清理前缀 owner 面：中段 = 线 piSessionId（renderer disposeBtwLinePartitions 按
    //    isVirtualKeyOf(key, extractBtwPiSessionId(vid)) 前缀命中——owner 同源即闭环）
    expect(extractMainSessionId(deltas[0].sessionId)).toBe('line-rt-b1')
    // D9 路由键不变：bus publish 第一参仍是线 vid（分区路由），仅键中段翻译
    expect(published[0].sid).toBe(vid)
    // entry 帧同理：路由键 vid、payload 归属 vid（路由键 ≠ 键中段，两面解耦）
    feedLines(tee, [{ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], timestamp: 1 } }])
    const entries = entryFrames(published)
    expect(entries[0].sessionId).toBe(vid)
  })
})
