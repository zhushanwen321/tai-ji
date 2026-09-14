import { beforeEach, describe, expect, it } from 'vitest'

import { MockSchedulerBackend } from './mock-backend.js'
import { SchedulerRuntime } from '../runtime.js'
import { SchedulerService } from '../service.js'

describe('SchedulerService', () => {
  let service: SchedulerService
  let backend: MockSchedulerBackend

  beforeEach(() => {
    backend = new MockSchedulerBackend()
    // 固定时间避免 clock-boundary flake：formatRelativeTime 内部读 Date.now()，
    // 两次读之间的延迟可能导致 "in 1h" 变成 "in 59m"。
    backend.nowValue = Date.now()
    service = new SchedulerService(new SchedulerRuntime(backend), () => backend.now())
  })

  describe('create', () => {
    it('creates task with duration and returns full summary', async () => {
      const result = await service.create('check build', '5m')
      expect(result.success).toBe(true)
      expect(result.message).toContain('Task "check build"')
      expect(result.message).toContain('every 5m')
      expect(result.message).toContain('Next 5 runs:')
      expect(result.data!.task.schedule).toEqual({ mode: 'interval', intervalMs: 300000 })
      expect(result.data!.nextRuns).toHaveLength(5)
      // TC-RECURRING-NO-REGRESS：recurring 回显仍为 5 行编号 run 行（编号列表不变）
      const runLines = result.message.split('\n').filter(l => /^\s+\d+\./.test(l))
      expect(runLines).toHaveLength(5)
    })

    // TC-ONCE-ECHO：once 任务回显仅 1 条 run 行（单行内联，无编号列表）
    it('TC-ONCE-ECHO: once task echoes single run line without numbered list', async () => {
      const result = await service.create('git pull', '1h', { kind: 'once' })
      expect(result.success).toBe(true)
      expect(result.message).toContain('once in 1h')
      expect(result.message).not.toContain('Next 5 runs:')
      expect(result.message).toContain('Next run: in 1h')
      // 无编号 run 行（once 单行内联）
      expect(result.message).not.toMatch(/^\s+\d+\./m)
      // nextRuns 数据同步裁剪
      expect(result.data!.nextRuns).toHaveLength(1)
    })

    // TC-NOW-INJECT：create 用注入的 now 源（backend.now()）而非 Date.now()
    it('TC-NOW-INJECT: create uses injected now source', async () => {
      const fixedNow = Date.now()
      const injectBackend = new MockSchedulerBackend()
      injectBackend.nowValue = fixedNow
      const nowService = new SchedulerService(new SchedulerRuntime(injectBackend), () => injectBackend.now())
      const result = await nowService.create('one shot', '1h', { kind: 'once' })
      expect(result.data!.nextRuns[0]).toBe(fixedNow + 3_600_000)
      expect(result.message).toContain('in 1h')
    })

    it('creates cron task', async () => {
      const result = await service.create('standup', '0 9 * * 1-5')
      expect(result.success).toBe(true)
      expect(result.data!.task.schedule).toEqual({ mode: 'cron', cronExpression: '0 0 9 * * 1-5' })
    })

    it('returns invalid-schedule message for invalid schedule', async () => {
      const result = await service.create('test', 'invalid')
      expect(result).toEqual({
        success: false,
        message: 'Invalid schedule: "invalid". Use duration (5m/2h/1d) or cron expression (*/10 * * * *).',
      })
    })

    it('returns task-limit message when 50 tasks exist', async () => {
      for (let i = 0; i < 50; i++) {
        await service.create(`task ${i}`, '5m')
      }
      const result = await service.create('one more', '5m')
      expect(result.success).toBe(false)
      expect(result.message).toContain('Task limit reached (50)')
    })
  })

  describe('list', () => {
    it('returns empty message when no tasks', () => {
      expect(service.list()).toEqual({
        success: true,
        message: 'No scheduled tasks.',
        data: { tasks: [] },
      })
    })

    it('returns formatted lines when tasks exist', async () => {
      await service.create('check build', '5m')
      const result = service.list()
      expect(result.success).toBe(true)
      expect(result.message).toContain('check build')
      expect(result.message).toContain('every 5m')
      expect(result.data!.tasks).toHaveLength(1)
    })

    it('marks disabled tasks with ○', async () => {
      const created = await service.create('paused', '5m')
      await service.toggle(created.data!.task.id, false)
      const result = service.list()
      expect(result.message).toContain('○')
    })
  })

  describe('toggle', () => {
    it('toggles task', async () => {
      const created = await service.create('test', '5m')
      const id = created.data!.task.id
      const result = await service.toggle(id, false)
      expect(result).toEqual({ success: true, message: `Task ${id} disabled.` })
      expect(service.runtime.getTask(id)?.enabled).toBe(false)
    })

    it('TC4: returns not-found message for unknown id', async () => {
      const result = await service.toggle('deadbeef', true)
      expect(result).toEqual({
        success: false,
        message: 'Task deadbeef not found.',
      })
    })

    it('returns invalid-params message when id missing', async () => {
      const result = await service.toggle(undefined, true)
      expect(result).toEqual({
        success: false,
        message: 'id is required for toggle.',
      })
    })

    it('returns invalid-params message when enabled missing', async () => {
      const result = await service.toggle('abc12345', undefined)
      expect(result).toEqual({
        success: false,
        message: 'enabled is required for toggle.',
      })
    })
  })

  describe('delete', () => {
    it('deletes task', async () => {
      const created = await service.create('test', '5m')
      const id = created.data!.task.id
      const result = service.delete(id)
      expect(result).toEqual({ success: true, message: `Task ${id} deleted.` })
      expect(service.runtime.getTask(id)).toBeUndefined()
    })

    it('TC4: returns not-found message for unknown id', () => {
      const result = service.delete('deadbeef')
      expect(result).toEqual({
        success: false,
        message: 'Task deadbeef not found.',
      })
    })
  })

  describe('run', () => {
    it('runs task now', async () => {
      const created = await service.create('test', '5m')
      const id = created.data!.task.id
      const result = await service.run(id)
      expect(result).toEqual({ success: true, message: `Task ${id} executed.` })
      expect(service.runtime.getTask(id)?.runCount).toBe(1)
    })

    it('TC4: returns not-found message for unknown id', async () => {
      const result = await service.run('deadbeef')
      expect(result).toEqual({
        success: false,
        message: 'Task deadbeef not found.',
      })
    })

    it('returns dispatch-skipped message for disabled task (not not-found)', async () => {
      const created = await service.create('test', '5m')
      const id = created.data!.task.id
      await service.toggle(id, false)
      const result = await service.run(id)
      expect(result).toEqual({
        success: false,
        message: `Task ${id} not dispatched (disabled, rate-limited, or dispatch in flight).`,
      })
    })

    it('run 直投成功', async () => {
      const backend2 = new MockSchedulerBackend()
      const service2 = new SchedulerService(new SchedulerRuntime(backend2), () => backend2.now())

      const created = await service2.create('test', '5m')
      const id = created.data!.task.id
      const result = await service2.run(id)

      // steer 直投成功（runtime 层无 idle/busy 判定）
      expect(result.success).toBe(true)
      expect(backend2.sentMessages).toHaveLength(1)
    })
  })
})
