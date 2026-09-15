/**
 * contract-hardening.test.ts — api-contract-hardening slice 单元验收
 * （S3-W1 + S3-W2 + S3-W3 窄校验 + S3-W4 限流/毒化隔离）
 *
 * 覆盖：
 * - 命令执行链复合键：插件 B 无法覆盖/注销插件 A 的同名命令（register/unregister
 *   按 `pluginId:commandId` 复合键隔离）；commandId 含 ':' 被拒；sandbox 通道
 *   身份覆写后伪冒 pluginId 不改变键归属
 * - tool/hook 注销归属隔离（MF-1，D7 同语义）：tools.unregister 校验 toolKey
 *   前缀 `${pluginId}:`、hooks.unregister 比对 entry.pluginId，跨插件注销 no-op；
 *   sandbox 通道身份覆写后伪冒 pluginId 无法跨插件注销
 * - runtime→Worker 发送段闭环：executeCommand 经 rpcServer.notify 发
 *   plugin.commands.invoke（mock Worker port 收到），Worker 经
 *   plugin.commands.invoke.result 回传结果/错误 → pending resolve/reject
 * - sessions 定向投递：registerCreate/registerDestroy 建注册表（handlerId →
 *   workerId），didCreate/didDestroy 只投递到注册 Worker；unregister /
 *   clearForPlugin 停止投递
 * - sessions 创建入口收敛：lifecycle create / restoreSession / forkSession 三处
 *   spawn 路径均触发 notifySessionCreated；销毁汇聚点 removeSessionEntry 触发
 *   onSessionDestroyed
 * - events 显式降级：api.events.on / emit 调用即抛 NOT_IMPLEMENTED（含 issue 指引）
 * - CT-U1（S3-W3）：40+ RPC 方法 params 畸形输入（缺字段/错类型/越界键）返回
 *   INVALID_* 结构化错误（error.code）且零写副作用；asString/asSafeKey/
 *   asBoundedString 工具正反例
 * - CT-D3（S3-W4）：notify 每插件令牌桶（默认 20 条/s，超限丢弃记日志）；
 *   message >8KB 拒；statusbar text >4KB 拒；statusbar 更新 100ms 合并窗口；
 *   常量可配置（构造参数覆盖 shared SSOT 默认值）
 * - CT-D4（S3-W4）：statusbar 单条坏 item（text:{}）拒绝该条并记宿主日志，
 *   其余条目与后续更新不受影响（不整包丢弃）
 *
 * 运行：cd packages/runtime && npx vitest run test/contract-hardening.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// fork 用例 mock 截断函数（真实 createForkedSessionFile 操作 sessions 数据目录，
// 单测无该基建；返回受控 filePath 指向真实 tmp 文件供后续 strip/switch 流程使用）
vi.mock('../src/services/session/session-fork.js', () => ({
  createForkedSessionFile: vi.fn(async () => ({ filePath: '', sessionId: 'fork-1' })),
}))

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import {
  registerCommandRpcHandlers,
  commandCompositeKey,
  COMMAND_RPC_METHODS,
} from '../src/services/plugin-service/api/commands-api.js'
import type { CommandRegistration } from '../src/services/plugin-service/api/commands-api.js'
import {
  SessionEventDispatch,
  SESSION_EVENT_METHODS,
  registerSessionRpcHandlers,
} from '../src/services/plugin-service/api/session-api.js'
import { registerAgentRpcHandlers } from '../src/services/plugin-service/api/agent-api.js'
import { registerConfigRpcHandlers } from '../src/services/plugin-service/api/config-api.js'
import { registerStorageRpcHandlers } from '../src/services/plugin-service/api/storage-api.js'
import { registerSessionDataRpcHandlers } from '../src/services/plugin-service/api/session-data-api.js'
import { registerUiRpcHandlers } from '../src/services/plugin-service/api/ui-api.js'
import { registerViewRpcHandlers } from '../src/services/plugin-service/api/views-api.js'
import { registerWorkspaceRpcHandlers } from '../src/services/plugin-service/api/workspace-api.js'
import { registerToolRpcHandlers } from '../src/services/plugin-service/tool-api.js'
import { registerHookRpcHandlers } from '../src/services/plugin-service/hook-api.js'
import { NotifyRateLimiter, registerNotifyRpcHandler } from '../src/services/plugin-service/api/notify-api.js'
import { StatusBarRegistry } from '../src/services/plugin-service/status-bar-registry.js'
import { asBoundedString, asSafeKey, asString } from '../src/services/plugin-service/validation.js'
import { PLUGIN_NOTIFY_LIMITS } from '@taiji/shared'
import type { SessionInfo } from '../src/services/plugin-service/plugin-types.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { createAgentAPI } from '../src/services/plugin-service/plugin-bootstrap.js'
import { SessionLifecycle, setMigrationGate } from '../src/services/session/session-lifecycle.js'
import { SessionService } from '../src/services/session/session-service.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../src/services/session/session-internal.js'
import type { IEventAdapter } from '../src/interfaces.js'
import type { IProcessManager } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { IExtensionService, IMessageBroker } from '../src/interfaces.js'
import type { IManagedSessionView, ScannedSession } from '../src/services/session/types.js'
import type { SessionSummary } from '@taiji/shared'

// ══════════════════════════════════════════════════════════════════
// 共用测试基建
// ══════════════════════════════════════════════════════════════════

/** 记录 postMessage 收到的消息（plugin-rpc.test.ts 同款） */
function createMockPort(): WorkerPort & { messages: Array<Record<string, unknown>> } {
  const messages: Array<Record<string, unknown>> = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg as Record<string, unknown>)
    },
  }
}

function createMockBroker(): IMessageBroker {
  return { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() }
}

/** 从 mock port 收到的消息中提取全部 rpc 通知（method + params） */
function notificationsOf(port: { messages: Array<Record<string, unknown>> }): Array<{ method: string; params: Record<string, unknown> }> {
  return port.messages
    .filter(m => m.type === 'rpc' && (m as { notification?: unknown }).notification)
    .map(m => {
      const n = (m as { notification: { method: string; params: Record<string, unknown> } }).notification
      return { method: n.method, params: n.params }
    })
}

/** 构造最小 lifecycle 环境（session-lifecycle-gate.test.ts 同款模式） */
function makeLifecycleEnv() {
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s: IManagedSessionView): SessionSummary => ({
      id: s.id, label: `label-${s.id}`, cwd: '/tmp', status: 'active',
      lastActiveAt: Date.now(), modelId: 'p/m', tokenCount: 0,
    })),
    findScannedSession: vi.fn((): ScannedSession | undefined => undefined),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    // S3-W2 被测收敛点
    notifySessionCreated: vi.fn(),
    // S2 ISP 化：结构性满足 lifecycle 窄接口（10 方法 = 实际消费面），无强转
    removeSessionEntry: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
  }
  const client = {
    getState: vi.fn(async () => ({ sessionId: 'sess-1', sessionFile: undefined })),
    switchSession: vi.fn(async () => undefined),
  }
  const pm = {
    createSession: vi.fn(async () => client),
    rekey: vi.fn(),
    destroySession: vi.fn(async () => undefined),
    // D5② 短路预检读点（session-dead-structural-fixes）：undefined = 无 client → 不短路 → 全流程。
    getClient: vi.fn(() => undefined),
  } as unknown as IProcessManager
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService

  // S3 写点归位：注册走真 registerSession（svc.initializeManagedSession 已从接口移除），
  // 装配依赖注入 fake adapterFactory。
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
    notifyMessageComplete: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { svc, pm, configStore, sessionStore, workspaceService, client, lifecycle }
}

