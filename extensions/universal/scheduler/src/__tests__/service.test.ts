import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MockSchedulerBackend } from './mock-backend.js'
import {
  dictionaryKeys,
  readUiLocale,
  renderResult,
  renderTaskLine,
  SERVICE_MESSAGE_KEYS,
  t,
} from '../i18n.js'
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
        messageKey: 'schedule.invalid',
        params: { input: 'invalid' },
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
      expect(result.messageKey).toBe('task.limit')
      expect(result.params).toEqual({ max: 50 })
    })
  })

  describe('list', () => {
    it('returns empty message when no tasks', () => {
      expect(service.list()).toEqual({
        success: true,
        messageKey: 'task.list.empty',
        params: {},
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
      expect(result).toEqual({
        success: true,
        messageKey: 'task.disabled',
        params: { id },
        message: `Task ${id} disabled.`,
      })
      expect(service.runtime.getTask(id)?.enabled).toBe(false)
    })

    it('TC4: returns not-found message for unknown id', async () => {
      const result = await service.toggle('deadbeef', true)
      expect(result).toEqual({
        success: false,
        messageKey: 'task.notFound',
        params: { id: 'deadbeef' },
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
      expect(result).toEqual({
        success: true,
        messageKey: 'task.deleted',
        params: { id },
        message: `Task ${id} deleted.`,
      })
      expect(service.runtime.getTask(id)).toBeUndefined()
    })

    it('TC4: returns not-found message for unknown id', () => {
      const result = service.delete('deadbeef')
      expect(result).toEqual({
        success: false,
        messageKey: 'task.notFound',
        params: { id: 'deadbeef' },
        message: 'Task deadbeef not found.',
      })
    })
  })

  describe('run', () => {
    it('runs task now', async () => {
      const created = await service.create('test', '5m')
      const id = created.data!.task.id
      const result = await service.run(id)
      expect(result).toEqual({
        success: true,
        messageKey: 'task.executed',
        params: { id },
        message: `Task ${id} executed.`,
      })
      expect(service.runtime.getTask(id)?.runCount).toBe(1)
    })

    it('TC4: returns not-found message for unknown id', async () => {
      const result = await service.run('deadbeef')
      expect(result).toEqual({
        success: false,
        messageKey: 'task.notFound',
        params: { id: 'deadbeef' },
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
        messageKey: 'task.notDispatched',
        params: { id },
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

  // ── 结构化结果码 + 词典契约（r4 M2 / r5 追补）──

  describe('messageKey / params 契约', () => {
    it('create 返回单任务 shape（含 enabled，原始值非英文串）+ message 英文回退不变', async () => {
      const result = await service.create('check build', '5m')
      expect(result.messageKey).toBe('task.created')
      expect(result.params).toMatchObject({
        name: 'check build',
        kind: 'recurring',
        mode: 'interval',
        intervalMs: 300_000,
        enabled: true,
      })
      expect(result.params).not.toHaveProperty('cron')
      // message 保留英文回退（L4 tool result），未被本地化污染
      expect(result.message).toContain('Task "check build"')
      expect(result.message).toContain('every 5m')
      expect(result.message).toContain('Next 5 runs:')
    })

    it('create cron shape 用 mode:cron 显式判别（禁 nullable 推断）', async () => {
      const result = await service.create('standup', '0 9 * * 1-5')
      expect(result.messageKey).toBe('task.created')
      expect(result.params).toMatchObject({ mode: 'cron', cron: '0 0 9 * * 1-5', enabled: true })
      expect(result.params).not.toHaveProperty('intervalMs')
    })

    it('create toast 含任务 id（rm <id> 的可见性依赖）', async () => {
      const result = await service.create('check build', '5m')
      if (result.params === undefined || !('name' in result.params)) throw new Error('expected task params')
      const toast = renderResult('task.created', result.params, 'zh-CN')
      expect(toast).toContain(result.params.id)
      expect(toast).toContain('已创建')
    })

    it('list shape {n,tasks[],now}；tasks[] 元素含 enabled；停用行首 ○ / 启用 ●', async () => {
      await service.create('active', '5m')
      const paused = await service.create('paused', '5m')
      await service.toggle(paused.data!.task.id, false)

      const result = service.list()
      expect(result.messageKey).toBe('task.list')
      if (result.params === undefined || !('tasks' in result.params)) {
        throw new Error('expected list params')
      }
      const params = result.params
      expect(params.n).toBe(2)
      expect(params.tasks).toHaveLength(2)
      expect(params.tasks[0]).toMatchObject({ name: 'active', enabled: true, mode: 'interval' })
      expect(params.tasks[1]).toMatchObject({ name: 'paused', enabled: false })

      // renderTaskLine 单点：停用 ○ / 启用 ●
      expect(renderTaskLine(params.tasks[0]!, 'zh-CN').startsWith('●')).toBe(true)
      expect(renderTaskLine(params.tasks[1]!, 'zh-CN').startsWith('○')).toBe(true)

      // list 行复用 renderTaskLine：行首状态位与任务启用态对齐
      const lines = renderResult('task.list', params, 'zh-CN').split('\n')
      expect(lines[0]).toBe('### 定时任务 2 条')
      expect(lines[1]).toContain('active')
      expect(lines[1]!.startsWith('●')).toBe(true)
      expect(lines[2]!.startsWith('○')).toBe(true)
      expect(renderResult('task.list', params, 'en-US')).toContain('### Scheduled (2)')
    })

    // ── D1 执行状态摘要（task.list 行尾失败可见性补偿；widget 推送修正设计 D1 代价四要素）──

    it('task.list 行尾摘要：近期失败 → 「上次: 失败×n」（用户可见失败信号）', async () => {
      const created = await service.create('flaky', '5m')
      const task = service.runtime.getTask(created.data!.task.id)
      task!.history.push({ at: Date.now() - 2000, status: 'failed' }, { at: Date.now() - 1000, status: 'failed' })
      task!.lastStatus = 'failed'

      const result = service.list()
      if (result.params === undefined || !('tasks' in result.params)) throw new Error('expected list params')
      const line = renderResult('task.list', result.params, 'zh-CN').split('\n')[1]!
      expect(line).toContain('上次: 失败×2')
      // 命令变体保留相对时间（设计 D1-a：命令层按需呈现面不变）
      expect(line).toMatch(/分钟后|分钟前|\d+m ago|in \d+m/)
      // params 携带 locale-neutral 原始值（摘要不预渲染）
      expect(result.params.tasks[0]!.lastExec).toEqual({ lastStatus: 'failed', recentFailures: 2 })
    })

    it('task.list 行尾摘要：有成功记录无失败 → 「上次: 成功」；无记录 → 无摘要段', async () => {
      const done = await service.create('done-task', '5m')
      service.runtime.getTask(done.data!.task.id)!.lastStatus = 'success'
      await service.create('fresh-task', '5m')

      const result = service.list()
      if (result.params === undefined || !('tasks' in result.params)) throw new Error('expected list params')
      const lines = renderResult('task.list', result.params, 'zh-CN').split('\n')
      expect(lines[1]).toContain('上次: 成功')
      expect(lines[2]).not.toContain('上次:')
    })

    it('task.created toast 不带执行摘要（e2e S18 断言锚定其全行文本）', async () => {
      const created = await service.create('s18-guard', '45m', { kind: 'once' })
      if (created.params === undefined || !('name' in created.params)) throw new Error('expected task params')
      const toast = renderResult('task.created', created.params, 'en-US')
      expect(toast).not.toContain('last:')
      expect(toast).not.toContain('上次:')
      // S18 同款形态锚点：全行结构不被摘要破坏
      expect(toast).toMatch(/^Created [0-9a-f]+: s18-guard · once in 45m · next run in \d+m$/)
    })

    it('renderTaskLine 命令变体保留相对时间（widget 静态化的命令层对照）', async () => {
      const now = Date.now()
      const line = renderTaskLine(
        {
          mode: 'interval',
          intervalMs: 300_000,
          id: 'abc12345',
          name: 'cmd variant',
          kind: 'recurring',
          nextRunAt: now + 3_600_000,
          now,
          enabled: true,
        },
        'en-US',
      )
      expect(line).toContain('in 1h')
    })

    it('词典 key 集合 ⊇ messageKey 词表 + tray.title（zh/en 双侧且 key 集合对齐）', () => {
      for (const locale of ['zh-CN', 'en-US'] as const) {
        const keys = new Set(dictionaryKeys(locale))
        for (const key of SERVICE_MESSAGE_KEYS) expect(keys.has(key)).toBe(true)
        expect(keys.has('tray.title')).toBe(true)
      }
      expect(new Set(dictionaryKeys('zh-CN'))).toEqual(new Set(dictionaryKeys('en-US')))
    })

    it("词典 key 集合覆盖源码中全部 t('…') 字面量键（含 tray.title / widget.*）", () => {
      const used = new Set<string>()
      for (const file of ['i18n.ts', 'widget.ts']) {
        const sourcePath = fileURLToPath(new URL(`../${file}`, import.meta.url))
        const text = readFileSync(sourcePath, 'utf-8')
        for (const match of text.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(match[1]!)
      }
      // 防正则失配空转：锚点键（tray.title 无参单行 / widget.task 跨行带参）必被采集
      expect(used.has('tray.title')).toBe(true)
      expect(used.has('widget.task')).toBe(true)
      for (const locale of ['zh-CN', 'en-US'] as const) {
        const keys = new Set(dictionaryKeys(locale))
        for (const key of used) {
          expect(keys.has(key), `${locale} 缺 t('${key}') 词条`).toBe(true)
        }
      }
    })

    it('t() 缺键禁返回空串（回落 en 值 → 键名）', () => {
      expect(t('definitely.missing.key', undefined, 'zh-CN')).toBe('definitely.missing.key')
      expect(t('definitely.missing.key', undefined, 'zh-CN')).not.toBe('')
      expect(t('task.list.empty', undefined, 'zh-CN')).toBe('没有定时任务')
    })
  })

  describe('readUiLocale（缺失 / 损坏回落 en-US）', () => {
    const original = process.env.TAIJI_AGENT_DATA_DIR
    const dirs: string[] = []

    afterEach(() => {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
      dirs.length = 0
      if (original === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
      else process.env.TAIJI_AGENT_DATA_DIR = original
    })

    function freshDir(): string {
      const dir = mkdtempSync(join(tmpdir(), 'sched-i18n-'))
      dirs.push(dir)
      return dir
    }

    it('缺失文件回落 en-US', () => {
      process.env.TAIJI_AGENT_DATA_DIR = freshDir()
      expect(readUiLocale()).toBe('en-US')
    })

    it('损坏 JSON 回落 en-US', () => {
      const dir = freshDir()
      writeFileSync(join(dir, 'ui-preferences.json'), '{ not valid json')
      process.env.TAIJI_AGENT_DATA_DIR = dir
      expect(readUiLocale()).toBe('en-US')
    })

    it('合法 zh-CN 生效；非法值回落 en-US', () => {
      const zhDir = freshDir()
      writeFileSync(
        join(zhDir, 'ui-preferences.json'),
        JSON.stringify({ v: 1, locale: 'zh-CN', updatedAt: 0 }),
      )
      process.env.TAIJI_AGENT_DATA_DIR = zhDir
      expect(readUiLocale()).toBe('zh-CN')

      const badDir = freshDir()
      writeFileSync(join(badDir, 'ui-preferences.json'), JSON.stringify({ v: 1, locale: 'fr-FR' }))
      process.env.TAIJI_AGENT_DATA_DIR = badDir
      expect(readUiLocale()).toBe('en-US')
    })

    it('env 缺失回落 en-US', () => {
      delete process.env.TAIJI_AGENT_DATA_DIR
      expect(readUiLocale()).toBe('en-US')
    })
  })
})
