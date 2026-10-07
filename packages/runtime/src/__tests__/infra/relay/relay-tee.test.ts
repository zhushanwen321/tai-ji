/**
 * relay-tee 单测（E-2，验收 1 的 tee 部分）。
 *
 * 覆盖：entry 化产出（message_end / toolCall 两形态 + 锚点补齐）、stream_chunk 增量契约
 * （B2：delta 原样转发 + msgSeq/deltaSeq 双序号 + 虚拟分区归属 + 定稿清除帧 additive
 * msgSeq）、状态查询入口 getStreamState（拉取数据源三元组）、单事件隔离（坏字节丢弃不
 * 连坐）、连续 50 失败放弃、大 payload tool result 全量透传。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RelayTee, TEE_MAX_CONSECUTIVE_FAILURES } from '../../../infra/relay/relay-tee.js'
import type { ServerMessage } from '@taiji/shared'
import { subagentVirtualId, isSubagentVirtualId, extractMainSessionId } from '@taiji/shared'

/** 本层旧截断阈值（256KB，已退役）——大 payload 透传用例以「超旧阈值仍有量」为形，
 *  防护语义改由下游出站守卫承担（见 describe 内注释）。 */
const TEE_FORMER_LIMIT_BYTES = 256 * 1024

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

/** stream_delta 帧 payload（R 路径现只产清除形态：lines undefined + additive msgSeq）。 */
function deltaFrames(published: Array<{ sid: string; msg: ServerMessage }>) {
  return published
    .filter((p) => p.msg.type === 'subagent.stream_delta')
    .map((p) => p.msg.payload as { sessionId: string; recordId: string; lines: string[] | undefined; msgSeq?: number })
}

/** stream_chunk 帧 payload（B2 增量内容契约：msgSeq/deltaSeq/delta）。 */
function chunkFrames(published: Array<{ sid: string; msg: ServerMessage }>) {
  return published
    .filter((p) => p.msg.type === 'subagent.stream_chunk')
    .map((p) => p.msg.payload as { sessionId: string; recordId: string; msgSeq: number; deltaSeq: number; delta: string })
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

describe('RelayTee stream_chunk 增量契约（B2 subagent-stream-chunk §4.2）', () => {
  it('text_delta → stream_chunk：delta 原样转发 + 双序号（msgSeq 从 1 起、deltaSeq per-message 从 0）+ 虚拟分区归属', () => {
    const { tee, published } = createTee()
    feedLines(tee, [
      { type: 'message_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello ' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'world' } },
    ])
    const chunks = chunkFrames(published)
    expect(chunks).toHaveLength(2)
    const virtualId = subagentVirtualId('main-1', 'rec-1')
    expect(chunks.every((c) => c.sessionId === virtualId)).toBe(true)
    expect(chunks.every((c) => c.recordId === 'rec-1')).toBe(true)
    expect(chunks[0]).toMatchObject({ msgSeq: 1, deltaSeq: 0, delta: 'hello ' })
    expect(chunks[1]).toMatchObject({ msgSeq: 1, deltaSeq: 1, delta: 'world' })
  })

  it('R 路径不再产生携带 lines 全文的 stream_delta：中间态零全量帧，stream_delta 仅剩定稿清除（lines undefined + additive msgSeq）', () => {
    const { tee, published } = createTee()
    feedLines(tee, [
      { type: 'message_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } },
      // 下一轮 assistant 消息：msgSeq 递进 2，deltaSeq 重置 0
      { type: 'message_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'b' } },
    ])
    const deltas = deltaFrames(published)
    // 只剩清除帧（lines undefined），携带 msgSeq = 被定稿消息的序号（sealedMsgSeq 置位依据）
    expect(deltas).toHaveLength(1)
    expect(deltas[0].lines).toBeUndefined()
    expect(deltas[0].msgSeq).toBe(1)
    const chunks = chunkFrames(published)
    expect(chunks.map((c) => [c.msgSeq, c.deltaSeq, c.delta])).toEqual([
      [1, 0, 'a'],
      [2, 0, 'b'],
    ])
  })

  it('user/toolResult message_end 不发清除帧、user message_start 不递进 msgSeq（msgSeq 只数 assistant 消息）', () => {
    const { tee, published } = createTee()
    feedLines(tee, [
      // user 轮（翻译层 message_start{user} 产 noop，tee 不见；message_end 只产 entry）
      { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: 1 } },
      // assistant 轮
      { type: 'message_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a1' } },
    ])
    expect(deltaFrames(published)).toHaveLength(0)
    expect(chunkFrames(published).map((c) => [c.msgSeq, c.deltaSeq, c.delta])).toEqual([[1, 0, 'a1']])
    // toolResult message_end 同理：只产 entry，不发清除帧
    feedLines(tee, [
      { type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'r' }], toolCallId: 'tc-1', timestamp: 2 } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a2' } },
    ])
    expect(deltaFrames(published)).toHaveLength(0)
    // msgSeq 未被 user/toolResult 打断，仍在第 1 条 assistant 消息内递进
    expect(chunkFrames(published).map((c) => [c.msgSeq, c.deltaSeq, c.delta])).toEqual([
      [1, 0, 'a1'],
      [1, 1, 'a2'],
    ])
  })
})