// ══════════════════════════════════════════════════════════════════
// S3-W1 — 命令表复合键隔离
// ══════════════════════════════════════════════════════════════════

describe('命令表复合键隔离（pluginId:commandId）', () => {
  let rpc: PluginRpcServer
  let registry: Map<string, CommandRegistration>
  let port: ReturnType<typeof createMockPort>

  beforeEach(() => {
    rpc = new PluginRpcServer()
    registry = new Map()
    port = createMockPort()
    rpc.registerWorker('w1', port)
    registerCommandRpcHandlers(rpc, {
      registry,
      broadcastRegistered: vi.fn(),
      deliverInvokeResult: vi.fn(),
    })
  })

  function dispatchRegister(workerId: string, pluginId: string, commandId: string, handlerId: string): Promise<void> {
    return rpc.dispatch(workerId, {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 100000),
      method: COMMAND_RPC_METHODS.register,
      params: { pluginId, command: { id: commandId }, handlerId },
    })
  }

  it('插件 A 与插件 B 注册同名命令 x：registry 两条共存，B 不覆盖 A', async () => {
    await dispatchRegister('w1', 'A', 'x', 'h-A')
    await dispatchRegister('w1', 'B', 'x', 'h-B')

    expect(registry.get(commandCompositeKey('A', 'x'))).toMatchObject({ pluginId: 'A', handlerId: 'h-A' })
    expect(registry.get(commandCompositeKey('B', 'x'))).toMatchObject({ pluginId: 'B', handlerId: 'h-B' })
    expect(registry.size).toBe(2)
  })

  it('插件 B 注销 x 只删自身（B:x），A:x 不受影响', async () => {
    await dispatchRegister('w1', 'A', 'x', 'h-A')
    await dispatchRegister('w1', 'B', 'x', 'h-B')

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 2,
      method: COMMAND_RPC_METHODS.unregister,
      params: { pluginId: 'B', commandId: 'x' },
    })

    expect(registry.has(commandCompositeKey('A', 'x'))).toBe(true)
    expect(registry.has(commandCompositeKey('B', 'x'))).toBe(false)
  })

  it('插件 B 传注入形态 commandId="A:x" 注销：键为 B:A:x（不存在），A:x 原样保留', async () => {
    await dispatchRegister('w1', 'A', 'x', 'h-A')

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 3,
      method: COMMAND_RPC_METHODS.unregister,
      params: { pluginId: 'B', commandId: 'A:x' },
    })

    expect(registry.has(commandCompositeKey('A', 'x'))).toBe(true)
    expect(registry.size).toBe(1)
  })

  it('register 拒绝含 ":" 的 commandId（复合键注入防护），注册失败返回错误响应', async () => {
    await dispatchRegister('w1', 'B', 'A:x', 'h-inject')

    expect(registry.size).toBe(0)
    const responses = port.messages.filter(m => m.type === 'rpc' && (m as { response?: unknown }).response)
    const last = responses[responses.length - 1] as { response: { error?: { message: string } } }
    expect(last.response.error?.message).toContain('INVALID_COMMAND_ID')
  })

  it('sandbox 通道身份覆写：插件 B 伪冒 pluginId="A" 注册，键仍按通道身份 B 隔离', async () => {
    // 宿主已注册的通道身份（security slice resolveIdentity 同款装配）
    rpc.registerIdentity('w1', { trustLevel: 'sandbox', pluginId: 'B' })
    await dispatchRegister('w1', 'A', 'x', 'h-spoof') // 消息体自报 pluginId='A'

    // dispatch 身份覆写后 params.pluginId 被强制改为 'B' → 键 B:x，A:x 未被伪造
    expect(registry.has(commandCompositeKey('A', 'x'))).toBe(false)
    expect(registry.get(commandCompositeKey('B', 'x'))).toMatchObject({ pluginId: 'B', handlerId: 'h-spoof' })
  })
})

// ──────────────────────────────────────────────────────────
// MF-1 — tool/hook 注销归属隔离（D7：与 commands 域复合键语义对齐）
// ──────────────────────────────────────────────────────────

describe('tool/hook 注销归属隔离（D7）', () => {
  let rpc: PluginRpcServer
  let toolRegistry: Map<string, unknown>
  let hookRegistry: Map<string, Array<{ pluginId: string; handlerId: string; priority: number }>>
  let port: ReturnType<typeof createMockPort>
  let syncCalls: number

  beforeEach(() => {
    rpc = new PluginRpcServer()
    toolRegistry = new Map()
    hookRegistry = new Map()
    syncCalls = 0
    port = createMockPort()
    rpc.registerWorker('w1', port)
    registerToolRpcHandlers(rpc, {
      toolRegistry: toolRegistry as never,
      syncToolsToBridge: async () => {
        syncCalls++
      },
    })
    registerHookRpcHandlers(rpc, {
      hookRegistry: hookRegistry as never,
      getDescriptor: () => undefined,
    })
  })

  function seedTool(pluginId: string, name: string): void {
    toolRegistry.set(`${pluginId}:${name}`, {
      pluginId,
      handlerId: `${pluginId}:${name}`,
      schema: { name, description: '', parameters: {} },
    })
  }

  function seedHook(pluginId: string, handlerId: string, hookType = 'onPiEvent'): void {
    const entries = hookRegistry.get(hookType) ?? []
    entries.push({ pluginId, handlerId, priority: 200 })
    hookRegistry.set(hookType, entries)
  }

  it('tools.unregister：插件 B 传 A:xxx → no-op，A 的注册不受影响；B 注销自身前缀正常删除', async () => {
    seedTool('A', 'xxx')
    seedTool('B', 'yyy')

    // B 试图注销 A 的工具（裸 toolKey 无归属校验时会被删）
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 1, method: 'plugin.tools.unregister',
      params: { pluginId: 'B', toolKey: 'A:xxx' },
    })
    expect(toolRegistry.has('A:xxx')).toBe(true)
    expect(syncCalls).toBe(0)

    // B 注销自身工具 → 删除 + sync
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 2, method: 'plugin.tools.unregister',
      params: { pluginId: 'B', toolKey: 'B:yyy' },
    })
    expect(toolRegistry.has('B:yyy')).toBe(false)
    expect(syncCalls).toBe(1)
  })

  it('tools.unregister：sandbox 通道身份覆写后 B 伪冒 pluginId="A" 仍无法删 A 的工具', async () => {
    rpc.registerIdentity('w1', { trustLevel: 'sandbox', pluginId: 'B' })
    seedTool('A', 'xxx')

    // 消息体自报 pluginId='A'，dispatch 覆写为通道身份 'B' → 前缀不匹配 → no-op
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 3, method: 'plugin.tools.unregister',
      params: { pluginId: 'A', toolKey: 'A:xxx' },
    })
    expect(toolRegistry.has('A:xxx')).toBe(true)
    expect(syncCalls).toBe(0)
  })

  it('hooks.unregister：插件 B 传 hook_A_1 → no-op，A 的条目不受影响；B 注销自身正常删除', async () => {
    seedHook('A', 'hook_A_1')
    seedHook('B', 'hook_B_1')

    // B 试图注销 A 的 handler（handlerId 格式 hook_${pluginId}_${n} 可猜测）
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 4, method: 'plugin.hooks.unregister',
      params: { pluginId: 'B', hookType: 'onPiEvent', handlerId: 'hook_A_1' },
    })
    expect(hookRegistry.get('onPiEvent')!.some(e => e.handlerId === 'hook_A_1')).toBe(true)

    // B 注销自身 handler → 条目被删（该类型仅剩 A 的条目，hookType 键保留）
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 5, method: 'plugin.hooks.unregister',
      params: { pluginId: 'B', hookType: 'onPiEvent', handlerId: 'hook_B_1' },
    })
    const entries = hookRegistry.get('onPiEvent')!
    expect(entries.some(e => e.handlerId === 'hook_B_1')).toBe(false)
    expect(entries.some(e => e.handlerId === 'hook_A_1')).toBe(true)
  })

  it('hooks.unregister：sandbox 通道身份覆写后 B 伪冒 pluginId="A" 仍无法删 A 的 handler', async () => {
    rpc.registerIdentity('w1', { trustLevel: 'sandbox', pluginId: 'B' })
    seedHook('A', 'hook_A_1')

    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 6, method: 'plugin.hooks.unregister',
      params: { pluginId: 'A', hookType: 'onPiEvent', handlerId: 'hook_A_1' },
    })
    expect(hookRegistry.get('onPiEvent')!.some(e => e.handlerId === 'hook_A_1')).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════
