/**
 * u3（B7）单元测试：ring 字节记账——memory-leak-remediation §3.3-B7 纯 A 方案。
 *
 * 覆盖（设计 A2 单测锚 + impl-plan u3 验收条款）：
 * - 预算内多帧驱逐：字节超预算从最旧加速淘汰至回到预算内，记账与实际驻留帧序列化字节一致
 * - 容量覆盖写淘汰同步扣减：capacity 覆盖最旧帧时 bytes 扣减（否则幽灵字节引发误驱逐）
 * - 单帧 > 预算超调下界终止：仅剩最新帧即停、不逐刚 push 帧、不死循环（后续 publish 正常）
 * - truncated 版记账口径：截断档帧按实际入 ring 的 truncated 版字节计（非外层截断前 bytes）
 * - stateSnapshot 覆盖式计量：同 typeKey set 替换按当前值重计（非累计求和），
 *   超预算 warn 仅观测不驱逐（快照存活、ring 不受影响）
 * - 记账不截断：单帧行为完全不变——8-32MB warn 档照旧双完整（wire 收完整帧 + ring 存完整帧）、
 *   32MB 档既有截断照旧双写（wire≡ring 同一份截断版），预算不引入任何单帧截断/丢帧
 *
 * 阈值参数化（对齐 guardOptions 范式）：guard 注入小阈值走真实截断逻辑；ringBudgetBytes
 * 注入小预算走真实驱逐逻辑。纯内存逻辑，不触 fs。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/services/message-bus/__tests__/message-bus-ring-bytes.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'
import type { BusClient } from '../types.js'
import { MessageBus } from '../message-bus.js'
import type { OutboundFrameGuardOptions } from '../outbound-frame-registry.js'

/** 守卫静默档：阈值足够大，测试帧不触发出站守卫（warn/截断都不触发），隔离 B7 变量。 */
const QUIET_OPTS: OutboundFrameGuardOptions = { warnBytes: 8 * 1024 * 1024, truncateBytes: 32 * 1024 * 1024 }

/** 截断启用档（对齐 outbound-frame-guard.test.ts 的 SMALL_OPTS）：告警 1KB / 截断 4KB。 */
const TRUNC_OPTS: OutboundFrameGuardOptions = { warnBytes: 1024, truncateBytes: 4096 }

afterEach(() => {
  vi.restoreAllMocks()
})

// ── helpers ──────────────────────────────────────────────────────

/** mock BusClient（最小契约：readyState + send）。 */
function makeClient(): BusClient & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() } as unknown as BusClient & { send: ReturnType<typeof vi.fn> }
}

function sentMessages(client: ReturnType<typeof makeClient>): ServerMessage[] {
  return client.send.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as ServerMessage)
}

/** stream 类帧（message.status）——pad 撑到目标字节数附近。 */
function makeStreamFrame(n: number, padLen: number): ServerMessage {
  return {
    type: 'message.status',
    payload: { sessionId: 's1', status: 'running', n, pad: 'x'.repeat(padLen) },
  } as ServerMessage
}

/** 未注册类型帧（fallback=stream）：blob 字段守卫不认识，warn 档区间内 passthrough 完整。 */
function makeUnregisteredFrame(blobLen: number): ServerMessage {
  const type: string = 'message.future_unknown_type' // widen：未入表类型不在 ServerMessageType（fallback=stream 语义入口）
  return {
    type,
    payload: { sessionId: 's1', blob: 'y'.repeat(blobLen) },
  } as ServerMessage
}

/** message.message_end 帧（注册表覆盖类型——截断档替换 content 字段的入口）。 */
function makeMessageEndFrame(textLen: number): ServerMessage {
  return {
    type: 'message.message_end',
    payload: {
      sessionId: 's1',
      entry: {
        type: 'message',
        parentId: null,
        timestamp: '2026-09-14T00:00:00.000Z',
        message: { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(textLen) }] },
      },
    },
  } as unknown as ServerMessage
}

