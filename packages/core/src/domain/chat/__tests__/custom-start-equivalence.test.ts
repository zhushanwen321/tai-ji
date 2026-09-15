/**
 * custom 通知链 live ≡ reload 等价性（custom 双管线收敛的守护网）。
 *
 * 背景（data-source-governance 审计问题 4）：customStart 实时侧曾独立构造 system 消息 +
 * display 覆写（与重开 apply-entry custom_message case 两份对称代码，对称性靠注释维持）。
 * 收敛后实时路径 = customStart effect 构造 custom_message entry → ctx.applyEntryFrame 喂
 * 与文件重放（get_entries → replayEntries）同一个 applyEntry，本文件锁定该等价性：
 *
 * 1. 同一条 custom entry：实时喂入构造的 store 状态 ≡ 重开 replayEntries（deep equal 关键字段）
 * 2. ref 消息与 reducer state 消息同源同 id（overlay 投影消费同一份派生）
 * 3. display 覆写收敛到 reducer 单点（完成通知类 → false；非通知类三态透传）
 * 4. message_end（role custom）去双计（pi 双发同一 message 对象，customStart 已喂）
 * 5. 畸形 details 归一（与重开 isLooseRecord 同语义）
 *
 * 红性依据：回退旧 customStart 分支（不喂 reducer 的独立构造）→ live reducer state 空 →
 * 用例 1 的「toHaveLength(1)」与后续 deep equal 必红。
 *
 * 运行：cd packages/core && pnpm exec vitest run src/domain/chat/__tests__/custom-start-equivalence.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createChatStore } from '../store'
import type { ChatStoreInstance } from '../store'
import { replayEntries } from '../apply-entry'
import type { ChatViewState } from '../apply-entry'
import type { Message, PiCustomMessageEntry, ServerMessage } from '@taiji/shared'

/** 构造独立 store 实例（effectScope 包裹 onScopeDispose 注册 + 测试隔离）。 */
function makeStore(): { store: ChatStoreInstance; dispose: () => void } {
  const scope = effectScope(true)
  const store = scope.run(() => createChatStore())!
  return { store, dispose: () => scope.stop() }
}

/** pi 持久化形态的 custom_message entry（重开侧 get_entries 返回形态：uuidv7 id + pi 持久化时刻） */
function persistedCustomEntry(overrides: Partial<PiCustomMessageEntry> = {}): PiCustomMessageEntry {
  return {
    type: 'custom_message',
    id: '0199aaaa-bbbb-7ccc-dddd-eeeeffff0000',
    parentId: null,
    timestamp: new Date(1724066400000).toISOString(),
    customType: 'subagent-bg-notify',
    content: 'Subagent "coder" (job-1) completed.',
    // pi 扩展生产端写 true（pi TUI 语义）——taiji 消费端统一覆写 false（M2 display 前置）
    display: true,
    details: { id: 'job-1', status: 'done', agent: 'coder', startedAt: 1000, endedAt: 13000 },
    ...overrides,
  }
}

/** 实时侧 customStart payload（event-adapter handleMessageStart custom 分支透传形态，protocol.ts） */
function customStartPayload(entry: PiCustomMessageEntry): Record<string, unknown> {
  return {
    customType: entry.customType,
    content: entry.content,
    details: entry.details,
    display: entry.display,
  }
}

