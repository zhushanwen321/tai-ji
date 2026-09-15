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
import { describe, it, expect, vi } from 'vitest'
import { MessageBus } from '../src/services/message-bus/message-bus.js'
import type { ServerMessage } from '@taiji/shared'

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
    // 重连：新 ws 订阅，从 stateSnapshot 恢复占用投影（不依赖当时的 live 广播）
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
