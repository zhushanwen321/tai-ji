import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MockSchedulerBackend } from './mock-backend.js'
import { SchedulerRuntime } from '../runtime.js'
import { SchedulerService } from '../service.js'
import { handleSchedule, handleScheduleControl } from '../tool.js'

// handleSchedule 六步流签名（U2）：(pi, service, params, ctx, signal)。本文件只测
// service 瘦壳直通与预校验路径，统一用 headless ctx（mode 'print' → D4 直通分支），
// 交互分支覆盖见 tool-create-flow.test.ts。
const mockPi = { setActiveTools: vi.fn(), getAllTools: () => [] } as unknown as ExtensionAPI
const headlessCtx = { mode: 'print' } as unknown as ExtensionContext

describe('schedule tool', () => {
  let service: SchedulerService

  beforeEach(() => {
    vi.clearAllMocks()
    const backend = new MockSchedulerBackend()
    service = new SchedulerService(new SchedulerRuntime(backend), () => backend.now())
  })

  it('creates task with duration', async () => {
    const result = await handleSchedule(mockPi, service, { prompt: 'check build', schedule: '5m' }, headlessCtx, undefined)
    expect(result.content[0]!.text).toContain('Task "check build"')
    const details = result.details as { task: { schedule: { mode: string; intervalMs: number } } }
    expect(details.task.schedule).toEqual({ mode: 'interval', intervalMs: 300000 })
  })

  // W4：业务失败 throw（pi 只对 execute throw 置 isError:true，返回值里的 isError
  // 被 agent-loop 丢弃——错误轮曾被标成功）。预校验文案见 §3.5（可自修复重试）。
  it('invalid schedule throws with message (W4: pi 采信 throw)', async () => {
    await expect(
      handleSchedule(mockPi, service, { prompt: 'test', schedule: 'invalid' }, headlessCtx, undefined),
    ).rejects.toThrow('unrecognized schedule')
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
    const created = await service.create('test', '5m')
    const result = await handleScheduleControl(service, { action: 'run', id: created.data!.task.id })
    expect(result.content[0]!.text).toContain('executed')
  })
})
