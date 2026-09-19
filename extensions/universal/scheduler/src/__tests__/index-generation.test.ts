// src/__tests__/index-generation.test.ts
//
// G1（S9 review 修复 / R3-M1 模块级化）集成单测：index.ts 装配点为每代 SchedulerRuntime
// 注入代际检测回调（模块级 sessionGeneration 比对），使 stale 分诊不依赖 pi 错误文案。
//
// 两类拓扑：
// - 同闭包重复 fire session_start（rpc-mode bindExtensions 重调等次要路径）——第一组用例
//   在同一 factory 闭包上连续触发验证代数接线。
// - factory 重跑（生产主路径：pi 每次 session 替换 newSession/fork/switchSession 都重跑
//   factory 函数体，loader.ts extensionCache 只缓存 factory 函数对象不缓存执行结果）——
//   装配级用例模拟两次独立 factory() 调用（各自新闭包、共享模块级代数），实证模块级变量
//   跨 factory 重跑保留：第二代 session_start 递增模块级计数器后，第一代 runtime 的
//   isCtxStale 翻转为 true 且其泄漏 timer 在下个 tick 前置检查自停。闭包级实现（R3-M1
//   修复前）在此拓扑下恒 false——正是被 R3 实测证伪的生产失效路径。
//
// 本文件用 InstrumentedRuntime（继承真实 SchedulerRuntime，记录构造参 isCtxStale）
// 捕获注入回调与装配事实。InstrumentedRuntime 全部行为继承父类，不影响装配链本身
// （F1 停旧 timer 等行为由 index-session-start.test.ts U4 锚定，此处不重复）。
// steer 直投模型（scheduler-steer-direct-dispatch）：装配点不再创建 delivery handle，
// runtime 构造收 backend + isCtxStale? + modelOps? 三参（U4：modelOps 缺省 = 无模型
// 切换能力降级）。

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock 共享 logger，让 logger.warn 可被 spy（源码已从 console.warn 改为 logger.warn）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@zhushanwen/pi-extension-logger', () => ({
  getLogger: () => loggerMock,
  createLogger: () => loggerMock,
  setPiHandle: vi.fn(),
}))

// 与 index-session-start.test.ts 同款（MF-3）：mock 掉 importer，装配路径仍被调用、FS 副作用为零。
vi.mock('../importer.js', () => ({ importLegacyStore: vi.fn(() => vi.fn()) }))

// vi.mock factory 会被提升，跨模块共享状态必须经 vi.hoisted。
const { isCtxStaleCaptures, runtimeInstances } = vi.hoisted(() => ({
  isCtxStaleCaptures: [] as Array<(() => boolean) | undefined>,
  runtimeInstances: [] as Array<{ stopScheduler(): void }>,
}))

// InstrumentedRuntime 继承真实实现（loadTasks/onAfterTick/startScheduler 均真实执行），
// 仅捕获构造参（isCtxStale）并登记实例（afterEach 统一停 timer，避免真实 setInterval 残留）。
vi.mock('../runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime.js')>()
  const RealSchedulerRuntime = actual.SchedulerRuntime
  class InstrumentedRuntime extends RealSchedulerRuntime {
    constructor(
      backend: ConstructorParameters<typeof RealSchedulerRuntime>[0],
      isCtxStale?: () => boolean,
    ) {
      super(backend, isCtxStale)
      isCtxStaleCaptures.push(isCtxStale)
      runtimeInstances.push(this)
    }
  }
  return { ...actual, SchedulerRuntime: InstrumentedRuntime }
})

import schedulerExtension from '../index.js'

const TICK_INTERVAL_MS = 30_000

/**
 * 最小 fake pi：与 index-session-start.test.ts 同款，覆盖 factory 消费的 API 面
 * （on 捕获事件 handler 供手动触发；registerTool/registerCommand/sendMessage/appendEntry 兜底）。
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

/** 最小 fake ctx：覆盖 session_start 装配链读到的全部字段（backend 构造 / runtime 构造 / refreshWidget）。 */
function createFakeCtx(sessionFile: string): ExtensionContext {
  return {
    cwd: '/test-index-generation',
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { setWidget: vi.fn() },
    sessionManager: {
      getEntries: () => [],
      getSessionFile: () => sessionFile,
    },
  } as unknown as ExtensionContext
}

