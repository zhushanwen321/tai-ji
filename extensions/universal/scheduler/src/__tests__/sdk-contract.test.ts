// src/__tests__/sdk-contract.test.ts
//
// SDK 契约测试：验证 pi-scheduler 扩展对 Pi SDK 的消费符合契约。
// 保护本次 PR 修复的 4 个 tool 注册 bug 不回归：
//   1. tool 注册名为 schedule / schedule_control
//   2. tool 有 execute 函数字段（不是 handler/fn）
//   3. execute 是 async function（SDK 期望返回 Promise）
//   4. 错误路径 throw（W4：pi-agent-core 只对 execute throw 置 isError:true，
//      返回值里的 isError 字段被 agent-loop 丢弃——错误轮曾被标成功；
//      锚点 agent-loop.js:453-483/525-547）
//
// 不导入 SchedulerRuntime 的内部：只通过 index.ts 的 default export 测，
// 保证 tool 注册逻辑的入口契约。
//
// 关键回归点：runtime 在 session_start 前为 null。execute 通过 getRuntime() 延迟
// 读取——若在 factory 顶层捕获 runtime! 非空断言，注册时 runtime 为 null，
// execute 调用会 NPE。此套件验证 session_start 前 execute 优雅 throw 而非 crash。

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'

// MF-3：session_start handler 会真实执行 importLegacyStore(ctx.cwd, ...) —— fakeCtx cwd='/test'
// 会触碰真实用户 FS（~/.pi/agent/scheduler/root/test/scheduler.json 的 renameSync/existsSync/
// unlinkSync；该目录是活跃数据目录，一旦路径存在会 rename+unlink 真实用户数据且结果不确定）。
// mock 掉 importer 模块：session_start 装配路径仍被调用（vi.fn 记录调用），FS 副作用为零；
// 装配时序由 scripts/verify-scheduler-e2e.cjs 的 S10/S12/S17 真实环境覆盖。
// mock 返回 vi.fn() 作为延迟删除 cleanup（MF-1：turn_end / session_shutdown 装配链路可测）。
vi.mock('../importer.js', () => ({ importLegacyStore: vi.fn(() => vi.fn()) }))

import { importLegacyStore } from '../importer.js'
import schedulerExtension from '../index.js'

/**
 * 构造 mock pi：捕获 registerTool 收到的 tool definition + registerCommand + 事件 handler。
 * sendMessage 为空 vi.fn()，dispatch 路径会调用它但不影响契约断言。
 */
/** 捕获到的 tool definition：只关心我们要断言的字段。 */
interface CapturedTool {
  name: string
  execute: (...args: unknown[]) => Promise<{
    content: { type: string; text: string }[]
    details: unknown
    isError?: boolean
  }>
  handler?: unknown
  fn?: unknown
  [key: string]: unknown
}