// S3-W1 — runtime→Worker 发送段闭环（executeCommand → invoke 通知 → result 回传）
// ══════════════════════════════════════════════════════════════════

describe('命令执行发送段闭环（executeCommand → plugin.commands.invoke → invoke.result）', () => {
  let tmpDir: string
  let service: PluginService
  let rpcServer: PluginRpcServer
  let port: ReturnType<typeof createMockPort>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'contract-cmd-'))
    const registryMock = {
      getDescriptor: vi.fn(() => ({ pluginId: 'p1', pluginPath: '/tmp/p1' })),
      getAllDescriptors: () => [],
    }
    service = new PluginService(registryMock as never, createMockBroker(), { configDir: tmpDir })
    // 真实 RPC 方法注册（含 plugin.commands.invoke.result）
    ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()
    rpcServer = (service as unknown as { rpcServer: PluginRpcServer }).rpcServer
    port = createMockPort()
    rpcServer.registerWorker('w1', port)
    // 预置命令注册表条目（register 链路由复合键用例覆盖；此处聚焦发送段）。
    // workerId='w1' 与回传 dispatch 来源一致（D2 回传归属校验比对基准）
    const commandRegistry = (service as unknown as { commandRegistry: Map<string, CommandRegistration> }).commandRegistry
    commandRegistry.set(commandCompositeKey('p1', 'cmd1'), {
      commandId: 'cmd1', pluginId: 'p1', handlerId: 'h1', workerId: 'w1', registeredAt: Date.now(),
    })
    // host 替换：getWorkerHandle 返回受控 workerId（PluginHost 真实装配归集成层）
    ;(service as unknown as {
      host: { getWorkerHandle: (pluginId: string) => { workerId: string } | undefined }
    }).host = { getWorkerHandle: () => ({ workerId: 'w1' }) }
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 模拟 Worker 侧 invoke.result 回传（经真实 dispatch → deliverInvokeResult → pending） */
  function workerReplies(handlerId: string, payload: { result?: unknown; error?: unknown }): Promise<void> {
    return rpcServer.dispatch('w1', {
      jsonrpc: '2.0',
      id: 99000 + Math.floor(Math.random() * 999),
      method: COMMAND_RPC_METHODS.invokeResult,
      params: { handlerId, ...payload },
    })
  }

  it('executeCommand 向 Worker 发 plugin.commands.invoke（handlerId+args）并经 result 回传拿到返回值', async () => {
    const pending = service.executeCommand('p1', 'cmd1', { x: 1 })
    // 发送段：Worker port 收到 invoke 通知（方法名常量 + 复合键对应的 handlerId）
    await vi.waitFor(() => {
      const invokes = notificationsOf(port).filter(n => n.method === COMMAND_RPC_METHODS.invoke)
      expect(invokes).toHaveLength(1)
      expect(invokes[0]!.params).toEqual({ handlerId: 'h1', args: { x: 1 } })
    })

    await workerReplies('h1', { result: 'result-ok' })
    await expect(pending).resolves.toBe('result-ok')
  })

  it('Worker 回传 error 字段：executeCommand 以含错误信息的 Error reject', async () => {
    const pending = service.executeCommand('p1', 'cmd1', {})
    await vi.waitFor(() => {
      expect(notificationsOf(port).some(n => n.method === COMMAND_RPC_METHODS.invoke)).toBe(true)
    })

    await workerReplies('h1', { error: 'handler blew up' })
    await expect(pending).rejects.toThrow('handler blew up')
  })

  it('executeCommand 查复合键：未注册的命令（B:x 未注册）报 Command not found 且不发通知', async () => {
    await expect(service.executeCommand('B', 'x', {})).rejects.toThrow('Command not found: B:x')
    expect(notificationsOf(port).some(n => n.method === COMMAND_RPC_METHODS.invoke)).toBe(false)
  })

  it('并发执行同一命令被拒绝（pending 登记表防覆盖）', async () => {
    const first = service.executeCommand('p1', 'cmd1', {})
    await expect(service.executeCommand('p1', 'cmd1', {})).rejects.toThrow('already executing')
    // 收尾：resolve 第一个，避免悬挂 timer
    await workerReplies('h1', { result: undefined })
    await expect(first).resolves.toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════
// D2 — invoke.result 回传归属校验（handlerId 必须属于来源通道）
// ══════════════════════════════════════════════════════════════════

describe('invoke.result 回传归属校验（D2 回传段：handlerId 必须属于来源通道）', () => {
  let tmpDir: string
  let service: PluginService
  let rpcServer: PluginRpcServer
  let portA: ReturnType<typeof createMockPort>
  let portB: ReturnType<typeof createMockPort>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'contract-cmdown-'))
    const registryMock = {
      getDescriptor: vi.fn(() => ({ pluginId: 'p1', pluginPath: '/tmp/p1' })),
      getAllDescriptors: () => [],
    }
    service = new PluginService(registryMock as never, createMockBroker(), { configDir: tmpDir })
    ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()
    rpcServer = (service as unknown as { rpcServer: PluginRpcServer }).rpcServer
    portA = createMockPort()
    portB = createMockPort()
    rpcServer.registerWorker('wA', portA)
    rpcServer.registerWorker('wB', portB)
    // 命令 p1:cmd1 的执行 Worker 是通道 A（executeCommand 经它发 invoke 通知）
    ;(service as unknown as {
      host: { getWorkerHandle: (pluginId: string) => { workerId: string } | undefined }
    }).host = { getWorkerHandle: () => ({ workerId: 'wA' }) }
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 归属拒绝类 warn 的全部调用文案（滤除无关 warn，如 broadcastFn 缺失提示） */
  function ownershipWarnMessages(): string[] {
    return warnSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((msg: string) => msg.includes('invoke result'))
  }

  /** 经真实 register dispatch 在通道 A 注册命令 p1:cmd1（registration.workerId 由 ctx 捕获为 'wA'） */
  function registerOnA(handlerId: string): Promise<void> {
    return rpcServer.dispatch('wA', {
      jsonrpc: '2.0',
      id: 880000 + Math.floor(Math.random() * 999),
      method: COMMAND_RPC_METHODS.register,
      params: { pluginId: 'p1', command: { id: 'cmd1' }, handlerId },
    })
  }

  /** 从指定通道回传 invoke.result（workerId 即来源通道，归属校验比对对象） */
  function replyFrom(workerId: string, handlerId: string, payload: { result?: unknown; error?: unknown }): Promise<void> {
    return rpcServer.dispatch(workerId, {
      jsonrpc: '2.0',
      id: 890000 + Math.floor(Math.random() * 999),
      method: COMMAND_RPC_METHODS.invokeResult,
      params: { handlerId, ...payload },
    })
  }

  it('register 从 ctx 捕获注册通道：registration.workerId = 来源 workerId（通道身份，非消息体自报）', async () => {
    await registerOnA('h-A')
    const commandRegistry = (service as unknown as { commandRegistry: Map<string, CommandRegistration> }).commandRegistry
    expect(commandRegistry.get(commandCompositeKey('p1', 'cmd1'))?.workerId).toBe('wA')
  })

  it('a) 通道 B 伪造通道 A 的 handlerId 回 result：pending 不被 resolve，挂起至超时 reject + warn 落日志', async () => {
    vi.useFakeTimers()
    try {
      await registerOnA('h-A')
      const pending = service.executeCommand('p1', 'cmd1', {}) // 故意不 await：保持挂起观察
      // 发送段已到通道 A
      expect(notificationsOf(portA).some(n => n.method === COMMAND_RPC_METHODS.invoke)).toBe(true)

      // 通道 B（wB）伪造 h-A 的成功回传
      await replyFrom('wB', 'h-A', { result: 'forged' })

      // 拒绝投递落宿主日志：含 handlerId + 双方 workerId（可直接排查）
      const warns = ownershipWarnMessages()
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('h-A')
      expect(warns[0]).toContain('wA')
      expect(warns[0]).toContain('wB')

      // pending 保持挂起（未被 forged resolve）：推进超时窗口后以超时 reject。
      // 若归属校验缺失，pending 已被 resolve('forged')，此 rejects 断言失败。
      // （D4 后命令默认超时 = DEFAULT_TOOL_EXECUTE_TIMEOUT_MS 30min）
      vi.advanceTimersByTime(1_800_000)
      await expect(pending).rejects.toThrow("Command 'p1:cmd1' timed out after 30min")
    } finally {
      vi.useRealTimers()
    }
  })

  it('b) 通道 A 自身回传（归属一致）：pending 正常 resolve，无归属拒绝日志', async () => {
    await registerOnA('h-A')
    const pending = service.executeCommand('p1', 'cmd1', {})

    await replyFrom('wA', 'h-A', { result: 'legit' })

    await expect(pending).resolves.toBe('legit')
    expect(ownershipWarnMessages()).toHaveLength(0)
  })

  it('c) handlerId 无对应 registration（执行中被注销）：即使归属通道正确也拒绝投递，pending 挂起至超时', async () => {
    vi.useFakeTimers()
    try {
      await registerOnA('h-A')
      const pending = service.executeCommand('p1', 'cmd1', {})

      // 执行期间命令被注销（registration 清除——插件禁用/crash 清理的对偶场景）
      await rpcServer.dispatch('wA', {
        jsonrpc: '2.0', id: 888001, method: COMMAND_RPC_METHODS.unregister,
        params: { pluginId: 'p1', commandId: 'cmd1' },
      })
      // 来源通道正确（wA），但注册表已无该 handlerId 条目 → fail-closed 拒绝
      await replyFrom('wA', 'h-A', { result: 'late' })

      const warns = ownershipWarnMessages()
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('h-A')

      vi.advanceTimersByTime(1_800_000)
      await expect(pending).rejects.toThrow("Command 'p1:cmd1' timed out after 30min")
    } finally {
      vi.useRealTimers()
    }
  })
})

