import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MockSchedulerBackend } from './mock-backend.js'
import { registerScheduleCommand } from '../commands.js'
import { SchedulerRuntime } from '../runtime.js'
import { SchedulerService } from '../service.js'

// MockSchedulerBackend 零 FS 副作用，无需 mock store.js。

interface CommandOpts {
  description: string
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
  getArgumentCompletions: (prefix: string) => unknown
}

interface MockCtx {
  ctx: ExtensionCommandContext
  notify: ReturnType<typeof vi.fn>
}

function createMockPi(): { pi: unknown; commands: Map<string, CommandOpts> } {
  const commands = new Map<string, CommandOpts>()
  const pi = {
    registerCommand: (name: string, opts: CommandOpts) => {
      commands.set(name, opts)
    },
  }
  return { pi, commands }
}

function createMockCtx(mode = 'rpc'): MockCtx {
  const notify = vi.fn()
  const ctx = { mode, hasUI: true, ui: { notify } } as unknown as ExtensionCommandContext
  return { ctx, notify }
}

describe('/scheduler command（子命令路由 + 补全 + 错误通道）', () => {
  let service: SchedulerService
  let commands: Map<string, CommandOpts>
  let commandOpts: CommandOpts

  function register(getService: () => SchedulerService | null = () => service): void {
    const mockPi = createMockPi()
    commands = mockPi.commands
    registerScheduleCommand(mockPi.pi as never, getService)
    commandOpts = commands.get('scheduler')!
  }

  beforeEach(() => {
    vi.clearAllMocks()
    const backend = new MockSchedulerBackend()
    service = new SchedulerService(new SchedulerRuntime(backend), () => backend.now())
    register()
  })

  // ── 注册：/scheduler + /schedule alias（同一 handler / 补全） ──

  it('注册 /scheduler 与 /schedule alias，同一 handler 与补全', () => {
    expect(commands.has('scheduler')).toBe(true)
    expect(commands.has('schedule')).toBe(true)
    const alias = commands.get('schedule')!
    expect(alias.handler).toBe(commandOpts.handler)
    expect(alias.getArgumentCompletions).toBe(commandOpts.getArgumentCompletions)
    expect(commandOpts.description).toContain('scheduler')
  })

  // ── 子命令路由：list ──

  it('list：空列表 → notify info', async () => {
    const { ctx, notify } = createMockCtx()
    await commandOpts.handler('list', ctx)
    expect(notify).toHaveBeenCalledWith('No scheduled tasks.', 'info')
  })

  it('list：格式化任务行（含 schedule 与名称）', async () => {
    await service.create('check build', '5m')
    const { ctx, notify } = createMockCtx()
    await commandOpts.handler('list', ctx)
    expect(notify.mock.calls[0]![0]).toContain('check build')
    expect(notify.mock.calls[0]![0]).toContain('every 5m')
    expect(notify.mock.calls[0]![1]).toBe('info')
  })

  it('list：disabled 任务标记 ○', async () => {
    const created = await service.create('paused task', '5m')
    await service.toggle(created.data!.task.id, false)
    const { ctx, notify } = createMockCtx()
    await commandOpts.handler('list', ctx)
    expect(notify.mock.calls[0]![0]).toContain('○')
  })

  // ── 子命令路由：on / off ──

  it('off：停用任务（notify info）', async () => {
    const created = await service.create('test', '5m')
    const { ctx, notify } = createMockCtx()
    await commandOpts.handler(`off ${created.data!.task.id}`, ctx)
    expect(service.runtime.getTask(created.data!.task.id)?.enabled).toBe(false)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('disabled'), 'info')
  })

  it('on：启用任务', async () => {
    const created = await service.create('test', '5m')
    await service.toggle(created.data!.task.id, false)
    const { ctx, notify } = createMockCtx()
    await commandOpts.handler(`on ${created.data!.task.id}`, ctx)
    expect(service.runtime.getTask(created.data!.task.id)?.enabled).toBe(true)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('enabled'), 'info')
  })

  it('off/on 缺 id → usage + notify error', async () => {
    for (const keyword of ['off', 'on']) {
      const { ctx, notify } = createMockCtx()
      await commandOpts.handler(keyword, ctx)
      expect(notify).toHaveBeenCalledWith(`Usage: /scheduler ${keyword} <id>`, 'error')
    }
  })

  it('off 未知 id → not found（service message 同源）', async () => {
    const { ctx, notify } = createMockCtx()
    await commandOpts.handler('off deadbeef', ctx)
    expect(notify).toHaveBeenCalledWith('Task deadbeef not found.', 'error')
  })

  // ── 子命令路由：rm ──

  it('rm：删除任务', async () => {
    const created = await service.create('test', '5m')
    const { ctx, notify } = createMockCtx()
    await commandOpts.handler(`rm ${created.data!.task.id}`, ctx)
    expect(service.runtime.getTask(created.data!.task.id)).toBeUndefined()
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('deleted'), 'info')
  })

  it('rm 缺 id → usage + error；未知 id → not found + error', async () => {
    const { ctx, notify } = createMockCtx()
    await commandOpts.handler('rm', ctx)
    expect(notify).toHaveBeenCalledWith('Usage: /scheduler rm <id>', 'error')
    await commandOpts.handler('rm deadbeef', ctx)
    expect(notify).toHaveBeenCalledWith('Task deadbeef not found.', 'error')
  })

  // ── 子命令路由：run ──

  it('run：立即执行任务', async () => {
    const created = await service.create('test', '5m')
    const { ctx, notify } = createMockCtx()
    await commandOpts.handler(`run ${created.data!.task.id}`, ctx)
    expect(service.runtime.getTask(created.data!.task.id)?.runCount).toBe(1)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('executed'), 'info')
  })

  it('run 缺 id → usage + error；未知 id → not found + error', async () => {
    const { ctx, notify } = createMockCtx()
    await commandOpts.handler('run', ctx)
    expect(notify).toHaveBeenCalledWith('Usage: /scheduler run <id>', 'error')
    await commandOpts.handler('run deadbeef', ctx)
    expect(notify).toHaveBeenCalledWith('Task deadbeef not found.', 'error')
  })

  // ── notify severity 分级 ──

  it('notify severity：成功 info / 失败 error（list 成功 vs 未知 id 失败）', async () => {
    const ok = createMockCtx()
    await commandOpts.handler('list', ok.ctx)
    expect(ok.notify).toHaveBeenCalledWith(expect.any(String), 'info')

    const bad = createMockCtx()
    await commandOpts.handler('off deadbeef', bad.ctx)
    expect(bad.notify).toHaveBeenCalledWith(expect.any(String), 'error')
  })

  // ── 错误通道：service 未初始化 ──

  it('service null：rpc → notify error（throw 在 rpc 被静默丢弃，不能依赖）', async () => {
    const mockPi = createMockPi()
    registerScheduleCommand(mockPi.pi as never, () => null)
    const { ctx, notify } = createMockCtx('rpc')
    await mockPi.commands.get('scheduler')!.handler('list', ctx)
    expect(notify).toHaveBeenCalledWith('Scheduler not initialized: session not started.', 'error')
  })

  it('service null：json → 原样 throw（stderr 是唯一可见通道）', async () => {
    const mockPi = createMockPi()
    registerScheduleCommand(mockPi.pi as never, () => null)
    const { ctx } = createMockCtx('json')
    await expect(mockPi.commands.get('scheduler')!.handler('list', ctx))
      .rejects.toThrow('Scheduler not initialized: session not started.')
  })

  // ── 原型链键不误路由 ──

  it('constructor/toString/__proto__ 不被当子命令（Map 只查自身键）：json 模式落入创建分支 throw', async () => {
    for (const key of ['constructor', 'toString', '__proto__']) {
      const { ctx } = createMockCtx('json')
      await expect(commandOpts.handler(key, ctx)).rejects.toThrow('No interactive channel')
    }
  })

  // ── getArgumentCompletions ──

  it('补全：空前缀列子命令（list/on/off/rm/run），once/cron 直建补全已退役', () => {
    const completions = commandOpts.getArgumentCompletions('') as Array<{ label: string }>
    const labels = completions.map(c => c.label)
    expect(labels).toEqual(['list', 'on', 'off', 'rm', 'run'])
    expect(labels).not.toContain('once')
    expect(labels).not.toContain('cron')
  })

  it('补全：按前缀过滤子命令', () => {
    const completions = commandOpts.getArgumentCompletions('r') as Array<{ label: string }>
    const labels = completions.map(c => c.label)
    expect(labels).toContain('rm')
    expect(labels).toContain('run')
    expect(labels).not.toContain('list')
  })

  it('补全：on/off/rm/run 之后补全任务 id（description = name · schedule）', async () => {
    const created = await service.create('mytask', '5m')
    const task = created.data!.task
    const completions = commandOpts.getArgumentCompletions(`on ${task.id.slice(0, 2)}`) as Array<{ label: string; description: string }>
    const hit = completions.find(c => c.label === task.id)
    expect(hit).toBeDefined()
    expect(hit!.description).toContain('mytask')
    expect(hit!.description).toContain('every 5m')
  })

  it('补全：service 缺失且前缀 2 token → null', () => {
    const mockPi = createMockPi()
    registerScheduleCommand(mockPi.pi as never, () => null)
    expect(mockPi.commands.get('scheduler')!.getArgumentCompletions('on abcdef12')).toBeNull()
  })
})
