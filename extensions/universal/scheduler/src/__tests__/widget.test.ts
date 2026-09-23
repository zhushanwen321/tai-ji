import { describe, expect, it, vi } from 'vitest'
import { GUI_WIDGET_MARKER } from '@zhushanwen/extension-protocol'
import type { GuiContext } from '@zhushanwen/extension-protocol'

import {
  buildSchedulerWidgetContent,
  buildSchedulerWidgetGui,
  buildSchedulerWidgetItems,
  computeTasksFingerprint,
  renderSchedulerWidgetTui,
  setSchedulerWidget,
} from '../widget.js'
import type { ScheduledTask } from '../types.js'

const makeTask = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 'abc12345',
  name: 'test task',
  prompt: 'test prompt',
  kind: 'recurring',
  schedule: { mode: 'interval', intervalMs: 60000 },
  enabled: true,
  createdAt: Date.now(),
  nextRunAt: Date.now() + 60000,
  runCount: 0,
  history: [],
  ...overrides,
})

describe('renderSchedulerWidgetTui（D1 静态面契约）', () => {
  it('returns empty array when no tasks', () => {
    expect(renderSchedulerWidgetTui([], 'en-US')).toEqual([])
  })

  it('renders task count', () => {
    const tasks = [makeTask(), makeTask({ id: 'def67890', name: 'another' })]
    const result = renderSchedulerWidgetTui(tasks, 'en-US')
    expect(result[0]).toContain('2 scheduled')
  })

  // 静态面：最近任务行 = 任务名 + 静态调度描述（formatSchedule），无相对时间
  it('renders nearest task with static schedule description, no relative time', () => {
    const tasks = [makeTask({ name: 'check build' })]
    const result = renderSchedulerWidgetTui(tasks, 'en-US')
    expect(result[0]).toContain('check build')
    expect(result[0]).toContain('every 1m')
    // 用户可见文本断言：无 now 派生段（en 相对时间形态 in Xd/Xh/Xm/Xs/now）
    expect(result[0]).not.toMatch(/\bin \d+[dhms]\b/)
    expect(result[0]).not.toContain('now')
  })

  // 逾期标记整体移除：nextRunAt 在过去也不产生 [!] 段（now 派生显示不进静态面）
  it('omits overdue marker even when nextRunAt is in the past', () => {
    const tasks = [makeTask({ nextRunAt: Date.now() - 1000 })]
    const result = renderSchedulerWidgetTui(tasks, 'en-US')
    expect(result[0]).not.toContain('[!]')
    expect(result[0]).not.toContain('overdue')
    // 反例锚点（设计 D1-a）：过期任务仍是最近任务（不用 now 过滤），显示其静态调度描述
    expect(result[0]).toContain('test task')
    expect(result[0]).toContain('every 1m')
  })

  it('starts with [scheduler] prefix (en-US)', () => {
    const tasks = [makeTask()]
    const result = renderSchedulerWidgetTui(tasks, 'en-US')
    expect(result[0]).toMatch(/^\[scheduler\]/)
  })

  // zh-CN 文本行（词典化）
  it('renders localized zh-CN widget line with static schedule text', () => {
    const tasks = [makeTask({ name: 'check build' })]
    const result = renderSchedulerWidgetTui(tasks, 'zh-CN')
    expect(result[0]).toMatch(/^\[定时任务\]/)
    expect(result[0]).toContain('1 条')
    // 静态调度描述（zh interval recurring = 每 X 分钟），非相对时间「X 分钟后」
    expect(result[0]).toContain('每 1 分钟')
    expect(result[0]).not.toContain('分钟后')
  })

  it('renders overdue state as plain static line in zh-CN (no [!] marker)', () => {
    const tasks = [makeTask({ nextRunAt: Date.now() - 1000 })]
    const result = renderSchedulerWidgetTui(tasks, 'zh-CN')
    expect(result[0]).not.toContain('[!]')
    expect(result[0]).not.toContain('已逾期')
  })

  // disabled 任务被过滤：scheduled 计数与最近任务行都只统计 enabled
  it('excludes disabled tasks from counts and nearest-task line', () => {
    const tasks = [
      makeTask({ id: 'enabled1', name: 'active', enabled: true }),
      makeTask({ id: 'disabled1', name: 'inactive', enabled: false, nextRunAt: Date.now() - 1000 }),
    ]
    const result = renderSchedulerWidgetTui(tasks, 'en-US')
    expect(result[0]).toContain('1 scheduled')
    expect(result[0]).toContain('active')
    expect(result[0]).not.toContain('inactive')
  })

  // 最近任务 = nextRunAt 升序首个启用任务（不用 now 过滤）：全部禁用 → 只剩计数段
  it('renders count-only line when all tasks are disabled', () => {
    const tasks = [
      makeTask({ id: 'a1', name: 'one', enabled: false }),
      makeTask({ id: 'b2', name: 'two', enabled: false }),
    ]
    const result = renderSchedulerWidgetTui(tasks, 'en-US')
    expect(result[0]).toContain('0 scheduled')
    expect(result[0]).not.toContain('one')
    expect(result[0]).not.toContain('two')
  })

  // nearest-task 选择：nextRunAt 升序（与 now 无关）
  it('picks the earliest-nextRunAt enabled task as nearest', () => {
    const base = Date.now()
    const tasks = [
      makeTask({ id: 'later1', name: 'later task', nextRunAt: base + 3_600_000 }),
      makeTask({ id: 'sooner1', name: 'sooner task', nextRunAt: base + 60_000 }),
    ]
    const result = renderSchedulerWidgetTui(tasks, 'en-US')
    expect(result[0]).toContain('sooner task')
    expect(result[0]).not.toContain('later task')
  })
})

