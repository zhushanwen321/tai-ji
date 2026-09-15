/**
 * branchSummary live ≡ reload 等价性（D13 renderer-deepening entry 化的守护网）。
 *
 * 背景（designs/design §3.3 D13，本设计第二处有意行为变化）：branchSummary 实时侧曾
 * 直插 system 消息（fallback 文案 'Branched'），与重开 apply-entry branch_summary case
 * （`rawSummary ?? ''`）两份投影，live 显示与关闭重开不一致。entry 化后实时路径 =
 * branchSummary effect 构造 branch_summary entry → ctx.applyEntryFrame 喂与文件重放
 * （get_entries → replayEntries）同一个 applyEntry + overlay 投影，本文件锁定：
 *
 * 1. branch 后 live 投影（reducer state + ref 消息）与经 entry 重放的投影逐字段一致
 *    （异源 id/timestamp 归一——branchSummary 帧携带 timestamp 时两侧同值直断）
 * 2. summary 缺失：两侧同产空串行（live 'Branched' 占位消灭——D13 行为变化锁定）
 * 3. 空串 summary：两侧同保留空行（readBranchSummary 空串门，compaction E4c 同族）
 * 4. ref 消息与 reducer state 消息同源同 id（overlay 投影消费同一份派生）
 * 5. 混合序列（user → branch → 后续消息）两路全量 state 一致 + 分组语义
 *   （branchSummary 作 boundary systemNotice，message-turns 规则 5）
 *
 * 红性依据：回退旧直插分支（不喂 reducer 的独立构造）→ live reducer state 空 →
 * 用例 1 的「toHaveLength(1)」与后续 deep equal 必红。
 *
 * 运行：cd packages/core && pnpm exec vitest run src/domain/chat/__tests__/branch-summary-equivalence.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createChatStore } from '../store'
import type { ChatStoreInstance } from '../store'
import { replayEntries } from '../apply-entry'
import type { ChatViewState } from '../apply-entry'
import { toRenderItems } from '../message-turns'
import type { Message, PiBranchSummaryEntry, ServerMessage } from '@taiji/shared'

/** 构造独立 store 实例（effectScope 包裹 onScopeDispose 注册 + 测试隔离）。 */
function makeStore(): { store: ChatStoreInstance; dispose: () => void } {
  const scope = effectScope(true)
  const store = scope.run(() => createChatStore())!
  return { store, dispose: () => scope.stop() }
}

/** pi 持久化形态的 branch_summary entry（重开侧 get_entries 返回形态：uuidv7 id + pi 落盘时刻） */
function persistedBranchEntry(overrides: Partial<PiBranchSummaryEntry> = {}): PiBranchSummaryEntry {
  return {
    type: 'branch_summary',
    id: '0199bbbb-cccc-7ddd-eeee-ffff00000001',
    parentId: null,
    timestamp: new Date(1724066400000).toISOString(),
    summary: '分支摘要',
    fromId: 'msg-abc',
    ...overrides,
  }
}

/** 实时侧 branchSummary payload（readers 消费形态：summary/fromId/timestamp） */
function branchPayload(entry: PiBranchSummaryEntry): Record<string, unknown> {
  return {
    summary: entry.summary,
    fromId: entry.fromId,
    timestamp: new Date(entry.timestamp).getTime(),
  }
}

/**
 * 异源字段归一：剥 id 与 timestamp。
 * - id：实时 br-uuid（客户端生成）vs 重开 pi uuidv7 entry id——id 值异源属 W21 已裁决的
 *   live/reload 差异类（customStart cm- / compaction cmp- 同族）。
 * - timestamp：帧携带时两侧同值（不剥也可断言，此处统一归一隔离无关变量）；帧缺省时
 *   实时客户端时钟 vs 重开 pi 持久化时刻，差值为投递延迟（custom-start stripVolatile 同族）。
 * 归一后其余字段（role/content/status/branchSummary）必须逐字段 deep equal。
 */
