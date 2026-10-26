/**
 * MessageBus topic 通道（TOPIC_TABLE/STATE_TYPE_KEY_MAP 一致性 / btw.* 登记锚定 / session.occupancy）合并测试。
 *
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper/mock 随节下沉）：
 * - state-type-key-map-guard.test.ts
 * - message-bus-occupancy.test.ts
 *
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/services/message-bus/__tests__/state-type-key-map-guard.test.ts
 */

import { describe, it, expect, vi } from 'vitest'
import type { ServerMessage } from '@taiji/shared'
import { TOPIC_TABLE, STATE_TYPE_KEY_MAP, STATE_TYPE_KEY_PAYLOAD_DERIVED, STATE_NO_KEY_TOPICS, MessageBus } from '../message-bus.js'

describe('state-type-key-map-guard', () => {
/**
 * TOPIC_TABLE ↔ STATE_TYPE_KEY_MAP 一致性检查（code-harden RT-1#5）。
 *
 * 此前风险只在 message-bus.ts 注释里自认（「state 类未映射 typeKey 则静默不写快照，
 * 重连派生视图失效」），无机器检查——新增 state 类型漏登记 STATE_TYPE_KEY_MAP 时零红灯、
 * 零日志。本文件把该风险变成测试期检查：
 *
 * 不变量：TOPIC_TABLE 中每个 'state' 类 type 的 typeKey 出处必须三居其一（scheduler-widget-push
 * D3 扩展为两形态登记 + 例外白名单）：
 * ① 静态映射——STATE_TYPE_KEY_MAP 有 typeKey（type → 固定 key，写快照、重连可回放）；
 * ② 派生登记——STATE_TYPE_KEY_PAYLOAD_DERIVED 有派生函数（type → 从 payload 派生 key，
 *    widget 帧的 (session, widgetKey) 粒度去重）；派生 miss（如 widgetKey 缺失/空串）时
 *    运行时按 state-no-key 同款处理（不入快照 + warn 一次，live 不变）；
 * ③ 例外白名单——STATE_NO_KEY_TOPICS 显式登记（带设计理由，现仅
 *    session.subagentEntriesAppended 一例：增量流非 last-value，靠 reducer 幂等 + 快照拉取对账）。
 * 三者都不满足 = 漂移，本测试红。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/message-bus/__tests__/state-type-key-map-guard.test.ts
 */
describe('TOPIC_TABLE ↔ STATE_TYPE_KEY_MAP 一致性检查（RT-1#5）', () => {
  it('每个 state 类 type 都有 typeKey 出处（静态映射 / 派生登记 / 例外白名单三居其一，漏登记即红）', () => {
    const drift: string[] = []
    for (const [type, kind] of Object.entries(TOPIC_TABLE)) {
      if (kind !== 'state') continue
      if (STATE_NO_KEY_TOPICS.has(type)) continue
      if (type in STATE_TYPE_KEY_MAP) continue
      if (type in STATE_TYPE_KEY_PAYLOAD_DERIVED) continue
      drift.push(type)
    }
    expect(
      drift,
      `state 类 type 无 typeKey 出处（重连派生视图将静默失效）：${drift.join(', ')}——补静态映射 STATE_TYPE_KEY_MAP，或载荷派生形态登记进 STATE_TYPE_KEY_PAYLOAD_DERIVED，或确属 state-no-key 形态时登记进 STATE_NO_KEY_TOPICS 并附理由`,
    ).toEqual([])
  })

  it('例外白名单不空转：每项都真实登记为 state 类（例外清单自身不漂移）', () => {
    const stale: string[] = []
    for (const type of STATE_NO_KEY_TOPICS) {
      if (TOPIC_TABLE[type] !== 'state') stale.push(type)
    }
    expect(
      stale,
      `STATE_NO_KEY_TOPICS 存在非 state 类条目（例外已失效，应移除）：${stale.join(', ')}`,
    ).toEqual([])
  })

  it('STATE_TYPE_KEY_MAP 不含非 state 类条目（映射表自身不漂移）', () => {
    const stale: string[] = []
    for (const type of Object.keys(STATE_TYPE_KEY_MAP)) {
      if (TOPIC_TABLE[type] !== 'state') stale.push(type)
    }
    expect(
      stale,
      `STATE_TYPE_KEY_MAP 存在 TOPIC_TABLE 未登记为 state 类的条目：${stale.join(', ')}`,
    ).toEqual([])
  })

  it('STATE_TYPE_KEY_PAYLOAD_DERIVED 不含非 state 类条目（派生登记表自身不漂移）', () => {
    const stale: string[] = []
    for (const type of Object.keys(STATE_TYPE_KEY_PAYLOAD_DERIVED)) {
      if (TOPIC_TABLE[type] !== 'state') stale.push(type)
    }
    expect(
      stale,
      `STATE_TYPE_KEY_PAYLOAD_DERIVED 存在 TOPIC_TABLE 未登记为 state 类的条目：${stale.join(', ')}`,
    ).toEqual([])
  })

  it('已知例外 session.subagentEntriesAppended 在白名单内（锚定既有 state-no-key 形态）', () => {
    expect(STATE_NO_KEY_TOPICS.has('session.subagentEntriesAppended')).toBe(true)
  })

  it('widget 两类型在派生登记表内（锚定 scheduler-widget-push D3 的载荷派生形态）', () => {
    // 锚定意图：widget 帧的快照去重粒度是 (session, widgetKey)，必须走派生登记而非
    // 静态 key（静态 key 会让同 session 多个 widget 互相覆盖）。若未来改回静态映射
    // 或移除派生登记，本断言红——改动者须确认快照粒度语义后同步本文件。
    expect('extension:widget' in STATE_TYPE_KEY_PAYLOAD_DERIVED).toBe(true)
    expect('extension:widgetGui' in STATE_TYPE_KEY_PAYLOAD_DERIVED).toBe(true)
    // 不应同时出现在静态表（一 type 只一形态，防双源歧义）
    expect('extension:widget' in STATE_TYPE_KEY_MAP).toBe(false)
    expect('extension:widgetGui' in STATE_TYPE_KEY_MAP).toBe(false)
  })
})

describe('btw.* TOPIC/STATE 登记锚定（btw-question D6，M2-a；W4b 线枚举帧退役）', () => {
  it('btw.create / btw.remove 纯 RPC reply 不入 TOPIC_TABLE（D6：btw 域无 publish 面）', () => {
    // 锚定意图：create/remove 走 reply 通道（同名 request/reply，broker.reply 直发），
    // 从不经 bus.publish——入表即误导（topicOf 对 reply 无意义，state 登记会造出永空的
    // 快照槽位）。原 btw.list 的 state 登记（typeKey 'btw'）随该消息退役删除：btw 线进
    // 通用列表（session.list {surface:'btw', mainSessionId}，设计 §3.3.1/§5-W4b），
    // create/remove 后不再 publish 线列表帧。若未来确需广播，须先裁决语义再改本断言。
    expect('btw.create' in TOPIC_TABLE).toBe(false)
    expect('btw.remove' in TOPIC_TABLE).toBe(false)
    expect('btw.create' in STATE_TYPE_KEY_MAP).toBe(false)
    expect('btw.remove' in STATE_TYPE_KEY_MAP).toBe(false)
  })

  it('btw.list 已退役：三张登记表（TOPIC_TABLE / STATE_TYPE_KEY_MAP / 派生表 / 例外白名单）零残留', () => {
    // 锚定意图：线枚举消息与其 state 广播面整体收缩——任何一张表残留 'btw.list' 登记
    // 都意味着「零订阅方的死消息面」复活（协议已删、publish 点已删，登记表是最后漏网点）。
    expect('btw.list' in TOPIC_TABLE).toBe(false)
    expect('btw.list' in STATE_TYPE_KEY_MAP).toBe(false)
    expect('btw.list' in STATE_TYPE_KEY_PAYLOAD_DERIVED).toBe(false)
    expect(STATE_NO_KEY_TOPICS.has('btw.list')).toBe(false)
  })
})
})

