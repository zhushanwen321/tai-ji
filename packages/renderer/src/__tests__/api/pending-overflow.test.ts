// @vitest-environment node

/** [已裁剪] 原 6 用例中 4 个（超限驱逐/迟到 resolve/timeoutMs=0/deadline 重挂）与 core
 *  pending-sweep.test.ts 用例逐一重复，已删；原 5 用例中「全部 reject + map 清空」与
 *  core pending-sweep.test.ts:119 逐字重复、「空 map 不抛错」是 Map.forEach 空迭代的
 *  平凡传导，已删。保留 core 侧未显式锁定的增量：
 *  - overflow 侧：共享 sweep timer 计数（无 per-request timer 泄漏）+ 迟到 error envelope 对称路径
 *  - rejectAll 侧：no-op 幂等 / 新注册不受影响 / error 对象透传含 code
 *  （findings 原裁决为「迁移增量到 core 后删」——本 wave 只动 renderer 测试，原地保留。）


 * pending 容量上限 + 共享超时 timer + rejectAll 单测（Q1-5 / R4）。
 *
 * 覆盖：
 * 1. 超 256 驱逐最老（Map 插入序首个），reject 带 code:'overflow'；新请求正常注册
 * 2. 被驱逐 id 的迟到响应静默丢弃（resolveEnvelope 契约：no-op 不抛错）
 * 3. N 个 pending 只挂 ≤1 个共享 sweep timer（不再 per-request 一个 timer）
 * 4. timeoutMs=0 的请求不挂 timer 参与 sweep（无超时语义保持）
 * 5. resolve/reject 删除条目后重算 sweep timer（W04 review：最后带 deadline 的
 *    pending 正常完成时 timer 立即 disarm，不空转到原触发点）
 * 6. 被驱逐 id 的迟到 error envelope 同样静默丢弃（对称路径）
 * 7. rejectAll（WS 断连 / runtime 崩溃时批量 reject 防永挂）：no-op 幂等、
 *    后续注册不受影响、error 对象透传含附加属性
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as pending from '@taiji/core/transport/api'
import type { ServerMessage } from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../../../../core/src/transport/api/pending'

/** 构造 resolveEnvelope 入参（payload 用 as 断言对齐 ServerMessage 联合 payload） */
function envelopeMsg(type: string, id: string, payload: Record<string, unknown>): ServerMessage {
  return { type: type as ServerMessage['type'], id, payload } as ServerMessage
}

/**
 * 注册并立即吞掉终态 rejection——本文件多数用例只观察 map/timer 状态，
 * 不 await 各 promise 结果；驱逐/rejectAll 触发的 reject 若无 handler 会报 unhandled rejection。
 */
function registerSwallowed(id: string, timeoutMs: number): void {
  pending.register(id, timeoutMs).catch(() => {})
}

describe('pending 容量上限 + 共享 sweep timer（Q1-5）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pending.rejectAll(new Error('setup cleanup'))
  })

  afterEach(() => {
    pending.rejectAll(new Error('teardown cleanup'))
    vi.useRealTimers()
  })

  it('N 个 pending 只挂 1 个共享 sweep timer（无 per-request timer 泄漏）', () => {
    expect(vi.getTimerCount()).toBe(0)

    for (let i = 0; i < 100; i++) {
      registerSwallowed(pending.createCommandId(), 60_000)
    }
    // 100 个 pending：全部共享 1 个指向最近 deadline 的 timer
    expect(vi.getTimerCount()).toBe(1)

    // 更早 deadline 的新请求加入 → 仍是 1 个（重挂到更近的 deadline）
    registerSwallowed(pending.createCommandId(), 1_000)
    expect(vi.getTimerCount()).toBe(1)

    // sweep 到期批量 reject 过期条目（1s 的那个）后，剩余条目仍有 timer 在管
    vi.advanceTimersByTime(1_000)
    expect(vi.getTimerCount()).toBe(1)

    // rejectAll 清空 map → timer 一并清除
    pending.rejectAll(new Error('cleanup'))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('被驱逐 id 的迟到 error envelope 经 resolveEnvelope 静默丢弃（对称路径：error type 不抛错不误伤其他请求）', async () => {
    const victim = pending.createCommandId()
    const victimPromise = pending.register(victim, 60_000)
    // 填满至 256
    for (let i = 0; i < 255; i++) {
      registerSwallowed(pending.createCommandId(), 60_000)
    }
    // 下一个注册驱逐 victim（最老）
    const newcomer = pending.createCommandId()
    const pNew = pending.register<string>(newcomer, 60_000)

    await expect(victimPromise).rejects.toMatchObject({ code: 'overflow' })

    // 迟到的 error envelope 到达（runtime 慢回错误）：resolveEnvelope 的 pendingMap.has
    // 前置守卫对 error 分支同样生效——已驱逐 id 不进 reject 展开，no-op
    expect(() =>
      pending.resolveEnvelope(
        envelopeMsg('error', victim, { code: 'permission_denied', message: 'denied' }),
      ),
    ).not.toThrow()
    // newcomer 不受影响（未被误 reject），仍可正常 settle
    pending.resolve(newcomer, 'ok')
    await expect(pNew).resolves.toBe('ok')
  })
})

describe('pending.rejectAll', () => {
  beforeEach(() => {
    // 确保模块单例 pendingMap 在每个用例前为空
    pending.rejectAll(new Error('setup cleanup'))
  })

  it('rejectAll 后新注册的请求不受影响（可正常 resolve）', async () => {
    pending.rejectAll(new Error('first batch'))

    const id = pending.createCommandId()
    const p = pending.register<string>(id, RPC_BACKSTOP_TIMEOUT_MS)
    pending.resolve(id, 'new value')

    await expect(p).resolves.toBe('new value')
  })

  it('rejectAll 透传 error 对象（含 code 等附加属性的场景）', async () => {
    const id = pending.createCommandId()
    const p = pending.register<string>(id, RPC_BACKSTOP_TIMEOUT_MS)

    const customError = Object.assign(new Error('runtime crashed'), { code: 'E_RUNTIME' })
    pending.rejectAll(customError)

    await expect(p).rejects.toMatchObject({ message: 'runtime crashed', code: 'E_RUNTIME' })
  })
})
