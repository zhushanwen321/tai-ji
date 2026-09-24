/**
 * equivalence fixture 样本 —— pending:register / pending:unregister / notify-ledger entry
 * 混入对话流序列时 applyEntry reducer 的确定性与投影口径（notify-once 设计 U5⑥）。
 *
 * 静态 fixture（不 spawn pi、凭证无关，属凭证无关 unit 轨——勿登记 REAL_PI_TESTS）。
 *
 * 断言三点：
 * 1. **确定性**：同一 entry 序列两次重放 deep-equal（「消息列表 = entry 日志的纯函数」
 *    纯度契约在通知域样本上成立——live ≡ reload 构造性不变量的样本级复核）；
 * 2. **零投影**：pending 差集 entry 与 notify-ledger/ack entry（plain custom 通道，不进
 *    LLM 上下文、不产对话流消息）重放后 messages 不增不减、不打断 message 派生；
 * 3. **双 fold 路径同 reducer**：applyEntry 单条逐喂 ≡ replayEntries 批量（实时/重放两条
 *    链路喂同一 reducer 的构造性保证在本样本上成立）。
 */
import { describe, expect, it } from 'vitest'
import {
  applyEntry,
  createInitialChatViewState,
  replayEntries,
  type PiEntry,
} from '../../../../core/src/domain/chat/apply-entry.js'

// ─── fixture 构造（JSONL 反序列化形态）──────────────────────────────────────

const ts = (ms: number): string => new Date(ms).toISOString()
const id = (n: number): string => `0198aabb-ccdd-7e0${n}-8f00-00000000000${n}`

function userMsg(text: string, n: number, ms: number): PiEntry {
  return {
    type: 'message',
    id: id(n),
    parentId: null,
    timestamp: ts(ms),
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: ms },
  }
}

function assistantMsg(text: string, n: number, ms: number): PiEntry {
  return {
    type: 'message',
    id: id(n),
    parentId: null,
    timestamp: ts(ms),
    message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: ms },
  }
}

/** pending:register plain custom entry（三键契约 {id=notifyId, type:'session', name}）。 */
function pendingRegister(notifyId: string, n: number, ms: number): PiEntry {
  return {
    type: 'custom',
    id: id(n),
    parentId: null,
    timestamp: ts(ms),
    customType: 'pending:register',
    data: {
      id: notifyId,
      type: 'session', // notify-once 扩展的 PendingType 新值（u-protocol 面）
      name: 'auth-refactor',
      status: 'active',
      registeredAt: ms,
      sessionId: 'parent-1',
    },
  }
}

/** pending:unregister plain custom entry（差集抵消键 = data.id）。 */
function pendingUnregister(notifyId: string, n: number, ms: number): PiEntry {
  return {
    type: 'custom',
    id: id(n),
    parentId: null,
    timestamp: ts(ms),
    customType: 'pending:unregister',
    data: { id: notifyId, reason: 'completed', status: 'completed' },
  }
}

/** notify-ledger（B-ledger）落账 entry（plain custom：ledger / ack 两通道）。 */
function ledgerEntry(customType: string, notifyId: string, n: number, ms: number): PiEntry {
  return {
    type: 'custom',
    id: id(n),
    parentId: null,
    timestamp: ts(ms),
    customType,
    data: { notifyId, status: 'pending', content: 'Managed session "auth-refactor" finished.' },
  }
}

/**
 * 样本序列：user → register(sm-a) → assistant → register(sm-b) → ledger(sm-a)
 * → unregister(sm-a) → ack(sm-a) → assistant。
 * 通知域 entry 全部夹在 message 之间，覆盖「穿越」与「不位移派生」两面。
 */
function buildSequence(): PiEntry[] {
  return [
    userMsg('派发 auth 重构任务', 1, 1000),
    pendingRegister('sm-a', 2, 1100),
    assistantMsg('收到，开始执行', 3, 1200),
    pendingRegister('sm-b', 4, 1300),
    ledgerEntry('subagent-bg-notify-ledger', 'sm-a', 5, 1400),
    pendingUnregister('sm-a', 6, 1500),
    ledgerEntry('subagent-bg-notify-ack', 'sm-a', 7, 1600),
    assistantMsg('任务完成', 8, 1700),
  ]
}

describe('equivalence：pending/notify-ledger entry 样本的 applyEntry reducer 确定性（U5⑥）', () => {
  it('确定性：同一序列两次重放 deep-equal（消息列表 = entry 日志的纯函数）', () => {
    const seq = buildSequence()
    const first = replayEntries(seq)
    const second = replayEntries(seq)
    expect(first).toEqual(second)
    // 非空守卫（防空转）：3 条 message entry（user + 2 assistant）全数投影
    expect(first.messages).toHaveLength(3)
    expect(first.clientUuidMap.size).toBe(0)
    expect(first.orphanToolResults).toHaveLength(0)
  })

  it('零投影：pending 差集与 notify-ledger/ack entry 不产消息、不位移 message 派生 id', () => {
    const seq = buildSequence()
    const full = replayEntries(seq)
    const messagesOnly = seq.filter((e) => e.type !== 'custom')
    const reduced = replayEntries(messagesOnly)
    // 通知域 custom entry 全部被派生穿越：消息集与仅 message 子序列重放逐字节一致
    expect(full.messages).toEqual(reduced.messages)
    expect(full.messages.map((m) => m.id)).toEqual(reduced.messages.map((m) => m.id))
    // 消息内容形态：夹缝中的通知 entry 不产生任何幽灵消息
    expect(full.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
  })

  it('双 fold 路径同 reducer：applyEntry 单条逐喂 ≡ replayEntries 批量', () => {
    const seq = buildSequence()
    const folded = seq.reduce(applyEntry, createInitialChatViewState())
    expect(folded).toEqual(replayEntries(seq))
    // 中途快照同样确定（逐条 fold 任一前缀两次喂入一致）
    const prefix = seq.slice(0, 5)
    const prefixA = prefix.reduce(applyEntry, createInitialChatViewState())
    const prefixB = prefix.reduce(applyEntry, createInitialChatViewState())
    expect(prefixA).toEqual(prefixB)
    expect(prefixA.messages).toHaveLength(2)
  })
})
