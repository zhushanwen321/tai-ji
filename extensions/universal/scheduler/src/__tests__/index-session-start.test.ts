// src/__tests__/index-session-start.test.ts
//
// F1 集成单测（crash-fix U4）：session_start 多发/重入时先停上一代 runtime 的 tick interval。
// 排查结论：dispatch 的 await sendMessage 窗口与 session 替换交错时，旧 session_shutdown 可能
// 永远等不到 → 旧 30s tick timer 泄漏 → 下一 tick 的 refreshWidget 访问 stale ctx.ui 抛错 →
// unhandledRejection → pi 主进程 exit 1。F1 在 session_start 开头幂等 stopScheduler，从源头消灭。
//
// 行为断言口径（验收 U4）：第二次 session_start 后 advance 30s，tick 引起的 widget 刷新
// 增量恰 +1（只有新 runtime 的 timer 在跑）；F1 缺失时两个 timer 都活着，增量为 +2。
// 观测面说明：session_start 硬编码 new PiSchedulerBackend（now() = Date.now()，无法注入计数），
// 故用 onAfterTick → refreshWidget → ctx.ui.setWidget 的调用计数作为 tick 发生次数的
// 行为观测面（每个 tick 恰好一次，与 backend.now 计数等价）。

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 与 sdk-contract.test.ts 同款（MF-3）：session_start 会真实执行 importLegacyStore(ctx.cwd, ...)，
// 触碰用户真实 FS（~/.pi/agent/scheduler/... 的 renameSync/existsSync 探测）。mock 掉 importer
// 模块，装配路径仍被调用、FS 副作用为零。
vi.mock('../importer.js', () => ({ importLegacyStore: vi.fn(() => vi.fn()) }))

import schedulerExtension from '../index.js'

const TICK_INTERVAL_MS = 30_000

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
 * 最小 fake ctx：覆盖 session_start 装配链读到的全部字段——PiSchedulerBackend 构造
 * （sessionManager）、delivery 内核装配（isIdle/hasPendingMessages，构造器直传 runtime——
 * L2/L3）、importLegacyStore（cwd，已 mock）、refreshWidget（ui.setWidget）。
 * setWidget 以独立引用导出：session_start 初始渲染 + 每次 tick 末 onAfterTick 各调一次，
 * 是「哪个 runtime 的 timer 还在 tick」的行为观测面。
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
      getEntries: () => [],
      getSessionFile: () => sessionFile,
    },
  } as unknown as ExtensionContext
  return { ctx, setWidget }
}

describe('F1: session_start 停旧 runtime（crash-fix U4）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('U4: 双 session_start 后旧 timer 已停——advance 30s tick 引起的刷新恰 +1 而非 +2', async () => {
    const { pi, events } = createMockPi()
    schedulerExtension(pi)
    const sessionStart = events.get('session_start')
    expect(sessionStart).toBeDefined()

    // 第一次 session_start：runtime1 + timer1 启动，初始渲染 1 次
    const first = createFakeCtx('/test/session-1.json')
    sessionStart!({ type: 'session_start', reason: 'startup' }, first.ctx)
    expect(first.setWidget).toHaveBeenCalledTimes(1)

    // 前置因果锚点：advance 30s，timer1 正常 tick 一次（排除「timer 从未启动」的假绿）
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS)
    expect(first.setWidget).toHaveBeenCalledTimes(2)

    // 第二次 session_start（session 替换）：F1 在装配新 runtime 前停掉 timer1
    const second = createFakeCtx('/test/session-2.json')
    sessionStart!({ type: 'session_start', reason: 'new_session' }, second.ctx)
    expect(second.setWidget).toHaveBeenCalledTimes(1) // runtime2 初始渲染

    // 行为断言（验收口径）：再 advance 30s，只有 runtime2 的 timer 触发一次 tick——
    // F1 缺失时 timer1/timer2 都活着，first 与 second 的 spy 各 +1（合计 +2）
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS)
    expect(second.setWidget).toHaveBeenCalledTimes(2) // 恰 +1：新 runtime 正常调度
    expect(first.setWidget).toHaveBeenCalledTimes(2) // 旧 runtime 的 tick 不再发生（timer 已停）
  })
})