// ══════════════════════════════════════════════════════════════════
// S3-W2 — session 事件注册表定向投递
// ══════════════════════════════════════════════════════════════════

describe('session 事件注册表定向投递（registerCreate → didCreate）', () => {
  let rpc: PluginRpcServer
  let dispatchTable: SessionEventDispatch
  let portA: ReturnType<typeof createMockPort>
  let portB: ReturnType<typeof createMockPort>

  beforeEach(() => {
    rpc = new PluginRpcServer()
    dispatchTable = new SessionEventDispatch(rpc)
    portA = createMockPort()
    portB = createMockPort()
    rpc.registerWorker('wA', portA)
    rpc.registerWorker('wB', portB)
    registerSessionRpcHandlers(rpc, {
      listSessions: () => [],
      getSession: () => undefined,
      getActiveSession: () => undefined,
      sendMessage: async () => {},
      sessionEvents: dispatchTable,
    })
  })

  const session: SessionInfo = {
    id: 's1', label: 'L', cwd: '/tmp', status: 'active', createdAt: 0, lastActiveAt: 0,
  }

  /** 经真实 dispatch 注册一个 create/destroy handler（handler 内部从 ctx 取 workerId） */
  function registerHandler(kind: 0 | 1, workerId: string, handlerId: string, pluginId: string): Promise<void> {
    return rpc.dispatch(workerId, {
      jsonrpc: '2.0',
      id: 1000 + Math.floor(Math.random() * 999),
      method: SESSION_EVENT_METHODS[kind],
      params: { pluginId, handlerId },
    })
  }

  it('didCreate 只投递到注册 create 的 Worker（含 handlerId + session），其余 Worker 不收', async () => {
    await registerHandler(0, 'wA', 'hc-A', 'pluginA')

    dispatchTable.didCreate(session)

    const notes = notificationsOf(portA)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.method).toBe('plugin.sessions.didCreate')
    expect(notes[0]!.params).toEqual({ handlerId: 'hc-A', session })
    expect(notificationsOf(portB)).toHaveLength(0)
  })

  it('create 与 destroy 双表隔离：didDestroy 不触发 create 订阅者', async () => {
    await registerHandler(0, 'wA', 'hc-A', 'pluginA')
    await registerHandler(1, 'wB', 'hd-B', 'pluginB')

    dispatchTable.didDestroy(session)

    expect(notificationsOf(portA)).toHaveLength(0)
    const notes = notificationsOf(portB)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.method).toBe('plugin.sessions.didDestroy')
    expect(notes[0]!.params).toEqual({ handlerId: 'hd-B', session })
  })

  it('unregisterCreate 后不再投递（Worker dispose 对偶）', async () => {
    await registerHandler(0, 'wA', 'hc-A', 'pluginA')
    await rpc.dispatch('wA', {
      jsonrpc: '2.0', id: 77, method: 'plugin.sessions.unregisterCreate', params: { handlerId: 'hc-A' },
    })

    dispatchTable.didCreate(session)

    expect(notificationsOf(portA)).toHaveLength(0)
  })

  it('clearForPlugin 清空该插件全部订阅（crash/disable/uninstall 对偶清理）', async () => {
    await registerHandler(0, 'wA', 'hc-A', 'pluginA')
    await registerHandler(1, 'wB', 'hd-B', 'pluginB')

    dispatchTable.clearForPlugin('pluginA')
    dispatchTable.didCreate(session)
    dispatchTable.didDestroy(session)

    expect(notificationsOf(portA)).toHaveLength(0)
    expect(notificationsOf(portB)).toHaveLength(1) // pluginB 的 destroy 订阅不受影响
  })
})

// ══════════════════════════════════════════════════════════════════
// S3-W2 — session 创建/销毁入口收敛触发
// ══════════════════════════════════════════════════════════════════

