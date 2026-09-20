import { describe, expect, it, vi } from 'vitest'
import { GUI_WIDGET_MARKER } from '@zhushanwen/extension-protocol'
import type { GuiContext } from '@zhushanwen/extension-protocol'

import {
  buildSchedulerWidgetContent,
  buildSchedulerWidgetGui,
  buildSchedulerWidgetItems,
  renderSchedulerWidget,
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

describe('renderSchedulerWidgetTui', () => {
  it('returns empty array when no tasks', () => {
    expect(renderSchedulerWidgetTui([], 'en-US')).toEqual([])
  })

  it('renders task count', () => {
    const tasks = [makeTask(), makeTask({ id: 'def67890', name: 'another' })]
    const result = renderSchedulerWidgetTui(tasks, 'en-US')
    expect(result[0]).toContain('2 scheduled')
  })

  it('renders next upcoming task', () => {
    const tasks = [makeTask({ name: 'check build' })]
    const result = renderSchedulerWidgetTui(tasks, 'en-US')
    expect(result[0]).toContain('check build')
    expect(result[0]).toContain('in')
  })

  it('renders overdue count', () => {
    const tasks = [makeTask({ nextRunAt: Date.now() - 1000 })]
    const result = renderSchedulerWidgetTui(tasks, 'en-US')
    expect(result[0]).toContain('1 overdue')
  })

  it('starts with [scheduler] prefix (en-US)', () => {
    const tasks = [makeTask()]
    const result = renderSchedulerWidgetTui(tasks, 'en-US')
    expect(result[0]).toMatch(/^\[scheduler\]/)
  })

  // zh-CN 文本行（词典化）
  it('renders localized zh-CN widget line', () => {
    const tasks = [makeTask({ name: 'check build' })]
    const result = renderSchedulerWidgetTui(tasks, 'zh-CN')
    expect(result[0]).toMatch(/^\[定时任务\]/)
    expect(result[0]).toContain('1 条')
    expect(result[0]).toContain('分钟后')
  })

  it('renders overdue count in zh-CN', () => {
    const tasks = [makeTask({ nextRunAt: Date.now() - 1000 })]
    const result = renderSchedulerWidgetTui(tasks, 'zh-CN')
    expect(result[0]).toContain('[!] 1 条已逾期')
  })

  // disabled 任务被过滤：scheduled 计数与 overdue/upcoming 都只统计 enabled
  it('excludes disabled tasks from counts', () => {
    const tasks = [
      makeTask({ id: 'enabled1', name: 'active', enabled: true }),
      makeTask({ id: 'disabled1', name: 'inactive', enabled: false, nextRunAt: Date.now() - 1000 }),
    ]
    const result = renderSchedulerWidgetTui(tasks, 'en-US')
    expect(result[0]).toContain('1 scheduled')
    expect(result[0]).not.toContain('1 overdue')
    expect(result[0]).toContain('active')
    expect(result[0]).not.toContain('inactive')
  })

  // 生产入口（无 locale 参数）保持旧导出形态：经 readUiLocale() 解析（默认 en-US）
  it('renderSchedulerWidget keeps legacy signature and renders via resolved locale', () => {
    const result = renderSchedulerWidget([makeTask()])
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('1 scheduled')
  })
})

describe('buildSchedulerWidgetGui', () => {
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

  it('emits localized title (zh-CN) and overdue status', () => {
    const tasks = [makeTask({ nextRunAt: Date.now() - 1000 })]
    const gui = buildSchedulerWidgetGui(tasks, 'zh-CN')
    expect(gui.meta!.title).toBe('定时任务')
    expect(gui.meta!.status).toBe('failed')
    expect(gui.component.type).toBe('list-tree')
  })

  it('marks disabled tasks with ○ in the body row (renderTaskLine single point)', () => {
    const items = buildSchedulerWidgetItems([makeTask({ enabled: false })], 'zh-CN')
    expect(items[0]!.label.startsWith('○')).toBe(true)
    const enabledItems = buildSchedulerWidgetItems([makeTask({ enabled: true })], 'zh-CN')
    expect(enabledItems[0]!.label.startsWith('●')).toBe(true)
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
