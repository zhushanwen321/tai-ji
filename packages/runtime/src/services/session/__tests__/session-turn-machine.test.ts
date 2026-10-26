/**
 * EventInterpreter（occupancy turn 状态机转移/宣告 / 静态审计 / pingTimer dispose）合并测试。
 *
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper/mock 随节下沉）：
 * - session-turn-machine.test.ts
 * - event-interpreter-ping-dispose.test.ts
 *
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/services/session/__tests__/session-turn-machine.test.ts
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerMessage } from '@taiji/shared'
import { generateTableTests } from '@zhushanwen/state-machine/testing'
import { applySessionOccupancyTransition, announceSessionOccupancy, SESSION_TURN_MACHINE, EventInterpreter, PING_INTERVAL_MS } from '../event-interpreter.js'
import type { SessionOccupancy, SessionOccupancyTransition } from '../types.js'

describe('session-turn-machine', () => {
/**
 * session turn 状态机迁移测试（chat-flow-consistency §3.3 D1，A9 等价性 + 穷举 + 审计三件）。
 *
 * 覆盖映射（承接 test/session-occupancy-transition.test.ts 的原语行为断言，D1 迁移后改写）：
 * 1. generateTableTests 穷举：SESSION_TURN_MACHINE 全组合（4 状态 × 6 事件，每事件 × 每状态
 *    一行，幂等 no-op 也是行）——转移表即文档的机器级锚定；
 * 2. 原语行为：applySessionOccupancyTransition 编排（turn 机器 transition + 布尔维 patch
 *    一次合并写）、幂等去重、payload 形状（四维含 handingOff）、null-safe、未知转移抛错；
 * 3. 词表派发点静态审计（design-turn-statemachine 缺陷 6 配套）：SessionOccupancyTransition
 *    词表每项必须有派发点（src 非测试代码中 'event' 字面量出现在 applySessionOccupancyTransition
 *    调用或其回调转发链）——generateTableTests 的盲区（「事件无人派发」这类死行）在此显式补；
 * 4. 死行零残留：abort-stall-converged / abort-stall-force-kill / reject-processing /
 *    announce-idle 退出词表后 src 全域 grep 零命中（impl-plan U1 验收条款）。
 *
 * mock 策略：纯函数直测 + fs 读源码做审计，零运行时依赖 mock。
 * 运行：pnpm -C packages/runtime exec vitest run src/services/session
 */
type TransitionSession = Parameters<typeof applySessionOccupancyTransition>[0]

function makeSession(overrides: Partial<TransitionSession> = {}): TransitionSession {
  return {
    id: 's1',
    ...overrides,
  }
}

function makePublish() {
  return vi.fn<(sessionId: string, msg: ServerMessage) => void>()
}

function occupancyFrames(publish: ReturnType<typeof makePublish>): Array<SessionOccupancy & { sessionId: string }> {
  return publish.mock.calls
    .map((c) => c[1])
    .filter((m) => m.type === 'session.occupancy')
    .map((m) => m.payload as SessionOccupancy & { sessionId: string })
}

const IDLE_OCC: SessionOccupancy = { turn: 'idle', compacting: false, bash: false, handingOff: false }

// ── 1. 机器穷举（generateTableTests，全组合合法表）──────────────────────────────

generateTableTests(SESSION_TURN_MACHINE, { describeName: 'session-turn 状态机表穷举（D1 全组合合法表）' })

// ── 2. 原语编排行为 ──────────────────────────────────────────────────────────────

describe('applySessionOccupancyTransition：turn 维事件（机器编排 + 广播 payload 四维）', () => {
  it("'dispatching'：turn=dispatching（#1 语义：预检通过、prompt 已发），payload 恒带 handingOff", () => {
    const session = makeSession()
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'dispatching')
    expect(session.occupancy).toEqual({ turn: 'dispatching', compacting: false, bash: false, handingOff: false })
    expect(occupancyFrames(publish)).toEqual([
      { sessionId: 's1', turn: 'dispatching', compacting: false, bash: false, handingOff: false },
    ])
  })

  it("'generating'：绝对式幂等——settling 中再收 generating 仍写 generating（乱序合法形态保留）", () => {
    const session = makeSession({ occupancy: { turn: 'settling', compacting: false, bash: false, handingOff: false } })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'generating')
    expect(session.occupancy?.turn).toBe('generating')
  })

  it("'idle'：turn=idle（#4 语义：agent_settled 终点），正交布尔维不被改写", () => {
    const session = makeSession({ occupancy: { turn: 'settling', compacting: true, bash: true, handingOff: true } })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'idle')
    expect(session.occupancy).toEqual({ turn: 'idle', compacting: true, bash: true, handingOff: true })
  })

  it("'full-reset'：四维全复位（#10 语义：进程死亡 agent_settled 永不到达——机器 idle 行 + 布尔维 patch 编排）", () => {
    const session = makeSession({ occupancy: { turn: 'generating', compacting: true, bash: true, handingOff: true } })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'full-reset')
    expect(session.occupancy).toEqual({ turn: 'idle', compacting: false, bash: false, handingOff: false })
    expect(occupancyFrames(publish)).toEqual([
      { sessionId: 's1', turn: 'idle', compacting: false, bash: false, handingOff: false },
    ])
  })
})