describe('message-bus-occupancy', () => {
/**
 * message-bus × session.occupancy state topic 单测（session-occupancy-send-closure u5a-p3-runtime ③）。
 *
 * 锁定 TOPIC_TABLE['session.occupancy']='state' + STATE_TYPE_KEY_MAP['session.occupancy']='occupancy'
 * 的机制生效（写快照 / 回放），不重复 MessageBus 通用机制测试（message-bus.test.ts）：
 * - publish occupancy 帧 → 分配 seq + 写 stateSnapshot（key='occupancy'）+ 不入 ring
 * - last-value 覆盖：同 key 两次 publish，快照只留最新
 * - 重连回放：subscribe 返回的 stateSnapshot 含 occupancy 帧（G4 断连/切回恢复）
 * - 非快照帧（stream 类）不覆盖 occupancy key（快照按 typeKey 分区）
 *
 * 运行：cd packages/runtime && npx vitest run test/message-bus-occupancy.test.ts
 */
function occupancyFrame(turn: string, seq?: number): ServerMessage {
  return {
    type: 'session.occupancy',
    ...(seq !== undefined ? { seq } : {}),
    payload: { sessionId: 's1', turn, compacting: false, bash: false },
  } as ServerMessage
}

function makeWs() {
  return { readyState: 1, send: vi.fn() }
}

describe('MessageBus · session.occupancy state topic', () => {
  it('publish occupancy 帧：分配 seq + 写 stateSnapshot（key=occupancy）+ 不入 ring + 推订阅者', () => {
    const bus = new MessageBus()
    const ws = makeWs()
    bus.subscribe('s1', ws)
    bus.publish('s1', occupancyFrame('dispatching'))
    expect(ws.send).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(ws.send.mock.calls[0][0] as string) as ServerMessage
    expect(sent.type).toBe('session.occupancy')
    expect(sent.seq).toBe(1)
    // 快照写入 + 不入 ring：重订阅回放只见 stateSnapshot，ring snapshot 为空
    bus.unsubscribe('s1', ws)
    const replay = bus.subscribe('s1', makeWs())
    expect(replay.snapshot).toHaveLength(0)
    expect(replay.stateSnapshot.map((m) => m.type)).toEqual(['session.occupancy'])
    expect(replay.lastSeq).toBe(1)
  })

  it('last-value 覆盖：同 key 两次 publish 快照只留最新（状态去重语义）', () => {
    const bus = new MessageBus()
    bus.publish('s1', occupancyFrame('dispatching'))
    bus.publish('s1', occupancyFrame('generating'))
    const { stateSnapshot, lastSeq } = bus.subscribe('s1', makeWs())
    expect(stateSnapshot).toHaveLength(1)
    expect((stateSnapshot[0].payload as { turn: string }).turn).toBe('generating')
    expect(lastSeq).toBe(2)
  })

  it('重连回放（G4）：断连前占用中（generating+compacting），重连 subscribe 从快照恢复同值', () => {
    const bus = new MessageBus()
    const wsA = makeWs()
    bus.subscribe('s1', wsA)
    bus.publish('s1', {
      type: 'session.occupancy',
      payload: { sessionId: 's1', turn: 'generating', compacting: true, bash: false },
    } as ServerMessage)
    bus.unsubscribeAll(wsA) // 断连
    // 重连：新 ws 订阅，从 stateSnapshot 恢复占用派生视图（不依赖当时的 live 广播）
    const wsB = makeWs()
    const replay = bus.subscribe('s1', wsB)
    expect(replay.stateSnapshot).toHaveLength(1)
    expect(replay.stateSnapshot[0].payload).toEqual({
      sessionId: 's1', turn: 'generating', compacting: true, bash: false,
    })
  })

  it('快照按 typeKey 分区：stream 类帧不覆盖 occupancy key，occupancy 不冲刷 ring', () => {
    const bus = new MessageBus()
    bus.publish('s1', occupancyFrame('generating'))
    bus.publish('s1', { type: 'message.error', payload: { sessionId: 's1', message: 'x' } } as ServerMessage)
    bus.publish('s1', { type: 'session.state_changed', payload: { sessionId: 's1' } } as unknown as ServerMessage)
    const { stateSnapshot, snapshot } = bus.subscribe('s1', makeWs())
    const keys = stateSnapshot.map((m) => m.type)
    expect(keys).toContain('session.occupancy')
    expect(keys).toContain('session.state_changed')
    expect(stateSnapshot.filter((m) => m.type === 'session.occupancy')).toHaveLength(1)
    // occupancy 是 state 类不入 ring：ring 只含 message.error（stream 类）
    expect(snapshot.map((m) => m.type)).toEqual(['message.error'])
  })

  it('clearSession 清 occupancy 快照（session 销毁 / respawn 清场：无帧 = idle 缺省）', () => {
    const bus = new MessageBus()
    bus.publish('s1', occupancyFrame('generating'))
    bus.clearSession('s1')
    const { stateSnapshot } = bus.subscribe('s1', makeWs())
    expect(stateSnapshot).toHaveLength(0)
  })
})
})
