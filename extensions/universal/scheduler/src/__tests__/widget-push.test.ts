// src/__tests__/widget-push.test.ts
//
// scheduler widget 推送（D1 指纹跳推）集成单测：
// 走 index.ts 真实装配链（session_start → runtime.onAfterTick → refreshWidget），
// 观测面 = ctx.ui.setWidget 调用序列（每个实际推送恰一次调用——跳推判定在
// setSchedulerWidget 之前，setWidgetDual 的 TUI 分支与清屏分支都落 setWidget）。
//
// 行为契约（scheduler widget 推送修正设计 D1-b）：
// - 任务集指纹不变 → 跳推（时间流逝不是状态变化，静态期零推送——G1；跨原保活窗口
//   时长仍零推送，锁定原 D2 保活底线帧已随 idle reaper 退役不回归）
// - 空任务集同样静态期零推送（清屏帧只推一次）
// - fail-open：指纹计算异常即推送（宁可多推不可漏显）+ warn 留痕
// - locale 入指纹：切语言一次推送自愈（集成臂；kind 字段在 widget.test.ts 纯函数臂锁定）
//
// timer 红线：fake timers（vitest useFakeTimers），静置用大步进 advance（fake 无墙钟成本）。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// MF-3（与 sdk-contract.test.ts 同款）：mock importer，session_start 装配零 FS 副作用。
vi.mock('../importer.js', () => ({ importLegacyStore: vi.fn(() => vi.fn()) }))

// mock 共享 logger（与 index-generation.test.ts 同款）：fail-open 用例断言 warn 留痕。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@zhushanwen/pi-extension-logger', () => ({
  getLogger: () => loggerMock,
  createLogger: () => loggerMock,
  setPiHandle: vi.fn(),
}))

import schedulerExtension from '../index.js'
import { TICK_INTERVAL_MS } from '../runtime.js'
import { TASK_ENTRY_TYPE } from '../types.js'
/** 原保活窗口时长（10min；原 D2 已退役）——静态用例静置越过后断言仍零推送。 */
const RETIRED_KEEPALIVE_WINDOW_MS = 10 * 60 * 1000
const BASE = Date.parse('2026-01-01T00:00:00Z')

/** 构造一个远期到期的启用任务 upsert entry（owner = sessionFile，避免 fork owner 过滤）。 */
function taskEntry(sessionFile: string, overrides: Record<string, unknown> = {}) {
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
        nextRunAt: BASE + 3_600_000, // 远期到期：测试时间窗内无 dispatch 噪音
        runCount: 0,
        history: [],
        ...overrides,
      },
    },
  }
}

function createMockPi(): { pi: ExtensionAPI; events: Map<string, (...args: unknown[]) => void> } {
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

/** fake ctx：entries 注入任务（owner = sessionFile）；setWidget 独立导出作观测面。 */
function createFakeCtx(sessionFile: string, entries: unknown[] = []): {
  ctx: ExtensionContext
  setWidget: ReturnType<typeof vi.fn>
} {
  const setWidget = vi.fn()
  const ctx = {
    cwd: '/test-widget-push',
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { setWidget },
    sessionManager: {
      getEntries: () => entries,
      getSessionFile: () => sessionFile,
    },
  } as unknown as ExtensionContext
  return { ctx, setWidget }
}

describe('widget 推送判定（D1 指纹跳推）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE)
    loggerMock.warn.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('D1: 任务集静态期间零推送——静置越过原保活窗口仍零推送（D2 退役不回归）', async () => {
    const { pi, events } = createMockPi()
    schedulerExtension(pi)
    const sessionStart = events.get('session_start')!
    const { ctx, setWidget } = createFakeCtx('/test/wp-static.json', [taskEntry('/test/wp-static.json')])
    sessionStart({ type: 'session_start', reason: 'startup' }, ctx)
    expect(setWidget).toHaveBeenCalledTimes(1) // 首帧必推（实例态重置）

    // 静置越过原保活窗口（10min + 2 个 tick）：指纹相同 → 零推送（无保活底线帧）
    await vi.advanceTimersByTimeAsync(RETIRED_KEEPALIVE_WINDOW_MS + 2 * TICK_INTERVAL_MS)
    expect(setWidget).toHaveBeenCalledTimes(1)
  })

  it('D1: 空任务集静态期零推送（清屏帧只推一次）', async () => {
    const { pi, events } = createMockPi()
    schedulerExtension(pi)
    const sessionStart = events.get('session_start')!
    const { ctx, setWidget } = createFakeCtx('/test/wp-empty.json')
    sessionStart({ type: 'session_start', reason: 'startup' }, ctx)
    expect(setWidget).toHaveBeenCalledTimes(1) // 首帧 = 清屏帧（setWidget(key, undefined)）
    expect(setWidget.mock.calls[0]![1]).toBeUndefined()

    // 静置 30min：空任务集指纹稳定 → 零推送
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(setWidget).toHaveBeenCalledTimes(1)
  })

  it('fail-open: 指纹计算异常 → 该 tick 照常推送 + warn 留痕', async () => {
    const { pi, events } = createMockPi()
    schedulerExtension(pi)
    const sessionStart = events.get('session_start')!
    const file = '/test/wp-failopen.json'
    const { ctx, setWidget } = createFakeCtx(file, [taskEntry(file)])
    sessionStart({ type: 'session_start', reason: 'startup' }, ctx)
    expect(setWidget).toHaveBeenCalledTimes(1)

    // 注入 JSON.stringify 单次抛错（computeTasksFingerprint 是 tick 链上首个 stringify 调用点）
    const stringifySpy = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
      throw new Error('simulated serialization failure')
    })
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS)
    stringifySpy.mockRestore()

    expect(setWidget).toHaveBeenCalledTimes(2) // fail-open：宁可多推不可漏显
    // 用户可见面：fail-open 推出的帧内容正确（静态行完整，非空帧/异常串）
    const frame = String((setWidget.mock.calls[1]![1] as string[])[0] ?? '')
    expect(frame).toContain('keepalive probe')
    const warnText = loggerMock.warn.mock.calls.map(c => String(c[0])).join('\n')
    expect(warnText).toContain('fingerprint')
  })

  it('D1: locale 切换改变指纹 → 下一 tick 推送一次且文本随新语言', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-wp-locale-'))
    try {
      const { pi, events } = createMockPi()
      schedulerExtension(pi)
      const sessionStart = events.get('session_start')!
      const file = '/test/wp-locale.json'
      const { ctx, setWidget } = createFakeCtx(file, [taskEntry(file)])
      sessionStart({ type: 'session_start', reason: 'startup' }, ctx)
      expect(setWidget).toHaveBeenCalledTimes(1)
      expect(String(setWidget.mock.calls[0]![1]?.[0])).toContain('[scheduler]')

      // 切语言（runtime 写 ui-preferences.json 的同款形状）→ 指纹含 locale → 推送自愈
      writeFileSync(join(dir, 'ui-preferences.json'), JSON.stringify({ v: 1, locale: 'zh-CN', updatedAt: 0 }))
      process.env.TAIJI_AGENT_DATA_DIR = dir
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS)
      expect(setWidget).toHaveBeenCalledTimes(2)
      const zhFrame = String(setWidget.mock.calls[1]![1]?.[0] ?? '')
      expect(zhFrame).toContain('[定时任务]')

      // 切语言只推送一次：后续 tick 指纹再度稳定 → 零推送
      await vi.advanceTimersByTimeAsync(5 * TICK_INTERVAL_MS)
      expect(setWidget).toHaveBeenCalledTimes(2)
    } finally {
      delete process.env.TAIJI_AGENT_DATA_DIR
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
