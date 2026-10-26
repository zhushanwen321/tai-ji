// apply-entry.test.ts —— core C05 簇合并产物（round5-G）。
// 共同被测业务模块：`src/domain/chat/apply-entry.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/domain/chat/__tests__/apply-entry-buffer-equivalence.test.ts（8 用例，skip 0）
//   - src/domain/chat/__tests__/apply-entry-convert.test.ts（18 用例，skip 0）
//   - src/domain/chat/__tests__/apply-entry-fold-equivalence.test.ts（7 用例，skip 0）
//   - src/domain/chat/__tests__/apply-entry.test.ts（44 用例，skip 0）
//   - src/domain/chat/__tests__/entry-truncate.test.ts（10 用例，skip 0）
//   - src/domain/chat/__tests__/handoff-instruction.test.ts（9 用例，skip 0）
//   - src/domain/chat/__tests__/turn-usage-live-reload-equivalence.test.ts（2 用例，skip 0）

import { describe, it, expect } from 'vitest'
import { applyEntry, createChatViewStateBuffer, createInitialChatViewState, replayEntries, type PiEntry, type PiMessageEntry } from '../apply-entry'
import { msgEntry, makeCtx as sharedMakeCtx, msg as serverMsg } from './helpers/fixtures'
import { expectDerivedIdSequence } from './helpers/equivalence-asserts'
import { computeToolCallFill, isHandoffPromptText, convertMessageBody } from '../apply-entry-convert'
import { parseDiffStat, ENTRY_TOOL_OUTPUT_MAX_BYTES, normalizePiToolResult, truncateEntryToolOutput } from '../apply-entry-utils'
import { type Message, type PiMessageEntry as PiMessageEntryShared, type ServerMessage, HANDOFF_PROMPT_TEMPLATE } from '@taiji/shared'
import { dispatchMessageEvent } from '../effects/registry'
import { type MessageEffectContext } from '../effect-types'
import { isHandoffInstructionNotice, isHandoffDocTurn, toRenderItems, type MessageTurn } from '../message-turns'
import { terminalMessagePatch } from '../mutations'
import { findLastAssistantIndex } from '../chunk-processor'
import { deriveTurnAggregates } from '../turn-aggregates'

