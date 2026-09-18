/**
 * replayEntries(mutable fold) ≡ entries.reduce(applyEntry, initial) 元断言（transient fold）。
 *
 * applyEntry 单条走 copy-on-write collector，replayEntries 走 mutable collector 原地累积；
 * 两条 fold 路径共享同一派生段（deriveXxxMessage）与 dispatch 骨架（apply-entry.ts 文件头
 * collector 叙事）——本文件以三个维度机器守卫「内部累积、产物同构」约定：
 * 1. 产物同构：混合全类型序列两条路径全量 state deep-equal（messages / clientUuidMap /
 *    orphanToolResults / deliveredToolResultIds / lastAssistantWithToolCalls 非抽样）；
 * 2. 输入纯度：entries 与 initial（含非空 initial 接续场景）均不被 mutable fold mutate；
 * 3. 长序列形态：10k 条无 id entry 的 fold 正确性 + `e<N>` 确定性 id 全程唯一（O(n) 路径
 *    的结构验证，不计时——性能画像归基准工具）。
 *
 * 行为级具体断言（role 细分 / 回填字段 / 分组渲染）在 apply-entry.test.ts 与
 * apply-entry-equivalence.test.ts，本文件不重复。
 *
 * 运行：cd packages/core && pnpm exec vitest run src/domain/chat/__tests__/apply-entry-fold-equivalence.test.ts
 */
import { describe, it, expect } from 'vitest'
import { applyEntry, createInitialChatViewState, replayEntries } from '../apply-entry'
import type { PiEntry } from '../apply-entry'
import { msgEntry } from './helpers/fixtures'

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

describe('replayEntries(mutable fold) ≡ reduce(applyEntry) 元断言', () => {
  it('混合全类型序列：全量 state deep-equal（messages/clientUuidMap/orphan/delivered/配对锚点）', () => {
    const entries = mixedEntries()
    const viaFold = replayEntries(entries)
    const viaReduce = entries.reduce(applyEntry, createInitialChatViewState())
    expect(viaFold).toEqual(viaReduce)
    // 用户可见内容非空守卫（防两侧同归于空 / no-op 假等价）：user / assistant / 回填 /
    // 孤儿 / bash / 双形态压缩 / 分支 / 自定义通知各就各位
    expect(viaFold.messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(viaFold.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(viaFold.messages.find((m) => m.toolCalls?.some((t) => t.id === 'tc-1'))?.toolCalls?.[0]?.output).toBe('out')
    expect(viaFold.orphanToolResults).toHaveLength(1)
    expect(viaFold.messages.filter((m) => m.bashExecution !== undefined)).toHaveLength(1)
    expect(viaFold.messages.filter((m) => m.compactionSummary !== undefined)).toHaveLength(2)
    expect(viaFold.messages.filter((m) => m.branchSummary !== undefined)).toHaveLength(1)
    expect(viaFold.messages.filter((m) => m.customType === 'goal-context')).toHaveLength(1)
    expect(viaFold.clientUuidMap.get('e-user-1')).toBe('u-1')
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

  it('长序列（10k 条无 id user entry）：id e0..e9999 确定性唯一，fold 与 reduce 产物全等', () => {
    const entries: PiEntry[] = Array.from({ length: 10_000 }, (_, i) => ({
      type: 'message',
      parentId: null,
      timestamp: ISO(i),
      message: { role: 'user', content: [{ type: 'text', text: `m${i}` }], timestamp: i },
    }))
    const viaFold = replayEntries(entries)
    const viaReduce = entries.reduce(applyEntry, createInitialChatViewState())
    expect(viaFold).toEqual(viaReduce)
    expect(viaFold.messages).toHaveLength(10_000)
    expect(viaFold.messages[0]?.id).toBe('e0')
    expect(viaFold.messages[9_999]?.id).toBe('e9999')
    expect(new Set(viaFold.messages.map((m) => m.id))).toHaveLength(10_000)
  })

  /** 头段序列的 reduce 终态（非空 initial 接续用例的基座） */
  function headState() {
    return mixedEntries().reduce(applyEntry, createInitialChatViewState())
  }
})
