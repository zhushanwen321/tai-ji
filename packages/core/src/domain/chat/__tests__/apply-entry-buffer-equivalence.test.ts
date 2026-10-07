/**
 * createChatViewStateBuffer 连续 feed ≡ entries.reduce(applyEntry, initial) 元断言（第三形态）。
 *
 * buffer 是跨 feed 调用持久的 mutable 累积缓冲（store entryStates 活容器形态），与
 * applyEntry（copy-on-write）/ replayEntries（fold 内 mutable）共享同一派生段与 dispatch
 * 骨架（apply-entry.ts 文件头 collector 叙事）——本文件以四个维度机器守卫「活容器累积、
 * 产物同构」约定：
 * 1. 产物同构：混合全类型序列 buffer feed 与 reduce 两条路径全量 state deep-equal
 *    （messages / orphanToolResults / deliveredToolResultIds / lastAssistantWithToolCalls
 *    非抽样）；
 * 2. 幂等双喂：同 toolResult 两帧（tool_call_end 重构 + message_end 权威帧）在 buffer
 *    连续 feed 下收敛单投递——R2-S1 双入口幂等在活容器形态下保持；
 * 3. 输入纯度：feed 不 mutate 外部传入的 entry 对象（buffer 自身容器可变，不适用
 *    structuredClone 整表对照——纯度断言对象是输入 entry 而非容器）；
 * 4. 长序列形态：10k 条无 id entry 的 feed 正确性 + `e<N>` 确定性 id 全程唯一（O(1)
 *    每帧落账路径的结构验证，不计时——性能画像归基准工具）。
 *
 * 附带锁定活容器约束的读口义务：snapshot() 是低频浅拷贝（快照不随后续 feed 漂移），
 * `state` 引用恒定、内容随 feed 累积（跨帧持有其容器引用 = 观察到后续变更，属契约外用法）。
 *
 * 行为级具体断言（role 细分 / 回填字段 / 分组渲染）在 apply-entry.test.ts 与
 * apply-entry-equivalence.test.ts，fold 路径元断言在 apply-entry-fold-equivalence.test.ts，
 * 本文件不重复。
 *
 * 运行：cd packages/core && pnpm exec vitest run src/domain/chat/__tests__/apply-entry-buffer-equivalence.test.ts
 */
import { describe, it, expect } from 'vitest'
import { applyEntry, createChatViewStateBuffer, createInitialChatViewState, replayEntries } from '../apply-entry'
import type { PiEntry } from '../apply-entry'
import { msgEntry } from './helpers/fixtures'

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

describe('createChatViewStateBuffer 连续 feed ≡ reduce(applyEntry) 元断言', () => {
  it('混合全类型序列：全量 state deep-equal（messages/orphan/delivered/配对锚点）', () => {
    const viaBuffer = feedMixed()
    const viaReduce = mixedEntries().reduce(applyEntry, createInitialChatViewState())
    expect(viaBuffer.state).toEqual(viaReduce)
    // 用户可见内容非空守卫（防两侧同归于空 / no-op 假等价）：user / assistant / 回填 /
    // 孤儿 / bash / 双形态压缩 / 分支 / 自定义通知各就各位
    expect(viaBuffer.state.messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(viaBuffer.state.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(viaBuffer.state.messages.find((m) => m.toolCalls?.some((t) => t.id === 'tc-1'))?.toolCalls?.[0]?.output).toBe('out')
    expect(viaBuffer.state.orphanToolResults).toHaveLength(1)
    expect(viaBuffer.state.messages.filter((m) => m.bashExecution !== undefined)).toHaveLength(1)
    expect(viaBuffer.state.messages.filter((m) => m.compactionSummary !== undefined)).toHaveLength(2)
    expect(viaBuffer.state.messages.filter((m) => m.branchSummary !== undefined)).toHaveLength(1)
    expect(viaBuffer.state.messages.filter((m) => m.customType === 'goal-context')).toHaveLength(1)
    // custom（client-msg-id）纯数据 entry：两路径同为 no-op（零对话流投影）
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

  it('长序列（10k 条无 id user entry）：id e0..e9999 确定性唯一，buffer feed 与 reduce 产物全等', () => {
    const entries: PiEntry[] = Array.from({ length: 10_000 }, (_, i) => ({
      type: 'message',
      parentId: null,
      timestamp: ISO(i),
      message: { role: 'user', content: [{ type: 'text', text: `m${i}` }], timestamp: i },
    }))
    const buf = createChatViewStateBuffer()
    for (const entry of entries) buf.feed(entry)
    const viaReduce = entries.reduce(applyEntry, createInitialChatViewState())
    expect(buf.state).toEqual(viaReduce)
    expect(buf.state.messages).toHaveLength(10_000)
    expect(buf.state.messages[0]?.id).toBe('e0')
    expect(buf.state.messages[9_999]?.id).toBe('e9999')
    expect(new Set(buf.state.messages.map((m) => m.id))).toHaveLength(10_000)
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
