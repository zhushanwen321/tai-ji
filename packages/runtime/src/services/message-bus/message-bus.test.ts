/**
 * MessageBus 单元测试（wave:bus-core，D5 topic 三分类改造 wave:perf-w06）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/message-bus/message-bus.test.ts
 *
 * 覆盖 TC1-TC11（5 方法 + 3 错误路径 ES1/ES2/ES4 + 3 不变量）+ D5 分流语义：
 * - TC1：publish 分配 per-session 单调 seq（1→2→3，state/stream 类分配，transient 不分配）。
 * - TC2：publish 广播给所有 OPEN subscribers（三类 topic 共用出口）。
 * - TC3：subscribe 返回 ring snapshot（浅拷贝）+ lastSeq。
 * - TC4：unsubscribe 取消单 session 订阅 + 反查表清理。
 * - TC5：unsubscribeAll 清理 ws 的全部 session 订阅。
 * - TC6：clearSession 删除整个 SessionBusState + 反查表清理。
 * - TC7：ring 覆盖写——满时淘汰最旧（O(1)），不阻塞 publish。
 * - TC8：双向不变量——sessions[sid].subscribers ↔ wsSubscriptions[ws] 一致。
 * - TC9：publish 到非 OPEN（readyState!==1）ws 不发。
 * - TC10：state topic typeKey 覆盖（同 typeKey 新消息覆盖旧）。
 * - TC11：subscribe 返回 stateSnapshot（state topic last-value，含 D5-2 补全的
 *   session.state_changed 与修正的 session.workflowUpdate）。
 * - D5-1：topicOf 分类表 + miss fallback=stream（R-07）。
 * - D5-1：transient 消息无 seq、不入 ring、不推进 seq 计数。
 * - D5-3/R-03：state+stream 混合 session 正常重连不误报 gap；ring 溢出后 gap=true 全量回放。
 * - ES1：clearSession 对不存在 session no-op（幂等）。
 * - ES2：unsubscribe / unsubscribeAll 对未订阅 ws no-op（幂等）。
 * - ES4：publish 时单个 ws.send 抛错——不影响其它 ws 与 publish。
 */
import { describe, it, expect, vi } from 'vitest'
import type { ServerMessage } from '@taiji/shared'
import { MessageBus, topicOf } from './message-bus.js'
import type { BusClient } from './types.js'

// ── mock helpers ─────────────────────────────────────────────

/**
 * 创建 mock BusClient。sent 数组捕获所有 send 调用，便于断言广播内容与次数。
 * readyState 默认 1（OPEN）。
 */
function createMockClient(readyState: number = 1): BusClient & { sent: string[] } {
  const sent: string[] = []
  return {
    readyState,
    send: (data: string) => {
      sent.push(data)
    },
    sent,
  }
}

/**
 * 创建 mock ServerMessage。默认 stream topic（message.message_start——D5 后 text_delta 是
 * transient 不分配 seq，seq 相关测试默认用 stream 类），payload 带 sessionId。
 * state / transient topic 测试用 type 参数覆盖。
 */
function createMockMessage(
  type: string = 'message.message_start',
  payload: Record<string, unknown> = {},
): ServerMessage {
  return {
    type,
    payload: { sessionId: 'test-sid', ...payload },
  } as ServerMessage
}

/**
 * 复刻 session-message-handler subscribe case 的 gap 判定表达式（R-03：gap 唯一判定点），
 * 让 bus 层测试可以直接断言 handler 视角的 gap 结论。
 */
function handlerGapFrom(result: { snapshot: ServerMessage[] }, fromSeq: number): boolean {
  const oldestSeq = result.snapshot[0]?.seq ?? 0
  return fromSeq < oldestSeq
}