/** state 类帧（typeKey='commands'）。 */
function makeCommandsFrame(padLen: number): ServerMessage {
  return {
    type: 'session.commands',
    payload: { sessionId: 's1', commands: [{ name: 'cmd', pad: 'c'.repeat(padLen) }] },
  } as ServerMessage
}

/** 实际序列化字节数（publish 后对象已带 seq，与 ring 驻留份逐字节一致）。 */
function frameBytes(msg: ServerMessage): number {
  return Buffer.byteLength(JSON.stringify(msg), 'utf8')
}

/** ring 当前驻留帧（按 seq 顺序，浅拷贝）——subscribe snapshot 即 ring 窗口行为面。 */
function ringSnapshot(bus: MessageBus, sid = 's1'): ServerMessage[] {
  return bus.subscribe(sid, makeClient()).snapshot
}

/** ring 驻留帧的实际总字节（行为化验证记账口径：Σ 序列化字节）。 */
function ringResidentBytes(frames: ServerMessage[]): number {
  return frames.reduce((acc, m) => acc + frameBytes(m), 0)
}

// ── 预算内多帧驱逐 ─────────────────────────────────────────────────

describe('B7 · 预算内多帧驱逐（超预算从最旧加速淘汰）', () => {
  it('字节累计超预算时从最旧驱逐至回到预算内；记账与实际驻留字节一致', () => {
    const budget = 1100
    const bus = new MessageBus(100, QUIET_OPTS, budget)
    // 每帧 ~356B：3 帧 ~1068 ≤ 1100 全保留；第 4 帧后 ~1424 > 1100 → 淘汰最旧至 ~1068 ≤ 1100
    const f1 = makeStreamFrame(1, 260)
    const f2 = makeStreamFrame(2, 260)
    const f3 = makeStreamFrame(3, 260)
    const f4 = makeStreamFrame(4, 260)
    for (const f of [f1, f2, f3]) bus.publish('s1', f)
    let snap = ringSnapshot(bus)
    expect(snap).toHaveLength(3)
    expect(ringResidentBytes(snap)).toBeLessThanOrEqual(budget)

    bus.publish('s1', f4)
    snap = ringSnapshot(bus)
    // 最旧 f1 被加速淘汰，窗口 = f2,f3,f4（条数上限 100 远未触顶——驱逐由字节预算驱动）
    expect(snap.map((m) => (m.payload as { n: number }).n)).toEqual([2, 3, 4])
    expect(snap[0]).toBe(f2)
    // 记账一致性：驻留字节回到预算内，且恰为实际序列化字节之和（无幽灵增量/漏扣减）
    expect(ringResidentBytes(snap)).toBeLessThanOrEqual(budget)
    expect(ringResidentBytes(snap)).toBe(frameBytes(f2) + frameBytes(f3) + frameBytes(f4))
    // seq 分配不受驱逐影响（4 次 publish，lastSeq=4，无回滚）
    expect(bus.subscribe('s1', makeClient()).lastSeq).toBe(4)
  })

  it('大帧一次跨越预算：一次淘汰多帧至回到预算内（不是每 push 只逐一帧）', () => {
    const budget = 1150
    const bus = new MessageBus(100, QUIET_OPTS, budget)
    const f1 = makeStreamFrame(1, 60)
    const f2 = makeStreamFrame(2, 60)
    const f3 = makeStreamFrame(3, 60)
    for (const f of [f1, f2, f3]) bus.publish('s1', f) // 3×~156B ≈ 468 ≤ 1150
    // 大帧 ~916B：总 ~1384 > 1150 → 淘汰 f1（~156B）后 ~1228 仍 > 1150 → 再淘汰 f2 → ~1072 ≤ 1150
    const big = makeStreamFrame(4, 820)
    bus.publish('s1', big)
    const snap = ringSnapshot(bus)
    expect(snap.map((m) => (m.payload as { n: number }).n)).toEqual([3, 4])
    expect(ringResidentBytes(snap)).toBeLessThanOrEqual(budget)
  })

  it('容量覆盖写淘汰同步扣减：capacity 覆盖最旧帧后 bytes 不留幽灵增量', () => {
    // capacity=2、预算 900B：f1/f2/f3 各 ~356B。容量覆盖淘汰 f1 后实际驻留 = f2+f3 ≈ 712 ≤ 900。
    // 若覆盖写漏扣减（bytes=1068 幽灵）：1068 > 900 会误驱逐 f2——snapshot 断言可判别。
    const budget = 900
    const bus = new MessageBus(2, QUIET_OPTS, budget)
    const f1 = makeStreamFrame(1, 260)
    const f2 = makeStreamFrame(2, 260)
    const f3 = makeStreamFrame(3, 260)
    bus.publish('s1', f1)
    bus.publish('s1', f2)
    bus.publish('s1', f3) // 容量满：覆盖 f1（应扣减其字节）
    const snap = ringSnapshot(bus)
    expect(snap.map((m) => (m.payload as { n: number }).n)).toEqual([2, 3])
    expect(ringResidentBytes(snap)).toBeLessThanOrEqual(budget)
    expect(ringResidentBytes(snap)).toBe(frameBytes(f2) + frameBytes(f3))
  })
})