function createMockPi(): {
  pi: ExtensionAPI
  tools: CapturedTool[]
  commands: { name: string; opts: Record<string, unknown> }[]
  events: Map<string, (...args: unknown[]) => void>
} {
  const tools: CapturedTool[] = []
  const commands: { name: string; opts: Record<string, unknown> }[] = []
  const events = new Map<string, (...args: unknown[]) => void>()
  const pi = {
    registerTool: (tool: CapturedTool) => tools.push(tool),
    registerCommand: (name: string, opts: Record<string, unknown>) => commands.push({ name, opts }),
    on: (event: string, handler: (...args: unknown[]) => void) => events.set(event, handler),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI
  return { pi, tools, commands, events }
}

/**
 * 构造最小 fakeCtx：覆盖 index.ts 在 session_start/refreshWidget 中读到的字段。
 * setWidget 在 session_start 立即调用一次（refreshWidget），故必须存在。
 */
function createFakeCtx(): ExtensionContext {
  return {
    cwd: '/test',
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { setWidget: vi.fn() },
    // append-only 模型：session_start 时 PiSchedulerBackend(ctx, pi) 读 ctx.sessionManager.getEntries()
    // 折叠恢复任务。fakeCtx 返回空 entries + 固定 sessionFile（无历史任务，等价新 session）。
    sessionManager: {
      getEntries: () => [],
      getSessionFile: () => '/test/session.json',
    },
  } as unknown as ExtensionContext
}

describe('pi-scheduler SDK contract', () => {
  it('registerTool 被调 2 次，name 为 schedule / schedule_control', () => {
    const { pi, tools } = createMockPi()
    schedulerExtension(pi)
    expect(tools).toHaveLength(2)
    expect(tools.map(t => t.name).sort()).toEqual(['schedule', 'schedule_control'])
  })

  it('每个 tool 有 execute 函数字段（不是 handler/fn）—— 本 PR 修的核心 bug', () => {
    const { pi, tools } = createMockPi()
    schedulerExtension(pi)
    for (const tool of tools) {
      expect(typeof tool.execute).toBe('function')
      // 反回归：旧的错误字段名不应存在
      expect(tool.handler).toBeUndefined()
      expect(tool.fn).toBeUndefined()
    }
  })

  it('execute 是 async function', () => {
    const { pi, tools } = createMockPi()
    schedulerExtension(pi)
    for (const tool of tools) {
      // async function 的 constructor 是 AsyncFunction
      expect(tool.execute.constructor.name).toBe('AsyncFunction')
    }
  })

  it('session_start 前 execute throw（runtime 未初始化；W4：pi 只采信 throw）', async () => {
    const { pi, tools, events } = createMockPi()
    schedulerExtension(pi)
    const fakeCtx = createFakeCtx()

    // 不触发 session_start，runtime 仍为 null
    expect(events.get('session_start')).toBeDefined()

    // W4：错误 throw 传播——pi catch 后置 isError:true，文案（含 Error: 前缀格式，R3）进 toolResult
    await expect(
      tools[0]!.execute('call-1', { prompt: 'x', schedule: '5m' }, undefined, undefined, fakeCtx),
    ).rejects.toThrow('Error: Scheduler not initialized: session not started')
  })

  it('session_start 后 execute 正常返回结果', async () => {
    const { pi, tools, events } = createMockPi()
    schedulerExtension(pi)
    const fakeCtx = createFakeCtx()

    // 触发 session_start：runtime 被创建、loadTasks、startScheduler、refreshWidget
    const sessionStart = events.get('session_start')!
    await sessionStart({ type: 'session_start', reason: 'startup' }, fakeCtx)

    const result = await tools[0]!.execute('call-2', { prompt: 'check build', schedule: '5m' }, undefined, undefined, fakeCtx)
    // 正常路径：返回 content（非 isError）
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('Task "check build"')
  })

  it('execute 签名兼容 SDK 全签名（5 参数：toolCallId, params, signal, onUpdate, ctx）', async () => {
    const { pi, tools, events } = createMockPi()
    schedulerExtension(pi)
    const fakeCtx = createFakeCtx()
    await events.get('session_start')!({ type: 'session_start', reason: 'startup' }, fakeCtx)

    // 传全 5 参，signal/onUpdate 为 undefined，不应抛
    const result = await tools[0]!.execute('call-full', { prompt: 'x', schedule: '1h' }, undefined, undefined, fakeCtx)
    expect(result.isError).toBeFalsy()
  })

  it('handler 业务失败 throw（W4：返回值 isError 被 pi 丢弃，throw 才被采信）', async () => {
    const { pi, tools, events } = createMockPi()
    schedulerExtension(pi)
    const fakeCtx = createFakeCtx()
    await events.get('session_start')!({ type: 'session_start', reason: 'startup' }, fakeCtx)

    // 非法 cron 表达式：service.create 失败 → toToolResult throw service message 本体
    //（无 'Error:' 前缀——前缀格式仅 index.ts 的初始化异常兜底使用）
    await expect(
      tools[0]!.execute('call-err', { prompt: 'x', schedule: 'invalid-cron-expr-xxx' }, undefined, undefined, fakeCtx),
    ).rejects.toThrow('Invalid schedule')
  })

  it('schedule_control tool 业务失败同样 throw（W4）', async () => {
    const { pi, tools, events } = createMockPi()
    schedulerExtension(pi)
    const fakeCtx = createFakeCtx()
    await events.get('session_start')!({ type: 'session_start', reason: 'startup' }, fakeCtx)

    // toggle 不存在的 task id：service 返回 TASK_NOT_FOUND → throw message 本体
    const controlTool = tools.find(t => t.name === 'schedule_control')!
    await expect(
      controlTool.execute('call-ctrl', { action: 'toggle', id: 'deadbeef', enabled: false }, undefined, undefined, fakeCtx),
    ).rejects.toThrow('Task deadbeef not found.')
  })

  it('registerCommand 注册了名为 schedule 的命令', () => {
    const { pi, commands } = createMockPi()
    schedulerExtension(pi)
    expect(commands.map(c => c.name)).toContain('schedule')
  })

  // MF-1（R2）装配链路：session_start → importLegacyStore 返回延迟删除 cleanup；
  // turn_end 触发 cleanup（主触发点，flush 已发生）；session_shutdown 兜底再调 + 复位。
  it('MF-1 装配：turn_end / session_shutdown 调用延迟删除 cleanup，importer 仅 session_start 调 1 次', async () => {
    const { pi, events } = createMockPi()
    schedulerExtension(pi)
    const fakeCtx = createFakeCtx()

    // 其他用例也触发 session_start，先清调用记录（mockClear 保留实现）
    vi.mocked(importLegacyStore).mockClear()

    // session_start → importLegacyStore 调用 1 次，返回 cleanup（新 session 未 flush 延迟删除路径）
    await events.get('session_start')!({ type: 'session_start', reason: 'startup' }, fakeCtx)
    expect(importLegacyStore).toHaveBeenCalledTimes(1)
    const cleanup = vi.mocked(importLegacyStore).mock.results[0]!.value
    expect(typeof cleanup).toBe('function')

    // turn_end（首个 turn 完成，flush 已发生）→ cleanup 被调用——跨 session 双导入窗口闭合点
    await events.get('turn_end')!()
    expect(cleanup).toHaveBeenCalledTimes(1)

    // session_shutdown → 兜底再调一次（覆盖从未产生 turn 的 session），随后复位
    await events.get('session_shutdown')!()
    expect(cleanup).toHaveBeenCalledTimes(2)
  })
})