describe('MessageBus', () => {
  // ── TC1：publish 分配 per-session 单调 seq ──────────────────────
  it('TC1: publish assigns per-session monotonic seq (1 -> 2 -> 3)', () => {
    const bus = new MessageBus()
    const sid = 's1'
    // 三次 publish 前 lastSeq 应递增 1→2→3
    let { lastSeq } = bus.subscribe(sid, createMockClient())
    expect(lastSeq).toBe(0) // 订阅时尚无 publish

    bus.publish(sid, createMockMessage())
    ;({ lastSeq } = bus.subscribe(sid, createMockClient()))
    expect(lastSeq).toBe(1)

    bus.publish(sid, createMockMessage())
    bus.publish(sid, createMockMessage())
    ;({ lastSeq } = bus.subscribe(sid, createMockClient()))
    expect(lastSeq).toBe(3)
  })

  it('TC1b: seq is per-session isolated (independent counters)', () => {
    const bus = new MessageBus()
    bus.publish('s1', createMockMessage())
    bus.publish('s1', createMockMessage())
    bus.publish('s2', createMockMessage())
    // s1 seq=2, s2 seq=1，互不影响
    expect(bus.subscribe('s1', createMockClient()).lastSeq).toBe(2)
    expect(bus.subscribe('s2', createMockClient()).lastSeq).toBe(1)
  })

  // ── TC2：publish 广播给所有 OPEN subscribers ──────────────────────
  it('TC2: publish broadcasts to all OPEN subscribers', () => {
    const bus = new MessageBus()
    const sid = 's1'
    const ws1 = createMockClient()
    const ws2 = createMockClient()
    bus.subscribe(sid, ws1)
    bus.subscribe(sid, ws2)

    const msg = createMockMessage()
    bus.publish(sid, msg)

    expect(ws1.sent).toHaveLength(1)
    expect(ws2.sent).toHaveLength(1)
    // 广播内容是 JSON.stringify(message)，现在含 seq
    const received1 = JSON.parse(ws1.sent[0])
    const received2 = JSON.parse(ws2.sent[0])
    expect(received1.seq).toBe(1)
    expect(received1.type).toBe('message.message_start')
    expect(received2.seq).toBe(1)
    expect(received2.type).toBe('message.message_start')
  })

  // ── TC1c：多条 publish 的 seq 递增 ──────────────────────
  it('publish 分配 per-session seq，多条递增', () => {
    const bus = new MessageBus(10)
    const ws = createMockClient()
    bus.subscribe('s1', ws)
    bus.publish('s1', createMockMessage('a'))
    bus.publish('s1', createMockMessage('b'))
    bus.publish('s1', createMockMessage('c'))
    expect(JSON.parse(ws.sent[0]).seq).toBe(1)
    expect(JSON.parse(ws.sent[1]).seq).toBe(2)
    expect(JSON.parse(ws.sent[2]).seq).toBe(3)
  })

  // ── TC1d：不同 session 的 seq 独立递增 ──────────────────────
  it('不同 session 的 seq 独立递增', () => {
    const bus = new MessageBus(10)
    const ws = createMockClient()
    bus.subscribe('a', ws)
    bus.subscribe('b', ws)
    bus.publish('a', createMockMessage('x'))
    bus.publish('b', createMockMessage('y'))
    bus.publish('a', createMockMessage('z'))
    // session-a: seq 1, 2; session-b: seq 1
    // ws.sent[0] = a:x seq1, ws.sent[1] = b:y seq1, ws.sent[2] = a:z seq2
    expect(JSON.parse(ws.sent[0]).seq).toBe(1) // session a, first
    expect(JSON.parse(ws.sent[1]).seq).toBe(1) // session b, first
    expect(JSON.parse(ws.sent[2]).seq).toBe(2) // session a, second
  })

  // ── TC1e：subscribe snapshot 中消息带 seq ──────────────────────
  it('subscribe 返回的 snapshot 中消息带 seq', () => {
    const bus = new MessageBus(10)
    const ws = createMockClient()
    bus.publish('s1', createMockMessage('a'))
    bus.publish('s1', createMockMessage('b'))
    const result = bus.subscribe('s1', ws)
    expect(result.snapshot[0].seq).toBe(1)
    expect(result.snapshot[1].seq).toBe(2)
    expect(result.lastSeq).toBe(2)
  })

  // ── TC3：subscribe 返回 ring snapshot + stateSnapshot + lastSeq ──────────────────────
  it('TC3: subscribe returns ring snapshot (shallow copy) + lastSeq', () => {
    const bus = new MessageBus()
    const sid = 's1'
    const m1 = createMockMessage()
    const m2 = createMockMessage()
    bus.publish(sid, m1)
    bus.publish(sid, m2)

    const { snapshot, lastSeq } = bus.subscribe(sid, createMockClient())
    expect(lastSeq).toBe(2)
    expect(snapshot).toHaveLength(2)
    expect(snapshot[0]).toBe(m1) // ring 内部引用
    expect(snapshot[1]).toBe(m2)
  })

  it('TC3b: subscribe snapshot is a shallow copy (mutating it does not affect ring)', () => {
    const bus = new MessageBus()
    const sid = 's1'
    bus.publish(sid, createMockMessage())
    const { snapshot } = bus.subscribe(sid, createMockClient())
    snapshot.pop() // 外部修改

    // 内部 ring 不受影响：再次 subscribe 仍拿到 1 条
    const { snapshot: snapshot2 } = bus.subscribe(sid, createMockClient())
    expect(snapshot2).toHaveLength(1)
  })

  // ── TC4：unsubscribe 取消单 session 订阅 ──────────────────────
  it('TC4: unsubscribe removes ws from single session subscribers + reverse map', () => {
    const bus = new MessageBus()
    const sid = 's1'
    const ws = createMockClient()
    bus.subscribe(sid, ws)
    bus.publish(sid, createMockMessage())
    expect(ws.sent).toHaveLength(1)

    bus.unsubscribe(sid, ws)
    bus.publish(sid, createMockMessage())

    // 取消订阅后不再收新消息
    expect(ws.sent).toHaveLength(1)
  })

  it('TC4b: unsubscribe keeps ws subscribed to other sessions', () => {
    const bus = new MessageBus()
    const ws = createMockClient()
    bus.subscribe('s1', ws)
    bus.subscribe('s2', ws)

    bus.unsubscribe('s1', ws)
    bus.publish('s2', createMockMessage())

    // s2 订阅仍在，能收到 s2 的广播
    expect(ws.sent).toHaveLength(1)
  })

  // ── TC5：unsubscribeAll 清理 ws 全部 session 订阅 ──────────────────────
  it('TC5: unsubscribeAll removes ws from all sessions', () => {
    const bus = new MessageBus()
    const ws = createMockClient()
    bus.subscribe('s1', ws)
    bus.subscribe('s2', ws)
    bus.subscribe('s3', ws)

    bus.unsubscribeAll(ws)

    bus.publish('s1', createMockMessage())
    bus.publish('s2', createMockMessage())
    bus.publish('s3', createMockMessage())

    // 三个 session 都不再广播给 ws
    expect(ws.sent).toHaveLength(0)
  })

  // ── TC6：clearSession 删除整个 SessionBusState ──────────────────────
  it('TC6: clearSession deletes the whole SessionBusState + cleans reverse map', () => {
    const bus = new MessageBus()
    const sid = 's1'
    const ws1 = createMockClient()
    const ws2 = createMockClient()
    bus.subscribe(sid, ws1)
    bus.subscribe(sid, ws2)
    bus.publish(sid, createMockMessage())
    expect(ws1.sent).toHaveLength(1)

    bus.clearSession(sid)

    // 清除后该 session 不再广播给原订阅者
    bus.publish(sid, createMockMessage())
    expect(ws1.sent).toHaveLength(1)
    expect(ws2.sent).toHaveLength(1)

    // 清除后重新 subscribe 是全新状态：lastSeq 已被新 publish 推进到 1，
    // 但 ring 仅有 1 条（清除前的历史已丢）。验证 clearSession 把旧 ring/seq 清零：
    // 不 publish 直接 subscribe（全新 bus 对照），seqCounter 应为 0。
    const freshBus = new MessageBus()
    const freshSub = freshBus.subscribe(sid, createMockClient())
    expect(freshSub.lastSeq).toBe(0)
    expect(freshSub.snapshot).toHaveLength(0)
    // 原 bus 清除后再 publish 1 条：ring 只有这 1 条新消息（旧 2 条已丢）
    const { snapshot } = bus.subscribe(sid, createMockClient())
    expect(snapshot).toHaveLength(1)
  })

  it('TC6b: clearSession cleans wsSubscriptions reverse map (ws can resubscribe cleanly)', () => {
    const bus = new MessageBus()
    const sid = 's1'
    const ws = createMockClient()
    bus.subscribe(sid, ws)
    bus.clearSession(sid)

    // unsubscribeAll 不应误删（反查表已清，ws entry 不存在）
    expect(() => bus.unsubscribeAll(ws)).not.toThrow()

    // 重新 subscribe 后 unsubscribeAll 能正确清理
    bus.subscribe(sid, ws)
    bus.unsubscribeAll(ws)
    bus.publish(sid, createMockMessage())
    expect(ws.sent).toHaveLength(0)
  })

  // ── TC7：ring 覆盖写满时淘汰最旧（D5-3 O(1)）──────────────────────
  it('TC7: ring overwrites oldest when full (O(1) ring buffer), does not block publish', () => {
    const bus = new MessageBus(3) // 小容量便于测试
    const sid = 's1'
    bus.publish(sid, createMockMessage('message.message_start', { n: 1 }))
    bus.publish(sid, createMockMessage('message.complete', { n: 2 }))
    bus.publish(sid, createMockMessage('message.status', { n: 3 }))

    // 容量 3，再 publish 应覆盖最旧（n:1）
    bus.publish(sid, createMockMessage('message.error', { n: 4 }))

    const { snapshot } = bus.subscribe(sid, createMockClient())
    expect(snapshot).toHaveLength(3)
    // 淘汰最旧 n:1，保留 n:2,3,4，且按 seq 顺序导出
    expect((snapshot[0].payload as { n: number }).n).toBe(2)
    expect((snapshot[1].payload as { n: number }).n).toBe(3)
    expect((snapshot[2].payload as { n: number }).n).toBe(4)

    // seq 仍单调递增（publish 不被阻塞）——4 次 publish 后 lastSeq=4
    expect(bus.subscribe(sid, createMockClient()).lastSeq).toBe(4)
  })

  // ── TC8：双向不变量 sessions[sid].subscribers ↔ wsSubscriptions[ws] ──────────────────────
  it('TC8: bidirectional invariant — subscribe/unsubscribe keep both maps consistent', () => {
    const bus = new MessageBus()
    const ws = createMockClient()
    bus.subscribe('s1', ws)
    bus.subscribe('s2', ws)

    // unsubscribe s1 后，ws 仍在 s2 的 subscribers（反查表不误删）
    bus.unsubscribe('s1', ws)
    bus.publish('s2', createMockMessage())
    expect(ws.sent).toHaveLength(1)

    // unsubscribe s2 后反查表 ws entry 应被清空（集合 size=0 时 delete entry）
    bus.unsubscribe('s2', ws)
    // 再次 subscribe 同一 ws 不应有副作用残留
    bus.subscribe('s3', ws)
    bus.unsubscribeAll(ws)
    bus.publish('s3', createMockMessage())
    expect(ws.sent).toHaveLength(1) // 仅 s2 的 1 条，s3 已 unsubscribeAll
  })

  it('TC8b: invariant holds across clearSession + unsubscribeAll interplay', () => {
    const bus = new MessageBus()
    const ws1 = createMockClient()
    const ws2 = createMockClient()
    bus.subscribe('s1', ws1)
    bus.subscribe('s1', ws2)
    bus.subscribe('s2', ws1)

    bus.clearSession('s1')
    // s1 清除后，ws1 仍订阅 s2，ws2 应无任何订阅
    bus.publish('s2', createMockMessage())
    expect(ws1.sent).toHaveLength(1)
    expect(ws2.sent).toHaveLength(0)

    // ws1 可以干净地 unsubscribeAll（只剩 s2）
    expect(() => bus.unsubscribeAll(ws1)).not.toThrow()
    bus.publish('s2', createMockMessage())
    expect(ws1.sent).toHaveLength(1) // 不再增加
  })

  // ── TC9：publish 到非 OPEN ws 不发 ──────────────────────
  it('TC9: publish does not send to non-OPEN (readyState !== 1) ws', () => {
    const bus = new MessageBus()
    const sid = 's1'
    const openWs = createMockClient(1) // OPEN
    const closedWs = createMockClient(3) // CLOSED
    bus.subscribe(sid, openWs)
    bus.subscribe(sid, closedWs)

    bus.publish(sid, createMockMessage())

    expect(openWs.sent).toHaveLength(1)
    expect(closedWs.sent).toHaveLength(0) // 非 OPEN 不发
  })

  // ── TC10：state topic typeKey 覆盖 ──────────────────────
  it('TC10: state topic typeKey overwrites (same typeKey newer message wins)', () => {
    const bus = new MessageBus()
    const sid = 's1'
    // D5-2 映射：session.commands → 'commands'
    const cmd1 = createMockMessage('session.commands', { commands: [{ name: 'a' }] })
    const cmd2 = createMockMessage('session.commands', { commands: [{ name: 'a' }, { name: 'b' }] })
    bus.publish(sid, cmd1)
    bus.publish(sid, cmd2)

    // D5-1：state 类不入 ring——snapshot 不含 state 消息
    const { snapshot, stateSnapshot, lastSeq } = bus.subscribe(sid, createMockClient())
    expect(snapshot).toHaveLength(0)
    expect(lastSeq).toBe(2) // state 类仍分配 seq（统一计数器，R-03）

    // stateSnapshot 覆盖语义：同 typeKey（'commands'）只保留最新（cmd2），
    // 长度 = 已 publish 的不同 typeKey 数（此处仅 'commands' 1 个）。
    expect(stateSnapshot).toHaveLength(1)
    expect(stateSnapshot[0]).toBe(cmd2)

    // 核心：state topic 与 stream topic 混合 publish 都正常工作。
    const ctxMsg = createMockMessage('context.update', { usagePercent: 50 })
    bus.publish(sid, ctxMsg)
    const sub3 = bus.subscribe(sid, createMockClient())
    // state 不入 ring：snapshot 仍为 0
    expect(sub3.snapshot).toHaveLength(0)
    // stateSnapshot 增至 2 个 typeKey（commands + context）
    expect(sub3.stateSnapshot).toHaveLength(2)
    expect(sub3.lastSeq).toBe(3)
  })

  it('TC10b: non-state topics do not enter stateSnapshot (no typeKey match)', () => {
    const bus = new MessageBus()
    const sid = 's1'
    // message.complete 是 stream 类（不在 STATE_TYPE_KEY_MAP）→ stateTypeKey 返回 null
    bus.publish(sid, createMockMessage('message.complete', { text: 'hi' }))
    const { snapshot, stateSnapshot, lastSeq } = bus.subscribe(sid, createMockClient())
    expect(snapshot).toHaveLength(1)
    // 非 state topic 不进 stateSnapshot
    expect(stateSnapshot).toHaveLength(0)
    expect(lastSeq).toBe(1)
  })

  // ── TC11：subscribe 返回 stateSnapshot（wave:remove-bandaids，D5-2 补全修正后）──────────────────────
  it('TC11: subscribe returns stateSnapshot with 5 state topics last-value (independent from snapshot)', () => {
    const bus = new MessageBus()
    const sid = 's1'
    // 5 个 state topic 各 publish 多次（最后值是最新的）+ 一条 stream 消息
    const cmds = createMockMessage('session.commands', { commands: [{ name: 'cmd' }] })
    const ctx = createMockMessage('context.update', { usagePercent: 42 })
    const subs = createMockMessage('session.subagents', { subagents: [{ subagentId: 's1' }] })
    const wfUpdate = createMockMessage('session.workflowUpdate', { runId: 'w1', status: 'running' })
    const stateChanged = createMockMessage('session.state_changed', { modelId: 'm1', thinkingLevel: 'high' })
    const streamMsg = createMockMessage('message.complete', { text: 'stream' })
    bus.publish(sid, createMockMessage('session.commands', { commands: [] })) // 旧 commands，应被覆盖
    bus.publish(sid, cmds)
    bus.publish(sid, ctx)
    bus.publish(sid, subs)
    bus.publish(sid, wfUpdate)
    bus.publish(sid, stateChanged)
    bus.publish(sid, streamMsg)

    const { snapshot, stateSnapshot, lastSeq } = bus.subscribe(sid, createMockClient())

    // snapshot 只含 stream 消息（D5-1：state 类不入 ring）
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]).toBe(streamMsg)
    // 全部 7 条 publish 都分配 seq（state+stream 统一计数器）
    expect(lastSeq).toBe(7)
    // stateSnapshot 含 5 个 state topic 的最新值（按 typeKey 去重，旧 commands 已被 cmds 覆盖）
    expect(stateSnapshot).toHaveLength(5)
    // 按 type 检索（不依赖数组顺序）
    const findByType = (type: string): ServerMessage =>
      stateSnapshot.find((m) => m.type === type)!
    expect(findByType('session.commands')).toBe(cmds) // 最新 commands
    expect(findByType('context.update')).toBe(ctx)
    expect(findByType('session.subagents')).toBe(subs)
    expect(findByType('session.workflowUpdate')).toBe(wfUpdate)
    expect(findByType('session.state_changed')).toBe(stateChanged)
    // streamMsg 不在 stateSnapshot（非 state topic）
    expect(stateSnapshot.find((m) => m.type === 'message.complete')).toBeUndefined()
  })

  it('TC11b: subscribe stateSnapshot is a shallow copy (mutating it does not affect internal Map)', () => {
    const bus = new MessageBus()
    const sid = 's1'
    bus.publish(sid, createMockMessage('session.commands', { commands: [] }))
    const { stateSnapshot } = bus.subscribe(sid, createMockClient())
    stateSnapshot.pop() // 外部修改

    // 内部 Map 不受影响：再次 subscribe 仍拿到 1 个 typeKey
    const sub2 = bus.subscribe(sid, createMockClient())
    expect(sub2.stateSnapshot).toHaveLength(1)
  })

  it('TC11c: subscribe on never-published session returns empty stateSnapshot', () => {
    const bus = new MessageBus()
    // 从未 publish 的 session：stateSnapshot 为空数组
    const { snapshot, stateSnapshot, lastSeq } = bus.subscribe('fresh', createMockClient())
    expect(snapshot).toHaveLength(0)
    expect(stateSnapshot).toHaveLength(0)
    expect(lastSeq).toBe(0)
  })

  // ── D5-1：topicOf 分类表 + fallback ──────────────────────
  it('D5-1: topicOf classifies known types and falls back to stream on miss (R-07)', () => {
    // state 类
    expect(topicOf('session.commands')).toBe('state')
    expect(topicOf('context.update')).toBe('state')
    expect(topicOf('session.subagents')).toBe('state')
    expect(topicOf('session.workflowUpdate')).toBe('state')
    expect(topicOf('session.state_changed')).toBe('state')
    // stream 类（抽样）
    expect(topicOf('message.message_start')).toBe('stream')
    expect(topicOf('message.complete')).toBe('stream')
    expect(topicOf('message.error')).toBe('stream')
    expect(topicOf('session.exited')).toBe('stream')
    expect(topicOf('terminal.alive')).toBe('stream')
    // extension:* 全族（setEditorText 为 session 级 push 型，W06-M1 补录）
    expect(topicOf('extension:setEditorText')).toBe('stream')
    // transient 类（全量）
    expect(topicOf('message.text_delta')).toBe('transient')
    expect(topicOf('message.thinking_delta')).toBe('transient')
    expect(topicOf('message.thinking_start')).toBe('transient')
    expect(topicOf('message.thinking_end')).toBe('transient')
    expect(topicOf('subagent.stream_delta')).toBe('transient')
    expect(topicOf('terminal.data')).toBe('transient')
    expect(topicOf('message.stream_warn')).toBe('transient')
    expect(topicOf('plugin:viewUpdate')).toBe('transient')
    // 未入表类型 fallback = stream（R-07：与改造前「所有 publish 都入 ring」语义一致，最安全）
    expect(topicOf('message.future_type')).toBe('stream')
    expect(topicOf('whatever.unknown')).toBe('stream')
  })

  it('D5-1/R-07: unknown type behaves as stream — assigns seq and enters ring', () => {
    const bus = new MessageBus(10)
    const sid = 's1'
    bus.publish(sid, createMockMessage('message.future_unknown_type', { n: 1 }))
    const { snapshot, lastSeq } = bus.subscribe(sid, createMockClient())
    // fallback=stream：分配 seq + 入 ring（新增消息类型忘记入表时不产生行为回归）
    expect(lastSeq).toBe(1)
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0].seq).toBe(1)
  })

  // ── D5-1：transient 消息无 seq、不入 ring、不推进 seq 计数 ──────────────────────
  it('D5-1: transient publish sends to subscribers without seq, ring size and seq counter unchanged', () => {
    const bus = new MessageBus(10)
    const sid = 's1'
    const ws = createMockClient()
    bus.subscribe(sid, ws)

    // 先发一条 stream（seq=1）建立基线
    bus.publish(sid, createMockMessage('message.message_start', { n: 'base' }))
    expect(JSON.parse(ws.sent[0]).seq).toBe(1)

    // transient：直传订阅者但无 seq 字段
    bus.publish(sid, createMockMessage('message.text_delta', { delta: 'tok' }))
    bus.publish(sid, createMockMessage('terminal.data', { chunk: 'out' }))
    bus.publish(sid, createMockMessage('plugin:viewUpdate', { view: 'v' }))

    expect(ws.sent).toHaveLength(4)
    const t1 = JSON.parse(ws.sent[1])
    const t2 = JSON.parse(ws.sent[2])
    const t3 = JSON.parse(ws.sent[3])
    // transient 消息无 seq 字段（routeInbound 对无 seq 消息直接 dispatch，不做 gap 检测）
    expect(t1.seq).toBeUndefined()
    expect(t2.seq).toBeUndefined()
    expect(t3.seq).toBeUndefined()
    expect(t1.type).toBe('message.text_delta')

    // ring 长度不变（transient 不入 ring）、seq 计数不变（transient 不分配）
    const { snapshot, lastSeq } = bus.subscribe(sid, createMockClient())
    expect(snapshot).toHaveLength(1) // 仅基线 stream 消息
    expect(lastSeq).toBe(1) // 3 条 transient 未推进计数器
  })

  // ── D5-3/R-03：state+stream 混合 session 正常重连不误报 gap ──────────────────────
  it('D5-3/R-03: state+stream mixed session (5 state + 3 stream) — normal resubscribe has no false gap, snapshots complete', () => {
    const bus = new MessageBus()
    const sid = 's1'
    // 5 条 state（5 个不同 type）+ 3 条 stream 交错 publish
    bus.publish(sid, createMockMessage('session.commands', { commands: [] })) // seq 1
    bus.publish(sid, createMockMessage('message.message_start', { n: 1 })) // seq 2
    bus.publish(sid, createMockMessage('context.update', { usagePercent: 50 })) // seq 3
    bus.publish(sid, createMockMessage('message.tool_call_start', { n: 2 })) // seq 4
    bus.publish(sid, createMockMessage('session.subagents', { subagents: [] })) // seq 5
    bus.publish(sid, createMockMessage('message.complete', { n: 3 })) // seq 6
    bus.publish(sid, createMockMessage('session.workflowUpdate', { runId: 'w1' })) // seq 7
    bus.publish(sid, createMockMessage('session.state_changed', { modelId: 'm1' })) // seq 8

    const result = bus.subscribe(sid, createMockClient())

    // 旧死 gauge（seqCounter > streamRing.length）在此场景恒真（8 > 3）会误报 gap；
    // R-03 后 gap 由 handler 的 fromSeq < ring 最旧 seq 判定——正常重连（fromSeq = lastSeq）不误报。
    expect(result.lastSeq).toBe(8) // state+stream 统一计数器
    expect(result.snapshot).toHaveLength(3) // ring 只存 stream 类
    expect(result.stateSnapshot).toHaveLength(5) // 5 个 state typeKey 的 last-value
    // 模拟 handler 判定（session-message-handler subscribe case 的同构表达式）
    expect(handlerGapFrom(result, result.lastSeq)).toBe(false)
    // 快照完整：snapshot 是 3 条 stream（按 seq 顺序），stateSnapshot 是 5 条 state 最新值
    expect(result.snapshot.map((m) => m.seq)).toEqual([2, 4, 6])
    expect(result.snapshot.every((m) => m.type.startsWith('message.'))).toBe(true)
    const stateTypes = result.stateSnapshot.map((m) => m.type).sort()
    expect(stateTypes).toEqual([
      'context.update',
      'session.commands',
      'session.state_changed',
      'session.subagents',
      'session.workflowUpdate',
    ])
  })

  // ── D5-3：ring 溢出后 oldest seq 正确、gap=true 路径触发全量回放 ──────────────────────
  it('D5-3: after ring overflow, oldest seq is correct and gap=true path serves full snapshot', () => {
    const bus = new MessageBus(3)
    const sid = 's1'
    for (let i = 1; i <= 6; i++) {
      bus.publish(sid, createMockMessage('message.status', { n: i })) // seq 1..6
    }

    const result = bus.subscribe(sid, createMockClient())
    // 溢出后 ring 只剩最近 3 条（seq 4,5,6），oldest seq = 4
    expect(result.snapshot).toHaveLength(3)
    expect(result.snapshot.map((m) => m.seq)).toEqual([4, 5, 6])
    expect(result.lastSeq).toBe(6)

    // 长断线重连（fromSeq=1 早于 ring 最旧 seq 4）→ handler 判定 gap=true → 全量回放
    // （snapshot 不做增量过滤，renderer 触发全量重拉）
    expect(handlerGapFrom(result, 1)).toBe(true)

    // fromSeq 落在 ring 覆盖范围内（如 4）→ 增量模式不误报
    expect(handlerGapFrom(result, 4)).toBe(false)
    expect(handlerGapFrom(result, result.lastSeq)).toBe(false)
  })

  it('D5-3: ring wraps multiple times and still exports in seq order', () => {
    const bus = new MessageBus(3)
    const sid = 's1'
    for (let i = 1; i <= 10; i++) {
      bus.publish(sid, createMockMessage('message.status', { n: i }))
    }
    const { snapshot } = bus.subscribe(sid, createMockClient())
    // 多轮覆盖后仍按 seq 顺序导出（8,9,10），无重复无空洞
    expect(snapshot.map((m) => (m.payload as { n: number }).n)).toEqual([8, 9, 10])
    expect(snapshot.map((m) => m.seq)).toEqual([8, 9, 10])
  })

  // ── ES1：clearSession 对不存在 session no-op（幂等）──────────────────────
  it('ES1: clearSession on non-existent session is a no-op', () => {
    const bus = new MessageBus()
    expect(() => bus.clearSession('nonexistent')).not.toThrow()
  })

  // ── ES2：unsubscribe / unsubscribeAll 对未订阅 ws no-op（幂等）──────────────────────
  it('ES2: unsubscribe / unsubscribeAll on non-subscribed ws are no-ops', () => {
    const bus = new MessageBus()
    const ws = createMockClient()
    // 未订阅任何 session
    expect(() => bus.unsubscribe('s1', ws)).not.toThrow()
    expect(() => bus.unsubscribeAll(ws)).not.toThrow()

    // 已订阅 s1，unsubscribe s2（ws 未订阅 s2）应 no-op，不影响 s1
    bus.subscribe('s1', ws)
    bus.unsubscribe('s2', ws)
    bus.publish('s1', createMockMessage())
    expect(ws.sent).toHaveLength(1) // s1 订阅仍在
  })

  // ── ES4：publish 时单个 ws.send 抛错不影响其它 ws 与 publish ──────────────────────
  it('ES4: a single ws.send throwing does not affect other ws or publish', () => {
    const bus = new MessageBus()
    const sid = 's1'
    const goodWs = createMockClient()
    const throwingWs: BusClient = {
      readyState: 1,
      send: () => {
        throw new Error('ws closed unexpectedly')
      },
    }
    bus.subscribe(sid, throwingWs)
    bus.subscribe(sid, goodWs)

    // 抑制 console.warn 保持测试输出干净
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => bus.publish(sid, createMockMessage())).not.toThrow()
    } finally {
      warnSpy.mockRestore()
    }

    // 抛错的 ws 不阻塞 goodWs 收到广播
    expect(goodWs.sent).toHaveLength(1)
    // publish 主流程继续：seq 递增、ring 写入正常
    expect(bus.subscribe(sid, createMockClient()).lastSeq).toBe(1)
  })
})