describe('session 创建入口收敛触发 notifySessionCreated', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    setMigrationGate(Promise.resolve())
    tmpDir = mkdtempSync(join(tmpdir(), 'contract-sess-'))
  })

  afterEach(() => {
    setMigrationGate(Promise.resolve())
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('lifecycle.create 成功 → notifySessionCreated 恰好一次且 summary 为新 session', async () => {
    const { lifecycle, svc } = makeLifecycleEnv()
    const summary = await lifecycle.create('/tmp', 'test')

    expect(summary.id).toBe('sess-1')
    expect(svc.notifySessionCreated).toHaveBeenCalledTimes(1)
    expect(svc.notifySessionCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-1', status: 'active' }))
  })

  it('lifecycle.restoreSession 成功 → notifySessionCreated 触发（restore 也是创建入口）', async () => {
    const { lifecycle, svc } = makeLifecycleEnv()
    // 持久化 session 文件（restore 读取 JSONL strip；两行最小合法内容即可）
    const filePath = join(tmpDir, 'sess-9.jsonl')
    writeFileSync(filePath, '{"type":"session","id":"sess-9"}\n{"type":"message","id":"e1"}\n')
    ;(svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'sess-9', filePath, cwd: tmpDir, name: 'restored', launchPresetId: undefined, projectId: undefined,
    })

    const summary = await lifecycle.restoreSession('sess-9')

    expect(summary.id).toBe('sess-9')
    expect(svc.notifySessionCreated).toHaveBeenCalledTimes(1)
    expect(svc.notifySessionCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-9' }))
  })

  it('lifecycle.forkSession 成功 → notifySessionCreated 触发（fork 也是创建入口）', async () => {
    const { lifecycle, svc } = makeLifecycleEnv()
    const sourceFile = join(tmpDir, 'sess-src.jsonl')
    writeFileSync(sourceFile, '{"type":"session","id":"sess-src"}\n{"type":"message","id":"e1"}\n')
    ;(svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'sess-src', filePath: sourceFile, cwd: tmpDir, name: 'src', launchPresetId: undefined, projectId: undefined,
    })
    // vi.mock 的 createForkedSessionFile 返回受控产物（filePath 指向真实 tmp 文件，
    // 供 fork 内部 readFileSync(strip) + switchSession 流程消费）
    const forkedFile = join(tmpDir, 'fork-1.jsonl')
    writeFileSync(forkedFile, '{"type":"session","id":"fork-1"}\n')
    const { createForkedSessionFile } = await import('../src/services/session/session-fork.js')
    ;(createForkedSessionFile as ReturnType<typeof vi.fn>).mockResolvedValue({ filePath: forkedFile, sessionId: 'fork-1' })

    const summary = await lifecycle.forkSession('sess-src', 'e1', true, 'forked')

    expect(summary.id).toBe('fork-1')
    expect(svc.notifySessionCreated).toHaveBeenCalledTimes(1)
    expect(svc.notifySessionCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'fork-1' }))
  })

  it('lifecycle.create 失败（pi 无 session id）→ notifySessionCreated 不触发', async () => {
    const { lifecycle, svc, pm } = makeLifecycleEnv()
    ;(pm.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      getState: async () => ({ sessionId: '', sessionFile: undefined }),
    })

    await expect(lifecycle.create('/tmp')).rejects.toThrow('session ID')
    expect(svc.notifySessionCreated).not.toHaveBeenCalled()
  })
})

describe('session 销毁汇聚点触发 onSessionDestroyed', () => {
  it('removeSessionEntry 触发 setOnSessionDestroyed 注册的回调（fallback summary 带 sessionId）', () => {
    const pm = {
      onSessionExit: vi.fn(),
      getClient: vi.fn(() => undefined),
      destroySession: vi.fn(async () => {}),
      destroyAll: vi.fn(async () => {}),
    } as unknown as ConstructorParameters<typeof SessionService>[0]
    const broker = createMockBroker()
    const adapterFactory = vi.fn()
    const extensionService = {} as unknown as IExtensionService
    const configStore = {} as unknown as IConfigStore
    const sessionStore = {} as unknown as ISessionStore
    const gitInfoReader = {} as unknown as ConstructorParameters<typeof SessionService>[7]
    const workspaceService = {} as unknown as WorkspaceService

    const svc = new SessionService(
      pm, broker, adapterFactory, '/project-root', extensionService,
      configStore, sessionStore, gitInfoReader, workspaceService,
    )

    const destroyed: SessionSummary[] = []
    svc.setOnSessionDestroyed(summary => destroyed.push(summary))

    // 不进 Map 直接删（Map 无条目走最小 summary fallback——触发逻辑与富化分支同点）
    svc.removeSessionEntry('s-gone')

    expect(destroyed).toHaveLength(1)
    expect(destroyed[0]!.id).toBe('s-gone')
    expect(destroyed[0]!.status).toBe('dead')
  })
})

// ══════════════════════════════════════════════════════════════════
// S3-W2 — events 显式降级（NOT_IMPLEMENTED）
// ══════════════════════════════════════════════════════════════════

describe('events 面显式降级：调用即抛 NOT_IMPLEMENTED', () => {
  it('api.events.on 调用即抛，错误含 NOT_IMPLEMENTED 与 issue 指引', () => {
    const api = createAgentAPI('p1')
    expect(() => api.events.on('some-event', () => {})).toThrow(/NOT_IMPLEMENTED/)
    expect(() => api.events.on('some-event', () => {})).toThrow(/zhushanwen321\/tai-ji\/issues/)
  })

  it('api.events.emit 调用即抛，错误含 NOT_IMPLEMENTED 与 issue 指引', () => {
    const api = createAgentAPI('p1')
    expect(() => api.events.emit('some-event', { a: 1 })).toThrow(/NOT_IMPLEMENTED/)
    expect(() => api.events.emit('some-event', { a: 1 })).toThrow(/zhushanwen321\/tai-ji\/issues/)
  })
})

// ══════════════════════════════════════════════════════════════════
// S3-W3 — CT-U1 api 入口窄校验层（40+ 方法畸形输入 → INVALID_*）
// ══════════════════════════════════════════════════════════════════