// ======== 来源：apply-entry-buffer-equivalence.test.ts ========
describe("apply-entry-buffer-equivalence", () => {
  // ── fixture（msgEntry 构造收敛到 helpers/fixtures.ts 单源；混合全类型序列沿用
  //    apply-entry-fold-equivalence.test.ts 的手写字面量形态——承载 buffer 维度的序列语义）──

  const ISO = (ms: number): string => new Date(ms).toISOString()

  /**
 * 混合全类型序列：custom（纯数据 no-op）/ user / assistant（toolCalls + 无 id → e<N>
 * 派生交叉检验）/ toolResult（回填 + 同 id 双投递幂等 + 孤儿）/ bashExecution /
 * compactionSummary role / label（no-op）/ compaction / branch_summary / custom_message /
 * 未建模类型（default no-op）。
 */
  function mixedEntries(): PiEntry[] {
    return [
      { type: 'custom', id: 'c-1', parentId: null, timestamp: ISO(1), customType: 'taiji.client-msg-id', data: { clientUuid: 'u-1', userEntryId: 'e-user-1' } },
      msgEntry('e-user-1', { role: 'user', content: [{ type: 'text', text: '问题' }], timestamp: 100 }, { timestamp: ISO(100) }),
      { type: 'message', parentId: null, timestamp: ISO(200), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'ls' } }, { type: 'toolCall', id: 'tc-2', name: 'read', arguments: { path: '/x' } }], timestamp: 200 } },
      msgEntry('e-tr-1', { role: 'toolResult', toolCallId: 'tc-1', toolName: 'bash', content: [{ type: 'text', text: 'out' }], timestamp: 300 }, { timestamp: ISO(300) }),
      { type: 'message', parentId: null, timestamp: ISO(310), message: { role: 'toolResult', toolCallId: 'tc-1', toolName: 'bash', content: [{ type: 'text', text: 'out-dup-loses' }], timestamp: 310 } },
      msgEntry('e-tr-orphan', { role: 'toolResult', toolCallId: 'tc-none', toolName: 'read', content: [{ type: 'text', text: 'orphan' }], timestamp: 320 }, { timestamp: ISO(320) }),
      msgEntry('e-bash-1', { role: 'bashExecution', command: 'pwd', output: '/x', exitCode: 0, cancelled: false, truncated: false, timestamp: 400 }, { timestamp: ISO(400) }),
      msgEntry('e-cs-1', { role: 'compactionSummary', summary: '角色形态压缩', tokensBefore: 9, timestamp: 500 }, { timestamp: ISO(500) }),
      { type: 'label', id: 'l-1', parentId: null, timestamp: ISO(510), label: 'bookmark', targetId: 'e-user-1' },
      { type: 'compaction', id: 'cp-1', parentId: null, timestamp: ISO(600), summary: '专用形态压缩', firstKeptEntryId: 'e-user-1', tokensBefore: 50 },
      { type: 'branch_summary', id: 'br-1', parentId: null, timestamp: ISO(700), fromId: 'node-1', summary: '分支' },
      { type: 'custom_message', id: 'cmb-1', parentId: null, timestamp: ISO(800), customType: 'goal-context', content: '<goal_context>x</goal_context>', display: true, details: { k: 1 } },
      { type: 'model_change', id: 'mc-1', parentId: null, timestamp: ISO(810), provider: 'p', modelId: 'm' },
    ] as unknown as PiEntry[]
  }

  /** buffer 连续 feed 混合序列（对 reduce 基准的喂入侧） */
  function feedMixed(): ReturnType<typeof createChatViewStateBuffer> {
    const buf = createChatViewStateBuffer()
    for (const entry of mixedEntries()) buf.feed(entry)
    return buf
  }

  /** 无 id user entry 序列（`e<N>` 确定性 id 派生路径的载体；n 含 0/1/2 边界档） */
  function idLessEntries(n: number): PiEntry[] {
    return Array.from({ length: n }, (_, i) => ({
      type: 'message',
      parentId: null,
      timestamp: ISO(i),
      message: { role: 'user', content: [{ type: 'text', text: `m${i}` }], timestamp: i },
    }))
  }

  describe('createChatViewStateBuffer 连续 feed ≡ reduce(applyEntry) 元断言', () => {
    it('混合全类型序列：全量 state deep-equal（messages/orphan/delivered/配对锚点）', () => {
      const viaBuffer = feedMixed()
      const viaReduce = mixedEntries().reduce(applyEntry, createInitialChatViewState())
      expect(viaBuffer.state).toEqual(viaReduce)
      // 用户可见内容非空检查（防两侧同归于空 / no-op 假等价）：user / assistant / 回填 /
      // 孤儿 / bash / 双形态压缩 / 分支 / 自定义通知各就各位
      expect(viaBuffer.state.messages.filter((m) => m.role === 'user')).toHaveLength(1)
      expect(viaBuffer.state.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
      expect(viaBuffer.state.messages.find((m) => m.toolCalls?.some((t) => t.id === 'tc-1'))?.toolCalls?.[0]?.output).toBe('out')
      expect(viaBuffer.state.orphanToolResults).toHaveLength(1)
      expect(viaBuffer.state.messages.filter((m) => m.bashExecution !== undefined)).toHaveLength(1)
      expect(viaBuffer.state.messages.filter((m) => m.compactionSummary !== undefined)).toHaveLength(2)
      expect(viaBuffer.state.messages.filter((m) => m.branchSummary !== undefined)).toHaveLength(1)
      expect(viaBuffer.state.messages.filter((m) => m.customType === 'goal-context')).toHaveLength(1)
      // custom（client-msg-id）纯数据 entry：两路径同为 no-op（零对话流派生视图）
      expect(viaBuffer.state.messages.every((m) => m.customType !== 'taiji.client-msg-id')).toBe(true)
      // 幂等簿记：同 id 双投递收敛单投递（deliveredToolResultIds 两路径同构）
      expect(viaBuffer.state.deliveredToolResultIds).toEqual(new Set(['tc-1', 'tc-none']))
      expect(viaBuffer.state.lastAssistantWithToolCalls).toBe(1)
    })

    it('幂等双喂：同 toolResult 两帧（tool_call_end + message_end 权威帧）在活容器上收敛单投递', () => {
      // pi 时序：tool_execution_end 重构帧先到（hook 改写内容），message_end 权威帧后到
      //（endTime last-wins——commitToolResultMessage 去重命中分支的放行语义）
      const tEnd = msgEntry('e-tend', { role: 'toolResult', toolCallId: 'tc-dup', toolName: 'bash', content: [{ type: 'text', text: 'rewritten' }], timestamp: 300 }, { timestamp: ISO(300) })
      const mEnd = { type: 'message', parentId: null, timestamp: ISO(310), message: { role: 'toolResult', toolCallId: 'tc-dup', toolName: 'bash', content: [{ type: 'text', text: 'rewritten' }], timestamp: 310 } } as unknown as PiEntry
      const buf = createChatViewStateBuffer()
      buf.feed(msgEntry('e-asst', { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-dup', name: 'bash', arguments: {} }], timestamp: 200 }, { timestamp: ISO(200) }))
      buf.feed(tEnd)
      buf.feed(mEnd)
      const viaReduce = [msgEntry('e-asst', { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-dup', name: 'bash', arguments: {} }], timestamp: 200 }, { timestamp: ISO(200) }), tEnd, mEnd].reduce(applyEntry, createInitialChatViewState())
      expect(buf.state).toEqual(viaReduce)
      // 回填只发生一次（首条版本保留），且无孤儿残留（双喂不重复收集）
      expect(buf.state.messages).toHaveLength(1)
      expect(buf.state.orphanToolResults).toHaveLength(0)
      expect(buf.state.deliveredToolResultIds).toEqual(new Set(['tc-dup']))
    })

    it('输入纯度：feed 不 mutate 外部传入的 entry 对象', () => {
      // buffer 自身容器可变（活容器形态），纯度断言对象 = 输入 entry：deep-clone 对照前后
      const entries = mixedEntries()
      const snapshot = structuredClone(entries)
      feedMixed()
      expect(entries).toEqual(snapshot)
    })

    it('snapshot() 是低频浅拷贝：快照不随后续 feed 漂移；state 活引用继续累积', () => {
      const buf = createChatViewStateBuffer()
      buf.feed(msgEntry('e-1', { role: 'user', content: [{ type: 'text', text: 'first' }], timestamp: 1 }, { timestamp: ISO(1) }))
      const snap = buf.snapshot()
      expect(snap.messages).toHaveLength(1)
      // 后续 feed：快照冻结在拍下时刻，活容器继续累积
      buf.feed(msgEntry('e-2', { role: 'user', content: [{ type: 'text', text: 'second' }], timestamp: 2 }, { timestamp: ISO(2) }))
      expect(snap.messages).toHaveLength(1)
      expect(buf.state.messages).toHaveLength(2)
      // snapshot 与拍快照时刻的 reducer 产物同构；容器引用不同（浅拷贝义务）
      expect(snap).toEqual([msgEntry('e-1', { role: 'user', content: [{ type: 'text', text: 'first' }], timestamp: 1 }, { timestamp: ISO(1) })].reduce(applyEntry, createInitialChatViewState()))
      expect(snap.messages).not.toBe(buf.state.messages)
      // snapshot 不 mutate buffer 自身（快照后 feed 幂等性不受影响）
      expect(buf.state).toEqual([msgEntry('e-1', { role: 'user', content: [{ type: 'text', text: 'first' }], timestamp: 1 }, { timestamp: ISO(1) }), msgEntry('e-2', { role: 'user', content: [{ type: 'text', text: 'second' }], timestamp: 2 }, { timestamp: ISO(2) })].reduce(applyEntry, createInitialChatViewState()))
    })

    it('空序列：createChatViewStateBuffer 不 feed ≡ 初始态；实例间容器独立', () => {
      const a = createChatViewStateBuffer()
      const b = createChatViewStateBuffer()
      expect(a.state).toEqual(createInitialChatViewState())
      // 实例隔离：feed 一侧不影响另一侧（store per-session 分区的构造性前提）
      a.feed(msgEntry('e-a', { role: 'user', content: [{ type: 'text', text: 'a' }], timestamp: 1 }, { timestamp: ISO(1) }))
      expect(b.state.messages).toHaveLength(0)
      expect(a.state.messages).toHaveLength(1)
    })

    it('长序列（500 条无 id user entry）：id e0..e499 确定性唯一，buffer feed 与 reduce 产物全等', () => {
      const entries = idLessEntries(500)
      const buf = createChatViewStateBuffer()
      for (const entry of entries) buf.feed(entry)
      const viaReduce = entries.reduce(applyEntry, createInitialChatViewState())
      expect(buf.state).toEqual(viaReduce)
      expect(buf.state.messages).toHaveLength(500)
      expect(buf.state.messages[0]?.id).toBe('e0')
      expect(buf.state.messages[499]?.id).toBe('e499')
      expect(new Set(buf.state.messages.map((m) => m.id))).toHaveLength(500)
    })

    it('无 id 边界微用例（0/1/2 条）：id 自 e0 起连续派生，buffer feed 与 reduce 产物全等', () => {
      for (const n of [0, 1, 2]) {
        const entries = idLessEntries(n)
        const buf = createChatViewStateBuffer()
        for (const entry of entries) buf.feed(entry)
        const viaReduce = entries.reduce(applyEntry, createInitialChatViewState())
        expect(buf.state, `n=${n}`).toEqual(viaReduce)
        expect(buf.state.messages, `n=${n}`).toHaveLength(n)
        expectDerivedIdSequence(buf.state.messages, n)
      }
    })

    it('initial 接续：非空 initial 的 buffer feed ≡ 逐条 reduce(applyEntry, initial)', () => {
      const head = mixedEntries().reduce(applyEntry, createInitialChatViewState())
      const more: PiEntry[] = [
        msgEntry('e-tail-1', { role: 'user', content: [{ type: 'text', text: '续' }], timestamp: 9000 }, { timestamp: ISO(9000) }),
        msgEntry('e-tail-2', { role: 'toolResult', toolCallId: 'tc-2', toolName: 'read', content: [{ type: 'text', text: 'late' }], timestamp: 9100 }, { timestamp: ISO(9100) }),
      ]
      const headSnapshot = structuredClone(head)
      const buf = createChatViewStateBuffer(head)
      for (const entry of more) buf.feed(entry)
      const viaReduce = more.reduce(applyEntry, head)
      expect(buf.state).toEqual(viaReduce)
      // 回填落在 head 段 assistant 的 tc-2 上（窗口配对锚点跨 initial 边界仍生效）
      const tc2 = buf.state.messages
        .find((m) => m.toolCalls?.some((t) => t.id === 'tc-2'))
        ?.toolCalls?.find((t) => t.id === 'tc-2')
      expect(tc2?.output).toBe('late')
      expect(head).toEqual(headSnapshot) // initial 不被 buffer 构造/feed mutate
      // 三方收敛：buffer ≡ mutable fold ≡ copy-on-write reduce
      expect(buf.state).toEqual(replayEntries(more, structuredClone(headSnapshot)))
    })
  })
});

// ======== 来源：apply-entry-convert.test.ts ========
describe("apply-entry-convert", () => {
  // ── 测试数据工厂（同 apply-entry.test.ts 惯例：ISO timestamp / uuid 风格 id；
  //    msgEntry 构造收敛到 helpers/fixtures.ts 单源——本文件原默认 timestamp
  //    '2026-09-13' 未被任何调用触达，全部调用显式传 overrides）──────────

  const ISO = (ms: number): string => new Date(ms).toISOString()

  /** 带 toolCall 的 assistant entry（startTime 来源 = body.timestamp）。 */
  function assistantWithToolCall(id: string, tcId: string, ts: number): PiMessageEntry {
    return msgEntry(id, {
      role: 'assistant',
      content: [{ type: 'toolCall', id: tcId, name: 'bash', arguments: { command: 'ls' } }],
      timestamp: ts,
    }, { timestamp: ISO(ts) })
  }

  /** toolResult entry（endTime 来源 = body.timestamp）。 */
  function toolResultEntry(id: string, tcId: string, ts: number | undefined, extra?: Record<string, unknown>): PiMessageEntry {
    return msgEntry(id, {
      role: 'toolResult',
      toolCallId: tcId,
      toolName: 'bash',
      content: [{ type: 'text', text: 'done' }],
      ...(ts !== undefined ? { timestamp: ts } : {}),
      ...extra,
    }, { timestamp: ISO(ts ?? 0) })
  }

  describe('computeToolCallFill：endTime 回填源（chat-flow-timestamp U1 验收①）', () => {
    it('body.timestamp 为 number → endTime 返回该值', () => {
      const fill = computeToolCallFill({
        role: 'toolResult', toolCallId: 'tc1', toolName: 'bash',
        content: [{ type: 'text', text: 'ok' }], timestamp: 5432,
      })
      expect(fill.endTime).toBe(5432)
    })

    it('body.timestamp 缺失 → 不设 endTime 字段（条件 spread，无 undefined 噪声）', () => {
      const fill = computeToolCallFill({
        role: 'toolResult', toolCallId: 'tc1', toolName: 'bash',
        content: [{ type: 'text', text: 'ok' }],
      })
      expect('endTime' in fill).toBe(false)
    })

    it('body.timestamp 非 number（JSONL 宽形态防御，同 usageField 模式）→ 不设 endTime', () => {
      // PiMessageBody.timestamp 类型收窄为 number，真实磁盘数据是宽形态（外部系统不信任原则）
      const malformed = {
        role: 'toolResult', toolCallId: 'tc1', toolName: 'bash',
        content: [{ type: 'text', text: 'ok' }], timestamp: '2026-09-13T10:00:00.000Z',
      } as unknown as Parameters<typeof computeToolCallFill>[0]
      const fill = computeToolCallFill(malformed)
      expect('endTime' in fill).toBe(false)
    })
  })

  describe('reload 路径 toolCall.endTime 回填（chat-flow-timestamp U1 验收② / 设计 A5）', () => {
    it('replayEntries：toolCall.endTime === toolResult body.timestamp，startTime 不受影响', () => {
      const state = replayEntries([
        assistantWithToolCall('e-asst', 'tc-x', 1000),
        toolResultEntry('e-tr', 'tc-x', 5432),
      ])
      expect(state.messages).toHaveLength(1)
      const tc = state.messages[0]!.toolCalls![0]!
      expect(tc.id).toBe('tc-x')
      expect(tc.startTime).toBe(1000) // assistant body.timestamp（既有语义不变）
      expect(tc.endTime).toBe(5432) // toolResult body.timestamp（本次回填）
    })

    it('toolResult 缺 timestamp → 回填后 toolCall 不带 endTime 字段（running/end_not_received 缺口语义）', () => {
      const state = replayEntries([
        assistantWithToolCall('e-asst', 'tc-x', 1000),
        toolResultEntry('e-tr', 'tc-x', undefined),
      ])
      const tc = state.messages[0]!.toolCalls![0]!
      expect('endTime' in tc).toBe(false)
    })

    it('applyEntry 单条路径（live 帧入口）：copy-on-write —— 原 state 的 toolCall 对象不被 mutate', () => {
      const base = replayEntries([assistantWithToolCall('e-asst', 'tc-x', 1000)])
      const originalTc = base.messages[0]!.toolCalls![0]!
      const next = applyEntry(base, toolResultEntry('e-tr', 'tc-x', 5432))

      // 新 state 回填完成
      expect(next.messages[0]!.toolCalls![0]!.endTime).toBe(5432)
      // 原 state 引用与值均不变（copy-on-write：产物是新副本，输入零污染）
      expect(base.messages[0]!.toolCalls![0]!).toBe(originalTc)
      expect(originalTc.endTime).toBeUndefined()
      // entry 输入不被 mutate
      const trBody = toolResultEntry('e-tr-2', 'tc-x', 9999).message
      expect('endTime' in trBody).toBe(false)
    })

    it('R2-S1 双入口幂等（U3 后）：内容首条 wins，endTime last-wins（第二帧覆盖为权威值）', () => {
      const first = applyEntry(
        replayEntries([assistantWithToolCall('e-asst', 'tc-x', 1000)]),
        toolResultEntry('e-tr-1', 'tc-x', 5432),
      )
      expect(first.messages[0]!.toolCalls![0]!.endTime).toBe(5432)
      expect(first.messages[0]!.toolCalls![0]!.output).toBe('done')

      // 第二条帧（message_end 载体，pi 权威 timestamp）：内容仍保留首条（R2-S1），
      // endTime 被覆盖为第二帧权威值（U3 last-wins——live 客户端时钟被 pi 时刻修正）
      const second = applyEntry(first, toolResultEntry('e-tr-2', 'tc-x', 7777))
      const tc2 = second.messages[0]!.toolCalls![0]!
      expect(tc2.endTime).toBe(7777)
      expect(tc2.output).toBe('done')
    })

    it('去重命中但第二帧无 timestamp → endTime 保持首条值（检查不误清）', () => {
      const first = applyEntry(
        replayEntries([assistantWithToolCall('e-asst', 'tc-x', 1000)]),
        toolResultEntry('e-tr-1', 'tc-x', 5432),
      )
      const second = applyEntry(first, toolResultEntry('e-tr-2', 'tc-x', undefined))
      expect(second.messages[0]!.toolCalls![0]!.endTime).toBe(5432)
    })

    it('孤儿 toolResult（带 timestamp）：不崩，收集为 orphan，不产消息不回填', () => {
      const state = replayEntries([
        toolResultEntry('e-tr-orphan', 'tc-none', 5432),
      ])
      expect(state.messages).toHaveLength(0)
      expect(state.orphanToolResults).toHaveLength(1)
      expect(state.orphanToolResults[0]!.toolCallId).toBe('tc-none')
      expect(state.orphanToolResults[0]!.timestamp).toBe(5432)
    })

    it('同 assistant 多 toolCall 只回填匹配 id（其余 toolCall 不带 endTime）', () => {
      const state = replayEntries([
        msgEntry('e-asst', {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tc-a', name: 'bash', arguments: {} },
            { type: 'toolCall', id: 'tc-b', name: 'read', arguments: {} },
          ],
          timestamp: 1000,
        }, { timestamp: ISO(1000) }),
        toolResultEntry('e-tr', 'tc-a', 5432),
      ])
      const [tcA, tcB] = state.messages[0]!.toolCalls!
      expect(tcA.endTime).toBe(5432)
      expect('endTime' in tcB).toBe(false)
      expect(tcB.status).toBe('completed')
    })
  })

  describe('确定性：endTime 派生自 entry 数据，无 Date.now() 渗入（reducer 纯度契约）', () => {
    it('同序列两次喂入 endTime 全等', () => {
      const entries: PiEntry[] = [
        assistantWithToolCall('e-asst', 'tc-x', 1000),
        toolResultEntry('e-tr', 'tc-x', 5432),
      ]
      const a = replayEntries(entries)
      const b = replayEntries(entries)
      expect(a.messages[0]!.toolCalls![0]!.endTime).toBe(b.messages[0]!.toolCalls![0]!.endTime)
      expect(a.messages[0]!.toolCalls![0]!.endTime).toBe(5432)
    })

    it('createInitialChatViewState 起点下 orphan 分支同序列确定性', () => {
      const entry = toolResultEntry('e-tr-orphan', 'tc-none', 5432)
      const s1 = applyEntry(createInitialChatViewState(), entry)
      const s2 = applyEntry(createInitialChatViewState(), entry)
      expect(s1.orphanToolResults).toEqual(s2.orphanToolResults)
    })
  })

  // ── [diff-stat-chip] edit 工具 details.diff → diffStat（ToolCall 新字段，live≡reload 同口径）──
  //
  // pi edit 工具 result.details = { diff, patch, firstChangedLine }（pi dist edit.js），diff 行
  // 格式（edit-diff.js generateDiffString）：变更行 `+<行号> <内容>` / `-<行号> <内容>`，
  // 上下文行与省略标记以空格开头。write 工具 details 恒 undefined → diffStat 缺省不渲染。

  const EDIT_DIFF = [
    '+ 3 const b = 2',
    '  1 const a = 1',
    '- 2 const b = old',
    '       ...',
    '+ 5 const c = 3',
  ].join('\n')

  describe('parseDiffStat：pi edit diff 行格式统计', () => {
    it('行首 +/- 计数（上下文行与省略标记以空格开头，不计入）', () => {
      expect(parseDiffStat(EDIT_DIFF)).toEqual({ additions: 2, deletions: 1 })
    })

    it('非字符串（write 工具 details 恒 undefined / 畸形数据）与空 diff → undefined', () => {
      expect(parseDiffStat(undefined)).toBeUndefined()
      expect(parseDiffStat(123)).toBeUndefined()
      expect(parseDiffStat('')).toBeUndefined()
    })
  })

  describe('computeToolCallFill：diffStat 派生', () => {
    it('edit details.diff → fill.diffStat 有值', () => {
      const fill = computeToolCallFill({
        role: 'toolResult', toolCallId: 'tc1', toolName: 'edit',
        content: [{ type: 'text', text: 'ok' }],
        details: { diff: EDIT_DIFF, patch: '---', firstChangedLine: 3 },
      })
      expect(fill.diffStat).toEqual({ additions: 2, deletions: 1 })
    })

    it('write（details 缺省）→ 不设 diffStat 字段（条件 spread，无 undefined 噪声）', () => {
      const fill = computeToolCallFill({
        role: 'toolResult', toolCallId: 'tc1', toolName: 'write',
        content: [{ type: 'text', text: 'ok' }],
      })
      expect('diffStat' in fill).toBe(false)
    })
  })

  describe('reload 路径 toolCall.diffStat 回填（reducer 路径，与 live overlay 同口径）', () => {
    it('replayEntries：edit toolResult entry details.diff → toolCall.diffStat 有值', () => {
      const state = replayEntries([
        msgEntry('e-asst', {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc-ed', name: 'edit', arguments: { path: '/a.ts' } }],
          timestamp: 1000,
        }, { timestamp: ISO(1000) }),
        toolResultEntry('e-tr', 'tc-ed', 5432, {
          details: { diff: EDIT_DIFF, patch: '---', firstChangedLine: 3 },
        }),
      ])
      expect(state.messages).toHaveLength(1)
      const tc = state.messages[0]!.toolCalls![0]!
      expect(tc.diffStat).toEqual({ additions: 2, deletions: 1 })
      expect(tc.details).toEqual({ diff: EDIT_DIFF, patch: '---', firstChangedLine: 3 })
    })

    it('write toolResult（无 details）→ toolCall 不带 diffStat 字段（缺省语义：不渲染统计段）', () => {
      const state = replayEntries([
        msgEntry('e-asst', {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc-wr', name: 'write', arguments: { path: '/a.ts' } }],
          timestamp: 1000,
        }, { timestamp: ISO(1000) }),
        toolResultEntry('e-tr', 'tc-wr', 5432),
      ])
      const tc = state.messages[0]!.toolCalls![0]!
      expect('diffStat' in tc).toBe(false)
    })
  })
});

// ======== 来源：apply-entry-fold-equivalence.test.ts ========
describe("apply-entry-fold-equivalence", () => {
  // ── fixture（msgEntry 构造收敛到 helpers/fixtures.ts 单源；混合全类型序列仍为本文件
  //    手写字面量——它承载 fold 维度的序列形态语义，不跨文件共享）──────────

  const ISO = (ms: number): string => new Date(ms).toISOString()

  /**
 * 混合全类型序列：custom（client-msg-id）/ user / assistant（toolCalls + 无 id → e<N>
 * 派生，两路径共用 deriveBaseId 的交叉检验）/ toolResult（回填 + 同 id 双投递幂等 + 孤儿）/
 * bashExecution / compactionSummary role / label（no-op）/ compaction / branch_summary /
 * custom_message / 未建模类型（default no-op）。
 */
  function mixedEntries(): PiEntry[] {
    return [
      { type: 'custom', id: 'c-1', parentId: null, timestamp: ISO(1), customType: 'taiji.client-msg-id', data: { clientUuid: 'u-1', userEntryId: 'e-user-1' } },
      msgEntry('e-user-1', { role: 'user', content: [{ type: 'text', text: '问题' }], timestamp: 100 }, { timestamp: ISO(100) }),
      { type: 'message', parentId: null, timestamp: ISO(200), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'ls' } }, { type: 'toolCall', id: 'tc-2', name: 'read', arguments: { path: '/x' } }], timestamp: 200 } },
      msgEntry('e-tr-1', { role: 'toolResult', toolCallId: 'tc-1', toolName: 'bash', content: [{ type: 'text', text: 'out' }], timestamp: 300 }, { timestamp: ISO(300) }),
      { type: 'message', parentId: null, timestamp: ISO(310), message: { role: 'toolResult', toolCallId: 'tc-1', toolName: 'bash', content: [{ type: 'text', text: 'out-dup-loses' }], timestamp: 310 } },
      msgEntry('e-tr-orphan', { role: 'toolResult', toolCallId: 'tc-none', toolName: 'read', content: [{ type: 'text', text: 'orphan' }], timestamp: 320 }, { timestamp: ISO(320) }),
      msgEntry('e-bash-1', { role: 'bashExecution', command: 'pwd', output: '/x', exitCode: 0, cancelled: false, truncated: false, timestamp: 400 }, { timestamp: ISO(400) }),
      msgEntry('e-cs-1', { role: 'compactionSummary', summary: '角色形态压缩', tokensBefore: 9, timestamp: 500 }, { timestamp: ISO(500) }),
      { type: 'label', id: 'l-1', parentId: null, timestamp: ISO(510), label: 'bookmark', targetId: 'e-user-1' },
      { type: 'compaction', id: 'cp-1', parentId: null, timestamp: ISO(600), summary: '专用形态压缩', firstKeptEntryId: 'e-user-1', tokensBefore: 50 },
      { type: 'branch_summary', id: 'br-1', parentId: null, timestamp: ISO(700), fromId: 'node-1', summary: '分支' },
      { type: 'custom_message', id: 'cmb-1', parentId: null, timestamp: ISO(800), customType: 'goal-context', content: '<goal_context>x</goal_context>', display: true, details: { k: 1 } },
      { type: 'model_change', id: 'mc-1', parentId: null, timestamp: ISO(810), provider: 'p', modelId: 'm' },
    ] as unknown as PiEntry[]
  }

  /** 无 id user entry 序列（`e<N>` 确定性 id 派生路径的载体；n 含 0/1/2 边界档） */
  function idLessEntries(n: number): PiEntry[] {
    return Array.from({ length: n }, (_, i) => ({
      type: 'message',
      parentId: null,
      timestamp: ISO(i),
      message: { role: 'user', content: [{ type: 'text', text: `m${i}` }], timestamp: i },
    }))
  }

  describe('replayEntries(mutable fold) ≡ reduce(applyEntry) 元断言', () => {
    it('混合全类型序列：全量 state deep-equal（messages/orphan/delivered/配对锚点）', () => {
      const entries = mixedEntries()
      const viaFold = replayEntries(entries)
      const viaReduce = entries.reduce(applyEntry, createInitialChatViewState())
      expect(viaFold).toEqual(viaReduce)
      // 用户可见内容非空检查（防两侧同归于空 / no-op 假等价）：user / assistant / 回填 /
      // 孤儿 / bash / 双形态压缩 / 分支 / 自定义通知各就各位
      expect(viaFold.messages.filter((m) => m.role === 'user')).toHaveLength(1)
      expect(viaFold.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
      expect(viaFold.messages.find((m) => m.toolCalls?.some((t) => t.id === 'tc-1'))?.toolCalls?.[0]?.output).toBe('out')
      expect(viaFold.orphanToolResults).toHaveLength(1)
      expect(viaFold.messages.filter((m) => m.bashExecution !== undefined)).toHaveLength(1)
      expect(viaFold.messages.filter((m) => m.compactionSummary !== undefined)).toHaveLength(2)
      expect(viaFold.messages.filter((m) => m.branchSummary !== undefined)).toHaveLength(1)
      expect(viaFold.messages.filter((m) => m.customType === 'goal-context')).toHaveLength(1)
      // custom（client-msg-id）纯数据 entry：两路径同为 no-op（零对话流派生视图，D6-4 死簿记已删）
      expect(viaFold.messages.every((m) => m.customType !== 'taiji.client-msg-id')).toBe(true)
      // 幂等簿记：同 id 双投递收敛单投递（deliveredToolResultIds 两路径同构）
      expect(viaFold.deliveredToolResultIds).toEqual(new Set(['tc-1', 'tc-none']))
      expect(viaFold.lastAssistantWithToolCalls).toBe(1)
    })

    it('确定性交叉：replay ≡ reduce ≡ replay（同序列重复喂入全等）', () => {
      const entries = mixedEntries()
      const a = replayEntries(entries)
      const b = entries.reduce(applyEntry, createInitialChatViewState())
      const c = replayEntries(entries)
      expect(a).toEqual(b)
      expect(a).toEqual(c)
    })

    it('输入纯度：entries 序列不被 mutable fold mutate', () => {
      const entries = mixedEntries()
      const snapshot = structuredClone(entries)
      replayEntries(entries)
      expect(entries).toEqual(snapshot)
    })

    it('输入纯度：initial（空/非空）不被 mutate，接续产物独立', () => {
      const initial = createInitialChatViewState()
      const tail = [
        msgEntry('e-seed', { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }, { timestamp: ISO(1) }),
      ]
      // 空 initial：fold 后 initial 深度不变
      const seeded = replayEntries(tail, initial)
      expect(initial).toEqual(createInitialChatViewState())
      expect(initial.messages).toHaveLength(0)
      expect(seeded.messages).toHaveLength(1)
      expect(seeded.messages).not.toBe(initial.messages)

      // 非空 initial 接续：replayEntries(tail, head) ≡ tail 逐条 reduce(applyEntry, head)
      const head = headState()
      const more = [
        msgEntry('e-tail-1', { role: 'user', content: [{ type: 'text', text: '续' }], timestamp: 9000 }, { timestamp: ISO(9000) }),
        msgEntry('e-tail-2', { role: 'toolResult', toolCallId: 'tc-2', toolName: 'read', content: [{ type: 'text', text: 'late' }], timestamp: 9100 }, { timestamp: ISO(9100) }),
      ]
      const headSnapshot = structuredClone(head)
      const viaFold = replayEntries(more, head)
      const viaReduce = more.reduce(applyEntry, head)
      expect(viaFold).toEqual(viaReduce)
      // 回填落在 head 段 assistant 的 tc-2 上（窗口配对锚点跨 initial 边界仍生效）
      const tc2 = viaFold.messages
        .find((m) => m.toolCalls?.some((t) => t.id === 'tc-2'))
        ?.toolCalls?.find((t) => t.id === 'tc-2')
      expect(tc2?.output).toBe('late')
      expect(head).toEqual(headSnapshot) // 非空 initial 也不被 mutate
    })

    it('空序列：replayEntries([]) ≡ 初始态', () => {
      expect(replayEntries([])).toEqual(createInitialChatViewState())
    })

    it('长序列（500 条无 id user entry）：id e0..e499 确定性唯一，fold 与 reduce 产物全等', () => {
      const entries = idLessEntries(500)
      const viaFold = replayEntries(entries)
      const viaReduce = entries.reduce(applyEntry, createInitialChatViewState())
      expect(viaFold).toEqual(viaReduce)
      expect(viaFold.messages).toHaveLength(500)
      expect(viaFold.messages[0]?.id).toBe('e0')
      expect(viaFold.messages[499]?.id).toBe('e499')
      expect(new Set(viaFold.messages.map((m) => m.id))).toHaveLength(500)
    })

    it('无 id 边界微用例（0/1/2 条）：id 自 e0 起连续派生，fold 与 reduce 产物全等', () => {
      for (const n of [0, 1, 2]) {
        const entries = idLessEntries(n)
        const viaFold = replayEntries(entries)
        const viaReduce = entries.reduce(applyEntry, createInitialChatViewState())
        expect(viaFold, `n=${n}`).toEqual(viaReduce)
        expect(viaFold.messages, `n=${n}`).toHaveLength(n)
        expectDerivedIdSequence(viaFold.messages, n)
      }
    })

    /** 头段序列的 reduce 终态（非空 initial 接续用例的基座） */
    function headState() {
      return mixedEntries().reduce(applyEntry, createInitialChatViewState())
    }
  })
});

// ======== 来源：apply-entry.test.ts ========
describe("apply-entry", () => {
  /**
 * [W5] 读取 spread 保字段的 images（shared.ToolCall/Message 暂无 images 类型声明，
 * 运行时窄化后读取——断言不裸 as）。形态：Array<{ data: string; mimeType: string }>。
 */
  function readImagesField(obj: object): Array<{ data: string; mimeType: string }> | undefined {
    const v = (obj as Record<string, unknown>).images
    if (!Array.isArray(v)) return undefined
    return v.map((x) => {
      const r = x as Record<string, unknown>
      return { data: String(r.data), mimeType: String(r.mimeType) }
    })
  }

  // ── 测试数据工厂（真实形态：ISO timestamp / parentId 链 / uuid 风格 id；
  //    msgEntry 构造收敛到 helpers/fixtures.ts 单源）──────────

  const ISO = (ms: number): string => new Date(ms).toISOString()

  describe('applyEntry —— entry 类型逐类型覆盖', () => {
    // ── message entry：user ──────────────────────────────────────────
    it('message/user：text → role user + Segment[] content + piEntryId 回填', () => {
      const state = replayEntries([
        msgEntry('e-user-1', { role: 'user', content: [{ type: 'text', text: '你好' }], timestamp: 1000 }, { timestamp: ISO(1000) }),
      ])
      expect(state.messages).toHaveLength(1)
      const m = state.messages[0]
      expect(m.role).toBe('user')
      expect(m.status).toBe('complete')
      expect(m.timestamp).toBe(1000)
      expect(m.content).toEqual([{ type: 'text', text: '你好' }])
      expect(m.piEntryId).toBe('e-user-1')
    })

    it('message/user：skill block 剖离为 skill segment + 余文 text segment', () => {
      const state = replayEntries([
        msgEntry('e-user-2', {
          role: 'user',
          content: [{ type: 'text', text: '<skill name="code-review" location="/abs/SKILL.md">body</skill>do it' }],
          timestamp: 1000,
        }),
      ])
      expect(state.messages[0].content).toEqual([
        { type: 'skill', name: 'code-review', location: '/abs/SKILL.md' },
        { type: 'text', text: 'do it' },
      ])
    })

    it('message/user：[簇 A2] defer flush 确认标记剥除——派生视图片段不含实现标记（live 帧 / reload 重放同点）', () => {
      // flush 提交文本尾附加 `<!--taiji:msg:<entry.id>-->`（user-delivery ①a 身份通道），pi 落盘
      // entry 带标记 → 派生视图层单点剥除：live reducer 喂入与重开 replay 同经 convertMessageBody
      // → 对话流不暴露标记，且剥后文本 = confirmDelivery overlay 文本（文本去重命中不双计）。
      const state = replayEntries([
        msgEntry('e-user-dm1', {
          role: 'user',
          content: [{ type: 'text', text: '排队消息正文\n<!--taiji:msg:3f2504e0-4f89-41d3-9a0c-0305e82c3301-->' }],
          timestamp: 1000,
        }),
      ])
      expect(state.messages[0].content).toEqual([{ type: 'text', text: '排队消息正文' }])
    })

    it('message/user：[簇 A2] skill 展开文本 + 尾部确认标记——标记剥除不破坏 skill block 剖离', () => {
      // 改写场景（skill-injector 展开拼接把标记推到文本尾）：剥标记与 skill 反解析的叠加
      const state = replayEntries([
        msgEntry('e-user-dm2', {
          role: 'user',
          content: [{ type: 'text', text: '<skill name="review" location="/abs/SKILL.md">body</skill>\n\n帮我审查\n<!--taiji:msg:3f2504e0-4f89-41d3-9a0c-0305e82c3301-->' }],
          timestamp: 1000,
        }),
      ])
      expect(state.messages[0].content).toEqual([
        { type: 'skill', name: 'review', location: '/abs/SKILL.md' },
        { type: 'text', text: '帮我审查' },
      ])
    })

    // ── 三形态反解析（D7 兜底通道，composer 多 skill 注入 u3；R4 剥块升级）──────────
    // 反解析 SSOT = apply-entry-convert parseSkillBlock（live 帧 / 历史重建 / 文件重放
    // 三链路共用）。形态① <taiji-skill-data> 剥块（R4 D11 末尾块协议，任意位置整块剔除）、
    // 形态② taiji 私有标记（本设计序列化产物）、形态③ 存量兼容（pi 原生 block +
    // <taiji-skills> 降级块，对应设计 D7-③，零改动）。
    it('message/user：taiji 私有标记混排中文正文——标记前后正文全保留为交错 segments（专防前置正文丢失回归）', () => {
      const state = replayEntries([
        msgEntry('e-user-mk1', {
          role: 'user',
          content: [{ type: 'text', text: '帮我<taiji-skill name="code-review" location="/abs/SKILL.md"/>审查这段代码' }],
          timestamp: 1000,
        }),
      ])
      expect(state.messages[0].content).toEqual([
        { type: 'text', text: '帮我' },
        { type: 'skill', name: 'code-review', location: '/abs/SKILL.md' },
        { type: 'text', text: '审查这段代码' },
      ])
    })

    it('message/user：taiji 多标记 + 首尾正文——全部还原且正文无丢失', () => {
      const state = replayEntries([
        msgEntry('e-user-mk2', {
          role: 'user',
          content: [{ type: 'text', text: '前置<taiji-skill name="a"/><taiji-skill name="b" location="/b/SKILL.md"/>后置' }],
          timestamp: 1000,
        }),
      ])
      expect(state.messages[0].content).toEqual([
        { type: 'text', text: '前置' },
        { type: 'skill', name: 'a' },
        { type: 'skill', name: 'b', location: '/b/SKILL.md' },
        { type: 'text', text: '后置' },
      ])
    })

    it('message/user：taiji 降级块夹正文——块整体还原为各 skill segment，块前后正文保留、指引行不作正文残留', () => {
      // 块形态 = buildSkillsFallbackBlock 产物（SSOT 构建 + 手写锚定格式双保险；指引行
      // C5 改英文）：
      // <taiji-skills>\n<标记行…/>\n</taiji-skills>\nUse the read tool to load the skill files above before continuing the task
      const state = replayEntries([
        msgEntry('e-user-mk3', {
          role: 'user',
          content: [{
            type: 'text',
            text: '正文开始\n<taiji-skills>\n<taiji-skill name="a" location="/a/SKILL.md"/>\n<taiji-skill name="b"/>\n</taiji-skills>\nUse the read tool to load the skill files above before continuing the task\n正文结束',
          }],
          timestamp: 1000,
        }),
      ])
      expect(state.messages[0].content).toEqual([
        { type: 'text', text: '正文开始\n' },
        { type: 'skill', name: 'a', location: '/a/SKILL.md' },
        { type: 'skill', name: 'b' },
        { type: 'text', text: '\n正文结束' },
      ])
    })

    it('message/user：空正文纯标记消息——产出纯 skill segment 无 text（u3 断言④）', () => {
      const state = replayEntries([
        msgEntry('e-user-mk4', {
          role: 'user',
          content: [{ type: 'text', text: '<taiji-skill name="solo" location="/s/SKILL.md"/>' }],
          timestamp: 1000,
        }),
      ])
      expect(state.messages[0].content).toEqual([{ type: 'skill', name: 'solo', location: '/s/SKILL.md' }])
    })

    it('message/user：存量 pi 原生格式回归等价（场景 4⑤）——block 前置 + \\n\\nargs 在后 → [skill, args-text]', () => {
      const state = replayEntries([
        msgEntry('e-user-pi1', {
          role: 'user',
          content: [{ type: 'text', text: '<skill name="code-review" location="/abs/SKILL.md">skill body</skill>\n\ndo the thing with args' }],
          timestamp: 1000,
        }),
      ])
      expect(state.messages[0].content).toEqual([
        { type: 'skill', name: 'code-review', location: '/abs/SKILL.md' },
        { type: 'text', text: 'do the thing with args' },
      ])
      // 无 args 纯 block：单 skill segment（升级前 match[3].trim() 空串不产 text 的等价形态）
      const solo = replayEntries([
        msgEntry('e-user-pi2', {
          role: 'user',
          content: [{ type: 'text', text: '<skill name="x">body</skill>' }],
          timestamp: 1000,
        }),
      ])
      expect(solo.messages[0].content).toEqual([{ type: 'skill', name: 'x' }])
    })

    it('message/user：pi block 前正文保留（升级前该场景正文直接丢，缺陷修复）', () => {
      const state = replayEntries([
        msgEntry('e-user-pi3', {
          role: 'user',
          content: [{ type: 'text', text: '看看这个<skill name="x">body</skill>\n\nargs 部分' }],
          timestamp: 1000,
        }),
      ])
      expect(state.messages[0].content).toEqual([
        { type: 'text', text: '看看这个' },
        { type: 'skill', name: 'x' },
        { type: 'text', text: 'args 部分' },
      ])
    })

    it('message/user：两形态同文优先级——taiji 标记与 pi block 共存时按位置交错全还原（顺序锁定）', () => {
      const state = replayEntries([
        msgEntry('e-user-mix', {
          role: 'user',
          content: [{ type: 'text', text: '前<taiji-skill name="a"/><skill name="b">body</skill>\n\nargs' }],
          timestamp: 1000,
        }),
      ])
      expect(state.messages[0].content).toEqual([
        { type: 'text', text: '前' },
        { type: 'skill', name: 'a' },
        { type: 'skill', name: 'b' },
        { type: 'text', text: 'args' },
      ])
      // 降级块优先级：块内嵌套标记由块整体消费，不二次命中（无重复 segment、无标记文本残留）
      const nested = replayEntries([
        msgEntry('e-user-mix2', {
          role: 'user',
          content: [{ type: 'text', text: '<taiji-skills>\n<taiji-skill name="a" location="/a/SKILL.md"/>\n</taiji-skills>\nUse the read tool to load the skill files above before continuing the task' }],
          timestamp: 1000,
        }),
      ])
      expect(nested.messages[0].content).toEqual([{ type: 'skill', name: 'a', location: '/a/SKILL.md' }])
    })

    // ── R4 三形态①剥块（<taiji-skill-data> 包裹块，D11 末尾块协议）─────────────────
    it('message/user：[R4 ①] 正常形态——正文标记 + 末尾块：标记还原 + 块全文零残留（D11 场景 1）', () => {
      // 块形态 = buildSkillDataBlockExpansions 产物锚定（手写格式双保险）：块内 <skill>
      // 全文是注入器产物，剥块整体丢弃——不还原 badge、不残留文本
      const state = replayEntries([
        msgEntry('e-user-data1', {
          role: 'user',
          content: [{
            type: 'text',
            text: '帮我 review 这段代码 <taiji-skill name="code-review-graph" location="/abs/SKILL.md"/>\n\n<taiji-skill-data>\n<skill name="code-review-graph" location="/abs/SKILL.md">\nReferences are relative to /abs.\n\n（SKILL.md 全文…）\n</skill>\n</taiji-skill-data>',
          }],
          timestamp: 1000,
        }),
      ])
      expect(state.messages[0].content).toEqual([
        { type: 'text', text: '帮我 review 这段代码 ' },
        { type: 'skill', name: 'code-review-graph', location: '/abs/SKILL.md' },
        // 块与正文间的分隔空白属块外正文，逐字保留（「块外正文全部保留」）
        { type: 'text', text: '\n\n' },
      ])
    })

    it('message/user：[R4 ①] 块任意位置——中段/开头剥块，块外正文全部保留（防御 hook 改写挪位）', () => {
      // 中段：块夹在两段正文之间，前后正文零丢失
      const middle = replayEntries([
        msgEntry('e-user-data2', {
          role: 'user',
          content: [{
            type: 'text',
            text: '开头正文\n<taiji-skill-data>\n<skill name="x" location="/x/SKILL.md">\n（全文）\n</skill>\n</taiji-skill-data>\n结尾正文',
          }],
          timestamp: 1000,
        }),
      ])
      expect(middle.messages[0].content).toEqual([{ type: 'text', text: '开头正文\n\n结尾正文' }])
      // 开头：块前置 + 正文标记在后，剥块后标记照常还原
      const head = replayEntries([
        msgEntry('e-user-data3', {
          role: 'user',
          content: [{
            type: 'text',
            text: '<taiji-skill-data>\n<skill name="x" location="/x/SKILL.md">\n（全文）\n</skill>\n</taiji-skill-data>\n\n看这个 <taiji-skill name="a" location="/a/SKILL.md"/>',
          }],
          timestamp: 1000,
        }),
      ])
      expect(head.messages[0].content).toEqual([
        { type: 'text', text: '\n\n看这个 ' },
        { type: 'skill', name: 'a', location: '/a/SKILL.md' },
      ])
    })

    it('message/user：[R4 ①] 块内含 <taiji-skill> 字样——随块整体丢弃不误还原（清单标记/块内 <skill> 均零还原）', () => {
      const state = replayEntries([
        msgEntry('e-user-data4', {
          role: 'user',
          content: [{
            type: 'text',
            text: '正文 <taiji-skill name="body-marker" location="/b/SKILL.md"/>\n\n<taiji-skill-data>\n<taiji-skill name="in-block" location="/i/SKILL.md"/>\n<skill name="also-in-block" location="/s/SKILL.md">\n（全文）\n</skill>\nUse the read tool to load the skill files above before continuing the task\n</taiji-skill-data>',
          }],
          timestamp: 1000,
        }),
      ])
      // 仅正文标记还原；块内标记清单（in-block）与块内 <skill> 全文（also-in-block）
      // 随块丢弃——零还原零残留
      expect(state.messages[0].content).toEqual([
        { type: 'text', text: '正文 ' },
        { type: 'skill', name: 'body-marker', location: '/b/SKILL.md' },
        { type: 'text', text: '\n\n' },
      ])
    })

    it('message/user：[R4 ①→②] 降级形态——剥 <taiji-skill-data> 块后正文标记仍还原为 badge（D11 场景 2）', () => {
      // R4 降级形态 = buildSkillDataBlockFallback 产物锚定：块内标记清单 + 块内指引行
      //（与存量 <taiji-skills> 块外指引行形态不同）；正文占位标记原样保留，剥块后标记
      // 还原链路（形态②）不受影响
      const state = replayEntries([
        msgEntry('e-user-data5', {
          role: 'user',
          content: [{
            type: 'text',
            text: '帮我 review <taiji-skill name="a" location="/a/SKILL.md"/>\n\n<taiji-skill-data>\n<taiji-skill name="a" location="/a/SKILL.md"/>\nUse the read tool to load the skill files above before continuing the task\n</taiji-skill-data>',
          }],
          timestamp: 1000,
        }),
      ])
      expect(state.messages[0].content).toEqual([
        { type: 'text', text: '帮我 review ' },
        { type: 'skill', name: 'a', location: '/a/SKILL.md' },
        { type: 'text', text: '\n\n' },
      ])
    })

    it('message/user：[R4 ①] 纯块消息（无正文标记）——剥后无命中不回退原始文本，块全文零泄漏', () => {
      const state = replayEntries([
        msgEntry('e-user-data6', {
          role: 'user',
          content: [{
            type: 'text',
            text: '<taiji-skill-data>\n<skill name="only" location="/o/SKILL.md">\n（整块全文）\n</skill>\n</taiji-skill-data>',
          }],
          timestamp: 1000,
        }),
      ])
      // 关键防线：剥过块后不得返回 null（否则调用方回退 textToSegments 原文 = 全文泄漏
      // 进显示层）；剥后正文为空串 → 空 Segment[]（空串不产 text segment 同款约定）
      expect(state.messages[0].content).toEqual([])
    })

    it('message/user：[R4] defer 确认标记 + 末尾块组合（live 真实落盘形态）——两段剥除叠加正文零残留', () => {
      // D11 落盘末尾性依赖：useChat 先追加 <!--taiji:msg:u-…--> 注释、注入块拼接在注释后
      // ——剥 defer 标记（convertMessageBody 单点）与剥块（parseSkillBlock ①）叠加后
      // 标记与块均不可见
      const state = replayEntries([
        msgEntry('e-user-data7', {
          role: 'user',
          content: [{
            type: 'text',
            text: '正文标记 <taiji-skill name="a" location="/a/SKILL.md"/>\n<!--taiji:msg:3f2504e0-4f89-41d3-9a0c-0305e82c3301-->\n\n<taiji-skill-data>\n<skill name="a" location="/a/SKILL.md">\n（全文）\n</skill>\n</taiji-skill-data>',
          }],
          timestamp: 1000,
        }),
      ])
      expect(state.messages[0].content).toEqual([
        { type: 'text', text: '正文标记 ' },
        { type: 'skill', name: 'a', location: '/a/SKILL.md' },
        // 注释剥除前后各一行换行 + 块前空行分隔 = 三个换行，属块外正文保留
        { type: 'text', text: '\n\n\n' },
      ])
    })

    it('message/user：手打残缺/错序标记不还原（D8 透传语义——反解析不宽松）', () => {
      const state = replayEntries([
        msgEntry('e-user-broken', {
          role: 'user',
          content: [{ type: 'text', text: '正文 <taiji-skill name="a" 讨论标记语法' }],
          timestamp: 1000,
        }),
      ])
      // 无命中 → 整条消息纯 text（textToSegments 回退，与升级前行为一致）
      expect(state.messages[0].content).toEqual([{ type: 'text', text: '正文 <taiji-skill name="a" 讨论标记语法' }])
      // 属性顺序错乱（location 在前）不识别——u1 解析器固定 name → location 顺序
      const wrongOrder = replayEntries([
        msgEntry('e-user-broken2', {
          role: 'user',
          content: [{ type: 'text', text: '<taiji-skill location="/x" name="a"/>' }],
          timestamp: 1000,
        }),
      ])
      expect(wrongOrder.messages[0].content).toEqual([{ type: 'text', text: '<taiji-skill location="/x" name="a"/>' }])
    })

    it('message/user：content 含 image part → images 保字段不丢（W5，pi UserMessage content 可含 ImageContent）', () => {
      const state = replayEntries([
        msgEntry('e-user-img', {
          role: 'user',
          content: [
            { type: 'text', text: '看这张图' },
            { type: 'image', data: 'YmFzZTY0', mimeType: 'image/jpeg' },
            { type: 'image', data: '', mimeType: '' }, // 双空块过滤
          ],
          timestamp: 1000,
        }),
      ])
      expect(state.messages).toHaveLength(1)
      const m = state.messages[0]
      // text part 正常转 Segment（image 不混入文本）
      expect(m.content).toEqual([{ type: 'text', text: '看这张图' }])
      // image part → images 运行时字段（shared.Message 暂无类型声明，spread 保字段）
      expect(readImagesField(m)).toEqual([{ data: 'YmFzZTY0', mimeType: 'image/jpeg' }])
    })

    it('message/user：无 image part → 不设 images 字段（既有消息形态不变）', () => {
      const state = replayEntries([
        msgEntry('e-user-plain', { role: 'user', content: [{ type: 'text', text: '纯文本' }], timestamp: 1000 }),
      ])
      expect(readImagesField(state.messages[0])).toBeUndefined()
      expect('images' in state.messages[0]).toBe(false)
    })

    // ── message entry：assistant ─────────────────────────────────────
    it('message/assistant：thinking+toolCall+text parts → contentBlocks 顺序 / toolCalls / usage / fileChanges', () => {
      const state = replayEntries([
        msgEntry('e-asst-1', {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先思考' },
            { type: 'toolCall', id: 'tc-1', name: 'write', arguments: { path: '/a.ts' } },
            { type: 'toolCall', id: 'tc-2', name: 'edit', arguments: { file_path: '/b.ts' } },
            { type: 'text', text: '结论' },
          ],
          usage: { input: 120, output: 80 },
          timestamp: 2000,
        }),
      ])
      const m = state.messages[0]
      expect(m.role).toBe('assistant')
      expect(m.content).toBe('结论')
      expect(m.thinking).toEqual([{ id: 'e-asst-1-th0', content: '先思考', collapsed: true }])
      expect(m.contentBlocks?.map((b) => b.type)).toEqual(['thinking', 'toolCall', 'toolCall', 'text'])
      expect(m.contentBlocks?.[1]).toEqual({ type: 'toolCall', refId: 'tc-1', contentIndex: 1 })
      expect(m.toolCalls).toEqual([
        { id: 'tc-1', toolName: 'write', input: { path: '/a.ts' }, status: 'completed', startTime: 2000 },
        { id: 'tc-2', toolName: 'edit', input: { file_path: '/b.ts' }, status: 'completed', startTime: 2000 },
      ])
      expect(m.usage).toEqual({ inputTokens: 120, outputTokens: 80 })
      // write/edit 静态提取（历史无 cwd：一律 modified）
      expect(m.fileChanges).toEqual([
        { filePath: '/a.ts', status: 'modified' },
        { filePath: '/b.ts', status: 'modified' },
      ])
    })

    // ── message entry：toolResult ────────────────────────────────────
    it('message/toolResult：回填到 preceding assistant 的匹配 toolCall（output/outputRaw/isError/details）', () => {
      const state = replayEntries([
        msgEntry('e-asst-2', {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc-x', name: 'bash', arguments: { command: 'ls' } }],
          timestamp: 1000,
        }),
        msgEntry('e-tr-1', {
          role: 'toolResult',
          toolCallId: 'tc-x',
          toolName: 'bash',
          isError: true,
          content: [{ type: 'text', text: '\x1b[31mfailed\x1b[0m' }],
          details: { __gui__: { v: 1 } },
          timestamp: 2000,
        }),
      ])
      expect(state.messages).toHaveLength(1)
      const tc = state.messages[0].toolCalls![0]
      expect(tc.output).toBe('failed') // stripAnsi 版本
      expect(tc.outputRaw).toBe('\x1b[31mfailed\x1b[0m') // 原始 ANSI
      expect(tc.status).toBe('error')
      expect(tc.details).toEqual({ __gui__: { v: 1 } })
    })

    it('message/toolResult：content 含 image 块 → 回填 images（W5 live≡replay，对齐 runtime 版语义）', () => {
      const state = replayEntries([
        msgEntry('e-asst-img', {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc-img', name: 'read', arguments: { path: 'a.png' } }],
          timestamp: 1000,
        }),
        msgEntry('e-tr-img', {
          role: 'toolResult',
          toolCallId: 'tc-img',
          toolName: 'read',
          content: [
            { type: 'text', text: 'screenshot' },
            { type: 'image', data: 'aWNn', mimeType: 'image/png' },
            { type: 'image', data: '', mimeType: '' }, // 双空块过滤（对齐 runtime 版）
          ],
          timestamp: 2000,
        }),
      ])
      expect(state.messages).toHaveLength(1)
      const tc = state.messages[0].toolCalls![0]
      // output 只含 text join（image 不混入文本，与 runtime normalizePiToolResult 逐字对齐）
      expect(tc.output).toBe('screenshot')
      expect(tc.status).toBe('completed')
      expect(readImagesField(tc)).toEqual([{ data: 'aWNn', mimeType: 'image/png' }])
    })

    it('message/toolResult：纯 text content → 不设 images 字段（既有回填形态不变）', () => {
      const state = replayEntries([
        msgEntry('e-asst-plain', {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc-plain', name: 'read', arguments: { path: 'x' } }],
          timestamp: 1000,
        }),
        msgEntry('e-tr-plain', {
          role: 'toolResult',
          toolCallId: 'tc-plain',
          toolName: 'read',
          content: [{ type: 'text', text: 'ok' }],
          timestamp: 2000,
        }),
      ])
      const tc = state.messages[0].toolCalls![0]
      expect(readImagesField(tc)).toBeUndefined()
      expect('images' in tc).toBe(false)
    })

    it('message/toolResult：窗口内无 preceding assistant → 收集为孤儿不产消息', () => {
      const state = replayEntries([
        msgEntry('e-tr-orphan', {
          role: 'toolResult',
          toolCallId: 'tc-none',
          toolName: 'read',
          content: [{ type: 'text', text: 'out' }],
          timestamp: 1000,
        }),
      ])
      expect(state.messages).toHaveLength(0)
      expect(state.orphanToolResults).toEqual([
        { role: 'toolResult', toolCallId: 'tc-none', toolName: 'read', content: [{ type: 'text', text: 'out' }], timestamp: 1000 },
      ])
    })

    // ── [R2-S1 双入口幂等] pi 0.84.1 对同一 toolResult 双发 tool_execution_end +
    // message_end{role:'toolResult'} 两事件 → 两条帧各喂 reducer 一次。deliveredToolResultIds
    // 簿记保证双喂入 ≡ 单喂入（第二条同 id 帧整体 no-op，保留首条版本）。
    it('message/toolResult：同 toolCallId 二次投递 no-op（幂等去重：不重放回填、孤儿不重复收集、保留首条版本）', () => {
      const base = [
        msgEntry('e-asst-dup', {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc-dup', name: 'read', arguments: { path: '/x' } }],
          timestamp: 1000,
        }),
      ]
      const first = applyEntry(
        replayEntries(base),
        msgEntry('e-tr-dup-1', {
          role: 'toolResult',
          toolCallId: 'tc-dup',
          toolName: 'read',
          content: [{ type: 'text', text: 'first-version' }],
          timestamp: 2000,
        }),
      )
      expect(first.messages[0].toolCalls![0].output).toBe('first-version')

      // 第二条同 id 帧（message_end 载体，内容版本不同）：内容不重放回填
      //（保留首条版本）；endTime 例外走 U3 last-wins（见下方断言）；簿记集合引用不变
      const messagesBefore = first.messages
      const deliveredBefore = first.deliveredToolResultIds
      const second = applyEntry(
        first,
        msgEntry('e-tr-dup-2', {
          role: 'toolResult',
          toolCallId: 'tc-dup',
          toolName: 'read',
          content: [{ type: 'text', text: 'second-version-loses' }],
          timestamp: 3000,
        }),
      )
      expect(second.messages[0].toolCalls![0].output).toBe('first-version')
      // [chat-flow-timestamp U3] endTime last-wins：第二帧（权威 pi 时刻）覆盖首条客户端时钟；
      // 其余字段保持首条。覆盖产新 message 引用（copy-on-write：输入零污染，其余元素保引用）
      expect(second.messages[0].toolCalls![0].endTime).toBe(3000)
      expect(second.messages).not.toBe(messagesBefore)
      expect(second.messages.length).toBe(messagesBefore.length)
      expect(second.deliveredToolResultIds).toBe(deliveredBefore)
      expect(second.orphanToolResults).toHaveLength(0)

      // 孤儿分支同款幂等：窗口内无匹配时首投收集孤儿，同 id 二投不再重复收集
      const orphanFirst = applyEntry(
        createInitialChatViewState(),
        msgEntry('e-tr-orphan-1', {
          role: 'toolResult',
          toolCallId: 'tc-orphan',
          toolName: 'read',
          content: [{ type: 'text', text: 'out' }],
          timestamp: 1000,
        }),
      )
      expect(orphanFirst.orphanToolResults).toHaveLength(1)
      const orphanSecond = applyEntry(
        orphanFirst,
        msgEntry('e-tr-orphan-2', {
          role: 'toolResult',
          toolCallId: 'tc-orphan',
          toolName: 'read',
          content: [{ type: 'text', text: 'out-again' }],
          timestamp: 2000,
        }),
      )
      expect(orphanSecond.orphanToolResults).toHaveLength(1)
      expect(orphanSecond.orphanToolResults[0].content).toEqual([{ type: 'text', text: 'out' }])
    })

    it('message/toolResult：无 toolCallId 的畸形 body 无键可去重——每次投递都收集为孤儿（原语义保留）', () => {
      const mkOrphan = (id: string) => msgEntry(id, {
        role: 'toolResult',
        toolName: 'read',
        content: [{ type: 'text', text: 'no-call-id' }],
        timestamp: 1000,
      })
      const state = replayEntries([mkOrphan('e-tr-noid-1'), mkOrphan('e-tr-noid-2')])
      // 无 toolCallId 不进 deliveredToolResultIds（无键可去重）→ 两条都收集，不静默丢数据
      expect(state.messages).toHaveLength(0)
      expect(state.orphanToolResults).toHaveLength(2)
      expect(state.deliveredToolResultIds.size).toBe(0)
    })

    // ── message entry：bashExecution role ────────────────────────────
    it('message/bashExecution：→ system 消息，bashExecution 字段完整映射，exitCode undefined → null', () => {
      const state = replayEntries([
        msgEntry('e-bash-1', {
          role: 'bashExecution',
          command: 'git status',
          output: 'clean',
          exitCode: 0,
          cancelled: false,
          truncated: false,
          excludeFromContext: true,
          fullOutputPath: '/tmp/full.log',
          timestamp: 3000,
        }),
        msgEntry('e-bash-2', {
          role: 'bashExecution',
          command: 'x',
          output: '',
          cancelled: true,
          truncated: false,
          timestamp: 3100,
        }),
      ])
      expect(state.messages).toHaveLength(2)
      const [b1, b2] = state.messages
      expect(b1.role).toBe('system')
      expect(b1.bashExecution).toEqual({
        command: 'git status',
        output: 'clean',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: true,
        timestamp: 3000,
        fullOutputPath: '/tmp/full.log',
      })
      expect(b2.bashExecution!.exitCode).toBeNull() // 防 JSON 丢值
      expect(b2.bashExecution!.cancelled).toBe(true)
      expect(b2.bashExecution!.excludeFromContext).toBe(false) // 缺失归一 false
    })

    // ── message entry：特殊 role（与专用 entry 类型双形态存储）──────────
    it('message/compactionSummary role：→ system 消息 + compactionSummary 字段', () => {
      const state = replayEntries([
        msgEntry('e-cs-1', { role: 'compactionSummary', summary: '压缩摘要', tokensBefore: 10000, timestamp: 123 }, { timestamp: ISO(123) }),
      ])
      const m = state.messages[0]
      expect(m.role).toBe('system')
      expect(m.content).toBe('压缩摘要')
      expect(m.compactionSummary).toEqual({ summary: '压缩摘要', tokensBefore: 10000, timestamp: 123 })
    })

    it('message/custom role：→ system 消息 + customType/details/display 透传（不覆写）', () => {
      const state = replayEntries([
        msgEntry('e-cm-1', {
          role: 'custom',
          customType: 'subagent-bg-notify',
          content: 'done',
          details: { id: 'job-1', status: 'done' },
          display: true,
          timestamp: 1000,
        }),
      ])
      const m = state.messages[0]
      expect(m.role).toBe('system')
      expect(m.customType).toBe('subagent-bg-notify')
      expect(m.details).toEqual({ id: 'job-1', status: 'done' })
      // message-role 形态不覆写 display（覆写归 custom_message entry case，mapSessionEntries 同规则）
      expect(m.display).toBe(true)
    })

    it('message/branchSummary role：→ system 消息 + branchSummary 字段', () => {
      const state = replayEntries([
        msgEntry('e-bs-1', { role: 'branchSummary', summary: '分支摘要', fromId: 'msg-abc', timestamp: 456 }, { timestamp: ISO(456) }),
      ])
      const m = state.messages[0]
      expect(m.role).toBe('system')
      expect(m.content).toBe('分支摘要')
      expect(m.branchSummary).toEqual({ summary: '分支摘要', fromId: 'msg-abc', timestamp: 456 })
    })

    // ── custom entry（纯数据，不进对话流）─────────────────────────────
    it('custom entry：纯数据不进对话流——零消息派生视图、no-op 返回原 state 引用', () => {
      const initial = createInitialChatViewState()
      const state = applyEntry(initial, {
        type: 'custom', id: 'c-1', parentId: null, timestamp: ISO(1), customType: 'taiji.client-msg-id', data: { clientUuid: 'u-1', userEntryId: 'e-user-1' },
      })
      expect(state).toBe(initial) // no-op：纯数据 entry 跳过（badge 回填走 runtime 自建 map，D6-4）
      expect(state.messages).toHaveLength(0)
    })

    it('custom entry：任意 customType / data 形状不匹配（缺字段/类型错）→ 跳过不崩溃', () => {
      const state = replayEntries([
        { type: 'custom', id: 'c-2', parentId: null, timestamp: ISO(2), customType: 'taiji.client-msg-id', data: { clientUuid: 123 } },
        { type: 'custom', id: 'c-3', parentId: null, timestamp: ISO(3), customType: 'other.extension', data: { foo: 'bar' } },
      ])
      expect(state.messages).toHaveLength(0)
    })

    // ── label entry ──────────────────────────────────────────────────
    it('label entry：显式 no-op——state 引用不变（不丢弃、不崩溃、不产消息）', () => {
      const initial = createInitialChatViewState()
      const afterUser = applyEntry(initial, msgEntry('e-l-1', { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }))
      const afterLabel = applyEntry(afterUser, {
        type: 'label', id: 'l-1', parentId: 'e-l-1', timestamp: ISO(2), label: 'bookmark', targetId: 'e-l-1',
      })
      expect(afterLabel).toBe(afterUser) // 同一引用：纯 no-op
      expect(afterLabel.messages).toHaveLength(1)
    })

    // ── compaction entry（专用形态）──────────────────────────────────
    it('compaction entry：→ system 消息 + compactionSummary 字段（可重开恢复，关键规则 9）', () => {
      const state = replayEntries([
        { type: 'compaction', id: 'cp-1', parentId: null, timestamp: ISO(777), summary: '压缩了', tokensBefore: 5000 },
      ])
      expect(state.messages).toHaveLength(1)
      const m = state.messages[0]
      expect(m.role).toBe('system')
      expect(m.content).toBe('压缩了')
      expect(m.compactionSummary).toEqual({ summary: '压缩了', tokensBefore: 5000, timestamp: 777 })
      expect(m.timestamp).toBe(777)
    })

    // ── branch_summary entry（专用形态）──────────────────────────────
    it('branch_summary entry：→ system 消息 + branchSummary 字段', () => {
      const state = replayEntries([
        { type: 'branch_summary', id: 'br-1', parentId: null, timestamp: ISO(888), fromId: 'node-9', summary: '分支摘要' },
      ])
      expect(state.messages).toHaveLength(1)
      const m = state.messages[0]
      expect(m.content).toBe('分支摘要')
      expect(m.branchSummary).toEqual({ summary: '分支摘要', fromId: 'node-9', timestamp: 888 })
    })

    // ── custom_message entry（专用形态）──────────────────────────────
    it('custom_message entry：→ system 消息 + customType/content/details/display', () => {
      const state = replayEntries([
        {
          type: 'custom_message', id: 'cmb-1', parentId: null, timestamp: ISO(999),
          customType: 'goal-context', content: '<goal_context>x</goal_context>', display: false, details: { k: 1 },
        },
      ])
      const m = state.messages[0]
      expect(m.role).toBe('system')
      expect(m.customType).toBe('goal-context')
      expect(m.content).toBe('<goal_context>x</goal_context>')
      expect(m.details).toEqual({ k: 1 })
      expect(m.display).toBe(false)
    })

    it('custom_message entry：完成通知类 customType（COMPLETE_NOTIFY_CUSTOM_TYPES）display 覆写 false', () => {
      const state = replayEntries([
        {
          type: 'custom_message', id: 'cmb-2', parentId: null, timestamp: ISO(1000),
          customType: 'subagent-bg-notify', content: 'done', display: true,
        },
        {
          type: 'custom_message', id: 'cmb-3', parentId: null, timestamp: ISO(1001),
          customType: 'managed-session-notify', content: 'session completed', display: true,
        },
      ])
      // pi 可能持久化 display:true，taiji 统一隐藏（mapSessionEntries 同 SSOT 规则）
      expect(state.messages[0].display).toBe(false)
      expect(state.messages[1].customType).toBe('managed-session-notify')
      expect(state.messages[1].display).toBe(false)
    })

    // ── 未建模 entry 类型（default no-op，规则 #9 不丢弃）──────────────
    it('未建模类型 thinking_level_change / model_change / session_info：no-op 不崩溃不产消息', () => {
      // 这三个类型不在 taiji 建模联合内（pi session-manager.ts SessionEntry 全集成员），
      // 通过结构形态直接喂入以覆盖 default 分支——reducer 对未建模类型静默跳过且不中断重放
      const unmodeled = [
        { type: 'thinking_level_change', id: 't1', parentId: null, timestamp: ISO(1), thinkingLevel: 'high' },
        { type: 'model_change', id: 't2', parentId: null, timestamp: ISO(2), provider: 'p', modelId: 'm' },
        { type: 'session_info', id: 't3', parentId: null, timestamp: ISO(3), name: 'n' },
        { type: 'future_unknown_type', id: 't4', parentId: null, timestamp: ISO(4) },
      ] as unknown as PiEntry[]
      const state = replayEntries(unmodeled)
      expect(state.messages).toHaveLength(0)
      expect(state).toEqual(createInitialChatViewState())
    })
  })

  describe('applyEntry —— 确定性（D5 纯函数断言）', () => {
    /** 混合真实形态序列：custom 映射 + user + assistant(toolCalls+usage) + toolResult 回填 + bash + compaction */
    function mixedSequence(): PiEntry[] {
      return [
        { type: 'custom', id: 'c-1', parentId: null, timestamp: ISO(1), customType: 'taiji.client-msg-id', data: { clientUuid: 'u-1', userEntryId: 'e-1' } },
        msgEntry('e-1', { role: 'user', content: [{ type: 'text', text: '问题' }], timestamp: 100 }, { timestamp: ISO(100) }),
        msgEntry('e-2', {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '推理' },
            { type: 'toolCall', id: 'tc-1', name: 'write', arguments: { path: '/x.ts' } },
            { type: 'toolCall', id: 'tc-2', name: 'read', arguments: { path: '/y.ts' } },
          ],
          usage: { input: 10, output: 5 },
          timestamp: 200,
        }, { parentId: 'e-1', timestamp: ISO(200) }),
        msgEntry('e-3', { role: 'toolResult', toolCallId: 'tc-1', toolName: 'write', content: [{ type: 'text', text: 'ok' }], timestamp: 300 }, { parentId: 'e-2', timestamp: ISO(300) }),
        msgEntry('e-4', { role: 'bashExecution', command: 'ls', output: 'a', exitCode: 0, cancelled: false, truncated: false, timestamp: 400 }, { parentId: 'e-3', timestamp: ISO(400) }),
        { type: 'compaction', id: 'e-5', parentId: 'e-4', timestamp: ISO(500), summary: 's', tokensBefore: 1 },
      ]
    }

    it('同 entry 序列两次喂入 → state 全等（messages/orphan 全部）', () => {
      const a = replayEntries(mixedSequence())
      const b = replayEntries(mixedSequence())
      expect(a).toEqual(b)
      // 消息 id 也是确定性的（entry 派生，非 randomUUID）——两次产出逐字相等
      expect(a.messages.map((m: Message) => m.id)).toEqual(b.messages.map((m: Message) => m.id))
    })

    it('applyEntry 不 mutate 输入 state（copy-on-write）', () => {
      const state = replayEntries(mixedSequence())
      const snapshot = structuredClone(state)
      // 在已含 toolCalls 的 state 上追加一条 toolResult（触发回填 copy-on-write 路径）。
      // [R2-S1] toolCallId 必须用未投递过的（'tc-2'）：同 id 二次投递已被
      // deliveredToolResultIds 幂等去重（no-op，不再走回填路径）。
      const next = applyEntry(state, msgEntry('e-6', { role: 'toolResult', toolCallId: 'tc-2', toolName: 'read', content: [{ type: 'text', text: 'again' }], timestamp: 600 }, { parentId: 'e-5', timestamp: ISO(600) }))
      expect(state).toEqual(snapshot) // 原 state 深度不变
      expect(next.messages[1].toolCalls![1].output).toBe('again') // 新 state 可见回填
    })

    it('无 entry.id 的 entry：确定性派生 id（两次相同）且 piEntryId 不回填', () => {
      const entry: PiMessageEntry = {
        type: 'message',
        parentId: null,
        timestamp: ISO(1000),
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1000 },
      }
      const a = replayEntries([entry])
      const b = replayEntries([entry])
      expect(a.messages[0].id).toBe('e0') // 下标派生
      expect(a.messages[0].piEntryId).toBeUndefined() // 无真实 entry id 不回填
      expect(a).toEqual(b)
    })
  })

  // ═══════════════════════════════════════════════════════════════
  // [u4d-truncated-ui] D3 push 截断占位文案的 reducer 归一（crash-resilience §3.3 D3/D4）
  // ═══════════════════════════════════════════════════════════════
  describe('applyEntry —— u4a push 截断占位 content 数组归一（需求④：正常渲染无特殊处理）', () => {
    const PLACEHOLDER = '内容过大（32.0 MB）已在传输层截断，完整内容见 session 文件：/tmp/s.jsonl'

    it('assistant 定稿 content 被截断为 [{type:text,text:占位}] → 归一为占位字符串（text 渲染链路直接可用）', () => {
      const state = replayEntries([
        msgEntry(
          'e-a-1',
          { role: 'assistant', content: [{ type: 'text', text: PLACEHOLDER }], timestamp: 1000 },
          { timestamp: ISO(1000) },
        ),
      ])
      expect(state.messages).toHaveLength(1)
      const m = state.messages[0]
      expect(m.role).toBe('assistant')
      // content 数组按既有宽形态归一走 text part 累积 → Message.content = 占位字符串
      expect(m.content).toBe(PLACEHOLDER)
    })

    it('user entry content 被截断为 [{type:text,text:占位}] → Segment[] 含占位 text 段（UserBubble 文本分支）', () => {
      const state = replayEntries([
        msgEntry('e-u-1', { role: 'user', content: [{ type: 'text', text: PLACEHOLDER }], timestamp: 1000 }, { timestamp: ISO(1000) }),
      ])
      const m = state.messages[0]
      expect(m.role).toBe('user')
      expect(m.content).toEqual([{ type: 'text', text: PLACEHOLDER }])
    })
  })
});