describe('G1: index.ts 代际接线（S9）', () => {
  beforeEach(() => {
    isCtxStaleCaptures.length = 0
    runtimeInstances.length = 0
  })

  afterEach(() => {
    for (const rt of runtimeInstances) {
      rt.stopScheduler()
    }
  })

  it('每次 session_start 注入 isCtxStale：当前代 false、任意前代 true（跨三代）', () => {
    const { pi, events } = createMockPi()
    schedulerExtension(pi)
    const sessionStart = events.get('session_start')
    expect(sessionStart).toBeDefined()

    // 第 1 代
    sessionStart!({ type: 'session_start', reason: 'startup' }, createFakeCtx('/test/gen-1.json'))
    expect(isCtxStaleCaptures[0]).toBeTypeOf('function')
    expect(isCtxStaleCaptures[0]!()).toBe(false) // 当前代未替换

    // 第 2 代（session 替换）：第 1 代自此 stale，第 2 代为当前代
    sessionStart!({ type: 'session_start', reason: 'new_session' }, createFakeCtx('/test/gen-2.json'))
    expect(isCtxStaleCaptures[0]!()).toBe(true)
    expect(isCtxStaleCaptures[1]!()).toBe(false)

    // 第 3 代（resume 重入）：前两代均 stale
    sessionStart!({ type: 'session_start', reason: 'resume' }, createFakeCtx('/test/gen-3.json'))
    expect(isCtxStaleCaptures[0]!()).toBe(true)
    expect(isCtxStaleCaptures[1]!()).toBe(true)
    expect(isCtxStaleCaptures[2]!()).toBe(false)
  })

  // ── R3-M1/R3-S5：factory 重跑装配级用例（生产主路径拓扑）──
  // pi 每次 session 替换都重跑 factory 函数体（新闭包）。本用例模拟两次独立 factory()
  // 调用 + 各 fire 一次 session_start，实证「模块级 sessionGeneration 跨 factory 重跑保留」：
  // 闭包级实现（修复前）在第二代 session_start 后 firstStale() 仍恒 false——测试即失败。
  it('factory 重跑：第二次 factory 执行 + session_start 后，第一代 runtime isCtxStale 为 true 且 tick 前置自停', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    loggerMock.warn.mockClear()
    try {
      // 第一代：独立 factory 执行 + session_start 装配（runtime1 真实 startScheduler）
      const first = createMockPi()
      schedulerExtension(first.pi)
      const firstSessionStart = first.events.get('session_start')
      expect(firstSessionStart).toBeDefined()
      firstSessionStart!({ type: 'session_start', reason: 'startup' }, createFakeCtx('/test/factory-rerun-1.json'))
      const firstStale = isCtxStaleCaptures[0]!
      expect(firstStale).toBeTypeOf('function')
      expect(firstStale()).toBe(false) // 第一代是当前代

      // 第二代：再次独立执行 factory（模拟 newSession/fork/switchSession 的 factory 重跑，
      // 新闭包的 service 为 null——第一代闭包的 service 对它不可见，F1 停不到第一代 timer，
      // 复现「F1 未能触达、只剩 G1 前置检查」的泄漏路径）+ session_start
      const second = createMockPi()
      schedulerExtension(second.pi)
      const secondSessionStart = second.events.get('session_start')
      expect(secondSessionStart).toBeDefined()
      secondSessionStart!({ type: 'session_start', reason: 'new_session' }, createFakeCtx('/test/factory-rerun-2.json'))

      // 核心断言：模块级计数器被第二代闭包的 session_start 递增，第一代 runtime 的
      // isCtxStale 生效（闭包级实现在此恒 false——R3-M1 修复的生产失效路径）
      expect(firstStale()).toBe(true)
      expect(isCtxStaleCaptures[1]!()).toBe(false) // 第二代是当前代

      // tick 前置自停：第一代 runtime 的泄漏 timer 在下个 tick 被代际前置检查拦截
      // （G1-b 的生产路径验证：warn "tick stopped" + timer 自停，后续 tick 不再发生）
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS)
      const warnText = loggerMock.warn.mock.calls.map(c => String(c[0])).join('\n')
      expect(warnText).toContain('tick stopped')
      expect(warnText).not.toContain('tick error')

      const warnCountAfterSelfStop = loggerMock.warn.mock.calls.length
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 2) // timer 已停，无新 warn
      expect(loggerMock.warn.mock.calls.length).toBe(warnCountAfterSelfStop)
    } finally {
      vi.useRealTimers()
    }
  })
})