describe('CT-U1 api 入口窄校验层（畸形输入 → INVALID_* 结构化错误且零写副作用）', () => {
  let rpc: PluginRpcServer
  let port: ReturnType<typeof createMockPort>
  /** 全部写通道副作用 mock：畸形输入必须零触达（不落盘/不建注册表/不广播） */
  let effects: {
    configSet: ReturnType<typeof vi.fn<(pluginId: string, key: string, value: unknown) => Promise<void>>>
    storageSet: ReturnType<typeof vi.fn<(pluginId: string, key: string, value: unknown, scope: 'global' | 'workspace') => void>>
    sessionDataSet: ReturnType<typeof vi.fn<(sessionId: string, key: string, value: unknown) => void>>
    messageSent: ReturnType<typeof vi.fn<(sessionId: string | undefined, role: string, content: string) => Promise<void>>>
    notifySent: ReturnType<typeof vi.fn<(pluginId: string, level: string, message: string) => void>>
    statusBarSet: ReturnType<typeof vi.fn<(pluginId: string, id: string, text: string, options?: Record<string, unknown>) => Promise<void>>>
    viewUpdated: ReturnType<typeof vi.fn<(pluginId: string, viewId: string, guiTree: unknown[]) => void>>
    setModel: ReturnType<typeof vi.fn<(model: string) => Promise<string>>>
    syncTools: ReturnType<typeof vi.fn<() => Promise<void>>>
  }
  let commandRegistry: Map<string, CommandRegistration>
  let toolRegistry: Map<string, unknown>
  let hookRegistry: Map<string, unknown[]>

  beforeEach(() => {
    rpc = new PluginRpcServer()
    port = createMockPort()
    rpc.registerWorker('w1', port)
    effects = {
      configSet: vi.fn<(pluginId: string, key: string, value: unknown) => Promise<void>>(),
      storageSet: vi.fn<(pluginId: string, key: string, value: unknown, scope: 'global' | 'workspace') => void>(),
      sessionDataSet: vi.fn<(sessionId: string, key: string, value: unknown) => void>(),
      messageSent: vi.fn<(sessionId: string | undefined, role: string, content: string) => Promise<void>>(),
      notifySent: vi.fn<(pluginId: string, level: string, message: string) => void>(),
      statusBarSet: vi.fn<(pluginId: string, id: string, text: string, options?: Record<string, unknown>) => Promise<void>>(),
      viewUpdated: vi.fn<(pluginId: string, viewId: string, guiTree: unknown[]) => void>(),
      setModel: vi.fn<(model: string) => Promise<string>>(),
      syncTools: vi.fn<() => Promise<void>>(),
    }
    commandRegistry = new Map()
    toolRegistry = new Map()
    hookRegistry = new Map()

    registerAgentRpcHandlers(rpc, {
      getModel: () => '',
      setModel: effects.setModel,
      getThinkingLevel: () => '',
      setThinkingLevel: vi.fn<(level: string) => Promise<string>>(),
      getActiveTools: () => [],
    })
    registerCommandRpcHandlers(rpc, {
      registry: commandRegistry,
      broadcastRegistered: vi.fn(),
      deliverInvokeResult: vi.fn(),
    })
    registerConfigRpcHandlers(rpc, {
      get: vi.fn<(pluginId: string, key: string) => Promise<unknown>>(),
      getAll: vi.fn<(pluginId: string) => Promise<Record<string, unknown>>>(),
      set: effects.configSet,
    })
    registerStorageRpcHandlers(rpc, {
      get: vi.fn<(pluginId: string, key: string, scope: 'global' | 'workspace') => unknown>(),
      set: effects.storageSet,
      delete: vi.fn<(pluginId: string, key: string, scope: 'global' | 'workspace') => void>(),
      keys: () => [],
    })
    registerSessionDataRpcHandlers(rpc, {
      get: vi.fn<(sessionId: string, key: string) => unknown>(),
      set: effects.sessionDataSet,
      delete: vi.fn<(sessionId: string, key: string) => void>(),
      keys: () => [],
    })
    registerNotifyRpcHandler(rpc, { notify: effects.notifySent })
    registerSessionRpcHandlers(rpc, {
      listSessions: () => [],
      getSession: () => undefined,
      getActiveSession: () => undefined,
      sendMessage: effects.messageSent,
      sessionEvents: new SessionEventDispatch(rpc),
    })
    registerUiRpcHandlers(rpc, {
      showSelect: vi.fn<(title: string, options: string[], pluginId: string) => Promise<string | undefined>>(),
      showConfirm: vi.fn<(title: string, message: string, pluginId: string) => Promise<boolean>>(),
      showInput: vi.fn<(title: string, defaultValue: string | undefined, pluginId: string) => Promise<string | undefined>>(),
      notify: vi.fn<(pluginId: string, level: string, message: string) => Promise<void>>(),
      updateStatusBarItem: effects.statusBarSet as never,
    })
    registerViewRpcHandlers(rpc, { handleViewUpdate: effects.viewUpdated as never, mountPoints: [] })
    registerWorkspaceRpcHandlers(rpc, {
      getRootPath: () => '/tmp',
      getName: () => 'test-ws',
      findFiles: vi.fn<(pattern: string) => Promise<string[]>>(),
    })
    registerToolRpcHandlers(rpc, {
      toolRegistry: toolRegistry as never,
      syncToolsToBridge: effects.syncTools,
    })
    registerHookRpcHandlers(rpc, {
      hookRegistry: hookRegistry as never,
      getDescriptor: () => undefined,
    })
  })

  let seq = 500000
  /** dispatch 一条畸形 params，断言返回结构化错误（error.code = INVALID_*）且 message 含字段名 */
  async function expectInvalid(method: string, params: Record<string, unknown>, code: string, fieldHint: string): Promise<void> {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: ++seq, method, params })
    const responses = port.messages.filter(m => m.type === 'rpc' && (m as { response?: unknown }).response)
    const last = responses[responses.length - 1] as { response: { error?: { code?: unknown; message?: string } } }
    expect(last.response.error, `${method} 畸形输入必须返回错误响应`).toBeDefined()
    expect(last.response.error?.code, `${method} 错误码`).toBe(code)
    expect(last.response.error?.message, `${method} 错误 message 含字段名（可指导插件作者修正）`).toContain(fieldHint)
  }

  it('CT-U1 工具函数 asString/asSafeKey/asBoundedString：正例收窄返回，反例抛 INVALID_* 错误码', () => {
    // asString：正例原样收窄；错类型抛 INVALID_F（code 在 err.code）
    expect(asString('x', 'f')).toBe('x')
    expect(() => asString(42, 'f')).toThrow(/Invalid f: expected a string/)
    try {
      asString(42, 'f')
      expect.unreachable('asString 应抛错')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('INVALID_F')
    }

    // asSafeKey：白名单内放行；路径分隔符 / ':' / 超长 / 错类型全拒
    expect(asSafeKey('a.b_c-1', 'key')).toBe('a.b_c-1')
    for (const bad of ['../evil', 'a/b', 'a:b', 'a b', '', 'x'.repeat(129), 42, null]) {
      try {
        asSafeKey(bad, 'sessionId')
        expect.unreachable(`asSafeKey 应拒绝 ${String(bad)}`)
      } catch (e) {
        expect((e as { code?: string }).code).toBe('INVALID_SESSION_ID')
      }
    }

    // asBoundedString：上限内放行；按 UTF-8 字节数（非字符数）计长
    expect(asBoundedString('abc', 'message', 8)).toBe('abc')
    expect(asBoundedString('你'.repeat(2), 'message', 8)).toBe('你你') // 6 字节 ≤ 8
    for (const [value, maxBytes] of [['123456789', 8], ['你'.repeat(3), 8]] as const) {
      try {
        asBoundedString(value, 'message', maxBytes)
        expect.unreachable('asBoundedString 应抛错')
      } catch (e) {
        expect((e as { code?: string }).code).toBe('INVALID_MESSAGE')
      }
    }
  })

  it('CT-U1 标识符域（storage/config/sessionData/session/commands/hooks/tools）：越界键/错类型/缺字段全部 INVALID_*', async () => {
    await expectInvalid('plugin.storage.global.set', { pluginId: 'p', key: 'k/../..', value: 1 }, 'INVALID_KEY', 'key')
    await expectInvalid('plugin.storage.global.get', { pluginId: '../p', key: 'k' }, 'INVALID_PLUGIN_ID', 'pluginId')
    await expectInvalid('plugin.storage.workspace.get', { pluginId: 'p' }, 'INVALID_KEY', 'key')
    await expectInvalid('plugin.config.get', { pluginId: 'p', key: 'a:b' }, 'INVALID_KEY', 'key')
    await expectInvalid('plugin.config.getAll', { pluginId: {} }, 'INVALID_PLUGIN_ID', 'pluginId')
    await expectInvalid('plugin.config.set', { pluginId: 'p' }, 'INVALID_KEY', 'key')
    await expectInvalid('plugin.sessionData.set', { sessionId: '../x', key: 'k', value: 1 }, 'INVALID_SESSION_ID', 'sessionId')
    await expectInvalid('plugin.sessionData.keys', { sessionId: [] }, 'INVALID_SESSION_ID', 'sessionId')
    await expectInvalid('plugin.sessions.get', { sessionId: '../../etc' }, 'INVALID_SESSION_ID', 'sessionId')
    await expectInvalid('plugin.sessions.sendMessage', { sessionId: 's1', role: 'user', content: 42 }, 'INVALID_CONTENT', 'content')
    await expectInvalid(COMMAND_RPC_METHODS.register, { pluginId: '../evil', command: { id: 'x' }, handlerId: 'h' }, 'INVALID_PLUGIN_ID', 'pluginId')
    await expectInvalid(COMMAND_RPC_METHODS.register, { pluginId: 'p', command: 'not-object', handlerId: 'h' }, 'INVALID_COMMAND', 'command')
    await expectInvalid(COMMAND_RPC_METHODS.unregister, { pluginId: 'p' }, 'INVALID_COMMAND_ID', 'commandId')
    await expectInvalid(COMMAND_RPC_METHODS.invokeResult, { handlerId: 42 }, 'INVALID_HANDLER_ID', 'handlerId')
    await expectInvalid(SESSION_EVENT_METHODS[0], { pluginId: 'p' }, 'INVALID_HANDLER_ID', 'handlerId')
    await expectInvalid(SESSION_EVENT_METHODS[1], { pluginId: 'p', handlerId: 123 }, 'INVALID_HANDLER_ID', 'handlerId')
    await expectInvalid('plugin.sessions.unregisterCreate', {}, 'INVALID_HANDLER_ID', 'handlerId')
    await expectInvalid('plugin.sessions.unregisterDestroy', { handlerId: 'a/b' }, 'INVALID_HANDLER_ID', 'handlerId')
    await expectInvalid('plugin.hooks.register', { pluginId: 'p', handlerId: 'h' }, 'INVALID_HOOK_TYPE', 'hookType')
    await expectInvalid('plugin.hooks.unregister', { hookType: 'onPiEvent' }, 'INVALID_HANDLER_ID', 'handlerId')
    await expectInvalid('plugin.tools.register', { pluginId: 'p', name: 'x:y' }, 'INVALID_NAME', 'name')
    await expectInvalid('plugin.tools.register', { pluginId: 'p' }, 'INVALID_NAME', 'name')
    await expectInvalid('plugin.tools.unregister', { toolKey: 42 }, 'INVALID_TOOL_KEY', 'toolKey')
  })

  it('CT-U1 文本域（ui/notify/agent/workspace/views）：错类型/缺字段/超长全部 INVALID_*', async () => {
    await expectInvalid('plugin.ui.showSelect', { pluginId: 'p', title: 't', options: 'nope' }, 'INVALID_OPTIONS', 'options')
    await expectInvalid('plugin.ui.showSelect', { pluginId: 'p', title: 't', options: ['a', 42] }, 'INVALID_OPTIONS', 'options')
    await expectInvalid('plugin.ui.showConfirm', { pluginId: 'p', title: 't', message: [] }, 'INVALID_MESSAGE', 'message')
    await expectInvalid('plugin.ui.showInput', { pluginId: 'p' }, 'INVALID_TITLE', 'title')
    await expectInvalid('plugin.ui.updateStatusBarItem', { pluginId: 'p', id: 'a/b', text: 't' }, 'INVALID_ID', 'id')
    await expectInvalid('plugin.ui.notify', { pluginId: 'p', level: 'info', message: {} }, 'INVALID_MESSAGE', 'message')
    await expectInvalid('plugin.notify', { level: 'info', message: 'x' }, 'INVALID_PLUGIN_ID', 'pluginId')
    await expectInvalid('plugin.notify', { pluginId: 'p', level: 'info', message: {} }, 'INVALID_MESSAGE', 'message')
    await expectInvalid('plugin.agent.setModel', { model: {} }, 'INVALID_MODEL', 'model')
    await expectInvalid('plugin.agent.setThinkingLevel', {}, 'INVALID_LEVEL', 'level')
    await expectInvalid('plugin.workspace.findFiles', { pattern: 999 }, 'INVALID_PATTERN', 'pattern')
    await expectInvalid('plugin.views.update', { pluginId: 'p', viewId: 'v', guiTree: 'not-array' }, 'INVALID_GUI_TREE', 'guiTree')
    await expectInvalid('plugin.views.update', { pluginId: 'p', guiTree: [] }, 'INVALID_VIEW_ID', 'viewId')
  })

  it('CT-U1 畸形输入零写副作用：全部写通道未被调用、注册表零条目（不落盘不毒化）', async () => {
    const malformed: Array<[string, Record<string, unknown>]> = [
      ['plugin.storage.global.set', { pluginId: 'p', key: '../k', value: 1 }],
      ['plugin.config.set', { pluginId: 'p', key: '../k', value: 1 }],
      ['plugin.sessionData.set', { sessionId: '../s', key: 'k', value: 1 }],
      ['plugin.sessions.sendMessage', { sessionId: '../s', role: 'user', content: 'x' }],
      ['plugin.notify', { pluginId: 'p', level: 'info', message: 42 }],
      ['plugin.ui.updateStatusBarItem', { pluginId: 'p', id: 'i', text: {} }],
      ['plugin.views.update', { pluginId: 'p', viewId: 'v', guiTree: {} }],
      ['plugin.agent.setModel', { model: 42 }],
      ['plugin.commands.register', { pluginId: 'p', command: { id: 'x' }, handlerId: 42 }],
      ['plugin.tools.register', { pluginId: 'p', name: {}}],
      ['plugin.hooks.register', { pluginId: 'p', hookType: 42, handlerId: 'h' }],
    ]
    for (const [method, params] of malformed) {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: ++seq, method, params })
    }

    expect(effects.storageSet).not.toHaveBeenCalled()
    expect(effects.configSet).not.toHaveBeenCalled()
    expect(effects.sessionDataSet).not.toHaveBeenCalled()
    expect(effects.messageSent).not.toHaveBeenCalled()
    expect(effects.notifySent).not.toHaveBeenCalled()
    expect(effects.statusBarSet).not.toHaveBeenCalled()
    expect(effects.viewUpdated).not.toHaveBeenCalled()
    expect(effects.setModel).not.toHaveBeenCalled()
    expect(effects.syncTools).not.toHaveBeenCalled()
    expect(commandRegistry.size).toBe(0)
    expect(toolRegistry.size).toBe(0)
    expect(hookRegistry.size).toBe(0)
  })
})

