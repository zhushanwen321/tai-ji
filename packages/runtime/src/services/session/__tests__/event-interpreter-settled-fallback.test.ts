/**
 * [RT-4#2 / RT-4#9] EventInterpreter settling 终态兜底 + ping 生命期 + 未知 kind 守卫。
 *
 * 锁定三条不变量（code-harden RT-4#2 审计修复）：
 * - SC1 settled 副作用抛错（onAgentSettled 的 bash flush publish 炸）→ occupancy 终态
 *   'idle' 仍必达（此前 settling→idle 唯一边沿 = agent_settled 处理链，链内抛错 =
 *   occupancy 永久 settling、消息恒入 defer 队列）。
 * - SC2 ping 生命期 = turn-start → agent_settled：turn-end（settling 期）ping 继续
 *   探测（pi 收尾挂死时 3 次失败触发 onSilentAbort），settled 处理后停（防 B1 永续）。
 * - SC3 未知 kind（类型外运行时构造）落 handleMetaEvent default warn，不静默丢弃。
 *
 * （原 RT-4#2③ UserStoppedGate 收敛环代数上限组已随 ADR-0112 时间窗收敛环删除一并
 * 移除——「settled 永不到达」场景归 PingProbe → onSilentAbort → forceQuit 显式上报链，
 * 锁定用例见下方 settling 期 pi 真死组。）
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/event-interpreter-settled-fallback.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EventInterpreter,
  PING_INTERVAL_MS,
} from '../event-interpreter.js'
import type { ServerMessage } from '@taiji/shared'
import type { PiTranslatedEvent, SessionOccupancyTransition } from '../types.js'

const SID = 'sid-rt4-settled'

function makeInterpreter(opts: {
  onAgentSettled?: (sessionId: string) => void
  pingPi?: () => Promise<Record<string, unknown> | undefined>
  onOccupancyTransition?: (t: SessionOccupancyTransition) => void
  onSilentAbort?: (p: { sessionId: string }) => void
}) {
  const sent: ServerMessage[] = []
  const interp = new EventInterpreter(SID, {
    send: (m: ServerMessage) => { sent.push(m) },
    onAgentSettled: opts.onAgentSettled,
    pingPi: opts.pingPi,
    onSilentAbort: opts.onSilentAbort,
    onOccupancyTransition: opts.onOccupancyTransition,
  })
  return { interp, sent }
}

describe('[RT-4#2①] settled 副作用抛错 → occupancy 终态 idle 必达', () => {
  it('onAgentSettled 抛错：补写 idle，不中断（settling 不永久滞留）', () => {
    const transitions: SessionOccupancyTransition[] = []
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { interp } = makeInterpreter({
      onAgentSettled: () => { throw new Error('bash flush boom') },
      onOccupancyTransition: (t) => { transitions.push(t) },
    })

    interp.interpret([
      { kind: 'turn-start', messageId: 'm1' },
      { kind: 'turn-end', message: { type: 'message.complete', payload: { sessionId: SID, stopReason: 'end_turn' } }, stopReason: 'end_turn' },
      { kind: 'agent-settled' },
    ])

    // 抛错被隔离：settled 处理链的 'idle' 兜底仍写入（applyAgentSettledEffects 内部
    // 'idle' 未达 → runAgentSettledEffects catch 补写）
    expect(transitions).toContain('idle')
    // 错误落日志（不静默）
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('正常链：settled → idle 写入一次（幂等链路不重复报错）', () => {
    const transitions: SessionOccupancyTransition[] = []
    const { interp } = makeInterpreter({
      onOccupancyTransition: (t) => { transitions.push(t) },
    })
    interp.interpret([{ kind: 'agent-settled' }])
    expect(transitions).toEqual(['idle'])
  })
})

describe('[RT-4#2②] ping 生命期 = turn-start → agent_settled', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('turn-end 后 ping 继续探测（settling 期零探测已消除），agent-settled 后停止', async () => {
    const pingPi = vi.fn(async () => ({ ok: true }) as Record<string, unknown>)
    const { interp } = makeInterpreter({ pingPi })

    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(pingPi).toHaveBeenCalledTimes(1)

    // turn-end：settling 期 ping 不停（修复点——原实现此处 stop）
    interp.interpret([
      { kind: 'turn-end', message: { type: 'message.complete', payload: { sessionId: SID, stopReason: 'end_turn' } }, stopReason: 'end_turn' },
    ])
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 2)
    expect(pingPi).toHaveBeenCalledTimes(3)

    // agent-settled：ping 停止（turn 间不探测，AC-3 语义保留）
    interp.interpret([{ kind: 'agent-settled' }])
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 10)
    expect(pingPi).toHaveBeenCalledTimes(3)
  })

  it('settling 期 pi 真死：连续失败达阈值触发 onSilentAbort（settling 期有 no-progress 检测）', async () => {
    const pingPi = vi.fn(async () => undefined) // resolve(undefined) = 计失败（AC-9）
    const onSilentAbort = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { interp } = makeInterpreter({ pingPi, onSilentAbort })

    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    interp.interpret([
      { kind: 'turn-end', message: { type: 'message.complete', payload: { sessionId: SID, stopReason: 'end_turn' } }, stopReason: 'end_turn' },
    ])
    // settling 窗内 3 次失败（turn-end 后不再有事件，模拟 pi finally 前挂死）
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 3)
    expect(onSilentAbort).toHaveBeenCalledWith({ sessionId: SID })
    warnSpy.mockRestore()
  })

  it('settled 副作用抛错也停 ping（finally 收口，防 B1 永续）', async () => {
    const pingPi = vi.fn(async () => ({ ok: true }) as Record<string, unknown>)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { interp } = makeInterpreter({
      pingPi,
      onAgentSettled: () => { throw new Error('boom') },
    })

    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    interp.interpret([{ kind: 'agent-settled' }])
    const countAfterSettled = pingPi.mock.calls.length
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 10)
    expect(pingPi.mock.calls.length).toBe(countAfterSettled)
    vi.restoreAllMocks()
  })
})

describe('[RT-4#9] 未知 kind 运行时兜底（default warn，不静默丢弃）', () => {
  it('类型外 kind（未来新增事件漏接线）落 warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { interp } = makeInterpreter({})
    // 编译期穷尽守卫（assertTranslatedEventHandled）使生产代码不可能构造未知 kind；
    // 运行时防御 = adapter 演进期 / 反序列化边界的类型外值。cast 模拟该形态。
    const futureEvent = { kind: 'future-kind', payload: {} } as unknown as PiTranslatedEvent
    interp.interpret([futureEvent])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unhandled PiTranslatedEvent kind=future-kind'),
    )
    warnSpy.mockRestore()
  })
})
