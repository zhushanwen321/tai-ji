import { describe, expect,it } from 'vitest'

import type { ScheduledTask } from '../types.js'
import { renderSchedulerWidget } from '../widget.js'

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

describe('renderSchedulerWidget', () => {
  it('returns empty array when no tasks', () => {
    expect(renderSchedulerWidget([])).toEqual([])
  })

  it('renders task count', () => {
    const tasks = [makeTask(), makeTask({ id: 'def67890', name: 'another' })]
    const result = renderSchedulerWidget(tasks)
    expect(result[0]).toContain('2 scheduled')
  })

  it('renders next upcoming task', () => {
    const tasks = [makeTask({ name: 'check build' })]
    const result = renderSchedulerWidget(tasks)
    expect(result[0]).toContain('check build')
    expect(result[0]).toContain('in')
  })

  it('renders overdue count', () => {
    const tasks = [makeTask({ nextRunAt: Date.now() - 1000 })]
    const result = renderSchedulerWidget(tasks)
    expect(result[0]).toContain('1 overdue')
  })

  it('starts with [scheduler] prefix', () => {
    const tasks = [makeTask()]
    const result = renderSchedulerWidget(tasks)
    expect(result[0]).toMatch(/^\[scheduler\]/)
  })

  // disabled 任务被过滤：scheduled 计数与 overdue/upcoming 都只统计 enabled
  it('excludes disabled tasks from counts', () => {
    const tasks = [
      makeTask({ id: 'enabled1', name: 'active', enabled: true }),
      makeTask({ id: 'disabled1', name: 'inactive', enabled: false, nextRunAt: Date.now() - 1000 }),
    ]
    const result = renderSchedulerWidget(tasks)
    expect(result[0]).toContain('1 scheduled')
    expect(result[0]).not.toContain('1 overdue')
    expect(result[0]).toContain('active')
    expect(result[0]).not.toContain('inactive')
  })
})