// ======== 来源：entry-truncate.test.ts ========
describe("entry-truncate", () => {
  const MARKER = '\n\n[...output truncated...]'

  /** 生成指定 UTF-8 字节长的测试串（'a' 单字节，精确控长）。 */
  function asciiOfBytes(n: number): string {
    return 'a'.repeat(n)
  }

  /** CJK 串（每字 3 UTF-8 字节），边界对齐断言用。 */
  function cjkOfChars(n: number): string {
    return '中'.repeat(n)
  }

  function toolResultEntry(toolCallId: string, text: string, toolName = 'mcp__srv__query'): PiMessageEntryShared {
    return {
      type: 'message',
      id: `entry-${toolCallId}`,
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: {
        role: 'toolResult',
        toolCallId,
        toolName,
        content: [{ type: 'text', text }],
        isError: false,
        timestamp: 0,
      },
    } as unknown as PiMessageEntryShared
  }

  describe('truncateEntryToolOutput（D6-⑧ 64KB 累积截断）', () => {
    it('≤64KB 原样返回（零拷贝语义：text 同引用、truncated=false）', () => {
      const text = asciiOfBytes(ENTRY_TOOL_OUTPUT_MAX_BYTES)
      const r = truncateEntryToolOutput(text)
      expect(r.truncated).toBe(false)
      expect(r.text).toBe(text)
    })

    it('>64KB 截断 + 尾部标记，含标记总字节 ≤ 64KB', () => {
      const text = asciiOfBytes(ENTRY_TOOL_OUTPUT_MAX_BYTES + 1)
      const r = truncateEntryToolOutput(text)
      expect(r.truncated).toBe(true)
      expect(r.text.endsWith(MARKER)).toBe(true)
      expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(ENTRY_TOOL_OUTPUT_MAX_BYTES)
      // 头部内容保留（截断体 = 原文头部 + 标记）
      expect(r.text.startsWith('a')).toBe(true)
    })

    it('UTF-8 codepoint 边界对齐：CJK 尾部不被切成半个字符（不产生乱码）', () => {
      // 65536 不是 3 的倍数 → naive 按字节切会切开 CJK；对齐后必须以完整字符结尾
      const text = cjkOfChars(30000) // 90000 字节 > 64KB
      const r = truncateEntryToolOutput(text)
      expect(r.truncated).toBe(true)
      const body = r.text.slice(0, r.text.length - MARKER.length)
      // 解码不抛错 + 尾字符完整（正则匹配合法 CJK 尾）
      expect(body.endsWith('中')).toBe(true)
    })
  })

  describe('computeToolCallFill 截断标记', () => {
    it('大 output 截断 + outputTruncated=true；带 ANSI 的 outputRaw 同步截断', () => {
      const raw = asciiOfBytes(ENTRY_TOOL_OUTPUT_MAX_BYTES + 100)
      // 带 ANSI：normalizePiToolResult 在 stripAnsi 改变文本时才产 outputRaw（含 ANSI 原文）
      const ansiText = `\x1b[31m${raw}\x1b[0m`
      // pi 持久化 content 数组形态（normalizePiToolResult 的 content-array 分支）
      const fill = computeToolCallFill({ role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: ansiText }], isError: false })
      expect(fill.outputTruncated).toBe(true)
      expect(fill.output.endsWith(MARKER)).toBe(true)
      expect(fill.outputRaw).toBeDefined()
      expect(fill.outputRaw!.endsWith(MARKER)).toBe(true)
      expect(fill.outputRaw).toContain('\x1b[31m')
    })

    it('小 output 不截断不标记', () => {
      const fill = computeToolCallFill({ role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: 'small' }], isError: false })
      expect(fill.outputTruncated).toBe(false)
      expect(fill.output).toBe('small')
    })
  })

  describe('live ≡ reload 截断层统一（D3 代价 C 根治）', () => {
    /** 带 64KB+ MCP 大结果的 entry 序列（assistant toolCall + toolResult 回填）。 */
    function makeEntries() {
      const bigOutput = asciiOfBytes(ENTRY_TOOL_OUTPUT_MAX_BYTES + 7)
      const assistantEntry: PiMessageEntryShared = {
        type: 'message',
        id: 'entry-asst',
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: {
          role: 'assistant',
          content: [{
            type: 'toolCall',
            id: 'tc-mcp-1',
            name: 'mcp__srv__query',
            arguments: { q: 'x' },
          }],
          timestamp: 0,
        },
      } as unknown as PiMessageEntryShared
      return { assistantEntry, resultEntry: toolResultEntry('tc-mcp-1', bigOutput), bigOutput }
    }

    it('reload（replayEntries）与 live（applyEntry 逐帧累积）产物 deep-equal，均为截断形态', () => {
      const { assistantEntry, resultEntry } = makeEntries()
      const reload = replayEntries([assistantEntry, resultEntry])
      // live = applyEntry 逐帧累积（store.applyEntryFrame 的纯函数内核）
      let live = createInitialChatViewState()
      live = applyEntry(live, assistantEntry)
      live = applyEntry(live, resultEntry)
      expect(live.messages).toEqual(reload.messages)

      const tc = reload.messages[0]!.toolCalls![0]!
      expect(tc.outputTruncated).toBe(true)
      expect(tc.output!.endsWith(MARKER)).toBe(true)
      expect(Buffer.byteLength(tc.output!, 'utf8')).toBeLessThanOrEqual(ENTRY_TOOL_OUTPUT_MAX_BYTES)
    })

    it('幂等去重（deliveredToolResultIds）与截断正交：双帧喂入仍单份截断产物', () => {
      const { assistantEntry, resultEntry } = makeEntries()
      const state = replayEntries([assistantEntry, resultEntry, resultEntry])
      expect(state.messages[0]!.toolCalls![0]!.outputTruncated).toBe(true)
    })

    it('六类工具 5KB output 累积态原样（64KB 累积截断不越权做 4KB 派生视图的活）', () => {
      const fiveKB = asciiOfBytes(5120)
      const state = replayEntries([
        toolResultEntry('tc-read', fiveKB, 'read') as unknown as PiMessageEntryShared,
      ])
      // read 无配对 assistant → orphan 收集（累积态无 messages）——改用带 assistant 的序列验证
      const assistantEntry: PiMessageEntryShared = {
        type: 'message',
        id: 'entry-asst-2',
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc-read', name: 'read', arguments: {} }],
          timestamp: 0,
        },
      } as unknown as PiMessageEntryShared
      const state2 = replayEntries([assistantEntry, toolResultEntry('tc-read', fiveKB, 'read')])
      expect(state2.messages[0]!.toolCalls![0]!.output).toBe(normalizePiToolResult(fiveKB).output)
      expect(state2.messages[0]!.toolCalls![0]!.outputTruncated).toBeUndefined()
      void state
    })
  })

  describe('live overlay（registry tool_call_end）与 reducer 同函数一致性', () => {
    // sid 固定 's1'；构造实现收敛到 helpers/fixtures.ts（原内联版逐字同构，
    // initial 放宽 unknown[] 的文件内便捷签名保留，转发时窄化）
    function makeCtx(initial: unknown[]): MessageEffectContext {
      return sharedMakeCtx(initial as Message[], 's1')
    }

    function msg(type: string, payload: Record<string, unknown>): ServerMessage {
      return serverMsg('s1', type, payload)
    }

    it('非六类工具大结果：overlay 回填 output ≡ truncateEntryToolOutput 产物 + outputTruncated + images 回填', () => {
      const bigOutput = asciiOfBytes(ENTRY_TOOL_OUTPUT_MAX_BYTES + 3)
      const host = {
        id: 'm1', role: 'assistant' as const, content: '', status: 'streaming' as const, timestamp: 0,
        toolCalls: [{ id: 'tc-x', toolName: 'mcp__srv__render', input: {}, status: 'running' as const, startTime: 0 }],
      }
      const ctx = makeCtx([host])
      const entry = {
        type: 'message',
        timestamp: new Date(0).toISOString(),
        message: {
          role: 'toolResult', toolCallId: 'tc-x',
          // content 数组含 image block（D6-⑨ live 图片可见性的数据源）
          content: [{ type: 'text', text: bigOutput }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }],
          isError: false, timestamp: 0,
        },
      }
      dispatchMessageEvent(ctx, 's1', msg('message.tool_call_end', { entry }))
      const tc = ctx.messages.value.get('s1')!.value[0]!.toolCalls![0]!
      const expected = truncateEntryToolOutput(bigOutput)
      expect(tc.output).toBe(expected.text)
      expect(tc.outputTruncated).toBe(true)
      // [D6-⑨] live images 回填（缺失则 live 期图片无数据源、设计「live 期即写」不成立）
      expect(tc.images).toEqual([{ data: 'QUJD', mimeType: 'image/png' }])
    })

    it('小结果 overlay 不加 outputTruncated（与 reducer 缺省语义一致）', () => {
      const host = {
        id: 'm1', role: 'assistant' as const, content: '', status: 'streaming' as const, timestamp: 0,
        toolCalls: [{ id: 'tc-y', toolName: 'write', input: {}, status: 'running' as const, startTime: 0 }],
      }
      const ctx = makeCtx([host])
      dispatchMessageEvent(ctx, 's1', msg('message.tool_call_end', {
        // content 数组形态（W21 契约：adapter 归一为数组）
        entry: { type: 'message', timestamp: new Date(0).toISOString(), message: { role: 'toolResult', toolCallId: 'tc-y', content: [{ type: 'text', text: 'tiny' }], isError: false, timestamp: 0 } },
      }))
      const tc = ctx.messages.value.get('s1')!.value[0]!.toolCalls![0]!
      expect(tc.output).toBe('tiny')
      expect(tc.outputTruncated).toBeUndefined()
    })
  })
});

