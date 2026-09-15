/**
 * MessageDispatcher compact 零广播测试（M4 事件驱动）。
 *
 * 锁定（SSOT §3.3.4 dispatcher compact 改三件事）：
 * - TC5: compact 方法零广播——成功/失败/busy 预检路径均不广播 session.compacting/compacted/compactionSummary
 *        （compaction 生命周期由 interpreter 从 compaction_start/compaction_end 唯一编排，P-dedup by construction）
 * - busy 预检补 isCompacting：并发 compact 重入（isCompacting=true）→ 抛错 + 零广播
 * - busy 预检 isBashRunning/isGenerating：仍生效，抛错 + 零广播
 * - catch 只复位 isCompacting + 传播 RPC error（零广播，失败提示归 interpreter）
 *
 * 运行：npx vitest run src/__tests__/message-dispatcher-compact.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageDispatcher } from '../services/session/message-dispatcher.js'
import type { IDispatcherSessionOps } from '../services/session/session-internal.js'
import type { IManagedSessionView } from '../services/session/types.js'
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { ServerMessage } from '@taiji/shared'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'

function makeMockSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
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
    ...overrides,
  }
}

interface MockOpts {
  isBashRunning?: boolean
  isGenerating?: boolean
  isCompacting?: boolean
  compactResult?: unknown
  compactError?: Error
}

function makeMocks(opts: MockOpts = {}) {
  const session = makeMockSession({
    isBashRunning: opts.isBashRunning ?? false,
    isGenerating: opts.isGenerating ?? false,
    isCompacting: opts.isCompacting ?? false,
  })

  const compactFn = opts.compactError
    ? vi.fn(async () => { throw opts.compactError! })
    : vi.fn(async () => opts.compactResult ?? { summary: 'S', tokensBefore: 100, estimatedTokensAfter: 30 })

  const client = { compact: compactFn } as unknown as IPiEngine

  // wave:perf-w09（D1-2）：dispatcher 只依赖 publish 抽象（broker 双写腿已删），mock bus 收集发布消息
  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus

  // S2 ISP 化：结构性满足 dispatcher 窄接口（6 方法 = 实际消费面），无强转
  const svc: IDispatcherSessionOps = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    getSession: vi.fn(),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  }

  const pm = { getClient: vi.fn(() => client) } as unknown as IProcessManager
  const workspace = { record: vi.fn() } as unknown as WorkspaceService

  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  return { dispatcher, session, compactFn, broadcasts }
}

/** compaction 生命周期相关的广播类型（M4 后 dispatcher 应零广播这些） */
const COMPACTION_TYPES = ['session.compacting', 'session.compacted', 'message.compactionSummary']

describe('MessageDispatcher compact —— 零广播（M4 事件驱动）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('TC5-成功: compact 成功 → 零 compaction 广播（interpreter 唯一源）+ client.compact 调用 + isCompacting 不置位', async () => {
    const { dispatcher, compactFn, session, broadcasts } = makeMocks()

    await dispatcher.compact('s1')

    // client.compact 调用（RPC 触发保留）
    expect(compactFn).toHaveBeenCalledWith(undefined)
    // dispatcher 不置位 isCompacting（置位归 interpreter 的 compaction_start 事件）
    expect(session.isCompacting).toBe(false)
    // 零 compaction 广播
    const compactionBroadcasts = broadcasts.filter((m) => COMPACTION_TYPES.includes(m.type))
    expect(compactionBroadcasts).toHaveLength(0)
  })

  it('TC5-busy预检补isCompacting: isCompacting=true → 抛错 + 零广播（防并发 compact 重入）', async () => {
    const { dispatcher, compactFn, broadcasts } = makeMocks({ isCompacting: true })

    await expect(dispatcher.compact('s1')).rejects.toThrow(/compaction already running/)
    expect(compactFn).not.toHaveBeenCalled()

    const compactionBroadcasts = broadcasts.filter((m) => COMPACTION_TYPES.includes(m.type))
    expect(compactionBroadcasts).toHaveLength(0)
  })

  it('TC5-busy预检: isBashRunning=true → 抛错 + 零广播', async () => {
    const { dispatcher, broadcasts } = makeMocks({ isBashRunning: true })

    await expect(dispatcher.compact('s1')).rejects.toThrow(/bash running/)

    const compactionBroadcasts = broadcasts.filter((m) => COMPACTION_TYPES.includes(m.type))
    expect(compactionBroadcasts).toHaveLength(0)
  })

  it('TC5-busy预检: isGenerating=true → 抛错 + 零广播', async () => {
    const { dispatcher, broadcasts } = makeMocks({ isGenerating: true })

    await expect(dispatcher.compact('s1')).rejects.toThrow(/agent generating/)

    const compactionBroadcasts = broadcasts.filter((m) => COMPACTION_TYPES.includes(m.type))
    expect(compactionBroadcasts).toHaveLength(0)
  })

  it('TC5-catch: client.compact reject → 传播 error + 零广播 + isCompacting 复位', async () => {
    const { dispatcher, session, broadcasts } = makeMocks({ compactError: new Error('pi compact failed') })

    await expect(dispatcher.compact('s1')).rejects.toThrow('pi compact failed')

    // 零广播（失败提示归 interpreter 的 compaction_end{errorMessage} → message.error 对话流）
    const compactionBroadcasts = broadcasts.filter((m) => COMPACTION_TYPES.includes(m.type))
    expect(compactionBroadcasts).toHaveLength(0)
    // finally 兜底复位（对 false 无害，防 transport 级失败 session 卡死）
    expect(session.isCompacting).toBe(false)
  })
})
