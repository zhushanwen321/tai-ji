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
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateTableTests } from '@zhushanwen/state-machine/testing'
import { applySessionOccupancyTransition, announceSessionOccupancy, SESSION_TURN_MACHINE } from '../event-interpreter.js'
import type { ServerMessage } from '@taiji/shared'
import type { SessionOccupancy, SessionOccupancyTransition } from '../types.js'

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
    const missing: string[] = []
    for (const event of vocab) {
      const literal = `'${event}'`
      const hit = sourceFiles.some((f) => {
        const text = readFileSync(f, 'utf8')
        if (!text.includes('applySessionOccupancyTransition')) return false
        return text.includes(literal)
      })
      if (!hit) missing.push(event)
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
  ])(' retired 词表键 %r 在 src 非测试代码零残留', (retired) => {
    // 生产代码零命中（测试 fixture 命中不算——测试可断言退役词的拒绝行为）。
    const hits = sourceFiles.filter((f) => readFileSync(f, 'utf8').includes(`'${retired}'`))
    expect(hits).toEqual([])
  })
})