describe('applySessionOccupancyTransition：正交布尔维事件（机器外 patch）', () => {
  it("'compacting-start'：compacting=true，turn 维保留（正交维度不碰 turn）", () => {
    const session = makeSession({ occupancy: { turn: 'generating', compacting: false, bash: false, handingOff: false } })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'compacting-start')
    expect(session.occupancy).toEqual({ turn: 'generating', compacting: true, bash: false, handingOff: false })
  })

  it("'bash-start' / 'bash-end'：bash 维置位复位（#7/#11 语义：与 turn 并存）", () => {
    const session = makeSession({ occupancy: { turn: 'generating', compacting: false, bash: false, handingOff: false } })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'bash-start')
    expect(session.occupancy?.bash).toBe(true)
    applySessionOccupancyTransition(session, { publish }, 'bash-end')
    expect(session.occupancy?.bash).toBe(false)
  })

  it("'handingOff-start' / 'handingOff-end'：交接在途维置位复位（chat-flow-consistency R1，挂点 handoff-service）", () => {
    const session = makeSession({ occupancy: { turn: 'generating', compacting: false, bash: false, handingOff: false } })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'handingOff-start')
    expect(session.occupancy?.handingOff).toBe(true)
    // handoff turn 在跑：handingOff 与 turn=generating 并存（四维正交互不替代）
    expect(session.occupancy?.turn).toBe('generating')
    applySessionOccupancyTransition(session, { publish }, 'handingOff-end')
    expect(session.occupancy?.handingOff).toBe(false)
  })
})