/**
 * 异源字段归一：剥 id 与 timestamp。
 * - id：实时 cm-uuid（客户端生成）vs 重开 pi uuidv7 entry id——id 值异源属 W21 已裁决的
 *   live/reload 差异类（与 message_end 的 e<N> vs 真实 id 同类）。
 * - timestamp：实时客户端时钟（customStart 事件不携带 timestamp）vs 重开 pi 持久化时刻
 *   （session-manager appendCustomMessageEntry 的 new Date().toISOString()），差值为投递延迟。
 * 归一后其余字段（role/content/status/customType/display/details）必须逐字段 deep equal。
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

function customStartMsg(sid: string, payload: Record<string, unknown>): ServerMessage {
  return { type: 'message.customStart', payload: { sessionId: sid, ...payload } } as ServerMessage
}

describe('custom 通知链 live ≡ reload（custom 双管线收敛守护网）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('同一条 custom entry：实时 customStart 喂入的 store 状态 ≡ 重开 replayEntries（关键字段 deep equal）', () => {
    const s = makeStore()
    const sid = 's-custom-eq'
    const entry = persistedCustomEntry()
    // 实时路径：event-adapter 透传 payload → customStart effect 构造 entry 喂 reducer + ref
    s.store.applyMessageEvent(sid, customStartMsg(sid, customStartPayload(entry)))
    const liveState = s.store.testInternals._entryStatesForTest.get(sid)
    // 旧双管线回退时（customStart 不喂 reducer）liveState 为空/缺失 → 此处先红
    expect(liveState?.messages).toHaveLength(1)
    // 重开路径：同一 entry 直接重放（get_entries → replayEntries）
    const reloadState = replayEntries([entry])
    // 关键字段 deep equal（异源 id/timestamp 归一后全量比较）
    expect(normState(liveState!)).toEqual(normState(reloadState))
    // 红性可读的具体字段直断：display 覆写（完成通知类 → false）在 reducer 单点生效
    expect(liveState!.messages[0]).toMatchObject({
      role: 'system',
      status: 'complete',
      customType: 'subagent-bg-notify',
      display: false,
      content: entry.content,
    })
    // details 原始透传（含 __gui__ 消费契约）
    expect(liveState!.messages[0].details).toEqual(entry.details)
    // 异源字段健全性：id 非空、timestamp 有限（归一只剥字段不放弃健全性约束）
    expect(typeof liveState!.messages[0].id).toBe('string')
    expect(liveState!.messages[0].id.length).toBeGreaterThan(0)
    expect(Number.isFinite(liveState!.messages[0].timestamp)).toBe(true)
    s.dispose()
  })

  it('ref 消息与 reducer state 消息同源同 id（overlay 投影消费同一份派生）', () => {
    const s = makeStore()
    const sid = 's-custom-ref'
    s.store.applyMessageEvent(sid, customStartMsg(sid, {
      customType: 'subagent-bg-notify',
      content: 'notify',
      display: true,
      details: { id: 'job-2' },
    }))
    const refMsgs = s.store.getMessages(sid)
    expect(refMsgs).toHaveLength(1)
    const reducerMsgs = s.store.testInternals._entryStatesForTest.get(sid)!.messages
    expect(reducerMsgs).toHaveLength(1)
    // 同一 entry 派生 → 全字段（含 id）相等；ref id 形态保留 cm- 前缀（Vue key /
    // truncateFrom 消费的唯一性契约）
    expect(refMsgs[0]).toEqual(reducerMsgs[0])
    expect(refMsgs[0].id).toMatch(/^cm-/)
    s.dispose()
  })

  it('display 三态：完成通知类覆写 false / 非通知类透传 true/false/undefined（ref 与 reducer 一致）', () => {
    const s = makeStore()
    const sid = 's-custom-display'
    const cases: Array<{ payload: Record<string, unknown>; expected: boolean | undefined }> = [
      // 完成通知类：pi 生产端写 display:true（pi TUI 语义）→ 覆写 false（即使透传 true）
      { payload: { customType: 'subagent-bg-notify', content: 'a', display: true }, expected: false },
      { payload: { customType: 'workflow-result', content: 'b', display: true }, expected: false },
      // 完成通知类 + 无 display 字段 → 同样覆写 false（customType 判定即覆写条件）
      { payload: { customType: 'workflow-result', content: 'b2' }, expected: false },
      // 非通知类三态透传：false 隐藏 / true 显示 / undefined 安全显示
      { payload: { customType: 'goal-context', content: 'c', display: false }, expected: false },
      { payload: { customType: 'future-notify', content: 'd', display: true }, expected: true },
      { payload: { customType: 'legacy-notify', content: 'e' }, expected: undefined },
    ]
    for (const c of cases) {
      s.store.applyMessageEvent(sid, customStartMsg(sid, c.payload))
    }
    const refMsgs = s.store.getMessages(sid)
    const reducerMsgs = s.store.testInternals._entryStatesForTest.get(sid)!.messages
    expect(refMsgs).toHaveLength(cases.length)
    for (let i = 0; i < cases.length; i++) {
      expect(refMsgs[i].display).toBe(cases[i].expected)
      expect(reducerMsgs[i].display).toBe(cases[i].expected)
    }
    // 抽一条（goal-context，display:false）对照重开：归一后逐字段一致
    // （live payload 无 details → 对照 entry 同步不带 details）
    const goalReload = replayEntries([persistedCustomEntry({
      id: 'entry-goal', customType: 'goal-context', content: 'c', display: false, details: undefined,
    })])
    expect(stripVolatile(reducerMsgs[3])).toEqual(stripVolatile(goalReload.messages[0]))
    s.dispose()
  })

  it('message_end（role custom）去双计：customStart 已喂，message_end 持久化回声不再入 reducer/ref', () => {
    const s = makeStore()
    const sid = 's-custom-dedup'
    // pi 时序：message_start（custom）→ customStart 喂入
    s.store.applyMessageEvent(sid, customStartMsg(sid, {
      customType: 'subagent-bg-notify', content: 'done', display: true, details: { id: 'j' },
    }))
    // message_end（同一 message 对象的持久化回声，event-adapter handleMessageEnd 重构形态）
    s.store.applyMessageEvent(sid, {
      type: 'message.message_end',
      payload: {
        sessionId: sid,
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(1724066400000).toISOString(),
          message: { role: 'custom', customType: 'subagent-bg-notify', content: 'done', display: true, details: { id: 'j' }, timestamp: 1724066400000 },
        },
      },
    } as ServerMessage)
    // 单点喂入：reducer 与 ref 各一条（双管线残留或回退去双计守卫时此处为 2 条 → 红）
    expect(s.store.testInternals._entryStatesForTest.get(sid)!.messages).toHaveLength(1)
    expect(s.store.getMessages(sid)).toHaveLength(1)
    s.dispose()
  })

  it('畸形 details（string）→ undefined：与重开 isLooseRecord 同语义（不再恒空对象 {}）', () => {
    const s = makeStore()
    const sid = 's-custom-details'
    s.store.applyMessageEvent(sid, customStartMsg(sid, {
      customType: 'legacy-notify', content: 'x', details: 'not-a-record',
    }))
    const refMsgs = s.store.getMessages(sid)
    const reducerMsgs = s.store.testInternals._entryStatesForTest.get(sid)!.messages
    // 实时侧：窄化到 undefined（apply-entry isLooseRecord 守卫），与重开一致
    expect(refMsgs[0].details).toBeUndefined()
    expect(reducerMsgs[0].details).toBeUndefined()
    // 重开侧同 entry 同结果
    const reload = replayEntries([persistedCustomEntry({
      customType: 'legacy-notify', content: 'x', details: 'not-a-record', display: undefined,
    })])
    expect(reload.messages[0].details).toBeUndefined()
    expect(stripVolatile(reducerMsgs[0])).toEqual(stripVolatile(reload.messages[0]))
    s.dispose()
  })

  it('多条 custom 通知：每条独立 entry id（ref 无重复 id）+ reducer 逐条累积', () => {
    const s = makeStore()
    const sid = 's-custom-multi'
    for (let i = 0; i < 3; i++) {
      s.store.applyMessageEvent(sid, customStartMsg(sid, {
        customType: 'subagent-bg-notify', content: `notify-${i}`, display: true, details: { id: `job-${i}` },
      }))
    }
    const refMsgs = s.store.getMessages(sid)
    const reducerMsgs = s.store.testInternals._entryStatesForTest.get(sid)!.messages
    expect(refMsgs).toHaveLength(3)
    expect(reducerMsgs).toHaveLength(3)
    const ids = new Set(refMsgs.map((m) => m.id))
    expect(ids.size).toBe(3)
    // ref 与 reducer 逐条同 id 同内容
    for (let i = 0; i < 3; i++) expect(refMsgs[i]).toEqual(reducerMsgs[i])
    s.dispose()
  })
})