// ══════════════════════════════════════════════════════════════════
// S3-W4 — CT-D3 限流与大小上限
// ══════════════════════════════════════════════════════════════════

describe('CT-D3 限流与防毒化（notify 令牌桶 / 大小上限 / statusbar 合并窗口）', () => {
  it('CT-D3 NotifyRateLimiter 默认 20 条/s（shared SSOT）：瞬时突发 20 条放行、第 21 条拒、每插件独立分桶、1s 后配额恢复（nowMs 注入）', () => {
    const limiter = new NotifyRateLimiter()
    // 默认值来自 shared SSOT（可配置性：config 暴露且等于 PLUGIN_NOTIFY_LIMITS）
    expect(limiter.config.ratePerSec).toBe(PLUGIN_NOTIFY_LIMITS.NOTIFY_RATE_PER_SEC)
    expect(limiter.config.ratePerSec).toBe(20)

    const t0 = 1_000_000
    for (let i = 0; i < 20; i++) {
      expect(limiter.tryAcquire('p1', t0), `第 ${i + 1} 条应放行（容量=速率，可瞬时突发）`).toBe(true)
    }
    expect(limiter.tryAcquire('p1', t0), '第 21 条超限应丢弃').toBe(false)
    expect(limiter.tryAcquire('p2', t0), '每插件独立分桶：p1 超限不连坐 p2').toBe(true)
    // 半秒后按速率补充 0.5×20=10 个令牌：可再取 10 条，第 11 条拒
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryAcquire('p1', t0 + 500)).toBe(true)
    }
    expect(limiter.tryAcquire('p1', t0 + 500), '补充的 10 个令牌耗尽后仍拒').toBe(false)
    expect(limiter.tryAcquire('p1', t0 + 1000), '再过半秒又补充 10 个令牌，恢复放行').toBe(true)
  })

  it('CT-D3 常量可配置：构造参数覆盖默认值（ratePerSec=5 时第 6 条拒）', () => {
    const limiter = new NotifyRateLimiter({ ratePerSec: 5 })
    expect(limiter.config.ratePerSec).toBe(5)
    for (let i = 0; i < 5; i++) expect(limiter.tryAcquire('p', 0)).toBe(true)
    expect(limiter.tryAcquire('p', 0)).toBe(false)
  })

  it('CT-D3 plugin.notify 超限丢弃并记日志（真实 dispatch 链路，20/s 打满后第 21 条丢弃 + warn）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    const notify = vi.fn()
    registerNotifyRpcHandler(rpc, { notify })

    const dispatchNotify = (i: number) =>
      rpc.dispatch('w1', {
        jsonrpc: '2.0',
        id: 700000 + i,
        method: 'plugin.notify',
        params: { pluginId: 'storm', level: 'info', message: `m${i}` },
      })

    for (let i = 0; i < 20; i++) await dispatchNotify(i)
    expect(notify).toHaveBeenCalledTimes(20)

    await dispatchNotify(20)
    expect(notify, '超限第 21 条被丢弃（notify 不再被调用）').toHaveBeenCalledTimes(20)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('rate limit 20/s exceeded'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('storm'))

    warnSpy.mockRestore()
  })

  it('CT-D3 notify message >8KB 拒（INVALID_MESSAGE），8KB 整放行', async () => {
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    const notify = vi.fn()
    registerNotifyRpcHandler(rpc, { notify })

    // 8KB 整（默认值 + 1 字节越界；边界值本体合法）
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 710001, method: 'plugin.notify',
      params: { pluginId: 'p', level: 'info', message: 'x'.repeat(PLUGIN_NOTIFY_LIMITS.NOTIFY_MESSAGE_MAX_BYTES) },
    })
    expect(notify).toHaveBeenCalledTimes(1)

    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 710002, method: 'plugin.notify',
      params: { pluginId: 'p', level: 'info', message: 'x'.repeat(PLUGIN_NOTIFY_LIMITS.NOTIFY_MESSAGE_MAX_BYTES + 1) },
    })
    expect(notify, '>8KB 条目被拒，不触达 notify').toHaveBeenCalledTimes(1)
    const responses = port.messages.filter(m => m.type === 'rpc' && (m as { response?: unknown }).response)
    const last = responses[responses.length - 1] as { response: { error?: { code?: unknown } } }
    expect(last.response.error?.code).toBe('INVALID_MESSAGE')
  })

  it('CT-D3 statusbar text >4KB 拒（INVALID_TEXT，D3 验收「1MB text 被拒」依此规则）', async () => {
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    const updateStatusBarItem = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerUiRpcHandlers(rpc, {
      showSelect: vi.fn(), showConfirm: vi.fn(), showInput: vi.fn(), notify: vi.fn(), updateStatusBarItem,
    })

    const dispatchStatus = (id: number, text: string) =>
      rpc.dispatch('w1', {
        jsonrpc: '2.0', id, method: 'plugin.ui.updateStatusBarItem',
        params: { pluginId: 'p', id: 'item', text },
      })

    // 1MB text（验收场景）：拒绝
    await dispatchStatus(720001, 'x'.repeat(1024 * 1024))
    expect(updateStatusBarItem).not.toHaveBeenCalled()
    const responses = port.messages.filter(m => m.type === 'rpc' && (m as { response?: unknown }).response)
    const last = responses[responses.length - 1] as { response: { error?: { code?: unknown } } }
    expect(last.response.error?.code).toBe('INVALID_TEXT')

    // 4KB 整放行（边界值本体合法）
    await dispatchStatus(720002, 'x'.repeat(PLUGIN_NOTIFY_LIMITS.STATUSBAR_TEXT_MAX_BYTES))
    expect(updateStatusBarItem).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it('CT-D3 statusbar 更新 100ms 合并窗口（fake timers）：窗口内多次更新合并为一次广播，coalesceMs=0 退化立即广播，dispose 清 pending timer', () => {
    vi.useFakeTimers()
    try {
      const broadcasts: Array<{ items: unknown[] }> = []
      const registry = new StatusBarRegistry(p => broadcasts.push(p))
      // 默认值来自 shared SSOT（可配置性）
      expect(registry).toBeDefined()

      registry.items.set('p:a', { id: 'a', pluginId: 'p', text: 't1', priority: 1 } as never)
      registry.broadcastAll()
      registry.items.set('p:b', { id: 'b', pluginId: 'p', text: 't2', priority: 2 } as never)
      registry.broadcastAll()
      expect(broadcasts, '合并窗口内不广播（trailing-edge）').toHaveLength(0)

      vi.advanceTimersByTime(PLUGIN_NOTIFY_LIMITS.STATUSBAR_COALESCE_MS)
      expect(broadcasts, '窗口到期合并为一次广播').toHaveLength(1)
      expect(broadcasts[0]!.items, '广播内容是最新全量快照（合并不丢终态）').toHaveLength(2)

      // coalesceMs=0（构造参数覆盖默认）：退化为立即广播
      const immediate: Array<{ items: unknown[] }> = []
      const noCoalesce = new StatusBarRegistry(p => immediate.push(p), { coalesceMs: 0 })
      noCoalesce.broadcastAll()
      expect(immediate).toHaveLength(1)

      // dispose：pending timer 清理（关停后不再广播）
      registry.items.set('p:c', { id: 'c', pluginId: 'p', text: 't3', priority: 3 } as never)
      registry.broadcastAll()
      registry.dispose()
      vi.advanceTimersByTime(PLUGIN_NOTIFY_LIMITS.STATUSBAR_COALESCE_MS * 2)
      expect(broadcasts, 'dispose 后 pending 广播不发出').toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ══════════════════════════════════════════════════════════════════
// S3-W4 — CT-D4 毒化隔离（runtime 侧 statusbar 逐条校验）
// ══════════════════════════════════════════════════════════════════

describe('CT-D4 毒化隔离（runtime 侧）：statusbar 单条坏 item 拒绝该条，不整包丢弃', () => {
  it('CT-D4 text:{} 单条坏 item：该条 INVALID_TEXT 拒绝并记宿主日志，好条目与后续更新不受影响', async () => {
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    const updateStatusBarItem = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerUiRpcHandlers(rpc, {
      showSelect: vi.fn(), showConfirm: vi.fn(), showInput: vi.fn(), notify: vi.fn(), updateStatusBarItem,
    })

    const dispatchStatus = (id: number, itemId: string, text: unknown) =>
      rpc.dispatch('w1', {
        jsonrpc: '2.0', id, method: 'plugin.ui.updateStatusBarItem',
        params: { pluginId: 'p', id: itemId, text },
      })

    // 1) 好条目正常注册
    await dispatchStatus(800001, 'good', '正常文案')
    expect(updateStatusBarItem).toHaveBeenCalledTimes(1)

    // 2) 坏条目（text:{}，spec 点名形态）：该条拒绝（INVALID_TEXT 回包 + 宿主日志）
    await dispatchStatus(800002, 'bad', {})
    expect(updateStatusBarItem, '坏条目不触达 registry 写通道').toHaveBeenCalledTimes(1)
    const responses = port.messages.filter(m => m.type === 'rpc' && (m as { response?: unknown }).response)
    const last = responses[responses.length - 1] as { response: { error?: { code?: unknown } } }
    expect(last.response.error?.code).toBe('INVALID_TEXT')
    expect(warnSpy, '坏条目拒绝留宿主侧日志（可观测）').toHaveBeenCalledWith(
      expect.stringContaining('statusbar item rejected'),
    )

    // 3) 坏条目之后的好条目正常放行（毒化不扩散——不整包丢弃后续更新）
    await dispatchStatus(800003, 'good2', '后续好条目')
    expect(updateStatusBarItem).toHaveBeenCalledTimes(2)
    expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('good2')), '好条目不产生拒绝日志').toHaveLength(0)

    warnSpy.mockRestore()
  })
})