function stripVolatile(m: Message): Record<string, unknown> {
  const { id: _id, timestamp: _ts, ...rest } = m
  return rest as Record<string, unknown>
}

/** 全量 state 归一（messages 剥异源字段 + 其余簿记字段原样比较） */
function normState(st: ChatViewState) {
  return {
    messages: st.messages.map(stripVolatile),
    clientUuidMap: st.clientUuidMap,
    orphanToolResults: st.orphanToolResults,
    lastAssistantWithToolCalls: st.lastAssistantWithToolCalls,
  }
}

function branchSummaryMsg(sid: string, payload: Record<string, unknown>): ServerMessage {
  return { type: 'message.branchSummary', payload: { sessionId: sid, ...payload } } as ServerMessage
}

describe('branchSummary live ≡ reload（D13 entry 化守护网）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('branch 后 live 投影 ≡ 经 entry 重放的投影：reducer state 归一 deep-equal + ref 消息逐字段一致', () => {
    const s = makeStore()
    const sid = 's-branch-eq'
    const entry = persistedBranchEntry()
    // 实时路径：branchSummary 帧 → effect 构造 branch_summary entry 喂 reducer + overlay
    s.store.applyMessageEvent(sid, branchSummaryMsg(sid, branchPayload(entry)))
    const liveState = s.store.testInternals._entryStatesForTest.get(sid)
    // 旧直插分支回退时（branchSummary 不喂 reducer）liveState 为空/缺失 → 此处先红
    expect(liveState?.messages).toHaveLength(1)
    // 重开路径：同一 entry 直接重放（get_entries → replayEntries）
    const reloadState = replayEntries([entry])
    expect(normState(liveState!)).toEqual(normState(reloadState))
    // 用户可见行为：system 分支行，content = summary 原值（非 'Branched' 占位）
    expect(liveState!.messages[0]).toMatchObject({
      role: 'system',
      content: '分支摘要',
      status: 'complete',
      branchSummary: { summary: '分支摘要', fromId: 'msg-abc' },
    })
    // 帧 timestamp 经 entry ISO → toMs 精确往返：两侧消息 timestamp 数值同值直断
    expect(liveState!.messages[0].timestamp).toBe(new Date(entry.timestamp).getTime())
    expect(reloadState.messages[0].timestamp).toBe(new Date(entry.timestamp).getTime())
    // ref 消息（overlay 投影）与 reducer state 消息同源同 id（含 br- 前缀）
    const refMsgs = s.store.getMessages(sid)
    expect(refMsgs).toHaveLength(1)
    expect(refMsgs[0]).toEqual(liveState!.messages[0])
    expect(refMsgs[0].id).toMatch(/^br-/)
    s.dispose()
  })

  it('summary 缺失：live 投影 content 空串（原 Branched 占位消灭）且与重开逐字段一致', () => {
    const s = makeStore()
    const sid = 's-branch-missing'
    // 实时帧缺 summary（readBranchSummary 不设字段 → entry 无 summary）
    s.store.applyMessageEvent(sid, branchSummaryMsg(sid, { fromId: 'n-1', timestamp: 200 }))
    // 重开侧：pi 持久化 entry 同样无 summary 字段
    const reload = replayEntries([persistedBranchEntry({ id: 'entry-x', summary: undefined, fromId: 'n-1', timestamp: new Date(200).toISOString() })])
    const liveState = s.store.testInternals._entryStatesForTest.get(sid)!
    const refMsgs = s.store.getMessages(sid)
    expect(refMsgs).toHaveLength(1)
    // D13 行为变化锁定：live content = ''（reducer `rawSummary ?? ''`），不再是 'Branched'
    expect(refMsgs[0].content).toBe('')
    expect(liveState.messages[0].content).toBe('')
    expect(reload.messages[0].content).toBe('')
    // 三方（ref / live reducer / reload）逐字段一致
    expect(stripVolatile(refMsgs[0])).toEqual(stripVolatile(liveState.messages[0]))
    expect(stripVolatile(liveState.messages[0])).toEqual(stripVolatile(reload.messages[0]))
    s.dispose()
  })

  it('空串 summary 透传：两侧同保留空行（`\'\' ?? \'\'` 不触发、不走占位——与缺失形态区分）', () => {
    const s = makeStore()
    const sid = 's-branch-empty'
    // 实时帧 summary:''（readBranchSummary 空串门透传 → entry summary:''）
    s.store.applyMessageEvent(sid, branchSummaryMsg(sid, { summary: '', fromId: 'n-2', timestamp: 300 }))
    const reload = replayEntries([persistedBranchEntry({ id: 'entry-y', summary: '', fromId: 'n-2', timestamp: new Date(300).toISOString() })])
    const refMsgs = s.store.getMessages(sid)
    const liveState = s.store.testInternals._entryStatesForTest.get(sid)!
    expect(refMsgs[0].content).toBe('')
    expect(refMsgs[0].branchSummary).toMatchObject({ summary: '' })
    expect(stripVolatile(refMsgs[0])).toEqual(stripVolatile(reload.messages[0]))
    expect(normState(liveState)).toEqual(normState(reload))
    s.dispose()
  })

  it('混合序列（user → branch）：branch 行三路逐字段一致 + branch 作 boundary systemNotice', () => {
    const s = makeStore()
    const sid = 's-branch-mixed'
    // 实时路径：live user 消息（appendUser 乐观 overlay，u- 前缀——reducer 的 user entry
    // 唯一来源是 message_end(user) 权威帧，见 store.appendUser 注释）→ branchSummary 帧
    s.store.appendUser(sid, [{ type: 'text', text: '问题' }])
    s.store.applyMessageEvent(sid, branchSummaryMsg(sid, { summary: '分支', fromId: 'n-1', timestamp: 600 }))
    // live reducer state 只含 branch（user 乐观插入不喂 reducer——user 类型的 live≡reload
    // 经 message_end 权威帧成立，非本文件靶子）
    const liveState = s.store.testInternals._entryStatesForTest.get(sid)!
    expect(liveState.messages).toHaveLength(1)
    expect(liveState.messages[0].branchSummary).toBeDefined()
    // ref 消息 = user（overlay）+ branch（overlay），branch 归 turn 边界
    const refMsgs = s.store.getMessages(sid)
    expect(refMsgs).toHaveLength(2)
    // 重开路径：同内容 pi entry 序列（branch 前有 user）
    const branchEntry = persistedBranchEntry({ id: 'e-branch', summary: '分支', fromId: 'n-1', timestamp: new Date(600).toISOString() })
    const reloadState = replayEntries([
      { type: 'message', id: 'p-1', parentId: null, timestamp: new Date(100).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '问题' }], timestamp: 100 } },
      branchEntry,
    ])
    expect(reloadState.messages).toHaveLength(2)
    // 分组语义：branchSummary 关闭当前 turn，作 boundary systemNotice 独立行（规则 5），
    // 两侧分组骨架一致（user turn + branch 独立行）
    const liveItems = toRenderItems(refMsgs)
    const reloadItems = toRenderItems(reloadState.messages)
    expect(liveItems.filter((i) => i.kind === 'systemNotice' && i.message.branchSummary !== undefined)).toHaveLength(1)
    expect(reloadItems.filter((i) => i.kind === 'systemNotice' && i.message.branchSummary !== undefined)).toHaveLength(1)
    // branch 行本体（ref / live reducer / reload）逐字段一致
    const liveBranchMsg = liveState.messages[0]
    const reloadBranchMsg = reloadState.messages.find((m) => m.branchSummary !== undefined)!
    const refBranchMsg = refMsgs.find((m) => m.branchSummary !== undefined)!
    expect(stripVolatile(refBranchMsg)).toEqual(stripVolatile(liveBranchMsg))
    expect(stripVolatile(liveBranchMsg)).toEqual(stripVolatile(reloadBranchMsg))
    s.dispose()
  })
})