// ======== 来源：handoff-instruction.test.ts ========
describe("handoff-instruction", () => {
  const ISO = (ms: number): string => new Date(ms).toISOString()

  /** 构造 handoff 指令 user entry（内容 = 模板原文）。 */
  function handoffUserEntry(id = 'e-handoff-1'): ReturnType<typeof msgEntry> {
    return msgEntry(id, { role: 'user', content: HANDOFF_PROMPT_TEMPLATE, timestamp: 1000 }, { timestamp: ISO(1000) })
  }

  /** 构造 assistant entry（交接文档正文）。 */
  function assistantEntry(id: string, text: string, ts: number): ReturnType<typeof msgEntry> {
    return msgEntry(id, { role: 'assistant', content: [{ type: 'text', text }], timestamp: ts }, { timestamp: ISO(ts) })
  }

  describe('isHandoffPromptText —— 识别锚点（内容 === 模板常量）', () => {
    it('模板常量原文命中', () => {
      expect(isHandoffPromptText(HANDOFF_PROMPT_TEMPLATE)).toBe(true)
    })

    it('近似文本不命中（改一词 / 截断 / 前后空白）', () => {
      expect(isHandoffPromptText(HANDOFF_PROMPT_TEMPLATE.replace('handoff document', 'summary'))).toBe(false)
      expect(isHandoffPromptText(`${HANDOFF_PROMPT_TEMPLATE}\n`)).toBe(false)
      expect(isHandoffPromptText(` ${HANDOFF_PROMPT_TEMPLATE}`)).toBe(false)
      expect(isHandoffPromptText(HANDOFF_PROMPT_TEMPLATE.slice(0, 100))).toBe(false)
      expect(isHandoffPromptText('')).toBe(false)
      // 模板仅是长文本的子串：包含它的用户消息不命中（全文相等判定，非启发式包含）
      expect(isHandoffPromptText(`说点什么\n\n${HANDOFF_PROMPT_TEMPLATE}`)).toBe(false)
    })
  })

  describe('reducer 派生段 —— 命中 user entry 折叠为系统行（live/reload 同点）', () => {
    it('命中：role 转 system + handoffInstruction 携带原文 + piEntryId 回填', () => {
      const { messages } = replayEntries([handoffUserEntry()])
      expect(messages).toHaveLength(1)
      const m = messages[0]
      expect(m.role).toBe('system')
      expect(m.handoffInstruction).toEqual({ text: HANDOFF_PROMPT_TEMPLATE })
      expect(m.content).toBe(HANDOFF_PROMPT_TEMPLATE)
      expect(m.piEntryId).toBe('e-handoff-1')
      expect(m.status).toBe('complete')
      expect(m.timestamp).toBe(1000)
    })

    it('不命中：普通 user 消息派生不受影响（含模板子串 / 普通文本）', () => {
      const nearMiss = msgEntry(
        'e-user-2',
        { role: 'user', content: `请参考以下指令：\n\n${HANDOFF_PROMPT_TEMPLATE}`, timestamp: 1000 },
        { timestamp: ISO(1000) },
      )
      const { messages } = replayEntries([nearMiss])
      expect(messages).toHaveLength(1)
      expect(messages[0].role).toBe('user')
      expect(messages[0].handoffInstruction).toBeUndefined()
    })

    it('convertMessageBody 直调：命中返回系统行形态（单点转换函数行为锁定）', () => {
      const msg = convertMessageBody(
        { role: 'user', content: HANDOFF_PROMPT_TEMPLATE, timestamp: 1000 },
        'entry-9',
        'e9',
        0,
      )
      expect(msg).not.toBeNull()
      expect(msg?.role).toBe('system')
      expect(msg?.handoffInstruction?.text).toBe(HANDOFF_PROMPT_TEMPLATE)
    })
  })

  describe('live ≡ reload —— applyEntry 单条（live 帧）与 replayEntries（重放）产物一致', () => {
    it('同一序列两条喂入路径 messages deep-equal', () => {
      const entries = [
        handoffUserEntry(),
        assistantEntry('e-a-1', '# Handoff document\n\nContext summary.', 2000),
      ]
      // live 路径：store.applyEntryFrame 逐帧 applyEntry（单条、前置 state 累积）
      let live = createInitialChatViewState()
      for (const e of entries) live = applyEntry(live, e)
      // reload 路径：getHistory → replayEntries 序列重放
      const reloaded = replayEntries(entries)
      expect(live.messages).toEqual(reloaded.messages)
      // 两条消息：指令行（system）+ 文档（assistant）
      expect(live.messages.map((m) => m.role)).toEqual(['system', 'assistant'])
    })
  })

  describe('分组层 —— 指令行作 turn 锚 + 交接文档回合', () => {
    it('isHandoffInstructionNotice：只认带 handoffInstruction 的 system 行', () => {
      const { messages } = replayEntries([handoffUserEntry()])
      const line = messages[0]
      expect(isHandoffInstructionNotice(line)).toBe(true)
      const plainSystem: Message = { id: 's1', role: 'system', content: 'x', status: 'complete', timestamp: 1 }
      expect(isHandoffInstructionNotice(plainSystem)).toBe(false)
      expect(isHandoffInstructionNotice(line)).toBe(true)
    })

    it('指令行 + 其后 assistant → 同一 turn，isHandoffDocTurn true；普通 user 后开新 turn', () => {
      const { messages } = replayEntries([
        assistantEntry('e-prev', '上一轮回复', 500),
        handoffUserEntry(),
        assistantEntry('e-a-1', '# Handoff document', 2000),
        msgEntry('e-user-next', { role: 'user', content: '下一个问题', timestamp: 3000 }, { timestamp: ISO(3000) }),
        assistantEntry('e-a-2', '新回合回复', 4000),
      ])
      expect(messages).toHaveLength(5)
      const items = toRenderItems(messages)
      const turns = items.filter((i) => i.kind === 'turn')
      // 结构：[assistant 自启 turn（prev）] [指令 notice 独立行] [handoff turn（指令锚 + 文档）] [user turn（新问题）]
      // 指令行是 handoff turn 锚（不产独立 static 项），独立 systemNotice 项不应出现指令行
      expect(turns).toHaveLength(3)
      const handoffTurn = turns[1]
      if (handoffTurn.kind !== 'turn') throw new Error('unreachable')
      expect(handoffTurn.turn.user?.handoffInstruction).toBeDefined()
      expect(isHandoffDocTurn(handoffTurn.turn)).toBe(true)
      expect(handoffTurn.turn.assistants).toHaveLength(1)
      expect(handoffTurn.turn.assistants[0].content).toContain('Handoff document')
      // 前后 turn 判定为 false
      if (turns[0].kind !== 'turn' || turns[2].kind !== 'turn') throw new Error('unreachable')
      expect(isHandoffDocTurn(turns[0].turn)).toBe(false)
      expect(isHandoffDocTurn(turns[2].turn)).toBe(false)
    })

    it('交接中止形态（指令行后无 assistant）：指令行仍作锚产出空 assistant turn（消息不丢，无独立 notice 项）', () => {
      const { messages } = replayEntries([
        handoffUserEntry(),
        msgEntry('e-user-next', { role: 'user', content: '中止后的新消息', timestamp: 3000 }, { timestamp: ISO(3000) }),
      ])
      const items = toRenderItems(messages)
      // 锚位有消息（isEmptyTurn 判 user===null 不命中）→ turn 保留：指令行随锚位照显，
      // 后续 user 正常开新 turn。无独立 systemNotice 项。
      const turns = items.filter((i) => i.kind === 'turn')
      expect(turns).toHaveLength(2)
      if (turns[0].kind !== 'turn') throw new Error('unreachable')
      expect(turns[0].turn.user?.handoffInstruction).toBeDefined()
      expect(turns[0].turn.assistants).toHaveLength(0)
      expect(items.every((i) => i.kind !== 'systemNotice')).toBe(true)
    })
  })
});