describe('applySessionOccupancyTransition：幂等去重 / 缺省兜底 / null-safe / 防御', () => {
  it('值未变化不重复广播（复用既有全等去重）', () => {
    const session = makeSession()
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'dispatching')
    applySessionOccupancyTransition(session, { publish }, 'dispatching') // 重复同转移
    expect(occupancyFrames(publish)).toHaveLength(1)
  })

  it('occupancy 字段缺省（undefined）按 idle 兜底合并（存量构造点零改动）', () => {
    const session = makeSession() // occupancy 未初始化
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'compacting-start')
    expect(session.occupancy).toEqual({ turn: 'idle', compacting: true, bash: false, handingOff: false })
  })

  it('publish 未注入（null/undefined）：状态照写、广播跳过（null-safe，与既有原语一致）', () => {
    const session = makeSession()
    expect(() => applySessionOccupancyTransition(session, null, 'dispatching')).not.toThrow()
    expect(session.occupancy?.turn).toBe('dispatching')
  })

  it('封闭枚举外无第五种写法：非法转移值 fail-fast（表外值两表均不覆盖即抛，不静默写脏状态）', () => {
    const session = makeSession()
    const publish = makePublish()
    expect(() =>
      applySessionOccupancyTransition(session, { publish }, 'not-a-transition' as SessionOccupancyTransition),
    ).toThrow()
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('announceSessionOccupancy：宣告原语（announce-idle 退出词表后的广播层特例）', () => {
  it('对象初值即 idle：全等去重会短路广播，宣告原语必须照发（registerSession 宣告帧必达）', () => {
    const session = makeSession({ occupancy: { ...IDLE_OCC } })
    const publish = makePublish()
    announceSessionOccupancy(session, { publish })
    expect(session.occupancy).toEqual(IDLE_OCC) // 状态 no-op
    expect(occupancyFrames(publish)).toEqual([{ sessionId: 's1', ...IDLE_OCC }])
  })

  it('非 idle 派生视图同样原样强制广播（宣告的是当前派生视图，不做转移）', () => {
    const session = makeSession({ occupancy: { turn: 'generating', compacting: true, bash: false, handingOff: false } })
    const publish = makePublish()
    announceSessionOccupancy(session, { publish })
    expect(session.occupancy).toEqual({ turn: 'generating', compacting: true, bash: false, handingOff: false })
    expect(occupancyFrames(publish)).toEqual([
      { sessionId: 's1', turn: 'generating', compacting: true, bash: false, handingOff: false },
    ])
  })
})

// ── 3. 词表派发点静态审计（缺陷 6 配套：每词表项必须有派发点）─────────────────────

/** 从源码目录递归收集 .ts 文件（跳过 __tests__ 与 .test.ts）。 */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      out.push(...collectSourceFiles(full))
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('转移词表派发点静态审计（design-turn-statemachine 缺陷 6 配套）', () => {
  const runtimeSrc = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const sourceFiles = collectSourceFiles(runtimeSrc)

  it('SessionOccupancyTransition 词表每项在 src 非测试代码中至少一个派发点（零死行）', () => {
    // 词表全集 = 机器事件 ∪ 布尔维事件（与 event-interpreter.ts 的编排覆盖一致）。
    const vocab: readonly SessionOccupancyTransition[] = [
      ...SESSION_TURN_MACHINE.events,
      'compacting-start', 'compacting-end', 'bash-start', 'bash-end', 'handingOff-start', 'handingOff-end',
    ] as const
    // 派发点判据 = 调用行形态：原语调用行（applySessionOccupancyTransition(）或其回调转发行
    // （onOccupancyTransition?.(）与事件字面量同行。不判「同文件字面量同现」——词表定义文件
    // （types.ts 的 union、event-interpreter.ts 的机器 events 表）天然含全部事件字面量，文件级
    // 同现被结构性命中，审计恒绿（死行检不出，词表键漏写派发点时测试照绿）。回调转发行必须
    // 同列为证据：generating 的唯一派发形态是转发链（interpreter 内 onOccupancyTransition?(
    // 'generating') → 组合根 applySessionOccupancyTransition 接线，字面量不在接线行）。词表
    // 定义行不含调用括号形态，结构性不构成证据（无需文件黑名单）。跨行调用的字面量行不计
    // （保守方向：宁可误报逼人工核对，不漏报死行）；新增中转函数形态时把中转调用名加进本正则。
    const dispatchRe = /applySessionOccupancyTransition\s*\(|onOccupancyTransition\s*\?\.\s*\(/
    const dispatchLines = sourceFiles.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .filter((line) => dispatchRe.test(line)),
    )
    const missing: string[] = []
    for (const event of vocab) {
      const literal = `'${event}'`
      if (!dispatchLines.some((line) => line.includes(literal))) missing.push(event)
    }
    expect(missing).toEqual([])
  })
})

describe('死行零残留（D1 死行清理验收：删词表键后 grep 零命中）', () => {
  const runtimeSrc = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const sourceFiles = collectSourceFiles(runtimeSrc)

  it.each([
    'abort-stall-converged',
    'abort-stall-force-kill',
    'reject-processing',
    'announce-idle',
  ])('退役词表键 %s 在 src 非测试代码零残留', (retired) => {
    // 生产代码零命中（测试 fixture 命中不算——测试可断言退役词的拒绝行为）。
    const hits = sourceFiles.filter((f) => readFileSync(f, 'utf8').includes(`'${retired}'`))
    expect(hits).toEqual([])
  })
})
})

describe('event-interpreter-ping-dispose', () => {
/**
 * B1 pingTimer 泄漏回归（memory-leak-remediation §3.2-B1 / 验收 A1）。
 *
 * 泄漏序列（设计 §2.4 模式四核实链）：pi turn 中崩溃 → onSessionExit → adapter.detach →
 * interpreter.dispose()——事件源已退订，turn-end 永不再达，ping 循环失去唯一停止点
 * （历史场景注：B1 当时有 5s 自动 respawn 使失败计数恒清零、interval 永续；自动 respawn
 * 已随防御机制清查退役，该永续条件不再存在，但 dispose 幂等收尾仍是防线）。
 *
 * 修复：dispose() 补 this.stopPingLoop()（幂等）；已 in-flight 的 pingTick 由既有
 * `pingTimer === null` 检查（SR1）拦截。
 *
 * 锁定：
 * - TC1 respawn 序列：turn-start 起探 → dispose（模拟崩溃收殓）→ 大幅推进时钟，
 *   旧实例 pingPi 零调用、零 stream_warn、零 onSilentAbort；同 sid 新 interpreter
 *   （respawn 产物）起探后 ping 正常工作——证明停的是旧循环、不误伤新实例。
 * - TC2 in-flight tick 检查：tick 已发起（pingPi pending）→ dispose → ping 以失败
 *   resolve（模拟打到已死进程）→ 检查拦截，不计数/不广播/不 abort。
 * - TC3 dispose 幂等 + 未起探实例 dispose 不抛。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/event-interpreter-ping-dispose.test.ts
 */
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

  it('TC2: in-flight pingTick 在 dispose 后被 pingTimer===null 检查拦截（不计数/不广播/不 abort）', async () => {
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
    await vi.advanceTimersByTimeAsync(0) // flush 微任务，让 pingTick 走完检查分支

    // 检查生效：不计数 → 不达 WARN/ABORT 阈值副作用
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
})
