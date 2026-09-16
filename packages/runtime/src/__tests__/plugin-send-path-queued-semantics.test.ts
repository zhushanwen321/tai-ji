/**
 * 检查点 3 冒烟（实施计划 §7 残留风险 3 / 设计 §5 待验证检查点 3）：
 * **plugin-service 经 dispatcher 的 `{queued}` 语义透明性**。
 *
 * 真链路驱动（非 mock 语义断言）：`registerSessionRpcHandlers`（插件 RPC 表，真实注册函数）
 * → `plugin.sessions.sendMessage` handler → dispatcher.sendMessage → delivery registry
 * → 内核 FIFO → 出站交接。断言透明性的三条：
 * ① 目标 busy（compacting）时插件调用**不再收到拒绝**（旧 send.rejected/busy 拒绝面对
 *   插件是不可见的错误；新语义 = 排队承接，RPC resolve）；
 * ② 消息不丢：compaction 结束后由内核按 FIFO 投递（{queued} 语义的真实兑现）；
 * ③ runtime 侧零 send.rejected 帧（老协议拒绝面退役，插件调用方无需适配）。
 *
 * 既有冒烟通道：本文件驱动的是插件 API 的真实注册函数与真实 dispatcher/registry
 * （verify-plugin-contract.sh 的 CT-D1/CT-D2 覆盖的是命令执行与事件通道，不覆盖发送路径）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/plugin-send-path-queued-semantics.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { registerSessionRpcHandlers } from '../services/plugin-service/api/session-api.js'
import type { PluginRpcServer } from '../services/plugin-service/plugin-rpc-server.js'
import { MessageDispatcher } from '../services/session/message-dispatcher.js'
import {
  createSessionDeliveryRegistry,
  resetActiveDeliveryRegistryForTest,
  type SessionDeliveryDeps,
} from '../services/session/session-delivery-registry.js'
import { applySessionOccupancyTransition } from '../services/session/event-interpreter.js'
import type { IDispatcherSessionOps } from '../services/session/session-internal.js'
import type { IManagedSessionView } from '../services/session/types.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'
import type { SkillInjector } from '../services/session/skill-injector.js'
import type { ServerMessage } from '@taiji/shared'

function makeView(): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    occupancy: { turn: 'idle', compacting: false, bash: false },
  }
}

function makeHarness() {
  const view = makeView()
  const published: ServerMessage[] = []
  const promptCalls: string[] = []
  const client = {
    prompt: vi.fn(async (text: string) => {
      promptCalls.push(text)
      return {}
    }),
    touchActivity: vi.fn(),
    getEntries: vi.fn(async () => ({ data: { entries: [] } })),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    onEvent: vi.fn(() => () => {}),
  }
  const deps: SessionDeliveryDeps = {
    getSession: (sid) => (sid === view.id ? view : undefined),
    ensureActive: vi.fn(async () => client as unknown as IPiEngine),
    subscribeAgentSettled: () => () => {},
    recordWorkspace: vi.fn(),
    getMessageBus: () =>
      ({ publish: (_sid: string, msg: ServerMessage) => published.push(msg) }) as unknown as IMessageBus,
  }
  const registry = createSessionDeliveryRegistry(deps, {
    inject: async (_c: IPiEngine, text: string) => ({ text, notices: [] }),
  } as unknown as SkillInjector)
  const dispatcher = new MessageDispatcher(
    {} as unknown as IDispatcherSessionOps,
    { getClient: () => client as unknown as IPiEngine } as unknown as IProcessManager,
    { record: vi.fn() } as unknown as WorkspaceService,
    ({ publish: (_sid: string, msg: ServerMessage) => published.push(msg) }) as unknown as IMessageBus,
  )
  // 插件 RPC 表：捕获注册的 handler（真注册函数，非 mock）
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
  const rpcServer = {
    registerMethod: (name: string, fn: (params: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(name, fn)
    },
  } as unknown as PluginRpcServer
  registerSessionRpcHandlers(rpcServer, {
    listSessions: () => [],
    getSession: () => undefined,
    getActiveSession: () => undefined,
    // plugin-rpc-setup 的真实实现：deps.sessionService.sendMessage(sessionId, content)
    sendMessage: (sessionId: string | undefined, _role: string, content: string) =>
      dispatcher.sendMessage(sessionId as string, content),
    sessionEvents: { register: vi.fn(), unregister: vi.fn() },
  } as never)
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve()
  }
  return { registry, dispatcher, view, published, promptCalls, handlers, client, flush }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetActiveDeliveryRegistryForTest()
})
afterEach(() => {
  vi.useRealTimers()
  resetActiveDeliveryRegistryForTest()
})

describe('检查点 3：plugin-service 经 dispatcher 的 {queued} 语义透明性', () => {
  it('busy（compacting）目标：插件 sendMessage 不抛错不拒绝，消息入内核排队；compaction 结束后按序投递', async () => {
    const h = makeHarness()
    applySessionOccupancyTransition(h.view, null, 'compacting-start')

    const send = h.handlers.get('plugin.sessions.sendMessage')!
    expect(send, '插件 RPC 表已注册 sendMessage').toBeTruthy()

    // ① 不拒绝：RPC resolve（旧语义 = send.rejected 拒绝面，插件不可见地失败）
    await expect(send({ sessionId: 's1', role: 'user', content: '插件消息' })).resolves.toBeUndefined()
    await h.flush()
    expect(h.promptCalls).toHaveLength(0) // 持有：pi 暂不可收
    expect(h.published.some((m) => m.type === 'send.rejected')).toBe(false) // ③ 零 send.rejected 帧
    expect(h.registry.entries('s1')?.active[0]?.state).toBe('queued') // 排队承接

    // ② 不丢：compaction 结束 → 内核按 FIFO 投递（含插件消息 + 裸标记身份）
    applySessionOccupancyTransition(h.view, null, 'compacting-end')
    await vi.advanceTimersByTimeAsync(600)
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
    expect(h.promptCalls[0]).toContain('插件消息')
  })

  it('idle 目标：插件 sendMessage 走同一内核通道（直接受理，出站带裸标记）', async () => {
    const h = makeHarness()
    const send = h.handlers.get('plugin.sessions.sendMessage')!
    await send({ sessionId: 's1', role: 'user', content: '插件直发' })
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
    expect(h.promptCalls[0]).toContain('插件直发')
    expect(h.promptCalls[0]).toMatch(/<!--taiji:msg:[^>]+-->$/)
    expect(h.published.some((m) => m.type === 'message.error')).toBe(false)
  })
})
