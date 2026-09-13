import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MockSchedulerBackend } from './mock-backend.js'
import { SchedulerRuntime } from '../runtime.js'
import { SchedulerService } from '../service.js'
import { handleSchedule, handleScheduleControl } from '../tool.js'

describe('schedule tool', () => {
  let service: SchedulerService

  beforeEach(() => {
    vi.clearAllMocks()
    const backend = new MockSchedulerBackend()
    service = new SchedulerService(new SchedulerRuntime(backend), () => backend.now())
  })

  it('creates task with duration', async () => {
    const result = await handleSchedule(service, { prompt: 'check build', schedule: '5m' })
    expect(result.content[0]!.text).toContain('Task "check build"')
    const details = result.details as { task: { schedule: { mode: string; intervalMs: number } } }
    expect(details.task.schedule).toEqual({ mode: 'interval', intervalMs: 300000 })
  })

  // W4：业务失败 throw（pi 只对 execute throw 置 isError:true，返回值里的 isError
  // 被 agent-loop 丢弃——错误轮曾被标成功）。
  it('invalid schedule throws with message (W4: pi 采信 throw)', async () => {
    await expect(handleSchedule(service, { prompt: 'test', schedule: 'invalid' })).rejects.toThrow(
      'Invalid schedule',
    )
  })
})

describe('schedule_control tool', () => {
  let service: SchedulerService

  beforeEach(() => {
    vi.clearAllMocks()
    const backend = new MockSchedulerBackend()
    service = new SchedulerService(new SchedulerRuntime(backend), () => backend.now())
  })

  it('lists tasks', async () => {
    await service.create('test', '5m')
    const result = await handleScheduleControl(service, { action: 'list' })
    expect(result.content[0]!.text).toContain('test')
  })

  it('returns empty message when no tasks', async () => {
    const result = await handleScheduleControl(service, { action: 'list' })
    expect(result.content[0]!.text).toBe('No scheduled tasks.')
  })

  it('toggles task', async () => {
    const created = await service.create('test', '5m')
    const result = await handleScheduleControl(service, { action: 'toggle', id: created.data!.task.id, enabled: false })
    expect(result.content[0]!.text).toContain('disabled')
  })

  it('missing id on toggle throws (W4)', async () => {
    await expect(handleScheduleControl(service, { action: 'toggle', enabled: true })).rejects.toThrow(
      'id is required',
    )
  })

  // TC5 tool 侧：toggle 不存在 id → throw（service message 原文即 not found 文案）
  it('TC5: toggle unknown id throws with not-found message (W4)', async () => {
    await expect(handleScheduleControl(service, { action: 'toggle', id: 'deadbeef', enabled: false })).rejects.toThrow(
      'Task deadbeef not found.',
    )
  })

  it('deletes task', async () => {
    const created = await service.create('test', '5m')
    const result = await handleScheduleControl(service, { action: 'delete', id: created.data!.task.id })
    expect(result.content[0]!.text).toContain('deleted')
  })

  it('runs task now', async () => {
    // force 任务（L4：直投唯一入口，无 handle 直投分支已删）
    const created = await service.create('test', '5m', { force: true })
    const result = await handleScheduleControl(service, { action: 'run', id: created.data!.task.id })
    expect(result.content[0]!.text).toContain('executed')
  })
})