describe('buildSchedulerWidgetGui（D1 静态面契约）', () => {
  it('emits structured meta with self-owned localized title (en-US)', () => {
    const tasks = [makeTask(), makeTask({ id: 'def67890', name: 'another' })]
    const gui = buildSchedulerWidgetGui(tasks, 'en-US')
    expect(gui.meta).toMatchObject({
      title: 'Scheduled tasks',
      icon: 'clock',
      badge: '2',
      status: 'running',
    })
    expect(gui.meta!.title).not.toBe('')
  })

  // status 翻牌移除：overdue 任务仍是 running（两态 = 有启用任务 running / 空 idle）
  it('keeps running status for overdue tasks (failed flip removed)', () => {
    const tasks = [makeTask({ nextRunAt: Date.now() - 1000 })]
    const gui = buildSchedulerWidgetGui(tasks, 'zh-CN')
    expect(gui.meta!.title).toBe('定时任务')
    expect(gui.meta!.status).toBe('running')
    expect(gui.component.type).toBe('list-tree')
  })

  it('emits idle status for empty-enabled set', () => {
    const gui = buildSchedulerWidgetGui([makeTask({ enabled: false })], 'en-US')
    expect(gui.meta!.status).toBe('idle')
    expect(gui.meta!.badge).toBe('0')
  })

  it('marks disabled tasks with ○ in the body row (renderTaskLineStatic single point)', () => {
    const items = buildSchedulerWidgetItems([makeTask({ enabled: false })], 'zh-CN')
    expect(items[0]!.label.startsWith('○')).toBe(true)
    const enabledItems = buildSchedulerWidgetItems([makeTask({ enabled: true })], 'zh-CN')
    expect(enabledItems[0]!.label.startsWith('●')).toBe(true)
  })

  // GUI body 行静态契约：含静态调度描述，无相对时间/逾期段/执行状态摘要
  it('renders body rows without now-derived segments', () => {
    const now = Date.now()
    const task = makeTask({
      nextRunAt: now - 1000,
      history: [{ at: now - 2000, status: 'failed' }],
      lastStatus: 'failed',
    })
    const items = buildSchedulerWidgetItems([task], 'en-US', now)
    expect(items[0]!.label).toContain('every 1m')
    expect(items[0]!.label).not.toMatch(/\bin \d+[dhms]\b|\d+[dhms] ago\b/)
    expect(items[0]!.label).not.toContain('overdue')
    expect(items[0]!.label).not.toContain('failed')
    expect(items[0]!.label).not.toContain('last:')
  })
})

describe('buildSchedulerWidgetContent', () => {
  it('returns dual content (gui + text) with a non-empty tray title', () => {
    const content = buildSchedulerWidgetContent([makeTask()], 'zh-CN')
    expect(content).toBeDefined()
    expect(content!.gui.meta!.title).toBe('定时任务')
    expect(content!.text[0]).toContain('[定时任务]')
  })

  it('returns undefined for empty tasks (clear branch)', () => {
    expect(buildSchedulerWidgetContent([], 'en-US')).toBeUndefined()
  })
})