// ======== 来源：turn-usage-live-reload-equivalence.test.ts ========
describe("turn-usage-live-reload-equivalence", () => {
  const T0 = 1_700_000_000_000
  const ISO = (ms: number): string => new Date(ms).toISOString()

  // 同一 turn 的两次真实调用用量（call1 = 500、call2 = 30 output tokens）
  const CALL1 = { input: 400, output: 500, totalTokens: 900 }

  const CALL2 = { input: 50, output: 30, totalTokens: 80 }

  const SUM_OUTPUT = CALL1.output + CALL2.output // 530

  function makeTurn(user: Message | null, assistants: Message[]): MessageTurn {
    return { index: 0, user, assistants, isStreaming: false, hasFoldable: false }
  }

  describe('[turn-badge-tokens] 多 assistant 调用 turn：live ≡ reload 聚合一致（D3 逐条载荷口径）', () => {
    it('live 路径（定稿重建逐条 usage + complete 收尾不覆盖）= reload 路径（replayEntries 逐条求和）= 全部调用之和', () => {
      // ── live 路径：ref 形态（registry 定稿重建产物）——每条 assistant 的 usage =
      //    自己 message_end 载荷的调用值（rebuildAssistantOnFinalize 写入，与 reload 同源）──
      const live: Message[] = [
        { id: 'u-live', role: 'user', content: 'q', status: 'complete', timestamp: T0 },
        {
          id: 'a-live-1', role: 'assistant', content: '', status: 'streaming', timestamp: T0 + 100,
          toolCalls: [{ id: 'tc1', toolName: 'edit', input: { path: '/a.ts' }, status: 'completed', startTime: T0 + 200, endTime: T0 + 1500 }],
          usage: { inputTokens: CALL1.input, outputTokens: CALL1.output },
        },
        { id: 'a-live-2', role: 'assistant', content: 'final', status: 'streaming', timestamp: T0 + 2000, usage: { inputTokens: CALL2.input, outputTokens: CALL2.output } },
      ]
      // 回合收尾（message.complete）：terminalMessagePatch 只翻 status / 权威 content——
      // usage/endedAt 覆盖已退役（D3 规则 5）。负断言防回归：若此处改回回合级累计覆盖，
      // 下方聚合会变成「逐条 + 回合累计」双计而偏离 SUM_OUTPUT。
      const lastAssistantIdx = findLastAssistantIndex(live)
      const livePatched = live.map((m, i) =>
        m.role === 'assistant' && m.status === 'streaming'
          ? terminalMessagePatch(m, i, {
            lastAssistantIdx,
            isErrorStop: false,
            errorMessage: undefined,
            finalContent: 'final',
          })
          : m,
      )
      expect(livePatched[1]!.usage).toEqual({ inputTokens: CALL1.input, outputTokens: CALL1.output })
      expect(livePatched[2]!.usage).toEqual({ inputTokens: CALL2.input, outputTokens: CALL2.output })
      const liveTurn = makeTurn(livePatched[0]!, livePatched.filter((m) => m.role === 'assistant'))
      const liveAgg = deriveTurnAggregates(liveTurn)

      // ── reload 路径：session JSONL entries（每条 assistant 自带 usage）──
      const entries: PiMessageEntryShared[] = [
        msgEntry('e-u', { role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: T0 }, { timestamp: ISO(T0) }),
        msgEntry('e-a1', {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc1', name: 'edit', arguments: { path: '/a.ts' } }],
          timestamp: T0 + 100,
          usage: CALL1,
        }, { timestamp: ISO(T0 + 100) }),
        msgEntry('e-tr', {
          role: 'toolResult', toolCallId: 'tc1', toolName: 'edit',
          content: [{ type: 'text', text: 'ok' }], timestamp: T0 + 1500,
        }, { timestamp: ISO(T0 + 1500) }),
        msgEntry('e-a2', {
          role: 'assistant', content: [{ type: 'text', text: 'final' }],
          timestamp: T0 + 2000, usage: CALL2,
        }, { timestamp: ISO(T0 + 2000) }),
      ]
      const state = replayEntries(entries)
      const reloadAssistants = state.messages.filter((m) => m.role === 'assistant')
      const reloadUser = state.messages.find((m) => m.role === 'user') ?? null
      const reloadAgg = deriveTurnAggregates(makeTurn(reloadUser, reloadAssistants))

      // 两路径聚合全等 = 全部调用之和（逐条载荷同源求和，非末次调用量、非回合累计双计）
      expect(liveAgg.generatedTokens).toBe(SUM_OUTPUT)
      expect(reloadAgg.generatedTokens).toBe(SUM_OUTPUT)
      expect(liveAgg.generatedTokens).toBe(reloadAgg.generatedTokens)
    })

    it('单调用 turn：live = reload = 该次调用量（回归锚：收尾不改变单调用行为）', () => {
      const livePatched = terminalMessagePatch(
        { id: 'a1', role: 'assistant', content: 'x', status: 'streaming', timestamp: T0, usage: { inputTokens: CALL1.input, outputTokens: CALL1.output } },
        0,
        {
          lastAssistantIdx: 0,
          isErrorStop: false,
          errorMessage: undefined,
          finalContent: 'x',
        },
      )
      const liveAgg = deriveTurnAggregates(makeTurn(null, [livePatched]))
      const state = replayEntries([
        msgEntry('e-a', { role: 'assistant', content: [{ type: 'text', text: 'x' }], timestamp: T0, usage: CALL1 }, { timestamp: ISO(T0) }),
      ])
      const reloadAgg = deriveTurnAggregates(makeTurn(null, state.messages))
      expect(liveAgg.generatedTokens).toBe(CALL1.output)
      expect(reloadAgg.generatedTokens).toBe(CALL1.output)
    })
  })
});
