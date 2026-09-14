/**
 * B1 pingTimer 泄漏回归（memory-leak-remediation §3.2-B1 / 验收 A1）。
 *
 * 泄漏序列（设计 §2.4 模式四核实链）：pi turn 中崩溃 → onSessionExit → adapter.detach →
 * interpreter.dispose()——事件源已退订，turn-end 永不再达，ping 循环失去唯一停止点；
 * 5s 后 respawn 为同 sessionId 生成新 client，pingPi 的 pm.getClient(sessionId) 延迟解析
 * 打到新 client 必然成功 → pingFailCount 恒清零 → 3 次失败自停永不成立 → interval 永续
 * （且 ping 双向 touch lastActivityAt 钉死 idle-pi-reaper 回收）。
 *
 * 修复：dispose() 补 this.stopPingLoop()（幂等）；已 in-flight 的 pingTick 由既有
 * `pingTimer === null` 守卫（SR1）拦截。
 *
 * 锁定：
 * - TC1 respawn 序列：turn-start 起探 → dispose（模拟崩溃收殓）→ 大幅推进时钟，
 *   旧实例 pingPi 零调用、零 stream_warn、零 onSilentAbort；同 sid 新 interpreter
 *   （respawn 产物）起探后 ping 正常工作——证明停的是旧循环、不误伤新实例。
 * - TC2 in-flight tick 守卫：tick 已发起（pingPi pending）→ dispose → ping 以失败
 *   resolve（模拟打到已死进程）→ 守卫拦截，不计数/不广播/不 abort。
 * - TC3 dispose 幂等 + 未起探实例 dispose 不抛。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/event-interpreter-ping-dispose.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventInterpreter, PING_INTERVAL_MS } from '../event-interpreter.js'
import type { ServerMessage } from '@xyz-agent/shared'

const SID = 'sid-ping-b1'

function makePingInterpreter(pingPi: () => Promise<Record<string, unknown> | undefined>) {
  const sent: ServerMessage[] = []
  const onSilentAbort = vi.fn()
  const interp = new EventInterpreter(SID, {
    send: (m: ServerMessage) => { sent.push(m) },
    pingPi,
    onSilentAbort,
  })
  return { interp, sent, onSilentAbort }
}

describe('B1 pingTimer 泄漏：dispose 停 ping 循环（respawn 序列）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('TC1: dispose 后旧循环永续不再 tick；同 sid respawn 新实例探测正常', async () => {
    // 旧实例（崩溃前的 interpreter）：ping 恒成功（模拟打到 respawn 后的新 client——
    // pm.getClient(sessionId) 延迟解析必然命中新 client，正是泄漏不自停的机制）
    const oldPing = vi.fn(async () => ({ ok: true }) as Record<string, unknown>)
    const old = makePingInterpreter(oldPing)
    old.interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    // 探测已启动：首个 interval tick 确认在跑
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(oldPing.mock.calls.length).toBe(1)

    // 崩溃 → detach → dispose（B1 修复点）
    old.interp.dispose()

    // respawn 等待 + 远超 3 次失败阈值的窗口：旧循环不得再 tick
    await vi.advanceTimersByTimeAsync(60 * PING_INTERVAL_MS)
    expect(oldPing.mock.calls.length).toBe(1) // 只有 dispose 前那一跳
    expect(old.sent.filter(m => m.type === 'message.stream_warn')).toHaveLength(0)
    expect(old.onSilentAbort).not.toHaveBeenCalled()

    // respawn：同 sessionId 的新 interpreter，ping 打到新 client 正常工作
    const newPing = vi.fn(async () => ({ ok: true }) as Record<string, unknown>)
    const revived = makePingInterpreter(newPing)
    revived.interp.interpret([{ kind: 'turn-start', messageId: 'm2' }])
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(newPing.mock.calls.length).toBe(1)
    // 旧实例不被复活影响（互不干扰）
    expect(oldPing.mock.calls.length).toBe(1)
    revived.interp.dispose()
  })

  it('TC2: in-flight pingTick 在 dispose 后被 pingTimer===null 守卫拦截（不计数/不广播/不 abort）', async () => {
    // 手动 deferred：控制 ping 的 resolve 时点落在 dispose 之后（模拟 await 窗口内崩溃收殓）
    let resolvePing: (v: Record<string, unknown> | undefined) => void = () => {}
    const pingPi = vi.fn(() => new Promise<Record<string, unknown> | undefined>((resolve) => {
      resolvePing = resolve
    }))
    const { interp, sent, onSilentAbort } = makePingInterpreter(pingPi)
    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])

    // 触发首个 tick（interval 回调同步启动 async pingTick，挂起在 await pingPi）
    vi.advanceTimersByTime(PING_INTERVAL_MS)
    expect(pingPi).toHaveBeenCalledTimes(1)

    // await 窗口内 dispose（SR1 场景：turn-end/销毁先于 ping 返回）
    interp.dispose()

    // ping 以失败形态 resolve（resolve(undefined)：打到已死进程 / client 未就绪）
    resolvePing(undefined)
    await vi.advanceTimersByTimeAsync(0) // flush 微任务，让 pingTick 走完守卫分支

    // 守卫生效：不计数 → 不达 WARN/ABORT 阈值副作用
    expect(sent.filter(m => m.type === 'message.stream_warn')).toHaveLength(0)
    expect(onSilentAbort).not.toHaveBeenCalled()

    // 后续推进：interval 已清，无新 tick
    await vi.advanceTimersByTimeAsync(10 * PING_INTERVAL_MS)
    expect(pingPi).toHaveBeenCalledTimes(1)
    expect(onSilentAbort).not.toHaveBeenCalled()
  })

  it('TC3: dispose 幂等；未起探实例 dispose 不抛', () => {
    const { interp } = makePingInterpreter(vi.fn(async () => ({}) as Record<string, unknown>))
    expect(() => interp.dispose()).not.toThrow()
    expect(() => interp.dispose()).not.toThrow()
  })
})
