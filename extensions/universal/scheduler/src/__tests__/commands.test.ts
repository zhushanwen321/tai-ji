import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MockSchedulerBackend } from './mock-backend.js'
import { executeScheduleCommand, registerScheduleCommand } from '../commands.js'
import { SchedulerRuntime } from '../runtime.js'
import { SchedulerService } from '../service.js'

// MockSchedulerBackend 零 FS 副作用，无需 mock store.js。

interface CommandOpts {
  description: string
  handler: (args: string) => Promise<string>
  getArgumentCompletions: (prefix: string) => unknown
}

describe('/schedule command', () => {
  let service: SchedulerService
  let commandOpts: CommandOpts

  beforeEach(() => {
    vi.clearAllMocks()
    // 注册命令时把 opts 截获下来，后续直接调 handler / getArgumentCompletions。
    const mockPi = {
      registerCommand: (_name: string, opts: CommandOpts) => {
        commandOpts = opts
      },
    }
    const backend = new MockSchedulerBackend()
    service = new SchedulerService(
      new SchedulerRuntime(backend),
      () => backend.now(),
    )
    registerScheduleCommand(mockPi as never, () => service)
  })

  // ── 子命令路由：list ──

  it('list returns empty message when no tasks', async () => {
    expect(await executeScheduleCommand(service, 'list')).toBe('No scheduled tasks.')
  })

  it('list returns formatted task lines', async () => {
    await service.create('check build', '5m')
    const result = await executeScheduleCommand(service, 'list')
    expect(result).toContain('check build')
    expect(result).toContain('every 5m')
  })

  it('list marks disabled tasks with ○', async () => {
    const created = await service.create('paused task', '5m')
    await service.toggle(created.data!.task.id, false)
    const result = await executeScheduleCommand(service, 'list')
    expect(result).toContain('○')
    expect(result).toContain('paused task')
  })

  // ── 子命令路由：on / off ──

  it('off toggles task enabled to false', async () => {
    const created = await service.create('test', '5m')
    const result = await executeScheduleCommand(service, `off ${created.data!.task.id}`)
    expect(result).toContain('disabled')
    expect(service.runtime.getTask(created.data!.task.id)?.enabled).toBe(false)
  })

  it('on toggles task enabled to true', async () => {
    const created = await service.create('test', '5m')
    await service.toggle(created.data!.task.id, false)
    const result = await executeScheduleCommand(service, `on ${created.data!.task.id}`)
    expect(result).toContain('enabled')
    expect(service.runtime.getTask(created.data!.task.id)?.enabled).toBe(true)
  })

  it('off with missing id returns usage', async () => {
    expect(await executeScheduleCommand(service, 'off')).toBe('Usage: /schedule off <id>')
  })

  it('on with missing id returns usage', async () => {
    expect(await executeScheduleCommand(service, 'on')).toBe('Usage: /schedule on <id>')
  })

  // TC5 command 侧：消息同源（service 产出 TASK_NOT_FOUND message）
  it('off with unknown id returns not found', async () => {
    expect(await executeScheduleCommand(service, 'off deadbeef')).toBe('Task deadbeef not found.')
  })

  // ── 子命令路由：rm ──

  it('rm deletes task', async () => {
    const created = await service.create('test', '5m')
    const result = await executeScheduleCommand(service, `rm ${created.data!.task.id}`)
    expect(result).toContain('deleted')
    expect(service.runtime.getTask(created.data!.task.id)).toBeUndefined()
  })

  it('rm with missing id returns usage', async () => {
    expect(await executeScheduleCommand(service, 'rm')).toBe('Usage: /schedule rm <id>')
  })

  it('rm with unknown id returns not found', async () => {
    expect(await executeScheduleCommand(service, 'rm deadbeef')).toBe('Task deadbeef not found.')
  })

  // ── 子命令路由：run ──

  it('run executes task', async () => {
    // run 子命令的 dispatch 行为锚定 steer 直投路径
    const created = await service.create('test', '5m')
    const result = await executeScheduleCommand(service, `run ${created.data!.task.id}`)
    expect(result).toContain('executed')
    // dispatchTask 更新 task 对象（同一引用），runCount 自增到 1。
    expect(service.runtime.getTask(created.data!.task.id)?.runCount).toBe(1)
  })

  it('run with missing id returns usage', async () => {
    expect(await executeScheduleCommand(service, 'run')).toBe('Usage: /schedule run <id>')
  })

  it('run with unknown id returns not found', async () => {
    expect(await executeScheduleCommand(service, 'run deadbeef')).toBe('Task deadbeef not found.')
  })

  // ── 创建任务分支 ──

  it('creates interval task from /schedule 5m check build', async () => {
    const result = await executeScheduleCommand(service, '5m check build')
    expect(result).toContain('check build')
    expect(result).toContain('every 5m')
    expect(service.runtime.listTasks()).toHaveLength(1)
  })

  it('created interval task is recurring by default', async () => {
    await executeScheduleCommand(service, '5m check build')
    const task = service.runtime.listTasks()[0]!
    expect(task.kind).toBe('recurring')
  })

  it('creates once task from /schedule once 10s remind', async () => {
    const result = await executeScheduleCommand(service, 'once 10s remind me')
    expect(result).toContain('remind me')
    // once 显示为 'once in 10s'（非误导性的 'every 10s'）
    expect(result).toContain('once in 10s')
    expect(result).not.toContain('every 10s')
    // once 任务 dispatch 后会被删除，但创建时尚未 dispatch
    expect(service.runtime.listTasks()).toHaveLength(1)
    const task = service.runtime.listTasks()[0]!
    expect(task.kind).toBe('once')
  })

  // Quote-aware tokenizer 修复后，cron 'expr' 能正确提取整个表达式。
  it('creates cron task from quoted expression', async () => {
    const result = await executeScheduleCommand(service, "cron '*/10 * * * *' prompt")
    expect(result).toContain('created')
    expect(result).toContain('*/10 * * * *')
    expect(service.runtime.listTasks()).toHaveLength(1)
  })

  it('creates cron task from double-quoted expression', async () => {
    const result = await executeScheduleCommand(service, 'cron "0 9 * * 1-5" standup reminder')
    expect(result).toContain('created')
    expect(result).toContain('0 9 * * 1-5')
    expect(service.runtime.listTasks()).toHaveLength(1)
  })

  // Unquoted multi-token cron still fails -- tokenizer cannot distinguish cron fields from prompt.
  // Users should quote the cron expression or use the schedule tool (JSON params are unambiguous).
  it('cron branch fails on unquoted multi-token expression (use quotes)', async () => {
    const result = await executeScheduleCommand(service, 'cron */10 * * * * prompt')
    expect(result).toMatch(/^Invalid schedule:/)
    expect(result).toContain('*/10')
  })

  // ── 错误分支 ──

  it('invalid schedule returns error message', async () => {
    const result = await executeScheduleCommand(service, 'invalid-duration-str')
    expect(result).toMatch(/invalid|usage/i)
  })

  it('schedule with no prompt returns usage', async () => {
    const result = await executeScheduleCommand(service, '5m')
    expect(result).toBe('Usage: /schedule <schedule> <prompt>')
  })

  it('treats prototype-chain key names as unknown (Map lookup, no Object.prototype hit)', async () => {
    // 路由表用 Map 查找的语义锚：普通对象下标会把 "constructor"/"toString"/"__proto__"
    // 解析到 Object.prototype（constructor 被当 handler 调用返回对象、__proto__ 直接 TypeError），
    // 这里必须与其它未知子命令同走创建任务分支（无 schedule 输入 → usage 文案）。
    for (const key of ['constructor', 'toString', '__proto__']) {
      expect(await executeScheduleCommand(service, key)).toBe(
        'Usage: /schedule <schedule> <prompt>',
      )
    }
  })

  it('no args returns TUI not-implemented message', async () => {
    const result = await executeScheduleCommand(service, '')
    expect(result).toContain('not yet implemented')
  })

  it('returns error when service is null', async () => {
    expect(await executeScheduleCommand(null, 'list')).toBe('Scheduler not initialized: session not started.')
  })

  // ── getArgumentCompletions ──

  it('completes subcommands for empty prefix', () => {
    const completions = commandOpts.getArgumentCompletions('') as Array<{ label: string }>
    const labels = completions.map(c => c.label)
    expect(labels).toContain('list')
    expect(labels).toContain('on')
    expect(labels).toContain('off')
    expect(labels).toContain('rm')
    expect(labels).toContain('run')
    expect(labels).toContain('once')
    expect(labels).toContain('cron')
  })

  it('filters subcommands by prefix', () => {
    const completions = commandOpts.getArgumentCompletions('r') as Array<{ label: string }>
    const labels = completions.map(c => c.label)
    expect(labels).toContain('rm')
    expect(labels).toContain('run')
    expect(labels).not.toContain('list')
  })

  it('completes task ids after on/off/rm/run', async () => {
    const created = await service.create('mytask', '5m')
    const task = created.data!.task
    // 注意：路由要求 parts.length >= 2 才进 task-id 分支（'on ' 单 token 进子命令分支）。
    // 当前实现对部分输入的 id 不做过滤，返回所有 task id。
    const completions = commandOpts.getArgumentCompletions(`on ${task.id.slice(0, 2)}`) as Array<{ label: string; description: string }>
    const labels = completions.map(c => c.label)
    expect(labels).toContain(task.id)
    expect(completions.find(c => c.label === task.id)?.description).toContain('mytask')
  })

  it('returns null for completion when service missing and prefix has 2 tokens', () => {
    const mockPi = {
      registerCommand: (_name: string, opts: CommandOpts) => {
        commandOpts = opts
      },
    }
    registerScheduleCommand(mockPi as never, () => null)
    // 2 个 token 才能跳过子命令分支、命中末尾 return null
    expect(commandOpts.getArgumentCompletions('on abcdef12')).toBeNull()
  })
})