describe('setSchedulerWidget', () => {
  function makeCtx(mode: GuiContext['mode']): { ctx: GuiContext; setWidget: ReturnType<typeof vi.fn> } {
    const setWidget = vi.fn()
    const ctx: GuiContext = { mode, hasUI: true, ui: { setWidget } }
    return { ctx, setWidget }
  }

  it('pushes TUI text line in tui mode', () => {
    const { ctx, setWidget } = makeCtx('tui')
    setSchedulerWidget(ctx, [makeTask()])
    expect(setWidget).toHaveBeenCalledTimes(1)
    const [key, lines] = setWidget.mock.calls[0]!
    expect(key).toBe('scheduler')
    expect(lines).toHaveLength(1)
    expect(lines![0]).not.toContain(GUI_WIDGET_MARKER)
  })

  it('pushes marker-encoded structured payload in rpc mode', () => {
    const { ctx, setWidget } = makeCtx('rpc')
    setSchedulerWidget(ctx, [makeTask()])
    expect(setWidget).toHaveBeenCalledTimes(1)
    const [, lines] = setWidget.mock.calls[0]!
    expect(lines![0]).toContain(GUI_WIDGET_MARKER)
  })

  it('clears widget for empty tasks', () => {
    const { ctx, setWidget } = makeCtx('tui')
    setSchedulerWidget(ctx, [])
    expect(setWidget).toHaveBeenCalledWith('scheduler', undefined)
  })
})

// ── D1-b 任务集指纹（computeTasksFingerprint 纯函数契约）──
// 维护不变量：指纹字段集 ⊇ widget 显示决定因素全集（scheduler widget 推送修正设计 D1-b）。
// 显示面 = f(id, name, schedule, kind, enabled, nextRunAt, locale)——以下用例逐字段锁定：
// 变更任一显示决定因素必变指纹，字段不变必同指纹。

describe('computeTasksFingerprint（字段集契约）', () => {
  it('same field set → identical fingerprint (skip-push premise)', () => {
    const now = Date.now()
    const a = computeTasksFingerprint([makeTask({ nextRunAt: now })], 'en-US')
    const b = computeTasksFingerprint([makeTask({ nextRunAt: now })], 'en-US')
    expect(a).toBe(b)
  })

  it('locale is part of the fingerprint (locale switch pushes once)', () => {
    const task = makeTask()
    expect(computeTasksFingerprint([task], 'en-US')).not.toBe(computeTasksFingerprint([task], 'zh-CN'))
  })

  it('kind is part of the fingerprint (display determinant of formatSchedule)', () => {
    const now = Date.now()
    const recurring = makeTask({ kind: 'recurring', nextRunAt: now })
    const once = makeTask({ kind: 'once', nextRunAt: now })
    expect(computeTasksFingerprint([recurring], 'en-US')).not.toBe(computeTasksFingerprint([once], 'en-US'))
  })

  it('each stable display field change alters the fingerprint', () => {
    const base = makeTask()
    const variants: Array<Partial<ScheduledTask>> = [
      { id: 'ffffffff' },
      { name: 'renamed' },
      { schedule: { mode: 'interval', intervalMs: 120000 } },
      { enabled: false },
      { nextRunAt: base.nextRunAt + 1 },
    ]
    const baseFp = computeTasksFingerprint([base], 'en-US')
    for (const variant of variants) {
      expect(computeTasksFingerprint([makeTask(variant)], 'en-US'), JSON.stringify(variant)).not.toBe(baseFp)
    }
  })

  it('non-display runtime state does NOT alter the fingerprint', () => {
    // runCount/history/lastStatus/pending 不在指纹字段集（非显示决定因素——执行摘要只进
    // 命令查询面）。它们变化不触发推送，否则静态期零推送承诺被破坏。
    const base = makeTask()
    const busy = makeTask({
      runCount: 7,
      history: [{ at: base.createdAt, status: 'failed' }],
      lastStatus: 'failed',
      pending: true,
    })
    expect(computeTasksFingerprint([base], 'en-US')).toBe(computeTasksFingerprint([busy], 'en-US'))
  })

  it('task order and empty set are stable (array serialization)', () => {
    const now = Date.now()
    const a = makeTask({ id: 'aaa', nextRunAt: now })
    const b = makeTask({ id: 'bbb', nextRunAt: now + 1 })
    expect(computeTasksFingerprint([a, b], 'en-US')).toBe(computeTasksFingerprint([a, b], 'en-US'))
    expect(computeTasksFingerprint([a, b], 'en-US')).not.toBe(computeTasksFingerprint([b, a], 'en-US'))
    expect(computeTasksFingerprint([], 'en-US')).toBe(computeTasksFingerprint([], 'en-US'))
    expect(computeTasksFingerprint([], 'en-US')).not.toBe(computeTasksFingerprint([a], 'en-US'))
  })
})