// ── 单帧 > 预算超调下界终止 ─────────────────────────────────────────

describe('B7 · 单帧超预算超调下界终止（不逐新帧不死循环）', () => {
  it('单帧 > 预算：仅剩最新帧即停，驻留不误逐，publish 同步返回（死循环会挂死测试）', () => {
    const budget = 512
    const bus = new MessageBus(100, QUIET_OPTS, budget)
    const big = makeStreamFrame(1, 2000) // ~2KB > 512 预算（< 守卫阈值，不截断）
    bus.publish('s1', big)
    const snap = ringSnapshot(bus)
    // 下界：仅剩最新帧即停——刚 push 的帧不被逐（驱逐循环 size > 1 终止）
    expect(snap).toHaveLength(1)
    expect(snap[0]).toBe(big)
    // 允许瞬时超调：驻留字节 > 预算是接受态（单帧 truncated ≤32MB > 16MB 同构）
    expect(frameBytes(snap[0])).toBeGreaterThan(budget)
    // seq 正常分配（无回滚），后续 publish 正常推进（不死循环的证据）
    expect(bus.subscribe('s1', makeClient()).lastSeq).toBe(1)
    const next = makeStreamFrame(2, 60)
    bus.publish('s1', next)
    expect(bus.subscribe('s1', makeClient()).lastSeq).toBe(2)
  })

  it('超预算单帧驻留后，后续 push 恢复驱逐能力（大帧被作为最旧淘汰）', () => {
    const budget = 512
    const bus = new MessageBus(100, QUIET_OPTS, budget)
    const big = makeStreamFrame(1, 2000)
    bus.publish('s1', big) // 瞬时超调驻留（size=1 下界）
    const small = makeStreamFrame(2, 60)
    bus.publish('s1', small) // bytes ~2.1KB > 512、size=2 → 淘汰最旧（big）→ ~110 ≤ 512 停
    const snap = ringSnapshot(bus)
    expect(snap.map((m) => (m.payload as { n: number }).n)).toEqual([2])
    expect(ringResidentBytes(snap)).toBeLessThanOrEqual(budget)
  })
})

// ── truncated 版记账口径 ───────────────────────────────────────────

