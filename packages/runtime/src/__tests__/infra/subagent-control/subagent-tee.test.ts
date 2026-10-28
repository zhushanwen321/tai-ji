/**
 * subagent-tee：同被测对象多测试文件合并产物（round5-g 测试提速整合）。
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper 随节下沉）：
 *   - subagent-tee.test.ts
 *   - subagent-live-reload.test.ts
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/infra/subagent-control/subagent-tee.test.ts
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractMainSessionId, isSubagentVirtualId, subagentVirtualId } from '@taiji/shared'
import type { PiToolCallEntryForm, ServerMessage } from '@taiji/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { replayEntries } from '../../../../../core/src/domain/chat/apply-entry.js'
import type { PiEntry } from '../../../../../core/src/domain/chat/apply-entry.js'
import { PiSessionStore } from '../../../infra/pi/session-store.js'
import { SubagentMirrorHub } from '../../../infra/subagent-control/mirror.js'
import { SubagentTee, TEE_MAX_CONSECUTIVE_FAILURES } from '../../../infra/subagent-control/subagent-tee.js'
import { getHistoryFromFilePath } from '../../../services/session-history.js'


// ════════════════ 来源: subagent-tee.test.ts ════════════════
describe('subagent-tee', () => {
  /**
   * subagent-tee 单测（E-2 验收 1 的 tee 部分；含 M3 degraded 状态）。
   *
   * 覆盖：entry 化产出（message_end / toolCall 两形态 + 锚点补齐）、stream_chunk 增量契约
   * （B2：delta 原样转发 + msgSeq/deltaSeq 双序号 + 虚拟分区归属 + 定稿清除帧 additive
   * msgSeq）、状态查询入口 getStreamState（拉取数据源三元组）、单事件隔离（坏字节丢弃不
   * 连坐）、连续 50 失败放弃、大 payload tool result 全量透传。
   */

  /** 本层旧截断阈值（256KB，已退役）——大 payload 透传用例以「超旧阈值仍有量」为形，
   *  防护语义改由下游出站检查承担（见 describe 内注释）。 */
  const TEE_FORMER_LIMIT_BYTES = 256 * 1024

  function createTee() {
    const published: Array<{ sid: string; msg: ServerMessage }> = []
    const publish = vi.fn((sid: string, msg: ServerMessage) => {
      published.push({ sid, msg })
    })
    const tee = new SubagentTee({ mainSessionId: 'main-1', recordId: 'rec-1', publish })
    return { tee, publish, published }
  }

  /** 便捷：把若干 JSON 行拼成 Buffer 喂入。 */
  function feedLines(tee: SubagentTee, lines: unknown[]): void {
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

  describe('SubagentTee entry 化产出', () => {
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

  describe('SubagentTee stream_chunk 增量契约（B2 subagent-stream-chunk §4.2）', () => {
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

    it('text_delta chunk publish 抛错：单事件隔离丢弃，textAccumulated 与 deltaSeq 保持配对（拉取回放无孤儿 delta）', () => {
      const { tee, publish, published } = createTee()
      feedLines(tee, [
        { type: 'message_start' },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } },
      ])
      // 中间一条 chunk publish 抛错（bus 故障形态，W1 隔离丢弃该事件）
      publish.mockImplementationOnce(() => {
        throw new Error('bus down')
      })
      feedLines(tee, [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ORPHAN' } }])
      // 失败不连坐：后续 delta 照常发布，deltaSeq 连续（未被失败事件虚占）
      feedLines(tee, [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'b' } }])
      const chunks = chunkFrames(published)
      expect(chunks.map((c) => [c.msgSeq, c.deltaSeq, c.delta])).toEqual([
        [1, 0, 'a'],
        [1, 1, 'b'],
      ])
      // 配对不变量：lines 只含成功发布 delta 的拼接（不含被丢弃的 'ORPHAN'），
      // lastDeltaSeq 与已发布条数一致——getStreamState 拉取回放不重复显示孤儿 delta
      expect(tee.getStreamState()).toEqual({ found: true, msgSeq: 1, lastDeltaSeq: 1, lines: ['ab'] })
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

  describe('SubagentTee 状态查询入口 getStreamState（B2 §4.2，session.getSubagentStreamState 数据源）', () => {
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

  describe('SubagentTee 隔离与放弃', () => {
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

  describe('SubagentTee toolResult entry 全量透传（不在此层截断）', () => {
    // [subagent 派生视图丢失修复] 本层曾有 >256KB 整体替换截断——image 块/输出文本/details
    // 全丢且 reload 才恢复，与主会话 tool_call_end 帧（无此层截断）形成通道水位劈叉。
    // 量级防护单点 = 下游出站检查（outbound-frame-registry 已注册
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

  describe('[B1 / btw-question D9③] 生产半边：btw 线归属的键中段（M1-a 键中段位约定）', () => {
    it('mainSessionId=btw 线 session id（W4a 后即 pi 真实 id）：构造不 throw；键 = subagent:<线id>:<recordId> 三段式；bus 路由键同值', () => {
      const published: Array<{ sid: string; msg: ServerMessage }> = []
      const publish = vi.fn((sid: string, msg: ServerMessage) => { published.push({ sid, msg }) })
      const lineId = 'line-rt-b1'
      expect(() => new SubagentTee({ mainSessionId: lineId, recordId: 'rec-b1', publish })).not.toThrow()
      const tee = new SubagentTee({ mainSessionId: lineId, recordId: 'rec-b1', publish })
      feedLines(tee, [
        { type: 'message_start' },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } },
      ])
      const chunks = chunkFrames(published)
      expect(chunks).toHaveLength(1)
      // ① 三段键、不 throw，与 shared 工厂按线 session id 构造逐字一致（INVAR-1.1 键契约闭环；
      //   W4a 后线 id 即 pi 真实 id——旧「vid 先 extract 再入键」翻译层已删，直接传参）
      expect(chunks[0].sessionId).toBe(subagentVirtualId('line-rt-b1', 'rec-b1'))
      expect(isSubagentVirtualId(chunks[0].sessionId)).toBe(true)
      // ② 清理前缀 owner 面：中段 = 线 session id（renderer disposeBtwLinePartitions 按
      //    isVirtualKeyOf(key, 线id) 前缀命中——owner 同源即闭环）
      expect(extractMainSessionId(chunks[0].sessionId)).toBe('line-rt-b1')
      // D9 路由键不变：bus publish 第一参仍是线 session id（分区路由）
      expect(published[0].sid).toBe(lineId)
      // entry 帧同理：路由键与 payload 归属同为线 session id（路由键 = 键中段，两面同源）
      feedLines(tee, [{ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], timestamp: 1 } }])
      const entries = entryFrames(published)
      expect(entries[0].sessionId).toBe(lineId)
    })
  })
});

// ════════════════ 来源: subagent-live-reload.test.ts ════════════════
describe('subagent-live-reload', () => {
  /**
   * subagent live ≡ reload 等价性断言。
   *
   * 不变量：同一 subagent 任务的 drawer 对话流，两条供数路径喂同一个 core reducer 产出全等 state——
   * - live 路径：真实 SubagentTee（infra/subagent-control/subagent-tee.ts，生产 tee 翻译层）消费合成 child stdout
   *   字节流（pi RPC 事件 JSONL），产出的 session.subagentEntriesAppended entry 帧序列
   *   （PiToolCallEntryForm overlay 形态按 applySubagentEntries 同规则剔除，不进 reducer）
   *   → replayEntries；
   * - reload 路径：getSubagentHistory pi 直读链的转换尾段 getHistoryFromFilePath
   *   （parseJsonl + filterObjectEntries + mapSessionEntries + convertPiHistory，session-service.ts
   *   直读分支同款）→ Message[]。
   *
   * 断言形态对齐同目录 live-reload.test.ts（W21 store 级同构）——差异只在数据来源免真实 LLM：
   * 两路径 fixture 由同一逻辑会话常量派生（「同一任务」的结构性保证），stdout 事件序列 ≡ JSONL
   * 追加顺序的协议依据与主对话流相同（message_end 是持久化唯一触发点，event-adapter.ts W5 注释）。
   *
   * 归一化口径（物理差异非实现差异）：fixture JSONL entry 不写顶层 id——pi 在 emit message_end
   * **之后**才 appendMessage 分配 uuidv7（tee 侧结构性拿不到，live-reload.test.ts 因此剥 reload 侧
   * id），此处不写 id 使两路径 deriveBaseId 走同一 `e<N>` 派生；消息体 timestamp 两路径同源，
   * toolResult 回填不落时间戳字段，无其他归一点。
   *
   * 运行：cd packages/runtime && npx vitest run src/__tests__/equivalence/subagent-live-reload.test.ts
   */

  const MAIN_SID = 's-eq-subagent-main'
  const RECORD_ID = 'rec-eq-subagent-1'
  const VIRTUAL_ID = subagentVirtualId(MAIN_SID, RECORD_ID)

  // ── 同一 subagent 任务的逻辑会话（两路径 fixture 的唯一事实源）──────────────────
  //
  // 两轮形态覆盖续聊轮（R1 根因场景）+ 工具调用全链（R2：assistant 带 toolCall →
  // toolResult 回填 → 总结 assistant），usage/fileChanges 提取路径随消息体两侧同源透传。
  const CONVERSATION = {
    round1: {
      user: { text: '分析这个仓库的入口文件', timestamp: 1000 },
      assistantWithTool: {
        text: '先读取入口文件',
        toolCall: { id: 'tc-eq-subagent-1', name: 'read', arguments: { path: '/repo/src/main.ts' } },
        usage: { input: 120, output: 30 },
        stopReason: 'toolUse',
        timestamp: 1100,
      },
      toolResult: {
        toolCallId: 'tc-eq-subagent-1',
        toolName: 'read',
        text: 'export function main() { bootstrap() }',
        isError: false,
        timestamp: 1200,
      },
      summary: {
        text: '入口是 main.ts\n导出 main 函数',
        stopReason: 'end_turn',
        timestamp: 1300,
      },
    },
    round2: {
      user: { text: '再看看测试目录', timestamp: 2000 },
      reply: { text: '测试目录包含 3 个用例文件', stopReason: 'end_turn', timestamp: 2100 },
    },
  } as const

  /** 逻辑会话 → pi session JSONL 行（reload 路径：SessionManager._persist 形态）。 */
  function toSessionJsonlLines(): string[] {
    const c1 = CONVERSATION.round1
    const c2 = CONVERSATION.round2
    const line = (message: Record<string, unknown>): string =>
      JSON.stringify({ type: 'message', timestamp: new Date(Number(message.timestamp)).toISOString(), message })
    return [
      line({ role: 'user', content: [{ type: 'text', text: c1.user.text }], timestamp: c1.user.timestamp }),
      line({
        role: 'assistant',
        content: [
          { type: 'text', text: c1.assistantWithTool.text },
          { type: 'toolCall', ...c1.assistantWithTool.toolCall },
        ],
        usage: c1.assistantWithTool.usage,
        stopReason: c1.assistantWithTool.stopReason,
        timestamp: c1.assistantWithTool.timestamp,
      }),
      line({
        role: 'toolResult',
        toolCallId: c1.toolResult.toolCallId,
        toolName: c1.toolResult.toolName,
        content: [{ type: 'text', text: c1.toolResult.text }],
        isError: c1.toolResult.isError,
        timestamp: c1.toolResult.timestamp,
      }),
      line({
        role: 'assistant',
        content: [{ type: 'text', text: c1.summary.text }],
        stopReason: c1.summary.stopReason,
        timestamp: c1.summary.timestamp,
      }),
      line({ role: 'user', content: [{ type: 'text', text: c2.user.text }], timestamp: c2.user.timestamp }),
      line({
        role: 'assistant',
        content: [{ type: 'text', text: c2.reply.text }],
        stopReason: c2.reply.stopReason,
        timestamp: c2.reply.timestamp,
      }),
    ]
  }

  /**
   * 逻辑会话 → child stdout 事件行（live 路径：pi --mode rpc 事件流，顺序 ≡ JSONL 追加顺序）。
   * 含 message_start / text_delta / toolcall_end 锚点等 tee 全管线输入；事件 wire 字段名
   * （args/result/toolCallId/isError）以 pi-protocol.ts 为准（ADR-0037）。
   */
  function toChildStdoutLines(): string[] {
    const c1 = CONVERSATION.round1
    const c2 = CONVERSATION.round2
    const msgStart = (ts: number): string =>
      JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: ts } })
    const deltas = (parts: string[]): string[] =>
      parts.map((d) => JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: d } }))
    return [
      // round 1：user message_end（pi agent-loop 开头逐 prompt emit，A-08 实测序）
      JSON.stringify({ type: 'message_start', message: { role: 'user', content: [], timestamp: c1.user.timestamp } }),
      JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: c1.user.text }], timestamp: c1.user.timestamp } }),
      // assistant 流式：start → text_delta* → toolcall_end（contentIndex 锚点）
      msgStart(c1.assistantWithTool.timestamp),
      ...deltas(['先读取', '入口文件']),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: c1.assistantWithTool.toolCall.id }, contentIndex: 1 } }),
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: c1.assistantWithTool.text },
            { type: 'toolCall', ...c1.assistantWithTool.toolCall },
          ],
          usage: c1.assistantWithTool.usage,
          stopReason: c1.assistantWithTool.stopReason,
          timestamp: c1.assistantWithTool.timestamp,
        },
      }),
      // 工具执行：canonical 信息在 tool_execution_*（message_update.toolcall_* 数据不全）
      JSON.stringify({ type: 'tool_execution_start', toolCallId: c1.toolResult.toolCallId, toolName: c1.toolResult.toolName, args: { path: c1.assistantWithTool.toolCall.arguments.path } }),
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: c1.toolResult.toolCallId,
        toolName: c1.toolResult.toolName,
        isError: c1.toolResult.isError,
        result: { content: [{ type: 'text', text: c1.toolResult.text }], details: null },
      }),
      // pi 对同一 toolResult 双发（R2-S1，chaos real-pi 同证）：message_end 携带持久化权威
      // timestamp（与 JSONL 路径同源 1200）。live 侧 endTime 经 U3 last-wins 收敛为权威值 ≡ reload；
      // 缺此帧则 live endTime = 客户端时钟（Gate A 实测漂移源）
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: c1.toolResult.toolCallId,
          toolName: c1.toolResult.toolName,
          isError: c1.toolResult.isError,
          content: [{ type: 'text', text: c1.toolResult.text }],
          timestamp: c1.toolResult.timestamp,
        },
      }),
      // 总结 assistant + 清除帧触发（assistant 定稿 lines:undefined）
      msgStart(c1.summary.timestamp),
      ...deltas(['入口是 main.ts\n导出', ' main 函数']),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: c1.summary.text }], stopReason: c1.summary.stopReason, timestamp: c1.summary.timestamp } }),
      // round 2（续聊轮）：user → assistant
      JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: c2.user.text }], timestamp: c2.user.timestamp } }),
      msgStart(c2.reply.timestamp),
      ...deltas(['测试目录包含 ', '3 个用例文件']),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: c2.reply.text }], stopReason: c2.reply.stopReason, timestamp: c2.reply.timestamp } }),
    ]
  }

  describe('equivalence: subagent live ≡ reload（tee entry 帧 × getSubagentHistory 直读链，免真实 LLM）', () => {
    let dir: string | null = null

    afterEach(async () => {
      if (dir) {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
        dir = null
      }
    })

    it('tee entry 帧序列 replayEntries 产出 == JSONL 直读链产出（messages deep equal + reducer 确定性）', async () => {
      // ── live 路径：真实 SubagentTee 消费合成 stdout → 收集两种 WS 帧 ──
      const frames: Array<{ sessionId: string; msg: ServerMessage }> = []
      const tee = new SubagentTee({
        mainSessionId: MAIN_SID,
        recordId: RECORD_ID,
        publish: (sessionId, msg) => frames.push({ sessionId, msg }),
      })
      tee.feed(Buffer.from(toChildStdoutLines().map((l) => l + '\n').join(''), 'utf-8'))

      const entryFrames = frames.filter(
        (f): f is { sessionId: string; msg: ServerMessage & { payload: { entries: unknown[] } } } =>
          f.msg.type === 'session.subagentEntriesAppended',
      )
      // 非空检查（防 0 == 0 空转）：8 帧各 1 entry = 6 条 message（user×2 / assistant×3 /
      // toolResult×1，R2-S1 双发含 message_end 权威帧）+ 1 条 toolCall overlay form。overlay
      // form 是 tool_execution_start 的 UI running 态载体（timestamp 运行时生成非确定值），
      // 不进 reducer 不变量——下方 liveEntries 按 applySubagentEntries 同规则剔除，此处只
      // 断言其存在与归属。
      const allEntries = entryFrames.flatMap((f) => f.msg.payload.entries)
      expect(entryFrames).toHaveLength(8)
      expect(allEntries).toHaveLength(8)
      const overlayForms = allEntries.filter(
        (e): e is PiToolCallEntryForm => (e as { type?: string }).type === 'toolCall',
      )
      expect(overlayForms).toHaveLength(1)
      expect(overlayForms[0]?.toolCallId).toBe('tc-eq-subagent-1')

      // 帧归属契约（关键规则 7 / §4.3）：entry 帧路由 key = 主 sid，payload.sessionId 也是主 sid
      for (const f of entryFrames) {
        expect(f.sessionId).toBe(MAIN_SID)
        expect(f.msg.type).toBe('session.subagentEntriesAppended')
      }

      // B2 chunk 契约（§4.2）：内容通道 = 增量 stream_chunk——msgSeq = per-record assistant
      // 消息序号（从 1 起，3 条 assistant 消息 = 1/2/3）、deltaSeq = per-message 从 0 递增、
      // delta 原样转发；R 路径不再产生携带 lines 全文的 stream_delta
      const chunkFrames = frames.filter(
        (f): f is { sessionId: string; msg: ServerMessage & { payload: { sessionId: string; recordId: string; msgSeq: number; deltaSeq: number; delta: string } } } =>
          f.msg.type === 'subagent.stream_chunk',
      )
      expect(chunkFrames.map((f) => [f.msg.payload.msgSeq, f.msg.payload.deltaSeq, f.msg.payload.delta])).toEqual([
        [1, 0, '先读取'],
        [1, 1, '入口文件'],
        [2, 0, '入口是 main.ts\n导出'],
        [2, 1, ' main 函数'],
        [3, 0, '测试目录包含 '],
        [3, 1, '3 个用例文件'],
      ])
      for (const f of chunkFrames) {
        expect(f.msg.payload.recordId).toBe(RECORD_ID)
        // payload.sessionId = 虚拟分区 id（chunk 归属侧）；publish 路由 key = 主 sid（bus 分区侧）
        expect(f.msg.payload.sessionId).toBe(VIRTUAL_ID)
        expect(f.sessionId).toBe(MAIN_SID)
      }
      // assistant 定稿清除帧：每条 assistant message_end 一条（3 条），lines undefined +
      // additive msgSeq = 被定稿消息序号（消费端 sealedMsgSeq 置位依据）
      const clearFrames = frames.filter(
        (f): f is { sessionId: string; msg: ServerMessage & { payload: { sessionId: string; lines?: string[] | undefined; msgSeq?: number } } } =>
          f.msg.type === 'subagent.stream_delta',
      )
      expect(clearFrames).toHaveLength(3)
      expect(clearFrames.map((f) => f.msg.payload.msgSeq)).toEqual([1, 2, 3])
      expect(clearFrames.every((f) => f.msg.payload.lines === undefined)).toBe(true)
      // 失步拉取语义锚点（§4.1/§4.2）：消费端失步检测/水位回放在 core/renderer 单元验证，
      // 此处锚定拉取数据源（tee 状态查询三元组）的终态形状——全部消息定稿后 found=false
      expect(tee.getStreamState()).toEqual({ found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [] })

      // overlay 形态（toolCall form）按 applySubagentEntries 同规则剔除——store 层 UI 态不在
      // reducer 不变量内（§2.4 不变量只约束 reducer state）
      const liveEntries = allEntries.filter(
        (e): e is PiEntry => (e as { type?: string }).type !== 'toolCall',
      )
      // U3：R2-S1 双发的 message_end toolResult 帧计入（去重后仍占一个 entry 位）
      expect(liveEntries).toHaveLength(7)
      const liveState = replayEntries(liveEntries)

      // ── reload 路径：getSubagentHistory pi 直读链尾段（JSONL fixtures 驱动）──
      dir = await mkdtemp(join(tmpdir(), 'subagent-equiv-'))
      const filePath = join(dir, 'subagent-session.jsonl')
      await writeFile(filePath, toSessionJsonlLines().join('\n') + '\n', 'utf-8')
      const { messages: reloadMessages } = await getHistoryFromFilePath(filePath, new PiSessionStore())

      // ── 等价性主断言（E-重开验收）：live ≡ reload ──
      expect(liveState.messages).toEqual(reloadMessages)

      // reducer 确定性（chaos 不变量 0 同款）：同一 live 序列两次重放全等
      expect(replayEntries(liveEntries)).toEqual(liveState)

      // 结构检查：工具链路完整回填（非孤儿）、五条派生视图消息角色序符合两轮形态
      expect(liveState.orphanToolResults).toHaveLength(0)
      expect(reloadMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user', 'assistant'])
      const withTool = reloadMessages[1]
      expect(withTool?.toolCalls?.[0]).toMatchObject({
        id: 'tc-eq-subagent-1',
        status: 'completed',
        output: 'export function main() { bootstrap() }',
      })

      tee.dispose()
    })

    it('[M3 u-m3-mirror] 镜像通路（fd3 帧编码 → SubagentMirrorHub 解码）帧序列 ≡ 直通通路，entry replay ≡ JSONL 直读（raw mirror 不破 live ≡ reload）', async () => {
      const lines = toChildStdoutLines()
      // tool_execution_end 等翻译路径的 entry.timestamp 源自 Date.now()：冻结系统时间使两路径
      // 生成值逐字节可比（仅 fake Date，不 fake 定时器——fs 异步路径不受影响）。
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      try {

      // 直通路径：真实 Tee 直接喂行（镜像开通前的既有通路）
      const direct: Array<{ sessionId: string; msg: ServerMessage }> = []
      const directTee = new SubagentTee({
        mainSessionId: MAIN_SID,
        recordId: RECORD_ID,
        publish: (sid, msg) => direct.push({ sessionId: sid, msg }),
      })
      directTee.feed(Buffer.from(lines.map((l) => l + '\n').join(''), 'utf-8'))

      // 镜像路径：引擎 writer 同款编码（逐行 {v,recordId,seq,b64}）→ hub 解码（含任意 chunk 切分）
      const mirrored: Array<{ sessionId: string; msg: ServerMessage }> = []
      const hub = new SubagentMirrorHub({ publish: (sid, msg) => mirrored.push({ sessionId: sid, msg }) })
      hub.openChannel('ch-eq', MAIN_SID)
      let seq = 0
      const wire = lines
        .map((l) => `${JSON.stringify({ v: 1, recordId: RECORD_ID, seq: seq++, b64: Buffer.from(l, 'utf8').toString('base64') })}\n`)
        .join('')
      const bytes = Buffer.from(wire, 'utf8')
      for (let i = 0; i < bytes.length; i += 97) {
        hub.ingestBytes('ch-eq', bytes.subarray(i, Math.min(i + 97, bytes.length)))
      }

      // 帧序列全等：镜像开通前后前端可见帧流（entry/chunk/清除）逐字段一致。
      // 归一化物理差异（非实现差异）：toolCall overlay form 的 messageId/timestamp 是
      // tee 实例本地生成值（两个实例必然不同），按 applySubagentEntries 同规则剔除。
      const normalize = (f: { sessionId: string; msg: ServerMessage }): unknown => {
        const msg = JSON.parse(JSON.stringify(f.msg)) as {
          payload?: { entries?: Array<Record<string, unknown>> }
        }
        for (const entry of msg.payload?.entries ?? []) {
          if (entry.type === 'toolCall') {
            delete entry.messageId
            delete entry.timestamp
          }
        }
        return { sessionId: f.sessionId, msg }
      }
      expect(mirrored.length).toBeGreaterThan(0)
      expect(mirrored.map(normalize)).toEqual(direct.map(normalize))

      // 镜像路径 entry replay ≡ JSONL 直读（与直通路径共用同一 reload 断言目标）
      const mirrorEntries = mirrored
        .filter((f) => f.msg.type === 'session.subagentEntriesAppended')
        .flatMap((f) => (f.msg as { payload: { entries: unknown[] } }).payload.entries)
        .filter((e): e is PiEntry => (e as { type?: string }).type !== 'toolCall')
      dir = await mkdtemp(join(tmpdir(), 'mirror-equiv-'))
      const filePath = join(dir, 'subagent-session.jsonl')
      await writeFile(filePath, toSessionJsonlLines().join('\n') + '\n', 'utf-8')
      const { messages: reloadMessages } = await getHistoryFromFilePath(filePath, new PiSessionStore())
      expect(replayEntries(mirrorEntries).messages).toEqual(reloadMessages)

      hub.disposeChannel('ch-eq')
      directTee.dispose()
      } finally {
        vi.useRealTimers()
      }
    })

    it('流中拉取数据源形状（B2 失步/接入拉取占位）：getStreamState 同步读进行中三元组', () => {
      // 消费端失步检测与水位回放逻辑在 core/renderer 单元验证（§4.3）；本文件锚定其数据源
      // ——产生端只在 feed 刻度间推进状态，拉取（RPC 半）同步读到的快照必须自洽：
      // found=true + msgSeq=1 + lastDeltaSeq 水位 + lines 全文 split 形态
      const tee = new SubagentTee({
        mainSessionId: MAIN_SID,
        recordId: RECORD_ID,
        publish: () => {},
      })
      tee.feed(
        Buffer.from(
          [
            JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1100 } }),
            JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '先读取' } }),
            JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '入口文件' } }),
          ]
            .map((l) => l + '\n')
            .join(''),
          'utf-8',
        ),
      )
      expect(tee.getStreamState()).toEqual({
        found: true,
        msgSeq: 1,
        lastDeltaSeq: 1,
        lines: ['先读取入口文件'],
      })
      tee.dispose()
    })
  })
});
