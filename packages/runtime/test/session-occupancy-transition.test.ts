/**
 * applySessionOccupancyTransition 单一转移写原语单测（session-dead-structural-fixes D2，
 * 实施计划 u2 验收条款②：转移表每行至少一断言——合并/派生/去重/announce-idle 强制广播）。
 *
 * 覆盖映射：
 * - 封闭枚举 14 行逐行断言（occupancy 三维 patch + 三布尔派生语义，转移表即文档）；
 * - 幂等去重：非 announce 行值未变化零广播帧；
 * - announce-idle 特例：状态 no-op + 跳过全等去重强制广播当前投影（Gate B V6b④ 语义，
 *   registerSession 宣告帧收编行）；
 * - 通路归属：广播经注入的 publish（= bus.publish state-topic 通路的结构化窄投影），
 *   payload 形状与 shared protocol 'session.occupancy' 一致。
 *
 * mock 策略：纯函数直测，零依赖 mock。
 * 运行：cd packages/runtime && npx vitest run test/session-occupancy-transition.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { applySessionOccupancyTransition } from '../src/services/session/event-interpreter.js'
import type { ServerMessage } from '@taiji/shared'
import type { SessionOccupancy, SessionOccupancyTransition } from '../src/services/session/types.js'

type TransitionSession = Parameters<typeof applySessionOccupancyTransition>[0]

function makeSession(overrides: Partial<TransitionSession> = {}): TransitionSession {
  return {
    id: 's1',
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
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

describe('applySessionOccupancyTransition：turn 四相行（派生 isGenerating）', () => {
  it("'dispatching'：turn=dispatching + isGenerating=true（#1 语义：预检通过、prompt 已发）", () => {
    const session = makeSession()
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'dispatching')
    expect(session.occupancy).toEqual({ turn: 'dispatching', compacting: false, bash: false })
    expect(session.isGenerating).toBe(true)
    expect(occupancyFrames(publish)).toEqual([
      { sessionId: 's1', turn: 'dispatching', compacting: false, bash: false },
    ])
  })

  it("'generating'：turn=generating + isGenerating=true（#2 语义：message_start 驱动）", () => {
    const session = makeSession({ occupancy: { turn: 'dispatching', compacting: false, bash: false }, isGenerating: true })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'generating')
    expect(session.occupancy?.turn).toBe('generating')
    expect(session.isGenerating).toBe(true)
  })

  it("'settling'：turn=settling + isGenerating=false（#3 语义：agent_end 双写合一）", () => {
    const session = makeSession({ occupancy: { turn: 'generating', compacting: false, bash: false }, isGenerating: true })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'settling')
    expect(session.occupancy?.turn).toBe('settling')
    expect(session.isGenerating).toBe(false)
  })

  it("'idle'：turn=idle + isGenerating=false（#4 语义：agent_settled 终点）", () => {
    const session = makeSession({ occupancy: { turn: 'settling', compacting: false, bash: false } })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'idle')
    expect(session.occupancy?.turn).toBe('idle')
    expect(session.isGenerating).toBe(false)
  })
})

describe('applySessionOccupancyTransition：compacting± / bash±（正交维度置位复位）', () => {
  it("'compacting-start'：compacting=true + isCompacting=true（#5 语义），turn 维度不被改写", () => {
    const session = makeSession({ occupancy: { turn: 'generating', compacting: false, bash: false }, isGenerating: true })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'compacting-start')
    expect(session.occupancy).toEqual({ turn: 'generating', compacting: true, bash: false }) // 三维合并且 turn 保留
    expect(session.isCompacting).toBe(true)
    expect(session.isGenerating).toBe(true) // 正交维度不碰 turn 派生
  })

  it("'compacting-end'：compacting=false + isCompacting=false（#6 三路复位语义）", () => {
    const session = makeSession({ occupancy: { turn: 'idle', compacting: true, bash: false }, isCompacting: true })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'compacting-end')
    expect(session.occupancy?.compacting).toBe(false)
    expect(session.isCompacting).toBe(false)
  })

  it("'bash-start'：bash=true + isBashRunning=true（#7 语义：与 turn 并存）", () => {
    const session = makeSession({ occupancy: { turn: 'generating', compacting: false, bash: false }, isGenerating: true })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'bash-start')
    expect(session.occupancy).toEqual({ turn: 'generating', compacting: false, bash: true })
    expect(session.isBashRunning).toBe(true)
  })

  it("'bash-end'：bash=false + isBashRunning=false（#11 成败皆兜底语义）", () => {
    const session = makeSession({ occupancy: { turn: 'idle', compacting: false, bash: true }, isBashRunning: true })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'bash-end')
    expect(session.occupancy?.bash).toBe(false)
    expect(session.isBashRunning).toBe(false)
  })
})

describe('applySessionOccupancyTransition：full-reset / reject 分型 / 预留行', () => {
  it("'full-reset'：三维全复位 + 三布尔全 false（#10 语义：进程死亡 agent_settled 永不到达）", () => {
    const session = makeSession({
      occupancy: { turn: 'generating', compacting: true, bash: true },
      isGenerating: true, isCompacting: true, isBashRunning: true,
    })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'full-reset')
    expect(session.occupancy).toEqual({ turn: 'idle', compacting: false, bash: false })
    expect(session.isGenerating).toBe(false)
    expect(session.isCompacting).toBe(false)
    expect(session.isBashRunning).toBe(false)
    expect(occupancyFrames(publish)).toEqual([
      { sessionId: 's1', turn: 'idle', compacting: false, bash: false },
    ])
  })

  it("'reject-processing'：isGenerating=true + turn=generating（A1 止血转正：pi 拒绝为权威信号反转幽灵空闲）", () => {
    // 现场形态：agent_end 已复位 isGenerating（幽灵空闲），pi 侧 turn 实际在跑
    const session = makeSession({ occupancy: { turn: 'idle', compacting: false, bash: false }, isGenerating: false })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'reject-processing')
    expect(session.isGenerating).toBe(true)
    expect(session.occupancy?.turn).toBe('generating')
  })

  it("'reject-other'：isGenerating=false + turn=idle（compacting 拒绝与非 busy 真失败：turn 没跑起来）", () => {
    const session = makeSession({ occupancy: { turn: 'dispatching', compacting: false, bash: false }, isGenerating: true })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'reject-other')
    expect(session.isGenerating).toBe(false)
    expect(session.occupancy?.turn).toBe('idle')
  })

  it("'abort-stall-converged'（预留行）：turn=idle 派生，行为登记待兄弟分支接线", () => {
    const session = makeSession({ occupancy: { turn: 'generating', compacting: false, bash: false }, isGenerating: true })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'abort-stall-converged')
    expect(session.occupancy?.turn).toBe('idle')
    expect(session.isGenerating).toBe(false)
  })

  it("'abort-stall-force-kill'（预留行）：与 full-reset 同构的三维+三布尔全复位", () => {
    const session = makeSession({
      occupancy: { turn: 'generating', compacting: true, bash: true },
      isGenerating: true, isCompacting: true, isBashRunning: true,
    })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'abort-stall-force-kill')
    expect(session.occupancy).toEqual({ turn: 'idle', compacting: false, bash: false })
    expect(session.isGenerating).toBe(false)
    expect(session.isCompacting).toBe(false)
    expect(session.isBashRunning).toBe(false)
  })
})

describe('applySessionOccupancyTransition：幂等去重与 announce-idle 强制广播', () => {
  it('非 announce 行：值未变化不重复广播（复用既有全等去重）', () => {
    const session = makeSession()
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'dispatching')
    applySessionOccupancyTransition(session, { publish }, 'dispatching') // 重复同转移
    expect(occupancyFrames(publish)).toHaveLength(1)
  })

  it("occupancy 字段缺省（undefined）按 idle 兜底合并（存量构造点零改动）", () => {
    const session = makeSession() // occupancy 未初始化
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'compacting-start')
    expect(session.occupancy).toEqual({ turn: 'idle', compacting: true, bash: false })
  })

  it("'announce-idle'：状态 no-op + 跳过全等去重强制广播当前投影（registerSession 宣告帧收编行）", () => {
    // 对象初值即 idle（registerSession 现场）：全等去重会短路广播，announce 行必须照发
    const session = makeSession({ occupancy: { turn: 'idle', compacting: false, bash: false } })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'announce-idle')
    expect(session.occupancy).toEqual({ turn: 'idle', compacting: false, bash: false }) // 合并/派生 no-op
    expect(session.isGenerating).toBe(false)
    expect(occupancyFrames(publish)).toEqual([
      { sessionId: 's1', turn: 'idle', compacting: false, bash: false },
    ])
  })

  it("'announce-idle'：非 idle 投影同样原样强制广播（宣告的是当前投影，不做转移）", () => {
    const session = makeSession({ occupancy: { turn: 'generating', compacting: true, bash: false } })
    const publish = makePublish()
    applySessionOccupancyTransition(session, { publish }, 'announce-idle')
    expect(session.occupancy).toEqual({ turn: 'generating', compacting: true, bash: false }) // 状态不动
    expect(occupancyFrames(publish)).toEqual([
      { sessionId: 's1', turn: 'generating', compacting: true, bash: false },
    ])
  })

  it('publish 未注入（null/undefined）：状态照写、广播跳过（null-safe，与既有原语一致）', () => {
    const session = makeSession()
    expect(() => applySessionOccupancyTransition(session, null, 'dispatching')).not.toThrow()
    expect(session.occupancy?.turn).toBe('dispatching')
    expect(session.isGenerating).toBe(true)
  })

  it('封闭枚举外无第五种写法：非法转移值在编译期拦截（运行时形状守卫——表外值 undefined 即抛）', () => {
    // 运行时防御形态断言（编译期由 SessionOccupancyTransition 封闭联合保证）：
    // 表外值查表得 undefined，解构抛 TypeError——不会静默写成脏状态。
    const session = makeSession()
    const publish = makePublish()
    expect(() =>
      applySessionOccupancyTransition(session, { publish }, 'not-a-transition' as SessionOccupancyTransition),
    ).toThrow()
    expect(publish).not.toHaveBeenCalled()
  })
})