describe('B7 · truncated 版记账口径（截断档帧按实际入 ring 字节计）', () => {
  it('截断档帧按 truncated 版字节记账：不按外层截断前 bytes 高估（防过早驱逐）', () => {
    // 预算 800B：小帧 A ~150B + 截断档帧 B（原始 ~5.5KB → truncated 占位 ~300B）。
    // 正确口径（truncated 版）：~450 ≤ 800 → A、B 都驻留。
    // 错误口径（复用截断前 5.5KB）：~5.6KB > 800 → 驱逐 A 后仍 > 800 → 只剩 B——断言可判别。
    const budget = 800
    const bus = new MessageBus(100, TRUNC_OPTS, budget)
    const ws = makeClient()
    bus.subscribe('s1', ws)
    const A = makeStreamFrame(1, 100)
    const B = makeMessageEndFrame(5000) // > truncate 4KB → replaced（truncated 版入 ring）
    bus.publish('s1', A)
    bus.publish('s1', B)

    const snap = ringSnapshot(bus)
    expect(snap).toHaveLength(2)
    expect(snap[0]).toBe(A) // A 未被过早驱逐 → 证明记账用的是 truncated 版字节
    const truncatedStored = snap[1]!
    const content = (truncatedStored.payload as { entry: { message: { content: Array<{ text: string }> } } }).entry.message.content
    expect(content[0]?.text).toContain('已在传输层截断')
    // 记账一致性：驻留字节 = 实际 truncated 版序列化之和，在预算内且远小于原始 5.5KB 口径
    const resident = ringResidentBytes(snap)
    expect(resident).toBeLessThanOrEqual(budget)
    expect(frameBytes(A) + frameBytes(truncatedStored)).toBe(resident)
  })
})

// ── stateSnapshot 覆盖式计量 ────────────────────────────────────────

describe('B7 · stateSnapshot 覆盖式计量（仅观测，不驱逐）', () => {
  it('同 typeKey set 替换按当前值重计（非累计求和）：缩值替换后不再虚假触发 warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const budget = 500
    const bus = new MessageBus(100, QUIET_OPTS, budget)
    const big = makeCommandsFrame(420) // ~600B（帧骨架 + pad）
    bus.publish('s1', big)
    // 超预算 → warn #1（仅观测信号）
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('stateSnapshot')
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('observe-only')

    // 缩值替换：当前值口径 total = 小帧字节 ≤ 500 → 不再 warn。
    // 累计求和的错误口径会得到 600+~130 > 500 再次触发（虚假）——断言 0 次新增可判别。
    const small = makeCommandsFrame(0) // ~130B
    bus.publish('s1', small)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // 观测不驱逐：快照存活且只留最新值（覆盖语义），ring 不受 state 记账影响
    const sub = bus.subscribe('s1', makeClient())
    expect(sub.stateSnapshot).toHaveLength(1)
    expect(sub.stateSnapshot[0]).toBe(small)
    expect(sub.snapshot).toHaveLength(0)
  })

  it('不同 typeKey 各计当前值：跨 key 累计超预算触发 warn，key 内替换不叠加', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const budget = 500
    const bus = new MessageBus(100, QUIET_OPTS, budget)
    const cmds = makeCommandsFrame(0) // ~130B
    bus.publish('s1', cmds)
    expect(warnSpy).not.toHaveBeenCalled()
    // 第二个 typeKey（context）~450B：跨 key 合计 ~580 > 500 → warn
    const ctx: ServerMessage = {
      type: 'context.update',
      payload: { sessionId: 's1', usagePercent: 50, pad: 'z'.repeat(400) },
    } as ServerMessage
    bus.publish('s1', ctx)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    // 同 key（context）替换为小值：合计回到 ~130+~60 ≤ 500 → 不再新增 warn（当前值口径）
    const ctxSmall: ServerMessage = {
      type: 'context.update',
      payload: { sessionId: 's1', usagePercent: 50 },
    } as ServerMessage
    bus.publish('s1', ctxSmall)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const sub = bus.subscribe('s1', makeClient())
    expect(sub.stateSnapshot.map((m) => m.type).sort()).toEqual(['context.update', 'session.commands'])
  })
})

// ── 记账不截断（单帧行为不变） ───────────────────────────────────────

