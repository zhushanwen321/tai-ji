// src/__tests__/index-session-start.test.ts
//
// F1 集成单测（crash-fix U4）：session_start 多发/重入时先停上一代 runtime 的 tick interval。
// 排查结论：dispatch 的 await sendMessage 窗口与 session 替换交错时，旧 session_shutdown 可能
// 永远等不到 → 旧 30s tick timer 泄漏 → 下一 tick 的 refreshWidget 访问 stale ctx.ui 抛错 →
// unhandledRejection → pi 主进程 exit 1。F1 在 session_start 开头幂等 stopScheduler，从源头消灭。
//
// 行为断言口径（验收 U4）：观测面 = onAfterTick → refreshWidget → ctx.ui.setWidget 的调用
// 序列。widget 推送修正（D1 指纹跳推 + D2 保活底线帧）后每次 tick 不再必然推帧——任务集
// 静态期间零推送、空任务集恒零推送，故本套件注入非空任务集、以「跨 10min 保活窗口必推
// 一帧」作为「该 runtime 的 timer 是否还在 tick」的行为观测面（保活帧间隔与 index.ts
// WIDGET_KEEPALIVE_INTERVAL_MS 同值 10min）。F1 缺失时旧 timer 跨窗口必多推一帧，即被捕获。

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 与 sdk-contract.test.ts 同款（MF-3）：session_start 会真实执行 importLegacyStore(ctx.cwd, ...)，
// 触碰用户真实 FS（~/.pi/agent/scheduler/... 的 renameSync/existsSync 探测）。mock 掉 importer
// 模块，装配路径仍被调用、FS 副作用为零。
vi.mock('../importer.js', () => ({ importLegacyStore: vi.fn(() => vi.fn()) }))

import schedulerExtension from '../index.js'
import { TASK_ENTRY_TYPE } from '../types.js'

const TICK_INTERVAL_MS = 30_000
/** 与 index.ts 的 WIDGET_KEEPALIVE_INTERVAL_MS 同值（常量不导出，测试锚定同值）。 */
const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000
const BASE = Date.parse('2026-01-01T00:00:00Z')

/**
 * 最小 fake pi：覆盖 index.ts factory + commands.ts 注册路径消费的 API 面
 * （on / registerTool / registerCommand / sendMessage / appendEntry）。
 * on 捕获事件 handler 供手动触发；sendMessage/appendEntry 为 vi.fn 兜底（本套件无任务 dispatch）。
 */
function createMockPi(): {
  pi: ExtensionAPI
  events: Map<string, (...args: unknown[]) => void>
} {
  const events = new Map<string, (...args: unknown[]) => void>()
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => void) => events.set(event, handler),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI
  return { pi, events }
}

/**
 * 构造远期到期的启用任务 upsert entry（owner = sessionFile，避免 fork owner 过滤）；
 * nextRunAt 取 BASE + 1h，测试时间窗（分钟级）内无 dispatch 噪音，任务集保持静态。
 */
function taskEntry(sessionFile: string) {
  return {
    type: 'custom',
    customType: TASK_ENTRY_TYPE,
    data: {
      op: 'upsert',
      taskId: 'aaaa1111',
      ownerSessionFile: sessionFile,
      task: {
        id: 'aaaa1111',
        name: 'keepalive probe',
        prompt: 'probe prompt',
        kind: 'recurring',
        schedule: { mode: 'interval', intervalMs: 3_600_000 },
        enabled: true,
        createdAt: BASE,
        nextRunAt: BASE + 3_600_000,
        runCount: 0,
        history: [],
      },
    },
  }
}

/**
 * 最小 fake ctx：覆盖 session_start 装配链读到的全部字段——PiSchedulerBackend 构造
 * （sessionManager：getEntries 注入非空任务集）、runtime 装配、refreshWidget（ui.setWidget）。
 * setWidget 以独立引用导出：session_start 初始渲染 + 保活帧是「哪个 runtime 的 timer 还在
 * tick」的行为观测面（每个实际推送恰一次调用）。
 */
function createFakeCtx(sessionFile: string): {
  ctx: ExtensionContext
  setWidget: ReturnType<typeof vi.fn>
} {
  const setWidget = vi.fn()
  const ctx = {
    cwd: '/test-index-session-start',
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { setWidget },
    sessionManager: {
      getEntries: () => [taskEntry(sessionFile)],
      getSessionFile: () => sessionFile,
    },
  } as unknown as ExtensionContext
  return { ctx, setWidget }
}

describe('F1: session_start 停旧 runtime（crash-fix U4）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(BASE))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('U4: 双 session_start 后旧 timer 已停——跨保活窗口只有新 runtime 推帧', async () => {
    const { pi, events } = createMockPi()
    schedulerExtension(pi)
    const sessionStart = events.get('session_start')
    expect(sessionStart).toBeDefined()

    // 第一次 session_start：runtime1 + timer1 启动，初始渲染 1 次
    const first = createFakeCtx('/test/session-1.json')
    sessionStart!({ type: 'session_start', reason: 'startup' }, first.ctx)
    expect(first.setWidget).toHaveBeenCalledTimes(1)

    // 前置因果锚点：静置越过保活窗口，timer1 推一帧保活帧（排除「timer 从未启动」的假绿；
    // 也锁定跳推行为——窗口内其余 tick 零推送）
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + TICK_INTERVAL_MS)
    expect(first.setWidget).toHaveBeenCalledTimes(2)

    // 第二次 session_start（session 替换）：F1 在装配新 runtime 前停掉 timer1
    const second = createFakeCtx('/test/session-2.json')
    sessionStart!({ type: 'session_start', reason: 'new_session' }, second.ctx)
    expect(second.setWidget).toHaveBeenCalledTimes(1) // runtime2 初始渲染（实例态重置，首帧必推）

    // 行为断言（验收口径）：再静置一个保活窗口，只有 runtime2 的 timer 触发推送——
    // F1 缺失时 timer1/timer2 都活着，first 与 second 各再 +1
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + TICK_INTERVAL_MS)
    expect(second.setWidget).toHaveBeenCalledTimes(2) // 恰 +1：新 runtime 正常调度
    expect(first.setWidget).toHaveBeenCalledTimes(2) // 旧 runtime 的 tick 不再发生（timer 已停）
  })
})