describe('RelayTee 状态查询入口 getStreamState（B2 §4.2，session.getSubagentStreamState 数据源）', () => {
  it('未开始 / 已定稿 / dispose 后：found=false，其余字段恒 0/0/[]', () => {
    const { tee } = createTee()
    // 未开始
    expect(tee.getStreamState()).toEqual({ found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [] })
    // 已定稿（assistant message_end 之后流不再 in-flight）
    feedLines(tee, [
      { type: 'message_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } },
    ])
    expect(tee.getStreamState()).toEqual({ found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [] })
    // dispose 后（child exit / abandoned）
    tee.dispose()
    expect(tee.getStreamState()).toEqual({ found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [] })
  })

  it('进行中流：同步读三元组 (msgSeq, lastDeltaSeq 水位, lines 累积全文 split 形态)', () => {
    const { tee } = createTee()
    // message_start 已见、尚无 delta：水位 -1（expectedDeltaSeq 重置 0，首条 chunk 不被去重误丢）
    feedLines(tee, [{ type: 'message_start' }])
    expect(tee.getStreamState()).toEqual({ found: true, msgSeq: 1, lastDeltaSeq: -1, lines: [''] })
    feedLines(tee, [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '入口是 main.ts\n导出' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' main 函数' } },
    ])
    // 2 条 delta 已发：水位 = 最后一条的 deltaSeq = 1；lines 与旧 stream_delta payload 同形
    expect(tee.getStreamState()).toEqual({
      found: true,
      msgSeq: 1,
      lastDeltaSeq: 1,
      lines: ['入口是 main.ts', '导出 main 函数'],
    })
    // 第二条 assistant 消息：msgSeq 递进、水位归 -1、lines 重置
    feedLines(tee, [
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } },
      { type: 'message_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'y' } },
    ])
    expect(tee.getStreamState()).toEqual({ found: true, msgSeq: 2, lastDeltaSeq: 0, lines: ['y'] })
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

describe('RelayTee toolResult entry 全量透传（不在此层截断）', () => {
  // [subagent 投影丢失修复] 本层曾有 >256KB 整体替换截断——image 块/输出文本/details
  // 全丢且 reload 才恢复，与主会话 tool_call_end 帧（无此层截断）形成通道水位劈叉。
  // 量级防护单点 = 下游出站守卫（outbound-frame-registry 已注册
  // session.subagentEntriesAppended：8MB 告警 + 32MB 契约保持式截断）。

  it('大 payload tool result（含 image 块 + details）全量透传，结构字段与内容无损', () => {
    const { tee, published } = createTee()
    const big = 'x'.repeat(TEE_FORMER_LIMIT_BYTES + 4096)
    const img = { type: 'image', data: 'aGVsbG8taW1hZ2U=', mimeType: 'image/png' }
    feedLines(tee, [
      {
        type: 'tool_execution_end',
        toolCallId: 'tc-big',
        toolName: 'codemode',
        result: { content: [{ type: 'text', text: big }, img], details: { calls: [{ id: 'n1', name: 'read' }] } },
        isError: false,
      },
    ])
    const frames = entryFrames(published)
    expect(frames).toHaveLength(1)
    const entry = frames[0].entries[0] as unknown as {
      message: { role: string; content: Array<{ type: string; text?: string; data?: string }>; toolCallId: string; details?: unknown }
    }
    expect(entry.message.role).toBe('toolResult')
    expect(entry.message.toolCallId).toBe('tc-big')
    // 文本不被替换（无截断提示行）、image 块原样保留、details 不丢
    expect(entry.message.content).toHaveLength(2)
    expect(entry.message.content[0].text).toBe(big)
    expect(entry.message.content[1]).toEqual(img)
    expect(entry.message.details).toEqual({ calls: [{ id: 'n1', name: 'read' }] })
  })

  it('混合 content 形状（text + image 交错）逐块透传（丢失形态锚定：subagent 会话图片可见性的 live 载体）', () => {
    const { tee, published } = createTee()
    const img1 = { type: 'image', data: 'ZGF0YTE=', mimeType: 'image/png' }
    const img2 = { type: 'image', data: 'ZGF0YTJf', mimeType: 'image/jpeg' }
    feedLines(tee, [
      {
        type: 'tool_execution_end',
        toolCallId: 'tc-mix',
        toolName: 'codemode',
        result: { content: [{ type: 'text', text: 'first' }, img1, { type: 'text', text: 'second' }, img2] },
        isError: false,
      },
    ])
    const entry = entryFrames(published)[0].entries[0] as unknown as {
      message: { content: Array<{ type: string; text?: string; data?: string }> }
    }
    expect(entry.message.content.map((b) => b.type)).toEqual(['text', 'image', 'text', 'image'])
    expect(entry.message.content[0].text).toBe('first')
    expect(entry.message.content[1].data).toBe('ZGF0YTE=')
    expect(entry.message.content[2].text).toBe('second')
    expect(entry.message.content[3].data).toBe('ZGF0YTJf')
  })

  it('纯文本 tool result 原样透传', () => {
    const { tee, published } = createTee()
    feedLines(tee, [
      { type: 'tool_execution_end', toolCallId: 'tc-ok', toolName: 'read', result: { content: [{ type: 'text', text: 'small body' }] }, isError: false },
    ])
    const entry = entryFrames(published)[0].entries[0] as unknown as { message: { content: Array<{ type: string; text: string }> } }
    expect(entry.message.content[0].text).toBe('small body')
  })

  it('assistant 大文本同样全量透传', () => {
    const { tee, published } = createTee()
    const big = 'y'.repeat(TEE_FORMER_LIMIT_BYTES + 4096)
    feedLines(tee, [
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: big }] } },
    ])
    const entry = entryFrames(published)[0].entries[0] as unknown as { message: { role: string; content: Array<{ type: string; text: string }> } }
    expect(entry.message.role).toBe('assistant')
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
    const chunks = chunkFrames(published)
    expect(chunks).toHaveLength(1)
    // ① 三段键、不 throw，与 shared 工厂按线 piSessionId 构造逐字一致（INVAR-1.1 键契约闭环）
    expect(chunks[0].sessionId).toBe(subagentVirtualId('line-rt-b1', 'rec-b1'))
    expect(isSubagentVirtualId(chunks[0].sessionId)).toBe(true)
    // ② 清理前缀 owner 面：中段 = 线 piSessionId（renderer disposeBtwLinePartitions 按
    //    isVirtualKeyOf(key, extractBtwPiSessionId(vid)) 前缀命中——owner 同源即闭环）
    expect(extractMainSessionId(chunks[0].sessionId)).toBe('line-rt-b1')
    // D9 路由键不变：bus publish 第一参仍是线 vid（分区路由），仅键中段翻译
    expect(published[0].sid).toBe(vid)
    // entry 帧同理：路由键 vid、payload 归属 vid（路由键 ≠ 键中段，两面解耦）
    feedLines(tee, [{ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], timestamp: 1 } }])
    const entries = entryFrames(published)
    expect(entries[0].sessionId).toBe(vid)
  })
})
