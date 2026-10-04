/**
 * RT-6 code-harden 定向回归（P9 收尾批次）。
 *
 * 覆盖三行：
 * - RT-6#2（major）：BridgeToolCache 跨插件同名 schema 遮蔽——syncFrom 按裸名查重 warn +
 *   首见优先消歧；getSyncPayload 不前递同名项（tool-api.ts 注册入口按复合键
 *   `pluginId:name` 查重的语义不变，本测试不触碰注册路径）。
 * - RT-6#3（major）：HookPipeline 无 handle skip / handler 失败或超时 → 聚合 warn
 *   （含 pluginId + hookType + sessionId），每 N 次一条（禁逐条刷屏）。
 * - RT-6#4（major）：HookPipeline observe 腿在途深度上限 → 超限 drop + 聚合 warn。
 * - RT-6#7（minor）：executeCommand 下发后触发 broadcastCommandStarted（在途反馈）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/plugin-service/__tests__/rt6-hardening.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BridgeToolCache } from '../bridge-interop.js'
import { HookPipeline, HOOK_ANOMALY_WARN_EVERY } from '../hook-pipeline.js'
import type { HookPipelineDeps } from '../hook-pipeline.js'
import { executeCommand } from '../api/commands-executor.js'
import type { CommandExecutorDeps } from '../api/commands-executor.js'
import type { CommandRegistration } from '../api/commands-api.js'
import { PendingTracker } from '../../../utils/async/pending-tracker.js'
import { PluginService } from '../plugin-service.js'
import type { PluginHost } from '../plugin-host.js'
import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { ToolEntry, HookEntry, HookContext, HookType, PluginDescriptor } from '../plugin-types.js'

// ── RT-6#2：跨插件同名工具 ────────────────────────────────────────

function toolEntry(pluginId: string, name: string, description: string): ToolEntry {
  return {
    pluginId,
    handlerId: `${pluginId}:${name}`,
    schema: { name, description, parameters: { type: 'object', properties: {} } },
  }
}

describe('RT-6#2 BridgeToolCache 裸名跨插件查重 + 消歧', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('同名跨插件：warn 留痕（含两个 pluginId），且执行路由索引不被后写覆盖', () => {
    const cache = new BridgeToolCache()
    const registry = new Map<string, ToolEntry>([
      ['plugin-a:dup', toolEntry('plugin-a', 'dup', 'from A')],
      ['plugin-b:dup', toolEntry('plugin-b', 'dup', 'from B')],
    ])

    cache.syncFrom(registry)

    const texts = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(texts).toContain('dup')
    expect(texts).toContain('plugin-a')
    expect(texts).toContain('plugin-b')
    // 首见优先（registry 插入序 = 注册序）：A 不被 B 静默顶掉
    expect(cache.getEntryByName('dup')?.pluginId).toBe('plugin-a')
  })

  it('同名跨插件：getSyncPayload 不前递同名项（首见优先，仅一条）', () => {
    const cache = new BridgeToolCache()
    cache.syncFrom(new Map<string, ToolEntry>([
      ['plugin-a:dup', toolEntry('plugin-a', 'dup', 'from A')],
      ['plugin-b:dup', toolEntry('plugin-b', 'dup', 'from B')],
    ]))

    const payload = cache.getSyncPayload()
    expect(payload.tools).toEqual([
      { name: 'dup', description: 'from A', parameters: { type: 'object', properties: {} } },
    ])
    expect(payload.success).toBe(true)
  })

  it('异名插件：无 warn、两条 schema 均下发（不误伤正常路径）', () => {
    const cache = new BridgeToolCache()
    cache.syncFrom(new Map<string, ToolEntry>([
      ['plugin-a:alpha', toolEntry('plugin-a', 'alpha', 'A alpha')],
      ['plugin-b:beta', toolEntry('plugin-b', 'beta', 'B beta')],
    ]))

    expect(warnSpy).not.toHaveBeenCalled()
    expect(cache.getSyncPayload().tools.map((t) => t.name)).toEqual(['alpha', 'beta'])
    expect(cache.getEntryByName('alpha')?.pluginId).toBe('plugin-a')
    expect(cache.getEntryByName('beta')?.pluginId).toBe('plugin-b')
  })
})

// ── RT-6#3 / RT-6#4：HookPipeline 可观测性 + observe 背压 ──────────

function makeContext(hookType: HookType, sessionId: string): HookContext {
  return { pluginId: '', hookType, data: { eventName: 'turn_end', data: {}, sessionId }, timestamp: Date.now() }
}

function setupPipeline(
  hookType: HookType,
  entries: HookEntry[],
  opts: { workerId?: string | null } = {},
): { pipeline: HookPipeline; deps: HookPipelineDeps } {
  const workerId = opts.workerId === undefined ? 'worker-1' : opts.workerId
  const hookRegistry = new Map<string, HookEntry[]>([[hookType, entries]])
  const host = {
    getWorkerHandle: vi.fn().mockReturnValue(workerId === null ? undefined : { workerId, postMessage: vi.fn() }),
  }
  const rpcServer = { invoke: vi.fn(), notify: vi.fn() }
  const deps = {
    hookRegistry,
    host: host as unknown as PluginHost,
    rpcServer: rpcServer as unknown as PluginRpcServer,
  }
  return { pipeline: new HookPipeline(deps), deps }
}

describe('RT-6#3 HookPipeline skip/失败聚合 warn', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('execute：无 handle → warn 含 pluginId/hookType/sessionId（不再零日志 continue）', async () => {
    const { pipeline } = setupPipeline('onBeforeAgentStart', [
      { pluginId: 'p-gone', handlerId: 'p-gone:h1', priority: 0 },
    ], { workerId: null })

    // 聚合节流：到达 N 的整数倍才输出一条（禁逐条刷屏），内容断言需跑满一轮
    for (let i = 0; i < HOOK_ANOMALY_WARN_EVERY; i++) {
      const result = await pipeline.execute('onBeforeAgentStart', makeContext('onBeforeAgentStart', 'sid-1'))
      expect(result).toEqual({ blocked: false })
    }

    const texts = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(texts).toContain('p-gone')
    expect(texts).toContain('onBeforeAgentStart')
    expect(texts).toContain('sid-1')
    expect(texts).toContain('skipped total=10')
  })

  it('execute：handler 超时/抛错 → warn 含 pluginId/hookType/sessionId + 失败原因', async () => {
    const { pipeline, deps } = setupPipeline('onBeforeAgentStart', [
      { pluginId: 'p-slow', handlerId: 'p-slow:h1', priority: 0 },
    ])
    ;(deps.rpcServer.invoke as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('RPC timeout'))

    for (let i = 0; i < HOOK_ANOMALY_WARN_EVERY; i++) {
      await pipeline.execute('onBeforeAgentStart', makeContext('onBeforeAgentStart', 'sid-2'))
    }

    const texts = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(texts).toContain('p-slow')
    expect(texts).toContain('onBeforeAgentStart')
    expect(texts).toContain('sid-2')
    expect(texts).toContain('RPC timeout')
    expect(texts).toContain('failed total=10')
  })

  it('notifyObservers：无 handle 同样 warn 留痕（observe 腿不再静默 skip）', () => {
    const { pipeline } = setupPipeline('onPiEvent', [
      { pluginId: 'p-gone', handlerId: 'p-gone:h1', priority: 0 },
    ], { workerId: null })

    for (let i = 0; i < HOOK_ANOMALY_WARN_EVERY; i++) {
      pipeline.notifyObservers('onPiEvent', makeContext('onPiEvent', 'sid-3'))
    }

    const texts = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(texts).toContain('p-gone')
    expect(texts).toContain('onPiEvent')
    expect(texts).toContain('sid-3')
  })

  it('聚合节流：N 次以内只 warn 一次（禁逐条刷屏），计数达到 N 的整数倍再输出', async () => {
    const { pipeline } = setupPipeline('onBeforeAgentStart', [
      { pluginId: 'p-gone', handlerId: 'p-gone:h1', priority: 0 },
    ], { workerId: null })

    for (let i = 0; i < 9; i++) {
      await pipeline.execute('onBeforeAgentStart', makeContext('onBeforeAgentStart', 'sid-4'))
    }
    expect(warnSpy).not.toHaveBeenCalled()

    await pipeline.execute('onBeforeAgentStart', makeContext('onBeforeAgentStart', 'sid-4'))
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const texts = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(texts).toContain('skipped total=10')
  })
})

describe('RT-6#4 HookPipeline observe 腿在途深度上限', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('同步突发超过上限 → 超出部分 drop + warn，未超限部分照常 notify', () => {
    // 120 个 handler × 同一次 notifyObservers（同步循环内槽位未释放）→ 上限 64，
    // 前 64 下发、后 56 drop。
    const entries: HookEntry[] = Array.from({ length: 120 }, (_, i) => ({
      pluginId: `p-${i}`,
      handlerId: `p-${i}:h`,
      priority: i,
    }))
    const { pipeline, deps } = setupPipeline('onPiEvent', entries)
    const notify = deps.rpcServer.notify as unknown as ReturnType<typeof vi.fn>

    pipeline.notifyObservers('onPiEvent', makeContext('onPiEvent', 'sid-5'))

    expect(notify).toHaveBeenCalledTimes(64)
    const texts = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(texts).toContain('dropped')
    expect(texts).toContain('in-flight depth at limit')
  })

  it('跨事件循环轮次：槽位释放后不再误 drop（正常高频路径不受影响）', async () => {
    const { pipeline, deps } = setupPipeline('onPiEvent', [
      { pluginId: 'p-1', handlerId: 'p-1:h', priority: 0 },
    ])
    const notify = deps.rpcServer.notify as unknown as ReturnType<typeof vi.fn>

    for (let i = 0; i < 200; i++) {
      pipeline.notifyObservers('onPiEvent', makeContext('onPiEvent', 'sid-6'))
      // 让宏任务（槽位释放定时器）跑完再进下一轮
      await new Promise((r) => setTimeout(r, 0))
    }

    expect(notify).toHaveBeenCalledTimes(200)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

// ── RT-6#6：toggle/uninstall 失败不再「只 log 回成功形状」 ─────────────

function makeBroker() {
  return { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() }
}

describe('RT-6#6 togglePlugin 失败透出领域错误', () => {
  it('激活失败 → 广播回滚列表 + 抛带 code 的错误（不再回成功形状）', async () => {
    const broker = makeBroker()
    const service = new PluginService({} as never, broker)
    ;(service as unknown as { registry: unknown }).registry = {
      getDescriptor: vi.fn().mockReturnValue({ pluginId: 'p1', status: 'INACTIVE' }),
      getAllDescriptors: vi.fn().mockReturnValue([]),
    }
    ;(service as unknown as { activator: unknown }).activator = {
      activatePlugin: vi.fn().mockRejectedValue(new Error('boot timeout')),
      stopWatching: vi.fn(),
      getState: vi.fn().mockReturnValue('INACTIVE'),
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(service.togglePlugin('p1', true)).rejects.toThrow(/boot timeout/)
      await service.togglePlugin('p1', true).catch((e: unknown) => {
        expect((e as { code?: string }).code).toBe('PLUGIN_TOGGLE_FAILED')
      })
      // 回滚通道保留：仍广播最新列表（前端订阅据此复位 UI）
      expect(broker.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'config.plugins' }),
      )
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('停用失败 → 同样抛错（开关回弹不再静默）', async () => {
    const service = new PluginService({} as never, makeBroker())
    ;(service as unknown as { registry: unknown }).registry = {
      getDescriptor: vi.fn().mockReturnValue({ pluginId: 'p2', status: 'ACTIVE' }),
      getAllDescriptors: vi.fn().mockReturnValue([]),
    }
    ;(service as unknown as { activator: unknown }).activator = {
      deactivatePlugin: vi.fn().mockRejectedValue(new Error('deactivate hung')),
      stopWatching: vi.fn(),
      getState: vi.fn().mockReturnValue('ACTIVE'),
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(service.togglePlugin('p2', false)).rejects.toThrow(/deactivate hung/)
    vi.restoreAllMocks()
  })

  it('成功路径不回退：toggle 成功仍返回列表且不抛', async () => {
    const service = new PluginService({} as never, makeBroker())
    ;(service as unknown as { registry: unknown }).registry = {
      getDescriptor: vi.fn().mockReturnValue({ pluginId: 'p3', status: 'INACTIVE' }),
      getAllDescriptors: vi.fn().mockReturnValue([]),
    }
    ;(service as unknown as { activator: unknown }).activator = {
      activatePlugin: vi.fn().mockResolvedValue(undefined),
      stopWatching: vi.fn(),
      getState: vi.fn().mockReturnValue('ACTIVE'),
    }

    await expect(service.togglePlugin('p3', true)).resolves.toEqual([])
  })
})

// ── RT-6#7：command started 广播 ──────────────────────────────────

describe('RT-6#7 executeCommand 下发后广播 started', () => {
  it('notify 成功后触发 broadcastCommandStarted（含 pluginId/commandId/handlerId）', async () => {
    const registration: CommandRegistration = {
      handlerId: 'p1:h1',
      commandId: 'cmd1',
      pluginId: 'p1',
      workerId: 'w1',
      registeredAt: Date.now(),
    }
    const notify = vi.fn()
    const broadcast = vi.fn()
    const deps: CommandExecutorDeps = {
      registry: { getDescriptor: () => ({ pluginId: 'p1' }) as PluginDescriptor },
      host: { getWorkerHandle: () => ({ workerId: 'w1', postMessage: () => {} }) },
      rpcServer: { notify },
      commandRegistry: new Map([['p1:cmd1', registration]]),
      commandInvokes: new PendingTracker<string, unknown>(),
      broadcast,
    }

    void executeCommand(deps, 'p1', 'cmd1', { a: 1 }).catch(() => {})

    expect(notify).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
    const [type, id, payload] = broadcast.mock.calls[0]!
    expect(type).toBe('plugin:notification')
    expect(String(id)).toContain('cmdStarted_p1:cmd1_')
    const started = payload as { pluginId: string; level: string; message: string }
    expect(started.pluginId).toBe('p1')
    expect(started.level).toBe('info')
    expect(started.message).toContain("'cmd1'")
    expect(started.message).toContain("'p1:h1'")
  })

  it('未注入 broadcast 时不炸（可选依赖）', async () => {
    const registration: CommandRegistration = {
      handlerId: 'p2:h1',
      commandId: 'cmd2',
      pluginId: 'p2',
      workerId: 'w2',
      registeredAt: Date.now(),
    }
    const notify = vi.fn()
    const commandInvokes = new PendingTracker<string, unknown>()
    const deps: CommandExecutorDeps = {
      registry: { getDescriptor: () => ({ pluginId: 'p2' }) as PluginDescriptor },
      host: { getWorkerHandle: () => ({ workerId: 'w2', postMessage: () => {} }) },
      rpcServer: { notify },
      commandRegistry: new Map([['p2:cmd2', registration]]),
      commandInvokes,
    }

    // 不 await（pending 等 30min 兜底）——只验下发路径不因缺省依赖抛错
    void executeCommand(deps, 'p2', 'cmd2').catch(() => {})
    expect(notify).toHaveBeenCalledTimes(1)
    expect(commandInvokes.has('p2:h1')).toBe(true)
  })
})