describe('B7 · 记账不截断（单帧行为完全不变，wire≡ring 同一份）', () => {
  it('8-32MB warn 档（小阈值同构）：超预算也照旧双完整——wire 收完整帧 + ring 存完整帧，不驱逐不截断', () => {
    const budget = 512
    const bus = new MessageBus(100, TRUNC_OPTS, budget) // warn 1KB / truncate 4KB
    const ws = makeClient()
    bus.subscribe('s1', ws)
    const blobLen = 2000 // ~2KB ∈ (warn 1KB, truncate 4KB] → warn 档 passthrough 完整
    const frame = makeUnregisteredFrame(blobLen)
    bus.publish('s1', frame)

    // wire：收到完整帧（blob 原样，无截断无占位）
    const received = sentMessages(ws)
    expect(received).toHaveLength(1)
    expect((received[0]!.payload as { blob: string }).blob).toBe('y'.repeat(blobLen))
    // ring：存完整帧（同一对象引用，字节 > 预算靠下界驻留——记账不改变单帧处置）
    const snap = ringSnapshot(bus)
    expect(snap).toHaveLength(1)
    expect(snap[0]).toBe(frame)
    expect((snap[0]!.payload as { blob: string }).blob).toBe('y'.repeat(blobLen))
    // wire ≡ ring 逐字节一致
    expect(JSON.stringify(received[0])).toBe(JSON.stringify(snap[0]))
  })

  it('32MB 截断档（小阈值同构）：超预算下 wire 与 ring 仍是同一份截断版，预算不引入二次截断/丢帧', () => {
    const budget = 300
    const bus = new MessageBus(100, TRUNC_OPTS, budget) // truncate 4KB
    const ws = makeClient()
    bus.subscribe('s1', ws)
    const original = makeMessageEndFrame(5000) // > 4KB → truncated 版
    bus.publish('s1', original)

    // wire：截断版送达（content 为占位文案——既有行为）
    const received = sentMessages(ws)
    expect(received).toHaveLength(1)
    const wireContent = (received[0]!.payload as { entry: { message: { content: Array<{ text: string }> } } }).entry.message.content
    expect(wireContent[0]?.text).toContain('已在传输层截断')
    // ring：同一份截断版（超预算靠下界驻留，无二次截断）
    const snap = ringSnapshot(bus)
    expect(snap).toHaveLength(1)
    expect(JSON.stringify(snap[0])).toBe(JSON.stringify(received[0]))
    // 入参零污染（既有不变式保持）：调用方持有的 original 仍是完整 5KB 文本
    const originalContent = (original.payload as { entry: { message: { content: Array<{ text: string }> } } }).entry.message.content
    expect(originalContent[0]?.text).toBe('x'.repeat(5000))
  })

  it('预算生效下 seq 连续与广播计数不变：截断版照常占 seq 双写（记账零旁效）', () => {
    const budget = 256
    const bus = new MessageBus(100, TRUNC_OPTS, budget)
    const ws = makeClient()
    bus.subscribe('s1', ws)
    bus.publish('s1', makeStreamFrame(1, 60)) // 小帧 seq 1
    bus.publish('s1', makeMessageEndFrame(5000)) // 截断版占 seq 2
    bus.publish('s1', makeStreamFrame(3, 60)) // 小帧 seq 3
    const received = sentMessages(ws)
    // 三条全部广播（wire 面零变化），seq 连续（无 gap——记账/驱逐不触 seq）
    expect(received).toHaveLength(3)
    expect(received.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(bus.subscribe('s1', makeClient()).lastSeq).toBe(3)
  })

  it('默认构造（16MB 预算）下常规小消息零行为变化：驻留/回放/seq 与既有语义一致', () => {
    const bus = new MessageBus() // 默认 1000 帧 / 16MB 预算 / 生产守卫阈值
    const ws = makeClient()
    bus.subscribe('s1', ws)
    const f1 = makeStreamFrame(1, 200)
    const f2 = makeStreamFrame(2, 200)
    bus.publish('s1', f1)
    bus.publish('s1', f2)
    const sub = bus.subscribe('s1', makeClient())
    expect(sub.snapshot).toHaveLength(2) // 小消息远低于预算：零驱逐
    expect(sub.snapshot[0]).toBe(f1)
    expect(sub.snapshot[1]).toBe(f2)
    expect(sub.lastSeq).toBe(2)
    expect(sentMessages(ws)).toHaveLength(2)
  })
})
